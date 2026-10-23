// The face's mood engine: WHICH expression, and with what numbers.
//
// WHY THIS FILE EXISTS. 糯米模式（`CallMode` 的 nomi 变体）上半屏/左半屏是一张会动的脸。要让这张脸
// 像 OpenNomi 那样「活着」，靠的不是美术资源（它自己也没有一张图，两只 capsule + 一条弧线就是全部），
// 而是一张**情绪表**加四个**连续量**：attention（瞳孔多宽）、energy（多亮）、warmth（说完的余温）、
// phaseElapsed（想了几秒）。这一层全是算术，能离开浏览器验证，所以它住在这里、由
// `scripts/qa/nomi-mood.mts` 钉住；canvas 那边只管把数字画出来。
//
// 数字的来源：`kerwinyoung77/OpenNomi`（MIT）的 `NomiExpressionView.swift` / `EyeView`。
// 我们**重写**而不是搬运：它用 SwiftUI 的 View 组合与动画曲线，我们用 canvas 每帧算数；
// 搬过来的只有「哪些量、取什么值」这类事实性参数（尺寸、时长、阈值），代码形态是自己的。
//
// 两个来源，叠加而不是二选一（操作者 2026-10-23 拍板的第一条；第二条他也同意「要」）：
//   1. **状态层**（永远在）：通话相位 + 音频电平 + 相位时长 → 动作与神态。不依赖模型，永不缺席。
//   2. **情绪层**（可关）：agent 在句首写 `[emo:happy]` 这样的隐藏标记，这里剥掉、映射成 mood。
//      标记必须在**送 TTS 前、进转录前、落历史前**剥干净 —— `splitForSpeech()` 只剥
//      `[*_`#>|]`，不剥方括号，漏一处就会被念成「方括号 happy 方括号」。
import type { CallPhase } from "./CallMode";

/** 16 faces from OpenNomi + THREE of our own, because our agent is not a chatbot. */
export type NomiMood =
  | "idle" | "talking" | "loading" | "sleep" | "lookLeft" | "lookRight" | "scan" | "strive"
  | "focus" | "drowsy" | "happy" | "sad" | "surprise" | "curious" | "wink" | "error"
  // ── 我们自己的三种「没有标准输出」的脸 ──────────────────────────────────────────────────
  // OpenNomi 后端就是一个聊天机器人：它只会有「在听 / 在想 / 在说」。Agentus 的 agent 会跑工具、
  // 会停下来等你点授权，这些时刻**一个字都不输出**，而时长以分钟计。没有这三张脸，糯米模式在
  // 真实会话里会有一半时间是死的（或者更糟：看起来睡着了，而它其实正在干活）。
  | "working"   // 工具执行中 —— 低头看手上的活，不焦躁
  | "asking";   // 等你授权 —— 直视你，眼睛微微不对称（"你看这里"）

/** 现在这一轮里，agent 到底在干什么（比通话相位更细）。 */
export type AgentActivity = "none" | "thinking" | "tools" | "asking";


/** What the face is DOING (as opposed to how it feels). */
export type ExprMode = "idle" | "listening" | "thinking" | "speaking";

/** The four continuous knobs the renderer reads every frame. */
export interface ExprState {
  mode: ExprMode;
  /** 0..1 — how hard it looks at you (pupil width). */
  attention: number;
  /** 0..1 — brightness of the eye and of its glow. */
  energy: number;
  /** 0..1 — the afterglow of having just spoken; decays over WARMTH_MS. */
  warmth: number;
  /** seconds since this phase began — the thinking stages are read off this. */
  phaseElapsed: number;
}

/** Everything the canvas needs for ONE eye on ONE frame. Pure numbers, no time, no DOM. */
export interface EyeFrame {
  shape: "capsule" | "arc" | "x";
  /** width/height in px at scale 1 (the renderer multiplies by its own size factor) */
  w: number;
  h: number;
  /** vertical squash — this is where blinking and "talking" live */
  yScale: number;
  /** horizontal foreshortening: the far eye narrows when it looks sideways */
  xScale: number;
  rot: number;
  x: number;
  y: number;
  /** 0..1 opacity */
  alpha: number;
  /** shadow blur radius in px (the glow that the operator's own voice drives) */
  glow: number;
  /** ±px jitter at 24/19 Hz — only error (6) and strive (0.8) */
  jitter: number;
  /** arc direction, when shape === "arc" */
  arc?: "happy" | "sad";
}

