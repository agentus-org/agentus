// DashScope (阿里百炼) voice adapter.
//
// Shapes verified against the operator's own MaaS endpoint on 2026-10-02 (probe scripts
// in ~/.hermes/cache/agentus/night):
//   TTS   POST {root}/api/v1/services/audio/tts/SpeechSynthesizer
//         {model:"qwen-audio-3.0-tts-flash", input:{text, voice:"longanhuan_v3.6",
//         format:"wav", sample_rate}} → output.audio.url (fetch server-side, return bytes)
//   ASR   POST {compat}/chat/completions with an input_audio base64 data URL
//         (qwen3-asr-flash) → choices[0].message.content; hotwords ride in a system
//         message (the compat surface has no vocabulary parameter)
//   ASR流  WSS {root}/api-ws/v1/inference, run-task/finish-task duplex events, binary
//         PCM frames after task-started, result-generated carries partial + final
//         sentences. Supports instant hotwords (parameters.vocabulary) and context.
//
// The base URL is the operator's — every Bailian workspace id is different, and the
// whole point is that this is NOT the coding-plan endpoint. No URLs or keys are baked in.
import WebSocket from "ws";
import { getSettings, dashscopeUrls } from "./settings.js";

export class DashscopeError extends Error {
  constructor(message: string, readonly code: "not_configured" | "upstream" | "timeout" | "bad_audio") {
    super(message);
  }
}

const TIMEOUT_MS = 45_000;

function creds(): { key: string; root: string; compat: string; ws: string } {
  const v = getSettings().voice;
  if (v.provider !== "dashscope" || !v.baseUrl || !v.apiKey) {
    throw new DashscopeError("dashscope voice is not configured (settings page: endpoint + API key)", "not_configured");
  }
  const urls = dashscopeUrls(v.baseUrl);
  return { key: v.apiKey, ...urls };
}

async function fetchJson(url: string, init: RequestInit, label: string): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new DashscopeError(`${label} ${res.status}: ${detail.slice(0, 300) || res.statusText}`, "upstream");
    }
    return res;
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new DashscopeError(`${label} timed out after ${TIMEOUT_MS / 1000}s`, "timeout");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Text → audio bytes. Non-streaming: the response carries a 24h OSS URL; we fetch it
 *  server-side so the browser only ever talks to Agentus (and the key never pairs with
 *  a cross-origin request from the client). */
export async function dashscopeTts(text: string, opts: { voice?: string; speed?: number } = {}): Promise<{
  contentType: string;
  audio: Buffer;
}> {
  const { key, root } = creds();
  const v = getSettings().voice;
  const rate = Math.min(2, Math.max(0.5, opts.speed ?? 1));
  const res = await fetchJson(`${root}/api/v1/services/audio/tts/SpeechSynthesizer`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: v.ttsModel,
      input: {
        text,
        voice: opts.voice || v.ttsVoice,
        format: v.ttsFormat,
        sample_rate: v.ttsFormat === "wav" ? 24000 : undefined,
        ...(rate !== 1 ? { rate } : {}),
      },
    }),
  }, "dashscope tts");
  const data = (await res.json()) as { output?: { audio?: { url?: string; data?: string } } };
  const audio = data?.output?.audio;
  if (audio?.data) {
    return { contentType: mimeOf(v.ttsFormat), audio: Buffer.from(audio.data, "base64") };
  }
  if (!audio?.url) throw new DashscopeError(`dashscope tts returned no audio: ${JSON.stringify(data).slice(0, 200)}`, "upstream");
  // the url is http:// on some tenants; fetch as-is (same cloud, short-lived, signed)
  const dl = await fetchJson(audio.url, { method: "GET" }, "dashscope tts download");
  return { contentType: dl.headers.get("content-type") ?? mimeOf(v.ttsFormat), audio: Buffer.from(await dl.arrayBuffer()) };
}

function mimeOf(format: string): string {
  return format === "wav" ? "audio/wav" : format === "opus" ? "audio/ogg" : "audio/mpeg";
}

/** Hotwords for the compat route: a compact system message. The docs describe it as
 *  "背景文本和实体词表" — exactly the context-enhancement channel, and it is what makes
 *  "Agentus"/"网关" survive instead of "安逸 slot"/"万关". */
export function hotwordContext(words: string[]): string {
  if (!words.length) return "";
  return `本次语音可能涉及的词汇表（识别时可优先匹配）：${words.slice(0, 60).join("、")}。`;
}

/** One-shot transcription (the stop-and-finalise path, and the batch model).
 *  `audio` is raw bytes; `mime` decides the data URL prefix the model is told. */
