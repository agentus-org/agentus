// Operator settings: one row per section in the store's `settings` table, secrets never
// echoed back.
//
// Why the DB and not just env: the voice / theme / call / prefs features are configurable
// from the UI, and a restart (or another device) must not lose the operator's choices. Env
// stays the *bootstrap*: DASHSCOPE_API_KEY / DASHSCOPE_BASE_URL are read from the process
// env and — because the server is usually started from a plain shell, not from Hermes —
// from the .env files Hermes itself reads (~/.hermes/.env, the test home).
//
// Why not localStorage (the old home of the prefs section): a setting that describes how
// THE OPERATOR works — read replies aloud, which voice, which recogniser, how the call
// behaves — has to follow them from the phone to the laptop. localStorage already proved the
// point by disagreeing with itself across two tabs of the same instance. The browser keeps a
// copy for the first frame; the store is the truth.
//
// Secret handling: values live in the 0600 store and only ever leave through mask() —
// "…abcd". The browser PUTs a full key only when the operator types one; an unchanged
// masked value round-trips as null and keeps the stored secret.
import fs from "node:fs";
import path from "node:path";
import type { Store } from "./store/store.js";

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

/** Call-mode tuning. These are operator-visible because they are environment-dependent —
 *  what a phone's own loudspeaker leaks back into its microphone is nothing like a headset
 *  in a quiet room — so the defaults are a starting point, not a truth. The call page owns
 *  the panel; the settings page reads the same numbers. */
export type InterruptMode = "voice" | "button";

export interface CallSettings {
  /** WHO gets to interrupt the agent, and the operator picks:
   *  - `voice`  — the operator's own voice crossing the barge threshold (hands-free);
   *  - `button` — only the orb, i.e. a deliberate press.
   *  Both exist because the room decides: a phone on a table leaks its own loudspeaker straight
   *  into its own microphone, so a hands-free call there interrupts itself all the time. The orb
   *  tap always works in both modes — it is the one control that means "the floor changes hands". */
  interruptMode: InterruptMode;
  /** HOW EASY it is to talk over the reply, 0..100 (high = easy). Stored as a sensitivity,
   *  not as a mic level: the panel says "灵敏度 60%" and the number has to mean that. The
   *  threshold it maps to lives in the client (callSettings.ts `bargeLevelOf`), because the
   *  mic scale is the client's business. */
  bargeSensitivity: number;
  /** how long that level has to hold before the floor changes hands (ms) */
  bargeMs: number;
  /** silence that ends the operator's sentence (ms) */
  silenceMs: number;
  /** an AUTOMATIC send shorter than this many characters is dropped instead of being sent
   *  as a turn (1 = no limit). A tap on the orb always sends what is there — that gesture
   *  is an explicit instruction, not a guess about where a sentence ended. */
  minChars: number;
}

/** How the operator wants to TALK to the agent. These were browser-local (localStorage) and
 *  are now the operator's settings like everything else: the read-aloud switch, the voice and
 *  the speed have to be the same on the phone as on the laptop, and a second tab disagreeing
 *  with the first is a bug, not a feature. */
export interface PrefsSettings {
  /** read a finished reply aloud without being asked */
  autoRead: boolean;
  /** browser voiceURI ("" = pick the best for the language) */
  voiceURI: string;
  rate: number;
  /** BCP-47 for both directions; "" = whatever the browser is set to */
  lang: string;
  /** route synthesis through the server endpoint instead of the browser */
  serverTts: boolean;
  /** which recogniser to use, when the caller does not force one */
  stt: "auto" | "browser" | "stream" | "server";
}

export const PREFS_DEFAULT: PrefsSettings = {
  autoRead: false, voiceURI: "", rate: 1, lang: "", serverTts: false, stt: "auto",
};

export const CALL_DEFAULT: CallSettings = {
  interruptMode: "voice", bargeSensitivity: 60, bargeMs: 300, silenceMs: 1200, minChars: 3,
};

export const INTERRUPT_MODES: InterruptMode[] = ["voice", "button"];

/** The NUMERIC knobs. `interruptMode` is a two-way choice, not a slider, so it is deliberately
 *  outside both the range table and the loops that validate numbers. */
export const CALL_NUMERIC = ["bargeSensitivity", "bargeMs", "silenceMs", "minChars"] as const;
export type CallNumeric = (typeof CALL_NUMERIC)[number];

/** What this section shipped with before the sensitivity rename. A stored section that is still
 *  EXACTLY this is a section nobody ever touched — the operator should get the new defaults
 *  rather than a fossil of the old ones (the live instance had 最少字数 1 stored simply because
 *  1 used to be the default). One deliberate change to any knob and the section is left alone. */