export const MOODS: NomiMood[] = [
  "idle", "talking", "loading", "sleep", "lookLeft", "lookRight", "scan", "strive",
  "focus", "drowsy", "happy", "sad", "surprise", "curious", "wink", "error",
  "working", "asking",
];

/** Eye separation per mood (px at scale 1). Focus pulls the eyes together, drowsiness lets them drift. */
export function eyeSpacing(mood: NomiMood): number {
  switch (mood) {
    case "focus":
    case "strive":
      return 48;
    case "curious":
      return 54;
    case "drowsy":
    case "sleep":
      return 56;
    case "working":
      return 46;                       // 低头干活：眼睛往中间收，像盯着手上
    case "asking":
      return 52;                       // 看着你：比 curious 稍近
    default:
      return 60;
  }
}

/** Blinking is OFF in these six faces — a closed eye would read as a different expression. */
export const BLINK_BLOCKED: NomiMood[] = ["error", "scan", "drowsy", "sleep", "loading", "strive"];

/** Next blink, ms. 2.8–6.4 s in the original; it is random because a metronome looks dead. */
export function nextBlinkMs(rand: () => number = Math.random): number {
  return 2800 + rand() * 3600;
}

/** How long the eye stays shut, ms (0.10–0.16 s). */
export function blinkHoldMs(rand: () => number = Math.random): number {
  return 100 + rand() * 60;
}

/** Warmth decay after the reply ends. The original lets it bleed for 2.4 s. */
export const WARMTH_MS = 2400;

/** Idle thresholds: a small look-around after 30 s, going to sleep at 90 s. */
export const IDLE_LOOK_MS = 30_000;
export const IDLE_REST_MS = 90_000;
/** Sleep is a transition, not a cut: 2.6 s of eyelids falling. */
export const SLEEP_TRANSITION_MS = 2600;
/** The life beat ticks every 6 s and fires 56 % of the time (measured rate in the original). */
export const LIFE_BEAT_MS = 6000;
export const LIFE_BEAT_P = 0.56;

// --------------------------------------------------------------- expression state

/** The state vector for this phase. `level` is the live 0..1 audio level (mic or playback). */
export function exprFor(phase: CallPhase | "idle", level: number, elapsed: number, o: { resting?: boolean; warmth?: number } = {}): ExprState {
  const warmth = clamp01(o.warmth ?? 0);
  switch (phase) {
    case "listening":
      return { mode: "listening", attention: Math.min(1, 0.72 + level * 0.38), energy: 0.78, warmth, phaseElapsed: elapsed };
    case "thinking":
      return { mode: "thinking", attention: 0.88, energy: Math.min(1, 0.62 + elapsed * 0.08), warmth, phaseElapsed: elapsed };
    case "speaking":
      return { mode: "speaking", attention: 0.7, energy: Math.min(1, 0.72 + level * 0.35), warmth: Math.max(warmth, 0.25), phaseElapsed: elapsed };
    default:
      return {
        mode: "idle",
        attention: o.resting ? 0.12 : 0.38,
        energy: (o.resting ? 0.18 : 0.48) + warmth * 0.2,
        warmth,
        phaseElapsed: elapsed,
      };
  }
}

/**
 * The face to show. `life` is the transient mood the life beat picked (it wins only while idle),
 * `emotion` comes from an `[emo:…]` tag in the reply, and `resting`/`drowsy` come from idle time.
 */