export async function dashscopeAsr(audio: Buffer, mime: string, opts: { contextWords?: string[] } = {}): Promise<string> {
  const { key, compat } = creds();
  const v = getSettings().voice;
  const dataUrl = `data:${mime || "audio/wav"};base64,${audio.toString("base64")}`;
  const messages: unknown[] = [];
  const ctx = hotwordContext(opts.contextWords ?? []);
  if (ctx) messages.push({ role: "system", content: [{ type: "text", text: ctx }] });
  messages.push({ role: "user", content: [{ type: "input_audio", input_audio: { data: dataUrl } }] });
  const res = await fetchJson(`${compat}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: v.asrBatchModel, messages, asr_options: { enable_itn: true } }),
  }, "dashscope asr");
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return String(data?.choices?.[0]?.message?.content ?? "").trim();
}

/**
 * A live streaming recognition task over the DashScope WebSocket.
 *
 * The browser cannot talk to this endpoint itself: the auth header on a WebSocket
 * handshake is forbidden in browsers, and the raw key must not leave the server anyway.
 * So the cockpit server owns the upstream socket and the browser relays PCM through our
 * own /ws/asr (see index.ts). Events:
 *   onPartial(text)  — running sentence, replaces the previous partial
 *   onFinal(text)    — a completed sentence (sentence_end)
 */
export function openDashscopeStream(opts: {
  /** instant hotwords WITH weights: {"词": 1..5}, 50 = super-hotword */
  vocabulary?: Record<string, number>;
  /** plain word list, used when no weighted vocabulary is available */
  contextWords?: string[];
  /** context enhancement: recent lines of the conversation being dictated into */
  context?: { role: "user" | "assistant"; text: string }[];
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (message: string) => void;
  onClose: () => void;
}): { sendAudio: (chunk: Buffer) => void; stop: () => void; started: Promise<void> } {
  const { key, ws } = creds();
  const v = getSettings().voice;
  const socket = new WebSocket(ws, { headers: { authorization: `Bearer ${key}` } });
  const taskId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  let startedResolve: (() => void) | null = null;
  let startedReject: ((e: Error) => void) | null = null;
  const started = new Promise<void>((resolve, reject) => { startedResolve = resolve; startedReject = reject; });
  let closing = false;
  // "done" must be exactly once and must not depend on WHO closed the socket: the first
  // relay had the finalise path suppressed (closing=true swallowed the close), so the
  // browser sat waiting for an end that never came.
  let done = false;
  const notifyDone = (): void => {
    if (done) return;
    done = true;
    opts.onClose();
  };
  const vocab: Record<string, number> = { ...(opts.vocabulary ?? {}) };
  for (const w of opts.contextWords ?? []) if (!(w in vocab)) vocab[w] = 4;

  socket.on("open", () => {
    socket.send(JSON.stringify({
      header: { action: "run-task", task_id: taskId, streaming: "duplex" },
      payload: {
        task_group: "audio", task: "asr", function: "recognition", model: v.asrModel,
        parameters: { format: "pcm", sample_rate: 16000, ...(Object.keys(vocab).length ? { vocabulary: vocab } : {}) },
        // context enhancement: what the operator has been talking about. Only sent when
        // we have it: an empty array is not the same request as "no context".
        input: opts.context?.length ? { context: opts.context.slice(0, 5) } : {},
      },
    }));
  });
  socket.on("message", (raw: Buffer | string) => {
    let msg: { header?: { event?: string; error_message?: string }; payload?: { output?: { sentence?: { text?: string; sentence_end?: boolean }; text?: string } } };
    try {
      msg = JSON.parse(String(raw)) as typeof msg;
    } catch {
      return;
    }
    const event = msg?.header?.event ?? "";
    if (event === "task-started") { startedResolve?.(); startedResolve = null; return; }
    if (event === "task-failed") {
      const m = `dashscope asr: ${msg?.header?.error_message ?? "task failed"}`;
      startedReject?.(new Error(m)); startedReject = null;
      opts.onError(m);
      return;
    }
    if (event === "result-generated") {
      const sent = msg?.payload?.output?.sentence;
      const text = String(sent?.text ?? msg?.payload?.output?.text ?? "");
      if (!text) return;
      if (sent?.sentence_end) opts.onFinal(text);
      else opts.onPartial(text);
      return;
    }
    if (event === "task-finished") {
      // the API's own end-of-task event: report it now rather than waiting for the socket
      startedReject?.(new Error("task finished before start"));
      startedReject = null;
      notifyDone();
      return;
    }
  });
  socket.on("error", (e: Error) => {
    startedReject?.(e); startedReject = null;
    opts.onError(`dashscope asr socket: ${e.message}`);
  });
  socket.on("close", notifyDone);

  const timeout = setTimeout(() => {
    startedReject?.(new Error("dashscope asr: task-started timed out"));
    startedReject = null;
  }, 10_000);
  started.catch(() => { /* surfaced via onError/stop below */ }).finally(() => void 0);
  // clear the timer once started succeeds; reject path already rejected the promise
  void started.then(() => clearTimeout(timeout), () => { clearTimeout(timeout); try { socket.close(); } catch { /* gone */ } });

  return {
    sendAudio(chunk: Buffer): void {
      if (socket.readyState === socket.OPEN) socket.send(chunk, { binary: true });
    },
    stop(): void {
      closing = true;
      try {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ header: { action: "finish-task", task_id: taskId, streaming: "duplex" }, payload: { input: {} } }));
          setTimeout(() => { try { socket.close(); } catch { /* already */ } }, 2000);
        }
      } catch { /* already closed */ }
    },
    started,
  };
}

/**
 * 语音总结: one message in, a few spoken sentences out.
 *
 * Same door as batch ASR (`{compat}/chat/completions`) with the audio block swapped for text, so
 * the operator's existing voice endpoint and key are enough — there is no second model to
 * configure and no agent, no session and no history involved.
 *
 * The input is capped at `maxChars × 20` characters (30k ≈ 15k tokens is already the ceiling for a
 * 30-second listen): a 200 KB pasted log must not turn a long press into a bill.
 */
export async function summarizeForSpeech(opts: {
  text: string;
  maxChars: number;
  prompt: string;
  model: string;
  timeoutSec: number;
  /** Where to send it. Absent = the voice endpoint (settings → 语音), which is the old, always-on
   *  route. Present = the SESSION's own provider (see speech/route.ts) — the operator asked for the
   *  summary to be billed to whatever model he is actually talking to, not to a second vendor. */
  endpoint?: { baseUrl: string; apiKey: string };
}): Promise<{ text: string; truncated: boolean; ms: number }> {
  const { key, compat } = opts.endpoint
    ? { key: opts.endpoint.apiKey, compat: opts.endpoint.baseUrl.replace(/\/+$/, "") }
    : creds();
  const v = getSettings().voice;
  const limit = Math.max(400, opts.maxChars * 20);
  const body = opts.text.trim();
  const truncated = body.length > limit;
  const input = truncated ? `${body.slice(0, limit)}\n…（后面还有 ${body.length - limit} 字没发）` : body;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(5, opts.timeoutSec) * 1000);
  const started = Date.now();
  try {
    const res = await fetch(`${compat}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: opts.model || (opts.endpoint ? "" : "qwen-flash"),
        messages: [
          { role: "system", content: opts.prompt.replace(/\{maxChars\}/g, String(opts.maxChars)) },
          { role: "user", content: input },
        ],
        // No temperature knob: this surface is not a playground, and the default has produced
        // the steadiest length compliance. `max_tokens` guards against a chatty model — and it
        // must leave room for REASONING tokens, which count against the same budget: measured on
        // deepseek-v4-flash, a 480-token cap was spent entirely on reasoning_content and the
        // visible answer came back empty with finish_reason=length. 1200 is the floor that makes a
        // reasoning model answer; for a plain one it is only a ceiling nobody reaches.
        max_tokens: Math.max(1200, opts.maxChars * 6),
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new DashscopeError(`chat/completions ${res.status}: ${detail}`, "upstream");
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string; reasoning_content?: string }; finish_reason?: string }[];
    };
    const choice = data?.choices?.[0];
    const out = String(choice?.message?.content ?? "").trim();
    if (!out) {
      // Say WHICH silence this was. An empty `content` with a fat `reasoning_content` and
      // finish_reason=length means the budget went to thinking, not that the model refused.
      const thought = String(choice?.message?.reasoning_content ?? "").length;
      const why = choice?.finish_reason === "length"
        ? `预算被推理吃光了（reasoning ${thought} 字，finish_reason=length）—— 调大字数上限，或换一个非推理模型`
        : `模型返回空内容（finish_reason=${choice?.finish_reason ?? "?"}）`;
      throw new DashscopeError(why, "upstream");
    }
    void v;
    return { text: out, truncated, ms: Date.now() - started };
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      throw new DashscopeError(`summary timed out after ${opts.timeoutSec}s`, "timeout");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
