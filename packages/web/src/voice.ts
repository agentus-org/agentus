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

// ---------------------------------------------------------------- preferences

export interface VoicePrefs {
  /** read a finished reply aloud without being asked */
  autoRead: boolean;
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

const PREFS_KEY = "agentslot.voice";

const DEFAULT_PREFS: VoicePrefs = {
  autoRead: false,
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
  tts: { server: boolean; model: string | null; voice: string | null };
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
  tts: { server: false, model: null, voice: null },
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
export function splitForSpeech(text: string, max = 220): string[] {
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
        src.connect(audioCtx!.destination);
        src.onended = () => resolve();
        const abort = (): void => {
          try { src.stop(); } catch { /* already stopped */ }
          reject(new Error("stopped"));
        };
        if (signal) {
          if (signal.aborted) return abort();
          signal.addEventListener("abort", abort, { once: true });
        }
        src.start();
      });
      return;
    } catch (e) {
      if (signal?.aborted) throw new Error("stopped");
      // fall through to the element: a format the encoder produced but the decoder cannot take
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      const audio = new Audio(url);
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error("audio playback failed"));
      void audio.play().catch((e) => reject(new Error(String((e as Error)?.message ?? e))));
    });
  } finally {
    URL.revokeObjectURL(url);
  }
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
    this.stop();
    const chunks = splitForSpeech(body);
    if (!chunks.length) return;
    this.#set({ error: "", note: "", speakingId: id, speaking: true });
    try {
      if (prefs.serverTts && voiceCaps().tts.server) {
        await this.#speakServer(chunks, prefs);
      } else {
        await this.#speakBrowser(chunks, prefs);
      }
    } catch (e) {
      // Server voice failed: the browser can still read it. Say so once, then do it.
      if (prefs.serverTts && browserSpeechAvailable()) {
        this.#set({ note: `server voice failed (${String((e as Error)?.message ?? e)}), using the browser voice` });
        try {
          await this.#speakBrowser(chunks, prefs);
          return;
        } catch (e2) {
          this.#set({ error: String((e2 as Error)?.message ?? e2) });
        }
      } else {
        this.#set({ error: String((e as Error)?.message ?? e) });
      }
    } finally {
      this.#set({ speaking: false, speakingId: null });
    }
  }

  async #speakBrowser(chunks: string[], prefs: VoicePrefs): Promise<void> {
    if (!browserSpeechAvailable()) throw new Error("this browser has no speech synthesis");
    const synth = window.speechSynthesis;
    const voice = this.pickVoice(prefs);
    for (const [i, chunk] of chunks.entries()) {
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
      if (synth.paused) synth.resume();
    }
  }

  async #speakServer(chunks: string[], prefs: VoicePrefs): Promise<void> {
    for (const chunk of chunks) {
      this.#abort = new AbortController();
      const res = await fetch("/api/tts", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        signal: this.#abort.signal,
        body: JSON.stringify({ text: chunk, speed: prefs.rate }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({ error: `${res.status}` })) as { error?: string };
        throw new Error(detail.error ?? `tts ${res.status}`);
      }
      await playBlob(await res.blob(), this.#abort.signal);
    }
  }

  stop(): void {
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

/** Auto-read plumbing: which message id we already read aloud, so a re-render or a
 *  history load never re-reads the same reply. */
let lastAutoReadKey = "";

export function shouldAutoRead(key: string, prefs: VoicePrefs, isNewTurn: boolean): boolean {
  if (!prefs.autoRead || !isNewTurn) return false;
  if (key === lastAutoReadKey) return false;
  lastAutoReadKey = key;
  return true;
}

// ----------------------------------------------------------------- dictation

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
  #committed = "";

  subscribe = (fn: () => void): (() => void) => {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  };

  getSnapshot = (): DictationState => this.#state;

  #set(patch: Partial<DictationState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const fn of this.#listeners) fn();
  }

  /** Begin dictation. Returns false (with `error` set) when nothing can run it.
   *  `sessionId` is what lets the recogniser carry this conversation's hotwords. */
  async start(prefs: VoicePrefs, sessionId?: string): Promise<boolean> {
    if (this.#state.status !== "idle" && this.#state.status !== "error") return false;
    this.#set({ status: "idle", text: "", interim: "", error: "", seconds: 0 });
    this.#committed = "";
    const want = prefs.stt;
    const serverOk = voiceCaps().stt.server;
    const streamOk = voiceCaps().stt.streaming;
    const useBrowser = (want === "browser" || want === "auto") && browserDictationAvailable();
    try {
      // "auto" prefers the configured stream: the operator picked those models, wrote
      // the key and the hotword list — the browser engine knows none of that.
      if (want === "stream" || (want === "auto" && streamOk)) {
        if (!streamOk) throw new Error("streaming STT is not configured on the server (settings → 语音)");
        await this.#startStream(prefs, sessionId);
        return true;
      }
      if (useBrowser) {
        this.#startBrowser(prefs);
        return true;
      }
      if (serverOk) {
        await this.#startServer(prefs);
        return true;
      }
      this.#set({
        status: "error",
        engine: null,
        error: want === "server" || serverOk
          ? "no dictation available: this browser has no speech recognition and the server has no STT endpoint (AGENTSLOT_STT_BASE_URL)"
          : "no dictation available in this browser — set the server STT endpoint or use Chromium/Edge",
      });
      return false;
    } catch (e) {
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
  async #startStream(prefs: VoicePrefs, sessionId?: string): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("this browser cannot record audio");
    const Ctor = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!Ctor) throw new Error("this browser cannot process audio");
    // Ask for the microphone after saying we are waiting (the prompt is modal, QA R53).
    this.#set({ status: "requesting", engine: "stream", error: "" });
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    this.#mic = mic;
    // 16 kHz mono s16le is what the model takes. Ask the context for 16 kHz (Chromium
    // honours it) and resample when the browser insists on 44.1/48 kHz (Safari).
    const ctx = new Ctor({ sampleRate: 16000 });
    this.#ctx = ctx;
    const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/asr${q}`);
    ws.binaryType = "arraybuffer";
    this.#ws = ws;
    const pending: ArrayBuffer[] = [];
    ws.onopen = () => {
      for (const buf of pending) ws.send(buf);
      pending.length = 0;
      this.#set({ status: "listening", engine: "stream" });
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
        this.#set({ status: "error", error: String(msg.error ?? "streaming asr failed") });
      } else if (msg.t === "asr-done") {
        this.#finishStream();
      }
    };
    ws.onerror = () => {
      if (this.#state.status !== "idle" && this.#state.status !== "error") {
        this.#set({ status: "error", error: "the streaming socket failed — is the server up?" });
      }
    };
    ws.onclose = () => {
      if (this.#ws === ws) this.#ws = null;
    };
    const src = ctx.createMediaStreamSource(mic);
    // ScriptProcessor is deprecated but universally available, which matters more here
    // than the AudioWorklet's tidier lifecycle: this runs for one utterance.
    const proc = ctx.createScriptProcessor(2048, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0; // keeps the graph pulled without echoing the mic to the speakers
    this.#proc = proc;
    proc.onaudioprocess = (ev: AudioProcessingEvent) => {
      const pcm = resampleToPcm16(ev.inputBuffer.getChannelData(0), ctx.sampleRate, 16000);
      if (!pcm.length) return;
      // typed arrays are generic over ArrayBufferLike in TS; a fresh Int16Array's buffer
      // is always a plain ArrayBuffer
      const frame = pcm.buffer as ArrayBuffer;
      if (ws.readyState === WebSocket.OPEN) ws.send(frame);
      else if (ws.readyState === WebSocket.CONNECTING && pending.length < 300) pending.push(frame);
    };
    src.connect(proc);
    proc.connect(mute);
    mute.connect(ctx.destination);
    this.#set({ status: "listening", engine: "stream", seconds: 0 });
    this.#timer = window.setInterval(() => this.#set({ seconds: this.#state.seconds + 1 }), 1000);
  }

  /** Tears the capture graph + socket down. Idempotent. */
  #closeStream(): void {
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    }
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
    if (this.#timer) {
      window.clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  #finishStream(): void {
    this.#closeStream();
    this.#set({ status: "idle", interim: "" });
  }

  async #startServer(prefs: VoicePrefs): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("this browser cannot record audio");
    // Ask for the microphone *after* telling the UI we are waiting: getUserMedia does
    // not resolve until the operator answers the permission prompt, and without this
    // the button looked dead for as long as the prompt was up (QA R53).
    this.#set({ status: "requesting", engine: "server", error: "" });
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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

  /** Stop and keep what was heard (the composer takes `text`). */
  stop(): void {
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
    // streaming: ask the recogniser to finalise and wait for its last sentence; the
    // server closes the socket after asr-done, so nothing to tear down by hand.
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
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

export function useDictation(): DictationState {
  return useSyncExternalStore(dictation.subscribe, dictation.getSnapshot);
}

// Preferences are a module store, not component state: the composer's settings
// popover, the per-message read-aloud button and the auto-read effect all have to
// agree, and three copies of the same useState would drift the moment one changes.
let prefsState: VoicePrefs = loadVoicePrefs();
const prefsListeners = new Set<() => void>();

export function updateVoicePrefs(patch: Partial<VoicePrefs>): void {
  const next = { ...prefsState, ...patch };
  const rate = Number.isFinite(next.rate) ? Math.min(2, Math.max(0.5, next.rate)) : 1;
  prefsState = { ...next, rate };
  saveVoicePrefs(prefsState);
  for (const fn of prefsListeners) fn();
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

/** Speak a message when it lands, if the operator asked for that. `ready` is the
 *  caller's "this reply just finished" signal — auto-read must never fire while a
 *  turn is still streaming, and never for history that was merely loaded. */
export function useAutoRead(target: { key: string; text: string } | null, ready: boolean): void {
  const [prefs] = useVoicePrefs();
  useEffect(() => {
    if (!prefs.autoRead || !ready || !target || !target.text.trim()) return;
    if (!shouldAutoRead(target.key, prefs, true)) return;
    void speaker.speak(target.text, target.key, prefs);
  }, [target?.key, ready, prefs.autoRead]);
}