export function moodFor(o: {
  phase: CallPhase | "idle";
  /** 比相位更细的「这一轮在干嘛」—— 工具、授权这些时刻没有标准输出，靠它出脸。 */
  activity?: AgentActivity;
  emotion?: NomiMood | null;
  life?: NomiMood | null;
  resting?: boolean;
  drowsy?: boolean;
}): NomiMood {
  const { phase, activity = "none", emotion, life, resting, drowsy } = o;
  if (phase === "error") return "error";
  if (phase === "connecting") return "loading";
  if (phase === "speaking") {
    // The words decide HOW it speaks; the phase decides THAT it speaks. An unknown/neutral tag
    // leaves the plain talking face, which is also the fallback when the model writes no tag.
    return emotion && emotion !== "idle" ? emotion : "talking";
  }
  // 等你点授权 > 一切：它此刻**就是在等你**，这时候还眯着眼"思考"或者睡着都是谎话。
  if (activity === "asking") return "asking";
  // 工具执行中 > 听/想：一轮里跑三个工具时，相位一直是 thinking，可它并不是在想，是在干活。
  if (activity === "tools") return "working";
  if (phase === "listening" || phase === "thinking") return "focus";
  if (resting) return "sleep";
  if (drowsy) return "drowsy";
  return life ?? "idle";
}

// --------------------------------------------------------------- eye geometry

/** Three thinking stages: eyes flatten, tilt more, and dart faster the longer it takes. */
export function thinkingStage(phaseElapsed: number): 0 | 1 | 2 {
  if (phaseElapsed < 1.2) return 0;
  if (phaseElapsed < 3.2) return 1;
  return 2;
}

/**
 * One eye's frame. `t` is seconds (the renderer passes a monotonically growing number), `level`
 * the live audio 0..1, `sleep` the 0..1 eyelid-fall progress.
 */
