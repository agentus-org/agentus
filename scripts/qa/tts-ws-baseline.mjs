// Second probe: what the streaming path actually buys against the HTTP path.
//  A) HTTP baseline: POST SpeechSynthesizer → GET the signed URL → time to first audio byte.
//  B) WS: two tasks on ONE reused connection (does the socket-open cost disappear?).
//  C) WS: a long two-sentence text — does the server split it itself, so sentence 1 starts early?
//   node scripts/qa/tts-ws-baseline.mjs
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
const base = env.DASHSCOPE_BASE_URL.replace(/\/+$/, "");
const root = base.split("/compatible-mode")[0].replace(/\/+$/, "");
const wsUrl = root.replace(/^http/, "ws") + "/api-ws/v1/inference";
const VOICE = "longanhuan_v3.6", MODEL = "qwen-audio-3.0-tts-flash";
const SHORT = "能。这是流式合成的第一句，用于测量首包延迟。";
const LONG = "能。这是流式合成的第一句，用于测量首包延迟。"
  + "第二句要长一些，用来观察服务端是不是自己按句切分，从而让第一句的音频先回来，"
  + "而不是等整段文本都合成完再一起返回。第三句收尾。";

async function httpBaseline(text) {
  const t0 = Date.now();
  const res = await fetch(`${root}/api/v1/services/audio/tts/SpeechSynthesizer`, {
    method: "POST",
    headers: { authorization: "bearer " + key, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: { text, voice: VOICE, format: "mp3", sample_rate: 24000 } }),
  });
  const jsonAt = Date.now() - t0;
  const data = await res.json();
  const url = data?.output?.audio?.url;
  if (!url) return { text: text.length, error: JSON.stringify(data).slice(0, 200) };
  const t1 = Date.now();
  const dl = await fetch(url);
  const reader = dl.body.getReader();
  const first = await reader.read();
  const firstByteAt = Date.now() - t0;
  let bytes = first.value?.length ?? 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value?.length ?? 0; }
  return { text: text.length, jsonAt, dlStartAt: t1 - t0, firstByteAt, bytes, total: Date.now() - t0 };
}

function wsTask(socket, text, label, out) {
  const t0 = Date.now();
  const taskId = "probe-" + Math.random().toString(36).slice(2, 10);
  const marks = { label, openAt: null, startedAt: null, firstAudioAt: null, finishedAt: null, bytes: 0, sentences: 0 };
  out.push(marks);
  return new Promise((resolve) => {
    const send = (o) => socket.send(JSON.stringify(o));
    const onMessage = (raw, isBinary) => {
      if (isBinary) {
        if (marks.firstAudioAt === null) marks.firstAudioAt = Date.now() - t0;
        marks.bytes += Buffer.isBuffer(raw) ? raw.length : Buffer.from(raw).length;
        return;
      }
      let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
      const e = msg?.header?.event;
      const type = msg?.payload?.output?.type;
      if (e === "task-started") {
        marks.startedAt = Date.now() - t0;
        send({ header: { action: "continue-task", task_id: taskId, streaming: "duplex" }, payload: { input: { text } } });
        send({ header: { action: "finish-task", task_id: taskId, streaming: "duplex" }, payload: { input: {} } });
      }
      if (e === "result-generated" && type === "sentence-begin") marks.sentences++;
      if (e === "task-failed") { marks.error = String(msg?.header?.error_message ?? "").slice(0, 160); socket.off("message", onMessage); resolve(marks); }
      if (e === "task-finished") {
        marks.finishedAt = Date.now() - t0;
        socket.off("message", onMessage);
        resolve(marks);
      }
    };
    socket.on("message", onMessage);
    try {
      send({
        header: { action: "run-task", task_id: taskId, streaming: "duplex" },
        payload: {
          task_group: "audio", task: "tts", function: "SpeechSynthesizer", model: MODEL,
          parameters: { text_type: "PlainText", voice: VOICE, format: "mp3", sample_rate: 22050, volume: 50, rate: 1.0, pitch: 1.0 },
          input: {},
        },
      });
    } catch (e) { marks.error = String(e.message); resolve(marks); }
  });
}

console.log("--- A) HTTP baseline (POST + GET, time to FIRST audio byte) ---");
for (const t of [SHORT, LONG, SHORT]) console.log(JSON.stringify(await httpBaseline(t)));

console.log("\n--- B/C) WS on one reused connection ---");
await new Promise((resolve) => {
  const t0 = Date.now();
  const socket = new WebSocket(wsUrl, { headers: { authorization: "bearer " + key } });
  const out = [];
  socket.on("open", async () => {
    console.log(`socket open after ${Date.now() - t0} ms`);
    for (const [text, label] of [[SHORT, "short#1"], [SHORT, "short#2 (reused)"], [LONG, "long (2-3 sentences)"]]) {
      const marks = await wsTask(socket, text, label, out);
      console.log(JSON.stringify(marks));
      await new Promise((r) => setTimeout(r, 250));
    }
    try { socket.close(); } catch { /* gone */ }
    resolve();
  });
  socket.on("error", (e) => { console.log("WS ERR", e.message); resolve(); });
});
