// QA: 语音通话模式端到端（issue #48）—— 起自己的实例，用一个真 mock agent。
//
// 判据来自 issue 的验收 1/3/5/6 里能在无头环境证明的部分：
//   进入通话（页面报 call:true）→ 思考档位被压到最低、进入边界落库待发；
//   下一轮 prompt → 边界被消费、轮数 +1、转录里没有注入文本；
//   挂断（call:false）→ 思考档位还原成进入前的值、退出边界待发；
//   再下一轮 → 退出边界消费掉，之后什么都不注入；
//   从没打过电话的会话 → 一行 voice_mode 都不该有（普通语音输入不触发）。
//
//   node scripts/qa/voice-mode-call-sweep.mjs
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";

const REPO = path.resolve(import.meta.dirname, "../..");
const ROOT = `/tmp/agentus-qa-voicecall-${process.pid}`;
const DATA = path.join(ROOT, "data");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function check(ok, name, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
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
      res.on("end", () => resolve({ status: res.statusCode, text: buf, json: () => (buf ? JSON.parse(buf) : null) }));
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const token = () => fs.readFileSync(path.join(DATA, "auth.token"), "utf8").trim();
let server = null;

async function start() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  const port = await freePort();
  const log = [];
  server = spawn(process.execPath, ["--import", "tsx", "packages/server/src/index.ts"], {
    cwd: REPO,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "development",
      AGENTUS_PORT: String(port), AGENTUS_DATA: DATA,
      AGENTUS_USERNAME: "scratch", AGENTUS_PASSWORD: "scratch-pass-1",
      AGENTUS_IDLE_SWEEP_MS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (b) => log.push(b.toString()));
  server.stderr.on("data", (b) => log.push(b.toString()));
  for (let i = 0; i < 100; i++) {
    try { if ((await api(port, "", "/healthz")).status === 200) return port; } catch { /* booting */ }
    await sleep(200);
  }
  throw new Error(`server never came up:\n${log.join("").slice(-2000)}`);
}

function db() {
  return new DatabaseSync(path.join(DATA, "agentus.sqlite"), { readOnly: true });
}

function voiceRow(sessionId) {
  const d = db();
  try {
    return d.prepare("select in_call, boundary, turns, thought_before, thought_touched from voice_mode where session_id = ?").get(sessionId) ?? null;
  } finally { d.close(); }
}

async function thinkingValue(port, sessionId) {
  const all = (await api(port, token(), "/api/sessions")).json();
  const row = (all.live ?? []).find((s) => s.id === sessionId);
  const opt = (row?.configOptions ?? []).find((o) => o.id === "reasoning_effort");
  return opt?.currentValue ?? null;
}

async function createSession(port, title) {
  const r = await api(port, token(), "/api/sessions", {
    method: "POST", body: JSON.stringify({ backend: "mock", cwd: REPO, title }),
  });
  if (r.status !== 200 && r.status !== 201) throw new Error(`create: ${r.status} ${r.text.slice(0, 200)}`);
  const id = r.json().id;
  for (let i = 0; i < 100; i++) {
    const all = (await api(port, token(), "/api/sessions")).json();
    const row = (all.live ?? []).find((s) => s.id === id);
    if (row?.status === "ready") return id;
    await sleep(200);
  }
  throw new Error("session never ready");
}

const presence = (port, sessionId, call) =>
  api(port, token(), "/api/notify/presence", {
    method: "POST", body: JSON.stringify({ sessionId, visible: true, call }),
  });

/** The cockpit's own command channel (there is no REST route for config options). */
function wsSend(port, token, cmd, settleMs = 900) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => { try { sock.close(); } catch { /* gone */ } reject(new Error("ws timeout")); }, 10_000);
    sock.on("open", () => sock.send(JSON.stringify(cmd)));
    sock.on("error", (e) => { clearTimeout(timer); reject(e); });
    socketOpened: {
      // the command is fire-and-forget on this wire: give the server a beat to apply it
      setTimeout(() => { clearTimeout(timer); try { sock.close(); } catch { /* gone */ } resolve(); }, settleMs);
    }
  });
}

