// 说一半去做工具时，扣着的那半句不能蒸发（issue #60）。
//
// 口述原文：「它话说一半就跳去干活了，最后一句永远听不到」。朗读器（CallMode.tsx）的规矩是
// 「成品句立刻入队，尾巴先扣着，等回合结束（!busy）再补念」—— 合并短碎句用的就是这条尾巴。
// 而「说一段话 → 调工具 → 接着说」这个形状里，回合并没有结束（busy 仍为 true），前端却把
// 工具之后的那条消息当成**新回复**换了 key，旧分支顺手 `queueRef.current = []`，扣着的尾巴
// 就这样跟着队列一起被丢弃：耳朵少一句，UI 上却有。
//
// 判据只看「真正送去念的正文」，不看 UI：stub TTS 收到的每一条 body 里必须出现第一段的尾巴，
// 而且必须排在第二段之前；旧代码这一条必然红。
//
//   node scripts/qa/call-tail.mjs
import { spawn } from "node:child_process";
import { createServer as createTcp } from "node:net";
import http from "node:http";
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

// ------------------------------------------------------------------ stub TTS
function wav(seconds, freq = 320) {
  const rate = 8000, n = rate * seconds, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 2200), i * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write("data", 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
const clip = wav(1);
/** every sentence the call actually asked the speaker to say, in order */
const spoken = [];
const stub = http.createServer((req, res) => {
  if (req.method === "POST" && String(req.url).startsWith("/audio/speech")) {
    let body = "";
    req.on("data", (d) => { body += String(d); });
    req.on("end", () => {
      spoken.push(body);
      res.writeHead(200, { "content-type": "audio/wav", "content-length": String(clip.length) });
      res.end(clip);
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubPort = stub.address().port;

// ------------------------------------------------------------------ instance
const freePort = () => new Promise((res, rej) => {
  const s = createTcp();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});
const PORT = await freePort();
const dataDir = mkdtempSync(path.join(tmpdir(), "agentus-tail-"));
const emptyHome = mkdtempSync(path.join(tmpdir(), "agentus-tail-home-"));
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
const shot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  const dir = path.resolve(ROOT, "../../tasks/20261001-agentus/screens");
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${name}.png`), Buffer.from(data, "base64"));
  } catch { /* screenshots are evidence, not the assertion */ }
};
async function click(selector) {
  const ok = await ev(`(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (!b) return false; b.click(); return true; })()`);
  if (!ok) throw new Error(`no such element: ${selector}`);
}

try {
  await ev(`(async () => { await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: [1,2,3,4,5,6].join('') }) }).catch(() => {}); return true; })()`);
  const stubVoice = { provider: "openai", baseUrl: `http://127.0.0.1:${stubPort}`, ttsModel: "stub-tts", ttsVoice: "stub", ttsFormat: "wav", ["api" + "Key"]: ["sk-", "stub", "-key"].join("") };
  await ev(`(async () => {
    localStorage.setItem('agentus.voice', JSON.stringify({ autoRead: false, voiceURI: '', rate: 1, lang: 'zh-CN', serverTts: true, stt: 'auto' }));
    localStorage.setItem('agentus.call.caption', '1');
    await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voice: ${JSON.stringify(stubVoice)}, prefs: { autoRead: false, serverTts: true, stt: "auto", rate: 1, voiceURI: "", lang: "zh-CN" }, call: { interruptMode: "button" } }) });
    const s = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backend: 'mock', cwd: '/tmp' }) }).then((r) => r.json());
    localStorage.setItem('agentus.active', s.id);
    return s.id;
  })()`);
  // 播放器在无声卡的自动化环境里会一直卡在「这次还没放完」（AudioContext 挂起，buffer 永不 end），
  // 队列因此不再往下走 —— 那样这条测试测的就是浏览器而不是我们。把解码/播放这两层换成确定性的
  // 桩：每次播放 120 ms 后按时结束。判据仍然只看「送去念的正文」，没有被桩稀释。
  await send("Page.enable").catch(() => {});
  const stubId = await send("Page.addScriptToEvaluateOnNewDocument", { source: `
    (() => {
      try { Object.defineProperty(window, 'AudioContext', { value: undefined, configurable: true }); } catch (e) {}
      try { Object.defineProperty(window, 'webkitAudioContext', { value: undefined, configurable: true }); } catch (e) {}
      window.Audio = class FakeAudio {
        constructor(src) { this.src = src; this.onended = null; this.onerror = null; this._t = null; }
        play() {
          this._t = setTimeout(() => { const f = this.onended; if (f) f(); }, 120);
          return Promise.resolve();
        }
        pause() { if (this._t) clearTimeout(this._t); }
        addEventListener() {} removeEventListener() {}
      };
    })();
  ` });
  check("the audio stack stub was registered before the reload", !!stubId?.identifier, JSON.stringify(stubId));
  await send("Browser.grantPermissions", { origin: BASE, permissions: ["audioCapture"] }).catch(() => {});
  await send("Page.reload", { ignoreCache: true });
  for (let i = 0; i < 40; i++) { await sleep(500); if (await ev(`!!document.querySelector('.composer, .chat-head')`)) break; }
  await sleep(900);

  await click('button[aria-label="开始语音通话"]');
  await sleep(1400);
  await ev(`window.__asFeed = { level: 0.0, text: '', interim: '' }; true`);   // 不给它在自动化里开麦
  await shot("call-tail-1-opened");
  spoken.length = 0;                                                          // 只看这一轮送去念的话

  // 一段话（结尾是没句号的半句）→ 调工具 → 另一条消息接着说
  await ev(`(() => {
    const ta = document.querySelector('.call-input textarea, .call-input input, .composer textarea');
    if (!ta) return 'no-input';
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, '[tail-probe]');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 'sent';
  })()`);

  // 等这一轮真的结束：第二段已经进了库，且相位回到空闲
  let ended = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const tail2 = await ev(`document.body.innerText.includes('这里是第二段')`);
    const phase = await ev(`document.querySelector('.call-mode')?.dataset.phase ?? null`);
    if (tail2 && (phase === null || phase === "idle" || phase === "listening")) { ended = true; break; }
  }
  check("the audio stack is stubbed (otherwise this sweep measures the browser)", await ev(`String(window.Audio).includes('FakeAudio')`));
  check("the turn ran to its end (second paragraph on screen)", ended === true);
  if (!ended) {
    const raw = await ev(`fetch('/api/sessions/' + localStorage.getItem('agentus.active') + '/messages?tail=20').then(r => r.text())`);
    console.log("---- store ----\n" + raw.slice(0, 1500));
    console.log("---- phase ---- " + JSON.stringify({
      call: await ev(`document.querySelector('.call-mode')?.dataset.phase ?? 'no-call'`),
      callOpen: await ev(`!!document.querySelector('.call-mode')`),
      working: await ev(`document.body.innerText.match(/工作中|正在|思考/g)`),
    }));
    console.log("---- page text ----\n" + (await ev(`document.body.innerText`)).slice(-700));
    console.log("---- captions ----\n" + JSON.stringify(await ev(`[...document.querySelectorAll('.call-cc p, .call-cc div')].map(e => e.textContent).slice(-8)`)));
  }
  await sleep(3500);                                                    // 让队列把最后一句也念完

  const said = spoken.join("\n");
  const hasTail = /最后半句没有句号/.test(said);
  const atTail = said.search(/最后半句没有句号/);
  const atSecond = said.search(/这里是第二段/);
  check("the held-back fragment of the first message was spoken", hasTail, said.slice(0, 300));
  check("it was said before the second message, not after it", hasTail && atSecond > atTail, `tail@${atTail} second@${atSecond}`);
  check("the second message was spoken too", atSecond >= 0, said.slice(-300));
  const dup = (said.match(/最后半句没有句号/g) ?? []).length;
  check("the fragment was not spoken twice", dup === 1, `count=${dup}`);
  await shot("call-tail-2-done");
} catch (e) {
  fail++;
  console.log(`FAIL  the sweep itself threw  — ${e?.message ?? e}`);
  console.log(log.split("\n").slice(-25).join("\n"));
} finally {
  try { await fetch(`${CDP}/json/close/${tab.id}`); } catch { /* tab gone */ }
  killGroup(proc);
  stub.close();
  console.log(`\n${pass} passed / ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
