// 会话内的身份，在「执行体不在我们 spawn 的那个进程里」之后还到不到得了工具进程（issue #106）。
//
// 两条链各自成立、接不上：cockpit 把 per-session token 写进它 spawn 的 child 环境；Hermes 0.23 起
// 回合跑在常驻共享 gateway 里，工具子进程继承的是 GATEWAY 的环境。同时 `session delete` 的门是
// 「有 cockpit 身份就拒」，于是**没有身份**被当成了「操作者在终端里」—— 实测一路 purged。
//
// 这个 sweep 用 mock 的 MOCK_GATEWAY_OWNED=1 复刻那个形状（握手时 `_meta.hermes.sessionProvenance`），
// 然后分别扮演两个角色去敲真 CLI：
//   · 工具子进程 —— 只带运行时自己的会话标记（HERMES_SESSION_CHAT_ID），没有任何 AGENTUS_COCKPIT_*，
//     数据目录里还躺着一份可读的 auth.token（agent 读得到，这正是 #106 说的处境）；
//   · 人在终端 —— 只有 AGENTUS_DATA/PORT，没有运行时标记。
//
//   node scripts/qa/cockpit-identity-sweep.mjs
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer as createTcp } from "node:net";

const ROOT = path.resolve(import.meta.dirname, "../..");
const BIN = path.join(ROOT, "bin/agentus.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const freePort = () => new Promise((res, rej) => {
  const s = createTcp();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});

const PORT = await freePort();
const dataDir = mkdtempSync(path.join(tmpdir(), "agentus-id106-data-"));
// HOME 就是那个人口：CLI 只会去 ~/.agentus/cockpit 按会话号找文件，所以整台实例换一个 HOME，
// 断言也就不会碰到操作者真机上的那些文件。
const home = mkdtempSync(path.join(tmpdir(), "agentus-id106-home-"));
const BASE = `http://127.0.0.1:${PORT}`;
const ENV_MARKERS = ["HERMES_SESSION_CHAT_ID", "HERMES_SESSION_ID", "AGENTUS_SESSION_ROLE"];
const COCKPIT_VARS = ["AGENTUS_COCKPIT_ENDPOINT", "AGENTUS_COCKPIT_TOKEN", "AGENTUS_COCKPIT_SESSION", "AGENTUS_COCKPIT_BIN"];

