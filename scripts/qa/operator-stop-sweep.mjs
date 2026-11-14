// 停，到底停没停（issue #107 / #108），以及同一条队列行会不会跑两遍（#104）。
//
// 三张单的现场是同一个：agent 侧的一轮比驾驶舱活得久。
//   · #107 槽位是冷的、租约却活着（定时任务/通知回合/另一个窗口起的）：resume 死等，stop 说「没有回合」，
//     于是「停不了也恢复不了」；
//   · #108 停是发出了，agent 不认（fork 0.22.17 及更早对别处起的回合静默忽略），驾驶舱照样回 stopped:true
//     —— 假成功；干净重启还会把自己那一轮留在 gateway 里；
//   · #104 队列的自动 drain 带着 interrupt:true 送出，而那一刻正在跑的很可能是它自己刚递上去的那一轮，
//     于是自己把自己掐了（"Stopped waiting for another Hermes process on this session"），同一行还可能被
//     drain 两遍跑两次。
//
// 这个 sweep 用 mock 的回合租约（MOCK_TURN_LEASE=1，往 <HERMES_HOME>/state.db 写 session_turn_leases，
// 与 0.23 gateway 同形状）把那些形状搭出来，然后只从 HTTP/CLI 观察结果 —— 断言的是「说了什么」和
// 「实际发生了什么」是否一致。MOCK_IGNORE_CANCEL=1 的第二具实例专门复刻「agent 不认这一停」。
//
//   node scripts/qa/operator-stop-sweep.mjs
import { execFileSync, spawn } from "node:child_process";
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

