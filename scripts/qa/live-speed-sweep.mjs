// 流式测速（issue #70 step 1）：开关关着时服务端一个字节都不推，打开之后每秒推一次
// 「最近 3 秒多少字」，回合一结束就收摊 —— 全都用真实例 + 真 WS 证。
//
// 为什么要证的正是这三条：
//   · 关着的时候「没推」才是对的。一个默认开着的每秒心跳，是每个操作员都在付的噪音账单；
//   · 单位必须是 chars（`unit: "chars"`、`estimated: true`）。ACP 的流里没有 token，把字符
//     冒充 t/s 就是这个 issue 点名不许做的事；
//   · 回合结束后要**停**，而且最后一帧要说 available:false —— 否则胶囊停在一个过期数字上，
//     读起来像"模型现在这么慢"。
//
// 自给自足：临时数据目录 + 自带 mock 后端 + 随机端口。
//   node scripts/qa/live-speed-sweep.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createTcp } from "node:net";
import { WebSocket } from "ws";

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

const PORT = await freePort();
const dataDir = mkdtempSync(path.join(tmpdir(), "agentus-speed-"));
const emptyHome = mkdtempSync(path.join(tmpdir(), "agentus-speed-home-"));
const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
  detached: true,
  cwd: ROOT,
  env: {
    ...process.env, NODE_ENV: "development", HOME: emptyHome,
    AGENTUS_PORT: String(PORT), AGENTUS_DATA: dataDir, AGENTUS_AUTH: "off",
    // 每块 300ms：一轮正文要流三四秒，1Hz 的表才有得打。60ms 的默认值会在第一跳之前就说完。
    MOCK_SLOW_MS: "300",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
proc.stdout.on("data", (d) => { log += String(d); });
proc.stderr.on("data", (d) => { log += String(d); });
const BASE = `http://127.0.0.1:${PORT}`;
const cleanup = () => { try { process.kill(-proc.pid, "SIGKILL"); } catch { /* gone */ } };
process.on("exit", cleanup);

for (let i = 0; i < 160 && !log.includes(`:${PORT}`); i++) await sleep(150);
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }

