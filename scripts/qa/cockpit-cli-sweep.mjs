// The cockpit CLI, end to end (issue #15): identity in the environment, the read data plane, and the
// gated `send`.
//
// Everything here goes through the REAL path: a mock session is spawned by the real server, its
// `AGENTUS_COCKPIT_*` identity is read off the child process (which is exactly what an agent would
// find in its own environment), and `bin/agentus-cockpit.mjs` is executed as a separate process.
// Nothing is stubbed, so a broken token, a missing route or a wrong envelope all show up.
//
//   AGENTUS_BASE=http://127.0.0.1:8901 AGENTUS_DATA=/tmp/agentus-qa-account node scripts/qa/cockpit-cli-sweep.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.AGENTUS_BASE ?? "http://127.0.0.1:8901";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const DATA = process.env.AGENTUS_DATA ?? "/tmp/agentus-qa-account";
const CLI = path.join(REPO, "bin/agentus-cockpit.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const token = fs.readFileSync(path.join(DATA, "auth.token"), "utf8").trim();
const api = async (p, init = {}) => {
  const r = await fetch(`${BASE}${p}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; }
};

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

/** Run the CLI the way an agent would, with the target session's own identity in the environment. */
const cli = (env, args, stdin) => {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      cwd: REPO, env: { ...process.env, ...env }, input: stdin, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, doc: JSON.parse(out), stderr: "" };
  } catch (e) {
    const out = String(e.stdout ?? "");
    return { code: e.status ?? -1, doc: out ? JSON.parse(out) : null, stderr: String(e.stderr ?? "") };
  }
};

/** The identity the cockpit handed this child: read from ITS process, the same way `ps` would show it. */
const identityOf = (pid) => {
  const env = execFileSync("ps", ["eww", "-p", String(pid)], { encoding: "utf8" });
  const found = {};
  for (const kv of env.split(/\s+/)) {
    const at = kv.indexOf("=");
    if (at > 0 && kv.startsWith("AGENTUS_COCKPIT_")) found[kv.slice(0, at)] = kv.slice(at + 1);
  }
  return found;
};

const mkSession = async (title) => {
  const made = await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "mock", cwd: "/tmp", title }) });
  const id = made.body?.id;
  if (!id) throw new Error(`could not create ${title}: ${JSON.stringify(made.body)}`);
  for (let i = 0; i < 60; i++) {
    const rows = (await api("/api/sessions")).body.live ?? [];
    const row = rows.find((s) => s.id === id);
    if (row?.status === "ready" && row.pid) return row;
    await sleep(300);
  }
  throw new Error(`${title} never reached ready`);
};
const purge = async (id) => {
  await api(`/api/sessions/${id}`, { method: "DELETE" });
  await api(`/api/sessions/${id}`, { method: "DELETE" }); // cold → purge
};

const before = (await api("/api/settings")).body.agent?.cockpitSend ?? false;
const src = await mkSession("cockpit-cli src（自动删除）");
const dst = await mkSession("cockpit-cli dst（自动删除）");
const env = identityOf(src.pid);
const SID = env.AGENTUS_COCKPIT_SESSION;
console.log(`      src=${SID} dst=${dst.id} send was ${before ? "ON" : "OFF"}`);

try {
  // ---- identity: the cockpit hands it to the child, and only to the child ----
  check("the spawned agent carries AGENTUS_COCKPIT_ENDPOINT/_TOKEN/_SESSION",
    Boolean(env.AGENTUS_COCKPIT_ENDPOINT && env.AGENTUS_COCKPIT_TOKEN && SID), JSON.stringify(Object.keys(env)));
  check("…and the path of this very CLI (so `$AGENTUS_COCKPIT_BIN` works in bash)",
    env.AGENTUS_COCKPIT_BIN === CLI, String(env.AGENTUS_COCKPIT_BIN));
  check("…with a token minted per process (not a shared secret)",
    env.AGENTUS_COCKPIT_TOKEN !== token, "it equals the operator's machine token");

  // ---- a bad token is refused as a CODE, not as an HTTP lecture ----
  const bad = cli({ ...env, AGENTUS_COCKPIT_TOKEN: "nope" }, ["context"]);
  check("a wrong token answers code:bad_token and exits non-zero",
    bad.code !== 0 && bad.doc?.error?.code === "bad_token", JSON.stringify(bad.doc?.error ?? bad.stderr));

  // ---- capabilities: self-describing, and it tells the truth about `send` ----
  const caps = cli(env, ["capabilities"]).doc?.data;
  check("capabilities lists every command", ["capabilities", "context", "session", "messages", "plan", "send", "skill"]
    .every((c) => (caps?.commands ?? []).some((x) => x.name === c)), JSON.stringify((caps?.commands ?? []).map((c) => c.name)));
  check("…documents the truncation it actually applies (600 chars / 40 max)",
    String(caps?.truncation?.messages ?? "").includes("600") && String(caps?.truncation?.tail ?? "").includes("40"),
    JSON.stringify(caps?.truncation));
  check("…and states the send gate the operator's setting currently has",
    String(caps?.scope?.send ?? "").startsWith(before ? "ENABLED" : "DISABLED"), String(caps?.scope?.send));

  // ---- the skill document: the manual an agent reads on demand, not in every prompt ----
  const skillDoc = execFileSync(process.execPath, [CLI, "skill"], { cwd: REPO, encoding: "utf8" });
  check("`skill` serves the bundled document (issue: agents need the manual, not a paste)",
    /^---\nname: agentus-cockpit\n/.test(skillDoc) && skillDoc.includes("delivered"), `${skillDoc.length} bytes`);
  const skillPath = execFileSync(process.execPath, [CLI, "skill", "--path"], { cwd: REPO, encoding: "utf8" }).trim();
  check("…from a path inside this install, which is what a native-skill backend reads",
    fs.existsSync(skillPath) && fs.readFileSync(skillPath, "utf8") === skillDoc, skillPath);
  // ---- context: who am I, and what else is there ----
  const ctx = cli(env, ["context"]).doc;
  check("context identifies the CALLER (not the first row in the list)", ctx?.data?.self?.id === SID, String(ctx?.data?.self?.id));
  check("…and lists the other live session in scope",
    (ctx?.data?.sessions ?? []).some((s) => s.id === dst.id), `${(ctx?.data?.sessions ?? []).length} rows`);
  check("…never an archived row", (ctx?.data?.sessions ?? []).every((s) => s.archived === false));

  // ---- messages: the tail, bounded, with a per-message cap ----
  await api(`/api/sessions/${SID}/prompt`, { method: "POST", body: JSON.stringify({ text: "你好，CLI 转录测试" }) });
  await sleep(1500);
  const msgs = cli(env, ["messages", SID, "--tail", "5"]).doc;
  check("messages returns the tail of the transcript", (msgs?.data?.messages ?? []).some((m) =>
    String(m.text).includes("CLI 转录测试")), `${(msgs?.data?.messages ?? []).length} rows`);
  check("…with the documented cap declared in meta", msgs?.meta?.returned <= 5 && msgs?.meta?.asked === 5,
    JSON.stringify(msgs?.meta));
  const big = cli(env, ["messages", SID, "--tail", "999"]).doc;
  check("…and `--tail 999` is CLAMPED to the maximum, saying so",
    big?.meta?.returned <= 40 && big?.meta?.capped === true, JSON.stringify(big?.meta));

  // ---- plan + session detail ----
  const plan = cli(env, ["plan", SID]).doc;
  check("plan answers the plan object (null when there is none)", plan?.success === true && "plan" in (plan.data ?? {}),
    JSON.stringify(plan?.data));
  const one = cli(env, ["session", dst.id]).doc;
  check("session gives one row plus anything it is waiting on",
    one?.data?.session?.id === dst.id && Array.isArray(one?.data?.pending), JSON.stringify(Object.keys(one?.data ?? {})));

  // ---- send: gated, honest, and never a claim about having been read ----
  if (before) await api("/api/settings", { method: "PUT", body: JSON.stringify({ agent: { cockpitSend: false } }) });
  const off = cli(env, ["send"], JSON.stringify({ to: dst.id, message: "应该被拒" }));
  check("with the gate OFF, send answers code:sends_disabled", off.code !== 0 && off.doc?.error?.code === "sends_disabled",
    JSON.stringify(off.doc?.error));

  await api("/api/settings", { method: "PUT", body: JSON.stringify({ agent: { cockpitSend: true } }) });
  const okSend = cli(env, ["send"], JSON.stringify({ to: dst.id, message: "来自 CLI：目标空闲" }));
  check("with the gate ON and an idle target, send reports delivered", okSend.code === 0 && okSend.doc?.data?.delivered === true,
    JSON.stringify(okSend.doc?.data ?? okSend.doc?.error));
  check("…and says plainly that delivered is not read",
    String(okSend.doc?.meta?.note ?? "").includes("does NOT mean it read"), String(okSend.doc?.meta?.note));
  const landed = (await api(`/api/sessions/${dst.id}/messages`)).body?.messages ?? [];
  check("…the target's own transcript holds the message (the far side, not our own echo)",
    landed.some((m) => m.kind === "user" && JSON.stringify(m.payload ?? "").includes("目标空闲")));

  // a BUSY target must be refused, because a cross-session message may not take the floor from a turn
  // the operator started. `[slow]` = the mock streams for ~20 s.
  await api(`/api/sessions/${dst.id}/prompt`, { method: "POST", body: JSON.stringify({ text: "[slow] 我在忙" }) });
  await sleep(1200);
  const busySend = cli(env, ["send"], JSON.stringify({ to: dst.id, message: "目标正忙" }));
  check("a busy target answers code:target_busy (nothing was delivered)", busySend.code !== 0 && busySend.doc?.error?.code === "target_busy",
    JSON.stringify(busySend.doc?.data ?? busySend.doc?.error));

  const coldTarget = (await api("/api/sessions")).body.cold?.[0]?.id;
  if (coldTarget) {
    const coldSend = cli(env, ["send"], JSON.stringify({ to: coldTarget, message: "冷槽位" }));
    check("a COLD target answers code:target_cold (the cockpit does not wake it for you)",
      coldSend.code !== 0 && coldSend.doc?.error?.code === "target_cold", JSON.stringify(coldSend.doc?.error));
  }
  const nowhere = cli(env, ["send"], JSON.stringify({ to: "sess_nope", message: "x" }));
  check("an out-of-scope target answers code:out_of_scope", nowhere.code !== 0 && nowhere.doc?.error?.code === "out_of_scope",
    JSON.stringify(nowhere.doc?.error));
  const blank = cli(env, ["send"], JSON.stringify({ to: dst.id, message: "   " }));
  check("an empty message is refused before anything is sent", blank.code !== 0 && blank.doc?.error?.code === "bad_request",
    JSON.stringify(blank.doc?.error));
} finally {
  await api(`/api/settings`, { method: "PUT", body: JSON.stringify({ agent: { cockpitSend: before } }) });
  await purge(src.id);
  await purge(dst.id);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
