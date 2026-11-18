// 状态机红绿：操作者报的 bug —— "话已入队、喇叭还没出声时，哒哒声还在响盖住人声"。
//
// 统一状态机三态（读真实 __callSound.state + __sfx 音层）：
//   playing —— 第一句入队 → 最后一句念完：bed/work 全静
//   working —— 回合在跑、没在播报（工具/思考）：bed 响，工具期 work 响
//   idle    —— 没回合：全静
//
// 关键：TTS stub 收到请求后延迟 4.5s 才返回音频，制造"话已入队但还没出声"的窗口，
// 这段时间内 state 必须是 playing、bed/work 都必须 false（否则就盖住即将播放的人声）。
// fixture [bed-cycle] = 说一句完整的话 -> 长工具窗口 -> 结束。
// 回退状态机（改回读 spoken.speaking/phase）时，"入队未出声窗口全静"必红。
//
//   node scripts/qa/call-sound-machine.mjs
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
const check = (n, ok, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? `  — ${d}` : ""}`); };
const killGroup = (t) => { const p = typeof t === "number" ? t : t?.pid; if (!p) return;
  try { process.kill(-p, "SIGKILL"); } catch { try { killGroup(p); } catch {} } };

function wav(sec) { const r = 8000, n = r * sec, d = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) d.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 320 * i / r) * 2200), i * 2);
  const h = Buffer.alloc(44); h.write("RIFF", 0); h.writeUInt32LE(36 + d.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(r, 24); h.writeUInt32LE(r * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(d.length, 40); return Buffer.concat([h, d]); }
const clip = wav(0.4);
// TTS stub：每个请求延迟 4500ms 才回音频 —— 制造"话入队了但还没出声"的长窗口。
const stub = http.createServer((req, res) => {
  if (req.method === "POST" && String(req.url).startsWith("/audio/speech")) {
    let b = ""; req.on("data", (d) => { b += String(d); });
    req.on("end", () => { setTimeout(() => {
      res.writeHead(200, { "content-type": "audio/wav", "content-length": String(clip.length) });
      res.end(clip);
    }, 4500); });
    return;
  } res.writeHead(404).end();
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubPort = stub.address().port;

const freePort = () => new Promise((res, rej) => { const s = createTcp(); s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); });
const PORT = await freePort();
const dataDir = mkdtempSync(path.join(tmpdir(), "agentus-sndmach-"));
const home = mkdtempSync(path.join(tmpdir(), "agentus-sndmach-home-"));
const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
  detached: true, cwd: ROOT,
  env: { ...process.env, NODE_ENV: "development", HOME: home, AGENTUS_PORT: String(PORT), AGENTUS_DATA: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
proc.stdout.on("data", (d) => { log += String(d); }); proc.stderr.on("data", (d) => { log += String(d); });
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 100 && !log.includes(`0.0.0.0:${PORT}`); i++) await sleep(150);
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch {} await sleep(250); }

const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(2600);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const waiting = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { const x = waiting.get(m.id); waiting.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); } };
const send = (method, params = {}, to = 30000) => new Promise((res, rej) => {
  const mid = ++id; const t = setTimeout(() => { waiting.delete(mid); rej(new Error("TIMEOUT " + method)); }, to);
  waiting.set(mid, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expr, to = 30000) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, to);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed"); return r.result.value; };

try {
  await ev(`(async () => { await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: [1,2,3,4,5,6].join('') }) }).catch(() => {}); return true; })()`);
  const stubVoice = { provider: "openai", baseUrl: `http://127.0.0.1:${stubPort}`, ttsModel: "stub-tts", ttsVoice: "stub", ttsFormat: "wav", ["api" + "Key"]: ["sk-", "stub", "-key"].join("") };
  await ev(`(async () => { localStorage.setItem('agentus.call.caption','1');
    await fetch('/api/settings',{method:'PUT',headers:{'content-type':'application/json'},
      body: JSON.stringify({ voice: ${JSON.stringify(stubVoice)}, prefs:{autoRead:false,serverTts:true,stt:"auto",rate:1,voiceURI:"",lang:"zh-CN"}, call:{interruptMode:"button"} }) });
    const s = await fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({backend:'mock',cwd:'/tmp'})}).then(r=>r.json());
    localStorage.setItem('agentus.active', s.id); return s.id; })()`);
  await send("Browser.grantPermissions", { origin: BASE, permissions: ["audioCapture"] }).catch(() => {});
  await send("Page.reload", { ignoreCache: true });
  for (let i = 0; i < 40; i++) { await sleep(500); if (await ev(`!!document.querySelector('.composer, .chat-head')`)) break; }
  await sleep(900);

  const box = await ev(`(() => { const b = document.querySelector('button[aria-label="开始语音通话"]'); if (!b) return null;
    const r = b.getBoundingClientRect(); return [Math.round(r.x+r.width/2), Math.round(r.y+r.height/2)]; })()`);
  check("call button on screen", Array.isArray(box));
  if (Array.isArray(box)) { await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box[0], y: box[1], button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box[0], y: box[1], button: "left", clickCount: 1 }); }
  let listening = false;
  for (let i = 0; i < 40; i++) { await sleep(300); if (await ev(`document.querySelector('.call-mode')?.dataset.phase === 'listening'`)) { listening = true; break; } }
  check("call reached listening", listening);
  await ev(`window.__asFeed = { level: 0.0, text: '', interim: '' }; true`);
  check("sound-machine probe hook exists", await ev(`!!window.__callSound && typeof window.__sfx?.workPlaying === 'function'`));

  // 预热一轮（用真 TTS 延迟会很久；这里预热用小招：直接发一句短 prompt，等回到 listening）
  await ev(`(() => { const ta=document.querySelector('.call-input textarea,.call-input input,.composer textarea');
    const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
    set.call(ta,'warmup'); ta.dispatchEvent(new Event('input',{bubbles:true}));
    ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return true; })()`);
  for (let i = 0; i < 90; i++) { await sleep(400); const ph = await ev(`document.querySelector('.call-mode')?.dataset.phase ?? null`); if (ph === 'listening' || ph === null) break; }
  await sleep(500);

  // 发 probe，每 300ms 采 (phase, soundState, bed, work, 真实音层)
  await ev(`(() => { const ta=document.querySelector('.call-input textarea,.call-input input,.composer textarea');
    const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
    set.call(ta,'[bed-cycle]'); ta.dispatchEvent(new Event('input',{bubbles:true}));
    ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return true; })()`);
  const tl = [];
  for (let i = 0; i < 55; i++) { await sleep(300);
    const st = await ev(`({ phase: document.querySelector('.call-mode')?.dataset.phase ?? null,
      state: (window.__callSound||{}).state ?? null, bed: (window.__callSound||{}).bed ?? null,
      work: (window.__callSound||{}).work ?? null,
      rbed: window.__sfx?.bedPlaying?.() ?? null, rwork: window.__sfx?.workPlaying?.() ?? null })`); tl.push(st); }
  console.log("---- timeline ----\n" + tl.map((s,i)=>`${(i*.3).toFixed(1)}s ${s.phase} state=${s.state} bed=${s.bed} work=${s.work}`).join("\n"));

  // 核心：任何 state=playing 的采样里，bed/work 必须都 false（人声不能被盖）
  const playingSamples = tl.filter((s) => s.state === "playing");
  check("a playing window was observed", playingSamples.length > 0, `${playingSamples.length} samples`);
  check("during playing, bed is OFF (no chord covers the voice)", playingSamples.every((s) => s.bed === false));
  check("during playing, work is OFF (no keyboard clatter covers the voice)", playingSamples.every((s) => s.work === false),
    "bad=" + JSON.stringify(playingSamples.filter((s) => s.work !== false)));
  check("during playing, real audio layers are silent", playingSamples.every((s) => s.rbed === false && s.rwork === false));

  // working 期（工具静默）:bed 该响；工具在跑时 work 也响
  const workingSamples = tl.filter((s) => s.state === "working");
  check("a working window was observed after playback", workingSamples.length > 0, `${workingSamples.length} samples`);
  check("during working, bed is ON", workingSamples.some((s) => s.bed === true));
  check("during working with a running tool, work sound is ON", workingSamples.some((s) => s.work === true));

  // idle 期（回合结束）:全静
  const idleSamples = tl.filter((s) => s.state === "idle");
  check("turn ends in idle with all sounds off", idleSamples.length > 0 && idleSamples.every((s) => s.bed === false && s.work === false));

} catch (e) {
  fail++; console.log(`FAIL  swept threw  — ${e?.message ?? e}`);
  console.log(log.split("\n").slice(-25).join("\n"));
} finally {
  try { await fetch(`${CDP}/json/close/${tab.id}`); } catch {}
  killGroup(proc); stub.close();
  console.log(`\n${pass} passed / ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
