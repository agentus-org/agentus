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
import type { BackendId } from "../../shared/src/index.js";
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
  /** read a finished reply aloud without being asked. Kept as a DERIVED mirror of `speakMode`:
   *  the two used to be one switch, and a client that only knows this name must keep working. */
  autoRead: boolean;
  /** WHAT gets read aloud (issue #16). "off" = nothing; "reply" = the finished reply, full text
   *  (the old autoRead); "brief" = the cockpit's own one-line briefs (`t:"speak"`), which is what
   *  a long answer needs — reading a whole reply aloud was the thing operators turned off. */
  speakMode: SpeakMode;
  /** browser voiceURI ("" = pick the best for the language) */
  voiceURI: string;
  rate: number;
  /** BCP-47 for both directions; "" = whatever the browser is set to */
  lang: string;
  /** route synthesis through the server endpoint instead of the browser */
  serverTts: boolean;
  /** which recogniser to use, when the caller does not force one */
  stt: "auto" | "browser" | "stream" | "server";
  /** Whether — and how often — the cockpit tells the agent about the plan MCP it was handed.
   *  The tool's own description says "prefer this over any todo tool", but on a runtime that
   *  keeps MCP tools in a lazy-loaded catalog the agent never reads it unless it goes looking,
   *  so the session's plan card stays empty while the agent keeps a todo list nobody can see.
   *  A per-turn nudge in the prompt is what closes that last mile; this is its switch. */
  planHint: PlanHintSettings;
}

/** Longest operator-authored plan instruction we store and inject. Sized for a few sentences of
 *  house rules, not a document — the block rides on the end of the operator's message every turn,
 *  so its cost is paid per turn, not once. */
export const PLAN_HINT_INSTRUCTION_MAX = 2000;

export interface PlanHintSettings {
  /** Inject the plan-tool hint at all. Off = the prompt carries the operator's words and
   *  nothing else (some operators do not want anything appended to their message). */
  on: boolean;
  /** true = every turn (the agent is re-told as the plan moves); false = only the first prompt
   *  of each agent process. Default true: this mirrors Studio, which appends its block to the
   *  latest input on EVERY turn (services/task-plan-runs.ts) — the per-turn re-statement is the
   *  part that makes an agent actually keep the card current, and an agent process can be
   *  long-lived enough that "first prompt only" means "once this morning". */
  everyTurn: boolean;
  /** The operator's own wording for the appended instruction. Empty = the built-in text (which
   *  names the tool, says why it beats a native todo, and how to find it when the runtime defers
   *  MCP tools). This replaces only the GUIDANCE half — the per-turn plan STATUS (which steps are
   *  still open) is generated from the card and stays authoritative, so an edit here can never
   *  make the prompt disagree with what the operator sees. */
  instruction: string;
}

export const SPEAK_MODES = ["off", "reply", "brief"] as const;
export type SpeakMode = (typeof SPEAK_MODES)[number];

export const PREFS_DEFAULT: PrefsSettings = {
  autoRead: false, speakMode: "off", voiceURI: "", rate: 1, lang: "", serverTts: false, stt: "auto",
  // On + every turn by default: the feature exists because the tool was there and nobody used it,
  // and 对齐 Studio means the block rides on every turn (see everyTurn's note). Both are visible
  // and switchable in 设置 — this is a default, not a lock.
  planHint: { on: true, everyTurn: true, instruction: "" },
};

export const CALL_DEFAULT: CallSettings = {
  /* 说完停顿 1.5s (was 1.2): the operator reads a pause as "it stopped listening" before 1.2 s,
     and a long sentence with a breath in the middle got cut. Both ends of the range still let
     the room decide — this is only where a fresh install starts. */
  interruptMode: "voice", bargeSensitivity: 60, bargeMs: 300, silenceMs: 1500, minChars: 3,
};

export const INTERRUPT_MODES: InterruptMode[] = ["voice", "button"];

/** How the cockpit treats AGENT PROCESSES — as opposed to what a conversation contains. AionUi
 *  ships the same knob in 设置 → 系统 as 「Agent 空闲超时（分钟）」 (default 5, 1–60, step 5) with the
 *  honest description 「空闲超过该时长后自动终止 Agent 进程以释放内存」. Agentus keeps that meaning
 *  and adds ONE thing AionUi does not have: 0 = 关闭. A cockpit deliberately left holding a
 *  long-running slot (a build, a tunnel watcher, a call) must be able to say "never reclaim this",
 *  and "set it to 60 and hope" is not the same statement. */
