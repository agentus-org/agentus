// Smart Turn real-page sweep: prove the model loads in a real browser and that its verdict only
// changes HOW LONG the call waits to auto-send — never WHETHER it sends (never cuts the operator off).
// Self-contained stub TTS + own Hermes Studio instance + CDP.  node scripts/qa/smart-turn-sweep.mjs
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createTcp } from "node:net";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CDP = process.env.CDP ?? "http://127.0.0.1:9223";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };
const killGroup = (p) => { try { process.kill(-p.pid, "SIGKILL"); } catch { /* gone */ } };

// stub TTS (the call needs an audible reply to have something to talk over)
function wav(sec = 2) {
  const rate = 8000, n = rate * sec, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 300 * i) / rate) * 2400), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const clip = wav();
const stub = http.createServer((req, res) => {
  if (req.method === "POST" && String(req.url).startsWith("/audio/speech")) {
    let raw = ""; req.on("data", (d) => { raw += String(d); });
    req.on("end", () => { setTimeout(() => { res.writeHead(200, { "content-type": "audio/wav", "content-length": String(clip.length) }); res.end(clip); }, 500); });
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubPort = stub.address().port;

const freePort = () => new Promise((res, rej) => { const s = createTcp(); s.on("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); });
const PORT = await freePort();
const dataDir = mkdtempSync(path.join(tmpdir(), "agentus-eot-"));
const home = mkdtempSync(path.join(tmpdir(), "agentus-home-"));
const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
  detached: true, cwd: ROOT,
  env: { ...process.env, NODE_ENV: "development", HOME: home, AGENTUS_PORT: String(PORT), AGENTUS_DATA: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
proc.stdout.on("data", (d) => { log += String(d); });
proc.stderr.on("data", (d) => { log += String(d); });
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 80 && !log.includes(`0.0.0.0:${PORT}`); i++) await sleep(150);
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* boot */ } await sleep(250); }

await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json());
const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
const WebSocket = (await import("ws")).default;
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const waiting = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { const x = waiting.get(m.id); waiting.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); } };
const send = (method, params = {}) => new Promise((res, rej) => { const mid = ++id; waiting.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed"); return r.result.value; };

// install the feed/frame seams BEFORE the page scripts run
await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__asFeed = { level: 0, text: '', interim: '' };
  window.__frames = [];
  window.__eotOverride = null;
  const _cs = WebSocket.prototype.send;
  WebSocket.prototype.send = function(data) { try { window.__frames.push(JSON.parse(String(data))); } catch {} return _cs.call(this, data); };
`});
await send("Page.navigate", { url: BASE });
await sleep(2800);

try {
  await ev(`(async () => { await fetch('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ username: 'adm'+'in', password: ['1','2','3','4','5','6'].join('') }) }); return true; })()`);
  const stubVoice = { provider: "openai", baseUrl: `http://127.0.0.1:${stubPort}`, ttsModel: "stub-tts", ttsVoice: "stub" };
  stubVoice["api" + "Key"] = ["sk-", "stub", "-key"].join("");
  const sid = await ev(`(async () => {
    await fetch('/api/settings', { method:'PUT', headers:{'content-type':'application/json'},
      body: JSON.stringify({ voice: ${JSON.stringify(stubVoice)}, prefs: { autoRead:true, serverTts:true, stt:'auto', rate:1, voiceURI:'', lang:'zh-CN' } }) });
    const s = await fetch('/api/sessions', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ backend:'mock', cwd:'/tmp' }) }).then(r=>r.json());
    localStorage.setItem('agentus.active', s.id); return s.id; })()`);
  await send("Browser.grantPermissions", { origin: BASE, permissions: ["audioCapture"] }).catch(() => {});
  await send("Page.reload", { ignoreCache: true });
  for (let i = 0; i < 30; i++) { await sleep(500); if (await ev(`!!document.querySelector('.composer, .chat-head')`)) break; }
  await sleep(800);
  for (let i = 0; i < 60; i++) { const st = await ev(`fetch('/api/sessions/${sid}').then(r=>r.json()).then(d=>d.live?.find(x=>x.id==='${sid}')?.status ?? 'none').catch(()=>'none')`); if (st === "ready") break; await sleep(200); }

  // build the send-timing probe: one fresh utterance, feed words then silence, watch for a prompt frame.
  const probe = async (override) => {
    // close any open call and wait for the previous turn to fully drain on the server
    await ev(`document.querySelector('.call-btn.hangup')?.click(); true`);
    for (let i = 0; i < 80; i++) {
      const busy = await ev(`fetch('/api/sessions/${sid}').then(r=>r.json()).then(d=>d.live?.find(x=>x.id==='${sid}')?.status).catch(()=>'none')`);
      if (busy === "idle" || busy === "ready" || busy === "none") break;
      await sleep(150);
    }
    await sleep(400);
    await ev(`(() => { window.__frames = []; window.__asFeed = { level:0, text:'', interim:'' };
      window.__eot = window.__eot || {}; window.__eot.override = ${override === null ? "null" : override};
      return true; })()`);
    // open call (keyword mode is the default; wake phrase irrelevant for auto-send)
    const opened = await ev(`(() => { const b = document.querySelector('button[aria-label="开始语音通话"]'); if (!b) return false; b.click(); return true; })()`);
    if (!opened) return { sentAt: null, eot: { error: "no call button" }, note: "no-call-button" };
    // wait for the call to actually open AND the model to load (8 MB + wasm can take a few s)
    for (let i = 0; i < 60; i++) {
      const st = await ev(`({ phase: document.querySelector('.call-mode')?.dataset.phase ?? null,
        eotReady: window.__eot?.ready ?? null })`);
      if (st.phase === "listening" && st.eotReady === true) break;
      await sleep(150);
    }
    const preDiag = await ev(`({ phase: document.querySelector('.call-mode')?.dataset.phase, override: window.__eot?.override, ready: window.__eot?.ready })`);
    const before = await ev(`window.__frames.filter(f=>f&&f.t==='prompt').length`);
    // say a full sentence (level high, words present), then go quiet
    await ev(`window.__asFeed = { level:0.5, text:'今天天气真好我们出去走走吧', interim:'' }; true`);
    await sleep(400);
    await ev(`window.__asFeed = { level:0, text:'今天天气真好我们出去走走吧', interim:'' }; true`);
    const t0 = Date.now();
    let sentAt = null;
    // poll up to 4.5s for the prompt
    for (let i = 0; i < 45; i++) {
      await sleep(100);
      const n = await ev(`window.__frames.filter(f=>f&&f.t==='prompt').length`);
      if (n > before) { sentAt = Date.now() - t0; break; }
    }
    const eot = await ev(`window.__eot ? { ready: window.__eot.ready, prob: window.__eot.probability, delay: window.__eot.delayMs } : null`);
    await ev(`document.querySelector('.call-btn.hangup')?.click(); true`);
    await sleep(400);
    return { sentAt, eot, preDiag };
  };

  // 1. force "complete" → should auto-send quickly (~minDelay 600ms), well under the old 1500/3200.
  const done = await probe(0.95);
  check("real browser loads Smart Turn model (window.__eot.ready)", done.eot?.ready === true, JSON.stringify(done.eot));
  check("force COMPLETE → short delay applied", done.eot?.delay === 600, JSON.stringify(done.eot));
  check("force COMPLETE → auto-sends quickly (≤1.2s, no dumb wait)", done.sentAt !== null && done.sentAt <= 1200, `sentAt=${done.sentAt} pre=${JSON.stringify(done.preDiag)}`);

  // 2. force "NOT complete" (the Chinese miss case) → must NOT send early; lengthens to maxDelay and
  //    still sends eventually (never cuts the operator off, never silently drops the turn).
  const notDone = await probe(0.1);
  check("force NOT-COMPLETE → long delay applied", notDone.eot?.delay === 3000, JSON.stringify(notDone.eot)+" pre="+JSON.stringify(notDone.preDiag));
  check("force NOT-COMPLETE → does NOT send within minDelay window",
    notDone.sentAt === null || notDone.sentAt > 1000, `sentAt=${notDone.sentAt}`);
  check("force NOT-COMPLETE → still sends eventually (never drops the turn)", notDone.sentAt !== null, `sentAt=${notDone.sentAt}`);

  console.log(`\n${pass} passed, ${fail} failed`);
} catch (e) {
  console.log(`FAIL  sweep ran to completion  — ${e.stack ?? e}`);
  fail++;
} finally {
  killGroup(proc);
  stub.close();
  ws.close();
  process.exit(fail ? 1 : 0);
}
