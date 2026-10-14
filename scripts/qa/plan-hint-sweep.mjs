// QA: the plan-tool hint — does the agent ever LEARN that this session has a plan tool?
//
//   node scripts/qa/plan-hint-sweep.mjs
//
// Why this sweep exists (issue #9, 2026-10-14): the cockpit mounts a plan MCP on every session and
// the plan card renders what it writes, but agents kept publishing nothing. The tool's own
// description says "PREFER THIS over any checklist/todo tool" — on a runtime that keeps MCP tools in
// a lazy-loaded catalog (Hermes), the model never reads that description unless it goes looking, so
// the last mile was missing: nothing on the wire ever said the tool existed. Studio closes it by
// appending a template to the latest input every turn (`task-plan-runs.ts`); this does the same, and
// this sweep is the guard on the wire, not on the wording.
//
// What it proves, in order:
//   1. a session's FIRST prompt carries the hint block, and it names the tool (`update_plan`) —
//      including when the session has no plan yet, which is the case that used to say NOTHING;
//   2. with 频率 set to 仅首条, a later prompt does NOT carry it (a one-step request does not pay);
//   3. 每回合 carries it on EVERY turn, plan or no plan, exactly like Studio's unconditional
//      `task-plan-runs.ts` append — including the "no plan yet" turn, which is the one where the
//      nudge buys the most (an agent never told the tool exists uses its own todo instead);
//   4. switching the master switch OFF stops it on the very next prompt — and does NOT consume the
//      hand-over, so turning it back on delivers the plan rather than losing it;
//   5. an unfinished plan rides along as STEPS, and survives a process swap;
//   6. 注入内容 (settings.prefs.planHint.instruction) REPLACES the built-in guidance wording without
//      touching the plan STATUS half, and clearing the box brings the built-in text back.
//
// The mock backend is used throughout: no tokens. Its `[blocks]` trigger reports the SHAPE of what
// arrived (a plain `.text` read cannot see a `resource` block, which is exactly what the hint is).
const BASE = process.env.BASE ?? "http://127.0.0.1:8901";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = await import("node:fs");
const path = await import("node:path");
const { DatabaseSync } = await import("node:sqlite");

// Which data dir belongs to the instance under test? By EVIDENCE: an inherited AGENTUS_DATA must not
// hand this sweep another cockpit's token (the symptom is a wall of "unauthorized").
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

/** The blocks the agent saw, parsed out of the mock's `BLOCKS [...]` report. */
const blocksSeen = (reply) => {
  const i = reply.indexOf("BLOCKS ");
  if (i < 0) return null;
  try { return JSON.parse(reply.slice(i + 7)); } catch { return null; }
};
// The mock mirrors ACP's own field names (`resourceUri`, `meta`), which is what makes a resource
// block distinguishable from the operator's text at all.
const planBlockOf = (blocks) => (blocks ?? [])
  .find((b) => b?.type === "resource" && /agentus:\/\/plan\//.test(b?.resourceUri ?? "")) ?? null;

/** Put a plan on the card without going through an agent. The card renders this row, so this leaves
 *  behind exactly the state a real `update_plan` call would. */
const seedPlan = (id, items) => {
  const db = new DatabaseSync(path.join(DATA, "agentus.sqlite"));
  db.prepare("delete from plans where session_id = ?").run(id);
  db.prepare(
    `insert into plans (session_id, revision, items, explanation, source, terminal, updated_at)
     values (?, 1, ?, null, 'tool', null, ?)`,
  ).run(id, JSON.stringify(items), Date.now());
  db.close();
};

/** Settings are global: whatever this sweep changes must go back, or every later sweep inherits it. */
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
    } catch { /* the row may already be gone */ }
    await api(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
  }
};

console.log("== ① a session's first prompt carries the hint, and it NAMES the tool ==");
const before = await getHint();
console.log(`      settings before: ${JSON.stringify(before)}`);
// instruction: "" pins the wording to the built-in text — the assertions below are about what that
// text SAYS, and an operator who has written their own would otherwise fail them for the right
// reason (their text is fine, it just is not this text). ⑦ puts a custom one back.
await setHint({ on: true, everyTurn: false, instruction: "" });

const s1 = await freshSession("plan-hint sweep ①");
created.push(s1.id);
await idle(s1.id);
await say(s1.id, "[blocks] 第一步：先看一眼");