async function prompt(port, id, text) {
  const r = await api(port, token(), `/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text }) });
  if (r.status !== 200 && r.status !== 202) throw new Error(`prompt: ${r.status} ${r.text.slice(0, 160)}`);
  // wait for the turn to end so the next assertion sees a settled slot
  for (let i = 0; i < 200; i++) {
    const all = (await api(port, token(), "/api/sessions")).json();
    const row = (all.live ?? []).find((s) => s.id === id);
    if (row && row.status === "ready") return;
    await sleep(150);
  }
}

async function main() {
  const port = await start();
  console.log(`[voice-call] instance :${port} data ${DATA}`);

  // ---- 1. 进入通话 -------------------------------------------------------------------------------
  console.log("\n[1] 进入通话：约束待发 + 思考压到最低");
  const id = await createSession(port, "voice-call-sweep");
  const before = await thinkingValue(port, id);
  check(before === "medium", "基线：mock 的思考档位是 medium", String(before));
  await presence(port, id, true);
  await sleep(600);
  let v = voiceRow(id);
  check(v?.in_call === 1, "落库：in_call = 1");
  check(v?.boundary === "enter", "落库：进入边界待发（还没发出去，不单独触发回合）", String(v?.boundary));
  check(v?.thought_before === "medium", "落库：记住进入前的档位，退出时还原", String(v?.thought_before));
  check((await thinkingValue(port, id)) === "low", "思考档位被压到最低（low）", String(await thinkingValue(port, id)));

  // ---- 2. 通话中的第一轮 -------------------------------------------------------------------------
  console.log("\n[2] 通话第一轮：边界搭车送出、轮数 +1");
  await prompt(port, id, "[echo] 现在几点了");
  v = voiceRow(id);
  check(v?.boundary === null, "进入边界已被消费（不会每轮重复）");
  check(v?.turns === 1, "通话轮数 = 1", String(v?.turns));
  {
    const tail = (await api(port, token(), `/api/sessions/${id}/messages?tail=8`)).text;
    check(!/现在开始语音通话|仍在语音通话中/.test(tail), "转录里看不到注入块（只存操作者原话）");
    check(/现在几点了/.test(tail), "操作者原话一字不改地落库");
  }

  // ---- 3. 通话中第二轮 ---------------------------------------------------------------------------
  console.log("\n[3] 通话第二轮：只带稳定约束（轮数继续涨）");
  await prompt(port, id, "[echo] 再说一遍");
  v = voiceRow(id);
  check(v?.turns === 2, "通话轮数 = 2（约束每轮都带）", String(v?.turns));
  check(v?.boundary === null, "没有多出来的边界");

  // ---- 4. 挂断 -----------------------------------------------------------------------------------
  console.log("\n[4] 挂断：退出边界待发 + 档位还原");
  await presence(port, id, false);
  await sleep(600);
  v = voiceRow(id);
  check(v?.in_call === 0, "落库：in_call = 0");
  check(v?.boundary === "exit", "落库：退出边界待发（不单独触发回合）", String(v?.boundary));
  check(v?.turns === 2, "轮数保留（退出块要引用「上面 2 轮」）", String(v?.turns));
  check((await thinkingValue(port, id)) === "medium", "思考档位还原成进入前的 medium", String(await thinkingValue(port, id)));

  // ---- 5. 挂断后第一轮 ---------------------------------------------------------------------------
  console.log("\n[5] 挂断后第一轮：退出边界搭车送出，之后彻底恢复");
  await prompt(port, id, "[echo] 把它整理成表格");
  v = voiceRow(id);
  check(v?.boundary === null, "退出边界已被消费");
  check(v?.turns === 2, "轮数不再增长（已经不在通话里）", String(v?.turns));
  await prompt(port, id, "[echo] 继续");
  check(voiceRow(id)?.boundary === null, "再下一条：仍然什么都不注入");

  // ---- 6. 从没打过电话的会话 ---------------------------------------------------------------------
  console.log("\n[6] 普通语音输入（非通话）不触发");
  const plain = await createSession(port, "voice-plain-sweep");
  await prompt(port, plain, "[echo] 普通打字");
  check(voiceRow(plain) === null, "没有 voice_mode 行（一行都不该有）", JSON.stringify(voiceRow(plain)));
  check((await thinkingValue(port, plain)) === "medium", "档位没被动过");

  // ---- 7. 通话中操作者自己调档位 ----------------------------------------------------------------
  console.log("\n[7] 通话中操作者手动调档 → 挂断不覆盖他的选择");
  await presence(port, plain, true);
  await sleep(500);
  await wsSend(port, token(), { t: "set-config", sessionId: plain, configId: "reasoning_effort", value: "high" });
  await sleep(300);
  await presence(port, plain, false);
  await sleep(500);
  check((await thinkingValue(port, plain)) === "high", "挂断后保留操作者选的 high（不还原成 medium）",
    String(await thinkingValue(port, plain)));

  console.log(`\n[voice-call] ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  FAIL ${f}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[voice-call] crashed:", err);
  process.exitCode = 1;
}).finally(() => {
  try { server?.kill("SIGTERM"); } catch { /* gone */ }
  setTimeout(() => {
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exit(process.exitCode ?? 0);
  }, 1200);
});
