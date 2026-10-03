// Operator settings: one JSON file next to the store, 0600, secrets never echoed back.
//
// Why a file and not just env: the voice/theme features are configurable from the
// settings page, and a restart must not lose the operator's choices. Env stays the
// *bootstrap*: DASHSCOPE_API_KEY / DASHSCOPE_BASE_URL are read from the process env
// and — because the server is usually started from a plain shell, not from Hermes —
// from the .env files Hermes itself reads (~/.hermes/.env, the test home).
//
// Secret handling: values are stored in the 0600 file and only ever leave through
// mask() — "…abcd". The browser PUTs a full key only when the operator types one;
// an unchanged masked value round-trips as null and keeps the stored secret.
import fs from "node:fs";
import path from "node:path";

export interface VoiceSettings {
  provider: "browser" | "openai" | "dashscope";
  /** base URL. dashscope: the MaaS root (…/compatible-mode stripped) or the full
   *  compatible-mode URL — both accepted, normalised on use. openai: the /v1 base. */
  baseUrl: string;
  apiKey: string;
  /** speech-to-text. The two defaults are DashScope-specific names; any string is
   *  allowed because the dropdown is filled from the endpoint's own model list. */
  asrModel: string;
  /** batch/fallback ASR model (also used when the streaming model is unavailable) */
  asrBatchModel: string;
  /** use the WebSocket streaming pipeline when the provider supports it */
  asrStream: boolean;
  /** speech-synthesis model + voice (voice is provider-specific; longanhuan_v3.6 is
   *  龙安欢 on qwen-audio-3.0-tts-flash) */
  ttsModel: string;
  ttsVoice: string;
  ttsFormat: "wav" | "mp3";
  /** fixed hotwords, each "词" or "词=权重" (weight 1..5, 50 = super-hotword) */
  hotwords: string[];
  /** draw extra hotwords from recent transcript text (context enhancement) */
  dynamicHotwords: boolean;
  /** max hotwords sent per request */
  hotwordLimit: number;
}

/** Theme is a config item too (the operator asked for light/dark/follow-system), and it
 *  lives here so the choice survives a browser and a device: the page paints from
 *  localStorage for the first frame, then adopts this. */
export interface ThemeSettings {
  mode: "system" | "light" | "dark";
  /** empty = the built-in accent; otherwise a #hex colour */
  accent: string;
}

export const THEME_DEFAULT: ThemeSettings = { mode: "system", accent: "" };

export interface Settings {
  voice: VoiceSettings;
  theme: ThemeSettings;
  updatedAt: number;
}

const DEFAULTS: VoiceSettings = {
  provider: "dashscope",
  baseUrl: "",
  apiKey: "",
  asrModel: "qwen-audio-3.1-asr-flash-streaming",
  asrBatchModel: "qwen3-asr-flash",
  asrStream: true,
  ttsModel: "qwen-audio-3.0-tts-flash",
  ttsVoice: "longanhuan_v3.6",
  ttsFormat: "wav",
  hotwords: [],
  dynamicHotwords: true,
  hotwordLimit: 30,
};

let file = "";
let cache: Settings = { voice: { ...DEFAULTS }, theme: { ...THEME_DEFAULT }, updatedAt: 0 };
/** keys that came from env/.env (shown as "auto-detected" and used when settings are empty) */
let envCreds: { apiKey: string; baseUrl: string; source: string } | null = null;

function readEnvFile(p: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const i = t.indexOf("=");
      out[t.slice(0, i)] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* missing/unreadable: no env file */ }
  return out;
}

function discoverEnv(): { apiKey: string; baseUrl: string; source: string } | null {
  const sources: { env: Record<string, string | undefined>; label: string }[] = [
    { env: process.env, label: "process env" },
  ];
  for (const cand of [".hermes/.env", ".agentslot-test/home/.env"]) {
    const p = path.join(process.env.HOME ?? "", cand);
    if (fs.existsSync(p)) sources.push({ env: readEnvFile(p), label: p });
  }
  for (const s of sources) {
    const apiKey = s.env.DASHSCOPE_API_KEY ?? "";
    const baseUrl = s.env.DASHSCOPE_BASE_URL ?? "";
    if (apiKey && baseUrl) return { apiKey, baseUrl, source: s.label };
  }
  return null;
}

export function initSettings(dataDir: string): Settings {
  file = path.join(dataDir, "settings.json");
  envCreds = discoverEnv();
  let stored: Partial<Settings> = {};
  try {
    stored = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Settings>;
  } catch { /* first run */ }
  cache = {
    voice: { ...DEFAULTS, ...(stored.voice ?? {}) },
    theme: { ...THEME_DEFAULT, ...(stored.theme ?? {}) },
    updatedAt: Number((stored as Settings).updatedAt ?? 0),
  };
  // an unset baseUrl/apiKey bootstrap from the environment: the operator said the
  // Bailian endpoint lives in their .env, so the page must work before they type it
  if (!cache.voice.baseUrl && envCreds) cache.voice.baseUrl = envCreds.baseUrl;
  if (!cache.voice.apiKey && envCreds) cache.voice.apiKey = envCreds.apiKey;
  persist();
  return cache;
}

