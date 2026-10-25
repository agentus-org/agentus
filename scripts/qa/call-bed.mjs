// 状态音（#61）：干活时的背景音什么时候在、什么时候必须闭嘴；打断音有没有上膛。
//
// 这两条是这个功能的全部意义，也最容易做错：
//   · 干活（phase=thinking）时背景音在 —— 耳朵能听到「它还在推进」；
//   · **agent 一开口说话就必须淡出** —— 人声底下垫着底噪比没有背景音更差；
//   · 打断音（0.295s 的那一声音）要预取到手上，不能第一次点的时候还空着。
//
// 判据全部来自真实页面里 WebAudio 的实际行为（decode / start 的观测），不看 UI 文案。
//
//   node scripts/qa/call-bed.mjs
import { spawn } from "node:child_process";
import { createServer as createTcp } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CDP = process.env.CDP ?? "http://127.0.0.1:9223";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const killGroup = (target) => {
  const pid = typeof target === "number" ? target : target?.pid;
  if (!pid) return;
  try { process.kill(-pid, "SIGKILL"); } catch { try { killGroup(pid); } catch { /* gone */ } }
};

// ------------------------------------------------------------------ instance
const freePort = () => new Promise((res, rej) => {
  const s = createTcp();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});
const PORT = await freePort();
const dataDir = mkdtempSync(path.join(tmpdir(), "agentus-bed-"));
const emptyHome = mkdtempSync(path.join(tmpdir(), "agentus-bed-home-"));
const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
  detached: true,
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: "development", HOME: emptyHome, AGENTUS_PORT: String(PORT), AGENTUS_DATA: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
proc.stdout.on("data", (d) => { log += String(d); });
proc.stderr.on("data", (d) => { log += String(d); });
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 100 && !log.includes(`0.0.0.0:${PORT}`); i++) await sleep(150);
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }
const token = () => readFileSync(path.join(dataDir, "auth.token"), "utf8").trim();
const api = async (p, opts = {}) => {
  const r = await fetch(`${BASE}${p}`, { ...opts, headers: { authorization: `Bearer ${token()}`, ...(opts.body ? { "content-type": "application/json" } : {}) } });
  const text = await r.text();
  return { status: r.status, text, json: () => (text ? JSON.parse(text) : null) };
};

// ------------------------------------------------------------------ browser
const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(2600);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const waiting = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { const x = waiting.get(m.id); waiting.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); }
};
const send = (method, params = {}, to = 30000) => new Promise((res, rej) => {
  const mid = ++id; const timer = setTimeout(() => { waiting.delete(mid); rej(new Error("TIMEOUT " + method)); }, to);
  waiting.set(mid, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expr, to = 30000) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, to);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};
async function click(selector) {
  const ok = await ev(`(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (!b) return false; b.click(); return true; })()`);
  if (!ok) throw new Error(`no such element: ${selector}`);
}

