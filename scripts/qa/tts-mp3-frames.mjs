// Does the upstream mp3 stream arrive as clean frames, and can the browser decode
// frame-aligned slices gaplessly? This decides PCM-vs-mp3 for the streaming path.
//   node scripts/qa/tts-mp3-frames.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const env = {};
for (const line of fs.readFileSync(path.join(os.homedir(), ".hermes", ".env"), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
const key = env.DASHSCOPE_API_KEY;
const root = env.DASHSCOPE_BASE_URL.replace(/\/+$/, "").split("/compatible-mode")[0].replace(/\/+$/, "");
const wsUrl = root.replace(/^http/, "ws") + "/api-ws/v1/inference";

const TEXT = "能。这是流式合成的第一句。第二句要长一些，用来观察字节流的形状。第三句收尾。";
const OUT = path.resolve("scripts/qa/.tmp-tts");
fs.mkdirSync(OUT, { recursive: true });

function collect(bitrate) {
  return new Promise((resolve) => {
    const socket = new WebSocket(wsUrl, { headers: { authorization: "bearer " + key } });
    const taskId = "m-" + Math.random().toString(36).slice(2, 8);
    const parts = [];
    const arrivals = [];
    socket.on("open", () => socket.send(JSON.stringify({
      header: { action: "run-task", task_id: taskId, streaming: "duplex" },
      payload: { task_group: "audio", task: "tts", function: "SpeechSynthesizer", model: "qwen-audio-3.0-tts-flash",
        parameters: { text_type: "PlainText", voice: "longanhuan_v3.6", format: "mp3", sample_rate: 22050, bit_rate: bitrate }, input: {} },
    })));
    socket.on("message", (raw, isBinary) => {
      if (isBinary) { const b = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); arrivals.push(b.length); parts.push(b); return; }
      let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg?.header?.event === "task-started") {
        for (const s of TEXT.split(/(?<=。)/).filter(Boolean)) {
          socket.send(JSON.stringify({ header: { action: "continue-task", task_id: taskId, streaming: "duplex" }, payload: { input: { text: s } } }));
        }
        socket.send(JSON.stringify({ header: { action: "finish-task", task_id: taskId, streaming: "duplex" }, payload: { input: {} } }));
      }
      if (msg?.header?.event === "task-finished" || msg?.header?.event === "task-failed") {
        try { socket.close(); } catch {}
        resolve({ bytes: Buffer.concat(parts), arrivals });
      }
    });
    socket.on("error", () => resolve({ bytes: Buffer.alloc(0), arrivals }));
  });
}

/** Walk mp3 frames: optional ID3v2, then 0xFFEx sync + MPEG1/2 layer III frame length. */
function analyse(buf) {
  const out = { id3: 0, frames: [], trailing: 0, desyncAt: null, bitrates: new Set(), rates: new Set(), versions: new Set(), layers: new Set() };
  let at = 0;
  if (buf.subarray(0, 3).toString("latin1") === "ID3") {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    out.id3 = 10 + size + (buf[5] & 0x10 ? 10 : 0);
    at = out.id3;
  }
  const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  const KBPS_V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const KBPS_V2L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  while (at + 4 <= buf.length) {
    if (buf[at] !== 0xff || (buf[at + 1] & 0xe0) !== 0xe0) { if (out.desyncAt === null) out.desyncAt = at; break; }
    const verBits = (buf[at + 1] >> 3) & 3;          // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layerBits = (buf[at + 1] >> 1) & 3;        // 1 = layer III
    const brIdx = (buf[at + 2] >> 4) & 0xf;
    const srIdx = (buf[at + 2] >> 2) & 3;
    const pad = (buf[at + 2] >> 1) & 1;
    const v1 = verBits === 3;
    const rate = RATES[verBits]?.[srIdx];
    const kbps = (v1 ? KBPS_V1L3 : KBPS_V2L3)[brIdx];
    if (!rate || !kbps) { if (out.desyncAt === null) out.desyncAt = at; break; }
    const len = Math.floor(((v1 ? 144000 : 72000) * kbps) / rate) + pad;
    if (at + len > buf.length) { out.trailing = buf.length - at; break; }
    out.frames.push({ at, len });
    out.bitrates.add(kbps); out.rates.add(rate); out.versions.add(verBits); out.layers.add(layerBits);
    at += len;
  }
  return out;
}

for (const bitrate of [32, 48]) {
  const { bytes, arrivals } = await collect(bitrate);
  const a = analyse(bytes);
  console.log(`\n=== bit_rate=${bitrate} ===`);
  console.log("total bytes:", bytes.length, " first-3:", [...bytes.subarray(0, 3)].map((b) => b.toString(16)).join(" "));
  console.log("id3 header bytes:", a.id3, " frames:", a.frames.length, " trailing partial:", a.trailing, " desyncAt:", a.desyncAt);
  console.log("versions:", [...a.versions], "layers:", [...a.layers], "rates:", [...a.rates], "bitrates:", [...a.bitrates]);
  console.log("declared lengths sum:", a.frames.reduce((s, f) => s + f.len, 0) + a.id3 + a.trailing, "vs", bytes.length);
  console.log("arrival sizes:", JSON.stringify(arrivals));
  const frameLens = new Set(a.frames.map((f) => f.len));
  console.log("distinct frame lengths:", [...frameLens].join(","));
  if (bitrate === 32) fs.writeFileSync(path.join(OUT, "sample.mp3"), bytes);
  // where do the first 8 frame boundaries sit inside the first arrival?
  console.log("first 6 frames:", JSON.stringify(a.frames.slice(0, 6).map((f) => [f.at, f.len])));
}
console.log("\nwrote", path.join(OUT, "sample.mp3"));
