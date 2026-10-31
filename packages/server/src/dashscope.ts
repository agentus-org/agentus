// DashScope (阿里百炼) voice adapter.
//
// Shapes verified against the operator's own MaaS endpoint on 2026-10-02 (probe scripts
// in ~/.hermes/cache/agentus/night), and the TTS streaming shape re-measured on 2026-10-31
// (scripts/qa/tts-ws-probe.mjs / tts-ws-baseline.mjs / tts-ws-cancel.mjs):
//   TTS   POST {root}/api/v1/services/audio/tts/SpeechSynthesizer
//         {model:"qwen-audio-3.0-tts-flash", input:{text, voice:"longanhuan_v3.6",
//         format:"wav", sample_rate}} → output.audio.url (fetch server-side, return bytes)
//   TTS流 WSS {root}/api-ws/v1/inference — run-task {task:"tts", function:"SpeechSynthesizer"}
//         → task-started → continue-task {input:{text}} (feed per sentence) → binary audio
//         frames + result-generated per sentence → finish-task → task-finished.
//         Cancel = finish-task with payload.input.directive="cancel": the server answers
//         task-finished at once and sends no further audio (measured: 0 frames after cancel).
//         A cancelled connection can carry the NEXT run-task immediately — no reconnect.
//         Same endpoint the streaming ASR already uses.
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
import { getSettings, dashscopeUrls, SUMMARY_MODEL_DEFAULT } from "./settings.js";

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
 *  a cross-origin request from the client).
 *
 *  Kept as the fallback behind the streaming path (voice.ttsStream off, a provider that is
 *  not 百炼, or a streaming task that failed before the first byte). */
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

/** Measured upstream pacing for the streaming TTS path (2026-10-31, real endpoint):
 *   - a NEW upstream socket costs 200-650 ms before task-started (TLS + auth), while a
 *     run-task on an already-open socket reaches task-started in ~50 ms. That difference is
 *     larger than the whole HTTP path's advantage, which is why the relay keeps ONE socket
 *     and runs a sequence of tasks on it instead of dialling per sentence;
 *   - the first binary frame arrives ~300 ms after the task starts for one sentence, against
 *     709 ms warm / 1208 ms cold for the HTTP path (POST, then a second GET of the signed URL);
 *   - `finish-task` with `input.directive="cancel"` ends the task in ~75 ms with no further
 *     audio frames, and the very same socket accepts the next `run-task` immediately. */
const TTS_START_TIMEOUT_MS = 12_000;
/** How long the id of a cancelled task is remembered, so its late events are recognised as
 *  stale. Comfortably longer than the ~75 ms the ack takes; the id is per task, so the only
 *  cost of a long window is a set entry. */
const TTS_CANCEL_FORGET_MS = 30_000;
/** Heard nothing at all for this long inside a live task: the socket is dead, say so. */
const TTS_IDLE_TIMEOUT_MS = 20_000;

/** One task's callbacks. A task is one reply's worth of text: `say` per sentence,
 *  `end` when there is no more, `cancel` when the operator stops it. */
export interface TtsTaskHandlers {
  /** task-started: from here `say()` is legal and audio is on its way. */
  onReady: (format: "pcm", sampleRate: number) => void;
  /** A binary frame of s16le mono PCM at the negotiated rate. */
  onAudio: (pcm: Buffer) => void;
  /** The upstream began a sentence (index counts from 0 within the task). */
  onSentence: (index: number, text: string) => void;
  /** task-finished: everything fed has been synthesised. The task is over. */
  onDone: (characters: number) => void;
  onError: (message: string) => void;
}

interface LiveTask {
  taskId: string;
  handlers: TtsTaskHandlers;
  ready: boolean;
  ended: boolean;
  cancelled: boolean;
  finished: boolean;
  sentenceAt: number;
  startTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
}

/**
 * A reusable streaming-synthesis connection to the DashScope inference WebSocket.
 *
 * Why the server owns the socket: a browser cannot set the auth header on a WebSocket
 * handshake, and the key must not leave the server anyway. So the cockpit server holds the
 * upstream socket and the browser receives PCM through our own /ws/tts (see index.ts).
 *
 * Why one connection carries many tasks: the dial costs 200-650 ms, the task start ~50 ms.
 * A relay that dialled per sentence would spend more time connecting than synthesising.
 * `runTask()` starts the next one; `cancel()` abandons the current one without dropping the
 * connection; `close()` is the only thing that tears it down.
 *
 * PCM, not mp3: the browser has to schedule samples exactly. A frame-aligned mp3 prefix does
 * NOT decode to the same samples as the whole file (measured max |diff| 0.066 — see
 * scripts/qa/tts-mp3-incremental.mjs), so incremental mp3 decoding drifts out of alignment.
 * 24 kHz mono s16le is 48 KB/s, the same order as the mp3 the HTTP path already sends.
 */
