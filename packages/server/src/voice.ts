// Voice: speech-to-text and text-to-speech.
//
// Two layers, on purpose (the same two-layer idea hermes-studio uses):
//
//  1. **The browser does it by default, with zero configuration.** Every modern
//     browser ships `speechSynthesis` (read a reply aloud) and Chromium/Edge ship
//     `SpeechRecognition` (dictate a prompt). Nothing to install, nothing to pay
//     for, and the audio never leaves the machine the operator is sitting at.
//  2. **The server can proxy an OpenAI-compatible API when the operator has one.**
//     That is the answer for the two cases the browser cannot cover: a browser
//     without speech recognition (Firefox), and a machine where the browser's
//     speech service is unreachable but the operator's own endpoint is not.
//
// The server never synthesises anything itself: this file only forwards to a base
// URL the operator configured. No model, no vendor key baked in — that keeps the
// project's "the UI holds no intelligence" line intact (a voice endpoint is I/O,
// like the file panel, not an agent).
//
// Env (all optional; each direction is independent):
//   AGENTSLOT_TTS_BASE_URL   e.g. https://api.openai.com/v1
//   AGENTSLOT_TTS_API_KEY
//   AGENTSLOT_TTS_MODEL      default "tts-1"
//   AGENTSLOT_TTS_VOICE      default "alloy"
//   AGENTSLOT_STT_BASE_URL   e.g. https://api.openai.com/v1
//   AGENTSLOT_STT_API_KEY
//   AGENTSLOT_STT_MODEL      default "whisper-1"
//   AGENTSLOT_STT_LANGUAGE   optional ISO-639-1 hint, e.g. "zh"

export interface VoiceConfig {
  tts: { baseUrl: string; apiKey: string; model: string; voice: string } | null;
  stt: { baseUrl: string; apiKey: string; model: string; language: string } | null;
}

const trimmed = (v: string | undefined): string => String(v ?? "").trim().replace(/\/+$/, "");

export function voiceConfig(env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  const ttsBase = trimmed(env.AGENTSLOT_TTS_BASE_URL);
  const sttBase = trimmed(env.AGENTSLOT_STT_BASE_URL);
  return {
    tts: ttsBase
      ? {
          baseUrl: ttsBase,
          apiKey: String(env.AGENTSLOT_TTS_API_KEY ?? ""),
          model: String(env.AGENTSLOT_TTS_MODEL || "tts-1"),
          voice: String(env.AGENTSLOT_TTS_VOICE || "alloy"),
        }
      : null,
    stt: sttBase
      ? {
          baseUrl: sttBase,
          apiKey: String(env.AGENTSLOT_STT_API_KEY ?? ""),
          model: String(env.AGENTSLOT_STT_MODEL || "whisper-1"),
          language: String(env.AGENTSLOT_STT_LANGUAGE || ""),
        }
      : null,
  };
}

/** What the browser needs to know before it decides who speaks. */
export function voiceCapabilities(): {
  tts: { server: boolean; model: string | null; voice: string | null };
  stt: { server: boolean; model: string | null; language: string | null };
} {
  const cfg = voiceConfig();
  return {
    tts: { server: Boolean(cfg.tts), model: cfg.tts?.model ?? null, voice: cfg.tts?.voice ?? null },
    stt: { server: Boolean(cfg.stt), model: cfg.stt?.model ?? null, language: cfg.stt?.language || null },
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
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** POST {text} to <base>/audio/speech, hand the audio bytes back. */
export async function synthesize(text: string, opts: { voice?: string; speed?: number } = {}): Promise<{
  contentType: string;
  audio: Buffer;
}> {
  const cfg = voiceConfig().tts;
  if (!cfg) throw new VoiceError("server TTS is not configured (AGENTSLOT_TTS_BASE_URL)", "not_configured");
  const res = await withTimeout("tts", (signal) => fetch(`${cfg.baseUrl}/audio/speech`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      voice: opts.voice || cfg.voice,
      input: text,
      ...(opts.speed && opts.speed !== 1 ? { speed: opts.speed } : {}),
    }),
  }));
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new VoiceError(`tts upstream ${res.status}: ${detail.slice(0, 400) || res.statusText}`, "upstream");
  }
  return {
    contentType: res.headers.get("content-type") ?? "audio/mpeg",
    audio: Buffer.from(await res.arrayBuffer()),
  };
}

/** POST raw audio to <base>/audio/transcriptions, return the transcript. */
export async function transcribe(
  audio: Buffer,
  mime: string,
  opts: { filename?: string; language?: string } = {},
): Promise<string> {
  const cfg = voiceConfig().stt;
  if (!cfg) throw new VoiceError("server STT is not configured (AGENTSLOT_STT_BASE_URL)", "not_configured");
  const form = new FormData();
  const name = opts.filename || `dictation.${mimeToExt(mime)}`;
  form.append("file", new Blob([new Uint8Array(audio)], { type: mime || "audio/webm" }), name);
  form.append("model", cfg.model);
  if (opts.language || cfg.language) form.append("language", opts.language || cfg.language);
  const res = await withTimeout("stt", (signal) => fetch(`${cfg.baseUrl}/audio/transcriptions`, {
    method: "POST",
    signal,
    headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : undefined,
    body: form,
  }));
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new VoiceError(`stt upstream ${res.status}: ${detail.slice(0, 400) || res.statusText}`, "upstream");
  }
  const data = (await res.json()) as { text?: string };
  return String(data?.text ?? "").trim();
}

function mimeToExt(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("webm")) return "webm";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("wav")) return "wav";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("flac")) return "flac";
  return "webm";
}