export interface AgentSettings {
  /** minutes of no activity before a live slot's agent process is stopped to reclaim memory;
   *  0 = never. The row and its transcript always survive — this only stops the process. */
  idleKillMin: number;
  /** 「热备」= how many of the most recently USED sessions keep their agent process no matter how
   *  quiet they go. A FLOOR, not a ceiling: it names the slots that may not be reclaimed for being
   *  idle, it does not bound how many may run. Ranked over live AND cold rows by the same clock the
   *  sweep uses — a slot already reaped must not hand its seat to a session nobody has touched in
   *  days. Archived rows never occupy a seat. 0 = off (every slot obeys idleKillMin). */
  warmSlots: number;
  /** Hours a warm slot may go untouched before even its exemption expires. Without this the warm set
   *  is a permanent memory floor (5 × ~137 MB RSS measured); with it, a cockpit left alone for a day
   *  comes back to nothing running. 0 = 不过期. */
  warmTtlHours: number;
  /** 驾驶舱互发消息 (issue #15): may an agent hand a message to ANOTHER session through the cockpit
   *  CLI (`agentus cockpit send`)? Off by default — two agents that can talk to each other without
   *  being asked are a loop generator, and the operator pays for those tokens. Reading the cockpit
   *  (`context`/`messages`/`plan`) is NOT gated: it cannot change anything, and it is what the
   *  工作播报 observer runs on. */
  cockpitSend: boolean;
  /** Let a finished background process wake the agent with its own result (issue #22). ON by default:
   *  this is what the CLI and the gateway already do, and the failure it prevents is the silent one —
   *  a session that looks finished while a build is still running, whose result nobody ever reads. */
  completionWake: boolean;
  /** 显示不唤醒的后台进程 (issue #35). OFF by default: the row and the rail badge answer
   *  「这个会话还在干活吗」, and a silent process the agent is polling itself is noise — the
   *  agent knows it is there, the operator does not need to. Turned ON, every running process
   *  shows, which is what the fork's original "a snapshot is the only witness" design wanted. */
  showSilentBackground: boolean;
  /** 记忆召回条目：单条最多多少字符（issue #37 的容量）。These items are a per-turn status frame
   *  that also lands in SQLite, so the number is a cost knob, not a formatting preference: it is
   *  handed to the agent as `HINDSIGHT_RECALL_ITEM_CHARS`, and the server applies the same limit
   *  when it re-caps what arrives. 400 = the operator's 2026-10-21 decision (was 200). */
  recallItemChars: number;
  /** 记忆召回条目：一轮最多多少字符。**这是唯一的条数闸门** —— 不按条数截，短记忆本来就该多
   *  进来几条，按条数截会连预算都没用完就把整条记忆丢掉。Handed to the agent as
   *  `HINDSIGHT_RECALL_TOTAL_CHARS`（12K = 操作者 2026-10-21 的决定，原来是 6K）。 */
  recallTotalChars: number;
}

export const AGENT_DEFAULT: AgentSettings = {
  idleKillMin: 5, warmSlots: 5, warmTtlHours: 24, cockpitSend: false, completionWake: true,
  showSilentBackground: false, recallItemChars: 400, recallTotalChars: 12000,
};

/** The numeric half of `AgentSettings` — the keys the range-checked helpers may write. */
type AgentNumberKey =
  | "idleKillMin" | "warmSlots" | "warmTtlHours" | "recallItemChars" | "recallTotalChars";


/** What the settings page may offer: the ends of the number field. Server-side enforcement uses
 *  the same pair, so a hand-written request cannot store a nonsense value. */
export const AGENT_IDLE_RANGE: [number, number] = [0, 60];
/** 0 = off. The upper end is a memory decision (one live agent ≈ 137 MB RSS measured), not a limit
 *  the server has to defend. */
export const AGENT_WARM_RANGE: [number, number] = [0, 20];
/** 0 = 不过期; a week is the longest span worth offering on the page. */
export const AGENT_WARM_TTL_RANGE: [number, number] = [0, 168];
/** 召回条目单条字符数：下限是为了别把一条记忆截成半句话，上限是「一整帧别超过一次 prompt 的量」。
 *  与 provider 的默认同值（400），页面改这里，spawn 时用环境变量覆盖 agent 侧同一对常量。 */
