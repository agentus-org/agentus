// QA: the plan-tool hint is GONE — the agent must never be fed a plan resource block on the wire.
//
//   node scripts/qa/plan-hint-sweep.mjs
//
// Why this sweep changed shape (2026-11-22, issue #112 follow-up): the cockpit used to inject an
// `agentus://plan/<id>` resource block into EVERY prompt (default `planHint.everyTurn=true`). That
// nudge had two costs: (1) it polluted the session-title generator and Hindsight recall/ingest,
// because Hermes' acp_adapter/content.py joins all text parts into the user message, and the block
// rode along as text; (2) its own wording taught the model to go SEARCH for the deferred MCP tool.
// The plan tool's discoverability now comes from its own trigger-style description + SOUL.md, and
// the cockpit CLI comes from the `agentus-cockpit` skill (mounted at handshake). So nothing should
// be injected on the wire any more. This sweep guards that: every prompt is the operator's own text.
//
// What it proves:
//   1. first prompt, no plan on the card → no plan block, only the operator's text;
//   2. everyTurn=true + an unfinished plan → STILL no block (this is the every-turn pollution case);
//   3. plan survives a process swap → STILL no block (the old "hand-over" is deliberately gone);
//   4. custom 注入内容 no longer has any effect — nothing is injected regardless of settings;
//   5. the cockpit CLI is present as a SKILL, not injected in the prompt.
//
// The mock backend reports the SHAPE of what it received via its `[blocks]` trigger (a plain .text
// read cannot see the difference, which is exactly why this guard is about shape).
const BASE = process.env.BASE ?? "http://127.0.0.1:8901";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = await import("node:fs");
const path = await import("node:path");
const { DatabaseSync } = await import("node:sqlite");

const DATA = await (async () => {
  const candidates = [...new Set([process.env.AGENTUS_DATA, "/tmp/agentus-qa-account"].filter(Boolean))];
  for (const dir of candidates) {
    const file = path.join(dir, "auth.token");
    if (!fs.existsSync(file)) continue;
    const tok = fs.readFileSync(file, "utf8").trim();
    const r = await fetch(`${BASE}/api/sessions`, { headers: { authorization: `Bearer ${tok}` } }).catch(() => null);
    if (r?.ok) return dir;
  }
  throw new Error(`no data dir under test: tried ${candidates.join(", ")}`);
})();

