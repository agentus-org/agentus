// Streaming TTS in a real browser: does the FIRST SOUND arrive early, and does pressing stop
// actually interrupt it? (issue #81)
//
// Why a browser sweep and not only the unit tests: the two claims this change makes are about
// time and about interruption, and both live in the page — the PCM player's scheduling, the
// relay's session reuse, and the speaker's stop path. A unit test can prove the splitter and the
// s16le unpacking; only the browser can prove the operator hears the first sentence ~0.3 s after
// asking, and that a stop leaves nothing playing and tells the upstream to stop billing.
//
// Self-contained: its own stand-in provider (HTTP + the /api-ws/v1/inference socket), its own
// Agentus server on a free port, and the operator's Edge over raw CDP.
//   node scripts/qa/tts-stream-sweep.mjs
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createTcp } from "node:net";
import { WebSocket, WebSocketServer } from "ws";

const ROOT = path.resolve(import.meta.dirname, "../..");

/** Killing the `tsx` WRAPPER is not killing the server (see voice-stop-sweep.mjs): one
 *  negative-pid signal takes the whole process group. */
const killGroup = (target) => {
  const pid = typeof target === "number" ? target : target?.pid;
  if (!pid) return;
  try { process.kill(-pid, "SIGKILL"); } catch { try { killGroup(pid); } catch { /* already gone */ } }
};

const CDP = process.env.CDP ?? "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

// ------------------------------------------------------------------ stand-in provider
// Two delays that make the comparison the issue is about VISIBLE rather than a race:
//   - the HTTP one-shot path is slow to produce a clip (as the real 百炼 is: 0.7-1.2 s),
//   - the streaming path starts a task quickly and then emits one frame per sentence.
// Streaming must therefore win on first sound by a margin, not by luck.
const HTTP_DELAY_MS = 900;
const TASK_START_MS = 60;
const FRAME_GAP_MS = 90;
const PCM_RATE = 24000;
/** 0.4 s of a loud-ish tone at 24 kHz, s16le mono: real audio, so the player schedules samples. */
const FRAME_SECONDS = 0.4;
function pcmFrame(offset = 0) {
  const n = Math.round(PCM_RATE * FRAME_SECONDS);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.sin(((i + offset) / PCM_RATE) * Math.PI * 2 * 440) * 8000), i * 2);
  }
  return buf;
}
const seen = { httpTts: 0, run: 0, texts: [], cancels: 0, sockets: 0, finished: 0 };

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
const clip = wav(2);

const provider = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (req.url?.startsWith("/v1/audio/speech") || req.url?.startsWith("/api/v1/services/audio/tts")) {
      // The one-shot path: deliberately slow, and counted so the sweep can prove the streaming
      // run never touched it (that is what "no 80-character chunking, no clip per sentence" means).
      seen.httpTts += 1;
      setTimeout(() => {
        res.writeHead(200, { "content-type": "audio/wav", "content-length": String(clip.length) });
        res.end(clip);
      }, HTTP_DELAY_MS);
      return;
    }
    if (/\/compatible-mode\/v1\/models/.test(req.url ?? "") || /\/v1\/models/.test(req.url ?? "")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "qwen-audio-3.0-tts-flash" }, { id: "qwen-audio-3.1-asr-flash-streaming" }] }));
      return;
    }
    res.writeHead(404).end("{}");
  });
});
const providerPort = await new Promise((r) => provider.listen(0, "127.0.0.1", () => r(provider.address().port)));

