// Third probe — the two behaviours the implementation depends on:
//  A) does feeding ONE continue-task per sentence make the FIRST sentence's audio arrive earlier?
//  B) does cancel (finish-task + directive:cancel) stop the audio and finish the task?
//   node scripts/qa/tts-ws-cancel.mjs
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
const VOICE = "longanhuan_v3.6", MODEL = "qwen-audio-3.0-tts-flash";

const SENTENCES = [
  "能。这是流式合成的第一句。",
  "第二句要长一些，用来观察服务端是不是按 continue-task 的边界来切分句子，从而让第一句的音频先回来，而不是等整段文本都合成完再一起返回。",
  "第三句收尾。",
];

const connect = () => new Promise((resolve, reject) => {
  const socket = new WebSocket(wsUrl, { headers: { authorization: "bearer " + key } });
  socket.on("open", () => resolve(socket));
  socket.on("error", reject);
});

function trace(socket, label) {
  const t0 = Date.now();
  const log = [];
  const onMessage = (raw, isBinary) => {
    const at = Date.now() - t0;
    if (isBinary) {
      const n = Buffer.isBuffer(raw) ? raw.length : Buffer.from(raw).length;
      if (!log.some((l) => l[0] === "audio")) log.push(["audio", at, n]);
      return;
    }
    let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
    const e = msg?.header?.event, type = msg?.payload?.output?.type;
    log.push([e, at, type ?? "", String(msg?.payload?.output?.original_text ?? "").slice(0, 40) || JSON.stringify(msg?.payload?.usage ?? "")]);
  };
  socket.on("message", onMessage);
  return { t0, log, done: () => socket.off("message", onMessage) };
}

// ---- A) per-sentence feeding
{
  const socket = await connect();
  const tr = trace(socket, "per-sentence");
  const taskId = "A-" + Math.random().toString(36).slice(2, 8);
  const send = (o) => socket.send(JSON.stringify(o));
  send({ header: { action: "run-task", task_id: taskId, streaming: "duplex" },
    payload: { task_group: "audio", task: "tts", function: "SpeechSynthesizer", model: MODEL,
      parameters: { text_type: "PlainText", voice: VOICE, format: "mp3", sample_rate: 22050 }, input: {} } });
  let fed = 0;
  await new Promise((resolve) => {
    socket.on("message", (raw, isBinary) => {
      if (isBinary) return;
      let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg?.header?.event === "task-started") {
        const feed = () => {
          if (fed < SENTENCES.length) { send({ header: { action: "continue-task", task_id: taskId, streaming: "duplex" }, payload: { input: { text: SENTENCES[fed] } } }); fed++; setTimeout(feed, 500); return; }
          send({ header: { action: "finish-task", task_id: taskId, streaming: "duplex" }, payload: { input: {} } });
        };
        send({ header: { action: "continue-task", task_id: taskId, streaming: "duplex" }, payload: { input: { text: SENTENCES[0] } } }); fed = 1;
        setTimeout(feed, 500);
      }
      if (msg?.header?.event === "task-finished" || msg?.header?.event === "task-failed") resolve();
    });
    setTimeout(resolve, 20000);
  });
  tr.done(); try { socket.close(); } catch {}
  console.log("=== A) one continue-task per sentence ===");
  for (const l of tr.log) console.log("  ", JSON.stringify(l));
}

// ---- B) cancel mid-stream
{
  const socket = await connect();
  const tr = trace(socket, "cancel");
  const taskId = "B-" + Math.random().toString(36).slice(2, 8);
  const send = (o) => socket.send(JSON.stringify(o));
  send({ header: { action: "run-task", task_id: taskId, streaming: "duplex" },
    payload: { task_group: "audio", task: "tts", function: "SpeechSynthesizer", model: MODEL,
      parameters: { text_type: "PlainText", voice: VOICE, format: "mp3", sample_rate: 22050 }, input: {} } });
  let cancelledAt = null;
  await new Promise((resolve) => {
    let audioFrames = 0;
    socket.on("message", (raw, isBinary) => {
      if (isBinary) {
        audioFrames++;
        if (audioFrames === 2 && cancelledAt === null) {
          cancelledAt = Date.now() - tr.t0;
          send({ header: { action: "finish-task", task_id: taskId, streaming: "duplex" }, payload: { input: { directive: "cancel" } } });
        }
        return;
      }
      let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg?.header?.event === "task-started") {
        send({ header: { action: "continue-task", task_id: taskId, streaming: "duplex" }, payload: { input: { text: SENTENCES.join("") } } });
      }
      if (msg?.header?.event === "task-finished" || msg?.header?.event === "task-failed") resolve();
    });
    setTimeout(resolve, 20000);
  });
  const after = tr.log.filter((l) => cancelledAt !== null && l[1] > cancelledAt && l[0] === "audio").length;
  tr.done();
  console.log("\n=== B) cancel after 2 audio frames ===");
  console.log("  cancel sent at", cancelledAt, "ms; audio frames AFTER cancel:", after);
  for (const l of tr.log) console.log("  ", JSON.stringify(l));

  // can a new task start on the SAME socket right after a cancel?
  const again = trace(socket, "after-cancel");
  const taskId2 = "B2-" + Math.random().toString(36).slice(2, 8);
  await new Promise((resolve) => {
    socket.on("message", (raw, isBinary) => {
      if (isBinary) return;
      let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg?.header?.event === "task-started") {
        socket.send(JSON.stringify({ header: { action: "continue-task", task_id: taskId2, streaming: "duplex" }, payload: { input: { text: SENTENCES[2] } } }));
        socket.send(JSON.stringify({ header: { action: "finish-task", task_id: taskId2, streaming: "duplex" }, payload: { input: {} } }));
      }
      if (msg?.header?.event === "task-finished" || msg?.header?.event === "task-failed") resolve();
    });
    socket.send(JSON.stringify({ header: { action: "run-task", task_id: taskId2, streaming: "duplex" },
      payload: { task_group: "audio", task: "tts", function: "SpeechSynthesizer", model: MODEL,
        parameters: { text_type: "PlainText", voice: VOICE, format: "mp3", sample_rate: 22050 }, input: {} } }));
    setTimeout(resolve, 20000);
  });
  again.done(); try { socket.close(); } catch {}
  console.log("\n=== B2) a NEW task on the SAME socket after cancel ===");
  for (const l of again.log) console.log("  ", JSON.stringify(l));
}