const api = async (p, init = {}) => {
  const res = await fetch(`${BASE}${p}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  return res.status === 204 ? null : res.json().catch(() => null);
};

// ---- 事件流 --------------------------------------------------------------------------
const frames = [];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
ws.on("message", (raw) => {
  try { frames.push(JSON.parse(String(raw))); } catch { /* not json */ }
});
await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
const tpsFrames = (sid) => frames.filter((f) => f.t === "tps" && f.sessionId === sid);

const mk = async (title) => {
  const s = await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "mock", cwd: process.cwd(), title }) });
  if (!s?.id) throw new Error(`create failed: ${JSON.stringify(s)}`);
  return s.id;
};
/** `create` no longer waits for the handshake (that wait is what made 新建会话 feel broken), so a
 *  sweep that prompts immediately gets 「session not ready」 — and then every later assertion is
 *  about a turn that never ran. Wait for the slot to claim ready first. */
const waitReady = async (sid, ms = 20_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const d = await api("/api/sessions");
    const row = (d?.live ?? []).find((x) => x.id === sid);
    if (row && row.status === "ready") return true;
    await sleep(200);
  }
  return false;
};
const say = (sid, text) => api(`/api/sessions/${sid}/prompt`, { method: "POST", body: JSON.stringify({ text }) });
const waitIdle = async (sid, ms = 25_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const d = await api("/api/sessions");
    const row = [...(d?.live ?? [])].find((x) => x.id === sid);
    if (row && row.status !== "running") return true;
    await sleep(200);
  }
  return false;
};

// ---- 0. 默认关 ----------------------------------------------------------------------
const s0 = await api("/api/settings");
check("the switch starts OFF, so nobody pays for a 1Hz heartbeat by default",
  s0?.prefs?.showTps === false, JSON.stringify(s0?.prefs?.showTps));

// ---- 1. 关着：一个 tps 帧都不许有 ------------------------------------------------------
const offId = await mk("sweep · 测速关着");
await waitReady(offId);
await say(offId, "[slow] 关着的时候不该有任何测速帧");
await waitIdle(offId);
await sleep(500);
check("with the switch off, a whole turn emits ZERO tps frames",
  tpsFrames(offId).length === 0, `${tpsFrames(offId).length} frame(s)`);

// ---- 2. 打开：1Hz 推字符/秒 ----------------------------------------------------------
const saved = await api("/api/settings", { method: "PUT", body: JSON.stringify({ prefs: { showTps: true } }) });
check("the switch can be turned on from the settings endpoint", saved?.prefs?.showTps === true, JSON.stringify(saved?.prefs?.showTps));

const onId = await mk("sweep · 测速开着");
await waitReady(onId);
frames.length = 0;
await say(onId, "[slow] 开着的时候应该看到每秒一条测速帧");
await waitIdle(onId, 40_000);
await sleep(800);
const mine = tpsFrames(onId);
const live = mine.filter((f) => f.available !== false);
check("a streaming turn pushes tps frames", live.length >= 2, `${live.length} live frame(s)`);
check("…and they report TOKENS per second, flagged as an estimate (the stream carries no usage)",
  live.every((f) => f.unit === "tokens" && f.estimated === true && f.tps > 0), JSON.stringify(live[0] ?? null));
check("…the raw character rate rides along, so the estimate can be re-derived",
  live.every((f) => f.cps > 0 && f.tps <= f.cps + 0.001), live.map((f) => `${f.tps}/${f.cps}`).join(", "));
check("…with the 3s window they describe", live.every((f) => f.windowMs === 3000));

// 1Hz 的节奏：相邻两帧的间隔应是「秒」量级，不是 100ms 的洪水
const gaps = live.slice(1).map((f, i) => f.at - live[i].at);
check("…at roughly 1Hz, not on every chunk",
  gaps.length > 0 && gaps.every((g) => g >= 700 && g <= 1600), gaps.join(", "));

// ---- 3. 回合结束就收摊 -----------------------------------------------------------------
check("the meter closes itself when the turn ends (available:false, streaming:false)",
  mine.some((f) => f.available === false && f.streaming === false),
  JSON.stringify(mine[mine.length - 1] ?? null));
const after = mine.length;
await sleep(2000);
check("…and nothing is pushed after the turn is over", tpsFrames(onId).length === after,
  `${tpsFrames(onId).length - after} extra frame(s)`);

// ---- 4. 再关回去：立刻安静 ---------------------------------------------------------------
await api("/api/settings", { method: "PUT", body: JSON.stringify({ prefs: { showTps: false } }) });
const off2 = await mk("sweep · 关回去之后");
await waitReady(off2);
frames.length = 0;
await say(off2, "[slow] 关回去之后必须重新安静");
await waitIdle(off2, 40_000);
await sleep(400);
check("turning it back off silences the meter on the very next turn",
  tpsFrames(off2).length === 0, `${tpsFrames(off2).length} frame(s)`);

// ---- 5. 用量行仍然在（step 0 不能被 step 1 顶掉） ---------------------------------------
const rows = await api(`/api/sessions/${onId}/messages?limit=200`).catch(() => null);
const list = Array.isArray(rows) ? rows : (rows?.messages ?? []);
const usage = list.filter((m) => (m.kind ?? m.message?.kind) === "turn-usage");
check("the per-turn usage row is still written (step 0 not regressed)", usage.length >= 1, `${usage.length} row(s)`);

// ---- 6. 真页面上的那枚胶囊（协议对了不等于画出来了） -----------------------------------
// 这一节是"数字真的出现在操作员眼前"的证明：服务端推送、状态机、TurnLine 三处只要有一处错，
// 页面上就没有 `.tps-chip`。用操作员的 Edge（CDP）打开这个临时实例。
const CDP = process.env.CDP ?? "http://127.0.0.1:9223";
let browserOk = false;
try {
  const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
  await sleep(2500);
  const cdp = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { cdp.onopen = res; cdp.onerror = rej; });
  let mid = 0;
  const waiting = new Map();
  cdp.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const w = waiting.get(m.id);
    if (w) { waiting.delete(m.id); m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result); }
  };
  const send = (method, params = {}, to = 20000) => new Promise((res, rej) => {
    const id = ++mid;
    const timer = setTimeout(() => { waiting.delete(id); rej(new Error(`TIMEOUT ${method}`)); }, to);
    waiting.set(id, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
    cdp.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expr, to = 20000) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, to);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
    return r.result.value;
  };

  await api("/api/settings", { method: "PUT", body: JSON.stringify({ prefs: { showTps: true } }) });
  const domId = await mk("sweep · 页面上看得见");
  await waitReady(domId);
  // 打开那条会话。轨上的行是 div（onClick 冒泡），点最深的那层文字就行；点不到就先把工作空间
  // 分组展开（默认是展开的，但一台机器上第一次进来可能是收起的）。
  const openIt = async () => ev(`(() => {
    const hit = (t) => [...document.querySelectorAll(".rail-group-body *")]
      .filter((el) => el.children.length === 0 && (el.textContent || "").includes(t))[0];
    let el = hit("sweep · 页面上看得见");
    if (!el) return "no-row";
    (el.closest("[class*=rail-row], [role=button], li") ?? el).click();
    return "clicked";
  })()`);
  let opened = await openIt();
  if (opened === "no-row") {
    await ev(`(() => { const g = document.querySelector(".rail-group-row"); g && g.click(); return true; })()`);
    await sleep(600);
    opened = await openIt();
  }
  await sleep(1500);
  check("the page can open the session under test", opened === "clicked", opened);

  // 边流边看：胶囊出现、说的是「字/秒」、数字是个正数
  void say(domId, "[slow] 页面上应该出现一枚测速胶囊");
  let chip = null;
  for (let i = 0; i < 40; i++) {
    chip = await ev(`(() => {
      const el = document.querySelector(".tps-chip");
      return el ? el.textContent : null;
    })()`);
    if (chip) break;
    await sleep(250);
  }
  check("the live chip shows up while the reply is streaming", Boolean(chip), String(chip));
  check("…and it says t/s", /t\/s/.test(String(chip)), String(chip));
  check("…with a real number in it", /≈\s*\d/.test(String(chip)), String(chip));

  // 说完了就该收起来：胶囊是「现在多快」，不是「刚才多快」
  await waitIdle(domId, 40_000);
  let gone = false;
  for (let i = 0; i < 20; i++) {
    gone = (await ev(`(() => !document.querySelector(".tps-chip"))()`)) === true;
    if (gone) break;
    await sleep(300);
  }
  check("…and it disappears when the turn ends", gone);
  browserOk = true;
  cdp.close();
} catch (e) {
  check("the browser section could not run (is Edge listening on CDP?)", false, String(e).slice(0, 160));
}
void browserOk;

try { await fetch(`${CDP}/json/close/${tab.id}`); } catch {}  // 别把页面留在浏览器里（堆到几百个会把整台机器拖死）
ws.close();
cleanup();
console.log(`\nlive-speed-sweep: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