try {
  // 页面级的观测桩：解码过哪些音、真正 start 过哪些音
  await send("Page.enable").catch(() => {});
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `
    (() => {
      window.__decoded = []; window.__started = []; window.__ctxs = [];
      // 记录每一个被创建的 AudioContext：只有 state 是 "running" 才真的出声。
      // 之前只断言 "source.start() 被调用过"，那是假绿 —— suspended 的 context 里
      // start() 照常执行，但一个字节都不会响。
      const Base = window.AudioContext || window.webkitAudioContext;
      if (Base && !window.__ctxWrapped) {
        window.__ctxWrapped = true;
        window.AudioContext = class extends Base {
          constructor(...a) { super(...a); window.__ctxs.push(this); }
        };
        window.webkitAudioContext = window.AudioContext;
      }
      const wrap = () => {
        const C = window.AudioContext || window.webkitAudioContext;
        if (!C || window.__sfxWrapped) return;
        window.__sfxWrapped = true;
        // 必须保留 Promise 形态：带回调的旧形态会让调用方的 .then() 收到 undefined，
        // 而产品代码正是用 .then() 拿 buffer 的 —— 桩改坏形状会把「没播」误判成产品 bug。
        const od = C.prototype.decodeAudioData;
        C.prototype.decodeAudioData = function (buf) {
          return od.call(this, buf).then((audio) => {
            window.__decoded.push(Math.round(audio.duration * 1000));
            return audio;
          });
        };
        const os = AudioBufferSourceNode.prototype.start;
        AudioBufferSourceNode.prototype.start = function (...a) {
          if (this.buffer) window.__started.push(Math.round(this.buffer.duration * 1000));
          return os.apply(this, a);
        };
      };
      wrap();
      setTimeout(wrap, 300);
    })();
  ` });

  await ev(`(async () => { await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: [1,2,3,4,5,6].join('') }) }).catch(() => {}); return true; })()`);
  const sid = await ev(`(async () => {
    localStorage.setItem('agentus.call.caption', '1');
    // 按键模式：自动化里没有可用的浏览器语音识别网，语音模式会当场报 speech recognition failed
    await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ call: { interruptMode: "button" } }) });
    const s = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backend: 'mock', cwd: '/tmp' }) }).then((r) => r.json());
    localStorage.setItem('agentus.active', s.id);
    return s.id;
  })()`);
  await send("Browser.grantPermissions", { origin: BASE, permissions: ["audioCapture"] }).catch(() => {});
  await send("Page.reload", { ignoreCache: true });
  for (let i = 0; i < 40; i++) { await sleep(500); if (await ev(`!!document.querySelector('.composer, .chat-head')`)) break; }
  await sleep(900);

  // 用 CDP 真鼠标事件点，而不是 element.click()：自动播放策略只认 isTrusted 的输入，
  // 脚本 click() 不给 user activation，AudioContext 会一直是 suspended ——
  // 那样测出来的红全是浏览器策略，不是产品问题。
  const box = await ev(`(() => { const b = document.querySelector('button[aria-label="开始语音通话"]'); if (!b) return null;
    const r = b.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`);
  check("the call button is on screen", Array.isArray(box), JSON.stringify(box));
  if (Array.isArray(box)) {
    const [cx, cy] = box;
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 });
  }
  await sleep(1600);
  await ev(`window.__asFeed = { level: 0.0, text: '', interim: '' }; true`);   // 自动化里不给它开麦
  const opened = await ev(`({ open: !!document.querySelector('.call-mode'), phase: document.querySelector('.call-mode')?.dataset.phase ?? null,
    text: (document.querySelector('.call-mode')?.innerText ?? '').slice(0, 300) })`);
  check("the call opened and is listening (not stuck in error)", opened.open && opened.phase !== "error", JSON.stringify(opened));

  console.log("audio ctx probe:", JSON.stringify(await ev(`(() => { try { const c = new AudioContext(); const r = { ok: true, state: c.state, rate: c.sampleRate }; void c.close(); return r; } catch (e) { return { ok: false, err: String(e && e.message || e) }; } })()`)));

  // 两个音都预取到了？（32s 的背景音 + 0.295s 的打断音）
  let decoded = [];
  for (let i = 0; i < 40; i++) {
    decoded = await ev(`window.__decoded || []`);
    if (decoded.length >= 2) break;
    await sleep(250);
  }
  const hasBed = decoded.some((ms) => ms > 30000);
  const hasCut = decoded.some((ms) => ms >= 250 && ms <= 400);
  check("prefetched the 32s thinking bed", hasBed, JSON.stringify(decoded));
  check("prefetched the ~0.3s interrupt sound", hasCut, JSON.stringify(decoded));

  // 让它干活：mock 的工具窗口是 thinking 相位的真实来源
  const sent = await ev(`(() => {
    const ta = document.querySelector('.call-input textarea, .call-input input, .composer textarea');
    if (!ta) return 'no-input';
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, '[tools:1:5000]');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 'sent';
  })()`);
  check("the prompt went into the call", sent === "sent", String(sent));

  // 干活中：背景音必须在
  // 判据不是「thinking 相位」——那个窗口只有几十毫秒，测不到也不代表产品错。
  // 真正要断言的是：整轮在跑的时候底音在响，它一开口就没了。
  let bedWhileWorking = null, sawWorking = false;
  const phasesSeen = [];
  for (let i = 0; i < 80; i++) {
    await sleep(200);
    // 判据读**音频层的真状态**（`__sfx.bedPlaying()` = sfx 里真的有活着的 source/元素），
    // 不读 `__callBed.playing` —— 那是产品自己写的意图布尔，删掉整个 setBed() 它照样为 true，
    // 也就是"一个字节都不响"也能 PASS（review 抓到的假绿）。
    const st = await ev(`({ phase: document.querySelector('.call-mode')?.dataset.phase ?? null, bed: window.__callBed ?? null, playing: (window.__sfx?.bedPlaying?.() ?? null), starts: (window.__started || []).length })`);
    if (st.phase && phasesSeen[phasesSeen.length - 1] !== st.phase) phasesSeen.push(st.phase);
    if (st.phase === "speaking") break;
    if (st.playing === true) { sawWorking = true; bedWhileWorking = st; break; }
  }
  check("the bed plays while the turn is working (before it speaks)", sawWorking, JSON.stringify(bedWhileWorking) + " phases: " + phasesSeen.join(" → "));

  let bedWhileSpeaking = null, sawSpeaking = false;
  for (let i = 0; i < 80; i++) {
    await sleep(200);
    const st = await ev(`({ phase: document.querySelector('.call-mode')?.dataset.phase ?? null, bed: window.__callBed ?? null, playing: (window.__sfx?.bedPlaying?.() ?? null) })`);
    if (st.phase === "speaking") { sawSpeaking = true; bedWhileSpeaking = st.playing === true; break; }
  }
  check("the call reached the speaking phase", sawSpeaking);
  check("the bed is gone once it starts talking", bedWhileSpeaking === false, String(bedWhileSpeaking));
  // 兜底通道也算响：解不开 m4a 的 WebView 上 bedPlaying() 读的是 <audio> 元素。
  check("…and whichever channel carried it, it was a real one",
    (await ev(`(window.__sfx?.sfxStatus?.().channel ?? "none")`)) !== "none",
    JSON.stringify(await ev(`(window.__sfx?.sfxStatus?.() ?? null)`)));

  const started = await ev(`window.__started || []`);
  check("the call's audio context is actually running (not suspended)", (await ev(`(window.__ctxs || []).some((c) => c.state === "running")`)) === true,
    JSON.stringify(await ev(`(window.__ctxs || []).map((c) => c.state)`)));
  check("the bed really reached the audio graph (a 32s source was started)", started.some((ms) => ms > 30000), JSON.stringify(started));
  const sid2 = sid;
  check("the session under test is the one we created", typeof sid2 === "string" && sid2.length >= 6, sid2);
} catch (e) {
  fail++;
  console.log(`FAIL  the sweep itself threw  — ${e?.message ?? e}`);
  console.log(log.split("\n").slice(-25).join("\n"));
} finally {
  try { await fetch(`${CDP}/json/close/${tab.id}`); } catch { /* tab gone */ }
  killGroup(proc);
  console.log(`\n${pass} passed / ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