/** True when every knob still sits at a shipped value — either generation: the pre-rename row
 *  had `bargeLevel`, and a row that has already been through pickCall has no such key at all. */
function callAtShippedDefaults(r: Record<string, unknown>): boolean {
  const sens = r.bargeSensitivity === undefined ? Number(r.bargeLevel) === 0.2 : Number(r.bargeSensitivity) === 60;
  // The mode counts too: a row that only says `interruptMode: "button"` IS a deliberate choice and
  // must not be reset along with a section that happens to still carry the old numbers.
  const modeShipped = r.interruptMode === undefined || r.interruptMode === CALL_DEFAULT.interruptMode;
  return sens && modeShipped && Number(r.bargeMs) === 300 && Number(r.silenceMs) === 1200 && Number(r.minChars) === 1;
}

/** What each knob may be. The ranges are the panel's slider ends; the server is the one
 *  that enforces them, so a hand-written request cannot store a nonsense value. */
export const CALL_RANGE: Record<CallNumeric, [number, number]> = {
  bargeSensitivity: [0, 100],
  bargeMs: [100, 1000],
  silenceMs: [400, 4000],
  minChars: [1, 20],
};

export interface Settings {
  voice: VoiceSettings;
  theme: ThemeSettings;
  call: CallSettings;
  prefs: PrefsSettings;
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
  // mp3, not wav: measured on a real endpoint, the same 84-character reply is 664 KB of wav
  // versus 193 KB of mp3 (and 154 KB vs 37 KB for one sentence). The operator is often on a
  // phone or through a tunnel, where those bytes are the wait. Still a setting: wav is one
  // click away for anyone who wants it.
  ttsFormat: "mp3",
  hotwords: [],
  dynamicHotwords: true,
  hotwordLimit: 30,
};

let db: Store | null = null;
let legacyFile = "";
let cache: Settings = {
  voice: { ...DEFAULTS }, theme: { ...THEME_DEFAULT }, call: { ...CALL_DEFAULT },
  prefs: { ...PREFS_DEFAULT }, updatedAt: 0,
};
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

export function initSettings(dataDir: string, store: Store): Settings {
  db = store;
  legacyFile = path.join(dataDir, "settings.json");
  envCreds = discoverEnv();
  const stored: Partial<Settings> = { ...(store.listSettings() as Partial<Settings>) };
  if (!stored.voice && !stored.theme && !stored.call) {
    // first run on this DB: adopt whatever the pre-store JSON file held, once. The file is
    // left in place (renamed) rather than deleted — it is the only copy of a key that the
    // operator may have typed by hand.
    try {
      const fromFile = JSON.parse(fs.readFileSync(legacyFile, "utf8")) as Partial<Settings>;
      if (fromFile.voice || fromFile.theme || fromFile.call) {
        stored.voice = fromFile.voice;
        stored.theme = fromFile.theme;
        stored.call = fromFile.call;
        console.log(`[agentslot] settings: imported ${legacyFile} into the store`);
      }
      fs.renameSync(legacyFile, `${legacyFile}.imported`);
    } catch { /* no legacy file: nothing to migrate */ }
  }
  cache = {
    voice: { ...DEFAULTS, ...(stored.voice ?? {}) },
    theme: { ...THEME_DEFAULT, ...(stored.theme ?? {}) },
    call: pickCall(stored.call),
    prefs: pickPrefs(stored.prefs),
    updatedAt: Number((stored as Settings).updatedAt ?? 0),
  };
  // an unset baseUrl/apiKey bootstrap from the environment: the operator said the
  // Bailian endpoint lives in their .env, so the page must work before they type it
  if (!cache.voice.baseUrl && envCreds) cache.voice.baseUrl = envCreds.baseUrl;
  if (!cache.voice.apiKey && envCreds) cache.voice.apiKey = envCreds.apiKey;
  persist();
  return cache;
}

/** A stored section is not trusted: it may predate a rename (the call knobs replaced
 *  `bargeLevel` with `bargeSensitivity`) or carry keys nothing understands any more. Anything
 *  unrecognised or out of range is dropped, so the payload the UI reads has exactly the
 *  fields it knows about. */
function pickCall(raw: unknown): CallSettings {
  const out = { ...CALL_DEFAULT };
  if (raw && typeof raw === "object") {
    if (callAtShippedDefaults(raw as Record<string, unknown>)) return out;
    const mode = (raw as Record<string, unknown>).interruptMode;
    if (INTERRUPT_MODES.includes(mode as InterruptMode)) out.interruptMode = mode as InterruptMode;
    for (const k of CALL_NUMERIC) {
      const v = Number((raw as Record<string, unknown>)[k]);
      const [lo, hi] = CALL_RANGE[k];
      if (Number.isFinite(v) && v >= lo && v <= hi) out[k] = v;
    }
  }
  return out;
}

