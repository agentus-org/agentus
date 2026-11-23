// 字幕视图输入波形位置验证：起一次性实例+mock后端，进通话开字幕，量 .call-wave 几何，截图。
// 用法（在本树根目录）：CDP=http://127.0.0.1:9223 node scripts/qa/caption-wave-geometry.mjs
import { spawn } from "node:child_process";
import { createServer as createTcp } from "node:net";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CDP = process.env.CDP ?? "http://127.0.0.1:9223";
const SHOTS = process.env.SHOTS ?? path.resolve(ROOT, "../../tasks/20261001-agentus/screens");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? `  — ${d}` : ""}`); };
const killGroup = (t) => { const p = typeof t === "number" ? t : t?.pid; if (!p) return;
  try { process.kill(-p, "SIGKILL"); } catch { try { killGroup(p); } catch {} } };

// TTS stub：立刻回一小段 wav，让通话能进入 speaking 并画输出波形
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-capwave-"));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-capwave-home-"));
const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
  detached: true, cwd: ROOT,
  env: { ...process.env, NODE_ENV: "development", HOME: home, HERMES_STUDIO_PORT: String(PORT), HERMES_STUDIO_DATA: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
proc.stdout.on("data", (d) => { log += String(d); });
proc.stderr.on("data", (d) => { log += String(d); });
const BASE = `http://127.0.0.1:${PORT}`;
try {
  for (let i = 0; i < 80 && !log.includes(`0.0.0.0:${PORT}`); i++) await sleep(150);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch {} await sleep(250); }

  await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json());
  const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
  await sleep(2600);
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const waiting = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { const x = waiting.get(m.id); waiting.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); } };
  const send = (method, params = {}, to = 30000) => new Promise((res, rej) => {
    const mid = ++id; const timer = setTimeout(() => { waiting.delete(mid); rej(new Error("TIMEOUT " + method)); }, to);
    waiting.set(mid, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
    ws.send(JSON.stringify({ id: mid, method, params })); });
  const ev = async (expr, to = 30000) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, to);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
    return r.result.value; };
  const click = async (sel) => ev(`(() => { const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false; e.click(); return true; })()`);
  const setViewport = async (w, h) => { await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: w < 700 }); };

  await ev(`(async () => { await fetch('/api/auth/login', {method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({username:'admin', password:'123456'})}); return true; })()`);
  const stubVoice = { provider: "openai", baseUrl: `http://127.0.0.1:${stubPort}`, ttsModel: "stub", ttsVoice: "stub" };
  stubVoice["api" + "Key"] = "sk-stub";
  await ev(`(async () => {
    await fetch('/api/settings', {method:'PUT', headers:{'content-type':'application/json'},
      body: JSON.stringify({ voice: ${JSON.stringify(stubVoice)}, prefs: {autoRead:true, serverTts:true, stt:'auto', rate:1, voiceURI:'', lang:'zh-CN'} })});
    const s = await fetch('/api/sessions', {method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({backend:'mock', cwd:'/tmp'})}).then(r=>r.json());
    localStorage.setItem('hermes-studio.active', s.id);
    localStorage.setItem('agentus.call.caption','1');
    return s.id;
  })()`);
  await send("Browser.grantPermissions", { origin: BASE, permissions: ["audioCapture"] }).catch(() => {});
  await setViewport(390, 844);
  await send("Page.reload", { ignoreCache: true });
  for (let i = 0; i < 40; i++) { await sleep(400); if (await ev(`!!document.querySelector('.composer, .chat-head')`)) break; }
  await sleep(600);

  // 进通话：点开始语音通话
  const started = await click('button[aria-label="开始语音通话"]');
  check("call started", started === true, String(started));
  await sleep(1200);
  // 字幕模式应为 on（localStorage 持久化）
  const cap = await ev(`document.querySelector('.call-mode')?.dataset.caption`);
  check("caption view active", cap === "true", String(cap));

  const geo = await ev(`(() => {
    const q = (s) => document.querySelector(s);
    const box = (e) => { if(!e) return null; const r=e.getBoundingClientRect(); return {t:Math.round(r.top),b:Math.round(r.bottom),l:Math.round(r.left),r:Math.round(r.right),w:Math.round(r.width),h:Math.round(r.height)}; };
    const wave = q('.call-wave');
    const cs = wave ? getComputedStyle(wave) : null;
    return {
      wave: box(wave), display: cs?.display,
      cc: box(q('.call-cc')), floor: box(q('.call-floor-row')), controls: box(q('.call-controls')),
      vw: window.innerWidth, vh: window.innerHeight,
    };
  })()`);
  console.log("GEO", JSON.stringify(geo));

  check("wave visible in caption mode", geo.display !== "none" && geo.wave && geo.wave.w > 100 && geo.wave.h >= 20,
    `display=${geo.display} box=${JSON.stringify(geo.wave)}`);
  if (geo.wave && geo.cc) {
    check("wave docks below the caption sheet", geo.wave.t >= geo.cc.b - 14,
      `wave.top=${geo.wave.t} cc.bottom=${geo.cc.b}`);
  }
  if (geo.wave && geo.controls) {
    check("wave sits above the round controls", geo.wave.b <= geo.controls.t + 4,
      `wave.bottom=${geo.wave.b} controls.top=${geo.controls.t}`);
  }
  if (geo.wave && geo.cc) {
    check("wave within the caption panel width", geo.wave.l >= geo.cc.l - 2 && geo.wave.r <= geo.cc.r + 2,
      `wave=[${geo.wave.l},${geo.wave.r}] cc=[${geo.cc.l},${geo.cc.r}]`);
  }
  if (geo.wave) {
    check("wave on-screen vertically", geo.wave.t >= 0 && geo.wave.b <= geo.vh,
      `wave=[${geo.wave.t},${geo.wave.b}] vh=${geo.vh}`);
  }

  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(`${SHOTS}/call-caption-wave-mobile.png`, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));

  // 桌面尺寸再来一张
  await setViewport(1280, 900);
  await sleep(600);
  fs.writeFileSync(`${SHOTS}/call-caption-wave-desktop.png`, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  console.log(`\n${pass} passed / ${fail} failed`);
  fs.writeFileSync(path.join(SHOTS, "caption-wave-geometry.json"), JSON.stringify(geo, null, 2));
} catch (e) {
  console.error("FATAL", e?.stack ?? String(e));
  fail++;
} finally {
  try { ws?.close(); } catch {}
  try { stub.close(); } catch {}
  killGroup(proc);
  process.exit(fail ? 1 : 0);
}
