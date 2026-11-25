// #117: 容器被整体 SIGKILL 重建后，session_turn_leases 里残留的租约行（holder pid 已死、不再
// 续期）被 busy 判定当成「还在跑的回合」—— 每条消息都报「上一个回合没能停下来」，只能右键
// 「重启 agent 进程」恢复，而错误信息从不提示这一点。
//
// 根因：holderAlive 判据只在 resume() 用了；#foreignBusyTick（只看行存在）与 prompt() 忙分支
// 没贯穿。本 sweep 造两种租约，从 HTTP 观察真实症状：
//   ① 活 holder（pid 活着）= 真在跑的别处回合 → 必须 foreignBusy（#115 能力不能一起删掉）；
//   ② 死 holder（pid 已死）= 崩溃残留 → 不得 foreignBusy，且带 interrupt 的消息必须真的发出去。
// 旧代码 ② 恒红：残留行被置 foreignBusy，随后 cancel 打给死回合，15s 超时抛错、文本不落库。
//
//   node scripts/qa/stale-lease-recovery.mjs
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
  const home = mkdtempSync(path.join(tmpdir(), "stale-lease-home-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "stale-lease-data-"));
  const agentHome = mkdtempSync(path.join(tmpdir(), "stale-lease-agent-"));
  const base = `http://127.0.0.1:${port}`;
  let log = "";
  // 把 cancel-wait 窗口压短：旧代码在死 holder 上等满 15s 才抛错，红证不必真等那么久。
  const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
    detached: true, cwd: ROOT,
    env: {
      ...process.env, NODE_ENV: "development", HOME: home,
      HERMES_STUDIO_HERMES_HOME: agentHome, HERMES_HOME: agentHome,
      HERMES_STUDIO_PORT: String(port), HERMES_STUDIO_DATA: dataDir,
      HERMES_STUDIO_SETTLE_TIMEOUT_MS: "2000",
      MOCK_SLOW_MS: "15", MOCK_GATEWAY_OWNED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => { log += String(d); });
  proc.stderr.on("data", (d) => { log += String(d); });
  for (let i = 0; i < 200 && !log.includes(`:${port}`); i++) await sleep(150);
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* booting */ }
    await sleep(250);
  }
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
  return { base, port, home, dataDir, agentHome, api, proc, log: () => log,
    kill: () => { try { process.kill(-proc.pid, "SIGKILL"); } catch { /* gone */ } } };
}