export const AGENT_RECALL_ITEM_RANGE: [number, number] = [80, 2000];
/** 一轮条目的总字符数。这就是条数闸门本身，所以下限不能太小（2000 ≈ 5 条长记忆）。 */
export const AGENT_RECALL_TOTAL_RANGE: [number, number] = [2000, 60000];

/** 观察智能体 (`工作播报`, issue #16): ONE long-lived ACP session per observed session, spawned by the
 *  cockpit, in its own scratch directory, read-only, out of the rail. It is the thing that turns
 *  「回合结束了」 into one sentence a person can listen to — it reads the cockpit through the CLI
 *  (issue #15) instead of being handed a summary, because a summariser that is told what happened
 *  cannot notice what the operator actually cares about.
 *
 *  Everything here is the operator's: the switch, which backend/model runs it (a cheap fast model is
 *  the right answer), the wording it answers in, and the throttle. */
export interface ObserverSettings {
  /** 工作播报 on/off. Off = no observer is spawned at all and the speaker falls back to #11's
   *  plan title (zero cost), then to nothing. */
  enabled: boolean;
  /** Which backend the observer runs on. null = same backend as the observed session (the default:
   *  an install that only configured one agent should not have to configure a second one). */
  backend: BackendId | null;
  /** The observer's own wording. "" = the built-in template (which is also what the settings page
   *  shows as the thing it will actually send). Sized like the plan hint's instruction: a few
   *  sentences of house style, not a document — it rides on ONE turn per brief. */
  systemPrompt: string;
  /** Shortest gap between two MODEL-backed briefs for the same session, in seconds. Zero-cost
   *  events (an approval is waiting, a step completed) never wait on it. Default 120: a brief per
   *  turn is fine, a brief per token is a phone that never stops talking. */
  throttleSec: number;
  /** 节拍上限 (issue #24), in seconds. 0 = off = pure event-driven (what shipped in #16).
   *
   *  What it is NOT: a period the cockpit obeys unconditionally. A long turn that never ends
   *  produces no `turn-end`, so the operator hears nothing for minutes — that is the hole this
   *  fills. The ticker only fires while a turn is IN FLIGHT and the last line was at least this
   *  long ago, so an idle cockpit stays silent and a busy one gets a word every N minutes.
   *  Deliberately separate from `throttleSec`: min-gap answers 「别话痨」, interval answers
   *  「长回合别死寂」, and one number cannot serve both. */
  intervalSec: number;
}

export const OBSERVER_PROMPT_MAX = 2000;
export const OBSERVER_THROTTLE_RANGE: [number, number] = [0, 3600];
/** 0 means 「不按节拍，只在事件上说」 — the whole feature's off switch for the timer. */
export const OBSERVER_INTERVAL_RANGE: [number, number] = [0, 3600];

/** What the observer is told, when the operator writes nothing. Two jobs in one paragraph: say who
 *  it is watching and how to find out (the cockpit CLI — never trust the trigger line for facts), and
 *  fix the output shape (one sentence, ≤60 characters, spoken aloud by a TTS voice). */
export const OBSERVER_PROMPT_DEFAULT = [
  "你是这个驾驶舱里某个会话的观察员。用 `$AGENTUS_COCKPIT_BIN session list` 看全景，",
  "用 `session <id>` / `messages <id> --tail 20` / `plan <id>` 核实它正在做什么、卡在哪。",
  "只陈述这些工具读到的事实，不猜、不补、不评价；工具没说的就当不知道。",
  "输出一句中文播报，不超过 60 字，会被语音念出来：不要 Markdown、不要列表、不要引号、不要解释你在做什么。",
].join("\n");

export const OBSERVER_DEFAULT: ObserverSettings = {
  // intervalSec 0 on purpose: a timer that spends tokens must be asked for. The speaker menu
  // offers 1/2/5 minutes in one tap, so turning it on is still one gesture.
  enabled: false, backend: null, systemPrompt: "", throttleSec: 120, intervalSec: 0,
};

/** 语音总结 (the message speaker's long press, 2026-10-18): ONE message → a few sentences worth
 *  listening to.
 *
 *  Deliberately NOT an agent, and deliberately not a fork: no session, no history, no tools. The
 *  server posts the message's own text plus this instruction to `{compat}/chat/completions` — the
 *  same door ASR already uses — and speaks what comes back. Two reasons the history must stay out
 *  of it: a summary of ONE message does not need the conversation, and handing it the conversation
 *  makes the model summarise the wrong thing (the session instead of the message).
 */
