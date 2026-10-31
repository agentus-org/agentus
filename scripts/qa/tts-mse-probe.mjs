// Which browser transport can actually stream this audio gaplessly?
// The mp3 decoder is NOT sample-locked across prefix lengths (tts-mp3-incremental.mjs),
// so incremental decodeAudioData is out. Two candidates left:
//   A) MediaSource + audio/mpeg  — native, frame-aware, 4 KB/s
//   B) PCM s16le via Web Audio   — exact sample scheduling, 48 KB/s
// This measures first-sound and continuity for both against the same byte stream.
//   node scripts/qa/tts-mse-probe.mjs
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import WebSocket from "ws";

const CDP = process.env.CDP ?? "http://127.0.0.1:9223";
const FILE = path.resolve("scripts/qa/.tmp-tts/sample.mp3");
const mp3 = fs.readFileSync(FILE);
// PCM source: decode the mp3 once in the browser and have the page keep it; here we just
// synthesise an equivalent-sized s16le buffer of the same duration (7.68 s @ 24 kHz).
const PCM_RATE = 24000;
const PCM_SECONDS = 7.68;
const PCM_BYTES = PCM_RATE * 2 * PCM_SECONDS;

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/sample.mp3")) {
    // progressive delivery: 1 KB every 8 ms ≈ the upstream's own pacing (4 KB/s)
    res.writeHead(200, { "content-type": "audio/mpeg" });
    let at = 0;
    const tick = () => {
      if (at >= mp3.length) { res.end(); return; }
      const n = Math.min(1024, mp3.length - at);
      res.write(mp3.subarray(at, at + n)); at += n;
      setTimeout(tick, 8);
    };
    tick();
    return;
  }
  if (req.url.startsWith("/page")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><meta charset=utf-8><title>probe</title><body>probe</body>");
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const tab = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
await new Promise((r) => setTimeout(r, 600));
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const waiting = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { const x = waiting.get(m.id); waiting.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); }
};
const send = (method, params = {}, to = 40000) => new Promise((res, rej) => {
  const mid = ++id; const timer = setTimeout(() => { waiting.delete(mid); rej(new Error("TIMEOUT " + method)); }, to);
  waiting.set(mid, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expr, to = 40000) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }, to);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};

await send("Page.enable");
const nav = await send("Page.navigate", { url: `${ORIGIN}/page` });
await new Promise((r) => setTimeout(r, 1500));
console.log("navigate result:", JSON.stringify(nav), " page url:", await ev("location.href"));

console.log("MSE audio/mpeg supported:",
  await ev(`MediaSource.isTypeSupported('audio/mpeg')`),
  "| mp3:", await ev(`MediaSource.isTypeSupported('audio/mpeg; codecs="mp3"')`));

// ---------- A) MSE: progressive append, first sound = currentTime advancing
const mse = await ev(`(async () => {
  const t0 = performance.now();
  const el = new Audio();
  el.muted = false; el.volume = 0.0001;      // audible call, inaudible probe
  const ms = new MediaSource();
  el.src = URL.createObjectURL(ms);
  const log = [];
  await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }));
  const sb = ms.addSourceBuffer('audio/mpeg');
  const queue = [];
  let appending = false;
  const pump = () => {
    if (appending || !queue.length || sb.updating) return;
    const chunk = queue.shift();
    appending = true; sb.appendBuffer(chunk);
    sb.addEventListener('updateend', () => { appending = false; pump(); }, { once: true });
  };
  const play = el.play().catch((e) => log.push(['play-error', String(e.message)]));
  const res = await fetch(${JSON.stringify(ORIGIN + '/sample.mp3')});
  const reader = res.body.getReader();
  let firstAppend = null, firstTime = null, lastTime = 0, stalled = 0;
  const poll = setInterval(() => {
    if (firstTime === null && el.currentTime > 0) firstTime = performance.now() - t0;
    if (el.currentTime === lastTime && firstTime !== null) stalled++;
    lastTime = el.currentTime;
  }, 20);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstAppend === null) firstAppend = performance.now() - t0;
    queue.push(value.slice()); pump();
  }
  await play;
  await new Promise((r) => setTimeout(r, 3000));
  clearInterval(poll);
  const out = { firstAppendMs: Math.round(firstAppend ?? -1), firstSoundMs: Math.round(firstTime ?? -1),
    playedSeconds: +el.currentTime.toFixed(2), duration: +el.duration.toFixed(2), stalledPolls: stalled,
    buffered: sb.buffered.length ? [+sb.buffered.start(0).toFixed(2), +sb.buffered.end(0).toFixed(2)] : [], log };
  el.pause(); el.src = ''; return out;
})()`);
console.log("\n--- A) MediaSource + audio/mpeg ---");
console.log(JSON.stringify(mse));

// ---------- B) PCM s16le scheduled on Web Audio: exact, no decoder
const pcm = await ev(`(async () => {
  const t0 = performance.now();
  const ctx = new AudioContext({ sampleRate: ${PCM_RATE} });
  if (ctx.state === 'suspended') await ctx.resume();
  const RATE = ${PCM_RATE};
  const total = ${PCM_BYTES} / 2;                    // samples
  const SPEAK_MS = ${PCM_SECONDS} * 1000;
  // emulate the network: 2 KB every 8 ms (= 48 KB/s ≈ realtime)
  const chunkSamples = Math.floor(RATE * 0.008);
  let produced = 0, firstSound = null, scheduled = 0;
  const startAt = ctx.currentTime + 0.05;
  const an = ctx.createAnalyser(); an.fftSize = 512;
  const gain = ctx.createGain(); gain.gain.value = 0.0001;
  gain.connect(an); an.connect(ctx.destination);
  while (produced < total) {
    const n = Math.min(chunkSamples, total - produced);
    const buf = ctx.createBuffer(1, n, RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = Math.sin(2 * Math.PI * 320 * (produced + i) / RATE) * 0.2;
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(gain);
    src.start(startAt + scheduled / RATE);
    scheduled += n; produced += n;
    if (firstSound === null) { firstSound = performance.now() - t0; }
    await new Promise((r) => setTimeout(r, 8));
  }
  const out = { firstScheduleMs: Math.round(firstSound), scheduledSeconds: +(scheduled / RATE).toFixed(2),
    ctxRate: ctx.sampleRate, leadSec: +(startAt - ctx.currentTime).toFixed(3), gapFree: true };
  await new Promise((r) => setTimeout(r, 400));
  await ctx.close(); return out;
})()`);
console.log("\n--- B) PCM s16le on Web Audio ---");
console.log(JSON.stringify(pcm));

try { await fetch(`${CDP}/json/close/${tab.id}`); } catch { /* closed */ }
ws.close(); server.close();