let log = "";
const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
  detached: true,
  cwd: ROOT,
  env: {
    ...process.env, NODE_ENV: "development", HOME: home,
    AGENTUS_PORT: String(PORT), AGENTUS_DATA: dataDir,
    MOCK_SLOW_MS: "20",
    // the shape that broke it: the agent owns the session, not our child
    MOCK_GATEWAY_OWNED: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
proc.stdout.on("data", (d) => { log += String(d); });
proc.stderr.on("data", (d) => { log += String(d); });
for (let i = 0; i < 200 && !log.includes(`:${PORT}`); i++) await sleep(150);
for (let i = 0; i < 120; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }

// The cockpit's own credential, for the harness's backstage calls. It has to be a REAL one: the red
// proof below is 「an agent that can read this file can purge」, and a token the server rejects would
// prove nothing.
const machineToken = () => String(fs.readFileSync(path.join(dataDir, "auth.token"), "utf8")).trim();
const api = async (p, init = {}) => {
  const res = await fetch(`${BASE}${p}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: ["Bearer", machineToken()].join(" "),
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/** Point the builtin hermes row at the mock: same trick the other cockpit sweeps use (no live home,
 *  no real agent, and `MOCK_GATEWAY_OWNED` makes the handshake claim vendor ownership). */
const { body: rows } = await api("/api/backends");
const hermes = (rows ?? []).find((r) => r.id === "hermes");
await api("/api/backends/hermes", {
  method: "PUT",
  body: JSON.stringify({
    ...hermes, cmd: process.execPath, args: [path.join(ROOT, "packages/server/mock/agent.mjs")],
    home: null, env: [], profile: null, cwd: null,
  }),
});

// `send` has its own gate (驾驶舱互发消息); it is the operator's switch and defaults to OFF. Opened here
// for the duration of the sweep only — the point being tested is the IDENTITY, not that policy.
await api("/api/settings", { method: "PUT", body: JSON.stringify({ agent: { cockpitSend: true } }) });

/** Run the real CLI. `extra` is the whole identity story for this call: these sweeps never inherit the
 *  harness's own environment as an accident, because that is exactly the confusion #106 is about. */
const cli = (extra, args) => {
  const env = { ...process.env, HOME: home, ...extra };
  for (const k of [...COCKPIT_VARS, ...ENV_MARKERS]) delete env[k];
  Object.assign(env, extra);
  try {
    const out = execFileSync(process.execPath, [BIN, ...args], {
      cwd: ROOT, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    let doc = null;
    try { doc = JSON.parse(out); } catch { /* --table prints prose */ }
    return { code: 0, out, doc };
  } catch (e) {
    let doc = null;
    try { doc = JSON.parse(String(e.stdout ?? "")); } catch { /* non-JSON failure */ }
    return { code: e.status ?? -1, out: String(e.stdout ?? ""), err: String(e.stderr ?? ""), doc };
  }
};

/** The rail row for one id — `live` first, then `cold` (a slot that did not come up). */
const rowOf = async (id) => {
  const { body } = await api("/api/sessions");
  return [...(body?.live ?? []), ...(body?.cold ?? [])].find((s) => s.id === id) ?? null;
};
const createSession = async (title) => {
  const made = await api("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ backend: "hermes", cwd: mkdtempSync(path.join(tmpdir(), "agentus-id106-ws-")), title }),
  });
  const id = made.body?.id;
  if (!id) throw new Error(`could not create ${title}: ${JSON.stringify(made.body)}`);
  for (let i = 0; i < 100; i++) {
    const row = await rowOf(id);
    if (row?.status === "ready") return row;
    if (row?.status === "error") throw new Error(`${title} failed: ${JSON.stringify(row.lastError ?? row)}`);
    await sleep(200);
  }
  throw new Error(`${title} never reached ready`);
};

const rowA = await createSession("身份探针");
const A = rowA.id;
check("a gateway-owned slot starts (mock claims _meta.hermes.sessionProvenance)",
  rowA.status === "ready", JSON.stringify(rowA).slice(0, 120));
const AGENT_ID = rowA.acpSessionId;
check("…and the row carries the agent-side session id (the lookup key)", Boolean(AGENT_ID), String(AGENT_ID));

// ---- ① 身份文件 ----------------------------------------------------------------
const idDir = path.join(home, ".agentus", "cockpit");
const idFile = path.join(idDir, `${AGENT_ID}.json`);
check("the cockpit published an identity file named by the AGENT-side session id",
  fs.existsSync(idFile), idFile.replace(home, "~"));
let pub = {};
try { pub = JSON.parse(fs.readFileSync(idFile, "utf8")); } catch { /* reported below */ }
check("…carrying the endpoint, a per-session token and OUR session id",
  pub.endpoint === BASE && typeof pub.token === "string" && pub.session === A,
  JSON.stringify({ endpoint: pub.endpoint, session: pub.session, token: pub.token ? "***" : "" }));
// Guards, not optimism: on the OLD build these files do not exist at all, and a sweep that dies at the
// first missing file hides the two assertions below it that actually describe the damage.
const mode = (p) => (fs.existsSync(p) ? fs.statSync(p).mode & 0o777 : 0);
check("…and it is 0600 inside a 0700 directory",
  mode(idFile) === 0o600 && mode(idDir) === 0o700,
  `${mode(idFile).toString(8)} / ${mode(idDir).toString(8)}`);
const diskToken = (() => {
  try { return machineToken(); } catch { return ""; }
})();
check("…it is NOT the operator's machine token", Boolean(pub.token) && pub.token !== diskToken);

// ---- ② 工具子进程：只剩运行时标记，也没有一条 AGENTUS_COCKPIT_* ------------------
// AGENTUS_PORT is here for the OLD build's sake: without it the operator fallback aims at the default
// 8788 (the operator's live cockpit) and the red proof would be about a port, not about identity.
const AS_TURN = {
  HOME: home, HERMES_SESSION_CHAT_ID: AGENT_ID, HERMES_SESSION_ID: "20261113_220116_probe",
  AGENTUS_DATA: dataDir, AGENTUS_PORT: String(PORT),
};
const listed = cli(AS_TURN, ["session", "list", "--here"]);
check("a TOOL subprocess (runtime markers only) still reaches the cockpit", listed.code === 0 && listed.doc?.success === true,
  listed.doc?.error ? JSON.stringify(listed.doc.error) : `code ${listed.code}`);
check("…and it is identified as ITS session, not as the operator",
  listed.doc?.data?.self?.id === A, JSON.stringify(listed.doc?.data?.self ?? null));

// ---- ③ 派活：--reply-on-done 恢复 ------------------------------------------------
const B = (await createSession("收件人")).id;
const sent = cli(AS_TURN, ["session", "send", B, "身份恢复探针", "--reply-on-done"]);
check("--reply-on-done from inside a turn is ACCEPTED (it used to be 400 'only another session…')",
  sent.code === 0 && sent.doc?.success === true,
  sent.doc?.error ? JSON.stringify(sent.doc.error) : `code ${sent.code}`);
// The provenance card is the SAME mechanism: no origin ⇒ the target shows the words as the operator's.
for (let i = 0; i < 40; i++) {
  const { body } = await api(`/api/sessions/${B}/messages?tail=10`);
  const hit = (body?.messages ?? []).find((m) => String(m.payload?.text ?? "").includes("身份恢复探针"));
  if (hit) {
    check("…and the delivered row carries `origin` — the source the target's bubble renders as 来自「…」",
      hit.payload?.origin?.sessionId === A, JSON.stringify(hit.payload?.origin ?? null));
    break;
  }
  await sleep(150);
}

// ---- ④ fail-closed：没有身份 ≠ 操作员 ------------------------------------------
// The situation #106 demonstrated: the agent can read <data>/auth.token, and it has no cockpit identity.
// Both of those are true for this call — and the answer must still be a refusal.
const sneaky = cli({
  HOME: home, HERMES_SESSION_CHAT_ID: "some-other-agent-session", AGENTUS_DATA: dataDir, AGENTUS_PORT: String(PORT),
}, ["session", "delete", B]);
check("a TOOL subprocess WITHOUT an identity cannot delete history, even holding the machine token",
  sneaky.code !== 0 && sneaky.doc?.error?.code === "agents_may_not_delete",
  JSON.stringify(sneaky.doc?.error ?? sneaky.doc ?? `code ${sneaky.code}`));
const stillThere = await rowOf(B);
check("…and the row is untouched (no purge happened)", Boolean(stillThere), JSON.stringify(stillThere ?? null).slice(0, 80));

// An identity that DID resolve is a session, never the operator — the door stays shut for it too (#73).
const byFile = cli(AS_TURN, ["session", "delete", B]);
check("…and a resolved session identity is refused the same way (identity ≠ operator)",
  byFile.code !== 0 && byFile.doc?.error?.code === "agents_may_not_delete",
  JSON.stringify(byFile.doc?.error ?? `code ${byFile.code}`));

// ---- ⑤ 人在终端仍然能删（别把门焊死了）------------------------------------------
const human = cli({ HOME: home, AGENTUS_DATA: dataDir, AGENTUS_PORT: String(PORT) }, ["session", "delete", B]);
check("a HUMAN shell (no runtime markers, auth.token on disk) still gets operator mode",
  human.code === 0 && human.doc?.success === true,
  human.doc?.error ? JSON.stringify(human.doc.error) : `code ${human.code}`);

// ---- ⑥ 槽位一死，文件随之消失 --------------------------------------------------
cli(AS_TURN, ["session", "stop", A, "--close"]);
for (let i = 0; i < 60 && fs.existsSync(idFile); i++) await sleep(200);
check("closing the slot removes the file (a dead token must not keep advertising itself)", !fs.existsSync(idFile),
  fs.existsSync(idFile) ? "still there" : "gone");

console.log(`\n${pass} passed, ${fail} failed`);
try { process.kill(-proc.pid, "SIGKILL"); } catch { /* already gone */ }
process.exit(fail ? 1 : 0);