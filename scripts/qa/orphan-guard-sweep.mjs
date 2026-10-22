// QA: 孤儿回收的归属校验 + 单例锁 — incident 2026-10-22（恢复会话必 SIGKILL）的回归守卫。
//
// 事故：一次 promote 漏了 --launchd，第二个 server 用**同一个 AGENTUS_DATA** 起来（不同端口，所以
// listen 不冲突），启动时的 reclaimOrphans() 把数据库里记录的 agent pid 全 SIGKILL —— 那是第一个
// server 正在服务的槽位。launchd 每 10 秒重生一次，于是「恢复会话，历史刚恢复完就被杀」循环下去。
//
// 这个脚本断言修好后的行为。它会自己起 instance（不碰 :8788 / :8901）：
//
//   node scripts/qa/orphan-guard-sweep.mjs            # 全绿才算过
//
// 四组：
//   NEG  同 dataDir 起第二个实例 → 必须拒绝启动（非 0 + 明确日志），第一个实例的 agent 仍活着、会话仍 ready
//   CRASH 第一个实例被 SIGKILL（agent 变孤儿）→ 新实例接管接管并回收，日志带 pid 与理由
//   STALE 留下一个「pid 已死」的 server.pid → 新实例照常启动（锁不能把安装弄砖）
//   EXIT  正常退出后 server.pid 必须消失（否则下次启动会被自己的残锁挡住）
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const REPO = path.resolve(import.meta.dirname, "../..");
// `node --import tsx` rather than the .bin/tsx wrapper: the wrapper is a SECOND process, so a
// SIGKILL of it would leave the real server (and its lock) alive — the exact confusion this sweep is
// about. With the loader the pid we hold IS the server.
const TSX_LOADER = "tsx";
const ROOT = `/tmp/agentus-qa-orphan-${process.pid}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
/** every instance this run started, killed on the way out */
const live = [];
function check(ok, name, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function readToken(dataDir) {
  try { return fs.readFileSync(path.join(dataDir, "auth.token"), "utf8").trim(); } catch { return ""; }
}

function api(port, token, p, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, path: p, method: opts.method ?? "GET",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(opts.body ? { "content-type": "application/json" } : {}),
      },
    }, (res) => {
      let buf = "";
      res.on("data", (d) => { buf += d; });
      res.on("end", () => resolve({ status: res.statusCode, text: buf, json: () => JSON.parse(buf) }));
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** One server instance, with its whole output captured so a refusal can be asserted on. */
function startInstance(dataDir, port) {
  const log = [];
  const child = spawn(process.execPath, ["--import", TSX_LOADER, "packages/server/src/index.ts"], {
    cwd: REPO,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "development",
      AGENTUS_PORT: String(port),
      AGENTUS_DATA: dataDir,
      AGENTUS_USERNAME: "scratch",
      AGENTUS_PASSWORD: "scratch-pass-1",
      // a real ACP agent is not needed to prove who gets killed: the mock is a real child process
      AGENTUS_IDLE_SWEEP_MS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const push = (b) => log.push(b.toString());
  child.stdout.on("data", push);
  child.stderr.on("data", push);
  const exited = new Promise((resolve) => child.on("exit", (code, sig) => resolve({ code, sig })));
  const inst = { child, port, log, text: () => log.join(""), exited };
  live.push(inst);
  return inst;
}

async function waitPort(port, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await api(port, "", "/healthz");
      if (r.status === 200) return true;
    } catch { /* not yet */ }
    await sleep(200);
  }
  return false;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

async function stopInstance(inst, sig = "SIGTERM") {
  if (inst.child.exitCode !== null) return;
  inst.child.kill(sig);
  await Promise.race([inst.exited, sleep(8000)]);
}

async function newMockSession(port, dataDir) {
  const token = readToken(dataDir);
  const r = await api(port, token, "/api/sessions", {
    method: "POST", body: JSON.stringify({ backend: "mock", cwd: REPO, title: "orphan-guard" }),
  });
  if (r.status !== 200 && r.status !== 201) throw new Error(`create session: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  const id = r.json().id;
  // ready = the handshake finished, so the pid is a live agent rather than a spawn in flight
  for (let i = 0; i < 100; i++) {
    const list = (await api(port, token, "/api/sessions")).json();
    const row = (list.live ?? []).find((s) => s.id === id);
    if (row?.status === "ready" && row.pid) return { id, pid: row.pid, token };
    await sleep(200);
  }
  throw new Error("session never became ready");
}

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  console.log(`[orphan-guard] scratch ${ROOT}`);

  // ---------- NEG: a second instance on the same data dir must refuse, and kill nothing ----------
  console.log("\nNEG · 同 dataDir 起第二个实例");
  const case1 = path.join(ROOT, "case1");
  const portA = await freePort();
  const A = startInstance(case1, portA);
  check(await waitPort(portA), "A 起来了（:port " + portA + "）");
  const sess = await newMockSession(portA, case1);
  check(alive(sess.pid), `A 的 agent 活着 (pid ${sess.pid})`);

  const portB = await freePort();
  const B = startInstance(case1, portB);
  const bEnd = await Promise.race([B.exited, sleep(15_000).then(() => null)]);
  if (bEnd === null) await stopInstance(B);
  const bLog = B.text();
  check(bEnd !== null, "B 退出了（没有变成第二个 server）", bEnd === null ? "20s 仍在运行" : "");
  check(bEnd !== null && bEnd.code !== 0, "B 的退出码非 0", bEnd ? `code=${bEnd.code}` : "");
  check(/already has an owner/i.test(bLog), "B 的日志说明了拒绝原因", bLog.split("\n").filter((l) => /owner|refus/i.test(l)).join(" | ").slice(0, 200));

  await sleep(500);
  check(alive(sess.pid), "B 启动后 A 的 agent 仍活着（本例的核心）", `pid ${sess.pid} ${alive(sess.pid) ? "" : "已被杀"}`);
  const tokenA = readToken(case1);
  const afterB = (await api(portA, tokenA, "/api/sessions")).json();
  const rowA = (afterB.live ?? []).find((s) => s.id === sess.id);
  check(rowA?.status === "ready", "A 的会话仍 ready", `status=${rowA?.status}`);
  check(rowA?.pid === sess.pid, "A 的会话仍指向同一个 agent pid", `pid=${rowA?.pid}`);
  check(!/reclaim: killed/.test(A.text()), "A 的日志里没有 reclaim 杀人记录");
  await stopInstance(A);

  // ---------- CRASH: SIGKILL leaves a stale claim; the next instance must take over, not brick ----------
  // (The mock agent exits with its stdin, so the "orphan survives SIGKILL" shape is proved at the
  // manager level in scripts/qa/reclaim-owner-sweep.mts, where the process is spawned by the test.)
  console.log("\nCRASH · 崩溃后重启：残锁要接管、冷会话要能恢复（不许退化）");
  const case2 = path.join(ROOT, "case2");
  const portC = await freePort();
  const C = startInstance(case2, portC);
  check(await waitPort(portC), "C 起来了");
  const sessC = await newMockSession(portC, case2);
  const lockPid = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(case2, "server.pid"), "utf8")).pid; } catch { return null; }
  })();
  check(lockPid === C.child.pid, "锁文件记的就是这个 server 进程", `lock=${lockPid} child=${C.child.pid}`);
  C.child.kill("SIGKILL"); // no graceful shutdown: the claim is left behind, its owner is dead
  await Promise.race([C.exited, sleep(5000)]);
  await sleep(300);
  check(!alive(lockPid), "SIGKILL 之后锁的 owner 确实死了（残锁）");
  check(fs.existsSync(path.join(case2, "server.pid")), "残锁还在（否则这组就没意义）");

  const portD = await freePort();
  const D = startInstance(case2, portD);
  check(await waitPort(portD), "D 在崩溃的 dataDir 上起来了（残锁被接管，没被弄砖）");
  await sleep(500);
  const dLog = D.text();
  check(/taking over|took over/i.test(dLog), "日志说明接管了残锁", dLog.split("\n").find((l) => /taking over|took over/i.test(l)) ?? "");
  check(/reclaim: (killed pid|nothing to kill)/.test(dLog), "启动回收走过一遍并且给了理由（没静默）",
    dLog.split("\n").find((l) => /reclaim:/.test(l)) ?? "");

  // the restart story that must not regress: the cold row comes back with a real agent and answers
  const tokenD = readToken(case2);
  const res = await api(portD, tokenD, `/api/sessions/${sessC.id}/resume`, { method: "POST" });
  check(res.status === 200, "冷会话 resume 返回 200", `${res.status} ${res.text.slice(0, 120)}`);
  let backRows = null;
  for (let i = 0; i < 100; i++) {
    const d = (await api(portD, tokenD, "/api/sessions")).json();
    const row = (d.live ?? []).find((s) => s.id === sessC.id);
    if (row?.status === "ready" && row.pid) { backRows = row; break; }
    await sleep(200);
  }
  check(backRows !== null, "恢复后的会话是 ready 且换了新 agent");
  check(backRows !== null && backRows.pid !== sessC.pid, "新 agent 是另一个 pid（旧的确实没了）", `old=${sessC.pid} new=${backRows?.pid}`);
  const marker = `重启后还能干活-${Date.now()}`;
  await api(portD, tokenD, `/api/sessions/${sessC.id}/prompt`, { method: "POST", body: JSON.stringify({ text: `[echo] ${marker}` }) });
  let answered = false;
  for (let i = 0; i < 100; i++) {
    const tail = await api(portD, tokenD, `/api/sessions/${sessC.id}/messages?tail=6`);
    if (tail.text.includes(marker)) { answered = true; break; }
    await sleep(300);
  }
  check(answered, "恢复后的会话能完成一个真回合（agent 回了话）");
  await stopInstance(D);

  // ---------- STALE: a claim naming a dead pid must not brick the directory ----------
  console.log("\nSTALE · 残锁（pid 已死）要能接管");
  const case3 = path.join(ROOT, "case3");
  fs.mkdirSync(case3, { recursive: true });
  fs.writeFileSync(path.join(case3, "server.pid"), JSON.stringify({
    pid: 999_999, port: 1, dataDir: case3, instanceId: "dead", startedAt: Date.now() - 60_000, entry: "",
  }));
  const portE = await freePort();
  const E = startInstance(case3, portE);
  check(await waitPort(portE), "E 起来了（残锁被替换）");
  check(/took over|taking over/i.test(E.text()), "日志说明接管了残锁");
  await stopInstance(E);
  // ---------- EXIT: a graceful exit must drop the claim ----------
  await sleep(500);
  check(!fs.existsSync(path.join(case3, "server.pid")), "正常退出后 server.pid 消失");

  console.log(`\n[orphan-guard] ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  FAIL ${f}`);
    process.exitCode = 1;
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
}

main().catch((err) => {
  console.error("[orphan-guard] crashed:", err);
  process.exitCode = 1;
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
}).finally(() => {
  // The instances we spawned keep the loop alive even after the assertions ran: leave nothing behind.
  for (const inst of live) {
    try { inst.child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 300);
});