export interface SummarySettings {
  /** the long-press menu offers 语音播报总结 at all; off = the menu item disappears */
  enabled: boolean;
  /** The instruction. "" = the built-in template (which is what the settings page shows as the
   *  thing it will actually send). `{maxChars}` is substituted at call time. */
  prompt: string;
  /** Target length of the spoken text, in characters. Also the threshold below which the message is
   *  spoken verbatim without asking a model at all (cheap and instant beats a paraphrase). */
  maxChars: number;
  /** Use THIS session's own provider + model (`deepseek:deepseek-v4-flash` → DeepSeek) instead of
   *  the voice endpoint. On by default: the summary is a side call on the operator's existing
   *  account, not a second vendor to configure. When it cannot be resolved (a provider with no
   *  OpenAI-compatible endpoint, no key on this box) the call falls back to the voice endpoint and
   *  SAYS so in the response. */
  followSession: boolean;
  /** chat model on the voice endpoint — now the FALLBACK (and the only route when
   *  `followSession` is off). "" = SUMMARY_MODEL_DEFAULT. */
  model: string;
  /** give up after this many seconds — and SAY so; never pass the original off as a summary. */
  timeoutSec: number;
}

export const SUMMARY_PROMPT_MAX = 2000;
export const SUMMARY_CHARS_RANGE: [number, number] = [40, 400];
export const SUMMARY_TIMEOUT_RANGE: [number, number] = [5, 60];
/** Measured against this operator's workspace, 2026-10-18: `qwen-flash` answered a 40-character
 *  ask with 67 prompt / 20 completion tokens. `qwen3-flash` and `qwen-turbo` are 404 there ("Model
 *  not exist"), and `qwen3.8-flash` spent 235 output tokens thinking about the same sentence.
 *
 *  2026-10-20 (operator's call): the fallback IS `qwen3.8-flash` anyway — it is the model this
 *  workspace already talks to, and `qwen-flash` was a second vendor's answer to a problem that has
 *  a proper knob. The 235-token overspend is what `SUMMARY_THINKING_BUDGET` below exists for:
 *  thinking stays ON (it reads the message better) but is capped at 200 tokens. */
export const SUMMARY_MODEL_DEFAULT = "qwen3.8-flash";

/** Thinking cap for qwen3-family models, in tokens (`thinking_budget`). 200 is deliberate: enough
 *  to hold the sentence together, too small to wander — measured 235 → 200 keeps the visible
 *  answer intact at a fifth of the default 4000. NOT used for non-qwen3 models (DeepSeek ignores
 *  the field, and sending it there would be a lie about what we asked for). */
export const SUMMARY_THINKING_BUDGET = 200;

/** The most characters this feature will ever hand a model. Above it the call is REFUSED with a
 *  visible 409 instead of quietly summarising the head (#36) — a summary that silently drops the
 *  second half is worse than no summary, because the conclusion usually lives there. 20k ≈ 10k
 *  tokens: longer than any agent reply worth listening to, short enough that a pasted 200 KB log
 *  cannot turn one long press into a bill. */
export const SUMMARY_MAX_INPUT_CHARS = 20_000;

export const SUMMARY_PROMPT_DEFAULT = [
  "下面是我在一个工作会话里拿到的一段输出。请把它改写成一段「用嘴念出来」的摘要：",
  "· 只讲结论和关键动作；不复述步骤，不念代码，不念表格里的数字（关键结论除外）",
  "· 口语化，一句话一个意思；不要 Markdown、列表、引号、括号、表情",
  "· 不超过 {maxChars} 字；先说发生了什么变化 / 发现了什么，再说影响",
  "· 第一句直接说事，不要「这段内容讲了…」这种开场",
].join("\n");

