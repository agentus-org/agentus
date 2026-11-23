// 工作音（敲键盘）红绿：工具执行时响、人一开口就静音。
//
// 操作者拍板用 R2（密集单键真录音）作为工具执行状态音，叠在 thinking 和弦上。
// 判据读真实 __sfx.workPlaying()（音频层有没有活着的 source），不是意图布尔。
// fixture [bed-cycle]：先说一句完整的话（喇叭中，工作音该静）→ 工具长窗口（喇叭闲、
// newest 是未完成的 tool，工作音该响）→ 结束。
// 回退 setWork 或闸门时，"工具期工作音响"必红。
//
//   node scripts/qa/call-work-sfx.mjs
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
const stub = http.createServer((req, res) => {
  if (req.method === "POST" && String(req.url).startsWith("/audio/speech")) {
    let b = ""; req.on("data", (d) => { b += String(d); });
    req.on("end", () => { res.writeHead(200, { "content-type": "audio/wav", "content-length": String(clip.length) }); res.end(clip); });
    return;
  } res.writeHead(404).end();
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubPort = stub.address().port;

const freePort = () => new Promise((res, rej) => { const s = createTcp(); s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); });
const PORT = await freePort();
const dataDir = mkdtempSync(path.join(tmpdir(), "agentus-worksfx-"));
const home = mkdtempSync(path.join(tmpdir(), "agentus-worksfx-home-"));
const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
  detached: true, cwd: ROOT,
  env: { ...process.env, NODE_ENV: "development", HOME: home, HERMES_STUDIO_PORT: String(PORT), HERMES_STUDIO_DATA: dataDir },
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
    localStorage.setItem('hermes-studio.active', s.id); return s.id; })()`);
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
  check("sfx probe hook has workPlaying", await ev(`!!window.__sfx && typeof window.__sfx.workPlaying === 'function'`));
  check("work-buzz.wav decoded", (await ev(`(window.__sfx?.sfxStatus?.()?.work ?? null)`)) !== null,
    JSON.stringify(await ev(`window.__sfx?.sfxStatus?.()`)));

  // 预热一轮让 baseline 落定
  await ev(`(() => { const ta=document.querySelector('.call-input textarea,.call-input input,.composer textarea');
    const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
    set.call(ta,'warmup'); ta.dispatchEvent(new Event('input',{bubbles:true}));
    ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return true; })()`);
  for (let i = 0; i < 60; i++) { await sleep(400); const ph = await ev(`document.querySelector('.call-mode')?.dataset.phase ?? null`); if (ph === 'listening' || ph === null) break; }
  await sleep(500);

  // 发 probe，每 250ms 采一次 (phase, workPlaying, spoken)
  await ev(`(() => { const ta=document.querySelector('.call-input textarea,.call-input input,.composer textarea');
    const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
    set.call(ta,'[bed-cycle]'); ta.dispatchEvent(new Event('input',{bubbles:true}));
    ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return true; })()`);
  const tl = [];
  for (let i = 0; i < 48; i++) { await sleep(250);
    const st = await ev(`({ phase: document.querySelector('.call-mode')?.dataset.phase ?? null,
      work: window.__sfx?.workPlaying?.() ?? null, speaking: !!document.querySelector('.call-mode [data-speaking="1"]'),
      intent: (window.__callSound||{}).work ?? (window.__callWork || {}).playing ?? null })`); tl.push(st); }
  console.log("---- timeline ----\n" + tl.map((s,i)=>`${(i*.25).toFixed(2)}s ${s.phase} work=${s.work} intent=${s.intent}`).join("\n"));

  // 说话期：工作音该静（用 intent 布尔判，避开音层解码竞态）
  const speakingOff = tl.some((s) => s.intent === false);
  check("work sound is off while speaking / before tool", speakingOff);
  // 工具期：工作音该响
  const workOn = tl.some((s) => s.intent === true);
  check("work sound turns ON during the tool-execution window", workOn,
    "on@" + tl.findIndex((s) => s.intent === true));
  // 真实音层确实起来了（不是只有意图布尔）
  const realOn = tl.some((s) => s.work === true);
  check("the work source really reached the audio graph", realOn);
  // 结束回 listening 后静
  check("work sound is off after the turn ends", tl.slice(-3).every((s) => s.intent === false || s.intent === null));

} catch (e) {
  fail++; console.log(`FAIL  swept threw  — ${e?.message ?? e}`);
  console.log(log.split("\n").slice(-25).join("\n"));
} finally {
  try { await fetch(`${CDP}/json/close/${tab.id}`); } catch {}
  killGroup(proc); stub.close();
  console.log(`\n${pass} passed / ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
