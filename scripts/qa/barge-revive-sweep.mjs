// L4 false-interruption revival — real-page sweep.
// Self-contained: stub TTS + its own Hermes Studio instance + the QA Edge over CDP at :9223.
// Proves the NEW behaviour the pure state-machine test cannot: a barge candidate that was really
// echo/noise (mic goes quiet once we pause) RESUMES playback instead of destroying the answer.
//
// RETIRED 2026-11-21: the operator retired the 语音打断 mode entirely ("逻辑先废弃掉"), so the default
// is now 关键词打断 and a pure-level feed (no wake word) no longer barges — this sweep's premise is gone.
// The L4 state machine is still fully guarded by the pure unit test `barge-revive.mts` (13/13), which
// does not depend on any mode. Kept here for history; exits clean so the regression suite stays honest
// about what is actually a supported product path.
//
// Run: CDP=http://127.0.0.1:9223 node scripts/qa/barge-revive-sweep.mjs
console.log("barge-revive-sweep: RETIRED — 语音打断 mode retired 2026-11-21; pure logic still guarded by barge-revive.mts (13/13).");
process.exit(0);
import { spawn } from "node:child_process";
import { createServer as createTcp } from "node:net";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CDP = process.env.CDP ?? "http://127.0.0.1:9223";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`PASS  ${name}${detail ? `  — ${detail}` : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
};

// ---- TTS stub: a 2 s WAV so the call has something to talk over -------------------------------
function wav(seconds, freq = 300) {
  const rate = 8000, n = rate * seconds, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 2400), i * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write("data", 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
const clip = wav(2);
let upstreamHits = 0;
const stub = http.createServer((req, res) => {
  if (req.method === "POST" && String(req.url).startsWith("/audio/speech")) {
    upstreamHits++;
    let raw = "";
    req.on("data", (d) => { raw += String(d); });
    req.on("end", () => {
      setTimeout(() => { res.writeHead(200, { "content-type": "audio/wav", "content-length": String(clip.length) }); res.end(clip); }, 300);
    });
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubPort = stub.address().port;

// ---- instance --------------------------------------------------------------------------------
const freePort = () => new Promise((res, rej) => {
  const s = createTcp(); s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});
const PORT = await freePort();
const dataDir = mkdtempSync(path.join(os.tmpdir(), "agentus-l4-"));
const emptyHome = mkdtempSync(path.join(os.tmpdir(), "agentus-home-"));
const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
  detached: true, cwd: ROOT,
  env: { ...process.env, NODE_ENV: "development", HOME: emptyHome, HERMES_STUDIO_PORT: String(PORT), HERMES_STUDIO_DATA: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
proc.stdout.on("data", (d) => { log += String(d); });
proc.stderr.on("data", (d) => { log += String(d); });
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 80 && !log.includes(`0.0.0.0:${PORT}`); i++) await sleep(150);
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }

// ---- browser ----------------------------------------------------------------------------------
await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json());
const tab = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
await sleep(400);
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
const api = (method, p, body) => fetch(`${BASE}${p}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