const r1 = await lastReply(s1.id);
const b1 = blocksSeen(r1);
check("the mock reported the SHAPE of the prompt it received", Array.isArray(b1), String(r1).slice(0, 160));
const hintBlock = planBlockOf(b1);
check("a plan `resource` block arrived on the FIRST prompt of a session with NO plan yet",
  hintBlock !== null, JSON.stringify(b1 ?? []).slice(0, 300));
check("…and it names the tool the agent is supposed to use",
  /update_plan/.test(hintBlock?.body ?? ""), String(hintBlock?.body ?? "").slice(0, 200));
check("…and it says the tool may be deferred, with how to find it",
  /agentus_plan update_plan|deferred/i.test(hintBlock?.body ?? ""),
  String(hintBlock?.body ?? "").slice(0, 260));
check("…and it is TAGGED, so the cockpit can tell its own block from the operator's words",
  hintBlock?.meta?.["agentus/plan-reminder"] === true, JSON.stringify(hintBlock?.meta));
check("…and it does NOT invent a plan that does not exist (no step lines)",
  !/^- \[/m.test(hintBlock?.body ?? ""), String(hintBlock?.body ?? "").slice(0, 200));
check("…and it tells the agent to prefer it over its own todo tool",
  /todo/i.test(hintBlock?.body ?? ""), String(hintBlock?.body ?? "").slice(0, 200));

console.log("\n== ② with 频率 set to 仅首条, a later prompt does NOT carry it ==");
await say(s1.id, "[blocks] 第二步");
const r2 = await lastReply(s1.id);
const b2 = blocksSeen(r2);
check("the second prompt still reported its shape", Array.isArray(b2), String(r2).slice(0, 120));
check("…and it carries NO plan block — a one-step request does not pay for the hint",
  planBlockOf(b2) === null, JSON.stringify(b2 ?? []).slice(0, 240));

console.log("\n== ③ 每回合 injects on EVERY turn — with a plan or without one (the Studio behaviour) ==");
await setHint({ on: true, everyTurn: true });
await say(s1.id, "[blocks] 第三步");
const b3a = blocksSeen(await lastReply(s1.id));
const hintIntro = planBlockOf(b3a);
check("with NO plan on the card yet, 每回合 still carries the INTRODUCTION — this is the turn that matters most, because an agent never told the tool exists reaches for its own todo list",
  hintIntro !== null, JSON.stringify(b3a ?? []).slice(0, 240));
check("…and the introduction does not invent steps for a plan that does not exist",
  hintIntro !== null && !/^- \[/m.test(hintIntro.body ?? ""), String(hintIntro?.body ?? "").slice(0, 240));

seedPlan(s1.id, [
  { content: "跑通注入链路", status: "completed" },
  { content: "写一条回归守卫", status: "in_progress" },
]);
await say(s1.id, "[blocks] 第四步");
const b3b = blocksSeen(await lastReply(s1.id));
const hint3 = planBlockOf(b3b);
check("with an unfinished plan on the card, 每回合 injects on the very next prompt — live, no restart",
  hint3 !== null, JSON.stringify(b3b ?? []).slice(0, 240));
check("…and it carries the OPEN step's own text",
  /写一条回归守卫/.test(hint3?.body ?? ""), String(hint3?.body ?? "").slice(0, 300));
check("…and it does not bother with the already-closed step",
  !/跑通注入链路/.test(hint3?.body ?? ""), String(hint3?.body ?? "").slice(0, 300));
check("…and it asks the agent to keep it current, naming the tool",
  /update_plan/.test(hint3?.body ?? ""), String(hint3?.body ?? "").slice(0, 240));

console.log("\n== ④ off: the very next prompt is the operator's words and nothing else ==");
await setHint({ on: false, everyTurn: false });
await say(s1.id, "[blocks] 第四步");
const b4 = blocksSeen(await lastReply(s1.id));
check("with the master switch off, no plan block is injected at all",
  planBlockOf(b4) === null, JSON.stringify(b4 ?? []).slice(0, 240));
check("…and the prompt carried exactly the operator's own block (nothing appended)",
  (b4 ?? []).filter((b) => b.type !== "text" || !/\[blocks\]/.test(b.body ?? "")).length === 0,
  JSON.stringify((b4 ?? []).map((b) => b.type)));

console.log("\n== ⑤ a hand-over is not CONSUMED while the switch is off ==");
// A session whose FIRST prompt goes out with the hint disabled: its plan hand-over is still owed, and
// it must arrive once the switch is back on instead of being silently eaten. (On s1 the hand-over was
// already spent in ①, so this needs a fresh process.)
await setHint({ on: false, everyTurn: false });
const s2 = await freshSession("plan-hint sweep ⑤");
created.push(s2.id);
await idle(s2.id);
await say(s2.id, "[blocks] 关着开关的首条");
const bOff = blocksSeen(await lastReply(s2.id));
check("the first prompt of a fresh session, with the switch off, carries nothing at all",
  planBlockOf(bOff) === null, JSON.stringify(bOff ?? []).slice(0, 200));
check("…and it really was the first prompt of that process (only the operator's block)",
  (bOff ?? []).length === 1 && bOff[0].type === "text", JSON.stringify(bOff ?? []).slice(0, 200));

await setHint({ on: true, everyTurn: false });
await say(s2.id, "[blocks] 打开开关后的下一条");
const bOn = blocksSeen(await lastReply(s2.id));
check("switching back on delivers the hand-over on the NEXT turn rather than losing it",
  planBlockOf(bOn) !== null, JSON.stringify(bOn ?? []).slice(0, 240));

console.log("\n== ⑥ an unfinished plan survives a process swap and rides along as STEPS ==");
seedPlan(s2.id, [
  { content: "旧进程留下的未完成步骤", status: "in_progress" },
  { content: "已经做完的那条", status: "completed" },
]);
// A freshly (re)started agent has no memory of the plan on the card — /restart swaps the process
// under the same live slot, which is exactly the case the hand-over exists for.
await api(`/api/sessions/${s2.id}/restart`, { method: "POST" }).catch(() => {});
await sleep(1500);
await idle(s2.id);
await say(s2.id, "[blocks] 重启后");
const b6 = blocksSeen(await lastReply(s2.id));
const plan6 = planBlockOf(b6);
check("a freshly (re)started agent is told the plan it cannot remember", plan6 !== null,
  JSON.stringify(b6 ?? []).slice(0, 240));
check("…and the open step's own text rides along",
  /旧进程留下的未完成步骤/.test(plan6?.body ?? ""), String(plan6?.body ?? "").slice(0, 300));
check("…and the finished step is left out",
  !/已经做完的那条/.test(plan6?.body ?? ""), String(plan6?.body ?? "").slice(0, 300));
check("…and it names the tool to keep it current with",
  /update_plan/.test(plan6?.body ?? ""), String(plan6?.body ?? "").slice(0, 300));

console.log("\n== ⑦ 注入内容可编辑：自定义文案取代内置指引，计划状态仍由卡片生成 ==");
const CUSTOM = "HOUSE RULE: 多步任务先调 update_plan 建计划（团队约定），别用自带的 todo。";
await setHint({ on: true, everyTurn: true, instruction: CUSTOM });
await say(s2.id, "[blocks] 自定义文案这一条");
const b7 = blocksSeen(await lastReply(s2.id));
const plan7 = planBlockOf(b7);
check("with 注入内容 filled in, the block still arrives", plan7 !== null,
  JSON.stringify(b7 ?? []).slice(0, 240));
check("…and it carries the operator's own words", /HOUSE RULE/.test(plan7?.body ?? ""),
  String(plan7?.body ?? "").slice(0, 300));
check("…and the built-in wording is GONE — the edit REPLACES the guidance, it does not append to it",
  !/This session has an `update_plan` tool mounted on it/.test(plan7?.body ?? "")
    && !/Carry on with it, and keep it updated with the `update_plan` tool/.test(plan7?.body ?? ""),
  String(plan7?.body ?? "").slice(0, 300));
check("…and the STATUS half is still generated from the card (the open step is named, unedited)",
  /旧进程留下的未完成步骤/.test(plan7?.body ?? ""), String(plan7?.body ?? "").slice(0, 300));

await setHint({ on: true, everyTurn: true, instruction: "" });
await say(s2.id, "[blocks] 清空之后");
const b8 = blocksSeen(await lastReply(s2.id));
const plan8 = planBlockOf(b8);
check("clearing the box brings the built-in wording back",
  /update_plan/.test(plan8?.body ?? "") && !/HOUSE RULE/.test(plan8?.body ?? ""),
  String(plan8?.body ?? "").slice(0, 240));

await cleanup();
// Falls back to PREFS_DEFAULT's shape (on + every turn + built-in wording) when the instance had no
// settings row yet — "restoring" a 仅首条 default here would silently change behaviour.
const FALLBACK = { on: true, everyTurn: true, instruction: "" };
await setHint(before ?? FALLBACK);
const after = await getHint();
check("the sweep put the setting back the way it found it",
  JSON.stringify(after) === JSON.stringify(before ?? FALLBACK),
  `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