export class DashscopeTtsConnection {
  readonly sampleRate = 24_000;
  #socket: WebSocket;
  #task: LiveTask | null = null;
  /** Tasks that were cancelled. The upstream keeps finishing them (a `task-finished` and a few
   *  late frames are normal), and those events must not be mistaken for the NEXT task's: a stray
   *  `task-finished` would truncate a new reply, and a stray audio frame would be audible as
   *  the previous sentence. The protocol echoes `task_id` in every header, so they are dropped
   *  by name instead of by timing. */
  #stale = new Set<string>();
  /** Frames written before the upstream handshake finished (see #send). */
  #pending: string[] = [];
  #closed = false;
  #onClosed: ((why: string) => void) | null;
  #idleSince = Date.now();

  constructor(opts: { onClose: (why: string) => void }) {
    const { key, ws } = creds();
    this.#socket = new WebSocket(ws, { headers: { authorization: `Bearer ${key}` } });
    this.#socket.on("open", () => { this.#idleSince = Date.now(); this.#flush(); });
    this.#socket.on("message", (raw: Buffer | string, isBinary: boolean) => this.#onMessage(raw, isBinary));
    this.#socket.on("error", (e: Error) => {
      const t = this.#task;
      if (t && !t.finished) this.#fail(t, `dashscope tts socket: ${e.message}`);
      else this.#shut(`dashscope tts socket: ${e.message}`);
    });
    this.#socket.on("close", () => {
      const t = this.#task;
      this.#closed = true;
      this.#pending = [];
      if (t && !t.finished && !t.cancelled) this.#fail(t, "dashscope tts socket closed before the audio finished");
      this.#shut("closed");
    });
    this.#onClosed = opts.onClose;
  }

  /** Is a task in flight right now? */
  get busy(): boolean {
    return this.#task !== null && !this.#task.finished;
  }

  /** Open a task and start feeding it. Throws when the connection is gone or already busy. */
  runTask(handlers: TtsTaskHandlers): { say: (text: string) => void; end: () => void; cancel: () => void } {
    if (this.#closed) throw new DashscopeError("dashscope tts connection is closed", "upstream");
    if (this.busy) throw new DashscopeError("dashscope tts connection already has a task in flight", "upstream");
    const v = getSettings().voice;
    const task: LiveTask = {
      taskId: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
      handlers, ready: false, ended: false, cancelled: false, finished: false, sentenceAt: 0,
      startTimer: null, idleTimer: null,
    };
    this.#task = task;
    const send = (obj: unknown): void => this.#send(obj);
    const armIdle = (): void => this.#armIdle(task);
    armIdle();
    // A socket that is still dialling queues the frame: ws buffers until open.
    task.startTimer = setTimeout(() => this.#fail(task, "dashscope tts: task-started timed out"), TTS_START_TIMEOUT_MS);
    send({
      header: { action: "run-task", task_id: task.taskId, streaming: "duplex" },
      payload: {
        task_group: "audio", task: "tts", function: "SpeechSynthesizer", model: v.ttsModel,
        parameters: {
          text_type: "PlainText",
          voice: v.ttsVoice,
          format: "pcm",
          sample_rate: this.sampleRate,
          volume: 50,
          rate: 1.0,
          pitch: 1.0,
        },
        input: {},
      },
    });
    return {
      say: (text: string): void => {
        if (task.finished || task.cancelled || !text.trim()) return;
        armIdle();
        send({ header: { action: "continue-task", task_id: task.taskId, streaming: "duplex" }, payload: { input: { text } } });
      },
      end: (): void => {
        if (task.finished || task.cancelled || task.ended) return;
        task.ended = true;
        armIdle();
        send({ header: { action: "finish-task", task_id: task.taskId, streaming: "duplex" }, payload: { input: {} } });
      },
      cancel: (): void => this.#cancelTask(task),
    };
  }

  /** Drop the connection. Any task in flight is cancelled first (best effort). */
  close(): void {
    if (this.#closed) return;
    const t = this.#task;
    if (t && !t.finished) { t.cancelled = true; this.#clearTaskTimers(t); }
    this.#closed = true;
    try {
      if (this.#socket.readyState === this.#socket.OPEN) this.#socket.close();
      else if (this.#socket.readyState === this.#socket.CONNECTING) this.#socket.terminate();
    } catch { /* already gone */ }
    this.#shut("closed by caller");
  }

  #cancelTask(task: LiveTask): void {
    if (task.finished || task.cancelled) return;
    task.cancelled = true;
    task.finished = true;
    this.#clearTaskTimers(task);
    this.#send({
      header: { action: "finish-task", task_id: task.taskId, streaming: "duplex" },
      payload: { input: { directive: "cancel" } },
    });
    // The slot is released NOW, not when the upstream acknowledges: a cancel is sent precisely
    // when the next sentence is about to be asked for, and waiting for the ack would make the
    // operator's interruption cost a stall. Measured 2026-10-31: the same socket accepts a new
    // run-task immediately after the cancel directive, and the ack arrives ~75 ms later.
    if (this.#task === task) this.#task = null;
    this.#idleSince = Date.now();
    this.#stale.add(task.taskId);
    const forget = setTimeout(() => this.#stale.delete(task.taskId), TTS_CANCEL_FORGET_MS);
    forget.unref?.();
  }

  /** Frames written before the handshake completes are QUEUED, not dropped.
   *
   *  Why this matters: `runTask()` is called the moment the browser asks to speak, which is
   *  usually while the socket is still dialling (a fresh connection costs 200-650 ms upstream).
   *  Dropping the run-task there leaves a task that never starts — measured against the
   *  stand-in upstream in scripts/voice-smoke.mjs, where the FIRST reply of every new
   *  connection was silent and every later one worked, because by then the socket was open. */
  #send(obj: unknown): void {
    const payload = JSON.stringify(obj);
    if (this.#socket.readyState === this.#socket.OPEN) {
      try { this.#socket.send(payload); } catch { /* the close handler reports it */ }
      return;
    }
    if (this.#socket.readyState === this.#socket.CONNECTING) this.#pending.push(payload);
  }

  #flush(): void {
    if (!this.#pending.length) return;
    const queued = this.#pending;
    this.#pending = [];
    for (const payload of queued) {
      try { this.#socket.send(payload); } catch { /* the close handler reports it */ }
    }
  }

  #clearTaskTimers(t: LiveTask): void {
    if (t.startTimer) { clearTimeout(t.startTimer); t.startTimer = null; }
    if (t.idleTimer) { clearTimeout(t.idleTimer); t.idleTimer = null; }
  }

  #armIdle(task: LiveTask): void {
    if (task.idleTimer) clearTimeout(task.idleTimer);
    task.idleTimer = setTimeout(
      () => this.#fail(task, `dashscope tts stream: no data for ${TTS_IDLE_TIMEOUT_MS / 1000}s`),
      TTS_IDLE_TIMEOUT_MS,
    );
    task.idleTimer.unref?.();
  }

  #fail(task: LiveTask, message: string): void {
    if (task.finished) return;
    task.finished = true;
    this.#clearTaskTimers(task);
    if (this.#task === task) this.#task = null;
    task.handlers.onError(message);
  }

  #shut(why: string): void {
    if (!this.#onClosed) return;
    const cb = this.#onClosed;
    this.#onClosed = null;
    cb(why);
  }

  #onMessage(raw: Buffer | string, isBinary: boolean): void {
    const task = this.#task;
    if (isBinary) {
      if (!task || task.finished || task.cancelled) return;   // late frames from a cancelled task
      this.#armIdle(task);
      task.handlers.onAudio(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as unknown as ArrayBufferLike));
      return;
    }
    let msg: {
      header?: { task_id?: string; event?: string; error_message?: string };
      payload?: {
        output?: { type?: string; original_text?: string; sentence?: { index?: number; text?: string } };
        usage?: { characters?: number };
      };
    };
    try { msg = JSON.parse(String(raw)) as typeof msg; } catch { return; }
    const event = msg?.header?.event ?? "";
    const id = msg?.header?.task_id;
    // A cancelled task keeps talking for a moment. Its `task_id` is the only thing that tells
    // its tail apart from the reply that replaced it.
    if (id && id !== task?.taskId) {
      if (id === undefined || this.#stale.has(id)) {
        if (event === "task-finished") this.#stale.delete(id);
        return;
      }
      return;   // an id we do not know and did not start: not ours to interpret
    }
    if (!task || task.finished) return;
    this.#armIdle(task);
    if (event === "task-started") {
      task.ready = true;
      if (task.startTimer) { clearTimeout(task.startTimer); task.startTimer = null; }
      task.handlers.onReady("pcm", this.sampleRate);
      return;
    }
    if (event === "task-failed") {
      this.#fail(task, `dashscope tts: ${msg?.header?.error_message ?? "task failed"}`);
      return;
    }
    if (event === "result-generated") {
      const out = msg?.payload?.output;
      if (out?.type === "sentence-begin") {
        const text = String(out.original_text ?? out.sentence?.text ?? "");
        if (text) task.handlers.onSentence(task.sentenceAt++, text);
      }
      return;
    }
    if (event === "task-finished") {
      task.finished = true;
      this.#clearTaskTimers(task);
      const chars = Number(msg?.payload?.usage?.characters ?? 0);
      if (this.#task === task) this.#task = null;
      this.#idleSince = Date.now();
      // A cancelled task still reports task-finished; the caller asked for it to stop, so it
      // must not look like a completed reply.
      if (!task.cancelled) task.handlers.onDone(chars);
      return;
    }
  }
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
 * The input is NOT truncated any more (#36). It used to be capped at `maxChars × 20` characters,
 * which punished exactly the case this feature exists for — a long agent reply — while the case
 * the cap protected against (a pasted 200 KB log) is rare and is now refused outright by the
 * caller with a visible 409. Half a summary that looks finished is worse than an error.
 */
export async function summarizeForSpeech(opts: {
  text: string;
  maxChars: number;
  prompt: string;
  model: string;
  timeoutSec: number;
  /** Where to send it. Absent = the voice endpoint (settings → 语音), which is the old, always-on
   *  route. Present = the SESSION's own provider (see speech/route.ts) — the operator asked for
   *  the summary to be billed to whatever model he is actually talking to, not to a second vendor. */
  endpoint?: { baseUrl: string; apiKey: string };
  /** qwen3-family only: `enable_thinking: true` + `thinking_budget: N`. The operator's rule is
   *  「开着思考，但只给一点点」 — a capped think reads the message better than a non-reasoning
   *  model, without the 235-token wander measured on the default budget (4000). Sending this to
   *  a non-qwen3 model would be a lie, so the caller decides and we just transmit. */
  thinkingBudget?: number;
}): Promise<{ text: string; ms: number }> {
  const { key, compat } = opts.endpoint
    ? { key: opts.endpoint.apiKey, compat: opts.endpoint.baseUrl.replace(/\/+$/, "") }
    : creds();
  const v = getSettings().voice;
  const input = opts.text.trim();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(5, opts.timeoutSec) * 1000);
  const started = Date.now();
  try {
    const res = await fetch(`${compat}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: opts.model || (opts.endpoint ? "" : SUMMARY_MODEL_DEFAULT),
        messages: [
          { role: "system", content: opts.prompt.replace(/\{maxChars\}/g, String(opts.maxChars)) },
          { role: "user", content: input },
        ],
        // No temperature knob: this surface is not a playground, and the default has produced
        // the steadiest length compliance. `max_completion_tokens` (NOT `max_tokens`): it bounds
        // thinking and answer TOGETHER and has no 32768 ceiling, so a capped-think call cannot
        // come back empty with finish_reason=length. Measured on deepseek-v4-flash, a 480-token
        // cap was spent entirely on reasoning_content and the visible answer was empty; 1200 is
        // the floor that makes a reasoning model answer, and for a plain one it is only a ceiling
        // nobody reaches. The think budget is added on top so capping the think never eats the
        // answer.
        max_completion_tokens: Math.max(1200, opts.maxChars * 6) + (opts.thinkingBudget ?? 0),
        // qwen3 family (#36): thinking ON, budget 200. `thinking_budget` and `reasoning_effort`
        // must never travel together (the vendor rejects the pair), so this is the only knob.
        ...(opts.thinkingBudget
          ? { enable_thinking: true, thinking_budget: opts.thinkingBudget }
          : {}),
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
    return { text: out, ms: Date.now() - started };
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      throw new DashscopeError(`summary timed out after ${opts.timeoutSec}s`, "timeout");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