export const SUMMARY_DEFAULT: SummarySettings = {
  enabled: true, prompt: "", maxChars: 120, followSession: true, model: "", timeoutSec: 20,
};

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
  agent: AgentSettings;
  observer: ObserverSettings;
  summary: SummarySettings;
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
  prefs: { ...PREFS_DEFAULT }, agent: { ...AGENT_DEFAULT },
  observer: { ...OBSERVER_DEFAULT }, summary: { ...SUMMARY_DEFAULT }, updatedAt: 0,
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
  // The credentials live in the agent's own home — the cockpit reads the same .env its slots do.
  // AGENTUS_HERMES_HOME can move that fallback to whatever home this box really uses.
  const cands = [path.join(process.env.HOME ?? "", ".hermes", ".env")];
  if (process.env.AGENTUS_HERMES_HOME) {
    cands.push(path.join(process.env.AGENTUS_HERMES_HOME, ".env"));
  }
  for (const p of cands) {
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
        console.log(`[agentus] settings: imported ${legacyFile} into the store`);
      }
      fs.renameSync(legacyFile, `${legacyFile}.imported`);
    } catch { /* no legacy file: nothing to migrate */ }
  }
  cache = {
    voice: { ...DEFAULTS, ...(stored.voice ?? {}) },
    theme: { ...THEME_DEFAULT, ...(stored.theme ?? {}) },
    call: pickCall(stored.call),
    prefs: pickPrefs(stored.prefs),
    agent: pickAgent(stored.agent),
    observer: pickObserver(stored.observer),
    summary: pickSummary(stored.summary),
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

/** The agent-process knobs. Out-of-range or unparseable values fall back to the shipped default
 *  rather than throwing: this section decides whether a slot's process is reclaimed, and a settings
 *  row that cannot be read must never leave the reaper in an undefined state (an undefined `> 0`
 *  comparison would silently turn reclaiming OFF — the safe failure is the documented default). */
function pickAgent(raw: unknown): AgentSettings {
  const out = { ...AGENT_DEFAULT };
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    // Explicitly the NUMERIC keys: `AgentSettings` also carries `cockpitSend: boolean`, and a
    // `keyof` assignment would have to satisfy both sides of the union.
    const take = (key: AgentNumberKey, range: [number, number]): void => {
      const v = Number(r[key]);
      const [lo, hi] = range;
      if (Number.isFinite(v) && v >= lo && v <= hi) out[key] = v;
    };
    take("idleKillMin", AGENT_IDLE_RANGE);
    take("warmSlots", AGENT_WARM_RANGE);
    take("warmTtlHours", AGENT_WARM_TTL_RANGE);
    take("recallItemChars", AGENT_RECALL_ITEM_RANGE);
    take("recallTotalChars", AGENT_RECALL_TOTAL_RANGE);
    if (typeof r.cockpitSend === "boolean") out.cockpitSend = r.cockpitSend;
    if (typeof r.completionWake === "boolean") out.completionWake = r.completionWake;
    if (typeof r.showSilentBackground === "boolean") out.showSilentBackground = r.showSilentBackground;
  }
  return out;
}

/** The observer's own section. Untrusted like the rest: an unknown backend id, a prompt over the
 *  cap or a throttle outside the range falls back to the shipped default rather than throwing —
 *  this section decides whether the cockpit spawns an agent to talk about another agent, and a
 *  corrupt row must leave it in the SHIPPED state (off), not in a half-configured one. */
function pickObserver(raw: unknown): ObserverSettings {
  const out = { ...OBSERVER_DEFAULT };
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (typeof r.enabled === "boolean") out.enabled = r.enabled;
    if (typeof r.backend === "string" && r.backend) out.backend = r.backend as BackendId;
    if (typeof r.systemPrompt === "string" && r.systemPrompt.length <= OBSERVER_PROMPT_MAX) {
      out.systemPrompt = r.systemPrompt;
    }
    const n = Number(r.throttleSec);
    const [lo, hi] = OBSERVER_THROTTLE_RANGE;
    if (Number.isFinite(n) && n >= lo && n <= hi) out.throttleSec = n;
    const iv = Number(r.intervalSec);
    const [ilo, ihi] = OBSERVER_INTERVAL_RANGE;
    if (Number.isFinite(iv) && iv >= ilo && iv <= ihi) out.intervalSec = Math.round(iv);
  }
  return out;
}

