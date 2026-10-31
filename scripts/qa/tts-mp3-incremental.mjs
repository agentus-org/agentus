// The one correctness question the mp3 streaming path rests on:
//   is decodeAudioData(prefix of N complete frames) sample-identical to the first
//   N*frameSamples of decodeAudioData(whole file)?
// If yes, the client can decode the growing buffer and schedule only the new tail —
// gapless, 12× less bandwidth than PCM, and no chunk-boundary clicks.
//   node scripts/qa/tts-mp3-incremental.mjs
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const CDP = process.env.CDP ?? "http://127.0.0.1:9223";
const FILE = path.resolve("scripts/qa/.tmp-tts/sample.mp3");
if (!fs.existsSync(FILE)) { console.log("run scripts/qa/tts-mp3-frames.mjs first"); process.exit(1); }
const mp3 = fs.readFileSync(FILE);

// frame walk (same rule as tts-mp3-frames.mjs)
const boundaries = [];
{
  let at = 0;
  if (mp3.subarray(0, 3).toString("latin1") === "ID3") {
    const size = ((mp3[6] & 0x7f) << 21) | ((mp3[7] & 0x7f) << 14) | ((mp3[8] & 0x7f) << 7) | (mp3[9] & 0x7f);
    at = 10 + size;
  }
  boundaries.push(at);              // header end = "0 complete frames"
  const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  const KBPS_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const KBPS_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  while (at + 4 <= mp3.length) {
    if (mp3[at] !== 0xff || (mp3[at + 1] & 0xe0) !== 0xe0) break;
    const v1 = ((mp3[at + 1] >> 3) & 3) === 3;
    const rate = RATES[(mp3[at + 1] >> 3) & 3]?.[(mp3[at + 2] >> 2) & 3];
    const kbps = (v1 ? KBPS_V1 : KBPS_V2)[(mp3[at + 2] >> 4) & 0xf];
    if (!rate || !kbps) break;
    const len = Math.floor(((v1 ? 144000 : 72000) * kbps) / rate) + ((mp3[at + 2] >> 1) & 1);
    if (at + len > mp3.length) break;
    at += len;
    boundaries.push(at);
  }
}
console.log(`mp3 ${mp3.length} bytes, ${boundaries.length - 1} complete frames, ${boundaries.length} prefix boundaries`);

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "audio/mpeg", "content-length": String(mp3.length) });
  res.end(mp3);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/sample.mp3`;

const tab = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
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
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};
await send("Page.enable");
// navigate TO the same origin: about:blank has an opaque origin and its fetch is blocked
await send("Page.navigate", { url: `${url}?page=1` });
await new Promise((r) => setTimeout(r, 800));

const check = (name, ok, detail = "") => console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);

const result = await ev(`(async () => {
  const url = ${JSON.stringify(url)};
  const bounds = ${JSON.stringify(boundaries)};
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const ctx = new OfflineAudioContext(1, 1024, 44100);
  const full = await ctx.decodeAudioData(bytes.slice().buffer);
  const data = full.getChannelData(0);

  // 1) every frame-aligned prefix must decode, and decode to a PREFIX of the same samples
  const out = { fullSamples: data.length, fullRate: full.sampleRate, prefixes: [], mismatches: [], longestPrefix: null };
  for (let i = 1; i < bounds.length; i++) {
    const slice = bytes.slice(0, bounds[i]).buffer;
    let buf = null;
    try { buf = await ctx.decodeAudioData(slice); } catch (e) { out.mismatches.push([i, "decode failed: " + e.message]); continue; }
    const d = buf.getChannelData(0);
    let worst = 0;
    for (let j = 0; j < d.length; j++) { const df = Math.abs(d[j] - data[j]); if (df > worst) worst = df; }
    if (i % 25 === 0 || i < 6 || i === bounds.length - 1) out.prefixes.push([i, buf.length, worst]);
    if (worst > 1e-6) out.mismatches.push([i, buf.length, worst]);
  }
  return out;
})()`);

console.log("decoded full:", result.fullSamples, "samples @", result.fullRate, "Hz =", (result.fullSamples / result.fullRate).toFixed(3), "s");
console.log("prefix samples vs full (frame, samples, maxAbsDiff):", JSON.stringify(result.prefixes));
check("every frame-aligned prefix decodes", result.mismatches.filter((m) => String(m[1]).startsWith("decode failed")).length === 0);
check("a prefix decodes to a PREFIX of the full decode (max|diff| <= 1e-6)", result.mismatches.length === 0,
  result.mismatches.length ? JSON.stringify(result.mismatches.slice(0, 5)) : "");

// 2) does scheduling successive tails reproduce the full duration with no gap?
const gap = await ev(`(async () => {
  const ctx = new AudioContext();
  if (ctx.state === "suspended") await ctx.resume();
  const bytes = new Uint8Array(await (await fetch(${JSON.stringify(url)})).arrayBuffer());
  const bounds = ${JSON.stringify(boundaries)};
  const starts = [];
  let decoded = 0, scheduledSamples = 0;
  const t0 = ctx.currentTime + 0.05;
  // emulate the streaming receive: grow the buffer in 8-frame steps, decode, schedule the new tail
  const STEP = 8;
  for (let i = STEP; i < bounds.length; i += STEP) {
    const end = bounds[Math.min(i, bounds.length - 1)];
    const buf = await ctx.decodeAudioData(bytes.slice(0, end).buffer);
    const tail = buf.getChannelData(0).slice(decoded);
    decoded = buf.length;
    if (tail.length) {
      const ab = ctx.createBuffer(1, tail.length, buf.sampleRate);
      ab.copyToChannel(tail, 0);
      const src = ctx.createBufferSource();
      src.buffer = ab; src.connect(ctx.destination);
      starts.push(ctx.currentTime);
      src.start(t0 + scheduledSamples / buf.sampleRate);
      scheduledSamples += tail.length;
    }
  }
  const out = { scheduledSamples, seconds: scheduledSamples / 22050, when: starts.slice(0, 4), state: ctx.state };
  await ctx.close();
  return out;
})()`);
console.log("tail-scheduling:", JSON.stringify(gap));
check("successive tails add up to the full sample count",
  Math.abs(gap.scheduledSamples - result.fullSamples) <= 2 * 1152,
  `${gap.scheduledSamples} vs ${result.fullSamples}`);

try { await fetch(`${CDP}/json/close/${tab.id}`); } catch { /* closed */ }
ws.close();
server.close();
