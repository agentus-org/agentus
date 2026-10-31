// Voice, browser-side: dictation into the composer and read-a-reply-aloud.
//
// Studio study (hermes-studio has a full provider system: local whisper, doubao,
// edge voices, per-profile keys) told us the *idea* worth copying is the layering,
// not the machinery: the browser can do both directions with zero configuration,
// and a server endpoint only exists for the cases the browser cannot cover.
//
// So this file holds two small singletons:
//
//   speaker   — read text aloud. Prefers the browser's own voices (offline, free,
//               instant, and the audio never leaves the device); can be pointed at
//               the server's OpenAI-compatible endpoint when one is configured.
//   dictation — turn speech into text. Prefers the browser's SpeechRecognition
//               (live interim words); falls back to MediaRecorder + /api/stt.
//
// Both are module singletons subscribed with useSyncExternalStore, the same shape
// `cockpit` uses: only one utterance can play and only one microphone can be open
// at a time, so a per-component hook would be a lie.
import { useEffect, useSyncExternalStore } from "react";
import type { ReadTarget, SpeakMode } from "./autoRead";
import { createSpeakQueue } from "./speakQueue";

// ---------------------------------------------------------------- preferences

export interface VoicePrefs {
  /** read a finished reply aloud without being asked. DERIVED from `speakMode` on the server and
   *  kept here so a pre-#16 page still works; new code reads `speakMode`. */
  autoRead: boolean;
  /** WHAT gets read aloud (issue #16): "off", "reply" (the old auto-read) or "brief" (the cockpit's
   *  own one-line 工作播报 from the observer agent). The server decides what a brief SAYS; this side
   *  only decides whether to speak. */
  speakMode?: "off" | "reply" | "brief";
  /** browser voiceURI, "" = pick the best one for the language */
  voiceURI: string;
  rate: number;
  /** BCP-47 for both directions, e.g. "zh-CN" */
  lang: string;
  /** route synthesis through the server endpoint instead of the browser */
  serverTts: boolean;
  /** "auto" = the configured streaming endpoint when there is one (it is the thing the
   *  operator paid for and configured hotwords on), else the browser, else batch upload */
  stt: "auto" | "browser" | "stream" | "server";
}

const PREFS_KEY = "agentus.voice";

const DEFAULT_PREFS: VoicePrefs = {
  autoRead: false,
  speakMode: "off",
  voiceURI: "",
  rate: 1,
  // Default to the browser's own language: an operator dictating Chinese should not
  // have to find a language setting first.
  lang: typeof navigator !== "undefined" && navigator.language ? navigator.language : "en-US",
  serverTts: false,
  stt: "auto",
};

export function loadVoicePrefs(): VoicePrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<VoicePrefs>;
    const rate = Number(parsed.rate);
    return {
      ...DEFAULT_PREFS,
      ...parsed,
      rate: Number.isFinite(rate) ? Math.min(2, Math.max(0.5, rate)) : DEFAULT_PREFS.rate,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function saveVoicePrefs(prefs: VoicePrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode: preferences just do not persist */
  }
}

// -------------------------------------------------------------- capabilities

export interface VoiceCaps {
  /** who would answer right now: 百炼 (dashscope) / any OpenAI-compatible endpoint /
   *  browser-only. The settings page shows this so "configured" is never a guess. */
  provider: "dashscope" | "openai" | "browser";
  tts: {
    server: boolean;
    /** the server can relay a live PCM stream (/ws/tts): first sound in ~300 ms instead of
     *  ~700 ms, and stopping it stops the billing for what was not generated yet. */
    streaming: boolean;
    /** the rate the streaming path delivers; null when it is not on offer */
    sampleRate: number | null;
    model: string | null;
    voice: string | null;
  };
  stt: {
    server: boolean;
    /** the server can relay a live PCM stream (/ws/asr) — live partials, hotwords */
    streaming: boolean;
    model: string | null;
    batchModel: string | null;
    language: string | null;
  };
  hotwords: { fixed: number; dynamic: boolean; limit: number };
}

export const NO_CAPS: VoiceCaps = {
  provider: "browser",
  tts: { server: false, streaming: false, sampleRate: null, model: null, voice: null },
  stt: { server: false, streaming: false, model: null, batchModel: null, language: null },
  hotwords: { fixed: 0, dynamic: false, limit: 0 },
};

let caps: VoiceCaps | null = null;
const capsListeners = new Set<() => void>();

/** Fetched once per page load; the answer changes when the server restarts — or when the
 *  settings page saves a new provider, which is what `force` is for. */
export async function loadVoiceCaps(force = false): Promise<VoiceCaps> {
  if (caps && !force) return caps;
  try {
    const res = await fetch("/api/voice", { credentials: "same-origin" });
    if (!res.ok) throw new Error(String(res.status));
    caps = (await res.json()) as VoiceCaps;
  } catch {
    // A failed probe must not break the buttons: assume browser-only.
    caps = NO_CAPS;
  }
  for (const fn of capsListeners) fn();
  return caps;
}

export function voiceCaps(): VoiceCaps {
  return caps ?? NO_CAPS;
}

/** Streaming dictation is available when the server says it is. */
export function streamingDictationAvailable(): boolean {
  return Boolean(voiceCaps().stt.streaming);
}

export function subscribeVoiceCaps(fn: () => void): () => void {
  capsListeners.add(fn);
  return () => capsListeners.delete(fn);
}

/** Text is spoken in sentence-sized pieces: one huge utterance is both unreliable
 *  (browsers truncate) and unstoppable mid-way. */
/** Chunk size for the SERVER path. Measured against a real 百炼 endpoint (2026-10-04):
 *  a 19-character sentence came back as 86 KB of wav in 0.5 s, 114 characters as 1.07 MB in
 *  3.3 s. So the first sound should wait for one SENTENCE, not for a 220-character block, and
 *  the extra requests cost nothing once they are prefetched (the audio is played while the
 *  next one is generated). The browser voice keeps the larger blocks: every utterance it
 *  starts has its own overhead. */
const SERVER_CHUNK = 80;
/** The streaming path does not chunk for the provider — it feeds SENTENCES, because the upstream
 *  synthesises each one as soon as its text is complete and the browser can start playing the
 *  first while the rest is still being generated. This cap only bounds one `continue-task` frame
 *  (the protocol allows 20000 characters, but a single 2000-character "sentence" in a bulleted
 *  reply would delay the first sound for no reason). */
const STREAM_UNIT = 120;
/** Seconds of scheduling headroom in front of the playhead. Audio chunks arrive asynchronously;
 *  a chunk scheduled at exactly `currentTime` lands late and clicks. 80 ms absorbs the gap
 *  without being audible as latency on the FIRST sound (the buffer is started immediately when
 *  nothing is playing yet — see PcmPlayer#push). */
const STREAM_LEAD = 0.08;
const BROWSER_CHUNK = 220;
/** How many TTS requests may be in flight: the next chunk is being generated and transferred
 *  while the current one plays, which is what removes the silence BETWEEN sentences. */
const SPEAK_AHEAD = 2;
/** Prefetched chunks kept. The call warms two sentences ahead (PREFETCH_SENTENCES) and one long
 *  sentence is up to three 80-char chunks, so six was one sentence short of useless. */
const PRE_CACHE_MAX = 12;

/** How many clips the PROVIDER will accept at once — and why this has to be enforced here instead of
 *  hoped for. Measured 2026-10-04 against the same 百炼 key with a 20-character sentence: 1 in flight
 *  → 1/1 ok, 3 in flight → 3/3 ok, 6 in flight → 3/6 ok with 502 `Throttling.RateQuota` after ~0.15 s.
 *  The prefetch pipeline that removed the inter-sentence silence therefore buys its silence back as a
 *  FAILED clip — and a failed clip is what made a whole sentence fall back to the browser voice
 *  ("播到一半换成浏览器语音了"). Bound it, and the failure stops happening. */
const TTS_IN_FLIGHT = 3;
/** A clip that failed is re-asked in place: one extra round trip beats changing voice mid-reply. */
const TTS_RETRIES = 2;
const TTS_RETRY_MS = 400;
/** A clip the reader needs NOW must not queue behind a speculative one for a sentence two later —
 *  that would be the same stall in a new costume. */
export const TTS_PRIORITY_NOW = 0;
export const TTS_PRIORITY_AHEAD = 1;

// The streaming relay's own liveness. The upstream recogniser finalises a task that has heard
// nothing for ~23 s (`request timeout after 23 seconds`), and a call keeps the microphone for
// minutes — the operator's own thinking included. So the socket is replaced instead of going
// quiet: frames captured while it reconnects are buffered and sent on open.
const RELAY_REOPEN_TRIES = 4;
const RELAY_REOPEN_MS = 400;
/** 100 ms of 16 kHz mono s16le per frame: this is ~6 s of the operator still being heard
 *  across a reconnect that has not completed yet (a stranded frame is a word nobody heard). */
const RELAY_PENDING_MAX = 60;

interface TtsWaiter { priority: number; run: () => void }
let ttsInFlight = 0;
const ttsQueue: TtsWaiter[] = [];

/** Hold one of the provider's slots for the duration of `fn`. A released slot is handed straight to
 *  the next waiter (never freed first — that would let a newcomer overtake the queue). Waiting is
 *  abortable: a call that stops must not leave a request stuck for a slot it will never use. */
async function withTtsSlot<T>(priority: number, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  if (ttsInFlight >= TTS_IN_FLIGHT) {
    await new Promise<void>((resolve, reject) => {
      const mine: TtsWaiter = { priority, run: resolve };
      ttsQueue.push(mine);
      ttsQueue.sort((a, b) => a.priority - b.priority);
      const drop = (): void => {
        const at = ttsQueue.indexOf(mine);
        if (at >= 0) ttsQueue.splice(at, 1);
        reject(new SpeechStopped());
      };
      if (signal) {
        if (signal.aborted) drop();
        else signal.addEventListener("abort", drop, { once: true });
      }
    });
  }
  ttsInFlight++;
  try {
    return await fn();
  } finally {
    const next = ttsQueue.shift();
    if (next) next.run();
    else ttsInFlight--;
  }
}