export function eyeFrame(o: {
  mood: NomiMood;
  right: boolean;
  blinking: boolean;
  t: number;
  level: number;
  expr: ExprState;
  sleep?: number;
}): EyeFrame {
  const { mood, right, blinking, t, expr } = o;
  const level = clamp01(o.level);
  const sleep = clamp01(o.sleep ?? 0);
  const { right: r } = { right };

  // --- shape ------------------------------------------------------------------------------
  if (mood === "error") {
    return { shape: "x", w: 45, h: 45, yScale: 1, xScale: 1, rot: 0, x: 0, y: 0, alpha: 0.86, glow: 10, jitter: 6 };
  }
  if (mood === "happy" || mood === "sad") {
    // Arcs, not capsules: joy curves up out of the eye, sadness curves down.
    return {
      shape: "arc",
      w: 45,
      h: 30,
      yScale: 1,
      xScale: 1,
      rot: 0,
      x: 0,
      y: mood === "happy" ? 20 + Math.sin(t * 10) * 3 : -10,
      alpha: clamp01(0.72 + expr.energy * 0.22 + expr.warmth * 0.06),
      glow: 9 + level * 12 + expr.warmth * 5,
      jitter: 0,
      arc: mood,
    };
  }

  // --- geometry ---------------------------------------------------------------------------
  const stage = thinkingStage(expr.phaseElapsed);
  const thinkingW = stage === 0 ? 48 : stage === 1 ? 56 : 60;
  const thinkingH = stage === 0 ? 18 : stage === 1 ? 13 : 10 + Math.sin(t * 2) * 2;
  const thinkingRot = stage === 0 ? 12 : stage === 1 ? 22 : 28;
  const thinkAmp = stage === 0 ? 4 : stage === 1 ? 10 : 14;
  const isThinking = mood === "focus" && expr.mode === "thinking";
  const isListening = mood === "focus" && expr.mode === "listening";

  let w: number;
  switch (mood) {
    case "scan": w = 65 + level * 8; break;
    case "strive": w = thinkingW; break;
    case "drowsy": w = 42 + sleep * 5; break;
    case "sleep": w = 45; break;
    case "surprise": w = 55; break;
    case "loading": w = 16; break;
    case "curious": w = r ? 35 : 45; break;
    case "working": w = 46; break;
    case "asking": w = r ? 38 : 50; break;
    case "focus": w = isListening ? 42 + level * 8 : isThinking ? 46 + Math.min(expr.phaseElapsed, 3) * 2.5 : 32 + expr.attention * 8; break;
    default: w = 42;
  }

  let h: number;
  switch (mood) {
    case "scan": h = 12 + level * 8; break;
    case "strive": h = thinkingH; break;
    case "drowsy": h = Math.max(8, 78 - sleep * 66); break;
    case "sleep": h = 4 + Math.sin(t * 1.1) * 1.2 + 1.2; break;
    case "surprise": h = 55; break;
    case "loading": h = 16; break;
    case "wink": h = r ? 2 : 40; break;
    case "working": h = 46; break;
    case "asking": h = 68; break;
    case "focus": h = isListening ? 54 + level * 18 : isThinking ? 44 - Math.min(expr.phaseElapsed, 3) * 3.5 : 78 + expr.attention * 12 + level * 8; break;
    default: h = 78;
  }

  let rot = 0;
  if (mood === "strive") rot = r ? -thinkingRot : thinkingRot;
  else if (mood === "curious") rot = 15;
  else if (mood === "asking") rot = 8;
  else if (isThinking) rot = r ? 4 : -4;

  let x = 0;
  switch (mood) {
    case "lookLeft": x = -40; break;
    case "lookRight": x = 40; break;
    case "scan": x = Math.sin(t * 3.5) * 45; break;
    case "working": x = 0; break;
    case "asking": x = Math.sin(t * 0.9) * 1.2; break;
    case "strive": x = Math.sin(t * (stage === 0 ? 1.8 : stage === 1 ? 4.2 : 5)) * thinkAmp; break;
    case "focus": x = isListening ? Math.sin(t * 1.2) * 1.8 : isThinking ? Math.sin(t * 2.4) * (expr.phaseElapsed < 1.2 ? 2.5 : 6) : Math.sin(t * 1.8) * (2 + expr.attention * 2); break;
  }

  let y = 0;
  switch (mood) {
    case "talking": y = Math.sin(t * 10) * 2 - level * 4 + expr.warmth * 2; break;
    case "strive": y = Math.cos(t * 3.2) * (2 + expr.energy * 2); break;
    case "drowsy": y = 4 + sleep * 12 + Math.sin(t * 1.2) * 1.4; break;
    case "curious": y = r ? 10 : -10; break;
    case "wink": y = r ? 0 : -10; break;
    case "working": y = 6 + Math.sin(t * 1.6) * 1.2; break;   // 低头看手上的活
    case "asking": y = r ? 6 : -6; break;
  }

  let yScale = 1;
  if (mood === "talking") yScale = 0.72 + level * 0.42 + Math.sin(t * 8) * 0.06 + expr.warmth * 0.04;
  else if (mood === "drowsy") yScale = Math.max(0.18, 1 - sleep * 0.74);
  else if (mood === "curious") yScale = r ? 0.8 : 1.2;
  else if (mood === "working") yScale = 0.58 + Math.sin(t * 1.6) * 0.02;  // 半阖：专注，不是困
  else if (mood === "asking") yScale = r ? 0.94 : 1.06;
  else if (mood === "focus") {
    yScale = isListening ? 0.9 + level * 0.12 + Math.sin(t * 1.4) * 0.015
      : isThinking ? 0.82 + Math.sin(t * 1.8) * 0.025
        : 0.94 + expr.attention * 0.06 + Math.sin(t * 2) * 0.02;
  }

  let xScale = 1;
  if (mood === "lookLeft") xScale = r ? 1.2 : 0.8;
  else if (mood === "lookRight") xScale = r ? 0.8 : 1.2;

  let alpha: number;
  if (mood === "drowsy") alpha = 0.72 - sleep * 0.44;
  else if (mood === "sleep") alpha = 0.18;
  else alpha = Math.min(1, 0.72 + expr.energy * 0.22 + expr.warmth * 0.06);

  // A blink is a squash of the SAME shape, so the expression never changes identity mid-blink.
  if (blinking && !BLINK_BLOCKED.includes(mood)) yScale = Math.min(yScale, 0.01);

  return {
    shape: "capsule",
    w,
    h,
    yScale,
    xScale,
    rot,
    x,
    y,
    alpha: clamp01(alpha),
    glow: 9 + level * 12 + expr.warmth * 5,
    jitter: mood === "strive" ? 0.8 : 0,
  };
}

