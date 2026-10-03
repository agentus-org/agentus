// Voice: speech-to-text and text-to-speech.
//
// Two layers (unchanged from the first voice pass): the browser can do both directions
// with zero configuration, and the server adds a provider when the operator configures
// one. What changed is where the configuration lives: the settings page (settings.ts)
// owns provider / base URL / key / models / voice / hotwords; env remains a bootstrap.
//
// This module is a ROUTER over providers:
//   "dashscope"  阿里百炼 (dashscope.ts): streaming ASR over its inference WebSocket,
//                 batch ASR over the OpenAI-compatible chat route, TTS via
//                 SpeechSynthesizer; fixed + dynamic hotwords ride along.
//   "openai"     any OpenAI-compatible /audio/speech + /audio/transcriptions endpoint
//                 (the AGENTSLOT_TTS_* / AGENTSLOT_STT_* bootstrap path).
//   "browser"    no server path (the UI uses speechSynthesis / SpeechRecognition).
//
// The server still synthesises or recognises nothing itself: every call forwards to an
// endpoint the operator owns. That keeps the project's "the UI holds no intelligence"
// line intact (a voice endpoint is I/O, like the file panel, not an agent).
import { getSettings, dashscopeUrls } from "./settings.js";
import { dashscopeAsr, dashscopeTts, DashscopeError } from "./dashscope.js";

export interface VoiceConfig {
  tts: { baseUrl: string; key: string; model: string; voice: string } | null;
  stt: { baseUrl: string; key: string; model: string; language: string } | null;
}

const trimmed = (v: string | undefined): string => String(v ?? "").trim().replace(/\/+$/, "");

/** Env bootstrap for the OpenAI-compatible provider (unchanged semantics: what the
 *  fake-endpoint tests and openai users hit; the settings page overrides it). */
export function voiceConfig(env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  const ttsBase = trimmed(env.AGENTSLOT_TTS_BASE_URL);
  const sttBase = trimmed(env.AGENTSLOT_STT_BASE_URL);
  return {
    tts: ttsBase
      ? {
          baseUrl: ttsBase,
          key: String(env.AGENTSLOT_TTS_API_KEY ?? env.OPENAI_API_KEY ?? ""),
          model: String(env.AGENTSLOT_TTS_MODEL || "tts-1"),
          voice: String(env.AGENTSLOT_TTS_VOICE || "alloy"),
        }
      : null,
    stt: sttBase
      ? {
          baseUrl: sttBase,
          key: String(env.AGENTSLOT_STT_API_KEY ?? env.OPENAI_API_KEY ?? ""),
          model: String(env.AGENTSLOT_STT_MODEL || "whisper-1"),
          language: String(env.AGENTSLOT_STT_LANGUAGE || ""),
        }
      : null,
  };
}

export type VoiceProvider = "dashscope" | "openai" | "browser";

/** Which provider would answer right now. The settings page wins over env; "dashscope"
 *  selected but incomplete resolves to "browser" (the UI must not be promised a server
 *  path that will 501). */
export function resolveVoice(env: NodeJS.ProcessEnv = process.env): {
  provider: VoiceProvider;
  tts: boolean;
  stt: boolean;
  openai: VoiceConfig;
} {
  const v = getSettings().voice;
  const openai = voiceConfig(env);
  if (v.provider === "dashscope") {
    const ready = Boolean(v.baseUrl && v.apiKey);
    return { provider: ready ? "dashscope" : "browser", tts: ready, stt: ready, openai };
  }
  if (v.provider === "openai") {
    const has = Boolean(v.baseUrl && v.apiKey);
    return {
      provider: has || openai.tts || openai.stt ? "openai" : "browser",
      tts: has || Boolean(openai.tts),
      stt: has || Boolean(openai.stt),
      openai,
    };
  }
  // provider "browser": env bootstrap still counts (a test server or an operator who
  // prefers env over the page)
  return { provider: "browser", tts: Boolean(openai.tts), stt: Boolean(openai.stt), openai };
}