function pickPrefs(raw: unknown): PrefsSettings {
  const out = { ...PREFS_DEFAULT };
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    // `speakMode` is the source of truth; `autoRead` is the pre-#16 name for its "reply" value. A
    // stored section carries one or the other depending on which build wrote it last, so accept
    // both and let the newer name win when both are present.
    if (r.speakMode === "off" || r.speakMode === "reply" || r.speakMode === "brief") out.speakMode = r.speakMode;
    else if (typeof r.autoRead === "boolean") out.speakMode = r.autoRead ? "reply" : "off";
    out.autoRead = out.speakMode === "reply";
    if (typeof r.serverTts === "boolean") out.serverTts = r.serverTts;
    if (typeof r.voiceURI === "string" && r.voiceURI.length <= 200) out.voiceURI = r.voiceURI;
    if (typeof r.lang === "string" && (!r.lang || /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(r.lang))) out.lang = r.lang;
    const rate = Number(r.rate);
    if (Number.isFinite(rate) && rate >= 0.5 && rate <= 2) out.rate = rate;
    if (r.stt === "auto" || r.stt === "browser" || r.stt === "stream" || r.stt === "server") out.stt = r.stt;
    const h = r.planHint;
    if (h && typeof h === "object") {
      const hr = h as Record<string, unknown>;
      if (typeof hr.on === "boolean") out.planHint.on = hr.on;
      if (typeof hr.everyTurn === "boolean") out.planHint.everyTurn = hr.everyTurn;
      if (typeof hr.instruction === "string" && hr.instruction.length <= PLAN_HINT_INSTRUCTION_MAX) {
        out.planHint.instruction = hr.instruction;
      }
    }
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
    db.setSetting("agent", cache.agent);
    db.setSetting("observer", cache.observer);
    db.setSetting("summary", cache.summary);
  } catch (e) {
    console.error(`[agentus] cannot write settings: ${(e as Error).message}`);
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
    agent: cache.agent,
    agentDefaults: AGENT_DEFAULT,
    agentIdleRange: AGENT_IDLE_RANGE,
    agentWarmRange: AGENT_WARM_RANGE,
    agentWarmTtlRange: AGENT_WARM_TTL_RANGE,
    agentRecallItemRange: AGENT_RECALL_ITEM_RANGE,
    agentRecallTotalRange: AGENT_RECALL_TOTAL_RANGE,
    observer: cache.observer,
    observerDefaults: OBSERVER_DEFAULT,
    observerPromptDefault: OBSERVER_PROMPT_DEFAULT,
    observerPromptMax: OBSERVER_PROMPT_MAX,
    observerThrottleRange: OBSERVER_THROTTLE_RANGE,
    observerIntervalRange: OBSERVER_INTERVAL_RANGE,
    summary: cache.summary,
    summaryDefaults: SUMMARY_DEFAULT,
    summaryPromptDefault: SUMMARY_PROMPT_DEFAULT,
    summaryPromptMax: SUMMARY_PROMPT_MAX,
    summaryCharsRange: SUMMARY_CHARS_RANGE,
    summaryTimeoutRange: SUMMARY_TIMEOUT_RANGE,
    summaryModelDefault: SUMMARY_MODEL_DEFAULT,
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
  // 三档（关 / 自动朗读 / 工作播报）. The old boolean still writes, so a cached page from before this
  // change does something sensible instead of failing: autoRead:true = "reply", false = "off".
  if ("speakMode" in patch) {
    const v = String(patch.speakMode ?? "");
    if (!SPEAK_MODES.includes(v as SpeakMode)) throw new Error(`invalid speakMode: ${JSON.stringify(patch.speakMode)}`);
    next.speakMode = v as SpeakMode;
    next.autoRead = v === "reply";
  } else if ("autoRead" in patch) {
    if (typeof patch.autoRead !== "boolean") throw new Error("invalid autoRead: expected true/false");
    next.speakMode = patch.autoRead ? "reply" : "off";
    next.autoRead = patch.autoRead;
  }
  if ("planHint" in patch) {
    const h = patch.planHint;
    if (!h || typeof h !== "object") throw new Error("invalid planHint: expected an object");
    const hr = h as Record<string, unknown>;
    const nextHint = { ...next.planHint };
    if ("on" in hr) {
      if (typeof hr.on !== "boolean") throw new Error("invalid planHint.on: expected true/false");
      nextHint.on = hr.on;
    }
    if ("everyTurn" in hr) {
      if (typeof hr.everyTurn !== "boolean") throw new Error("invalid planHint.everyTurn: expected true/false");
      nextHint.everyTurn = hr.everyTurn;
    }
    if ("instruction" in hr) {
      if (typeof hr.instruction !== "string") throw new Error("invalid planHint.instruction: expected a string");
      // Trimmed on the way in: whitespace-only means "use the built-in text", and storing it as the
      // empty string keeps that one case one case.
      if (hr.instruction.length > PLAN_HINT_INSTRUCTION_MAX) {
        throw new Error(`invalid planHint.instruction: longer than ${PLAN_HINT_INSTRUCTION_MAX} characters`);
      }
      nextHint.instruction = hr.instruction.trim() ? hr.instruction : "";
    }
    next.planHint = nextHint;
  }
  cache = { ...cache, prefs: next, updatedAt: Date.now() };
  persist();
  return cache;
}