/** 一具驾驶舱 + 它自己的 HOME/agent home，互不串味。`extra` 是这一具要复刻的 agent 行为。 */
async function boot(extra = {}) {
  const port = await freePort();
  const home = mkdtempSync(path.join(tmpdir(), "agentus-stop-home-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "agentus-stop-data-"));
  const agentHome = mkdtempSync(path.join(tmpdir(), "agentus-stop-agent-"));
  const base = `http://127.0.0.1:${port}`;
  let log = "";
  const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
    detached: true,
    cwd: ROOT,
    env: {
      ...process.env, NODE_ENV: "development", HOME: home,
      // The agent home is what `busyTurnEta` reads (and what the mock writes its lease into): one
      // temp dir per instance keeps the operator's real ~/.hermes out of the sweep entirely.
      AGENTUS_HERMES_HOME: agentHome, HERMES_HOME: agentHome,
      AGENTUS_PORT: String(port), AGENTUS_DATA: dataDir,
      MOCK_SLOW_MS: "15", MOCK_GATEWAY_OWNED: "1", MOCK_TURN_LEASE: "1",
      ...extra,
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
      headers: {
        "content-type": "application/json",
        authorization: ["Bearer", token()].join(" "),
        ...(init.headers ?? {}),
      },
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  // 让内置 hermes 行跑 mock（与其它 cockpit sweep 同一招）。
  const rows = (await api("/api/backends")).body ?? [];
  const hermes = rows.find((r) => r.id === "hermes");
  await api("/api/backends/hermes", {
    method: "PUT",
    body: JSON.stringify({
      ...hermes, cmd: process.execPath, args: [path.join(ROOT, "packages/server/mock/agent.mjs")],
      home: null, env: [], profile: null, cwd: null,
    }),
  });
  // `send`/`stop` 共用同一个「驾驶舱能不能动手」开关，默认关；这里只是测试期间打开。
  await api("/api/settings", { method: "PUT", body: JSON.stringify({ agent: { cockpitSend: true } }) });
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
    body: JSON.stringify({ backend: "hermes", cwd: mkdtempSync(path.join(tmpdir(), "agentus-stop-ws-")), title }),
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
const messagesOf = async (inst, id) => ((await inst.api(`/api/sessions/${id}/messages?tail=200`)).body?.messages ?? []);

/** 租约表：写一行「别处起的回合」进去，/ 读回来，/ 等它消失。 */
const withLeaseDb = (inst, fn) => {
  const db = new DatabaseSync(path.join(inst.agentHome, "state.db"));
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS session_turn_leases (
      conversation_id TEXT PRIMARY KEY, holder TEXT NOT NULL,
      acquired_at REAL NOT NULL, expires_at REAL NOT NULL)`);
    return fn(db);
  } finally {
    try { db.close(); } catch { /* closed */ }
  }
};
const plantForeignLease = (inst, conversationId) => withLeaseDb(inst, (db) =>
  db.prepare("INSERT OR REPLACE INTO session_turn_leases VALUES (?,?,?,?)").run(
    conversationId, `sweep:pid=${process.pid}`, Date.now() / 1000, (Date.now() + 600_000) / 1000));
const leaseOf = (inst, conversationId) => withLeaseDb(inst, (db) =>
  db.prepare("SELECT holder, expires_at FROM session_turn_leases WHERE conversation_id = ?").get(conversationId) ?? null);
/** A lease whose TTL has run out: the gateway's row is still there (it deletes on turn end, not on expiry),
 *  so the turn is genuinely still running — the real shape of any turn longer than the 540 s TTL. */
const plantExpiredLease = (inst, conversationId) => withLeaseDb(inst, (db) =>
  db.prepare("INSERT OR REPLACE INTO session_turn_leases VALUES (?,?,?,?)").run(
    conversationId, `sweep:pid=${process.pid}`, (Date.now() - 900_000) / 1000, (Date.now() - 30_000) / 1000));

const stopCockpit = (inst, id, extra = {}) =>
  inst.api("/api/cockpit/stop", { method: "POST", body: JSON.stringify({ id, ...extra }) });

// ══ 实例一：agent 认这一停（0.22.18 之后的形状）════════════════════════════════════════
const A = await boot();

// ---- ① 自己起的那一轮：停了就是停了 -------------------------------------------------
const ourSlot = await createSession(A, "自己的回合");
await A.api(`/api/sessions/${ourSlot.id}/prompt`, { method: "POST", body: JSON.stringify({ text: "[hold:6000] 自己起的一轮" }) });
let busySeen = false;
for (let i = 0; i < 40; i++) {
  if (await leaseOf(A, ourSlot.acpSessionId)) { busySeen = true; break; }
  await sleep(150);
}
check("a turn of ours holds the agent-side lease (the shape #107 is about)", busySeen,
  JSON.stringify(await leaseOf(A, ourSlot.acpSessionId) ?? null));
const stoppedOwn = await stopCockpit(A, ourSlot.id);
check("stop on our OWN running turn reports stopped:true", stoppedOwn.body?.stopped === true, JSON.stringify(stoppedOwn.body));
let ownLeaseGone = null;
for (let i = 0; i < 30; i++) {
  ownLeaseGone = await leaseOf(A, ourSlot.acpSessionId);
  if (!ownLeaseGone) break;
  await sleep(150);
}
check("…and the agent's lease is really gone (the stop landed, not just 'sent')", !ownLeaseGone,
  JSON.stringify(ownLeaseGone));

// ---- ② #107：冷槽位 + 别处起的活跃回合 ----------------------------------------------
const coldSlot = await createSession(A, "冷槽位占着租约");
await stopCockpit(A, coldSlot.id, { close: true });
for (let i = 0; i < 60; i++) {
  const row = await rowOf(A, coldSlot.id);
  if (!row || row.cold === true || row.status !== "ready") break;
  await sleep(150);
}
await plantForeignLease(A, coldSlot.acpSessionId);
const refused = await A.api(`/api/sessions/${coldSlot.id}/resume`, { method: "POST" });
check("resume of a cold slot held by someone else's turn is a 409 busy_turn", refused.status === 409 && refused.body?.code === "busy_turn",
  `${refused.status} ${JSON.stringify(refused.body)}`);
check("…and the refusal names the way out (takeoverAvailable)", refused.body?.takeoverAvailable === true,
  JSON.stringify(refused.body?.takeoverAvailable));
const stoppedCold = await stopCockpit(A, coldSlot.id);
check("stop on a COLD slot with a live lease now stops it (used to answer 'nothing was running')",
  stoppedCold.body?.stopped === true, JSON.stringify(stoppedCold.body));
check("…and says it had to wake the slot to do it", stoppedCold.body?.woke === true, JSON.stringify(stoppedCold.body));
check("…and the lease is gone afterwards", !(await leaseOf(A, coldSlot.acpSessionId)),
  JSON.stringify(await leaseOf(A, coldSlot.acpSessionId)));
const resumed = await A.api(`/api/sessions/${coldSlot.id}/resume`, { method: "POST" });
check("…so the slot can be resumed at last (「停不了也恢复不了」 is over)", resumed.status === 200,
  `${resumed.status} ${JSON.stringify(resumed.body)}`);

// ---- ②b 过期租约（TTL 540s、回合中途不续期）：那一轮仍在跑，不许说「没有回合」 ----------
// review D1：判据若用 `remainingMs > 0`，任何超过 9 分钟的回合都会被读成「没有回合」，冷槽位的停
// 又变回一句谎。
const staleSlot = await createSession(A, "过期的租约");
await stopCockpit(A, staleSlot.id, { close: true });
for (let i = 0; i < 60; i++) {
  const row = await rowOf(A, staleSlot.id);
  if (!row || row.cold === true || row.status !== "ready") break;
  await sleep(150);
}
await plantExpiredLease(A, staleSlot.acpSessionId);
const staleEta = await leaseOf(A, staleSlot.acpSessionId);
const staleStop = await stopCockpit(A, staleSlot.id);
check("an EXPIRED lease row still counts as a running turn (the TTL is a forecast, not the truth)",
  staleStop.body?.stopped === true, `${JSON.stringify(staleStop.body)} lease=${JSON.stringify(staleEta)}`);
check("…and it is gone afterwards", !(await leaseOf(A, staleSlot.acpSessionId)),
  JSON.stringify(await leaseOf(A, staleSlot.acpSessionId)));

// ---- ②c /takeover：一个请求做完「打断 + 接管」------------------------------------
const takeSlot = await createSession(A, "接管路由");
await stopCockpit(A, takeSlot.id, { close: true });
for (let i = 0; i < 60; i++) {
  const row = await rowOf(A, takeSlot.id);
  if (!row || row.cold === true || row.status !== "ready") break;
  await sleep(150);
}
await plantForeignLease(A, takeSlot.acpSessionId);
const took = await A.api(`/api/sessions/${takeSlot.id}/takeover`, { method: "POST" });
check("POST /api/sessions/:id/takeover stops the foreign turn AND brings the slot up (one request)",
  took.status === 200 && took.body?.status === "ready", `${took.status} ${JSON.stringify(took.body)?.slice(0, 120)}`);
check("…and the lease is gone", !(await leaseOf(A, takeSlot.acpSessionId)),
  JSON.stringify(await leaseOf(A, takeSlot.acpSessionId)));

// ---- ②d 干净退出：SIGTERM 之前先打断自己那一轮 -----------------------------------
// review D6：这一块以前零覆盖（整段删掉 sweep 仍全绿）。这里起一具独立实例，跑一轮长回合，然后只给
// **服务器进程**发 SIGTERM（不是整个进程组 —— mock 要活着才能响应 cancel），看租约有没有跟着清。
const C = await boot();
const exitSlot = await createSession(C, "退出时的一轮");
await C.api(`/api/sessions/${exitSlot.id}/prompt`, { method: "POST", body: JSON.stringify({ text: "[hold:30000] 退出前还在跑" }) });
for (let i = 0; i < 40; i++) {
  if (await leaseOf(C, exitSlot.acpSessionId)) break;
  await sleep(150);
}
const heldBeforeExit = Boolean(await leaseOf(C, exitSlot.acpSessionId));
let serverPid = 0;
try {
  serverPid = Number(execFileSync("lsof", ["-nP", `-iTCP:${C.port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
    .trim().split("\n")[0]);
} catch { /* reported below */ }
if (heldBeforeExit && serverPid) process.kill(serverPid, "SIGTERM");
let goneAfterExit = false;
for (let i = 0; i < 60; i++) {
  goneAfterExit = !(await leaseOf(C, exitSlot.acpSessionId));
  if (goneAfterExit) break;
  await sleep(200);
}
check("the turn was actually running before the SIGTERM", heldBeforeExit, heldBeforeExit ? "" : "no lease was planted");
check("a clean exit interrupts this cockpit's own turn instead of leaving it in the gateway (#108)",
  goneAfterExit, goneAfterExit ? "" : "the lease outlived the process — the turn kept running for nobody");
C.kill();

// ---- ②e #104 的 web 半边：drain 出去的帧里不许有 interrupt ----------------------
// review §六-6：删掉 state.ts 里那一行改动，14 条断言照样全过。这条读源码，断言的是「交棒不是抢麦」
// 这半边唯一能被机器判的东西 —— 真正的行为面在浏览器里，靠 sweep ④ 的服务器契约兜住。
const drainSrc = fs.readFileSync(path.join(ROOT, "packages/web/src/state.ts"), "utf8");
const drainBlock = (drainSrc.match(/drainQueue\(sessionId: string\): void \{[\s\S]*?\n  \}/) ?? [""])[0];
// 注释里写着「以前带 interrupt:true」，所以先剥掉行注释再判 —— 断言的是发出去的帧。
const drainCode = drainBlock.split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
check("#104 web: the auto-drain hands over WITHOUT `interrupt: true` (it would cancel its own turn)",
  Boolean(drainBlock) && !/interrupt:\s*true/.test(drainCode),
  drainBlock ? (drainCode.match(/interrupt:\s*true/) ? "still sends interrupt" : "plain hand-off") : "drainQueue not found");

// ---- ③ #104：同一条队列行只跑一次 --------------------------------------------------
const dedupeSlot = await createSession(A, "队列行幂等");
const rowId = `row-${Date.now()}`;
await A.api(`/api/sessions/${dedupeSlot.id}/prompt`, { method: "POST", body: JSON.stringify({ text: "队列行只跑一次", rowId }) });
// 等这一轮自己跑完，再把同一条队列行递一次 —— 这是「死 socket 上的重发／重连后重放」的形状：行号不变，
// 服务器必须认出它是同一句话的第二份，而不是第二句话。
for (let i = 0; i < 60; i++) {
  if ((await messagesOf(A, dedupeSlot.id)).some((m) => m.kind === "turn-usage")) break;
  await sleep(200);
}
await A.api(`/api/sessions/${dedupeSlot.id}/prompt`, { method: "POST", body: JSON.stringify({ text: "队列行只跑一次", rowId }) });
let copies = 0;
for (let i = 0; i < 40; i++) {
  const rows = await messagesOf(A, dedupeSlot.id);
  copies = rows.filter((m) => String(m.payload?.text ?? "") === "队列行只跑一次").length;
  if (copies > 1) break;
  await sleep(200);
}
check("the same queue row delivered twice runs ONCE (#104)", copies === 1, `transcript copies: ${copies}`);

// ---- ④ #104 的另一半：不带 interrupt 的第二次 prompt 不会掐掉正在跑的那一轮 -------
const raceSlot = await createSession(A, "不插队不掐轮");
await A.api(`/api/sessions/${raceSlot.id}/prompt`, { method: "POST", body: JSON.stringify({ text: "[hold:5000] 长回合" }) });
await sleep(500);
await A.api(`/api/sessions/${raceSlot.id}/prompt`, { method: "POST", body: JSON.stringify({ text: "插一句话", rowId: "race-row" }) });
let turnCompleted = false;
for (let i = 0; i < 50; i++) {
  const rows = await messagesOf(A, raceSlot.id);
  // 回合正常结束的证据是 `turn-usage` 行（mock 的答复体是空的，只能认这一行）。
  turnCompleted = rows.some((m) => m.kind === "turn-usage");
  if (turnCompleted) break;
  await sleep(200);
}
const raceRows = await messagesOf(A, raceSlot.id);
const cancelledNotice = raceRows.some((m) => String(m.payload?.text ?? "").includes("Stopped waiting for another Hermes process"));
check("a plain (non-interrupt) second prompt does NOT cancel the turn that is already running (#104)",
  !cancelledNotice, cancelledNotice ? "the transcript carries the cancellation notice" : "");
check("…and that turn finished normally (turn-usage recorded)", turnCompleted,
  turnCompleted ? "" : "no turn-usage row: the turn never completed");

// ══ 实例二：agent 不认这一停（0.22.17 及更早）══════════════════════════════════════════
const B = await boot({ MOCK_IGNORE_CANCEL: "1" });
const deafSlot = await createSession(B, "agent 不认这一停");
await B.api(`/api/sessions/${deafSlot.id}/prompt`, { method: "POST", body: JSON.stringify({ text: "[hold:6000] 停不掉的一轮" }) });
for (let i = 0; i < 40; i++) {
  if (await leaseOf(B, deafSlot.acpSessionId)) break;
  await sleep(150);
}
const lied = await stopCockpit(B, deafSlot.id);
check("when the agent does NOT honour the stop, the cockpit says so instead of reporting success (#108)",
  lied.body?.stopped === false && lied.body?.code === "cancel_unconfirmed", JSON.stringify(lied.body));
check("…and the lease is still held, i.e. the turn really is still running",
  Boolean(await leaseOf(B, deafSlot.acpSessionId)), JSON.stringify(await leaseOf(B, deafSlot.acpSessionId)));

console.log(`\n${pass} passed, ${fail} failed`);
A.kill();
B.kill();
process.exit(fail ? 1 : 0);
