// 和弦（thinking bed）红绿：说完一句后转工具/思考的静默期，和弦要回来。
//
// 症状：只在回合最初响一次，说完第一句后的工具/思考期间不响。
// 根因：旧闸门 `phase !== "speaking"` —— 说完后 busy 仍 true，reader 只在 !busy 时
//       把 phase 调回 listening，那段时间 phase 卡在 speaking，闸门一直为假。
// 修法：改问喇叭的 spoken.speaking。
//
// `[bed-cycle]` fixture：说一句完整的话（喇叭中、bed 灭）→ 工具长窗口（回合仍 busy、
// phase 卡 speaking，bed 该回来）→ 结束。判据读真实 __sfx.bedPlaying()。
// 回退修法（闸门换回 phase）时，"工具静默期 bed 回来"必红。
//
//   node scripts/qa/call-bed-cycle.mjs
import { spawn } from "node:child_process";
import { createServer as createTcp } from "node:net";
import http from "node:http";
import { mkdtempSync } from "node:fs";
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
const killGroup = (t) => {
  const pid = typeof t === "number" ? t : t?.pid;
  if (!pid) return;
  try { process.kill(-pid, "SIGKILL"); } catch { try { killGroup(pid); } catch {} }
};

// 本地 TTS stub：返回很短的 wav，让第一句很快念完、喇叭转 idle（不撞真上游 429）。
function wav(seconds) {
  const rate = 8000, n = rate * seconds, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 320 * i) / rate) * 2200), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const clip = wav(0.4);
const stub = http.createServer((req, res) => {
  if (req.method === "POST" && String(req.url).startsWith("/audio/speech")) {
    let body = "";
    req.on("data", (d) => { body += String(d); });
    req.on("end", () => { res.writeHead(200, { "content-type": "audio/wav", "content-length": String(clip.length) }); res.end(clip); });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubPort = stub.address().port;

const freePort = () => new Promise((res, rej) => {
  const s = createTcp();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});
const PORT = await freePort();
const dataDir = mkdtempSync(path.join(tmpdir(), "agentus-bedcycle-"));
const emptyHome = mkdtempSync(path.join(tmpdir(), "agentus-bedcycle-home-"));
const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
  detached: true, cwd: ROOT,
  env: { ...process.env, NODE_ENV: "development", HOME: emptyHome, HERMES_STUDIO_PORT: String(PORT), HERMES_STUDIO_DATA: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
proc.stdout.on("data", (d) => { log += String(d); });
proc.stderr.on("data", (d) => { log += String(d); });
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 100 && !log.includes(`0.0.0.0:${PORT}`); i++) await sleep(150);
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch {} await sleep(250); }

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

try {
  await ev(`(async () => { await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: [1,2,3,4,5,6].join('') }) }).catch(() => {}); return true; })()`);
  const stubVoice = { provider: "openai", baseUrl: `http://127.0.0.1:${stubPort}`, ttsModel: "stub-tts", ttsVoice: "stub", ttsFormat: "wav", ["api" + "Key"]: ["sk-", "stub", "-key"].join("") };
  await ev(`(async () => {
    localStorage.setItem('agentus.call.caption', '1');
    await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voice: ${JSON.stringify(stubVoice)}, prefs: { autoRead: false, serverTts: true, stt: "auto", rate: 1, voiceURI: "", lang: "zh-CN" }, call: { interruptMode: "button" } }) });
    const s = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backend: 'mock', cwd: '/tmp' }) }).then((r) => r.json());
    localStorage.setItem('hermes-studio.active', s.id);
    return s.id;
  })()`);
  await send("Browser.grantPermissions", { origin: BASE, permissions: ["audioCapture"] }).catch(() => {});
  await send("Page.reload", { ignoreCache: true });
  for (let i = 0; i < 40; i++) { await sleep(500); if (await ev(`!!document.querySelector('.composer, .chat-head')`)) break; }
  await sleep(900);

  const box = await ev(`(() => { const b = document.querySelector('button[aria-label="开始语音通话"]'); if (!b) return null;
    const r = b.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`);
  check("the call button is on screen", Array.isArray(box), JSON.stringify(box));
  if (Array.isArray(box)) {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box[0], y: box[1], button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box[0], y: box[1], button: "left", clickCount: 1 });
  }
  let listening = false;
  for (let i = 0; i < 40; i++) { await sleep(300); if (await ev(`document.querySelector('.call-mode')?.dataset.phase === 'listening'`)) { listening = true; break; } }
  check("the call reached listening", listening);
  await ev(`window.__asFeed = { level: 0.0, text: '', interim: '' }; true`);
  check("the sfx probe hook exists", await ev(`!!window.__sfx && typeof window.__sfx.bedPlaying === 'function'`));

  // 预热一轮，让 baseline 落定（否则 probe 的首段会被 bootLocked 当历史吞掉）
  await ev(`(() => { const ta = document.querySelector('.call-input textarea, .call-input input, .composer textarea');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, 'warmup'); ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
  for (let i = 0; i < 60; i++) { await sleep(400); const ph = await ev(`document.querySelector('.call-mode')?.dataset.phase ?? null`); if (ph === 'listening' || ph === null) break; }
  await sleep(500);

  // 发 probe，紧接着每 250ms 采一次 (phase, bedPlaying)，采 12 秒覆盖「说话→工具静默→结束」
  await ev(`(() => { const ta = document.querySelector('.call-input textarea, .call-input input, .composer textarea');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, '[bed-cycle]'); ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
  const timeline = [];
  for (let i = 0; i < 48; i++) {
    await sleep(250);
    const st = await ev(`({ phase: document.querySelector('.call-mode')?.dataset.phase ?? null, bed: window.__sfx?.bedPlaying?.() ?? null })`);
    timeline.push(st);
  }
  console.log("---- timeline ----\n" + timeline.map((s, i) => `${(i * 0.25).toFixed(2)}s ${s.phase} bed=${s.bed}`).join("\n"));

  // phase 卡在 speaking 是这个 bug 的形状，所以不能用「所有 speaking 时刻 bed 都该 false」当判据
  // ——那样会把「说完后工具静默期 bed 回来」也判成失败。按时间线形状断言：
  //   ① probe 开头先有一个 speaking+bed=false 的窗口（真在念，bed 关）
  //   ② 随后出现 speaking/thinking+bed=true（念完了、回合还在跑，bed 回来）
  //   ③ 回合结束 listening 时 bed=false
  const speakingOff = timeline.findIndex((s) => s.phase === "speaking" && s.bed === false);
  const bedBackAt = timeline.findIndex((s, i) => i > speakingOff && (s.phase === "speaking" || s.phase === "thinking") && s.bed === true);
  const endBed = timeline.slice(-3).every((s) => s.bed === false);
  check("bed is OFF at the start, while the first sentence is being spoken", speakingOff >= 0, `first off @${speakingOff}`);
  check("bed comes BACK after the sentence ends, while the turn is still running", bedBackAt > speakingOff,
    `off@${speakingOff} back@${bedBackAt}`);
  check("bed is OFF again once the turn ends", endBed);

} catch (e) {
  fail++;
  console.log(`FAIL  the sweep itself threw  — ${e?.message ?? e}`);
  console.log(log.split("\n").slice(-25).join("\n"));
} finally {
  try { await fetch(`${CDP}/json/close/${tab.id}`); } catch {}
  killGroup(proc);
  stub.close();
  console.log(`\n${pass} passed / ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