export function splitForSpeech(text: string, max = BROWSER_CHUNK): string[] {
  const clean = text
    .replace(/```[\s\S]*?```/g, " code block ") // never read code aloud
    .replace(/[*_`#>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return [];
  const out: string[] = [];
  let rest = clean;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    // prefer a sentence end, then a clause, then a space
    const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("。"), window.lastIndexOf("! "), window.lastIndexOf("? "));
    const alt = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf("，"));
    const at = cut > max * 0.5 ? cut + 1 : alt > max * 0.5 ? alt + 1 : window.lastIndexOf(" ");
    const end = at > 0 ? at : max;
    out.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

// ------------------------------------------------------------------- playback

/** One AudioContext for the whole page, created/resumed on a REAL user gesture.
 *  Why this exists: Chromium only allows playback inside (or shortly after) a gesture,
 *  and a synthesis round trip easily outlives that window — the operator clicks
 *  "合成并播放", waits two seconds for 百炼, and `audio.play()` is refused with "the user
 *  didn't interact with the document first". A context that was resumed by the click
 *  stays usable, so the audio still plays.
 */
let audioCtx: AudioContext | null = null;

function audioContextCtor(): typeof AudioContext | null {
  return (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) ?? null;
}

/** What the microphone ACTUALLY opened with.
 *
 *  Why this is tracked: echo cancellation is the ONLY thing standing between a phone on a table
 *  and a call that interrupts itself (its loudspeaker goes straight back into its own microphone).
 *  Chromium is allowed to ignore the constraint — and `openMic` below deliberately retries with
 *  the processing OFF when a vendor WebView refuses the processed pipeline. After that fallback the
 *  capture is raw: the echo is real, and any absolute "loud enough to interrupt" threshold will be
 *  crossed by the reply itself. The call shows this line so the operator stops tuning a slider
 *  against a device that quietly turned the cancellation off.
 *
 *  `null` = unknown (the browser-voice path never opens a stream through here). */
const MIC: { echoCancellation: boolean | null; noiseSuppression: boolean | null } = {
  echoCancellation: null,
  noiseSuppression: null,
};

function noteMic(stream: MediaStream, attempt: number): void {
  const track = stream.getAudioTracks()[0];
  const s = typeof track?.getSettings === "function" ? track.getSettings() : undefined;
  MIC.echoCancellation = typeof s?.echoCancellation === "boolean" ? s.echoCancellation : attempt > 0 ? false : null;
  MIC.noiseSuppression = typeof s?.noiseSuppression === "boolean" ? s.noiseSuppression : attempt > 0 ? false : null;
  if (MIC.echoCancellation === false) {
    console.warn("[voice] microphone opened WITHOUT echo cancellation — the call may hear itself");
  }
}

/** Did the capture we ended up with cancel its own echo? Unknown counts as yes: the gate then
 *  behaves as it did before this existed, instead of over-correcting on platforms that are fine. */
export function micEchoCancelled(): boolean {
  return MIC.echoCancellation !== false;
}

export function micInfo(): { echoCancellation: boolean | null; noiseSuppression: boolean | null } {
  return { ...MIC };
}

/** Ask for the microphone, degrading the constraints when the platform cannot honour them.
 *
 * Why this exists: on some Android vendor WebViews (seen on HyperOS 3 / Android 16) `getUserMedia`
 * with the WebRTC audio processing switched on fails to start the source —
 * `NotReadableError: Could not start audio source` — while a plain capture on the same device works.
 * The app's own native `AudioRecord` probe records fine there, so the permission and the device are
 * not the problem: it is the processed pipeline that will not open. Retrying with the processing off
 * (and finally with no constraints at all) turns that into a working microphone instead of an error
 * the operator can do nothing about. A refusal is never retried — that would just re-prompt.
 *
 * The cost of that fallback is real and is now measured instead of assumed: attempt 2 turns echo
 * cancellation OFF, and `noteMic` records it so the call can stop trusting an absolute level. */
async function openMic(preferred: MediaStreamConstraints): Promise<MediaStream> {
  const attempts: MediaStreamConstraints[] = [
    preferred,
    { audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } },
    { audio: true },
  ];
  let last: unknown = null;
  for (let i = 0; i < attempts.length; i++) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(attempts[i]);
      if (i > 0) console.warn("[voice] microphone opened only with degraded constraints", attempts[i]);
      noteMic(stream, i);
      return stream;
    } catch (e) {
      last = e;
      const name = (e as Error)?.name ?? "";
      if (name === "NotAllowedError" || name === "SecurityError") throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Call from the click handler itself (not after an await). */
export async function unlockAudio(): Promise<boolean> {
  const Ctor = audioContextCtor();
  if (!Ctor) return false;
  try {
    audioCtx = audioCtx ?? new Ctor();
    if (audioCtx.state === "suspended") await audioCtx.resume();
    return audioCtx.state === "running";
  } catch {
    return false;
  }
}

/** The analyser of whatever is playing right now (server TTS path only — the browser voice
 *  cannot be tapped, so callers fall back to their procedural animation there). The call
 *  UI reads this every animation frame: level and waveform must never go through React
 *  state, or a 60 fps visual turns into 60 renders/second. */
const PLAYBACK: { analyser: AnalyserNode | null } = { analyser: null };
// typed over ArrayBuffer (not ArrayBufferLike): getFloatTimeDomainData insists on it
let playbackBuf: Float32Array<ArrayBuffer> | null = null;

/** Live output amplitude 0..1, or -1 when there is nothing to measure. */
export function playbackLevel(): number {
  const a = PLAYBACK.analyser;
  if (!a) return -1;
  const buf: Float32Array<ArrayBuffer> = playbackBuf && playbackBuf.length === a.fftSize
    ? playbackBuf
    : new Float32Array(new ArrayBuffer(a.fftSize * 4));
  playbackBuf = buf;
  a.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.min(1, Math.sqrt(sum / buf.length) * 4);
}

/** The same output frame in its OWN units: RMS 0..1, no ×4 boost.
 *
 *  This is the reference signal of the barge gate. It must stay on the playback side's own scale:
 *  the gate compares it to `dictation.levelRms()`, and that comparison is only honest when neither
 *  side has been boosted or clamped (a loud reply clamped both meters at 1.0, which is why the
 *  first version of the gate could never fire). */
export function playbackRms(): number {
  const a = PLAYBACK.analyser;
  if (!a) return -1;
  const buf: Float32Array<ArrayBuffer> = playbackBuf && playbackBuf.length === a.fftSize
    ? playbackBuf
    : new Float32Array(new ArrayBuffer(a.fftSize * 4));
  playbackBuf = buf;
  a.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.min(1, Math.sqrt(sum / buf.length));
}

/** Copy the newest time-domain samples into `out` (for a waveform). False = nothing playing. */
export function playbackWave(out: Float32Array): boolean {
  const a = PLAYBACK.analyser;
  if (!a) return false;
  const buf = new Float32Array(new ArrayBuffer(a.fftSize * 4));
  a.getFloatTimeDomainData(buf);
  const step = Math.max(1, Math.floor(buf.length / out.length));
  for (let j = 0, i = 0; j < out.length; j++, i += step) out[j] = buf[i] ?? 0;
  return true;
}

/** Playback was stopped by the operator. Distinct from a failure on purpose: a stop must
 *  never trigger the "server voice failed, use the browser voice" fallback. */
export class SpeechStopped extends Error {
  constructor() { super("stopped"); this.name = "SpeechStopped"; }
}

/** Play a synthesized clip. Web Audio first (it survives the activation window), the
 *  <audio> element as the fallback for formats decodeAudioData cannot take. */
export async function playBlob(blob: Blob, signal?: AbortSignal): Promise<void> {
  const Ctor = audioContextCtor();
  if (Ctor) {
    try {
      audioCtx = audioCtx ?? new Ctor();
      if (audioCtx.state === "suspended") await audioCtx.resume();
      const buf = await audioCtx.decodeAudioData(await blob.arrayBuffer());
      await new Promise<void>((resolve, reject) => {
        const src = audioCtx!.createBufferSource();
        src.buffer = buf;
        // route through an analyser so the call UI can ride the real output — the voice
        // mode is worthless if the orb only fakes it from a timer
        const analyser = audioCtx!.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        analyser.connect(audioCtx!.destination);
        PLAYBACK.analyser = analyser;
        src.onended = () => { if (PLAYBACK.analyser === analyser) PLAYBACK.analyser = null; resolve(); };
        const abort = (): void => {
          if (PLAYBACK.analyser === analyser) PLAYBACK.analyser = null;
          try { src.stop(); } catch { /* already stopped */ }
          reject(new SpeechStopped());
        };
        if (signal) {
          if (signal.aborted) return abort();
          signal.addEventListener("abort", abort, { once: true });
        }
        src.start();
      });
      return;
    } catch (e) {
      if (e instanceof SpeechStopped) throw e;
      if (signal?.aborted) throw new SpeechStopped();
      // fall through to the element: a format the encoder produced but the decoder cannot take
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      const audio = new Audio(url);
      const abort = (): void => { try { audio.pause(); } catch { /* already paused */ } reject(new SpeechStopped()); };
      audio.onended = () => { cleanup(); resolve(); };
      audio.onerror = () => { cleanup(); reject(new Error("audio playback failed")); };
      const cleanup = (): void => { if (signal) signal.removeEventListener("abort", abort); };
      if (signal) {
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
      }
      void audio.play().catch((e) => { cleanup(); reject(new Error(String((e as Error)?.message ?? e))); });
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ------------------------------------------------------- streaming PCM player

/** Split text into the units fed to one `continue-task` frame.
 *
 *  This replaces the old 80-character chunking on the streaming path, and the difference is not
 *  cosmetic: the HTTP path had to cut the reply into whole clips, so a long sentence was split
 *  mid-clause and every cut was a request, a round trip and a possible voice change. The
 *  streaming protocol takes text incrementally and synthesises each complete sentence as it
 *  arrives, so the natural unit is the sentence — the first sound no longer waits for the rest
 *  of the paragraph, nor for an arbitrary character count.
 *
 *  Deliberately NOT reusing `splitForSpeech`: that one is tuned for "how much text one clip
 *  should hold" and its answer (80 chars) is exactly what we are getting rid of. */
export function splitForStream(text: string, max = STREAM_UNIT): string[] {
  const clean = text
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/[*_`#>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return [];

  const out: string[] = [];
  // Split on sentence ends FIRST — that is the unit the upstream synthesises and the reason the
  // first sound does not wait for the paragraph. A sentence that is still too long is then cut at
  // a clause, and only then at a space, so the synthesiser is never handed a phrase that starts
  // mid-word unless there is no alternative.
  const SENTENCE_END = /[。！？!?]|[.](?=\s|$)/g;
  let from = 0;
  for (const m of clean.matchAll(SENTENCE_END)) {
    const at = (m.index ?? 0) + m[0].length;
    const piece = clean.slice(from, at).trim();
    from = at;
    if (piece) out.push(...hardWrap(piece, max));
  }
  const tail = clean.slice(from).trim();
  if (tail) out.push(...hardWrap(tail, max));

  // A unit that is nothing but punctuation (a stray 「。」 from a stripped block) carries no
  // speech and would only start a task that produces no audio.
  return out.filter((u) => /[\p{L}\p{N}]/u.test(u));
}

/** Cut one sentence that is longer than `max` at a clause, then at a space, then anywhere. */
function hardWrap(piece: string, max: number): string[] {
  if (piece.length <= max) return [piece];
  const out: string[] = [];
  let rest = piece;
  while (rest.length > max) {
    const win = rest.slice(0, max);
    const clause = Math.max(win.lastIndexOf("，"), win.lastIndexOf(", "), win.lastIndexOf("；"), win.lastIndexOf("; "), win.lastIndexOf("、"));
    const space = win.lastIndexOf(" ");
    const at = clause > max * 0.4 ? clause + 1 : space > max * 0.4 ? space + 1 : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/** Playback of a live PCM stream.
 *
 *  Why not `playBlob` per sentence: the whole point of the streaming path is that the audio is
 *  already a continuous sample sequence, and re-entering an AudioBufferSourceNode per sentence
 *  puts the scheduling jitter of the JS thread between them (audible as a seam, and the reason
 *  the old path needed a prefetch queue to hide the gaps). Here every chunk is appended to one
 *  schedule: `nextAt` only ever moves forward by the exact duration of what was queued, so
 *  consecutive chunks are sample-contiguous no matter how they arrive.
 *
 *  The player owns its analyser so the call UI keeps riding the real output (playbackLevel /
 *  playbackRms / playbackWave), exactly as the one-shot path does. */
/** Unpack s16le mono PCM into the -1..1 floats a Web Audio buffer wants.
 *
 *  Separate and exported so it can be unit-tested without an AudioContext: the sign handling is
 *  the part that is easy to get subtly wrong (dividing by 0x8000 both ways clamps the positive
 *  full scale to 0.99997 and, worse, makes -32768 and +32767 asymmetric) and a wrong scale is
 *  audible as clipping rather than as an error. */
export function pcmS16leToFloat(pcm: ArrayBuffer, out: Float32Array): number {
  const view = new DataView(pcm);
  const n = Math.min(out.length, Math.floor(pcm.byteLength / 2));
  for (let i = 0; i < n; i++) {
    const v = view.getInt16(i * 2, true);            // little endian: the protocol's format
    out[i] = v < 0 ? v / 0x8000 : v / 0x7fff;
  }
  return n;
}

class PcmStreamPlayer {
  #ctx: AudioContext;
  #sampleRate: number;
  #analyser: AnalyserNode;
  #sources = new Set<AudioBufferSourceNode>();
  #nextAt = 0;
  #done = false;
  /** Resolvers waiting for everything queued so far to have played. */
  #drain: Array<() => void> = [];

  constructor(ctx: AudioContext, sampleRate: number) {
    this.#ctx = ctx;
    this.#sampleRate = sampleRate;
    this.#analyser = ctx.createAnalyser();
    this.#analyser.fftSize = 512;
    this.#analyser.connect(ctx.destination);
    PLAYBACK.analyser = this.#analyser;
  }

  /** Queue one frame of s16le mono PCM. */
  push(pcm: ArrayBuffer): void {
    if (this.#done) return;
    const samples = Math.floor(pcm.byteLength / 2);
    if (!samples) return;
    const buf = this.#ctx.createBuffer(1, samples, this.#sampleRate);
    pcmS16leToFloat(pcm, buf.getChannelData(0));
    const src = this.#ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.#analyser);
    const at = Math.max(this.#nextAt, this.#ctx.currentTime + STREAM_LEAD);
    src.start(at);
    this.#nextAt = at + buf.duration;
    this.#sources.add(src);
    src.onended = () => {
      this.#sources.delete(src);
      if (this.#sources.size === 0 && this.#done) this.#flushDrain();
    };
  }

  #flushDrain(): void {
    const waiting = this.#drain;
    this.#drain = [];
    // Never let one resolver throw past the others: the array is already emptied, so an
    // exception here would drop every remaining waiter on the floor and leave those promises
    // pending forever (and `finish()` is awaited by the speaker's queue).
    for (const fn of waiting) { try { fn(); } catch { /* a waiter's own problem */ } }
  }

  /** No more audio is coming: resolve once what was queued has actually been heard. */
  finish(): Promise<void> {
    this.#done = true;
    if (this.#sources.size === 0) { this.#cleanup(); return Promise.resolve(); }
    return new Promise<void>((resolve) => { this.#drain.push(resolve); });
  }

  /** Abandon playback immediately (operator pressed stop, or the call ended). */
  stop(): void {
    this.#done = true;
    for (const src of this.#sources) {
      try { src.stop(); } catch { /* already ended */ }
    }
    this.#sources.clear();
    this.#flushDrain();
    this.#cleanup();
  }

  #cleanup(): void {
    if (PLAYBACK.analyser === this.#analyser) PLAYBACK.analyser = null;
    try { this.#analyser.disconnect(); } catch { /* already gone */ }
  }
}

/** One relay connection, kept open across the sentences of a reply — and across replies.
 *
 *  Why it is not dialled per `speak()`: measured 2026-10-31 against the real endpoint, a NEW
 *  upstream socket costs 200-650 ms before the task starts (TLS + auth), while a task on an
 *  open socket starts in ~50 ms. Call mode hands the speaker one SENTENCE at a time, so
 *  per-sentence dialling would pay that back on every sentence and the streaming path would
 *  end up slower than the HTTP one it replaces.
 *
 *  So the connection outlives a run: `speak()` on an idle session just starts a new task on
 *  it. It closes itself after RELAY_IDLE_MS with nothing to say, and on any unrecoverable
 *  error, in which case the next `speak()` dials a fresh one. */
const RELAY_IDLE_MS = 20_000;

interface RelayRun {
  player: PcmStreamPlayer | null;
  heard: boolean;
  /** Has the server told us the output format for this task? Frames before that are unusable. */
  ready: boolean;
  resolve: () => void;
  reject: (e: Error) => void;
  /** Drop whatever this run attached to the socket (the `open` listener). */
  cleanup: () => void;
}

class TtsRelay {
  #ws: WebSocket;
  #ctx: AudioContext;
  #sampleRate: number;
  /** The rate actually being rendered: seeded from the capability, corrected by `tts-ready`. */
  #rate: number;
  #run: RelayRun | null = null;
  #failure: Error | null = null;
  #dead = false;
  #idleTimer = 0;

  constructor(ctx: AudioContext, sampleRate: number) {
    this.#ctx = ctx;
    this.#sampleRate = sampleRate;
    this.#rate = sampleRate;
    this.#ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/tts`);
    this.#ws.binaryType = "arraybuffer";
    this.#ws.onmessage = (ev: MessageEvent) => this.#onMessage(ev);
    this.#ws.onerror = () => { this.#failure = this.#failure ?? new Error("streaming TTS relay failed to connect"); };
    this.#ws.onclose = () => {
      this.#dead = true;
      window.clearTimeout(this.#idleTimer);
      this.#settleOrFail();
    };
  }

  get usable(): boolean {
    return !this.#dead && !this.#failure;
  }

  /** Settle whatever run is in flight because the connection is gone. */
  #settleOrFail(): void {
    const run = this.#run;
    if (!run) return;
    this.#run = null;
    if (this.#failure) {
      run.player?.stop();
      if (run.heard) run.resolve();
      else run.reject(this.#failure);
      return;
    }
    this.#settle(run);
  }

  #settle(run: RelayRun): void {
    const p = run.player;
    void (p ? p.finish() : Promise.resolve()).then(() => {
      if (this.#run === run) this.#run = null;
      run.resolve();
      this.#armIdle();
    });
  }

  #armIdle(): void {
    window.clearTimeout(this.#idleTimer);
    // A closed AudioContext cannot render anything: keeping the socket open would only burn a
    // server slot, so drop the relay in the same tick rather than at the idle deadline.
    if (this.#ctx.state === "closed") { this.close(); return; }
    this.#idleTimer = window.setTimeout(() => this.close(), RELAY_IDLE_MS);
  }

  #onMessage(ev: MessageEvent): void {
    const run = this.#run;
    if (typeof ev.data !== "string") {
      if (!run || !run.ready) return;      // late frames after a cancel, or before `tts-ready`
      run.player = run.player ?? new PcmStreamPlayer(this.#ctx, this.#rate);
      run.player.push(ev.data as ArrayBuffer);
      run.heard = true;
      return;
    }
    let msg: { t?: string; error?: string; why?: string; sampleRate?: number };
    try { msg = JSON.parse(ev.data) as typeof msg; } catch { return; }
    if (msg.t === "tts-ready") {
      // The server is the authority on the rate the provider actually produced: rendering at a
      // hardcoded 24 kHz is only right while the two agree.
      const rate = Number(msg.sampleRate);
      if (Number.isFinite(rate) && rate >= 8000 && rate <= 96000) this.#rate = rate;
      if (run) run.ready = true;
      return;
    }
    if (msg.t === "tts-done") {
      if (!run) return;
      this.#settle(run);
      return;
    }
    if (msg.t === "tts-error") {
      // Settle the run HERE, not on the close: the server may report a failed task and leave the
      // socket briefly open, and a run that never settles parks the caller forever — the lamp
      // sticks, the call sits in `speaking` with no audio, and the HTTP fallback never runs
      // (measured shape, found by review before release).
      this.#failure = new Error(msg.error ?? "streaming TTS failed");
      const failed = this.#run;
      if (failed) {
        this.#run = null;
        failed.player?.stop();
        // Before the first sample the caller can still fall back; after it, restarting the
        // sentence in another voice is worse than stopping.
        if (failed.heard) failed.resolve();
        else failed.reject(this.#failure);
      }
      this.close();
      return;
    }
    if (msg.t === "tts-closed") {
      // Belt and braces: the close event normally settles this, but a `tts-closed` that arrives
      // without one must not be able to strand a run.
      this.#failure = new Error(msg.why ?? msg.error ?? "streaming TTS closed");
      this.#settleOrFail();
    }
  }

  /** Speak `text` on this connection. Resolves once it has been heard. */
  speak(text: string, signal: AbortSignal, rate = 1): Promise<void> {
    if (!this.usable) return Promise.reject(this.#failure ?? new Error("streaming TTS relay is closed"));
    if (this.#ctx.state === "closed") {
      this.close();
      return Promise.reject(new Error("audio context closed"));
    }
    if (this.#run) this.cancel();        // one utterance at a time, like the speaker itself
    window.clearTimeout(this.#idleTimer);
    const units = splitForStream(text);
    if (!units.length) return Promise.resolve();

    let onAbort = (): void => { /* replaced below */ };
    const run: RelayRun = { player: null, heard: false, ready: false, resolve: () => {}, reject: () => {}, cleanup: () => {} };
    const heard = new Promise<void>((resolve, reject) => {
      run.resolve = resolve;
      run.reject = reject;
      this.#run = run;
      onAbort = (): void => {
        this.cancel();                   // releases #run and stops the PCM immediately
        reject(new SpeechStopped());
      };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
      const start = (): void => {
        // Only this run may speak: a stop pressed inside the 200-650 ms dial would otherwise
        // flush the cancelled sentence on `open` — synthesised, billed, and dropped (or, worse,
        // attributed to whatever reply was started in between).
        if (this.#run !== run) return;
        this.#send({ t: "tts-start", rate });
        for (const unit of units) this.#send({ t: "tts-say", text: unit });
        this.#send({ t: "tts-end" });
      };
      if (this.#ws.readyState === WebSocket.OPEN) start();
      else this.#ws.addEventListener("open", start, { once: true });
      run.cleanup = () => this.#ws.removeEventListener("open", start);
    });
    return heard.finally(() => {
      signal.removeEventListener("abort", onAbort);
      run.cleanup();
    });
  }

  #send(m: unknown): void {
    if (this.#ws.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(m));
  }

  /** Abandon what is playing. The CONNECTION stays open: the next sentence reuses it. */
  cancel(): void {
    const run = this.#run;
    this.#run = null;
    if (!run) return;
    run.player?.stop();
    if (this.#ws.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify({ t: "tts-cancel" }));
    run.resolve();
    this.#armIdle();
  }

  close(): void {
    window.clearTimeout(this.#idleTimer);
    this.cancel();
    this.#dead = true;
    try { this.#ws.close(); } catch { /* already gone */ }
  }
}

/** The single relay this page talks through, or null when streaming is off. */
let relay: TtsRelay | null = null;

function relayFor(ctx: AudioContext, sampleRate: number): TtsRelay {
  if (!relay || !relay.usable) {
    // Replace, but do not abandon: the old instance may still hold an open socket and its own
    // idle timer. Its `close()` is idempotent, and leaving it to GC would keep a /ws/tts
    // connection alive on the server for as long as the page lives.
    const stale = relay;
    relay = new TtsRelay(ctx, sampleRate);
    if (stale) { try { stale.close(); } catch { /* already gone */ } }
  }
  return relay;
}

/** Speak `text` through the /ws/tts relay.
 *
 *  Returns false when streaming is not on offer (setting off, or a provider with no streaming
 *  surface) so the caller can use the HTTP path unchanged. Throws when the relay was tried and
 *  failed before any audio was heard — that is the fallback the setting promises. */
async function speakStreaming(text: string, prefs: VoicePrefs, signal: AbortSignal): Promise<boolean> {
  const caps = voiceCaps().tts;
  if (!(prefs.serverTts && caps.server && caps.streaming)) return false;
  const Ctor = audioContextCtor();
  if (!Ctor) return false;
  audioCtx = audioCtx ?? new Ctor();
  if (audioCtx.state === "suspended") await audioCtx.resume();
  await relayFor(audioCtx, caps.sampleRate ?? 24000).speak(text, signal, prefs.rate);
  return true;
}

// ------------------------------------------------------------------- speaker

interface SpeakState {
  /** id of the message being read, or "clipboard"/null for an ad-hoc utterance */
  speakingId: string | null;
  speaking: boolean;
  error: string;
  /** server TTS is unavailable and we fell back to the browser */
  note: string;
}

function browserSpeechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

class Speaker {
  #state: SpeakState = { speakingId: null, speaking: false, error: "", note: "" };
  #listeners = new Set<() => void>();
  #abort: AbortController | null = null;
  /** Run token + stop flag. A stop() is NOT a failure. Without these the abort it raises
   *  came back as a rejected promise, speak()'s catch read it as "the server voice
   *  failed", and the documented browser fallback re-read the whole reply — i.e. pressing
   *  stop once more spoke it aloud with the system voice (operator report). The token also
   *  keeps an older run from clearing a newer run's state. */
  #run = 0;
  #stopped = false;
  #voices: SpeechSynthesisVoice[] = [];
  #voiceListeners = new Set<() => void>();

  subscribe = (fn: () => void): (() => void) => {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  };

  getSnapshot = (): SpeakState => this.#state;

  #set(patch: Partial<SpeakState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const fn of this.#listeners) fn();
  }

  /** Voices arrive asynchronously in Chromium; everyone who shows a picker needs
   *  to be told when the list is real. */
  subscribeVoices = (fn: () => void): (() => void) => {
    this.#voiceListeners.add(fn);
    return () => this.#voiceListeners.delete(fn);
  };

  voices = (): SpeechSynthesisVoice[] => this.#voices;

  /** The voice list is NOT ready at module load: Chromium populates it asynchronously and
   *  may fire `voiceschanged` seconds later (or only after speech is first used). Reading
   *  `getVoices()` once made the UI claim "no voices" on a browser with 200 of them —
   *  which is exactly what the operator saw. So: read, listen, AND poll briefly. */
  init(): void {
    if (!browserSpeechAvailable()) return;
    const load = (): void => {
      const next = window.speechSynthesis.getVoices();
      if (next.length === this.#voices.length) return;
      this.#voices = next;
      for (const fn of this.#voiceListeners) fn();
    };
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    let tries = 0;
    const poll = window.setInterval(() => {
      tries += 1;
      load();
      if (this.#voices.length || tries > 40) window.clearInterval(poll); // ~10s, then stop
    }, 250);
    // Safari fills the list on first interaction, and some Chromium builds only after a
    // user gesture: one extra read on the first tap costs nothing.
    window.addEventListener("pointerdown", load, { once: true });
  }

  /** The voice to use: the operator's pick, else the first one matching the language. */
  pickVoice(prefs: VoicePrefs): SpeechSynthesisVoice | null {
    const list = this.#voices.length ? this.#voices : (browserSpeechAvailable() ? window.speechSynthesis.getVoices() : []);
    if (!list.length) return null;
    if (prefs.voiceURI) {
      const exact = list.find((v) => v.voiceURI === prefs.voiceURI);
      if (exact) return exact;
    }
    const lang = prefs.lang.toLowerCase();
    const short = lang.split("-")[0];
    return (
      list.find((v) => v.lang.toLowerCase() === lang)
      ?? list.find((v) => v.lang.toLowerCase().startsWith(short))
      ?? list.find((v) => v.default)
      ?? list[0]
    );
  }

  /** Speak `text`. `id` labels the source so the UI can highlight the playing button. */
  async speak(text: string, id: string, prefs: VoicePrefs): Promise<void> {
    const body = String(text ?? "").trim();
    if (!body) return;
    this.stop();                       // stops playback AND marks the previous run stopped
    const run = ++this.#run;           // this run's token: stale runs must not write state
    this.#stopped = false;
    const caps = voiceCaps().tts;
    const onServer = prefs.serverTts && caps.server;
    // The streaming path feeds sentences and never needs the 80-character chunking: it exists
    // precisely because a cut mid-sentence used to be a whole round trip.
    const streaming = onServer && caps.streaming;
    const chunks = streaming ? [] : splitForSpeech(body, onServer ? SERVER_CHUNK : BROWSER_CHUNK);
    // The fallback needs the whole reply re-cut: `chunks` is empty precisely BECAUSE streaming was
    // chosen, so the catch below used to speak nothing and still claim it had switched voices.
    const fallbackChunks = (): string[] => (streaming ? splitForSpeech(body, SERVER_CHUNK) : chunks);
    if (!streaming && !chunks.length) return;
    const ctrl = new AbortController();   // one controller for the whole utterance
    this.#abort = ctrl;
    this.#set({ error: "", note: "", speakingId: id, speaking: true });
    try {
      let spoken = false;
      if (streaming) {
        try {
          spoken = await speakStreaming(body, prefs, ctrl.signal);
        } catch (e) {
          // A STOP is not a failure: let it reach the catch below, which returns quietly.
          if (this.#stopped || ctrl.signal.aborted || e instanceof SpeechStopped || (e as Error)?.name === "AbortError") throw e;
          // Anything else means the socket path is down for this utterance. Fall through to the
          // one-shot route: same provider, same voice, whole reply — which is what the setting
          // promises. Jumping straight to the browser voice here would silently swap the voice
          // the operator chose, which is a different product.
          this.#set({ note: `流式合成这一句失败了（${String((e as Error)?.message ?? e)}），已改用整句合成` });
        }
      }
      if (!spoken) {
        if (onServer) await this.#speakServer(fallbackChunks(), prefs, ctrl.signal);
        else await this.#speakBrowser(chunks, prefs, ctrl.signal);
      }
    } catch (e) {
      // A STOP is not a failure. Returning quietly here is the whole fix: the fallback
      // below is for a server that really failed, not for the operator pressing stop.
      if (this.#stopped || run !== this.#run || e instanceof SpeechStopped || (e as Error)?.name === "AbortError") {
        return;
      }
      // Server voice failed: the browser can still read it. Say so once, then do it.
      if (prefs.serverTts && browserSpeechAvailable()) {
        const rest = fallbackChunks();
        if (!rest.length) { this.#set({ error: String((e as Error)?.message ?? e) }); return; }
        this.#set({ note: `服务端语音这一句失败了（${String((e as Error)?.message ?? e)}），已改用浏览器语音` });
        try {
          await this.#speakBrowser(rest, prefs, ctrl.signal);
          return;
        } catch (e2) {
          if (this.#stopped || e2 instanceof SpeechStopped) return;
          this.#set({ error: String((e2 as Error)?.message ?? e2) });
        }
      } else {
        this.#set({ error: String((e as Error)?.message ?? e) });
      }
    } finally {
      if (this.#abort === ctrl) this.#abort = null;
      // only the current run may clear the lamp: a newer speak() owns the state now
      if (run === this.#run) this.#set({ speaking: false, speakingId: null });
    }
  }

  async #speakBrowser(chunks: string[], prefs: VoicePrefs, signal?: AbortSignal): Promise<void> {
    if (!browserSpeechAvailable()) throw new Error("this browser has no speech synthesis");
    const synth = window.speechSynthesis;
    const voice = this.pickVoice(prefs);
    for (const [i, chunk] of chunks.entries()) {
      if (signal?.aborted) throw new SpeechStopped();
      await new Promise<void>((resolve, reject) => {
        const u = new SpeechSynthesisUtterance(chunk);
        if (voice) { u.voice = voice; u.lang = voice.lang; } else { u.lang = prefs.lang; }
        u.rate = prefs.rate;
        u.onend = () => resolve();
        u.onerror = (ev) => reject(new Error(`speech error: ${(ev as SpeechSynthesisErrorEvent).error ?? "unknown"}`));
        synth.speak(u);
        // Safari/Chromium pause a long queue when the tab is backgrounded; resuming
        // here costs nothing and unsticks it.
        if (i === 0) synth.resume();
      });
      // cancel() ends the utterance we were awaiting; without this check the loop simply
      // moved on and spoke the NEXT chunk after a stop
      if (signal?.aborted) throw new SpeechStopped();
      if (synth.paused) synth.resume();
    }
  }

  /** One chunk of audio from the server, holding one of the provider's slots. */
  #fetchOnce(text: string, prefs: VoicePrefs, signal: AbortSignal | undefined, priority: number): Promise<Blob> {
    return withTtsSlot(priority, signal, async () => {
      const res = await fetch("/api/tts", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        signal,
        body: JSON.stringify({ text, speed: prefs.rate }),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({ error: `${res.status}` }))) as { error?: string };
        throw new Error(detail.error ?? `tts ${res.status}`);
      }
      return await res.blob();
    });
  }

  /** A clip that failed is re-asked in place. A throttled PREFETCH used to be remembered as a failed
   *  promise, so the sentence it belonged to fell back to the browser voice even though the service was
   *  healthy again by the time the clip was needed — one extra round trip is far better than a voice
   *  that changes in the middle of a reply. */
  async #fetchAudio(text: string, prefs: VoicePrefs, signal?: AbortSignal, priority = TTS_PRIORITY_NOW): Promise<Blob> {
    let last: unknown = null;
    for (let attempt = 0; attempt <= TTS_RETRIES; attempt++) {
      if (signal?.aborted) throw new SpeechStopped();
      try {
        return await this.#fetchOnce(text, prefs, signal, priority);
      } catch (e) {
        if (e instanceof SpeechStopped || (e as Error)?.name === "AbortError" || signal?.aborted) throw e;
        last = e;
        if (attempt < TTS_RETRIES) await new Promise((r) => { window.setTimeout(r, TTS_RETRY_MS * (attempt + 1)); });
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  /** Audio that was generated ahead of time, keyed by rate + voice + text. Invalidating on
   *  voice/rate means a settings change can never be heard as the previous voice. */
  #pre = new Map<string, Promise<Blob>>();

  #preKey(text: string, prefs: VoicePrefs): string {
    return `${prefs.rate}|${voiceCaps().tts.voice ?? ""}|${text}`;
  }

  /** Generate the audio for something that is about to be spoken — the CALL uses this on the
   *  next sentence while the current one is playing, which is where its inter-sentence silence
   *  came from. Deliberately not tied to a run's AbortSignal: the cache outlives the sentence
   *  that happened to ask for it. */
  prefetch(text: string, prefs: VoicePrefs): void {
    // The browser voice fetches nothing, and neither does a healthy streaming path: it feeds
    // the sentences into one live task, so a clip fetched ahead of time would be a second
    // synthesis of text that is then never played from it — billed, and useless. A relay that
    // has already failed is excluded on purpose: the sentences behind it fall back to HTTP,
    // and those DO need warming.
    if (voiceCaps().tts.streaming && relay?.usable !== false) return;
    if (!(prefs.serverTts && voiceCaps().tts.server)) return;   // the browser voice fetches nothing
    const body = String(text ?? "").trim();
    if (!body) return;
    for (const chunk of splitForSpeech(body, SERVER_CHUNK)) {
      const key = this.#preKey(chunk, prefs);
      if (this.#pre.has(key)) continue;
      const p = this.#fetchAudio(chunk, prefs, undefined, TTS_PRIORITY_AHEAD);
      p.catch(() => { /* awaited later if it is needed; a stray prefetch must not warn */ });
      this.#pre.set(key, p);
      while (this.#pre.size > PRE_CACHE_MAX) {
        const oldest = this.#pre.keys().next().value;
        if (oldest === undefined) break;
        this.#pre.delete(oldest);
      }
    }
  }

  /** Chunks are requested AHEAD of the playback: sequentially, the cost of the next sentence
   *  (generate + transfer + decode) was paid as silence BETWEEN them, which measured 0.5–3.3 s
   *  per gap and is what "播报很慢" actually was. */
  async #speakServer(chunks: string[], prefs: VoicePrefs, signal: AbortSignal): Promise<void> {
    const queue: Promise<Blob>[] = [];
    const take = (text: string): Promise<Blob> => {
      const key = this.#preKey(text, prefs);
      const hit = this.#pre.get(key);
      if (hit) {
        this.#pre.delete(key);
        // A prefetch can have been throttled while it was generated AHEAD of time, in which case it is
        // remembered as a failed promise — the service may well be healthy by the time the clip is
        // needed. Re-ask (bounded) rather than letting this sentence change voice.
        return hit.catch(() => this.#fetchAudio(text, prefs, signal, TTS_PRIORITY_NOW));
      }
      const p = this.#fetchAudio(text, prefs, signal, TTS_PRIORITY_NOW);
      p.catch(() => { /* awaited below: the catch here only marks it handled */ });
      return p;
    };
    for (let i = 0; i < chunks.length; i++) {
      if (signal.aborted) throw new SpeechStopped();
      while (queue.length < Math.min(SPEAK_AHEAD, chunks.length - i)) {
        queue.push(take(chunks[i + queue.length]));
      }
      await playBlob(await (queue.shift() as Promise<Blob>), signal);
      if (signal.aborted) throw new SpeechStopped();
    }
  }

  stop(): void {
    this.#stopped = true;              // marks the in-flight run: do NOT fall back, do not error
    relay?.cancel();                   // streaming PCM stops here; the connection stays open
    this.#abort?.abort();
    this.#abort = null;
    // Web Audio playback stops through the abort signal above; the browser voice needs
    // its own cancel.
    if (browserSpeechAvailable()) window.speechSynthesis.cancel();
    if (this.#state.speaking) this.#set({ speaking: false, speakingId: null });
  }
}

export const speaker = new Speaker();
speaker.init();

export function useSpeaker(): SpeakState {
  return useSyncExternalStore(speaker.subscribe, speaker.getSnapshot);
}

/** Auto-read plumbing: which message ids were already read aloud, so a re-render, a history load or
 *  a second hook instance never re-reads the same reply. This used to be a single slot — one turn
 *  split by tool calls produces SEVERAL agent messages, and one slot meant only the last of them was
 *  ever spoken while the earlier paragraphs were dropped for good (issue #67). */
const readKeys = new Set<string>();
const READ_KEYS_MAX = 1024;

/** One speaker, one segment at a time — and the queue holds only the NEWEST waiting segment.
 *  `speakQueue.ts` owns that rule: never cut the sentence being played, but a paragraph that has
 *  not started yet is stale the moment a newer one lands, so it is dropped instead of being read
 *  late (the operator's rule: 1 is playing, 2 and 3 arrive, 1 finishes → read 3, skip 2). */
const readQueue = createSpeakQueue((seg) => speaker.speak(seg.text, seg.key, prefsState));

export type { ReadTarget };

/** The operator is about to speak, or sent a new message: the playback stops NOW and the segment
 *  waiting behind it is dropped (issue #66). It is called from ONE place per entry point
 *  — `Dictation.start()` and the composer's send — rather than from every button's onClick, because
 *  the next recording entry point (a global shortcut, a phone button) must not have to remember it.
 *  Nothing about the new turn is suppressed: its messages carry new keys and queue up normally. */
export function hushSpeech(): void {
  readQueue.hush();
  speaker.stop();
}

function enqueueRead(target: ReadTarget): void {
  readQueue.push({ key: target.key, text: target.text });
}

/** A call is open (CallMode) → it owns the voice: it reads the reply sentence by sentence,
 *  and the auto-read of the SAME reply would preempt it mid-sentence (one speaker, two
 *  owners) — which sounds like the answer being read again from the beginning. */
let callActive = false;

export function setCallActive(on: boolean): void {
  callActive = on;
}

export function isCallActive(): boolean {
  return callActive;
}

/** Whether this message may be read. `enabled` is the level RESOLVED for this session (#68) — not
 *  the global `prefs.autoRead` mirror, which is only the default layer: a session whose horn was
 *  turned on must not be silenced by a global that is still "off". */
export function shouldAutoRead(key: string, isNewTurn: boolean, enabled: boolean): boolean {
  if (callActive) return false;
  if (!enabled || !isNewTurn) return false;
  if (readKeys.has(key)) return false;
  readKeys.add(key);
  // Bounded: a long-lived tab reads thousands of messages and this must not grow forever.
  while (readKeys.size > READ_KEYS_MAX) {
    const oldest = readKeys.values().next().value;
    if (oldest === undefined) break;
    readKeys.delete(oldest);
  }
  return true;
}

// ----------------------------------------------------------------- dictation

/** Which composer the transcript belongs to (see `Dictation.setOwner`): two of them are mounted at
 *  once while the new-session dialog is up, and only one may take the words. */
export type DictSink = "chat" | "start";

export interface DictationState {
  /** `requesting` = we asked for the microphone and the browser has not answered yet
   *  (its permission prompt is modal, so without this state the button looks dead). */
  status: "idle" | "requesting" | "listening" | "recording" | "transcribing" | "error";
  /** words the recogniser has already committed */
  text: string;
  /** the words it is still unsure about — shown greyed, appended on stop */
  interim: string;
  error: string;
  /** which engine actually ran, for the UI's "browser / stream / server" label */
  engine: "browser" | "stream" | "server" | null;
  /** seconds of audio captured (server path) */
  seconds: number;
}

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
};

function recognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function browserDictationAvailable(): boolean {
  return Boolean(recognitionCtor());
}

/** The Android app's native microphone, injected as `window.AgentusMic`.
 *
 *  It only exists inside the Agentus companion app, and only for a page that is one of the
 *  operator's saved servers (the app checks). When it is there, the page records with it instead of
 *  getUserMedia: Chromium's own capture never opens on that ROM, while the app's AudioRecord does. */
interface NativeMicBridge {
  available(): boolean;
  /** "ok" | "already" | "permission" | "denied" | "error: …" */
  start(rate: number): string;
  stop(): void;
}

function bridgeMic(): NativeMicBridge | null {
  const b = (window as unknown as { AgentusMic?: NativeMicBridge }).AgentusMic;
  return b && typeof b.start === "function" && typeof b.stop === "function" ? b : null;
}

export function nativeMicAvailable(): boolean {
  const b = bridgeMic();
  if (!b) return false;
  try {
    return Boolean(b.available());
  } catch {
    return false;
  }
}

/** Can this page capture audio at all — the app's native microphone, or the browser's own
 *  `getUserMedia`? An INSECURE ORIGIN (plain `http://` on a LAN IP) hides `navigator.mediaDevices`
 *  entirely; that is the browser's rule, not ours (measured 2026-10-08: on `http://<lan-ip>:8788`
 *  it is `undefined`, while `localhost` and the https entry have it). */
export function micCaptureAvailable(): boolean {
  return nativeMicAvailable() || typeof navigator.mediaDevices?.getUserMedia === "function";
}

/** Why the microphone is unavailable, in terms the operator can act on. The old text
 *  ("this browser cannot record audio") blamed the browser for what is an ORIGIN problem — the
 *  operator's report was exactly that error on a LAN page whose browser was fine. */
export function micUnavailableMessage(): string {
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return "当前页面是明文 http，浏览器不允许网页录音。请改用 https 入口访问（在服务前放一层终结 TLS 的反代或隧道），或走本机 localhost；手机上也可以用 Agentus app。";
  }
  return "this browser cannot record audio";
}

/** Open the device's own recorder and hand back the finished file, or null when dismissed.
 *  `<input capture>` needs no secure context — it is the one microphone-shaped door left open on
 *  a plain-http origin. On mobile it records; on a desktop it degrades to picking an audio file. */
function pickAudioFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*";
    input.setAttribute("capture", "microphone");
    input.style.position = "fixed";
    input.style.left = "-9999px";
    let settled = false;
    const done = (f: File | null): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(f);
    };
    input.onchange = () => done(input.files?.[0] ?? null);
    // A dismissed picker fires no `change`; the window coming back is the only signal.
    window.addEventListener("focus", () => { window.setTimeout(() => done(input.files?.[0] ?? null), 600); }, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

class Dictation {
  #state: DictationState = { status: "idle", text: "", interim: "", error: "", engine: null, seconds: 0 };
  #listeners = new Set<() => void>();
  #rec: SpeechRecognitionLike | null = null;
  #media: MediaRecorder | null = null;
  #chunks: Blob[] = [];
  #timer: number | null = null;
  // streaming path (/ws/asr): a PCM capture graph plus the relay socket
  #ws: WebSocket | null = null;
  #ctx: AudioContext | null = null;
  #proc: ScriptProcessorNode | null = null;
  #mic: MediaStream | null = null;
  /** The app's native microphone when the page is using it instead of getUserMedia. */
  #bridge: NativeMicBridge | null = null;
  #committed = "";
  /** Live amplitude 0..1 with a fast attack / slow release, plus a rolling snapshot of the
   *  newest samples. The voice-mode orb reads both every frame (never through React). */
  #level = 0;
  /** The SAME measurement in its own units: RMS of the input, 0..1, no ×6 boost.
   *
   *  Two scales exist on purpose and must not be mixed: `#level` is the orb's animation value
   *  (boosted and clamped so a normal voice fills the ring), while the barge gate has to compare
   *  the microphone to what we are PLAYING (`playbackRms`) — that comparison only means anything
   *  in real amplitude. Comparing the boosted, clamped values is how the gate ended up unable to
   *  fire at all: a loud reply clamped BOTH meters at 1.0, and 0.45 × 1.0 stayed above any voice. */
  #rms = 0;
  #wave = new Float32Array(256);
  /** Set while a call wants its 16 kHz frames scored (see `setVadTap`). */
  #vadTap: ((samples: Float32Array) => void) | null = null;
  #relay = true;
  /** The streaming path's own coordinates, kept so a dead socket can be REPLACED without
   *  rebuilding the capture: the call holds the microphone for minutes, and the upstream ends a
   *  task that has heard nothing for ~23 s. */
  #sessionId?: string;
  /** true while the streaming path owns the microphone (set by #startStream, cleared by #closeStream) */
  #streaming = false;
  /** Capture-start generation (issue #51). A start() call is a chain of awaits — the permission
   *  prompt alone can sit open for minutes — and the operator may hang up in the middle of it. Every
   *  start takes a ticket; stop()/cancel() bump the counter, so whichever await resolves afterwards
   *  can see that nobody wants this microphone any more and hand the device back instead of parking an
   *  orphan stream on `#mic` (Chromium keeps the tab's recording badge lit for exactly that stream). */
  #gen = 0;
  /** frames captured while the socket (re)connects — one buffer for the CURRENT socket */
  #pending: ArrayBuffer[] = [];
  #reopen: number | null = null;
  #tries = 0;
  /** The last thing the relay said on its way out, kept for when the retries are exhausted —
   *  a hiccup that heals itself must not paint an error the operator has to dismiss. */
  #relayError = "";
  /** true when the END was ours (stop / the call's turn is over): a normal finish, not a failure. */
  #asked = false;

  /** Test seam — automation has no microphone, and the call's thresholds (how loud a
   *  barge-in must be, how long a silence ends a sentence, how short an utterance may be)
   *  are only observable by driving a level and a transcript through the real loop.
   *  `window.__asFeed = { level, text, interim }` makes start() succeed with no device and
   *  makes level()/getSnapshot() report exactly that. The product never sets it, and with
   *  nothing set every branch below is the plain microphone path. */
  #feed = (): { level?: number; rms?: number; text?: string; interim?: string } | null => {
    const f = (globalThis as { __asFeed?: unknown }).__asFeed;
    return f && typeof f === "object" ? (f as { level?: number; rms?: number; text?: string; interim?: string }) : null;
  };
  /** Live microphone amplitude 0..1 — read per animation frame. */
  level = (): number => {
    const f = this.#feed();
    if (!f) return this.#level;
    const n = Number(f.level);
    return Number.isFinite(n) ? n : 0;
  };
  /** Live microphone RMS 0..1 — the same frame, in real amplitude (see `#rms`). */
  levelRms = (): number => {
    const f = this.#feed();
    if (!f) return this.#rms;
    const n = Number(f.rms ?? (Number.isFinite(Number(f.level)) ? Number(f.level) / 6 : NaN));
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  };
  /** Newest input snapshot for the waveform (a flat line while not capturing). */
  wave = (): Float32Array => this.#wave;
  /** Hand every 16 kHz microphone frame to a detector (the call's Silero VAD).
   *  A tap, not a stored queue: the detector owns its own buffering, and a call that hangs up leaves
   *  nothing behind once the sink is nulled. */
  setVadTap = (fn: ((samples: Float32Array) => void) | null): void => { this.#vadTap = fn; };
  /** While false the mic stays OPEN (levels keep flowing, barge-in keeps working) but PCM
   *  is not relayed to the recogniser — the call speaks without feeding our own TTS back
   *  into the ASR.
   *
   *  The relay SOCKET lives exactly as long as the operator's turn does. The upstream recogniser
   *  finalises a task that has heard nothing for ~23 s, and a call parks one socket per turn while
   *  it reads a reply out loud — so the socket that was opened to hear the operator dies while the
   *  agent is still talking, and the microphone comes back attached to nothing. Closing it here is
   *  also the shape the relay was built on: one socket = one utterance. */
  setRelay(on: boolean): void {
    this.#relay = on;
    if (!on) {
      this.#asked = true;
      this.#closeSocket();
      return;
    }
    this.#asked = false;
    if (this.#streaming) this.#openRelay();
  }

  /** Drop the relay socket only. The capture graph stays up: levels, barge-in and the call's
   *  orb all read the microphone, not the socket. */
  #closeSocket(): void {
    if (this.#reopen !== null) {
      window.clearTimeout(this.#reopen);
      this.#reopen = null;
    }
    const ws = this.#ws;
    this.#ws = null;
    this.#pending.length = 0;
    if (!ws) return;
    // A socket we closed on purpose must never write again: `close()` is a handshake, and frames
    // already queued in the event loop still fire their handler. That is how the call's own words
    // (keyword mode keeps the recogniser running while the reply plays) landed in the transcript
    // AFTER a hang-up had already cleared it — and then in the chat composer.
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* already gone */
    }
  }
  /** Start a fresh listening turn without rebuilding the capture graph. */
  resetText(): void {
    this.#committed = "";
    this.#set({ text: "", interim: "" });
  }

  /** QA only (see `__asFeed` / `__asMic`): put a FINISHED sentence into the shared transcript,
   *  exactly where `asr-final` + `asr-done` leave it. The call and the chat composer share this
   *  object, so this is how a sweep proves that what the microphone heard during a call cannot
   *  surface in the composer afterwards — no recogniser credentials needed. */
  commitForTest(text: string): void {
    this.#committed = `${this.#committed}${text}`.replace(/\s+/g, " ").trim();
    this.#set({ status: "idle", text: this.#committed, interim: "" });
  }

  #measure(chan: Float32Array): void {
    let sum = 0;
    for (let i = 0; i < chan.length; i++) sum += chan[i] * chan[i];
    const rms = Math.sqrt(sum / chan.length);
    // speech sits around 0.02–0.2 RMS; ×6 + clamp puts normal speech near the top
    const target = Math.min(1, rms * 6);
    // fast attack, slow release: snap to a syllable, settle gently — a symmetric filter
    // makes the orb look like a level meter instead of something alive
    this.#level = target > this.#level
      ? this.#level + (target - this.#level) * 0.6
      : this.#level * 0.72 + target * 0.28;
    // …and the same frame in real units, smoothed the same way, for the barge gate
    this.#rms = rms > this.#rms ? this.#rms + (rms - this.#rms) * 0.6 : this.#rms * 0.72 + rms * 0.28;
    // The detector wants the FULL 16 kHz frame, not the downsampled display waveform: Silero's own
    // frame is 512 samples, and feeding it every other sample is how a detector invents a cadence.
    this.#vadTap?.(chan);
    const step = Math.max(1, Math.floor(chan.length / this.#wave.length));
    for (let j = 0, i = 0; j < this.#wave.length && i < chan.length; j++, i += step) this.#wave[j] = chan[i];
  }

  subscribe = (fn: () => void): (() => void) => {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  };

  /** The fed snapshot is CACHED: useSyncExternalStore compares snapshots by identity, and a
   *  fresh object per call is an infinite render loop (the page mounts, React bails out and
   *  the tree comes back empty — which is exactly how this seam first broke the QA tab). A
   *  test seam has to honour the same contracts as the real path. */
  #fedSnap: DictationState | null = null;
  getSnapshot = (): DictationState => {
    const f = this.#feed();
    if (!f) return this.#state;
    const text = String(f.text ?? "");
    const interim = String(f.interim ?? "");
    const cur = this.#fedSnap;
    if (cur && cur.text === text && cur.interim === interim
      && cur.status === this.#state.status && cur.error === this.#state.error
      && cur.engine === this.#state.engine && cur.seconds === this.#state.seconds) {
      return cur;
    }
    this.#fedSnap = { ...this.#state, text, interim };
    return this.#fedSnap;
  };

  #set(patch: Partial<DictationState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const fn of this.#listeners) fn();
  }

  /** Begin dictation. Returns false (with `error` set) when nothing can run it.
   *  `sessionId` is what lets the recogniser carry this conversation's hotwords. */
  async start(prefs: VoicePrefs, sessionId?: string): Promise<boolean> {
    if (this.#state.status !== "idle" && this.#state.status !== "error") return false;
    // Starting to talk takes the room: playback stops at once and unread segments are dropped
    // (#66). Done HERE, not in each button's onClick — the chat page's microphone button, the
    // hold-Ctrl keyboard entry and any future recorder all come through this door, and the call
    // page already stopped the speaker at five separate points to get the same thing.
    hushSpeech();
    // This start owns the microphone until something newer (a stop, a cancel, another start) takes the
    // ticket. Every await below is a place the operator can change his mind (#51).
    const gen = ++this.#gen;
    this.#set({ status: "idle", text: "", interim: "", error: "", seconds: 0 });
    this.#committed = "";
    const fed = this.#feed();
    if (fed) {
      // automation: no device, no socket — the injected signal is the microphone
      this.#relay = true;
      this.#set({ status: "listening", engine: "stream", error: "", text: String(fed.text ?? ""), interim: String(fed.interim ?? "") });
      return true;
    }
    const want = prefs.stt;
    const serverOk = voiceCaps().stt.server;
    const streamOk = voiceCaps().stt.streaming;
    const useBrowser = (want === "browser" || want === "auto") && browserDictationAvailable();
    try {
      // "auto" prefers the configured stream: the operator picked those models, wrote
      // the key and the hotword list — the browser engine knows none of that.
      if (want === "stream" || (want === "auto" && streamOk)) {
        if (!streamOk) throw new Error("streaming STT is not configured on the server (settings → 语音)");
        await this.#startStream(prefs, sessionId, gen);
        return true;
      }
      if (useBrowser) {
        this.#startBrowser(prefs);
        return true;
      }
      if (serverOk) {
        await this.#startServer(prefs, gen);
        return true;
      }
      this.#set({
        status: "error",
        engine: null,
        error: (typeof window !== "undefined" && !window.isSecureContext && !micCaptureAvailable()
          ? `${micUnavailableMessage()} `
          : "")
          + (want === "server" || serverOk
            ? "no dictation available: this browser has no speech recognition and the server has no STT endpoint (AGENTUS_STT_BASE_URL)"
            : "no dictation available in this browser — set the server STT endpoint or use Chromium/Edge"),
      });
      return false;
    } catch (e) {
      // An abandoned start (#51) failing on its way out is not an error the operator should see.
      if (this.#stale(gen)) return false;
      this.#set({ status: "error", error: String((e as Error)?.message ?? e) });
      return false;
    }
  }

  #startBrowser(prefs: VoicePrefs): void {
    const Ctor = recognitionCtor();
    if (!Ctor) throw new Error("speech recognition unavailable");
    const rec = new Ctor();
    rec.lang = prefs.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let committed = "";
    rec.onstart = () => this.#set({ status: "listening", engine: "browser", error: "" });
    rec.onresult = (ev: any) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
        const r = ev.results[i];
        const alt = r[0]?.transcript ?? "";
        if (r.isFinal) committed += alt;
        else interim += alt;
      }
      this.#set({ text: committed.trim(), interim: interim.trim() });
    };
    rec.onerror = (ev: any) => {
      const code = String(ev?.error ?? "unknown");
      this.#set({
        status: "error",
        error: code === "not-allowed" || code === "service-not-allowed"
          ? "microphone permission denied"
          : code === "no-speech"
            ? "heard nothing — try again closer to the microphone"
            : `speech recognition failed: ${code}`,
      });
    };
    rec.onend = () => {
      // Chromium ends the session on its own after a silence; report idle so the
      // button does not lie about being still on.
      if (this.#state.status === "listening") this.#set({ status: "idle", interim: "" });
      this.#rec = null;
    };
    this.#rec = rec;
    // Say "requesting" before start(): the permission prompt is modal, and a button
    // that shows nothing while it is up reads as broken.
    this.#set({ status: "requesting", engine: "browser" });
    try {
      rec.start();
    } catch (e) {
      this.#rec = null;
      throw new Error(String((e as Error)?.message ?? e));
    }
  }

  /** Live streaming recognition through the cockpit's own relay (/ws/asr). Unlike the
   *  browser engine, the same connection carries the operator's hotwords and the model
   *  they configured — and unlike the batch path, words appear as they are spoken. */
  async #startStream(prefs: VoicePrefs, sessionId: string | undefined, gen: number): Promise<void> {
    const bridge = nativeMicAvailable() ? bridgeMic() : null;
    if (!bridge && typeof navigator.mediaDevices?.getUserMedia !== "function") {
      // No live capture — an insecure origin (plain http on a LAN IP) hides `getUserMedia`.
      // The device's own recorder is the only door left; take it instead of refusing.
      await this.#startFileCapture(prefs);
      return;
    }
    const Ctor = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!bridge && !Ctor) throw new Error("this browser cannot process audio");
    // Ask for the microphone after saying we are waiting (the prompt is modal, QA R53).
    this.#set({ status: "requesting", engine: "stream", error: "" });
    this.#relay = true;          // a fresh capture always relays until the call says otherwise
    this.#asked = false;
    this.#tries = 0;
    this.#relayError = "";
    this.#sessionId = sessionId;
    this.#streaming = true;
    this.#pending.length = 0;
    // The socket comes FIRST, before the source: the source starts pushing frames the moment it is
    // open, and a frame with nowhere to go is a word the operator said that nothing heard.
    this.#openRelay();
    /** One place where a captured frame leaves the page, whichever source produced it — and
     *  whichever socket is current, since a dead one is replaced without touching the source. */
    const send = (frame: ArrayBuffer): void => this.#sendFrame(frame);
    if (bridge) await this.#startBridgeCapture(bridge, send, gen);
    else await this.#startWebCapture(Ctor, send, gen);
    // The permission prompt could have been answered long after the operator hung up. Nobody wants this
    // microphone now: hand it back instead of arming a relay and a timer for a call that is gone (#51).
    if (this.#stale(gen)) {
      this.#releaseCapture();
      this.#closeStream();
      this.#set({ status: "idle", interim: "", text: "" });
      return;
    }
    this.#set({ status: "listening", engine: "stream", seconds: 0 });
    this.#timer = window.setInterval(() => this.#set({ seconds: this.#state.seconds + 1 }), 1000);
  }

  /** One frame out of the page: straight to the socket when it is open, into the buffer while it
   *  is still connecting. A frame is a word the operator said, so it is never dropped on purpose
   *  while the relay gate is on. */
  #sendFrame(frame: ArrayBuffer): void {
    const ws = this.#ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(frame);
    else if (this.#pending.length < RELAY_PENDING_MAX) this.#pending.push(frame);
  }

  /** (Re)create the relay socket. Idempotent: a live socket is left alone.
   *
   *  A socket is replaced only while the operator still has the floor (`#relay`) and WE did not ask
   *  for the end (`#asked`) — the call's own turn-end closes it deliberately, and a normal end is
   *  not a failure to recover from. The retry ladder exists so a real outage still says so instead
   *  of retrying forever. */
  #openRelay(): void {
    if (this.#ws || !this.#streaming) return;
    const q = this.#sessionId ? `?sessionId=${encodeURIComponent(this.#sessionId)}` : "";
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/asr${q}`);
    ws.binaryType = "arraybuffer";
    this.#ws = ws;
    ws.onopen = () => {
      this.#tries = 0;
      this.#relayError = "";
      for (const buf of this.#pending) ws.send(buf);
      this.#pending.length = 0;
      if (this.#state.status !== "listening") this.#set({ status: "listening", engine: "stream", error: "" });
    };
    ws.onmessage = (ev: MessageEvent) => {
      let msg: { t?: string; text?: string; error?: string };
      try {
        msg = JSON.parse(String(ev.data)) as typeof msg;
      } catch {
        return;
      }
      if (msg.t === "asr-partial") this.#set({ interim: String(msg.text ?? "") });
      else if (msg.t === "asr-final") {
        this.#committed = `${this.#committed}${msg.text ?? ""}`.replace(/\s+/g, " ").trim();
        this.#set({ text: this.#committed, interim: "" });
      } else if (msg.t === "asr-error") {
        // The task died upstream (an idle ~23 s task, a provider refusal). The socket is next, so
        // this is a RELAY outage to recover from, not a transcript failure to paint.
        this.#relayGone(String(msg.error ?? "streaming asr failed"));
      } else if (msg.t === "asr-done") {
        if (this.#asked || !this.#streaming || !this.#relay) this.#finishStream();
        else this.#relayGone("the recogniser ended the turn by itself");
      }
    };
    ws.onerror = () => this.#relayGone("the streaming socket failed — is the server up?");
    ws.onclose = () => {
      if (this.#ws === ws) this.#ws = null;
      this.#relayGone(this.#relayError || "the streaming socket failed — is the server up?");
    };
  }

  /** The relay is gone. Reopen it while the operator still has the floor; say so when it will not
   *  come back. A socket that died with the relay OFF is our own doing (the call's turn ended) and
   *  costs nothing. */
  #relayGone(why: string): void {
    if (!this.#streaming || this.#asked || !this.#relay) return;
    if (!this.#relayError) this.#relayError = why;
    if (this.#reopen !== null) return;                 // already queued
    if (this.#tries >= RELAY_REOPEN_TRIES) {
      this.#set({ status: "error", error: this.#relayError });
      this.#relayError = "";
      this.#finishStream();
      return;
    }
    this.#tries += 1;
    this.#reopen = window.setTimeout(() => {
      this.#reopen = null;
      this.#openRelay();
    }, RELAY_REOPEN_MS * this.#tries);
  }

  /** The page's own capture: getUserMedia → graph → 16 kHz mono s16le. */
  async #startWebCapture(Ctor: typeof AudioContext, send: (frame: ArrayBuffer) => void, gen: number): Promise<void> {
    const mic = await openMic({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    // The operator may have hung up while the permission prompt was up. Taking the ticket check BEFORE
    // `#mic` is assigned is the whole fix for #51's leak A: once this stream is on `#mic` after a
    // cancel, no stop() will ever look for it again and the tab keeps its recording badge.
    if (this.#stale(gen)) {
      for (const t of mic.getTracks()) t.stop();
      return;
    }
    this.#mic = mic;
    // 16 kHz mono s16le is what the model takes. Ask the context for 16 kHz (Chromium
    // honours it) and resample when the browser insists on 44.1/48 kHz (Safari).
    const ctx = new Ctor({ sampleRate: 16000 });
    this.#ctx = ctx;
    const src = ctx.createMediaStreamSource(mic);
    // ScriptProcessor is deprecated but universally available, which matters more here
    // than the AudioWorklet's tidier lifecycle: this runs for one utterance.
    const proc = ctx.createScriptProcessor(2048, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0; // keeps the graph pulled without echoing the mic to the speakers
    this.#proc = proc;
    proc.onaudioprocess = (ev: AudioProcessingEvent) => {
      const raw = ev.inputBuffer.getChannelData(0);
      // the call UI's only source of live input: measured BEFORE the relay gate, so the
      // orb still moves and barge-in still fires while we are speaking
      this.#measure(raw);
      if (!this.#relay) return;
      const pcm = resampleToPcm16(raw, ctx.sampleRate, 16000);
      if (!pcm.length) return;
      // typed arrays are generic over ArrayBufferLike in TS; a fresh Int16Array's buffer
      // is always a plain ArrayBuffer
      send(pcm.buffer as ArrayBuffer);
    };
    src.connect(proc);
    proc.connect(mute);
    mute.connect(ctx.destination);
  }

  /** The app's own AudioRecord, into the very same relay.
   *
   *  Why: on this device the WebView's own capture will not open at all — `NotReadableError:
   *  Could not start audio source` after 18 granted page requests — while the app's plain
   *  AudioRecord records fine. The bridge hands the page 16 kHz mono s16le frames instead, so the
   *  socket, the level, the relay gate and the transcripts stay exactly as they are. */
  async #startBridgeCapture(bridge: NativeMicBridge, send: (frame: ArrayBuffer) => void, gen: number): Promise<void> {
    let status = "permission";
    for (let attempt = 0; attempt < 12; attempt++) {
      status = String(bridge.start(16000));
      if (status === "ok" || status === "already") break;
      if (status === "permission") {
        // The app raised its own RECORD_AUDIO dialog; keep asking until it is answered.
        this.#set({ status: "requesting", engine: "stream" });
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }
      throw new Error(`手机上的原生麦克风打不开（${status}）`);
    }
    if (status !== "ok" && status !== "already") throw new Error(`手机上的原生麦克风打不开（${status}）`);
    // Same ticket check as the web path (#51): the app's own dialog can be answered after the call is
    // over, and an AudioRecord left running keeps the device's microphone indicator on.
    if (this.#stale(gen)) {
      try {
        bridge.stop();
      } catch {
        /* the app is gone */
      }
      return;
    }
    this.#bridge = bridge;
    (window as unknown as { __asMic?: (b64: string) => void }).__asMic = (b64: string): void => {
      const bin = atob(b64);
      const n = bin.length >> 1;
      const pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        const lo = bin.charCodeAt(2 * i);
        const hi = bin.charCodeAt(2 * i + 1);
        pcm[i] = ((hi << 8) | lo) << 16 >> 16;
      }
      const level = new Float32Array(n);
      for (let i = 0; i < n; i++) level[i] = pcm[i] / 32768;
      this.#measure(level);
      if (!this.#relay) return;
      send(pcm.buffer as ArrayBuffer);
    };
  }

  /** Tears the capture graph + socket down. Idempotent. */
  #closeStream(): void {
    this.#closeSocket();          // the socket may outlive neither the capture nor a re-arm
    this.#streaming = false;
    this.#asked = false;
    this.#tries = 0;
    this.#relayError = "";
    this.#releaseCapture();
    if (this.#timer) {
      window.clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#relay = true;
  }

  /** Is the start that holds `gen` still the one the operator is waiting for? (#51) */
  #stale(gen: number): boolean {
    return gen !== this.#gen;
  }

  /** Hand the microphone back *now*, and only the microphone: tracks, graph, native recorder.
   *  `stop()` uses this to split the two halves of a call — the device is finished the moment the
   *  operator stops talking, while the recogniser still has to finish the last frames (#51). */
  #releaseCapture(): void {
    if (this.#proc) {
      this.#proc.onaudioprocess = null;
      try {
        this.#proc.disconnect();
      } catch {
        /* noop */
      }
      this.#proc = null;
    }
    if (this.#ctx) {
      void this.#ctx.close().catch(() => undefined);
      this.#ctx = null;
    }
    if (this.#mic) {
      for (const t of this.#mic.getTracks()) t.stop();
      this.#mic = null;
    }
    if (this.#bridge) {
      // The native recorder is the app's, so it must be told: an AudioRecord left running would keep
      // the microphone indicator on and the next start() would answer "already".
      try {
        this.#bridge.stop();
      } catch {
        /* the app is gone */
      }
      this.#bridge = null;
    }
    (window as unknown as { __asMic?: unknown }).__asMic = undefined;
    // the capture graph is gone: a stale level would leave the orb pulsing at nothing
    this.#level = 0;
    this.#wave.fill(0);
  }

  #finishStream(): void {
    this.#closeStream();
    this.#set({ status: "idle", interim: "" });
  }

  async #startServer(prefs: VoicePrefs, gen: number): Promise<void> {
    if (typeof navigator.mediaDevices?.getUserMedia !== "function") {
      // Same insecure-origin case as #startStream: the batch path cannot use the app's bridge,
      // so the device's own recorder is the fallback.
      await this.#startFileCapture(prefs);
      return;
    }
    // Ask for the microphone *after* telling the UI we are waiting: getUserMedia does
    // not resolve until the operator answers the permission prompt, and without this
    // the button looked dead for as long as the prompt was up (QA R53).
    this.#set({ status: "requesting", engine: "server", error: "" });
    const stream = await openMic({ audio: true });
    // Hung up while the prompt was up (#51): give the device straight back.
    if (this.#stale(gen)) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    this.#chunks = [];
    rec.ondataavailable = (ev) => {
      if (ev.data.size) this.#chunks.push(ev.data);
    };
    rec.onstop = () => {
      for (const track of stream.getTracks()) track.stop();
      void this.#finishServer(prefs);
    };
    this.#media = rec;
    // same reason as the browser path: getUserMedia already returned a stream here, so
    // "recording" is true — but keep `requesting` semantics for the panel label
    rec.start(1000); // timeslice: a long recording is sent as it goes, not only at the end
    this.#set({ status: "recording", engine: "server", seconds: 0 });
    this.#timer = window.setInterval(() => this.#set({ seconds: this.#state.seconds + 1 }), 1000);
  }

  /** No live capture (an insecure origin hides `getUserMedia`): fall back to the device's own
   *  recorder through `<input capture>`, whose finished file is exactly what the batch STT path
   *  takes. One utterance per invocation and no live level, but on a plain-http LAN entry it is
   *  the difference between "dictation works" and "this browser cannot record audio". */
  async #startFileCapture(prefs: VoicePrefs): Promise<void> {
    this.#set({ status: "requesting", engine: "server", error: "" });
    const file = await pickAudioFile();
    if (!file) {
      this.#set({ status: "idle", text: "", interim: "", error: "" });
      return;
    }
    await this.#uploadAudio(prefs, file);
  }

  /** POST one recorded clip to the server's STT and keep the text. Shared by the MediaRecorder
   *  path and the `<input capture>` fallback — one upload, one place the error is shaped. */
  async #uploadAudio(prefs: VoicePrefs, blob: Blob): Promise<void> {
    this.#set({ status: "transcribing" });
    try {
      const res = await fetch(`/api/stt?language=${encodeURIComponent(prefs.lang)}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": blob.type || "audio/webm" },
        body: blob,
      });
      const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? `stt ${res.status}`);
      this.#set({ status: "idle", text: String(data.text ?? "").trim(), interim: "" });
    } catch (e) {
      this.#set({ status: "error", error: String((e as Error)?.message ?? e) });
    }
  }

  async #finishServer(prefs: VoicePrefs): Promise<void> {
    if (this.#timer) {
      window.clearInterval(this.#timer);
      this.#timer = null;
    }
    const blob = new Blob(this.#chunks, { type: this.#chunks[0]?.type || "audio/webm" });
    this.#chunks = [];
    this.#media = null;
    if (!blob.size) {
      // A microphone that produced no bytes is a real failure (muted device, a stream
      // that never started). Saying nothing here would look like the feature is broken.
      this.#set({ status: "error", error: "nothing was recorded — check the microphone" });
      return;
    }
    await this.#uploadAudio(prefs, blob);
  }

  /** Stop and keep what was heard (the composer takes `text`). */
  stop(): void {
    // Nothing that is still starting is wanted any more (#51): every pending `start()` chain sees this
    // and hands its microphone back instead of parking it where no stop() would look for it.
    this.#gen += 1;
    // A pending permission prompt has no recording to stop: cancelling is the only
    // honest outcome, and it drops the state back to idle.
    if (this.#state.status === "requesting") {
      this.cancel();
      return;
    }
    if (this.#rec) {
      try {
        this.#rec.stop();
      } catch {
        /* already stopped */
      }
      return;
    }
    // streaming: the MICROPHONE is finished the moment the operator says stop — release it here, not in
    // #closeStream, which only runs once the recogniser sends back its last sentence. Before this split
    // the device stayed open for the whole finalisation (and forever when the asr-done never arrived),
    // so the tab kept its recording badge lit after the call was over (#51 leak B).
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
      this.#releaseCapture();
      if (this.#timer) {
        window.clearInterval(this.#timer);
        this.#timer = null;
      }
      this.#asked = true;
      this.#set({ status: "transcribing" });
      try {
        this.#ws.send(JSON.stringify({ t: "asr-stop" }));
      } catch {
        this.#finishStream();
        return;
      }
      window.setTimeout(() => {
        if (this.#state.status === "transcribing") this.#finishStream();
      }, 8000);
      return;
    }
    if (this.#media && this.#media.state !== "inactive") this.#media.stop();
    if (this.#timer) {
      window.clearInterval(this.#timer);
      this.#timer = null;
    }
    if (this.#state.status === "listening") {
      this.#set({ status: "idle", interim: "" });
    }
  }

  /** Throw the recording away. */
  cancel(): void {
    this.#gen += 1;   // a start still waiting on its permission prompt must not arm afterwards (#51)
    if (this.#rec) {
      try {
        this.#rec.abort();
      } catch {
        /* noop */
      }
      this.#rec = null;
    }
    if (this.#media && this.#media.state !== "inactive") {
      this.#media.onstop = null;
      this.#media.stop();
      this.#media = null;
    }
    if (this.#timer) {
      window.clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#closeStream();
    this.#committed = "";
    this.#chunks = [];
    this.#set({ status: "idle", text: "", interim: "", error: "", seconds: 0 });
  }

  /** Called by the composer once it has taken `text`. */
  consume(): string {
    const out = this.#state.text.trim();
    this.#set({ status: "idle", text: "", interim: "", seconds: 0 });
    return out;
  }

  /** Which composer owns the transcript.
   *
   *  Two composers are mounted at the SAME time while the new-session dialog is up — it is an
   *  overlay, so the chat page keeps its own `.composer-bar` behind it — and both sinks react to the
   *  same snapshot. React flushes the CHAT page's effect first (it sits before the dialog in the
   *  tree), so the words landed in the prompt box BEHIND the dialog while the dialog's own box
   *  stayed empty: the operator's 「语音录完点停止，没有填到输入框里」, reproduced on the new-session
   *  form 2026-10-15 (the chat composer had「你好这是语音测试」, the dialog's box nothing).
   *
   *  The box on screen takes the transcript; the other one must not touch it. */
  setOwner(who: DictSink): void {
    this.#owner = who;
  }
  owns(who: DictSink): boolean {
    return this.#owner === who;
  }
  #owner: DictSink = "chat";
}

/** Float32 [-1,1] at `from` Hz -> Int16 PCM at `to` Hz (linear interpolation).
 *  The streaming API takes 16 kHz mono s16le and nothing else. */
export function resampleToPcm16(input: Float32Array, from: number, to: number): Int16Array {
  if (from === to) {
    const same = new Int16Array(input.length);
    for (let i = 0; i < input.length; i += 1) same[i] = clampPcm(input[i]);
    return same;
  }
  const ratio = from / to;
  const len = Math.max(0, Math.floor(input.length / ratio));
  const out = new Int16Array(len);
  for (let i = 0; i < len; i += 1) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = clampPcm(input[i0] * (1 - frac) + input[i1] * frac);
  }
  return out;
}

function clampPcm(v: number): number {
  const n = Math.round((Number.isFinite(v) ? v : 0) * 32767);
  return n > 32767 ? 32767 : n < -32768 ? -32768 : n;
}

export const dictation = new Dictation();
// QA seam (next to `__asFeed` / `__asMic`): the call and the composer share one dictation object,
// and a sweep has to be able to leave a sentence in it without a recogniser.
if (typeof window !== "undefined") {
  (window as unknown as { __asDictation?: Dictation }).__asDictation = dictation;
}

export function useDictation(): DictationState {
  return useSyncExternalStore(dictation.subscribe, dictation.getSnapshot);
}

// Preferences are a module store, not component state: the composer's settings
// popover, the per-message read-aloud button and the auto-read effect all have to
// agree, and three copies of the same useState would drift the moment one changes.
let prefsState: VoicePrefs = loadVoicePrefs();
const prefsListeners = new Set<() => void>();

/** These used to be browser-local only. They are the operator's settings like the theme and
 *  the call knobs, so they live on the server too: the read-aloud switch, the voice and the
 *  speed have to be the same on the phone as on the laptop (and two tabs of one instance
 *  disagreeing about them is a bug, not a feature). localStorage stays as the first-frame
 *  mirror; `loadServerVoicePrefs` adopts the stored copy at boot and migrates the browser's
 *  copy up once, so nobody loses a setting they already made. */
export async function pushVoicePrefs(): Promise<string> {
  try {
    const res = await fetch("/api/settings", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prefs: prefsState }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return data.error ?? `save failed (${res.status})`;
    }
    return "";
  } catch (e) {
    return String((e as Error)?.message ?? e);
  }
}

/** What the server sent, in the client's shape. `lang: ""` means "the browser's language". */
export function normalizePrefs(raw: unknown): VoicePrefs {
  const base: VoicePrefs = { ...DEFAULT_PREFS };
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Partial<VoicePrefs>;
  return {
    autoRead: typeof r.autoRead === "boolean" ? r.autoRead : base.autoRead,
    // `speakMode` is the new name for what `autoRead` used to mean. Accept either, prefer the new
    // one, and keep `autoRead` consistent so an old component reading it is not lied to.
    speakMode: r.speakMode === "off" || r.speakMode === "reply" || r.speakMode === "brief"
      ? r.speakMode
      : (typeof r.autoRead === "boolean" && r.autoRead ? "reply" : "off"),
    voiceURI: typeof r.voiceURI === "string" ? r.voiceURI : base.voiceURI,
    rate: Number.isFinite(Number(r.rate)) ? Math.min(2, Math.max(0.5, Number(r.rate))) : base.rate,
    lang: typeof r.lang === "string" && r.lang ? r.lang : base.lang,
    serverTts: typeof r.serverTts === "boolean" ? r.serverTts : base.serverTts,
    stt: r.stt === "browser" || r.stt === "stream" || r.stt === "server" ? r.stt : "auto",
  };
}

export function applyVoicePrefs(next: VoicePrefs): void {
  prefsState = next;
  saveVoicePrefs(prefsState);
  for (const fn of prefsListeners) fn();
}

/** Adopt the stored copy. If the store has never been touched, the browser's copy wins and
 *  is pushed up — the operator made that choice before there was a server-side home for it. */
export async function loadServerVoicePrefs(): Promise<void> {
  try {
    const res = await fetch("/api/settings", { credentials: "same-origin" });
    if (!res.ok) return;
    const data = (await res.json()) as { prefs?: unknown; prefsDefaults?: unknown };
    const server = normalizePrefs(data.prefs);
    const defaults = normalizePrefs(data.prefsDefaults);
    const untouched = PREFS_FIELDS.every((k) => server[k] === defaults[k]);
    if (untouched && PREFS_FIELDS.some((k) => prefsState[k] !== server[k])) {
      void pushVoicePrefs();
      return;
    }
    if (PREFS_FIELDS.some((k) => prefsState[k] !== server[k])) applyVoicePrefs(server);
  } catch {
    /* offline / not logged in: the cached copy stands */
  }
}

// `autoRead` is deliberately NOT in this list: it is a derived mirror of `speakMode`, and comparing
// both would make an untouched store look touched the moment one of them is normalised.
const PREFS_FIELDS: (keyof VoicePrefs)[] = ["speakMode", "voiceURI", "rate", "lang", "serverTts", "stt"];

export function updateVoicePrefs(patch: Partial<VoicePrefs>): void {
  const next = { ...prefsState, ...patch };
  const rate = Number.isFinite(next.rate) ? Math.min(2, Math.max(0.5, next.rate)) : 1;
  prefsState = { ...next, rate };
  saveVoicePrefs(prefsState);
  for (const fn of prefsListeners) fn();
  void pushVoicePrefs();
}

export function getVoicePrefs(): VoicePrefs {
  return prefsState;
}

export function useVoicePrefs(): [VoicePrefs, (patch: Partial<VoicePrefs>) => void] {
  const prefs = useSyncExternalStore(
    (fn) => {
      prefsListeners.add(fn);
      return () => prefsListeners.delete(fn);
    },
    () => prefsState,
  );
  return [prefs, updateVoicePrefs];
}

/** Speak the segments of this turn that have LANDED, in order, if the operator asked for that.
 *  `ready` is the caller's "this transcript is real" signal — NOT "the turn finished": issue #67
 *  asked for a paragraph to be read as soon as it settles, instead of one silent stretch followed by
 *  only the turn's tail. History that was merely loaded never fires, because the caller hands over
 *  null once its freshness window has passed.
 *  Segments are queued on one serial chain, so the next paragraph waits for the previous one instead
 *  of calling stop() on it mid-sentence. */
export function useAutoRead(targets: ReadTarget[] | null, ready: boolean, mode?: SpeakMode): void {
  const [prefs] = useVoicePrefs();
  // `mode` is the position that applies to THIS session (issue #68); without one, fall back to the
  // global pref (`speakMode` is the truth; a pre-#16 stored pref only has `autoRead`, which the
  // loader maps onto it).
  const on = (mode ?? prefs.speakMode ?? (prefs.autoRead ? "reply" : "off")) === "reply";
  const sig = targets?.length ? targets.map((t) => t.key).join("\u0001") : "";
  useEffect(() => {
    if (!on || !ready || !targets?.length) return;
    for (const t of targets) {
      if (!t.text.trim()) continue;
      if (!shouldAutoRead(t.key, true, on)) continue;
      enqueueRead(t);
    }
  }, [sig, ready, on]);
}

/** 工作播报 (issue #16): speak the cockpit's own one-line briefs. The server throttles, decides what
 *  is worth saying and falls back on its own when no observer can speak — so this hook is only the
 *  last mile: a line arrived, the operator asked for briefs, say it. */
export function useBriefSpeak(target: { key: string; text: string } | null, ready: boolean, mode?: SpeakMode): void {
  const [prefs] = useVoicePrefs();
  const on = (mode ?? prefs.speakMode ?? (prefs.autoRead ? "reply" : "off")) === "brief";
  useEffect(() => {
    if (!on || !ready || !target || !target.text.trim()) return;
    void speaker.speak(target.text, target.key, prefs);
  }, [target?.key, ready, on]);
}