/** What the browser asks before it decides who speaks. */
export function voiceCapabilities(): Record<string, unknown> {
  const v = getSettings().voice;
  const r = resolveVoice();
  return {
    provider: r.provider,
    tts: {
      server: r.tts,
      model: r.provider === "dashscope" ? v.ttsModel : (r.openai.tts?.model ?? null),
      voice: r.provider === "dashscope" ? v.ttsVoice : (r.openai.tts?.voice ?? null),
    },
    stt: {
      server: r.stt,
      streaming: r.provider === "dashscope" && v.asrStream,
      model: r.provider === "dashscope" ? v.asrModel : null,
      batchModel: r.provider === "dashscope" ? v.asrBatchModel : (r.openai.stt?.model ?? null),
      language: r.openai.stt?.language || null,
    },
    hotwords: { fixed: v.hotwords.length, dynamic: v.dynamicHotwords, limit: v.hotwordLimit },
  };
}

export class VoiceError extends Error {
  constructor(message: string, readonly code: "not_configured" | "upstream" | "timeout") {
    super(message);
  }
}

const TIMEOUT_MS = 60_000;

async function withTimeout<T>(label: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await run(ac.signal);
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new VoiceError(`${label} timed out after ${TIMEOUT_MS / 1000}s`, "timeout");
    if (e instanceof VoiceError || e instanceof DashscopeError) throw e;
    // DNS/connection failure: the operator's endpoint is the problem, not this process —
    // report it as an upstream error so the UI says what actually happened.
    throw new VoiceError(`${label}: cannot reach the voice endpoint (${String((e as Error)?.message ?? e)})`, "upstream");
  } finally {
    clearTimeout(timer);
  }
}

function wrapDashscope(e: unknown): VoiceError {
  if (e instanceof DashscopeError) {
    return new VoiceError(e.message, e.code === "timeout" ? "timeout" : e.code === "not_configured" ? "not_configured" : "upstream");
  }
  return new VoiceError(String((e as Error)?.message ?? e), "upstream");
}

/** Text -> audio bytes, routed. The browser only ever sees bytes: the key and the
 *  provider's signed result URL stay server-side. */
export async function synthesize(text: string, opts: { voice?: string; speed?: number } = {}): Promise<{
  contentType: string;
  audio: Buffer;
}> {
  const v = getSettings().voice;
  const r = resolveVoice();
  if (r.provider === "dashscope") return dashscopeTts(text, opts).catch((e) => { throw wrapDashscope(e); });
  // openai-compatible: settings endpoint+key when complete, else the env bootstrap
  const fromSettings = v.baseUrl && v.apiKey ? { baseUrl: trimmed(v.baseUrl), key: v.apiKey, model: v.ttsModel || "tts-1", voice: v.ttsVoice } : null;
  const cfg = fromSettings ?? r.openai.tts;
  if (!cfg) throw new VoiceError("server TTS is not configured (settings page, or AGENTSLOT_TTS_BASE_URL)", "not_configured");
  const res = await withTimeout("tts", (signal) => fetch(`${cfg.baseUrl}/audio/speech`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", ...(cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}) },
    body: JSON.stringify({
      model: cfg.model,
      voice: opts.voice || cfg.voice || "alloy",
      input: text,
      ...(opts.speed && opts.speed !== 1 ? { speed: opts.speed } : {}),
    }),
  }));
  if (!res.ok) throw new VoiceError(`tts upstream ${res.status}: ${(await res.text().catch(() => "")).slice(0, 400)}`, "upstream");
  return { contentType: res.headers.get("content-type") ?? "audio/mpeg", audio: Buffer.from(await res.arrayBuffer()) };
}

/** Audio bytes -> transcript, routed. `sessionId` lets the provider pull context hotwords
 *  from the transcript it already has (dynamic hotwords). */