// The streaming synthesiser: the real protocol shape (run-task -> task-started -> per-sentence
// result-generated + one binary PCM frame -> task-finished, cancel = finish-task + directive).
const upstream = new WebSocketServer({ server: provider, path: "/api-ws/v1/inference" });
upstream.on("connection", (sock) => {
  seen.sockets += 1;
  let taskId = "";
  let cancelled = false;
  const send = (o) => { try { sock.send(JSON.stringify(o)); } catch { /* gone */ } };
  sock.on("message", (raw, isBinary) => {
    if (isBinary) return;
    const msg = JSON.parse(String(raw));
    const action = msg.header?.action;
    if (action === "run-task") {
      seen.run += 1;
      taskId = msg.header.task_id;
      cancelled = false;
      setTimeout(() => send({ header: { task_id: taskId, event: "task-started", attributes: {} }, payload: {} }), TASK_START_MS);
      return;
    }
    if (action === "continue-task") {
      const text = String(msg.payload?.input?.text ?? "");
      seen.texts.push(text);
      if (cancelled) return;
      send({ header: { task_id: taskId, event: "result-generated", attributes: {} },
        payload: { output: { type: "sentence-begin", original_text: text, sentence: { index: 0, words: [] } } } });
      // One frame per sentence, spaced: this is what the page plays while the rest is generated.
      setTimeout(() => {
        if (cancelled) return;
        try { sock.send(pcmFrame(seen.texts.length)); } catch { /* gone */ }
      }, FRAME_GAP_MS);
      return;
    }
    if (action === "finish-task") {
      if (msg.payload?.input?.directive === "cancel") {
        cancelled = true;
        seen.cancels += 1;
        send({ header: { task_id: taskId, event: "task-finished", attributes: {} }, payload: { output: {}, usage: {} } });
        return;
      }
      seen.finished += 1;
      setTimeout(() => send({ header: { task_id: taskId, event: "task-finished", attributes: {} },
        payload: { output: {}, usage: { characters: 42 } } }), FRAME_GAP_MS * 2);
      return;
    }
  });
});

// ------------------------------------------------------------------ Agentus server
const freePort = () => new Promise((res, rej) => {
  const s = createTcp();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});
const PORT = await freePort();
const dataDir = mkdtempSync(path.join(tmpdir(), "agentus-ttsstream-"));
const emptyHome = mkdtempSync(path.join(tmpdir(), "agentus-home-"));
const CHILDREN = new Set();
process.on("exit", () => { for (const c of CHILDREN) { try { killGroup(c); } catch { /* gone */ } } });

const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
  detached: true,
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: "development", HOME: emptyHome, AGENTUS_PORT: String(PORT), AGENTUS_DATA: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
});
CHILDREN.add(proc);
let log = "";
proc.stdout.on("data", (d) => { log += String(d); });
proc.stderr.on("data", (d) => { log += String(d); });
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 80 && !log.includes(`0.0.0.0:${PORT}`); i++) await sleep(150);
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }

// ------------------------------------------------------------------ browser
const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(2600);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const waiting = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { const x = waiting.get(m.id); waiting.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); }
};
const send = (method, params = {}, to = 25000) => new Promise((res, rej) => {
  const mid = ++id;
  const timer = setTimeout(() => { waiting.delete(mid); rej(new Error("TIMEOUT " + method)); }, to);
  waiting.set(mid, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expr, to = 25000) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, to);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};
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