function persist(): void {
  try {
    fs.writeFileSync(file, JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error(`[agentslot] cannot write ${file}: ${(e as Error).message}`);
  }
}

export function getSettings(): Settings {
  return cache;
}

export function mask(secret: string): string {
  if (!secret) return "";
  return `••••${secret.slice(-4)}`;
}

/** What the settings page may see: everything except raw secrets. */
export function publicSettings(): Record<string, unknown> {
  const v = cache.voice;
  return {
    provider: v.provider,
    baseUrl: v.baseUrl,
    apiKeySet: Boolean(v.apiKey),
    apiKeyMasked: mask(v.apiKey),
    apiKeySource: envCreds?.source ?? null,
    theme: cache.theme,
    themeDefaults: THEME_DEFAULT,
    // The 百炼 system voices shipped with qwen-audio-3.0-tts-flash. A dropdown cannot be
    // complete (tenants add voices), so the page also accepts a typed id.
    ttsVoices: ["longanhuan_v3.6", "longjielidou_v3.6", "loongeva_v3.6", "loongjohn"],
    asrModel: v.asrModel,
    asrBatchModel: v.asrBatchModel,
    asrStream: v.asrStream,
    ttsModel: v.ttsModel,
    ttsVoice: v.ttsVoice,
    ttsFormat: v.ttsFormat,
    hotwords: v.hotwords,
    dynamicHotwords: v.dynamicHotwords,
    hotwordLimit: v.hotwordLimit,
    // the defaults, so the UI can offer "reset to Bailian defaults"
    defaults: { ...DEFAULTS, apiKey: undefined, baseUrl: undefined },
    updatedAt: cache.updatedAt,
  };
}

/** Merge a partial update. `apiKey: null` keeps the stored key (the UI round-trips a
 *  mask, never the secret). Empty strings clear. Values are validated narrowly: this
 *  config reaches an external API with the operator's credentials. */
export function saveSettings(patch: Record<string, unknown>): Settings {
  const v = { ...cache.voice };
  const pick = <K extends keyof VoiceSettings>(k: K, ok: (x: unknown) => x is VoiceSettings[K]): boolean => {
    if (!(k in patch)) return false;
    const raw = patch[k];
    if (!ok(raw)) throw new Error(`invalid ${String(k)}: ${JSON.stringify(raw)?.slice(0, 60)}`);
    v[k] = raw;
    return true;
  };
  pick("provider", (x): x is VoiceSettings["provider"] => ["browser", "openai", "dashscope"].includes(String(x)));
  pick("baseUrl", (x): x is string => typeof x === "string" && (x === "" || /^https?:\/\//.test(x)));
  pick("asrModel", (x): x is string => typeof x === "string" && x.length <= 100);
  pick("asrBatchModel", (x): x is string => typeof x === "string" && x.length <= 100);
  pick("asrStream", (x): x is boolean => typeof x === "boolean");
  pick("ttsModel", (x): x is string => typeof x === "string" && x.length <= 100);
  pick("ttsVoice", (x): x is string => typeof x === "string" && x.length <= 100);
  pick("ttsFormat", (x): x is "wav" | "mp3" => x === "wav" || x === "mp3");
  pick("dynamicHotwords", (x): x is boolean => typeof x === "boolean");
  pick("hotwordLimit", (x): x is number => typeof x === "number" && x >= 0 && x <= 200);
  pick("hotwords", (x): x is string[] => Array.isArray(x) && x.every((i) => typeof i === "string" && i.length <= 60));
  if ("apiKey" in patch) {
    const raw = patch.apiKey;
    if (raw === null || raw === undefined) { /* keep */ }
    else if (typeof raw === "string" && (raw === "" || /^sk-[\w.-]{6,}$/.test(raw))) v.apiKey = raw;
    else if (typeof raw === "string" && raw.startsWith("••••")) { /* unchanged mask: keep */ }
    else throw new Error("invalid apiKey (expected sk-…, or empty to clear)");
  }
  // a baseUrl typed as the compatible-mode URL still works: store the root for the
  // native endpoints and derive the compatible path from it
  cache = { ...cache, voice: v, updatedAt: Date.now() };
  persist();
  return cache;
}

/** Theme updates are separate from voice: a bad accent must not be able to lock an
 *  operator out of the page that would fix it — mode is an enum, accent is a hex colour. */
export function saveTheme(patch: Record<string, unknown>): Settings {
  const t = { ...cache.theme };
  if ("mode" in patch) {
    const mode = String(patch.mode ?? "");
    if (!["system", "light", "dark"].includes(mode)) throw new Error(`invalid theme mode: ${JSON.stringify(patch.mode)}`);
    t.mode = mode as ThemeSettings["mode"];
  }
  if ("accent" in patch) {
    const accent = String(patch.accent ?? "");
    if (accent && !/^#[0-9a-fA-F]{3,8}$/.test(accent)) throw new Error("invalid accent (expected #hex, or empty)");
    t.accent = accent;
  }
  cache = { ...cache, theme: t, updatedAt: Date.now() };
  persist();
  return cache;
}

/** Normalise the two URL shapes operators paste: MaaS root or .../compatible-mode/v1. */
export function dashscopeUrls(baseUrl: string): { root: string; compat: string; ws: string } {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const compatIdx = trimmed.indexOf("/compatible-mode");
  const root = compatIdx >= 0 ? trimmed.slice(0, compatIdx) : trimmed;
  return {
    root,
    compat: compatIdx >= 0 ? trimmed : `${root}/compatible-mode/v1`,
    ws: trimmed.replace(/^http/, "ws").split("/compatible-mode")[0] + "/api-ws/v1/inference",
  };
}
