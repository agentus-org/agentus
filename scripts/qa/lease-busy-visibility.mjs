// 「后台/别处起的回合占着会话，驾驶舱却不知道」——忙状态可见性红证（issue #115 现场）。
//
// 现象：后台任务唤醒会话后去插话/停止，停不掉，发送键没变停止键、没显示「运行中」。
// 根因：Studio 的 s.busy / info.status 只在「我自己发 prompt」时置 running；gateway 内部 admit
// 的回合（子 agent 完成 / 后台 notify_on_complete / 定时任务 / 另一窗口）不经过 prompt，于是
// info.status 停在 ready。agent 侧唯一的真相是 <HERMES_HOME>/state.db 的 session_turn_leases 行。
//
// 这个 sweep 造的就是那个状态：一条「别处起的回合」租约 + 一个 idle 会话，然后只从 HTTP 观察
// 会话行有没有诚实地显示 foreignBusy（前端 busyNow() 据此把发送键变停止键）。旧代码无此字段 → RED。
//
//   node scripts/qa/lease-busy-visibility.mjs
import { spawn } from "node:child_process";
import fs, { mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createServer as createTcp } from "node:net";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(import.meta.dirname, "../..");
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

async function boot() {
  const port = await freePort();
  const home = mkdtempSync(path.join(tmpdir(), "lease-busy-home-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "lease-busy-data-"));
  const agentHome = mkdtempSync(path.join(tmpdir(), "lease-busy-agent-"));
  const base = `http://127.0.0.1:${port}`;
  let log = "";
  const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
    detached: true, cwd: ROOT,
    env: {
      ...process.env, NODE_ENV: "development", HOME: home,
      HERMES_STUDIO_HERMES_HOME: agentHome, HERMES_HOME: agentHome,
      HERMES_STUDIO_PORT: String(port), HERMES_STUDIO_DATA: dataDir,
      MOCK_SLOW_MS: "15", MOCK_GATEWAY_OWNED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => { log += String(d); });
  proc.stderr.on("data", (d) => { log += String(d); });
  for (let i = 0; i < 200 && !log.includes(`:${port}`); i++) await sleep(150);
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }
  const token = () => String(fs.readFileSync(path.join(dataDir, "auth.token"), "utf8")).trim();
  const api = async (p, init = {}) => {
    const res = await fetch(`${base}${p}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: ["Bearer", token()].join(" "), ...(init.headers ?? {}) },
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const rows = (await api("/api/backends")).body ?? [];
  const hermes = rows.find((r) => r.id === "hermes");
  await api("/api/backends/hermes", {
    method: "PUT",
    body: JSON.stringify({ ...hermes, cmd: process.execPath, args: [path.join(ROOT, "packages/server/mock/agent.mjs")],
      home: null, env: [], profile: null, cwd: null }),
  });
  return { base, port, home, dataDir, agentHome, api, proc,
    kill: () => { try { process.kill(-proc.pid, "SIGKILL"); } catch { /* gone */ } } };
}

const rowOf = async (inst, id) => {
  const { body } = await inst.api("/api/sessions");
  return [...(body?.live ?? []), ...(body?.cold ?? [])].find((s) => s.id === id) ?? null;
};
const createSession = async (inst, title) => {
  const made = await inst.api("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ backend: "hermes", cwd: mkdtempSync(path.join(tmpdir(), "lease-busy-ws-")), title }),
  });
  const id = made.body?.id;
  if (!id) throw new Error(`could not create ${title}: ${JSON.stringify(made.body)}`);
  for (let i = 0; i < 100; i++) {
    const row = await rowOf(inst, id);
    if (row?.status === "ready") return row;
    if (row?.status === "error") throw new Error(`${title} failed: ${JSON.stringify(row.lastError ?? row)}`);
    await sleep(150);
  }
  throw new Error(`${title} never reached ready`);
};
const writeLease = (inst, conversationId, ttlSec = 300) => {
  const db = new DatabaseSync(path.join(inst.agentHome, "state.db"));
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS session_turn_leases (
      conversation_id TEXT PRIMARY KEY, holder TEXT NOT NULL,
      acquired_at REAL NOT NULL, expires_at REAL NOT NULL)`);
    db.prepare("INSERT OR REPLACE INTO session_turn_leases VALUES (?,?,?,?)").run(
      conversationId, `gateway:pid=99999`, Date.now() / 1000, (Date.now() + ttlSec * 1000) / 1000);
  } finally { try { db.close(); } catch { /* closed */ } }
};
const clearLease = (inst, conversationId) => {
  const db = new DatabaseSync(path.join(inst.agentHome, "state.db"));
  try { db.prepare("DELETE FROM session_turn_leases WHERE conversation_id=?").run(conversationId); }
  catch { /* table maybe absent */ } finally { try { db.close(); } catch { /* closed */ } }
};

const inst = await boot();
try {
  const s = await createSession(inst, "lease busy probe");
  const acpId = s.acpSessionId;
  check("fixture: the session is idle with no prompt of ours running",
    s.status === "ready" && !s.foreignBusy, JSON.stringify({ status: s.status, foreignBusy: s.foreignBusy }));

  // 「别处起的回合」：agent 侧有租约，但驾驶舱没发过 prompt。
  writeLease(inst, acpId);
  await sleep(1800);
  const busyRow = await rowOf(inst, s.id);
  check("a lease held by another surface marks the slot foreignBusy (STOP button)",
    busyRow?.foreignBusy === true,
    JSON.stringify({ status: busyRow?.status, foreignBusy: busyRow?.foreignBusy }));
  check("…without lying about persisted status — it stays ready",
    busyRow?.status === "ready", JSON.stringify({ status: busyRow?.status }));

  // Review high: while a foreign turn holds the floor, no other turn may be injected. The prompt
  // entrance used to gate on s.busy only (false here), so a completion / interrupting utterance could
  // open a competing turn. REST /prompt is fire-and-forget (always 202), so assert on the REAL effect:
  // the injected text must never land in the transcript.
  const SENTINEL = "INJECTED-DURING-FOREIGN-7f3a";
  await inst.api(`/api/sessions/${s.id}/prompt`, {
    method: "POST", body: JSON.stringify({ text: SENTINEL }),
  });
  await sleep(1200);
  const msgs = await inst.api(`/api/sessions/${s.id}/messages`);
  const injected = JSON.stringify(msgs.body?.messages ?? []).includes(SENTINEL);
  check("a turn is NOT injected while a foreign turn holds the lease",
    !injected, injected ? "sentinel text reached the transcript" : "no competing turn ran");

  clearLease(inst, acpId);
  await sleep(2500); // watchdog needs two consecutive quiet ticks (2x 1s) before it settles
  const idleRow = await rowOf(inst, s.id);
  check("…and foreignBusy clears once the lease is gone",
    idleRow?.foreignBusy !== true,
    JSON.stringify({ status: idleRow?.status, foreignBusy: idleRow?.foreignBusy }));

  // Scenario: OUR OWN prompt. Its running state is owned by prompt(), not re-flagged by the watchdog.
  const promptRes = await inst.api(`/api/sessions/${s.id}/prompt`, {
    method: "POST", body: JSON.stringify({ text: "hello" }),
  });
  check("fixture: our own prompt was accepted", promptRes.status === 202, JSON.stringify(promptRes.body));
  await sleep(2500);
  const afterOwn = await rowOf(inst, s.id);
  check("a turn WE submitted settles back clean (watchdog does not re-flag it foreign)",
    afterOwn?.foreignBusy !== true && afterOwn?.status !== "running",
    JSON.stringify({ status: afterOwn?.status, foreignBusy: afterOwn?.foreignBusy }));
} finally {
  inst.kill();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