const token = fs.readFileSync(path.join(DATA, "auth.token"), "utf8").trim();
const api = async (p, init = {}) => {
  const r = await fetch(BASE + p, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const freshSession = async (title) => (await api("/api/sessions", {
  method: "POST", body: JSON.stringify({ backend: "mock", cwd: "/tmp", title }),
})).body;
const statusOf = async (id) => {
  const { body } = await api("/api/sessions");
  return (body?.live ?? []).find((s) => s.id === id)?.status ?? "";
};
const idle = async (id, ms = 60000) => {
  const t0 = Date.now();
  for (;;) {
    const st = await statusOf(id);
    if (st !== "running" && st !== "starting") return st;
    if (Date.now() - t0 > ms) return st;
    await sleep(300);
  }
};
const say = async (id, text) => {
  await api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text }) });
  await idle(id);
  await sleep(400);
};
const lastReply = async (id) => {
  const { body } = await api(`/api/sessions/${id}/messages?tail=1`);
  const agents = (body?.messages ?? [])
    .filter((m) => m.kind === "agent")
    .map((m) => m.payload?.content?.text ?? "")
    .filter(Boolean);
  return agents.at(-1) ?? "";
};
const blocksSeen = (reply) => {
  const i = reply.indexOf("BLOCKS ");
  if (i < 0) return null;
  try { return JSON.parse(reply.slice(i + 7)); } catch { return null; }
};
const planBlockOf = (blocks) => (blocks ?? [])
  .find((b) => b?.type === "resource" && /agentus:\/\/plan\//.test(b?.resourceUri ?? "")) ?? null;

const seedPlan = (id, items) => {
  const db = new DatabaseSync(path.join(DATA, "agentus.sqlite"));
  db.prepare("delete from plans where session_id = ?").run(id);
  db.prepare(
    `insert into plans (session_id, revision, items, explanation, source, terminal, updated_at)
     values (?, 1, ?, null, 'tool', null, ?)`,
  ).run(id, JSON.stringify(items), Date.now());
  db.close();
};

const setHint = async (hint) => (await api("/api/settings", {
  method: "PUT", body: JSON.stringify({ prefs: { planHint: hint } }),
})).body;
const getHint = async () => (await api("/api/settings")).body?.prefs?.planHint ?? null;

const created = [];
const cleanup = async () => {
  for (const id of created) {
    try {
      const db = new DatabaseSync(path.join(DATA, "agentus.sqlite"));
      db.prepare("delete from plans where session_id = ?").run(id);
      db.close();
    } catch { /* row may be gone */ }
    await api(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
  }
};

console.log("== ① first prompt, no plan: only the operator's text, no plan block ==");
const before = await getHint();
await setHint({ on: true, everyTurn: false, instruction: "" });
const s1 = await freshSession("plan-hint sweep ①");
created.push(s1.id);
await idle(s1.id);
await say(s1.id, "[blocks] 第一步：先看一眼");
const b1 = blocksSeen(await lastReply(s1.id));
check("the mock reported the SHAPE of the prompt it received", Array.isArray(b1), String(b1 ?? "").slice(0, 160));
check("no plan resource block on the first prompt", planBlockOf(b1) === null, JSON.stringify(b1 ?? []).slice(0, 240));
check("the prompt carried exactly the operator's own text block",
  (b1 ?? []).length === 1 && b1[0].type === "text" && /第一步/.test(b1[0].body ?? ""),
  JSON.stringify(b1 ?? []).slice(0, 240));

console.log("\n== ② everyTurn=true + an unfinished plan: STILL no injection (was the pollution case) ==");
await setHint({ on: true, everyTurn: true, instruction: "" });
seedPlan(s1.id, [
  { content: "跑通注入链路", status: "completed" },
  { content: "写一条回归守卫", status: "in_progress" },
]);
await say(s1.id, "[blocks] 第二步");
const b2 = blocksSeen(await lastReply(s1.id));
check("everyTurn=true with a plan on the card injects NOTHING", planBlockOf(b2) === null, JSON.stringify(b2 ?? []).slice(0, 240));
check("the open step's text is NOT leaked into the user message",
  !/写一条回归守卫|跑通注入链路/.test(JSON.stringify(b2 ?? [])), JSON.stringify(b2 ?? []).slice(0, 240));

console.log("\n== ③ after a process swap, a plan on the card is still NOT injected ==");
await api(`/api/sessions/${s1.id}/restart`, { method: "POST" }).catch(() => {});
await sleep(1500);
await idle(s1.id);
await say(s1.id, "[blocks] 重启后");
const b3 = blocksSeen(await lastReply(s1.id));
check("a restarted agent is NOT fed the plan block", planBlockOf(b3) === null, JSON.stringify(b3 ?? []).slice(0, 240));
check("the operator's own text still arrives", /重启后/.test(JSON.stringify(b3 ?? [])), JSON.stringify(b3 ?? []).slice(0, 240));

console.log("\n== ④ custom 注入内容 has no effect — nothing is injected regardless of settings ==");
await setHint({ on: true, everyTurn: true, instruction: "HOUSE RULE: 多步任务用 update_plan" });
await say(s1.id, "[blocks] 自定义文案这一条");
const b4 = blocksSeen(await lastReply(s1.id));
check("a custom instruction does not resurrect the injection", planBlockOf(b4) === null, JSON.stringify(b4 ?? []).slice(0, 240));
check("custom text is not appended to the prompt",
  !/HOUSE RULE/.test(JSON.stringify(b4 ?? [])), JSON.stringify(b4 ?? []).slice(0, 240));

console.log("\n== ⑤ the cockpit CLI lives in the agentus-cockpit SKILL, not in the prompt ==");
const skill = path.resolve("skills/agentus-cockpit/SKILL.md");
check("agentus-cockpit skill file exists", fs.existsSync(skill), skill);
const skillText = fs.existsSync(skill) ? fs.readFileSync(skill, "utf8") : "";
check("the skill documents the cross-session CLI (session list / send)",
  /session list/.test(skillText) && /AGENTUS_COCKPIT_BIN/.test(skillText) && /session send/.test(skillText),
  skillText.slice(0, 200));

await cleanup();
const FALLBACK = { on: true, everyTurn: true, instruction: "" };
await setHint(before ?? FALLBACK);
const after = await getHint();
check("the sweep put the setting back the way it found it",
  JSON.stringify(after) === JSON.stringify(before ?? FALLBACK),
  `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