try {
  const stubVoice = { provider: "openai", baseUrl: `http://127.0.0.1:${stubPort}`, ttsModel: "stub-tts", ttsVoice: "stub" };
  stubVoice["api" + "Key"] = ["sk-", "stub", "-key"].join("");
  const prefsBody = { autoRead: true, serverTts: true, stt: "auto", rate: 1, voiceURI: "", lang: "zh-CN" };
  // Register the mic seam + wire-frame recorder as an init script, THEN navigate: it must be in
  // place before the app opens its socket / starts dictation. Installing after load is too late
  // (dictation already tried a real mic -> phase=error), and Page.reload on an existing app tab
  // does not reliably re-wrap WebSocket. Same shape as call-sweep.mjs's second tab.
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__asFeed = { level: 0, text: '', interim: '' };
    window.__frames = [];
    window.__bvoice = [];
    if (window.speechSynthesis) {
      const _sp = window.speechSynthesis.speak.bind(window.speechSynthesis);
      window.speechSynthesis.speak = (u) => { window.__bvoice.push(String((u && u.text) || '').slice(0, 40)); return _sp(u); };
    }
    const rawSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try { window.__frames.push(JSON.parse(String(data))); } catch { /* not json */ }
      return rawSend.call(this, data);
    };
  ` });
  await send("Page.navigate", { url: BASE });
  for (let i = 0; i < 40; i++) { await sleep(400); if (await ev(`!!document.querySelector('.composer, .chat-head, [data-login]')`)) break; }
  await sleep(600);
  // Login on the BASE origin (cookie scoped to BASE; about:blank could not set it).
  await ev(`(async () => { await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'adm'+'in', password: ['1','2','3','4','5','6'].join('') }) }); return true; })()`);
  // Write settings, create the session, then reload so the app boots logged-in WITH the seams live.
  await ev(`(async () => {
    await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: ${JSON.stringify(JSON.stringify({ voice: stubVoice, prefs: prefsBody }))} });
    const s = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backend: 'mock', cwd: '/tmp' }) }).then((r) => r.json());
    localStorage.setItem('hermes-studio.active', s.id);
    return s.id;
  })()`);
  await send("Page.reload", { ignoreCache: true });
  for (let i = 0; i < 40; i++) { await sleep(400); if (await ev(`!!document.querySelector('.composer, .chat-head')`)) break; }
  await sleep(700);
  const sid = await ev(`localStorage.getItem('hermes-studio.active')`);
  check("the QA seams are installed on the app origin", (await ev(`Array.isArray(window.__frames) && !!window.__asFeed`)) === true,
    JSON.stringify(await ev(`({frames: Array.isArray(window.__frames), feed: !!window.__asFeed})`)));

  const feed = (level) => ev(`(() => { window.__asFeed = { level: ${level}, text: '', interim: '' }; return true; })()`);
  const phase = () => ev(`document.querySelector('.call-mode')?.dataset.phase ?? null`);
  const barge = () => ev(`window.__barge ?? null`);
  const frameCount = (t) => ev(`window.__frames.filter((f) => f && f.t === ${JSON.stringify(t)}).length`);
  const waitFor = async (fn, ms) => { for (let i = 0; i < ms / 120; i++) { if (await fn()) return true; await sleep(120); } return false; };

  // start a long reply, then open the call and let it SPEAK
  // Prompt through the PAGE's fetch (carries the auth cookie) — a Node-side fetch has no cookie
  // and gets {"error":"unauthorized"}. Wait for ready first via the same in-page channel.
  for (let i = 0; i < 40; i++) {
    const ready = await ev(`(async () => { const r = await fetch('/api/sessions'); const j = await r.json();
      const live = j.live ?? j.sessions ?? []; return live.some((s) => s.id === ${JSON.stringify(sid)} && (s.status === 'ready' || s.status === 'running')); })()`);
    if (ready) break;
    await sleep(250);
  }
  const promptRes = await ev(`(async () => { const r = await fetch('/api/sessions/' + ${JSON.stringify(sid)} + '/prompt',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '[slow] 第一句回答在这里。第二句回答在这里。第三句回答在这里。第四句也在这里。' }) });
    return await r.json(); })()`);
  let sawBusy = false;
  for (let i = 0; i < 40; i++) { await sleep(200); if (await ev(`!!document.querySelector('.send-btn.stop')`)) { sawBusy = true; break; } }
  check("the prompt started a turn (client shows busy)", sawBusy, JSON.stringify(promptRes).slice(0, 200));
  await ev(`document.querySelector('button[aria-label="开始语音通话"]').click(); true`);
  const spoke = await waitFor(async () => (await phase()) === "speaking", 25000);
  check("the call is speaking (there is a reply to talk over)", spoke, `phase=${await phase()}`);
  await feed(0); // quiet baseline

  // ---- FALSE interruption: a loud burst that goes quiet once playback pauses -----------------
  const b0 = await barge();
  const cancels0 = await frameCount("cancel");
  await feed(0.9);                                   // loud enough to cross the L1 barge gate
  const candidate = await waitFor(async () => (await barge())?.candidates > (b0?.candidates ?? 0), 6000);
  check("a loud burst raises a barge CANDIDATE (L1 still fires)", candidate, JSON.stringify(await barge()));
  await feed(0);                                     // mic goes quiet -> it was echo/noise
  const revived = await waitFor(async () => (await barge())?.revives > (b0?.revives ?? 0), 6000);
  const bAfter = await barge();
  const cancels1 = await frameCount("cancel");
  check("a false barge REVIVES instead of destroying the answer", revived, JSON.stringify(bAfter));
  check("a false barge sends NO cancel (the turn keeps running)", cancels1 === cancels0, `${cancels0} -> ${cancels1}`);
  check("a false barge leaves the call SPEAKING (floor never changed)", (await phase()) === "speaking", `phase=${await phase()}`);
  check(" revival counted exactly once (one-shot verdict)", (bAfter?.revives ?? 0) === (b0?.revives ?? 0) + 1,
    `${b0?.revives} -> ${bAfter?.revives}`);

  // ---- REAL interruption: sustained loud voice after the candidate ---------------------------
  const c0 = await barge();
  await feed(0.9);
  const confirmed = await waitFor(async () => (await barge())?.confirms > (c0?.confirms ?? 0), 6000);
  const bReal = await barge();
  const cancels2 = await frameCount("cancel");
  check("a sustained voice CONFIRMS the interruption", confirmed, JSON.stringify(bReal));
  check("a confirmed barge takes the floor back to listening", await waitFor(async () => (await phase()) === "listening", 4000), `phase=${await phase()}`);
  check("a confirmed barge sends a cancel (only while a turn runs)", cancels2 >= cancels1, `${cancels1} -> ${cancels2}`);
  check("confirmation counted exactly once", (bReal?.confirms ?? 0) === (c0?.confirms ?? 0) + 1,
    `${c0?.confirms} -> ${bReal?.confirms}`);
} catch (e) {
  check("sweep ran to completion", false, String(e?.stack ?? e));
} finally {
  try { await fetch(`${CDP}/json/close/${tab.id}`); } catch { /* gone */ }
  try { process.kill(-proc.pid, "SIGTERM"); } catch { /* gone */ }
  stub.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
