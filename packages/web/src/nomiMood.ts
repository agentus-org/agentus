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

/** The GAP between the two eyes (px at scale 1) — the original's `HStack(spacing:)`, i.e. edge to
 *  edge, not centre to centre. The renderer adds the eye's own width to get the centre distance;
 *  reading it as a centre distance is what made the face look cross-eyed at 1.6× scale. */
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
/** 一张脸此刻的连续量从**它自己是哪张脸**推，不是从相位推。
 *
 *  实测（操作者 2026-10-23「怎么还是呆呆的」）：早先这里只看 `phase`，于是
 *  `working`／`asking`／`curious` 这些 mood 拿到的都是 `thinking`／`listening` 的连续量 ——
 *  形状换了、神态没换，读起来还是同一张脸在发呆。 */
export function exprFor(who: CallPhase | NomiMood | "idle", level: number, elapsed: number, o: { resting?: boolean; warmth?: number } = {}): ExprState {
  const warmth = clamp01(o.warmth ?? 0);
  switch (who) {
    case "listening":
      return { mode: "listening", attention: Math.min(1, 0.72 + level * 0.38), energy: 0.78, warmth, phaseElapsed: elapsed };
    case "thinking":
      return { mode: "thinking", attention: 0.88, energy: Math.min(1, 0.62 + elapsed * 0.08), warmth, phaseElapsed: elapsed };
    case "speaking":
      return { mode: "speaking", attention: 0.7, energy: Math.min(1, 0.72 + level * 0.35), warmth: Math.max(warmth, 0.25), phaseElapsed: elapsed };
    // ── 按 mood 走（渲染器现在传的是解析后的那张脸，不是相位）────────────────────────
    // 「听」和「想」必须是两种神态：听的时侯睁着眼看着你，想的时候眯起来往上看。
    case "curious":
    case "asking":
      return { mode: "listening", attention: Math.min(1, 0.82 + level * 0.34), energy: 0.86, warmth, phaseElapsed: elapsed };
    case "focus":
    case "working":
    case "strive":
    case "loading":
      return { mode: "thinking", attention: 0.9, energy: Math.min(1, 0.64 + elapsed * 0.08), warmth, phaseElapsed: elapsed };
    case "talking":
    case "happy":
    case "surprise":
    case "wink":
      return { mode: "speaking", attention: 0.74, energy: Math.min(1, 0.76 + level * 0.33), warmth: Math.max(warmth, 0.28), phaseElapsed: elapsed };
    case "lookLeft":
    case "lookRight":
    case "scan":
      return { mode: "listening", attention: 0.66, energy: 0.7, warmth, phaseElapsed: elapsed };
    case "drowsy":
    case "sleep":
      return { mode: "idle", attention: 0.1, energy: 0.16 + warmth * 0.1, warmth, phaseElapsed: elapsed };
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
  // 听 ≠ 想（实测读法）：两者都回到同一张「眯着眼」的脸，通话里最常出现的两种状态就长得
  // 一模一样 —— 你说话时它在发呆，它在思考时你分不出来。听 = 睁眼看着你（curious），
  // 想 = 眯起来往上看（focus）。
  // 听话时也有小动作（扫一眼／偏一下／眨个眼）：生命感那一拍落在"听"上时优先出它，
  // 否则这两个状态永远被 curious 吃掉 —— 脸看着在看你，却一动不动。
  if (phase === "listening") return life ?? "curious";
  if (phase === "thinking") return "focus";
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
    case "curious": w = 34; break;   // 球面眼里 35×74 才读成"竖着的胶囊"；40×64 会变成圆角方块
    case "working": w = 46; break;
    case "asking": w = 38; break;
    case "focus": w = isListening ? 40 + level * 8 : isThinking ? 46 + Math.min(expr.phaseElapsed, 3) * 2.5 : 32 + expr.attention * 8; break;
    default: w = 34;
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
    case "asking": h = 74; break;
    case "focus": h = isListening ? 68 + level * 14 : isThinking ? 44 - Math.min(expr.phaseElapsed, 3) * 3.5 : 78 + expr.attention * 12 + level * 8; break;
    default: h = 70;   // 球里的眼睛：34×70 约 2:1，才读成"竖着的胶囊"（64 高会变圆角方块）
  }

  let rot = 0;
  if (mood === "strive") rot = r ? -thinkingRot : thinkingRot;
  else if (mood === "curious") rot = 6;
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
    case "wink": y = r ? 0 : -10; break;
    case "working": y = 6 + Math.sin(t * 1.6) * 1.2; break;   // 低头看手上的活
  }

  let yScale = 1;
  if (mood === "talking") yScale = 0.72 + level * 0.42 + Math.sin(t * 8) * 0.06 + expr.warmth * 0.04;
  else if (mood === "drowsy") yScale = Math.max(0.18, 1 - sleep * 0.74);
  else if (mood === "working") yScale = 0.58 + Math.sin(t * 1.6) * 0.02;  // 半阖：专注，不是困
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
  return String(text ?? "")
    .replace(EMO_TAG, "")
    // 流式到达时标签可能只有半截（`[emo:hap`）：整段剥掉的只有闭合的，半截的留着就会在气泡里
    // 闪一下，而它本来就不该被用户看到。只在**末尾**剥，中间未闭合的留给下一帧补全。
    .replace(/\[\s*(?:emo|emotion)\s*[:：]\s*[a-zA-Z\u4e00-\u9fa5_-]*\s*\]?\s*$/i, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** The one-line constraint for the prompt. Server-side block lives in `packages/server/src/acp/voice-mode.ts`. */
/** 提示句的唯一出处在 shared（服务端写、页面认），这里只是让 web 侧有同一个入口。 */
export { emoTagHint, EMO_TAG_VALUES } from "../../shared/src/index";

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 电平平滑：**上得快、落得慢**。
 *
 * 麦克风电平逐帧抖得厉害，直接用会让眼睛每帧都变尺寸（看着像噪点而不是表情）；但如果
 * 一律慢速平滑，人一开口那一下「它听见了」的反应就没了。所以起音跟得紧（0.55/帧），
 * 收尾慢慢落（0.10/帧）—— 这是包络检波器用了五十年的那套。
 */
export function smoothLevel(prev: number, raw: number, up = 0.55, down = 0.1): number {
  const p = clamp01(prev), r = clamp01(raw);
  return clamp01(p + (r - p) * (r > p ? up : down));
}

/** 人突然开口（电平跳起来）时该做什么小动作。返回 null 表示这一帧没什么好反应的。 */
export function voiceCue(prev: number, now: number): MicroAction | null {
  const jump = clamp01(now) - clamp01(prev);
  // 0.18 是「说话」和「房间本底」的分界：底噪跳这么多不会发生，正常开口一定超过。
  return jump > 0.18 && now > 0.22 ? "tick" : null;
}

/** 听你说话时的眼神节奏：每 2.4–4.6 s 一个 300–520 ms 的小动作（扫一眼／偏一下／眨个眼）。 */
export const SACCADE_MIN_MS = 2400;
export const SACCADE_MAX_MS = 4600;
export function nextSaccadeMs(rand: () => number = Math.random): number {
  return SACCADE_MIN_MS + rand() * (SACCADE_MAX_MS - SACCADE_MIN_MS);
}
export function saccadeFor(rand: () => number = Math.random): { mood: NomiMood; durationMs: number } {
  const r = rand();
  const mood: NomiMood = r < 0.42 ? "lookLeft" : r < 0.84 ? "lookRight" : "wink";
  return { mood, durationMs: 300 + rand() * 220 };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 球（本体）。眼睛不再是"悬在空中的两条白线"，而是**长在一个深色圆球里** —— 参照
// `grokbot-animation-anatomy` 那套解剖（Grok Bot 的头像 = 黑球 + 白眼 + 弹簧），但实现是我们自己的：
// 它们用 192 条射线的径向轮廓插值，我们只需要一个会挤压的圆，成本低一个数量级。
//
// 球存在的理由很实际：只有两只眼睛时，"在动"和"在发呆"的差别只有几像素；有了球，**整个身体的
// 挤压/回弹**都在动，同样 30 fps 下读起来是活的。
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface BallFrame {
  /** 半径（px，未乘 k）。 */
  r: number;
  /** 横向/纵向缩放：0.94 = 压扁一点。 */
  sx: number;
  sy: number;
  /** 垂直偏移（px，未乘 k）—— 说话时身体轻轻上浮。 */
  dy: number;
  /** 整颗球的倾斜（度）。好奇歪头、干活低头都该是"头"在转，不是眼睛各转各的。 */
  rot: number;
}

/** 每个 mood 的球体形状。数值是"安静可读"的区间：挤压超过 10% 会读成弹跳的果冻，不是呼吸。 */
export function ballFrame(mood: NomiMood, o: { level?: number; breath?: number; sleep?: number } = {}): BallFrame {
  const level = clamp01(o.level ?? 0);
  const breath = o.breath ?? 0;
  const sleeping = mood === "sleep";
  const drowsy = mood === "drowsy";
  switch (mood) {
    case "talking":
      // 说话：随音量体积略涨，纵向被"声音推"起来一点（不是抖动，是 0.02 的呼吸差）。
      return { r: 96 + level * 7, sx: 1 + level * 0.03, sy: 1 - level * 0.025, dy: -1.5 - level * 2, rot: 0 };
    case "happy":
    case "wink":
      return { r: 100, sx: 1.03, sy: 0.97, dy: -3, rot: -4 };
    case "surprise":
      return { r: 104, sx: 0.98, sy: 1.04, dy: -4, rot: 0 };
    case "sad":
      return { r: 93, sx: 1.02, sy: 0.94, dy: 3, rot: 3 };
    case "strive":
      return { r: 95, sx: 1.05, sy: 0.92, dy: 1, rot: -3 };
    case "working":
      // 干活：身体压低、前倾一点，像低着头。
      return { r: 92, sx: 1.06, sy: 0.9, dy: 4, rot: 7 };
    case "asking":
      return { r: 99, sx: 0.99, sy: 1.01, dy: -1, rot: 0 };
    case "focus":
      return { r: 94, sx: 0.98, sy: 1.0, dy: 0, rot: -5 };
    case "drowsy":
      return { r: 97, sx: 1.02, sy: 0.95, dy: 6, rot: 6 };
    case "sleep":
      return { r: 95, sx: 1.04, sy: 0.93, dy: 7, rot: 8 };
    case "loading":
      return { r: 92 + (o.breath ?? 0) * 3, sx: 1, sy: 1, dy: 0, rot: 0 };
    case "error":
      return { r: 96, sx: 1.03, sy: 0.96, dy: 0, rot: 0 };
    default:
      // idle / curious / lookLeft / lookRight / scan：安静的球，呼吸 2×6 px 走 dy。
      return {
        r: sleeping ? 95 : 98, sx: 1 + breath * 0.006, sy: 1 - breath * 0.006,
        dy: drowsy ? 5 : -breath * 2,
        rot: mood === "curious" ? 4 : mood === "lookLeft" ? -3 : mood === "lookRight" ? 3 : 0,
      };
  }
}

/**
 * 弹簧积分（半隐式欧拉，固定 dt）。**这是"弹一下再停"和"线性过去"的分界**，也是原引擎最核心的
 * 一条：菜单级 ease 在任何时长下都是单调的，而弹簧会过冲、回弹、稳住 —— 人眼读前者为"过渡"，
 * 读后者为"有重量"。
 *
 * 稳定性：k/m 与阻尼必须满足 dt 足够小；这里固定 dt=1/120 s、ω≤40 rad/s，单测跑 600 步验证不发散。
 */
export function springStep(x: number, v: number, target: number, dt: number, omega = 26, zeta = 0.55): { x: number; v: number } {
  const a = -2 * zeta * omega * v - omega * omega * (x - target);
  const nv = v + a * dt;
  return { x: x + nv * dt, v: nv };
}

/** 眨眼闭合量 → 眼睛高度系数（0.06 = 一条缝）。 */
export function blinkScale(blinking: boolean): number {
  return blinking ? 0.06 : 1;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 球面眼（伪 3D）。眼睛不是贴在平面上的贴纸，而是**长在球面上**：按正交投影摆放，
// 往侧看时近的一只变窄、远的一只几乎看不见 —— 这一条是"有体积"和"平面图案"的分界。
//
// 参数取自 Grok Bot 解剖里的实测值：眼睛活动范围 水平 14° / 垂直 18°（形状类眼睛 19°/26°）。
// 14° 听着小，但把它乘到半径上就是 ±0.24R 的位移，肉眼足够读出"它在看哪"。
// ─────────────────────────────────────────────────────────────────────────────────────────────

// sep 是**两只眼睛在球面上的夹角**。取 17° 而不是 26°：26° 时靠边的那只眼比另一只窄 8%，
// 静止画面读起来是"歪掉的半边脸"；17° 的差只有 3%，体积感靠转头时的变化给出，静态仍然对称。
export const SPHERE = { maxX: 14, maxY: 18, sep: 21 } as const;

/** 视点角度（度）。指针、情绪、思考都会把眼睛往某个方向拽。 */
export function gazeAngles(o: { mood: NomiMood; pointerX?: number; pointerY?: number; elapsed?: number; level?: number }): { ax: number; ay: number } {
  const px = Math.max(-1, Math.min(1, o.pointerX ?? 0));
  const py = Math.max(-1, Math.min(1, o.pointerY ?? 0));
  const el = o.elapsed ?? 0;
  let bx = 0, by = 0;
  switch (o.mood) {
    case "focus":
      // 想事情（focus 就是"想"那张脸）：往左上飘
      bx = -0.55; by = -0.7;
      break;
    case "working":
      bx = -0.25; by = 0.85; break;          // 低头看手上的活
    case "asking":
      bx = 0; by = 0.1; break;               // 直视你
    case "sad":
      bx = 0; by = 0.8; break;
    case "happy":
    case "wink":
      bx = 0.15; by = -0.25; break;
    case "surprise":
      bx = 0; by = -0.15; break;
    case "drowsy":
    case "sleep":
      bx = 0; by = 0.75; break;
    case "lookLeft": bx = -0.9; break;
    case "lookRight": bx = 0.9; break;
    case "scan": bx = Math.sin(el * 2.2) * 0.9; break;
    case "curious":
      bx = 0.35; by = -0.2; break;
    default: break;
  }
  // 指针是"它看着你"的输入，权重比情绪高：手一动眼睛就跟着，这条最容易让人觉得"活的"。
  const ax = Math.max(-1, Math.min(1, bx * 0.7 + px * 0.9));
  const ay = Math.max(-1, Math.min(1, by * 0.7 + py * 0.8));
  return { ax: ax * SPHERE.maxX, ay: ay * SPHERE.maxY };
}

/** 正交投影：把球面上某个角度的一个点投到屏幕坐标，并给出它的缩小系数（cos）。 */
export function projectEye(o: { ax: number; ay: number; side: -1 | 1; R: number; sep?: number }): { x: number; y: number; cos: number } {
  const sep = o.sep ?? SPHERE.sep;
  const th = ((o.ax + o.side * sep / 2) * Math.PI) / 180;
  const tv = (o.ay * Math.PI) / 180;
  // 球面上的点 (sinθ, sinφ, cosθ·cosφ)，正交投影只取前两维；cosθ·cosφ 就是"正对镜头的比例"。
  return {
    x: o.R * Math.sin(th),
    y: o.R * Math.sin(tv),
    cos: Math.max(0, Math.cos(th) * Math.cos(tv)),
  };
}
