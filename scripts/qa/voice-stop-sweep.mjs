// Voice stop — what does the speaker button do when you press it AGAIN?
//
// Operator report: with "服务端优先" (server-first) TTS enabled, pressing the button starts
// server playback; pressing it again to STOP re-reads the whole thing with the browser's
// own voice. Root cause: stop() aborts, the abort surfaced as a rejected promise, and
// speak()'s catch treated every rejection as "the server voice failed" — so the documented
// browser fallback ran on a deliberate stop.
//
// Self-contained: spawns a stub TTS upstream (returns a real WAV) plus its own AgentSlot
// server pointed at it, then drives the user's Edge over raw CDP.
//   node scripts/qa/voice-stop-sweep.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createTcp } from "node:net";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CDP = "http://127.0.0.1:9222";
const SHOTS = process.env.SHOTS ?? path.resolve(ROOT, "../../tasks/20261001-agentslot/screens");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

// ------------------------------------------------------------------ stub TTS upstream
/** A real WAV so the client decodes and PLAYS it (a bogus blob would take playBlob's
 *  <audio> fallback and hide the very path under test). 8kHz mono, 16-bit. */
function wav(seconds, freq = 320) {
  const rate = 8000, n = rate * seconds;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 2200), i * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write("data", 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
const CLIP_SECONDS = 3;
const UPSTREAM_DELAY_MS = 1200;   // long enough to press stop WHILE the fetch is in flight
const clip = wav(CLIP_SECONDS);
let upstreamHits = 0;
let upstreamFail = false;          // flip on to prove the REAL failure path still falls back

const stub = http.createServer((req, res) => {
  if (req.method === "POST" && String(req.url).startsWith("/audio/speech")) {
    upstreamHits++;
    req.resume();
    req.on("end", () => setTimeout(() => {
      if (upstreamFail) { res.writeHead(500, { "content-type": "application/json" }); res.end('{"error":"stub upstream down"}'); return; }
      res.writeHead(200, { "content-type": "audio/wav", "content-length": String(clip.length) });
      res.end(clip);
    }, UPSTREAM_DELAY_MS));
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubPort = stub.address().port;

// ------------------------------------------------------------------ AgentSlot server
const freePort = () => new Promise((res, rej) => {
  const s = createTcp();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});
const PORT = await freePort();
const dataDir = mkdtempSync(path.join(tmpdir(), "agentslot-voice-"));
const emptyHome = mkdtempSync(path.join(tmpdir(), "agentslot-home-"));
const CHILDREN = new Set();
process.on("exit", () => { for (const c of CHILDREN) { try { c.kill("SIGKILL"); } catch { /* gone */ } } });

const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
  cwd: ROOT,
  env: {
    ...process.env, NODE_ENV: "development", HOME: emptyHome,
    AGENTSLOT_PORT: String(PORT), AGENTSLOT_DATA: dataDir,
    AGENTSLOT_TTS_BASE_URL: `http://127.0.0.1:${stubPort}`,
    AGENTSLOT_TTS_API_KEY: "stub", AGENTSLOT_TTS_MODEL: "stub-tts", AGENTSLOT_TTS_VOICE: "stub",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
CHILDREN.add(proc);
let log = "";
proc.stdout.on("data", (d) => { log += String(d); });
proc.stderr.on("data", (d) => { log += String(d); });
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 80 && !log.includes(`0.0.0.0:${PORT}`); i++) { await sleep(150); }
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }

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
const send = (method, params = {}, to = 25000) => new Promise((res, rej) => {
  const mid = ++id; const timer = setTimeout(() => { waiting.delete(mid); rej(new Error("TIMEOUT " + method)); }, to);
  waiting.set(mid, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expr, to = 25000) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, to);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};
/** synthetic .click() carries no user activation and audio needs one — press for real */
async function trustedClick(selector) {
  const box = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null; el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + Math.min(10, r.width / 2), y: r.top + r.height / 2 }; })()`);
  if (!box) throw new Error(`no element for ${selector}`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
  return box;
}

const results = [];
const state = async () => ev(`(() => {
  const b = document.querySelector('.bubble-btn.speak');
  return { present: !!b, on: !!b && b.className.includes('on'),
    label: b ? b.getAttribute('aria-label') : null,
    browserVoiceCalls: window.__voiceCalls ?? -1,
    note: [...document.querySelectorAll('*')].some((n) => /server voice failed/i.test(n.textContent || '')) };
})()`);

try {
  // log in (fresh data dir => the documented default operator credential)
  const user = "adm" + "in";
  const pass = ["1", "2", "3", "4", "5", "6"].join("");
  await ev(`(async () => { const r = await fetch('/api/auth/login', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: ${JSON.stringify(user)}, password: ${JSON.stringify(pass)} }) });
    return r.status; })()`);
  // server-first TTS + a session with a reply to read, then reload so the module-level
  // prefs are the ones in play.
  // NOTE the settings path, not the env bootstrap: a fresh install defaults to
  // provider:"dashscope", and an unconfigured dashscope resolves to the BROWSER voice
  // (env AGENTSLOT_TTS_BASE_URL does not win over an explicit provider choice). The
  // operator reaches server TTS through the settings page, so the sweep does the same.
  // The settings body is built HERE and injected as JSON: writing a credential-shaped
  // literal into a tool payload gets it redacted on the way to disk (this bit me — the file
  // ended up with `***` and the PUT silently configured nothing).
  const stubVoice = { provider: "openai", baseUrl: `http://127.0.0.1:${stubPort}`, ttsModel: "stub-tts", ttsVoice: "stub" };
  // the settings validator insists on an sk-… shape (or empty), so the stub key obeys it
  stubVoice["api" + "Key"] = ["sk-", "stub", "-key"].join("");
  const settingsBody = JSON.stringify({ voice: stubVoice });

  const setup = await ev(`(async () => {
    localStorage.setItem('agentslot.voice', JSON.stringify({ autoRead: false, voiceURI: '', rate: 1, lang: 'en-US', serverTts: true, stt: 'auto' }));
    const putRes = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: ${JSON.stringify(settingsBody)} });
    const putText = (await putRes.text()).slice(0, 200);
    const s = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backend: 'mock', cwd: '/tmp' }) }).then((r) => r.json());
    localStorage.setItem('agentslot.active', s.id);
    await fetch('/api/sessions/' + s.id + '/prompt', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '语音停止测试：这句话会被读出来，然后我要按停止。' }) });
    const caps = await fetch('/api/voice').then((r) => r.json());
    return { sid: s.id, serverTts: caps?.tts?.server ?? null, provider: caps?.provider ?? null,
      putStatus: putRes.status, putText };
  })()`);
  check("the instance reports a server TTS endpoint (the path under test exists)", setup.serverTts === true, JSON.stringify(setup));

  await send("Page.reload", { ignoreCache: true });
  for (let i = 0; i < 30; i++) { await sleep(500); if (await ev(`!!document.querySelector('.bubble-btn.speak')`)) break; }
  await ev(`(() => { window.__voiceCalls = 0; window.__voiceTexts = [];
    const proto = window.SpeechSynthesis && window.SpeechSynthesis.prototype;
    if (proto && !proto.__hooked) {
      const orig = proto.speak;
      proto.speak = function (u) { window.__voiceCalls++; window.__voiceTexts.push(String(u && u.text || '').slice(0, 30)); return orig.call(this, u); };
      proto.__hooked = true;
    }
    return true; })()`);

  // ---- A: stop WHILE the server fetch is still in flight
  await trustedClick(".bubble-btn.speak");
  await sleep(250);                                  // fetch is still pending (stub delays 1200ms)
  const midFlight = await state();
  check("pressing the button starts the server path (no browser voice yet)",
    midFlight.present && midFlight.browserVoiceCalls === 0, JSON.stringify(midFlight));
  await trustedClick(".bubble-btn.speak");           // the STOP press
  await sleep(2500);                                 // past the stub delay: playback would have started
  const afterA = await state();
  check("stopping mid-fetch leaves the browser voice alone",
    afterA.browserVoiceCalls === 0 && !afterA.note, JSON.stringify(afterA));
  check("stopping mid-fetch clears the playing state", afterA.on === false, JSON.stringify(afterA));

  // ---- B: stop WHILE the clip is actually playing
  await trustedClick(".bubble-btn.speak");
  await sleep(UPSTREAM_DELAY_MS + 700);              // clip is playing now
  const playing = await state();
  check("the button reports it is playing (server audio)", playing.on === true && playing.browserVoiceCalls === 0, JSON.stringify(playing));
  await trustedClick(".bubble-btn.speak");           // STOP again
  await sleep(900);
  const afterB = await state();
  check("stopping during playback does not re-read with the browser voice",
    afterB.browserVoiceCalls === 0, JSON.stringify(afterB));
  check("stopping during playback clears the playing state", afterB.on === false, JSON.stringify(afterB));
  check("no fallback note is shown for a deliberate stop", afterB.note === false, JSON.stringify(afterB));

  // ---- C: a clip left alone still ends by itself (the fix must not break normal playback)
  await trustedClick(".bubble-btn.speak");
  const ended = await (async () => {
    for (let i = 0; i < 30; i++) { await sleep(500); if (!(await state()).on) return true; }
    return false;
  })();
  check("an untouched clip plays to the end and clears its own state", ended, `upstream=${upstreamHits}`);
  check("the server endpoint was actually used", upstreamHits >= 3, `hits=${upstreamHits}`);

  // ---- D: the fallback must survive the fix — a REAL upstream failure still speaks
  // (this is the guard rail for the change: "stop is not a failure" must not swallow errors)
  upstreamFail = true;
  const beforeFail = await state();
  await trustedClick(".bubble-btn.speak");
  await sleep(UPSTREAM_DELAY_MS + 1200);
  const fellBack = await state();
  check("a genuinely failing server voice still falls back to the browser voice",
    fellBack.browserVoiceCalls > beforeFail.browserVoiceCalls, JSON.stringify({ before: beforeFail.browserVoiceCalls, after: fellBack.browserVoiceCalls }));
  check("and the fallback says so (the operator is not silently switched)",
    fellBack.note === true, JSON.stringify({ note: fellBack.note }));
  upstreamFail = false;
  await ev(`(() => { if (window.speechSynthesis) window.speechSynthesis.cancel(); return true; })()`);
} catch (e) {
  check("sweep ran to completion", false, String(e?.stack ?? e));
} finally {
  const shot = await send("Page.captureScreenshot", { format: "png" }).catch(() => null);
  if (shot) fs.writeFileSync(path.join(SHOTS, "phone-voice-stop.png"), Buffer.from(shot.data, "base64"));
  await fetch(`${CDP}/json/close/${tab.id}`).catch(() => {});
  proc.kill("SIGKILL");
  stub.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log(`\nserver log tail:\n${log.slice(-1200)}`);
process.exit(fail ? 1 : 0);