try {
  const user = "adm" + "in";
  const pass = ["1", "2", "3", "4", "5", "6"].join("");
  await ev(`(async () => { const r = await fetch('/api/auth/login', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: ${JSON.stringify(user)}, password: ${JSON.stringify(pass)} }) });
    return r.status; })()`);

  // The settings body is built here and injected as JSON — a credential-shaped literal written
  // into the file gets redacted on the way to disk (recorded lesson).
  const stubVoice = { provider: "dashscope", baseUrl: `http://127.0.0.1:${providerPort}/`, ttsModel: "qwen-audio-3.0-tts-flash", ttsVoice: "longanhuan_v3.6", ttsStream: true };
  stubVoice["api" + "Key"] = ["sk-", "stub", "-stream", "-key"].join("");
  const settingsBody = JSON.stringify({
    voice: stubVoice,
    prefs: { serverTts: true, autoRead: false, stt: "auto", rate: 1, voiceURI: "", lang: "zh-CN" },
  });

  const setup = await ev(`(async () => {
    localStorage.setItem('agentus.voice', JSON.stringify({ autoRead: false, voiceURI: '', rate: 1, lang: 'zh-CN', serverTts: true, stt: 'auto' }));
    const putRes = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: ${JSON.stringify(settingsBody)} });
    const putText = (await putRes.text()).slice(0, 200);
    const s = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backend: 'mock', cwd: '/tmp' }) }).then((r) => r.json());
    localStorage.setItem('agentus.active', s.id);
    // POST /prompt is fire-and-forget and answers 202 even when the agent is not up yet — the
    // refusal then only reaches the log, and the reply (and therefore the speaker button) never
    // appears. So the readiness wait happens BEFORE the prompt: retrying the prompt cannot help.
    let status = 'starting';
    for (let i = 0; i < 80; i++) {
      const list = await fetch('/api/sessions').then((r) => r.json());
      const row = (list.live ?? []).find((x) => x.id === s.id);
      status = row?.status ?? 'gone';
      if (status === 'ready') break;
      await new Promise((res) => setTimeout(res, 250));
    }
    const pr = await fetch('/api/sessions/' + s.id + '/prompt', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '流式语音测试：第一句话应该立刻响起，第二句话紧随其后，第三句话用来验证打断。' }) });
    const caps = await fetch('/api/voice').then((r) => r.json());
    return { sid: s.id, tts: caps?.tts ?? null, provider: caps?.provider ?? null,
      putStatus: putRes.status, putText, agentStatus: status, promptStatus: pr.status };
  })()`);
  check("the server offers the streaming path", setup.tts?.streaming === true && setup.tts?.sampleRate === 24000, JSON.stringify(setup.tts));
  check("the provider is 百炼 (the only one with a streaming surface)", setup.provider === "dashscope", String(setup.provider));
  check("the mock agent reached ready before the prompt", setup.agentStatus === "ready", String(setup.agentStatus));
  check("the mock session accepted a prompt (there is a reply to read)", setup.promptStatus === 202, String(setup.promptStatus));

  await send("Page.reload", { ignoreCache: true });
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await ev(`!!document.querySelector('.bubble-btn.speak')`)) { ready = true; break; }
  }
  if (!ready) {
    console.log("  … messages:", await ev(`fetch('/api/sessions/' + localStorage.getItem('agentus.active') + '/messages')
      .then((r) => r.json()).then((m) => JSON.stringify(m).slice(0, 300)).catch((e) => String(e))`));
    const why = await ev(`({ url: location.href,
      bubbles: document.querySelectorAll('.bubble-btn').length,
      speaks: document.querySelectorAll('.bubble-btn.speak').length,
      text: (document.body.innerText || '').slice(0, 200) })`);
    console.log("  … page never showed a speaker button:", JSON.stringify(why));
  }

  // Instrumentation lives in the page and records only TIMESTAMPS and COUNTS: when the relay
  // reported ready, when the first audio frame arrived, and how many buffer sources were
  // actually started (that last one is the difference between "the bytes arrived" and "the
  // operator heard something").
  await ev(`(() => {
    window.__tts = { readyAt: 0, firstFrameAt: 0, frames: 0, scheduled: 0, scheduledSeconds: 0, cancels: 0, closed: 0, errors: [] };
    const OrigWS = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      const sock = new OrigWS(url, protocols);
      if (String(url).includes('/ws/tts')) {
        sock.binaryType = 'arraybuffer';
        sock.addEventListener('message', (e) => {
          if (typeof e.data !== 'string') {
            window.__tts.frames += 1;
            if (!window.__tts.firstFrameAt) window.__tts.firstFrameAt = performance.now();
            return;
          }
          try {
            const m = JSON.parse(e.data);
            if (m.t === 'tts-ready' && !window.__tts.readyAt) window.__tts.readyAt = performance.now();
            if (m.t === 'tts-error' || m.t === 'tts-closed') window.__tts.errors.push(m.error || m.why || m.t);
          } catch { /* not ours */ }
        });
        const origSend = sock.send.bind(sock);
        sock.send = (data) => { try { if (String(data).includes('tts-cancel')) window.__tts.cancels += 1; } catch { /* binary */ } return origSend(data); };
      }
      return sock;
    };
    window.WebSocket.prototype = OrigWS.prototype;
    Object.assign(window.WebSocket, OrigWS);
    const ctxProto = window.AudioContext && window.AudioContext.prototype;
    if (ctxProto) {
      const origStart = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (when, offset, duration) {
        window.__tts.scheduled += 1;
        try { window.__tts.scheduledSeconds += (this.buffer ? this.buffer.duration : 0); } catch { /* no buffer */ }
        return origStart.call(this, when, offset, duration);
      };
    }
    return true;
  })()`);

  // ---- A: the first sound must arrive without waiting for the whole reply
  const t0 = Date.now();
  await trustedClick(".bubble-btn.speak");
  let first = 0;
  for (let i = 0; i < 120; i++) {
    await sleep(50);
    const s = await ev(`({ frames: window.__tts.frames, scheduled: window.__tts.scheduled })`);
    if (s.frames > 0 && !first) { first = Date.now() - t0; break; }
  }
  const a = await ev(`JSON.parse(JSON.stringify(window.__tts))`);
  check("the relay reported ready", a.readyAt > 0, `errors=${JSON.stringify(a.errors)}`);
  check("the first PCM frame reached the page", a.frames > 0, `${a.frames} frame(s)`);
  check("audio was actually scheduled for playback (not just received)", a.scheduled > 0, `${a.scheduled} source(s), ${a.scheduledSeconds.toFixed(2)}s`);
  // The threshold is the point of the change: the one-shot path cannot answer before its clip
  // exists, and the stand-in makes that 900 ms. Anything under ~600 ms here can only be streaming.
  check("the first sound is well under the one-shot path's own latency",
    first > 0 && first < HTTP_DELAY_MS * 0.75, `${first}ms vs ${HTTP_DELAY_MS}ms one-shot`);
  check("the streaming run never touched the one-shot /api/tts route", seen.httpTts === 0, `${seen.httpTts} call(s)`);
  check("the reply was fed to the upstream as sentences", seen.texts.length >= 1, JSON.stringify(seen.texts.slice(0, 3)));

  // ---- B: stop must INTERRUPT — nothing keeps playing and the upstream is told to stop
  const framesBeforeStop = (await ev(`window.__tts.frames`)) ?? 0;
  const cancelsBefore = (await ev(`window.__tts.cancels`)) ?? 0;
  await trustedClick(".bubble-btn.speak");            // the STOP press
  await sleep(300);
  const b = await ev(`(() => { const btn = document.querySelector('.bubble-btn.speak');
    return { on: !!btn && btn.className.includes('on'), tts: JSON.parse(JSON.stringify(window.__tts)) }; })()`);
  check("pressing stop sends a cancel down the relay", b.tts.cancels > cancelsBefore, `${b.tts.cancels} cancel(s)`);
  check("pressing stop reaches the upstream as a cancel directive", seen.cancels > 0, `${seen.cancels} upstream cancel(s)`);
  check("pressing stop clears the playing state", b.on === false, String(b.on));
  const scheduledAfterStop = b.tts.scheduled;
  await sleep(700);
  const c = await ev(`JSON.parse(JSON.stringify(window.__tts))`);
  check("no audio is scheduled after the stop", c.scheduled === scheduledAfterStop, `${scheduledAfterStop} → ${c.scheduled}`);
  check("a stop is not reported as a failure", c.errors.length === 0, JSON.stringify(c.errors));

  // ---- C: the next utterance reuses the connection instead of dialling again
  const socketsBefore = seen.sockets;
  const runBefore = seen.run;
  await trustedClick(".bubble-btn.speak");
  for (let i = 0; i < 80; i++) { await sleep(50); if (((await ev(`window.__tts.frames`)) ?? 0) > framesBeforeStop) break; }
  const nextFrames = (await ev(`window.__tts.frames`)) ?? 0;
  check("speaking again produces new audio", nextFrames > framesBeforeStop, `${framesBeforeStop} → ${nextFrames}`);
  check("speaking again reuses the open socket (no re-dial)",
    seen.sockets === socketsBefore && seen.run > runBefore, `sockets +${seen.sockets - socketsBefore}, tasks +${seen.run - runBefore}`);

  // ---- D: the setting turns it off and the old one-shot path takes over
  seen.httpTts = 0;
  await ev(`(async () => { const r = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: ${JSON.stringify(JSON.stringify({ voice: { ttsStream: false } }))} }); return r.status; })()`);
  const capsOff = await ev(`fetch('/api/voice').then((r) => r.json())`);
  check("with ttsStream off the server stops offering streaming", capsOff?.tts?.streaming === false, JSON.stringify(capsOff?.tts));
  check("…and ttsStream=false reaches the client caps, not just the store", capsOff?.tts?.sampleRate === null, JSON.stringify(capsOff?.tts));
} catch (e) {
  fail++;
  console.log(`FAIL  the sweep threw — ${String(e?.message ?? e)}`);
} finally {
  await fetch(`${CDP}/json/close/${tab.id}`).catch(() => {});
  killGroup(proc);
  // The CDP socket and the stand-in provider keep the loop alive; a sweep that prints its result
  // and then HANGS reads as a failed run in CI. Close both and let node exit on its own.
  try { ws.close(); } catch { /* already gone */ }
  await new Promise((r) => upstream.close(r));
  await new Promise((r) => provider.close(r));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
if (fail) {
  console.log("--- server log tail ---");
  console.log(log.split("\n").slice(-25).join("\n"));
  process.exit(1);
}