// --------------------------------------------------------- 「它在干活」的三个状态

/** 忙的时候，多久没有任何新行就该做个小动作 —— 否则一张半阖的脸盯三分钟，读起来是"卡住了"。 */
export const NO_OUTPUT_LOOK_MS = 20_000;

/**
 * 一轮里 agent 到底在干什么。输入是**已有的行**，不是猜的：
 *   · `pending`  —— 等答复的授权请求条数（App 的 `v.perms.length`，不是转录里的历史卡）。
 *   · `newestKind` / `newestToolStatus` —— 这一轮最后一行是什么。工具卡在最上面就是「在干活」，
 *     哪怕它的 status 已经变成 ok：下一句文本还没到，它此刻仍在工具循环里。
 */
export function activityOf(o: {
  busy: boolean;
  pending: number;
  newestKind?: string;
  newestToolStatus?: string;
}): AgentActivity {
  if (o.pending > 0) return "asking";
  if (!o.busy) return "none";
  if (o.newestKind === "tool") return "tools";
  return "thinking";
}

// --------------------------------------------------------------- the life beat

export interface LifeBeat {
  mood: NomiMood;
  durationMs: number;
}

/**
 * What the face does when nobody is talking to it. Called every LIFE_BEAT_MS:
 *   · >90 s idle → 犯困（调用方负责走 SLEEP_TRANSITION_MS 的过渡）
 *   · >30 s idle → 候选里多出 curious / focus（东张西望变成观察）
 *   · otherwise  → 只做 lookLeft / lookRight / wink
 * Null means "nothing this beat", which is most beats.
 */
export function lifeBeat(
  idleMs: number,
  rand: () => number = Math.random,
  o: { busy?: boolean } = {},
): LifeBeat | "rest" | null {
  // 忙的时候不许睡：睡 = 「这一段结束了」，而它只是没在说话（工具跑 3 分钟很常见）。
  if (idleMs > IDLE_REST_MS) return o.busy ? null : "rest";
  const pool: NomiMood[] = idleMs > IDLE_LOOK_MS
    ? ["lookLeft", "lookRight", "curious", "wink", "focus"]
    : ["lookLeft", "lookRight", "wink"];
  if (rand() >= LIFE_BEAT_P) return null;
  const mood = pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
  return { mood, durationMs: mood === "wink" ? 750 : 1800 + rand() * 1400 };
}

// --------------------------------------------------- 第三层：没有标签时的本地派生

/**
 * 中间层：模型没写标签时，从**正在念的这一句**里猜一个情绪。
 *
 * 这一层永远不覆盖标签（标签是 agent 说的，派生是我们猜的），只补空位；而且故意做得笨——
 * 一个短词表 + 否定词前缀，不做语气分析。理由：猜错了的表情比没有表情更糟（它会在你说
 * 「我不难过」的时候笑给你看），所以这里只认**明确的情绪词**，认不出就返回 null 让别人兜底。
 */
const LEX: { mood: NomiMood; words: string[] }[] = [
  { mood: "happy", words: ["开心", "高兴", "太好了", "喜欢", "棒", "恭喜", "成功", "完成了", "搞定", "哈哈", "谢谢"] },
  { mood: "sad", words: ["抱歉", "难过", "遗憾", "可惜", "失败了", "没成功", "不舒服", "唉"] },
  { mood: "surprise", words: ["竟然", "居然", "没想到", "原来", "意外", "真的吗"] },
  { mood: "curious", words: ["要不要", "是不是", "你觉得", "哪个", "为什么", "要我", "需要我"] },
  { mood: "strive", words: ["麻烦", "麻烦你", "冲突", "错误", "报错", "卡住", "超时"] },
];
/** 「不/没/别」紧跟情绪词时不算 —— 这一条就是那个「我不难过」的形状。 */
const NEG = /[不没别未无](?:有|是|会|太|要)?\s*$/;

