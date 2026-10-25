// 在 live 上取证（#61）：用户说「思考中那么长时间一点声音都没有」。之前所有绿都是在自起的
// mock 实例上跑的，这次必须在 live + 真 hermes 后端上看。
//
// 判据只从页面里取：
//   · 页面加载的是哪个 bundle（先排除「没刷新，跑的还是旧代码」）
//   · 通话中 active.busy 到底是不是 true（bed 的触发条件就是它）
//   · AudioContext.state 是否 running
//   · __callBed 有没有出现过 playing:true
//
//   node scripts/qa/live-sfx-probe.mjs
import { readFileSync } from "node:fs";
import path from "node:path";

const CDP = process.env.CDP ?? "http://127.0.0.1:9223";
const BASE = process.env.AGENTUS_BASE ?? "http://127.0.0.1:8788";
// live 的口令用户改过，不猜；用实例自己的 machine token（Bearer）冒充已登录的页面。
// token 只在这个进程里用，不打印。
const TOKEN_FILE = process.env.AGENTUS_TOKEN_FILE
  ?? "/Users/liang/Workspace/agent-dev-workspace/worktrees/agentus/packages/server/.data/auth.token";
const TOKEN = readFileSync(TOKEN_FILE, "utf8").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(2500);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const waiting = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result); } };
const send = (method, params = {}, to = 30000) => new Promise((res, rej) => {
  const mid = ++id; const t = setTimeout(() => { waiting.delete(mid); rej(new Error("TIMEOUT " + method)); }, to);
  waiting.set(mid, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expr, to = 30000) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, to);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};
const clickAt = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
};

// 观测桩：每次创建的 AudioContext、解码与 start 的记录
await send("Page.enable").catch(() => {});
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  (() => {
    const T = ${JSON.stringify(TOKEN)};
    const of = window.fetch;
    window.fetch = function (u, o = {}) {
      const url = typeof u === "string" ? u : (u && u.url) || "";
      if (url.includes("/api/")) {
        o = { ...o, headers: { ...(o.headers || {}), authorization: "Bearer " + T } };
      }
      return of.call(this, u, o);
    };
    window.__ctxs = []; window.__decoded = []; window.__started = [];
    const Base = window.AudioContext || window.webkitAudioContext;
    if (Base && !window.__ctxWrapped) {
      window.__ctxWrapped = true;
      window.AudioContext = class extends Base { constructor(...a) { super(...a); window.__ctxs.push(this); } };
      window.webkitAudioContext = window.AudioContext;
      const od = Base.prototype.decodeAudioData;
      Base.prototype.decodeAudioData = function (b) { return od.call(this, b).then((x) => { window.__decoded.push(Math.round(x.duration * 1000)); return x; }); };
      const os = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (...a) { if (this.buffer) window.__started.push(Math.round(this.buffer.duration * 1000)); return os.apply(this, a); };
    }
  })();
` });

await send("Page.reload", { ignoreCache: true });
await sleep(2600);

console.log("bundle in page:", await ev(`Array.from(document.scripts).map(s => s.src).filter(s => s.includes('/assets/'))`));
console.log("version:", await ev(`fetch('/api/version').then(r => r.text())`));

console.log("auth me:", await ev(`fetch('/api/auth/me').then(r => r.status + ' ' + r.text())`));

// 建一个真 hermes 会话（用完删）
const sid = await ev(`(async () => {
  const r = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ backend: 'hermes', cwd: '/tmp' }) });
  const j = await r.json();
  localStorage.setItem('agentus.active', j.id);
  return j.id;
})()`);
console.log("session:", sid);

await send("Page.reload", { ignoreCache: true });
await sleep(3200);
console.log("bundle after reload:", await ev(`Array.from(document.scripts).map(s => s.src).filter(s => s.includes('/assets/'))`));

const box = await ev(`(() => { const b = document.querySelector('button[aria-label="开始语音通话"]');
  if (!b) return null; const r = b.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`);
console.log("call button:", box);
if (box) await clickAt(box[0], box[1]);
await sleep(2400);
console.log("phase:", await ev(`document.querySelector('.call-mode')?.dataset.phase ?? null`));

// 发一个会想一会儿的任务
console.log("send:", await ev(`(() => {
  const ta = document.querySelector('.call-mode textarea, .call-mode input[type=text], .call-mode [contenteditable]');
  if (!ta) return 'no-input';
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (ta.tagName === 'TEXTAREA' && set) set.call(ta, '慢慢想，用三分钟讲清楚 ACP 协议的握手流程，越细越好。');
  else ta.textContent = '慢慢想，用三分钟讲清楚 ACP 协议的握手流程，越细越好。';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return 'sent';
})()`));

const samples = [];
for (let i = 0; i < 60; i++) {
  await sleep(500);
  const s = await ev(`({ phase: document.querySelector('.call-mode')?.dataset.phase ?? null,
    bed: window.__callBed ?? null,
    ctx: (window.__ctxs || []).map(c => c.state), started: window.__started.slice(-3) })`);
  samples.push(s);
  if (i % 4 === 0) console.log(i * 0.5 + "s", JSON.stringify(s));
  if (s.bed && s.bed.playing) { console.log("BED PLAYING at", i * 0.5 + "s"); break; }
}
console.log("final states:", [...new Set(samples.map((s) => s.ctx.join()))]);
console.log("any bed playing:", samples.some((s) => s.bed && s.bed.playing));

// 收尾：删掉这个探针会话
console.log("cleanup:", await ev(`fetch('/api/sessions/${sid}', { method: 'DELETE' }).then(r => r.status)`));
ws.close();