const rowOf = async (inst, id) => {
  const { body } = await inst.api("/api/sessions");
  return [...(body?.live ?? []), ...(body?.cold ?? [])].find((s) => s.id === id) ?? null;
};
const createSession = async (inst, title) => {
  const made = await inst.api("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ backend: "hermes", cwd: mkdtempSync(path.join(tmpdir(), "stale-lease-ws-")), title }),
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
const writeLease = (inst, conversationId, holder, ttlSec = 300) => {
  const db = new DatabaseSync(path.join(inst.agentHome, "state.db"));
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS session_turn_leases (
      conversation_id TEXT PRIMARY KEY, holder TEXT NOT NULL,
      acquired_at REAL NOT NULL, expires_at REAL NOT NULL)`);
    db.prepare("INSERT OR REPLACE INTO session_turn_leases VALUES (?,?,?,?)").run(
      conversationId, holder, Date.now() / 1000, (Date.now() + ttlSec * 1000) / 1000);
  } finally { try { db.close(); } catch { /* closed */ } }
};
const clearLease = (inst, conversationId) => {
  const db = new DatabaseSync(path.join(inst.agentHome, "state.db"));
  try { db.prepare("DELETE FROM session_turn_leases WHERE conversation_id=?").run(conversationId); }
  catch { /* table maybe absent */ } finally { try { db.close(); } catch { /* closed */ } }
};

const inst = await boot();
try {
  const s = await createSession(inst, "stale lease probe");
  const acpId = s.acpSessionId;
  check("fixture: idle session, no foreign turn", s.status === "ready" && !s.foreignBusy,
    JSON.stringify({ status: s.status, foreignBusy: s.foreignBusy }));

  // ① 活 holder：这是真在跑的别处回合（background wake / cron / 另一窗口）。修 #117 不能把它
  //    一起删掉 —— #115 的 STOP 按钮就挂在这条判据上。
  writeLease(inst, acpId, `gateway:pid=${process.pid}`); // sweep 脚本进程活着，server 看得见
  await sleep(2300);
  const liveRow = await rowOf(inst, s.id);
  check("a LIVE foreign turn still marks foreignBusy (the #115 STOP button stays)",
    liveRow?.foreignBusy === true,
    JSON.stringify({ status: liveRow?.status, foreignBusy: liveRow?.foreignBusy }));

  clearLease(inst, acpId);
  await sleep(2300);
  check("…and clears once that live turn ends", (await rowOf(inst, s.id))?.foreignBusy !== true);

  // ② 死 holder：容器 SIGKILL 后的残留。行还在、expires_at 仍是未来（TTL 静态、不再续期），但
  //    pid 已死 —— gateway 会在下次 acquire 回收它。驾驶舱不得把它当成在跑的回合。
  writeLease(inst, acpId, "gateway:pid=99999999");
  await sleep(2300);
  const staleRow = await rowOf(inst, s.id);
  check("a stale lease whose holder is DEAD must NOT mark foreignBusy",
    staleRow?.foreignBusy !== true,
    JSON.stringify({ status: staleRow?.status, foreignBusy: staleRow?.foreignBusy }));

  // 症状级：带 interrupt 的消息必须真的发出去。旧代码下 foreignBusy 被残留行置位，prompt() 走
  // cancel-and-wait、cancel 打给死回合、2s 超时抛错，文本永远不进转录 —— 逐条重试同样失败。
  const SENTINEL = "STALE-LEASE-RECOVERED-9c1e";
  await inst.api(`/api/sessions/${s.id}/prompt`, {
    method: "POST", body: JSON.stringify({ text: SENTINEL, interrupt: true }),
  });
  await sleep(1800);
  const msgs = await inst.api(`/api/sessions/${s.id}/messages`);
  const landed = JSON.stringify(msgs.body?.messages ?? []).includes(SENTINEL);
  check("an interrupt prompt gets through a stale lease (no cancel-and-wait on a dead turn)",
    landed, landed ? "text reached the transcript" : "text was swallowed — the #117 symptom");

  // R1-F4：issue 说的是「每条消息」，补一条不带 interrupt 的普通消息 —— 用户正常发消息也不该撞
  // cancel-and-wait。旧代码下普通消息同样被残留行置位的 foreignBusy 挡住、15s 后报错。
  const PLAIN_SENTINEL = "STALE-LEASE-PLAIN-3f2a";
  await sleep(500); // 让上一条 mock 回合落地
  await inst.api(`/api/sessions/${s.id}/prompt`, {
    method: "POST", body: JSON.stringify({ text: PLAIN_SENTINEL }),
  });
  await sleep(1800);
  const plainMsgs = await inst.api(`/api/sessions/${s.id}/messages`);
  const plainLanded = JSON.stringify(plainMsgs.body?.messages ?? []).includes(PLAIN_SENTINEL);
  check("a plain prompt (no interrupt) also gets through a stale lease",
    plainLanded, plainLanded ? "text reached the transcript" : "text was swallowed — the #117 symptom");

  // 竞态窗口：foreignBusy 已由活 holder 置位、holder 刚变死、watchdog 还没到下一 tick（1s）。
  // prompt 不能只信内存里的 foreignBusy（那是旧的），必须自己查租约发现 holder 死了才放行 ——
  // 这条断言专门守住 prompt 忙分支那道闸（watchdog 修好后它平时不会被触发，是冗余的第二道防线）。
  const RACE_SENTINEL = "STALE-LEASE-RACE-2b7d";
  writeLease(inst, acpId, `gateway:pid=${process.pid}`); // 活 holder
  await sleep(1300); // 等 watchdog 把 foreignBusy 置起来
  const raceRow = await rowOf(inst, s.id);
  check("race fixture: foreignBusy is set by a live holder", raceRow?.foreignBusy === true,
    JSON.stringify({ foreignBusy: raceRow?.foreignBusy }));
  writeLease(inst, acpId, "gateway:pid=99999998"); // 同一行改成死 holder，不删行
  const logBefore = inst.log().split("cancel sent for").length - 1;
  await inst.api(`/api/sessions/${s.id}/prompt`, {
    method: "POST", body: JSON.stringify({ text: RACE_SENTINEL, interrupt: true }),
  });
  await sleep(1200);
  const raceMsgs = await inst.api(`/api/sessions/${s.id}/messages`);
  const raceLanded = JSON.stringify(raceMsgs.body?.messages ?? []).includes(RACE_SENTINEL);
  const logAfter = inst.log().split("cancel sent for").length - 1;
  check("a prompt in the watchdog's 1s race window also gets through",
    raceLanded, raceLanded ? "text reached the transcript" : "text was swallowed in the race window");
  check("…and never cancels the dead turn (no hard-interrupt planted for the next turn)",
    logAfter === logBefore,
    `cancel sent count ${logBefore} -> ${logAfter}`);
} finally {
  inst.kill();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