/** Agent-process knobs: its own update, like theme/call, so a bad number here cannot lock the
 *  operator out of the page that would fix it. Range-checked against the section's range table
 *  before it is stored — these numbers decide whether agent processes get killed, so they are not
 *  text fields. */
export function saveAgent(patch: Record<string, unknown>): Settings {
  const a = { ...cache.agent };
  const set = (key: AgentNumberKey, range: [number, number], unit: string, off: string): void => {
    if (!(key in patch)) return;
    const raw = typeof patch[key] === "number" ? (patch[key] as number) : Number(patch[key]);
    const [lo, hi] = range;
    if (!Number.isFinite(raw) || raw < lo || raw > hi) {
      throw new Error(`invalid ${key}: ${JSON.stringify(patch[key])} (expected ${lo}…${hi} ${unit}, ${off})`);
    }
    a[key] = raw;
  };
  set("idleKillMin", AGENT_IDLE_RANGE, "minutes", "0 = off");
  set("warmSlots", AGENT_WARM_RANGE, "slots", "0 = off");
  set("warmTtlHours", AGENT_WARM_TTL_RANGE, "hours", "0 = never expires");
  set("recallItemChars", AGENT_RECALL_ITEM_RANGE, "chars", "no 0 — a cap must stay a cap");
  set("recallTotalChars", AGENT_RECALL_TOTAL_RANGE, "chars", "no 0 — a cap must stay a cap");
  // A boolean next to three numbers: spelled out rather than forced through the numeric `set`.
  if ("cockpitSend" in patch) {
    if (typeof patch.cockpitSend !== "boolean") throw new Error("invalid cockpitSend: expected true or false");
    a.cockpitSend = patch.cockpitSend;
  }
  if ("completionWake" in patch) {
    if (typeof patch.completionWake !== "boolean") throw new Error("invalid completionWake: expected true or false");
    a.completionWake = patch.completionWake;
  }
  if ("showSilentBackground" in patch) {
    if (typeof patch.showSilentBackground !== "boolean") throw new Error("invalid showSilentBackground: expected true or false");
    a.showSilentBackground = patch.showSilentBackground;
  }
  cache = { ...cache, agent: a, updatedAt: Date.now() };
  persist();
  return cache;
}

/** The agent-process knobs as the reaper reads them — on every tick, so a settings change applies
 *  without a restart. Returns the live cache object, not a copy: a caller that wants a snapshot has
 *  no business holding this one. */
export function agentSettings(): AgentSettings {
  return cache.agent;
}

/** 观察智能体 knobs (issue #16). Read per event, like the plan hint: 工作播报 must be switchable
 *  without restarting anything. */
export function observerSettings(): ObserverSettings {
  return cache.observer;
}

/** Save 观察智能体. Its own update, like the agent knobs, so a bad value in this section cannot
 *  lock the operator out of the page that fixes it. */
export function saveObserver(patch: Record<string, unknown>): Settings {
  const o = { ...cache.observer };
  if ("enabled" in patch) {
    if (typeof patch.enabled !== "boolean") throw new Error("invalid enabled: expected true/false");
    o.enabled = patch.enabled;
  }
  if ("backend" in patch) {
    const v = patch.backend;
    if (v === null || v === "") o.backend = null;
    else if (typeof v === "string" && v.length <= 40) o.backend = v as BackendId;
    else throw new Error(`invalid backend: ${JSON.stringify(v).slice(0, 40)}`);
  }
  if ("systemPrompt" in patch) {
    const v = String(patch.systemPrompt ?? "");
    if (v.length > OBSERVER_PROMPT_MAX) {
      throw new Error(`invalid systemPrompt: longer than ${OBSERVER_PROMPT_MAX} characters`);
    }
    // Whitespace-only means "use the built-in template", the same rule the plan hint uses.
    o.systemPrompt = v.trim() ? v : "";
  }
  if ("throttleSec" in patch) {
    const n = Number(patch.throttleSec);
    const [lo, hi] = OBSERVER_THROTTLE_RANGE;
    if (!Number.isFinite(n) || n < lo || n > hi) {
      throw new Error(`invalid throttleSec: ${JSON.stringify(patch.throttleSec)} (expected ${lo}…${hi} seconds)`);
    }
    o.throttleSec = Math.round(n);
  }
  if ("intervalSec" in patch) {
    const n = Number(patch.intervalSec);
    const [lo, hi] = OBSERVER_INTERVAL_RANGE;
    if (!Number.isFinite(n) || n < lo || n > hi) {
      throw new Error(`invalid intervalSec: ${JSON.stringify(patch.intervalSec)} (expected ${lo}…${hi} seconds, 0 = off)`);
    }
    o.intervalSec = Math.round(n);
  }
  cache = { ...cache, observer: o, updatedAt: Date.now() };
  persist();
  return cache;
}