export function deriveEmotion(text: string): NomiMood | null {
  const t = String(text ?? "");
  if (!t) return null;
  let best: { mood: NomiMood; at: number } | null = null;
  for (const { mood, words } of LEX) {
    for (const w of words) {
      let at = t.indexOf(w);
      while (at >= 0) {
        if (!NEG.test(t.slice(Math.max(0, at - 2), at))) {
          if (!best || at < best.at) best = { mood, at };
          break;
        }
        at = t.indexOf(w, at + 1);
      }
    }
  }
  return best?.mood ?? null;
}

// ------------------------------------------------- 长时间没有输出时的「小动作」

/** 工具循环里每来一条新工具帧就点一下头；久了要换姿势，否则一张脸盯三分钟像死机。 */
export const WORK_FLICK_MS = 20_000;
export const WORK_STRETCH_MS = 45_000;

export type MicroAction = "tick" | "flick" | "stretch";

/**
 * 该做哪个小动作了。`sinceEvent` 是「距上一次任何 agent 活动」的毫秒数，`sinceAction` 是
 * 「距上一次小动作」的毫秒数（两者都得喂，否则一个 tick 会把 stretch 的计时也清零）。
 */
export function workBeat(o: {
  activity: AgentActivity;
  sinceEvent: number;
  sinceAction: number;
  rand?: () => number;
}): MicroAction | null {
  const { activity, sinceEvent, sinceAction } = o;
  if (activity !== "tools" && activity !== "thinking") return null;
  // 两个计时都要够久：`sinceAction` 防刷屏，`sinceEvent` 保证"刚有动静就换姿势"不会发生
  // （工具一个接一个回来时，脸该跟着点，不该自己另跳一套）。
  if (sinceAction < WORK_FLICK_MS || sinceEvent < WORK_FLICK_MS) return null;
  if (sinceEvent > WORK_STRETCH_MS && sinceAction > WORK_STRETCH_MS) return "stretch";
  return (o.rand ?? Math.random)() < 0.7 ? "flick" : "tick";
}

// --------------------------------------------------------------- emotion tags

/** The tag vocabulary. Deliberately small: a bigger list is a bigger chance of a miss. */
export const EMO_MOODS: Record<string, NomiMood> = {
  happy: "happy", joy: "happy", love: "happy",
  sad: "sad",
  angry: "strive", strive: "strive",
  surprise: "surprise", surprised: "surprise",
  curious: "curious", confused: "curious",
  shy: "wink", wink: "wink",
  thinking: "focus", focus: "focus",
  sleepy: "drowsy", sleep: "sleep",
  neutral: "idle",
};

/** ONLY `[emo:x]` / `[emotion: x]` — never a bare bracket, so ordinary text cannot be eaten. */
const EMO_TAG = /\[\s*(?:emo|emotion)\s*[:：]\s*([a-zA-Z\u4e00-\u9fa5_-]{1,16})\s*\]/gi;

/** Every mood the text asks for, in order. Unknown words are dropped, not guessed. */
export function readEmoTags(text: string): NomiMood[] {
  const out: NomiMood[] = [];
  for (const m of String(text ?? "").matchAll(EMO_TAG)) {
    const mood = EMO_MOODS[m[1].toLowerCase()];
    if (mood) out.push(mood);
  }
  return out;
}

/**
 * Remove the tags. Call this **before the text is spoken and before it is rendered/存储** —
 * `splitForSpeech()` does not strip brackets, so a leftover tag is read out loud.
 */
export function stripEmoTags(text: string): string {
  return String(text ?? "").replace(EMO_TAG, "").replace(/[ \t]{2,}/g, " ").trim();
}

/** The one-line constraint for the prompt. Server-side block lives in `packages/server/src/acp/voice-mode.ts`. */
export function emoTagHint(): string {
  return "想表达情绪时，在句子开头加一个隐藏标记，例如 [emo:happy]；可用值：" +
    Object.keys(EMO_MOODS).join("/") + "。标记不会被念出来，也不要放在句子中间。";
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
