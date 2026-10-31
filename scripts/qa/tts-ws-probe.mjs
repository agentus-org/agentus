// Probe the real DashScope TTS WebSocket: event shapes, binary frame size, first-byte latency.
// Reads credentials from ~/.hermes/.env at runtime; prints NOTHING secret.
//   node scripts/qa/tts-ws-probe.mjs
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
const base = env.DASHSCOPE_BASE_URL;
if (!key || !base) { console.log("no creds"); process.exit(1); }
const root = base.split("/compatible-mode")[0].replace(/\/+$/, "");
const wsUrl = root.replace(/^http/, "ws") + "/api-ws/v1/inference";
console.log("ws:", wsUrl, " key:", key.slice(0, 3) + "…(" + key.length + " chars)");

const TEXT = process.env.PROBE_TEXT ?? "能。这是流式合成的第一句，用于测量首包延迟。";

async function run(format, sampleRate) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const marks = [];
    let audioBytes = 0;
    const frames = [];
    const events = [];
    const taskId = "probe-" + Math.random().toString(36).slice(2, 10);
    const socket = new WebSocket(wsUrl, { headers: { authorization: "bearer " + key } });
    let started = 0;
    const timer = setTimeout(() => { try { socket.close(); } catch {} resolve({ format, sampleRate, error: "timeout 30s", events, marks }); }, 30000);
    socket.on("open", () => {
      marks.push(["open", Date.now() - t0]);
      socket.send(JSON.stringify({
        header: { action: "run-task", task_id: taskId, streaming: "duplex" },
        payload: {
          task_group: "audio", task: "tts", function: "SpeechSynthesizer",
          model: "qwen-audio-3.0-tts-flash",
          parameters: { text_type: "PlainText", voice: "longanhuan_v3.6", format, sample_rate: sampleRate, volume: 50, rate: 1.0, pitch: 1.0 },
          input: {},
        },
      }));
    });
    socket.on("message", (raw, isBinary) => {
      if (isBinary) {
        const n = Buffer.isBuffer(raw) ? raw.length : Buffer.from(raw).length;
        if (audioBytes === 0) marks.push(["first-audio-byte", Date.now() - t0]);
        audioBytes += n;
        if (frames.length < 12) frames.push([Date.now() - t0, n]);
        return;
      }
      let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
      const event = msg?.header?.event ?? "?";
      events.push([event, Date.now() - t0, String(msg?.header?.error_message ?? "").slice(0, 120), JSON.stringify(msg?.payload ?? {}).slice(0, 200)]);
      if (event === "task-started") {
        started = 1;
        // feed the text in two pieces to prove incremental feeding works
        const half = Math.ceil(TEXT.length / 2);
        socket.send(JSON.stringify({ header: { action: "continue-task", task_id: taskId, streaming: "duplex" }, payload: { input: { text: TEXT.slice(0, half) } } }));
        marks.push(["continue-1", Date.now() - t0]);
        setTimeout(() => {
          socket.send(JSON.stringify({ header: { action: "continue-task", task_id: taskId, streaming: "duplex" }, payload: { input: { text: TEXT.slice(half) } } }));
          marks.push(["continue-2", Date.now() - t0]);
          socket.send(JSON.stringify({ header: { action: "finish-task", task_id: taskId, streaming: "duplex" }, payload: { input: {} } }));
          marks.push(["finish-task", Date.now() - t0]);
        }, 400);
      }
      if (event === "task-failed") { clearTimeout(timer); try { socket.close(); } catch {} resolve({ format, sampleRate, error: msg?.header?.error_message, events, marks, frames, audioBytes }); }
      if (event === "task-finished") {
        clearTimeout(timer);
        marks.push(["task-finished", Date.now() - t0]);
        try { socket.close(); } catch {}
        setTimeout(() => resolve({ format, sampleRate, events, marks, frames, audioBytes, started }), 100);
      }
    });
    socket.on("error", (e) => { clearTimeout(timer); resolve({ format, sampleRate, error: String(e.message), events, marks }); });
  });
}

for (const [format, rate] of [["pcm", 24000], ["mp3", 22050]]) {
  const r = await run(format, rate);
  console.log(`\n===== format=${format} sample_rate=${rate} =====`);
  console.log("marks:", JSON.stringify(r.marks));
  console.log("audioBytes:", r.audioBytes, " first frames ([ms,bytes]):", JSON.stringify(r.frames));
  console.log("events:");
  for (const e of r.events ?? []) console.log("  ", JSON.stringify(e).slice(0, 260));
  if (r.error) console.log("ERROR:", r.error);
}