/** 语音总结 knobs. Untrusted like every other section: a corrupt row must leave it in the SHIPPED
 *  state (on, 120 characters, built-in prompt), never in a half-configured one. */
function pickSummary(raw: unknown): SummarySettings {
  const out = { ...SUMMARY_DEFAULT };
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (typeof r.enabled === "boolean") out.enabled = r.enabled;
    if (typeof r.followSession === "boolean") out.followSession = r.followSession;
    if (typeof r.prompt === "string" && r.prompt.length <= SUMMARY_PROMPT_MAX) out.prompt = r.prompt;
    if (typeof r.model === "string" && r.model.length <= 60) out.model = r.model;
    const chars = Number(r.maxChars);
    const [clo, chi] = SUMMARY_CHARS_RANGE;
    if (Number.isFinite(chars) && chars >= clo && chars <= chi) out.maxChars = Math.round(chars);
    const t = Number(r.timeoutSec);
    const [tlo, thi] = SUMMARY_TIMEOUT_RANGE;
    if (Number.isFinite(t) && t >= tlo && t <= thi) out.timeoutSec = Math.round(t);
  }
  return out;
}

/** Read per request: the long press must pick up a new prompt without a restart. */
export function summarySettings(): SummarySettings {
  return cache.summary;
}

/** Save 语音总结. Its own update, so a bad value here cannot lock the operator out of the page
 *  that fixes it. */
export function saveSummary(patch: Record<string, unknown>): Settings {
  const s = { ...cache.summary };
  if ("enabled" in patch) {
    if (typeof patch.enabled !== "boolean") throw new Error("invalid enabled: expected true/false");
    s.enabled = patch.enabled;
  }
  if ("prompt" in patch) {
    const v = String(patch.prompt ?? "");
    if (v.length > SUMMARY_PROMPT_MAX) {
      throw new Error(`invalid prompt: longer than ${SUMMARY_PROMPT_MAX} characters`);
    }
    // whitespace-only means "use the built-in template", same rule as the observer's wording
    s.prompt = v.trim() ? v : "";
  }
  if ("followSession" in patch) {
    if (typeof patch.followSession !== "boolean") throw new Error("invalid followSession: expected true/false");
    s.followSession = patch.followSession;
  }
  if ("model" in patch) {
    const v = String(patch.model ?? "").trim();
    if (v.length > 60) throw new Error("invalid model: longer than 60 characters");
    s.model = v;
  }
  if ("maxChars" in patch) {
    const n = Number(patch.maxChars);
    const [lo, hi] = SUMMARY_CHARS_RANGE;
    if (!Number.isFinite(n) || n < lo || n > hi) {
      throw new Error(`invalid maxChars: ${JSON.stringify(patch.maxChars)} (expected ${lo}…${hi})`);
    }
    s.maxChars = Math.round(n);
  }
  if ("timeoutSec" in patch) {
    const n = Number(patch.timeoutSec);
    const [lo, hi] = SUMMARY_TIMEOUT_RANGE;
    if (!Number.isFinite(n) || n < lo || n > hi) {
      throw new Error(`invalid timeoutSec: ${JSON.stringify(patch.timeoutSec)} (expected ${lo}…${hi})`);
    }
    s.timeoutSec = Math.round(n);
  }
  cache = { ...cache, summary: s, updatedAt: Date.now() };
  persist();
  return cache;
}

/** The plan-hint knobs. Read on EVERY prompt (not cached here), so the switch in 设置 takes effect
 *  on the operator's very next turn — no restart, no session to hibernate. */
export function planHintSettings(): PlanHintSettings {
  return cache.prefs.planHint;
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