export async function transcribe(
  audio: Buffer,
  mime: string,
  opts: { filename?: string; language?: string; sessionId?: string; contextWords?: string[] } = {},
): Promise<string> {
  const v = getSettings().voice;
  const r = resolveVoice();
  if (r.provider === "dashscope") {
    return dashscopeAsr(audio, mime, { contextWords: opts.contextWords ?? hotwordsForRequest(opts.sessionId) })
      .catch((e) => { throw wrapDashscope(e); });
  }
  const fromSettings = v.baseUrl && v.apiKey ? { baseUrl: trimmed(v.baseUrl), key: v.apiKey, model: v.asrBatchModel, language: "" } : null;
  const cfg = fromSettings ?? r.openai.stt;
  if (!cfg) throw new VoiceError("server STT is not configured (settings page, or AGENTSLOT_STT_BASE_URL)", "not_configured");
  const form = new FormData();
  const name = opts.filename || `dictation.${mimeToExt(mime)}`;
  form.append("file", new Blob([new Uint8Array(audio)], { type: mime || "audio/webm" }), name);
  form.append("model", cfg.model);
  if (opts.language || cfg.language) form.append("language", opts.language || cfg.language);
  const res = await withTimeout("stt", (signal) => fetch(`${cfg.baseUrl}/audio/transcriptions`, {
    method: "POST",
    signal,
    headers: cfg.key ? { authorization: `Bearer ${cfg.key}` } : undefined,
    body: form,
  }));
  if (!res.ok) throw new VoiceError(`stt upstream ${res.status}: ${(await res.text().catch(() => "")).slice(0, 400)}`, "upstream");
  const data = (await res.json()) as { text?: string };
  return String(data?.text ?? "").trim();
}

/** Hotword extraction needs the store, which lives outside this module: injected at
 *  boot (index.ts) so voice.ts stays free of database imports. */
type HotwordFn = (sessionId?: string) => string[];
let hotwordsForRequest: HotwordFn = () => [];
export function setHotwordSource(fn: HotwordFn): void {
  hotwordsForRequest = fn;
}

/** The model ids the configured endpoint serves, split into the two lists the settings
 *  page offers. The operator named two defaults but asked for "其它的也可选", and every
 *  Bailian tenant advertises a different set — so we ask the endpoint instead of
 *  hard-coding a catalogue. */
export async function listVoiceModels(): Promise<{ total: number; asr: string[]; tts: string[] }> {
  const v = getSettings().voice;
  const r = resolveVoice();
  let url = "";
  let key = "";
  if (r.provider === "dashscope") {
    const { compat } = dashscopeUrls(v.baseUrl);
    url = `${compat}/models`;
    key = v.apiKey;
  } else {
    // the settings page's endpoint first: resolveVoice() falls back to the env bootstrap,
    // so an operator who typed an endpoint must not be told "not configured" (the page's
    // "重新读取" button would be a lie).
    const base = trimmed(v.baseUrl) || r.openai.tts?.baseUrl || r.openai.stt?.baseUrl || "";
    if (!base) throw new VoiceError("no voice endpoint configured", "not_configured");
    key = (v.baseUrl && v.apiKey ? v.apiKey : "") || r.openai.tts?.key || r.openai.stt?.key || "";
    url = `${base}/models`;
  }
  const res = await withTimeout("models", (signal) => fetch(url, {
    signal,
    headers: key ? { authorization: `Bearer ${key}` } : undefined,
  }));
  if (!res.ok) throw new VoiceError(`models upstream ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`, "upstream");
  const data = (await res.json()) as { data?: { id?: string }[]; models?: { name?: string }[] };
  const ids = (data.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean);
  for (const m of data.models ?? []) if (m.name) ids.push(String(m.name));
  const asr = ids.filter((id) => /asr|speech-recog|recognition|paraformer|sensevoice/i.test(id));
  const tts = ids.filter((id) => /tts|speech-synth|cosyvoice|sambert/i.test(id));
  return { total: ids.length, asr, tts };
}

function mimeToExt(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("webm")) return "webm";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("wav")) return "wav";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("flac")) return "flac";
  if (m.includes("pcm")) return "pcm";
  return "webm";
}