function pickPrefs(raw: unknown): PrefsSettings {
  const out = { ...PREFS_DEFAULT };
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (typeof r.autoRead === "boolean") out.autoRead = r.autoRead;
    if (typeof r.serverTts === "boolean") out.serverTts = r.serverTts;
    if (typeof r.voiceURI === "string" && r.voiceURI.length <= 200) out.voiceURI = r.voiceURI;
    if (typeof r.lang === "string" && (!r.lang || /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(r.lang))) out.lang = r.lang;
    const rate = Number(r.rate);
    if (Number.isFinite(rate) && rate >= 0.5 && rate <= 2) out.rate = rate;
    if (r.stt === "auto" || r.stt === "browser" || r.stt === "stream" || r.stt === "server") out.stt = r.stt;
  }
  return out;
}

/** One row per section, so a change to the call knobs cannot lose the speech key. */
function persist(): void {
  if (!db) return;
  try {
    db.setSetting("voice", cache.voice);
    db.setSetting("theme", cache.theme);
    db.setSetting("call", cache.call);
    db.setSetting("prefs", cache.prefs);
  } catch (e) {
    console.error(`[agentslot] cannot write settings: ${(e as Error).message}`);
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
    call: cache.call,
    callDefaults: CALL_DEFAULT,
    callRange: CALL_RANGE,
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
    prefs: cache.prefs,
    prefsDefaults: PREFS_DEFAULT,
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

/** Call tuning is a separate update for the same reason theme is: a bad number here must
 *  not be able to lock the operator out of the page that would fix it. Every key is checked
 *  against CALL_RANGE before it is stored. */
export function saveCall(patch: Record<string, unknown>): Settings {
  const c = { ...cache.call };
  if ("interruptMode" in patch) {
    const mode = patch.interruptMode;
    if (!INTERRUPT_MODES.includes(mode as InterruptMode)) {
      throw new Error(`invalid interruptMode: ${JSON.stringify(mode)} (expected voice|button)`);
    }
    c.interruptMode = mode as InterruptMode;
  }
  for (const key of CALL_NUMERIC) {
    if (!(key in patch)) continue;
    const raw = typeof patch[key] === "number" ? patch[key] as number : Number(patch[key]);
    const [lo, hi] = CALL_RANGE[key];
    if (!Number.isFinite(raw) || raw < lo || raw > hi) {
      throw new Error(`invalid ${key}: ${JSON.stringify(patch[key])} (expected ${lo}…${hi})`);
    }
    c[key] = raw;
  }
  cache = { ...cache, call: c, updatedAt: Date.now() };
  persist();
  return cache;
}

/** The talk-to-the-agent preferences. Every key is checked here rather than trusted: this
 *  set reaches a speech endpoint, and `rate` in particular feeds an audio API. */
export function savePrefs(patch: Record<string, unknown>): Settings {
  const next = { ...cache.prefs };
  if ("autoRead" in patch) {
    if (typeof patch.autoRead !== "boolean") throw new Error("invalid autoRead: expected true/false");
    next.autoRead = patch.autoRead;
  }
  if ("serverTts" in patch) {
    if (typeof patch.serverTts !== "boolean") throw new Error("invalid serverTts: expected true/false");
    next.serverTts = patch.serverTts;
  }
  if ("voiceURI" in patch) {
    const v = String(patch.voiceURI ?? "");
    if (v.length > 200) throw new Error("invalid voiceURI: too long");
    next.voiceURI = v;
  }
  if ("lang" in patch) {
    const v = String(patch.lang ?? "");
    if (v && !/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(v)) throw new Error(`invalid lang: ${JSON.stringify(v).slice(0, 40)}`);
    next.lang = v;
  }
  if ("rate" in patch) {
    const v = Number(patch.rate);
    if (!Number.isFinite(v) || v < 0.5 || v > 2) throw new Error(`invalid rate: ${JSON.stringify(patch.rate)} (expected 0.5…2)`);
    next.rate = v;
  }
  if ("stt" in patch) {
    const v = String(patch.stt ?? "");
    if (!["auto", "browser", "stream", "server"].includes(v)) throw new Error(`invalid stt: ${JSON.stringify(patch.stt)}`);
    next.stt = v as PrefsSettings["stt"];
  }
  cache = { ...cache, prefs: next, updatedAt: Date.now() };
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
