// The face's mood engine: WHICH expression, and with what numbers.
//
// WHY THIS FILE EXISTS. Tus 模式（`CallMode` 的 tus 变体）上半屏/左半屏是一张会动的脸。要让这张脸
// 像 OpenNomi 那样「活着」，靠的不是美术资源（它自己也没有一张图，两只 capsule + 一条弧线就是全部），
// 而是一张**情绪表**加四个**连续量**：attention（瞳孔多宽）、energy（多亮）、warmth（说完的余温）、
// phaseElapsed（想了几秒）。这一层全是算术，能离开浏览器验证，所以它住在这里、由
// `scripts/qa/tus-mood.mts` 钉住；canvas 那边只管把数字画出来。
//
// 数字的来源有两个，都只取**参数**、不搬代码：
//   · `kerwinyoung77/OpenNomi`（MIT）的 `NomiExpressionView.swift` / `EyeView` —— 16 张基础脸；
//   · `ArvinYin1/grokbot-anatomy` 解出的 Grok Bot 原引擎（`grok-recipes.json`）—— 九个官方表情
//     描述符、别名表、眨眼包络与 `blocked→drowsy` / `waking` 转场（见 `GROK_EXPRESSIONS`）。
// 两家都是 SwiftUI/DOM 的 View 组合，我们用 canvas 每帧算数；搬过来的只有事实性参数（尺寸、
// 时长、阈值），形状由我们自己的 capsule / arc / x 三种原语画。
//
// 两层叠加而不是二选一（操作者 2026-10-23 拍板的第一条；第二条他也同意「要」）：
//   1. **状态层**（永远在）：通话相位 + 音频电平 + 相位时长 → 动作与神态。不依赖模型，永不缺席。
//   2. **情绪层**（可关）：agent 在句首写 `[emo:happy]` 这样的隐藏标记，这里剥掉、映射成 mood。
//      标记必须在**送 TTS 前、进转录前、落历史前**剥干净 —— `splitForSpeech()` 只剥
//      `[*_`#>|]`，不剥方括号，漏一处就会被念成「方括号 happy 方括号」。
import type { CallPhase } from "./CallMode";

/** 20 faces: 16 from OpenNomi, working/asking of our own, plus calm/confused from Grok Bot. */
export type TusMood =
  | "idle" | "talking" | "loading" | "sleep" | "lookLeft" | "lookRight" | "scan" | "strive"
  | "focus" | "drowsy" | "happy" | "sad" | "surprise" | "curious" | "wink" | "error"
  // ── 我们自己的两种「没有标准输出」的脸 ──────────────────────────────────────────────────
  // OpenNomi 后端就是一个聊天机器人：它只会有「在听 / 在想 / 在说」。Agentus 的 agent 会跑工具、
  // 会停下来等你点授权，这些时刻**一个字都不输出**，而时长以分钟计。没有这两张脸，Tus 模式在
  // 真实会话里会有一半时间是死的（或者更糟：看起来睡着了，而它其实正在干活）。
  | "working"   // 工具执行中 —— 低头看手上的活，不焦躁
  | "asking"    // 等你授权 —— 直视你，眼睛微微不对称（"你看这里"）
  // ── Grok Bot 官方九表情里我们原先缺的两张（2026-10-24 移植）────────────────────────────
  | "calm"      // 宽椭圆、半阖：平静地在场（官方 calm）
  | "confused"; // 竖胶囊整对左移：没听懂 / 在想你刚才那句（官方 confused）

/** 现在这一轮里，agent 到底在干什么（比通话相位更细）。 */
export type AgentActivity = "none" | "thinking" | "tools" | "asking";

/** 工具执行中的可观测子状态。
 *
 * WHY: `AgentActivity = "tools"` 只够说「它在干活」，而读文件、跑命令、写文件在屏幕上
 * 都是同一种半阖眼 —— 一轮跑五个工具时脸几乎不动。子状态全部从**已有的行**推出来
 * （`title` / `kind2` / `status` / `pending`），没有新增任何不可观测的来源：
 *   · `pending > 0`            → awaiting（等授权：请求还挂在服务端）
 *   · 最新一行是工具           → 按工具名/kind 分 reading / running / writing
 *   · 工具 status 终态         → done / failed
 * 其余时刻是 idle（想事情/说话不在这套子状态里，由 mood 负责）。 */
export type ToolSubstate = "idle" | "reading" | "running" | "writing" | "awaiting" | "done" | "failed";

export const TOOL_SUBSTATES: ToolSubstate[] = ["idle", "reading", "running", "writing", "awaiting", "done", "failed"];


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

export const MOODS: TusMood[] = [
  "idle", "talking", "loading", "sleep", "lookLeft", "lookRight", "scan", "strive",
  "focus", "drowsy", "happy", "sad", "surprise", "curious", "wink", "error",
  "working", "asking", "calm", "confused",
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Grok Bot 的九个官方表情（数据来自 `grokbot-anatomy/js/vendor/grok-recipes.json` 的 `expressions`
// 段，2026-10-12 从原引擎提取）。字段保留官方的：`off` 眼心偏移、`wid` 半宽（描边半径）、
// `lidY` 眼睑纵向系数、`oval` 椭圆半径、`tilt` 倾斜（弧度）。`pts` 是 21 点脊线，我们只留它的
// 外接框 `ridge[x0,x1,y0,y1]` —— 21 点插值属于参考实现的多边形填充管线，我们的原语用不上。
// 单位是 body 单位（Grok 的头身坐标），不是 px；px 换算见 `grokEyeBox`。
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type GrokExpression =
  | "neutral" | "happy" | "surprised" | "inspecting" | "sad"
  | "sleepy" | "squinted" | "calm" | "confused";

export interface GrokEyeDescriptor {
  readonly off: readonly [number, number];
  readonly wid: number;
  readonly lidY: number;
  readonly oval: readonly [number, number];
  readonly tilt: number;
  /** pts 的外接框：[x0, x1, y0, y1]。inspecting 的 pts 全为 0（两颗点）。 */
  readonly ridge: readonly [number, number, number, number];
}

const pair = (
  off: readonly [number, number],
  wid: number,
  lidY: number,
  oval: readonly [number, number],
  tilt: number,
  ridge: readonly [number, number, number, number],
): [GrokEyeDescriptor, GrokEyeDescriptor] => [
  { off, wid, lidY, oval, tilt, ridge },
  { off, wid, lidY, oval, tilt, ridge },
];

/** 左眼在 [0]，右眼在 [1]（inspecting 两只眼不等宽，其余对称）。 */
export const GROK_EXPRESSIONS: Record<GrokExpression, [GrokEyeDescriptor, GrokEyeDescriptor]> = {
  neutral: pair([0, 0], 0.13, 1, [0, 0], 0, [0, 0, -0.155, 0.155]),
  happy: pair([0.03, 0.03], 0.1305, 1, [0, 0], 0, [-0.16, 0.16, -0.04, 0.12]),
  surprised: pair([0.03, 0], 0.21, 1, [0, 0], 0, [0, 0, -0.22, 0.22]),
  inspecting: [
    { off: [0.04, 0], wid: 0.27, lidY: 1, oval: [0, 0], tilt: 0, ridge: [0, 0, 0, 0] },
    { off: [0.04, 0], wid: 0.18, lidY: 1, oval: [0, 0], tilt: 0, ridge: [0, 0, 0, 0] },
  ],
  sad: pair([-0.05, 0], 0.13, 1, [0, 0], 0, [-0.0563, 0.0563, -0.106, 0.106]),
  sleepy: pair([0.01, 0], 0.13, 1, [0, 0], 0, [-0.11, 0.11, -0.0125, 0.025]),
  squinted: pair([0.01, 0], 0.13, 1, [0, 0], 0, [-0.12, 0.12, 0, 0]),
  calm: pair([0.05, 0], 0.247, 1, [0.296, 0.247], 0, [-0.296, 0.296, 0, 0]),
  confused: pair([-0.1, 0], 0.1305, 1, [0, 0], 0, [-0.08, 0.01, -0.16, 0.16]),
};

/** 官方别名。注意我们**故意不照搬**两条：`thinking` 在本产品是 focus（不是 sad）、
 *  `angry` 是 strive（不是 neutral）—— 见 `EMO_MOODS` 的注释。 */
export const GROK_EXPRESSION_ALIASES: Record<string, GrokExpression> = {
  thinking: "sad", strange: "inspecting", angry: "neutral", inspect: "inspecting",
  squint: "squinted", idle: "neutral", smile: "happy", sleep: "sleepy",
};

export const GROK_EXPRESSION_NAMES = Object.keys(GROK_EXPRESSIONS) as GrokExpression[];
const GROK_NAME_SET = new Set<string>(GROK_EXPRESSION_NAMES);

/** 未知名字回落到 neutral（官方行为），大小写/空格宽容。 */
export function grokExpressionOf(name: string): GrokExpression {
  const k = String(name ?? "").trim().toLowerCase();
  if (GROK_NAME_SET.has(k)) return k as GrokExpression;
  return GROK_EXPRESSION_ALIASES[k] ?? "neutral";
}

/** 官方表情 → 我们的 mood。两张一对一是新增的；其余复用已有那张读法最近的脸。 */
export const GROK_EXPRESSION_MOOD: Record<GrokExpression, TusMood> = {
  neutral: "idle",
  happy: "happy",
  surprised: "surprise",
  inspecting: "curious",
  sad: "sad",
  sleepy: "drowsy",
  squinted: "focus",
  calm: "calm",
  confused: "confused",
};

/** 官方规定：这五张脸上眨眼要走完整的眼睑曲线，不能简单压扁。我们另外五张也压不得
 *  （error 的 ✕、scan 的横扫线、loading 的方点、strive 的眯眼是思考的读数、sleep 本来就闭着）。 */
export const GROK_BLINK_BLOCKED: GrokExpression[] = ["sad", "happy", "confused", "squinted", "sleepy"];

/** body 单位 → px。以 neutral 标定：Grok 的 0.26 × 0.57 正好是我们的 34 × 70。 */
const GROK_PX = { x: 34 / 0.26, y: 70 / 0.57 } as const;
/** 球只有 196 px 宽（R=98），Grok 的头比我们大：超出的按**同一比例**收，形状比不变。 */
export const GROK_EYE_LIMIT = { w: 64, h: 82 } as const;

/**
 * 描述符 → 我们 capsule 的盒子。宽度 = 脊线半跨 + 两侧描边；高度 = 脊线跨度 + 上下描边×lidY。
 * `off` 是两只眼一起的位移（原引擎靠它把整对眼随头偏），所以左右眼拿到同一个 x/y。
 * 换算后按 `GROK_EYE_LIMIT` 等比收口 —— 只收一边会把宽椭圆拉成圆，丢掉 calm 的读法。
 */
export function grokEyeBox(expr: GrokExpression, right: boolean): { w: number; h: number; x: number; y: number; rot: number } {
  const e = GROK_EXPRESSIONS[expr][right ? 1 : 0];
  const [x0, x1, y0, y1] = e.ridge;
  const rawW = 2 * Math.max(Math.abs(x0), Math.abs(x1)) + 2 * e.wid;
  const rawH = (y1 - y0) + 2 * e.wid * e.lidY;
  const fit = Math.min(1, GROK_EYE_LIMIT.w / (rawW * GROK_PX.x), GROK_EYE_LIMIT.h / (rawH * GROK_PX.y));
  return {
    w: rawW * GROK_PX.x * fit,
    h: rawH * GROK_PX.y * fit,
    x: e.off[0] * GROK_PX.x * fit,
    y: e.off[1] * GROK_PX.y * fit,
    rot: (e.tilt * 180) / Math.PI,
  };
}

/** The GAP between the two eyes (px at scale 1) — the original's `HStack(spacing:)`, i.e. edge to
 *  edge, not centre to centre. The renderer adds the eye's own width to get the centre distance;
 *  reading it as a centre distance is what made the face look cross-eyed at 1.6× scale. */
export function eyeSpacing(mood: TusMood): number {
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
    case "calm":
      return 62;                       // 宽椭圆要留足空隙，否则左右两只撞在一起
    case "confused":
      return 54;                       // 没听懂：靠近一点，像在辨认你刚才那句
    default:
      return 60;
  }
}

/**
 * 球面投影下两眼的角距（度）。
 *
 * WHY: 球面版的横向位置由 `projectEye` 的 ±sep/2 决定，而设计上两眼的**边到边**空隙是
 * `eyeSpacing(mood)`（46–60 逻辑 px）。固定一个角度（旧实现 21°）时中心距只有
 * 2·98·sin(10.5°) ≈ 35.7，比眼宽（focus 40–48）还小 —— 两只眼会叠成一个“暂停”符号。
 * 这里从「空隙 + 两眼半宽」反推中心距，再换算成角度：**未投影的球面空间**里空隙等于
 * `eyeSpacing`；投影后两眼各自按 foreshorten 收窄，屏幕上会等比再小一点。
 *
 * 非有限输入（未来某行 mood 写错 width）不能让整双眼睛消失：宽当 0、半径退回 98。
 */
export function eyeSepAngle(o: { mood: TusMood; leftW: number; rightW: number; ballR?: number }): number {
  const bw = (v: number) => (Number.isFinite(v) ? Math.max(0, v) : 0);
  const br = o.ballR;
  const R = br !== undefined && Number.isFinite(br) && br > 0 ? br : 98;
  const want = eyeSpacing(o.mood) + (bw(o.leftW) + bw(o.rightW)) / 2;
  const half = Math.min(1, Math.max(0, want / (2 * R)));
  return (Math.asin(half) * 180 / Math.PI) * 2;
}

/** Blinking is OFF in these ten faces — a closed eye would read as a different expression.
 *  The first five come from Grok's `blinkBlockingExpressions`, mapped through
 *  `GROK_EXPRESSION_MOOD`; the rest are ours. */
export const BLINK_BLOCKED: TusMood[] = [
  "happy", "sad", "confused", "focus", "drowsy",   // Grok: happy/sad/confused/squinted/sleepy
  "error", "scan", "loading", "strive", "sleep",   // ours
];

/** Next blink, ms. 2.8–6.4 s in the original; it is random because a metronome looks dead. */
export function nextBlinkMs(rand: () => number = Math.random): number {
  return 2800 + rand() * 3600;
}

/** Grok 的眨眼包络：总时长 260 ms = 闭合 70.8 + 闭住 33.3 + 睁开 155.9。
 *  闭的时候多盖 6%（`BLINK_OVERSHOOT`），所以完全闭合那一瞬眼睛不会留一条白缝。 */
export const BLINK_MS = 260;
export const BLINK_CLOSE_MS = 70.833;
export const BLINK_HOLD_MS = 33.333;
export const BLINK_OVERSHOOT = 1.06;
/** 完全闭合时的剩余高度系数（`1 - 1.06` 会被夹到这里）。 */
export const BLINK_CLOSED_SCALE = 0.01;

/** 闭眼程度 0..1：0 = 全开，1 = 闭住（含 hold）。越界返回 0，调用方不用自己判窗口。 */
export function blinkClosureAt(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0 || ms >= BLINK_MS) return 0;
  const smooth = (u: number): number => u * u * (3 - 2 * u);
  if (ms < BLINK_CLOSE_MS) return smooth(ms / BLINK_CLOSE_MS);
  if (ms < BLINK_CLOSE_MS + BLINK_HOLD_MS) return 1;
  const rest = BLINK_MS - BLINK_CLOSE_MS - BLINK_HOLD_MS;
  return 1 - smooth((ms - BLINK_CLOSE_MS - BLINK_HOLD_MS) / rest);
}

/** 闭眼程度 → 眼睛高度系数。1.06 的过冲让闭合点略过 0，夹在 0.01 上。 */
export function blinkScaleAt(ms: number): number {
  return Math.max(BLINK_CLOSED_SCALE, 1 - BLINK_OVERSHOOT * blinkClosureAt(ms));
}

/** Warmth decay after the reply ends. The original lets it bleed for 2.4 s. */
export const WARMTH_MS = 2400;

/** Idle thresholds: a small look-around after 30 s, going to sleep at 90 s. */
export const IDLE_LOOK_MS = 30_000;
export const IDLE_REST_MS = 90_000;
/** 挂着授权请求超过两分钟就不再盯着你：Grok 的 `blocked` 也在 120 s 后转 `drowsy`。
 *  脸可以走神，弹窗还在 —— 走神的是等待这件事，不是这张卡。 */
export const ASKING_DOZE_MS = 120_000;
/** 从困/睡里被叫醒：先「惊一下」（surprised）1.6 s，再回到常态（Grok 的 `waking`）。 */
export const WAKE_MS = 1600;
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
export function exprFor(who: CallPhase | TusMood | "idle", level: number, elapsed: number, o: { resting?: boolean; warmth?: number } = {}): ExprState {
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
    // calm 是「在，但不使劲」：不追着你看，也不困；confused 是「在辨认你刚才那句」：
    // 看着你但注意力收窄（官方两张脸在 Grok 里分别是 idle 与 strange 的底）。
    case "calm":
      return { mode: "idle", attention: 0.5, energy: 0.56, warmth, phaseElapsed: elapsed };
    case "confused":
      return { mode: "listening", attention: 0.64, energy: 0.6, warmth, phaseElapsed: elapsed };
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
  emotion?: TusMood | null;
  life?: TusMood | null;
  resting?: boolean;
  drowsy?: boolean;
  /** 授权请求已经挂了多久（ms）。120 s 之后脸会走神，见 `ASKING_DOZE_MS`。 */
  askingMs?: number;
  /** 刚从困/睡里被叫醒：1.6 s 的「惊一下」，见 `WAKE_MS`。 */
  waking?: boolean;
}): TusMood {
  const { phase, activity = "none", emotion, life, resting, drowsy } = o;
  if (phase === "error") return "error";
  if (phase === "connecting") return "loading";
  // 等你点授权 > 一切，**包括"还在念上一句"**：授权一挂起，这一轮就停在这里了，
  // 耳机里剩下的只是已经排队的旧句子。这时脸上还写着 talking，读起来是"它没在等我"，
  // 而操作者正盯着一个必须由他回答的弹窗。工具/授权状态比相位更接近事实。
  // 唯一例外是挂太久：两分钟还盯着你，读起来不是「在等」而是「在瞪」。
  if (activity === "asking") return (o.askingMs ?? 0) >= ASKING_DOZE_MS ? "drowsy" : "asking";
  // 被叫醒的头 1.6 s：先把「我醒了」演出来，再回到这一轮真正该有的脸。
  if (o.waking) return "surprise";
  if (phase === "speaking") {
    // The words decide HOW it speaks; the phase decides THAT it speaks. An unknown/neutral tag
    // leaves the plain talking face, which is also the fallback when the model writes no tag.
    return emotion && emotion !== "idle" ? emotion : "talking";
  }
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
  mood: TusMood;
  right: boolean;
  /** 旧入口：true = 完全闭住（等价于 blink = 1）。 */
  blinking?: boolean;
  /** 闭眼程度 0..1（`blinkClosureAt` 的输出）—— 0.26 s 包络就是从这里进来的。 */
  blink?: number;
  t: number;
  level: number;
  expr: ExprState;
  sleep?: number;
  /** 工具执行的子状态：眼形/视线在 working 的静止脸上再分一层。 */
  substate?: ToolSubstate;
}): EyeFrame {
  const { mood, right, t, expr } = o;
  const blinking = o.blinking ?? false;
  const blink = clamp01(o.blink ?? (blinking ? 1 : 0));
  const substate = o.substate ?? "idle";
  const level = clamp01(o.level);
  const sleep = clamp01(o.sleep ?? 0);
  const { right: r } = { right };
  // 官方描述符驱动的三张脸：surprise 是「neutral 放大」、calm 是宽椭圆、confused 是左移的窄胶囊。
  // 只在需要时算（每帧两只眼各一次，开销可忽略）。
  const grokBox = mood === "surprise" ? grokEyeBox("surprised", right)
    : mood === "calm" ? grokEyeBox("calm", right)
      : mood === "confused" ? grokEyeBox("confused", right)
        : null;

  // --- shape ------------------------------------------------------------------------------
  if (mood === "error") {
    return substateEye({ shape: "x", w: 45, h: 45, yScale: 1, xScale: 1, rot: 0, x: 0, y: 0, alpha: 0.86, glow: 10, jitter: 6 }, substate, right, t);
  }
  if (mood === "happy" || mood === "sad") {
    // Arcs, not capsules: joy curves up out of the eye, sadness curves down.
    return substateEye({
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
    }, substate, right, t);
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
    case "surprise": w = grokBox!.w; break;      // neutral 放大 1.5 倍（官方 surprised）
    case "calm": w = grokBox!.w; break;          // 宽椭圆：64×27
    case "confused": w = grokBox!.w; break;      // 比 idle 宽、整对左移
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
    case "surprise": h = grokBox!.h; break;
    case "calm": h = grokBox!.h; break;
    case "confused": h = grokBox!.h; break;
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
  // 官方 confused 是「胶囊中间往左拱」；capsule 画不出拱，用整体左倾近似（rot 由描述符的
  // tilt 给出，九张全是 0，所以这里补的是原语误差）。
  else if (mood === "confused") rot = grokBox!.rot - 8;
  else if (isThinking) rot = r ? 4 : -4;

  let x = 0;
  switch (mood) {
    case "lookLeft": x = -40; break;
    case "lookRight": x = 40; break;
    case "scan": x = Math.sin(t * 3.5) * 45; break;
    case "working": x = 0; break;
    case "asking": x = Math.sin(t * 0.9) * 1.2; break;
    // `projectEyes` 把风格位移按 0.5 权重叠到球面投影上；描述符的 `off` 是整对眼在屏幕上的
    // 实际位移，所以这里 ×2（否则 confused 的左移只剩 6 px，读不出来）。
    case "calm": x = grokBox!.x * 2 + Math.sin(t * 0.7) * 1.2; break;
    case "confused": x = grokBox!.x * 2 + Math.sin(t * 1.3) * 2; break;
    case "surprise": x = grokBox!.x * 2; break;
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
    case "surprise": y = grokBox!.y; break;
    case "calm": y = grokBox!.y + Math.sin(t * 1.1) * 1.1; break;   // 缓慢起伏，像在呼吸
    case "confused": y = grokBox!.y + Math.sin(t * 1.7) * 1.5; break;
  }

  let yScale = 1;
  if (mood === "talking") yScale = 0.72 + level * 0.42 + Math.sin(t * 8) * 0.06 + expr.warmth * 0.04;
  else if (mood === "drowsy") yScale = Math.max(0.18, 1 - sleep * 0.74);
  else if (mood === "working") yScale = 0.58 + Math.sin(t * 1.6) * 0.02;  // 半阖：专注，不是困
  else if (mood === "calm") yScale = 0.82 + Math.sin(t * 1.1) * 0.02;    // 半阖的平静（官方 oval 已经很宽）
  else if (mood === "confused") yScale = 0.98 + Math.sin(t * 1.7) * 0.015;
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
  // `blink` 是 0.26 s 包络的闭眼程度（0..1）；1.06 的过冲让闭合点略过 0，夹在 0.01。
  if (blink > 0 && !BLINK_BLOCKED.includes(mood)) {
    yScale = Math.min(yScale, Math.max(BLINK_CLOSED_SCALE, 1 - BLINK_OVERSHOOT * blink));
  }

  return substateEye({
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
  }, substate, right, t);
}

/**
 * 子状态的眼形。和 `substateBall` 分工：这里管"在看什么/怎么用力"，
 * 球体姿态管"身体朝向"。六个状态两两之间至少有一个通道不同（单测钉住）：
 *   · reading — 眼稍微收窄、往下偏、带一点扫视；
 *   · running — 更窄更扁，带一条更快的小抖动（在跑命令的节奏）；
 *   · writing — 两只眼不对称地往一处收（盯着下笔的那一点）；
 *   · awaiting — 恢复竖长、更亮（看着你等一个答复）；
 *   · done — 眼睛往上提、变矮（松一口气）；
 *   · failed — 往下掉、倾斜、变暗（没做成）。
 */
function substateEye(e: EyeFrame, sub: ToolSubstate, right: boolean, t: number): EyeFrame {
  switch (sub) {
    case "reading":
      return { ...e, w: e.w * 0.9, h: e.h * 0.82, rot: e.rot + 3, y: e.y + 2 };
    case "running":
      return {
        ...e, w: e.w * 1.06, h: e.h * 0.74, yScale: e.yScale * 0.82,
        jitter: Math.max(e.jitter, 1.1), y: e.y + Math.sin(t * 5.5) * 1.2,
      };
    case "writing":
      return { ...e, w: e.w * (right ? 0.76 : 0.88), h: e.h * 0.9, rot: e.rot + (right ? 4 : 1), y: e.y + 3 };
    case "awaiting":
      return { ...e, w: e.w * 0.94, h: e.h * 1.08, alpha: Math.min(1, e.alpha + 0.06), glow: e.glow + 3, rot: e.rot * 0.3 };
    case "done":
      return { ...e, w: e.w * 0.92, h: e.h * 0.72, y: e.y - 5, rot: e.rot * 0.4, alpha: Math.min(1, e.alpha + 0.04) };
    case "failed":
      return {
        ...e, w: e.w * 0.96, h: e.h * 0.8, y: e.y + 5, rot: e.rot + (right ? 5 : -5),
        alpha: e.alpha * 0.88, glow: e.glow * 0.8,
      };
    default:
      return e;
  }
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

/** 工具名/kind 的三类分法。先看 ACP 的 `kind`，再退回标题里的动词 ——
 *  真实后端两类都出现过（Hermes 给 kind=read/edit/execute 也把动词写进标题）。 */
function toolClassOf(title = "", kind = ""): "reading" | "running" | "writing" {
  const k = kind.toLowerCase();
  if (k === "edit" || k === "write" || k === "patch" || k === "create") return "writing";
  if (k === "read" || k === "search" || k === "fetch") return "reading";
  if (k === "execute" || k === "run" || k === "command" || k === "terminal") return "running";
  const t = title.toLowerCase();
  // 顺序有讲究：`write` 先于 `read`（"Write file" 里没有 read，但反过来的标题不少），
  // 而 `run` 最后 —— "read and run" 读的是文件，不是命令。
  if (/\b(write|edit|patch|apply_patch|multi_edit|create|mkdir|delete|move|rename)\b|写入|编辑|修改/.test(t)) return "writing";
  if (/\b(read|cat|head|tail|view|open|glob|grep|search|find|list|ls|tree)\b|读取|查看|搜索/.test(t)) return "reading";
  return "running";
}

/**
 * 工具执行的可观测子状态。判据全部来自行本身；`pending > 0`（授权请求还在）优先于
 * 一切 —— 此刻它不是在读也不是在写，是在等你。
 */
export function substateOf(o: {
  busy: boolean;
  pending: number;
  newestKind?: string;
  newestToolStatus?: string;
  newestToolTitle?: string;
  newestToolKind?: string;
}): ToolSubstate {
  if (o.pending > 0) return "awaiting";
  if (!o.busy || o.newestKind !== "tool") return "idle";
  const s = String(o.newestToolStatus ?? "").toLowerCase();
  if (s === "failed" || s === "error" || s === "cancelled") return "failed";
  if (s === "completed" || s === "success") return "done";
  return toolClassOf(o.newestToolTitle, o.newestToolKind);
}

// --------------------------------------------------------------- the life beat

export interface LifeBeat {
  mood: TusMood;
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
  const pool: TusMood[] = idleMs > IDLE_LOOK_MS
    ? ["lookLeft", "lookRight", "curious", "wink", "focus", "calm"]
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
const LEX: { mood: TusMood; words: string[] }[] = [
  { mood: "happy", words: ["开心", "高兴", "太好了", "喜欢", "棒", "恭喜", "成功", "完成了", "搞定", "哈哈", "谢谢"] },
  { mood: "sad", words: ["抱歉", "难过", "遗憾", "可惜", "失败了", "没成功", "不舒服", "唉"] },
  { mood: "surprise", words: ["竟然", "居然", "没想到", "原来", "意外", "真的吗"] },
  { mood: "curious", words: ["要不要", "是不是", "你觉得", "哪个", "为什么", "要我", "需要我"] },
  { mood: "strive", words: ["麻烦", "麻烦你", "冲突", "错误", "报错", "卡住", "超时"] },
];
/** 「不/没/别」紧跟情绪词时不算 —— 这一条就是那个「我不难过」的形状。 */
const NEG = /[不没别未无](?:有|是|会|太|要)?\s*$/;

export function deriveEmotion(text: string): TusMood | null {
  const t = String(text ?? "");
  if (!t) return null;
  let best: { mood: TusMood; at: number } | null = null;
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

/** The tag vocabulary: the nine official Grok names + their aliases + the names we already
 *  promised, minus the aliases we deliberately read differently. */
export const EMO_MOODS: Record<string, TusMood> = {
  // 官方九表情，一对一（neutral 回到 idle；inspecting 复用「看着你」的 curious）
  neutral: "idle", happy: "happy", surprised: "surprise", inspecting: "curious",
  sad: "sad", sleepy: "drowsy", squinted: "focus", calm: "calm", confused: "confused",
  // 官方别名里的五条（thinking / angry / sleep 三条见下）
  smile: "happy", inspect: "curious", strange: "curious", squint: "focus", idle: "idle",
  // 故意偏离官方的三条：
  //   · thinking —— 官方 thinking→sad，但在本产品里「在想」是 focus（眯起来往上看）；
  //   · angry    —— 官方 angry→neutral，我们的 strive 才是那张「顶住了/出问题了」的脸；
  //   · sleep    —— 官方 sleep→sleepy(drowsy)，我们的 sleep 是真的闭眼睡着，sleepy 才是 drowsy。
  thinking: "focus", focus: "focus", angry: "strive", sleep: "sleep",
  // OpenNomi 时代的同义词，继续认（老提示词/老会话里还会出现）
  joy: "happy", love: "happy", surprise: "surprise", curious: "curious",
  strive: "strive", shy: "wink", wink: "wink",
};

/** ONLY `[emo:x]` / `[emotion: x]` — never a bare bracket, so ordinary text cannot be eaten. */
const EMO_TAG = /\[\s*(?:emo|emotion)\s*[:：]\s*([a-zA-Z\u4e00-\u9fa5_-]{1,16})\s*\]/gi;

/** Every mood the text asks for, in order. Unknown words are dropped, not guessed. */
export function readEmoTags(text: string): TusMood[] {
  const out: TusMood[] = [];
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
export function saccadeFor(rand: () => number = Math.random): { mood: TusMood; durationMs: number } {
  const r = rand();
  const mood: TusMood = r < 0.42 ? "lookLeft" : r < 0.84 ? "lookRight" : "wink";
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
export function ballFrame(
  mood: TusMood,
  o: { level?: number; breath?: number; sleep?: number; substate?: ToolSubstate } = {},
): BallFrame {
  const rest = ballMoodFrame(mood, o);
  return substateBall(rest, o.substate ?? "idle");
}

function ballMoodFrame(mood: TusMood, o: { level?: number; breath?: number; sleep?: number }): BallFrame {
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
    case "calm":
      return { r: 100, sx: 1.01, sy: 0.99, dy: -1, rot: -2 };
    case "confused":
      return { r: 96, sx: 1.02, sy: 0.96, dy: 2, rot: 8 };
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
 * 子状态在静止姿态上叠的一层小位移。
 *
 * 同一张 `working` 脸，读文件/跑命令/写文件的身体必须不一样：眼睛形状（`substateEye`）
 * 管"在看什么"，球体姿态管"身体朝向" —— 两层加起来，六个子状态才各自读得出来。
 * 数值故意小（±4 px / ±9°）：工具还在跑，这不是换一张脸，是换个姿势。
 */
export function substateBall(f: BallFrame, sub: ToolSubstate): BallFrame {
  switch (sub) {
    case "reading":  return { ...f, r: f.r - 1, rot: f.rot - 4, dy: f.dy + 2 };
    case "running":  return { ...f, r: f.r - 2, sx: f.sx * 0.98, sy: f.sy * 0.96, rot: f.rot + 2, dy: f.dy + 3 };
    case "writing":  return { ...f, r: f.r - 2, sx: f.sx * 1.02, sy: f.sy * 0.95, rot: f.rot + 9, dy: f.dy + 4 };
    case "awaiting": return { ...f, r: f.r + 3, sy: f.sy * 1.02, dy: f.dy - 2, rot: f.rot * 0.4 };
    case "done":     return { ...f, r: f.r + 4, sy: f.sy * 1.05, dy: f.dy - 5, rot: f.rot - 3 };
    case "failed":   return { ...f, r: f.r - 4, sy: f.sy * 0.94, dy: f.dy + 5, rot: f.rot + 3 };
    default:         return f;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Clip 编排：切脸不再"一步弹到目标值"，而是先播一段 1.4–6 s 的短动作。
//
// WHY: 一个 mood 只有一个静止姿态时，脸在第一帧就到终点，之后只剩呼吸 —— 读起来是"一张图
// 在晃"。人做表情不是这样：听到你开口会先抬一下、说完话会往下沉一下再回位。所以把
// `ballFrame` 的静止目标升级成**关键帧 clip**：2–4 帧、每段自己的时长和 easing，播完回到
// 当前 mood 的静止姿态。clip 是纯数据（下面的 CLIPS 就是全部），采样器只做插值 ——
// 想加一个新动作是加一行数据，不是再加一个 if/else。
//
// 时钟：`clipFrameAt(clip, elapsedMs)` 的 elapsed 由调用方传（TusFace 用 rAF 的时刻）。
// 这里**不读 Date.now()/performance.now()**，所以同一组输入在单测里永远得到同一帧。
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type ClipName =
  | "listen-in"    // 听开始：抬一下，看着你
  | "say-in"       // 张嘴说话：吸气 → 吐出来
  | "think-turn"   // 思考转段：眯一下，换个角度
  | "tool-start"   // 工具开工：收一下再压进活里
  | "tool-done"    // 工具完成：向上轻弹
  | "error-frown"  // 错误/皱眉：缩一下，左右抖
  | "ask-hold"     // 等你授权：前倾歪头（我们自己的）
  | "blink-pop"    // 眨眼：身体跟着眨一下（我们自己的）
  | "tool-fail"    // 工具失败：往下一沉再收住（我们自己的）
  | "wake";        // 从犯困/睡着回神：伸个懒腰（我们自己的）

export type ClipEase = "linear" | "in" | "out" | "inOut";

/** 一帧相对静止姿态的倍数。r/sx/sy 以 1 为静止；dy/rot 以 0 为静止、
 *  单位是 `CLIP_DY_UNIT` px / `CLIP_ROT_UNIT` 度。 */
export interface ClipFrame {
  r: number;
  sx: number;
  sy: number;
  dy: number;
  rot: number;
}

export interface TusClip {
  /** 2–4 帧；第一帧和最后一帧都是静止姿态（clip 以"回归"收尾）。 */
  frames: ClipFrame[];
  /** 帧与帧之间的时长，长度 = frames.length - 1。 */
  ms: number[];
  ease: ClipEase[];
}

export const CLIP_DY_UNIT = 6;      // px（呼吸是 ±6，过冲 1.4 ≈ 8.4 px）
export const CLIP_ROT_UNIT = 9;     // 度（歪头 1.4 ≈ 12.6°，再大读成摔倒）
export const CLIP_MIN_MS = 1400;
export const CLIP_MAX_MS = 6000;

/**
 * 过冲带：1.36–1.50。
 *
 * WHY A BAND, NOT "whatever looks good": 过冲是这段动作里唯一会被读成"有重量"的东西，
 * 但它只在一个很窄的窗口里成立 ——
 *   · < 1.36：和 easing 的减速尾巴分不开，观众只会觉得"停得有点软"，不会觉得"弹了"；
 *   · > 1.50：球开始读成果冻/散架，尤其 sy（压扁轴）上 1.5 已经是 45° 的椭圆。
 * 所以 `normalizeClip` 在模块加载时把每条 clip 的**最大振幅**归一化到这条带里：
 * 超过 1.50 的整条按比例压回来，低于 1.36 的按比例放大 —— 作者只关心"哪里弹"，
 * 不关心"弹多少"，数值永远不会跑出这条带。
 */
export const OVERSHOOT = { min: 1.36, max: 1.5 } as const;

const REST_FRAME: ClipFrame = { r: 1, sx: 1, sy: 1, dy: 0, rot: 0 };

/** 作者写的数据。归一化发生在 `CLIPS` 的构造处，见 `normalizeClip`。 */
const RAW_CLIPS: Record<ClipName, TusClip> = {
  // 听开始（1.40 s）：先抬一下（dy 1.42 的过冲），再落回来。眼形由 curious 负责。
  "listen-in": {
    frames: [
      REST_FRAME,
      { r: 1.02, sx: 1.03, sy: 1.06, dy: -1.42, rot: -0.6 },
      { r: 1.01, sx: 0.99, sy: 1.02, dy: 0.8, rot: 0.35 },
      REST_FRAME,
    ],
    ms: [180, 260, 960],
    ease: ["out", "inOut", "out"],
  },
  // 张嘴说话（1.50 s）：吸气缩小 → 吐气涨开 → 回位。
  "say-in": {
    frames: [
      REST_FRAME,
      { r: 1.05, sx: 1.05, sy: 0.93, dy: -1.1, rot: 0.2 },
      { r: 1.06, sx: 0.98, sy: 1.08, dy: 1.4, rot: -0.3 },
      REST_FRAME,
    ],
    ms: [120, 220, 1160],
    ease: ["in", "out", "inOut"],
  },
  // 思考转段（2.00 s）：往一侧眯一下，再回来换个角度 —— 配合 thinkingStage 的三个台阶。
  "think-turn": {
    frames: [
      REST_FRAME,
      { r: 0.99, sx: 1.06, sy: 0.92, dy: 0.7, rot: -1.36 },
      { r: 1.01, sx: 0.98, sy: 1.03, dy: -0.9, rot: 0.5 },
      REST_FRAME,
    ],
    ms: [200, 700, 1100],
    ease: ["out", "inOut", "out"],
  },
  // 工具开工（1.80 s）：先收一下蓄力，再压进活里（向上弹一下）。
  "tool-start": {
    frames: [
      REST_FRAME,
      { r: 0.98, sx: 1.12, sy: 0.86, dy: 1.2, rot: 0.3 },
      { r: 1.02, sx: 0.96, sy: 1.06, dy: -1.42, rot: -0.6 },
      REST_FRAME,
    ],
    ms: [150, 250, 1400],
    ease: ["in", "out", "inOut"],
  },
  // 工具完成（2.00 s）：往上一提，落回来时还有一下回弹。
  "tool-done": {
    frames: [
      REST_FRAME,
      { r: 1.04, sx: 1.0, sy: 1.08, dy: -1.45, rot: -1.1 },
      { r: 1.01, sx: 1.03, sy: 0.96, dy: 1.36, rot: 0.5 },
      REST_FRAME,
    ],
    ms: [220, 380, 1400],
    ease: ["out", "in", "out"],
  },
  // 错误/皱眉（1.90 s）：缩一下，左右抖两下。
  "error-frown": {
    frames: [
      REST_FRAME,
      { r: 0.95, sx: 1.06, sy: 0.92, dy: 1.3, rot: -1.45 },
      { r: 0.98, sx: 1.02, sy: 0.96, dy: 0.7, rot: 1.36 },
      REST_FRAME,
    ],
    ms: [180, 520, 1200],
    ease: ["out", "inOut", "out"],
  },
  // 等你授权（3.06 s）：前倾、歪头，停住 —— 它会一直保持到请求被答复。
  "ask-hold": {
    frames: [
      REST_FRAME,
      { r: 1.02, sx: 0.99, sy: 1.02, dy: -0.7, rot: 1.36 },
      { r: 1.01, sx: 1.02, sy: 1.0, dy: 0.5, rot: 1.1 },
      REST_FRAME,
    ],
    ms: [260, 1200, 1600],
    ease: ["out", "inOut", "inOut"],
  },
  // 眨眼（1.40 s）：眼睛自己闭，球只跟着轻轻点一下。
  "blink-pop": {
    frames: [
      REST_FRAME,
      { r: 0.99, sx: 1.01, sy: 0.97, dy: 1.4, rot: 0 },
      REST_FRAME,
    ],
    ms: [180, 1220],
    ease: ["out", "out"],
  },
  // 工具失败（1.94 s）：被结果打了一下，先沉再稳住（比 error 轻，不是那张 X 脸）。
  "tool-fail": {
    frames: [
      REST_FRAME,
      { r: 0.94, sx: 1.08, sy: 0.9, dy: 1.45, rot: -0.8 },
      { r: 0.97, sx: 0.98, sy: 0.96, dy: 0.4, rot: 0.7 },
      REST_FRAME,
    ],
    ms: [160, 380, 1400],
    ease: ["out", "inOut", "out"],
  },
  // 回神（2.60 s）：从犯困/睡着里伸个懒腰再坐正。
  "wake": {
    frames: [
      REST_FRAME,
      { r: 1.05, sx: 0.97, sy: 1.06, dy: -1.45, rot: 0.4 },
      { r: 1.0, sx: 1.02, sy: 0.98, dy: 0.6, rot: -0.2 },
      REST_FRAME,
    ],
    ms: [200, 600, 1800],
    ease: ["out", "inOut", "out"],
  },
};

/** 一帧里最大的"离开静止"的幅度。scale 通道看 |v-1|，dy/rot 看绝对值。 */
export function clipPeak(c: TusClip): number {
  let peak = 0;
  for (const f of c.frames) {
    peak = Math.max(peak, Math.abs(f.r - 1), Math.abs(f.sx - 1), Math.abs(f.sy - 1), Math.abs(f.dy), Math.abs(f.rot));
  }
  return peak;
}

/** 把整条 clip 等比缩放进过冲带（见 OVERSHOOT 的注释）。 */
export function normalizeClip(c: TusClip): TusClip {
  const peak = clipPeak(c);
  if (!(peak > 0)) return c;
  const k = peak > OVERSHOOT.max ? OVERSHOOT.max / peak
    : peak < OVERSHOOT.min ? OVERSHOOT.min / peak : 1;
  if (k === 1) return c;
  return {
    ...c,
    frames: c.frames.map((f) => ({
      r: 1 + (f.r - 1) * k, sx: 1 + (f.sx - 1) * k, sy: 1 + (f.sy - 1) * k,
      dy: f.dy * k, rot: f.rot * k,
    })),
  };
}

export const CLIPS: Record<ClipName, TusClip> = Object.fromEntries(
  (Object.keys(RAW_CLIPS) as ClipName[]).map((n) => [n, normalizeClip(RAW_CLIPS[n])]),
) as Record<ClipName, TusClip>;

export const CLIP_NAMES = Object.keys(CLIPS) as ClipName[];

/**
 * 同一帧里两条 clip 同时被触发时谁说话。两个来源（工具行状态、mood）描述的是同一瞬间，
 * 而"结果"比"过渡"更值得被看见：工具完成/失败、报错、等授权不能被 say-in/tool-start 盖掉；
 * 眨眼最轻，永远让路。同优先级时后到的赢（例如 working 与 tick 都指向 tool-start）。
 */
export const CLIP_PRIORITY: Record<ClipName, number> = {
  "blink-pop": 0,
  "tool-start": 1,
  "listen-in": 2,
  "say-in": 2,
  "think-turn": 2,
  wake: 2,
  "ask-hold": 3,
  "tool-done": 4,
  "tool-fail": 4,
  "error-frown": 4,
};

export function clipDurationMs(c: TusClip): number {
  return c.ms.reduce((a, b) => a + b, 0);
}

const EASES: Record<ClipEase, (t: number) => number> = {
  linear: (t) => t,
  in: (t) => t * t * t,
  out: (t) => 1 - Math.pow(1 - t, 3),
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
};

/** 采样安全网：归一化后的数据本身在带里，这里只防手改/浮点越界。 */
function clampFrame(f: ClipFrame): ClipFrame {
  const sc = (v: number): number => Math.min(OVERSHOOT.max, Math.max(1 / OVERSHOOT.max, v));
  const am = (v: number): number => Math.min(OVERSHOOT.max, Math.max(-OVERSHOOT.max, v));
  return { r: sc(f.r), sx: sc(f.sx), sy: sc(f.sy), dy: am(f.dy), rot: am(f.rot) };
}

/**
 * 在 `elapsedMs` 时刻的那一帧（相对静止姿态）。播完返回 null —— 调用方据此回到静止姿态。
 * 纯函数：同一 (clip, elapsedMs) 永远同一帧，单测里可以逐帧钉住。
 */
export function clipFrameAt(c: TusClip, elapsedMs: number): ClipFrame | null {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  let left = elapsedMs;
  for (let i = 0; i < c.ms.length; i++) {
    const d = c.ms[i];
    if (left <= d) {
      const u = d > 0 ? left / d : 1;
      const e = EASES[c.ease[i] ?? "linear"](u);
      const a = c.frames[i], b = c.frames[i + 1] ?? a;
      return clampFrame({
        r: a.r + (b.r - a.r) * e,
        sx: a.sx + (b.sx - a.sx) * e,
        sy: a.sy + (b.sy - a.sy) * e,
        dy: a.dy + (b.dy - a.dy) * e,
        rot: a.rot + (b.rot - a.rot) * e,
      });
    }
    left -= d;
  }
  return null;
}

/** 把 clip 的一帧叠到静止姿态上。dy/rot 是加在静止值上的（呼吸/低头的基准还在）。 */
export function applyClip(rest: BallFrame, f: ClipFrame): BallFrame {
  return {
    r: rest.r * f.r,
    sx: rest.sx * f.sx,
    sy: rest.sy * f.sy,
    dy: rest.dy + f.dy * CLIP_DY_UNIT,
    rot: rest.rot + f.rot * CLIP_ROT_UNIT,
  };
}

export type FaceEvent =
  | { kind: "mood"; from: TusMood; to: TusMood }
  | { kind: "tool"; status: "start" | "done" | "failed" }
  | { kind: "think"; stage: 0 | 1 | 2 }
  | { kind: "blink" };

/**
 * 事件 → clip。只有**值得动手**的切换才返回名字；其余返回 null（保持静止姿态）。
 * 听/想的临时小动作（lookLeft/lookRight/wink/scan）不触发 listen-in —— 否则每次
 * 扫一眼回来都会重播一遍"我听见了"，5 秒一次的大动作会显得很躁。
 */
export function clipFor(ev: FaceEvent): ClipName | null {
  switch (ev.kind) {
    case "tool":
      return ev.status === "start" ? "tool-start" : ev.status === "done" ? "tool-done" : "tool-fail";
    case "blink":
      return "blink-pop";
    case "think":
      return ev.stage === 0 ? null : "think-turn";
    case "mood": {
      const { from, to } = ev;
      if (to === "error") return "error-frown";
      if (to === "asking") return "ask-hold";
      if (to === "working") return "tool-start";
      if (to === "talking") return "say-in";
      if (to === "focus") return "think-turn";
      if (to === "curious") {
        return from === "lookLeft" || from === "lookRight" || from === "wink" || from === "scan"
          ? null : "listen-in";
      }
      if ((to === "idle" || to === "happy") && (from === "sleep" || from === "drowsy")) return "wake";
      return null;
    }
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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 球面眼（伪 3D）。眼睛不是贴在平面上的贴纸，而是**长在球面上**：按正交投影摆放，
// 往侧看时近的一只变窄、远的一只几乎看不见 —— 这一条是"有体积"和"平面图案"的分界。
//
// 参数取自 Grok Bot 解剖里的实测值：眼睛活动范围 水平 14° / 垂直 18°（形状类眼睛 19°/26°）。
// 14° 听着小，但把它乘到半径上就是 ±0.24R 的位移，肉眼足够读出"它在看哪"。
// 注意它只是**视线**的范围：加上两眼自己的 ±sep/2（宽眼可到 45°），外眼可以到 ~60°，
// 这就是 `projectEyes` 需要球缘收口的原因。
// ─────────────────────────────────────────────────────────────────────────────────────────────

// 两眼在球面上的夹角不写死：它由当前表情的**边到边空隙**反推（见 `eyeSepAngle`）。
// 固定角度在宽眼上会让两只眼叠成一个"暂停"符号。
export const SPHERE = { maxX: 14, maxY: 18 } as const;

/** 视点角度（度）。指针、情绪、思考都会把眼睛往某个方向拽。 */
export function gazeAngles(o: { mood: TusMood; pointerX?: number; pointerY?: number; elapsed?: number; level?: number; substate?: ToolSubstate }): { ax: number; ay: number } {
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
    case "calm":
      bx = 0.08; by = 0.05; break;           // 平静地在场，不强求对视
    case "confused":
      bx = -0.4; by = -0.12; break;          // 视线偏到一边：在回忆你刚才那句
    default: break;
  }
  // 工具子状态把视线再分一层：读文件往左下扫、写文件往右下盯、完成往上、失败往下。
  // 只加在基础方向上，指针仍然有权重（见下），所以手一动眼睛还是会跟着你。
  switch (o.substate ?? "idle") {
    case "reading": bx -= 0.35; by += 0.55; break;
    case "running": bx += 0.05; by += 0.75; break;
    case "writing": bx += 0.4; by += 0.75; break;
    case "awaiting": bx *= 0.3; by = 0.15; break;
    case "done": bx += 0.1; by -= 0.5; break;
    case "failed": bx *= 0.6; by += 0.65; break;
    default: break;
  }
  // 指针是"它看着你"的输入，权重比情绪高：手一动眼睛就跟着，这条最容易让人觉得"活的"。
  const ax = Math.max(-1, Math.min(1, bx * 0.7 + px * 0.9));
  const ay = Math.max(-1, Math.min(1, by * 0.7 + py * 0.8));
  return { ax: ax * SPHERE.maxX, ay: ay * SPHERE.maxY };
}

/** 正交投影：把球面上某个角度的一个点投到屏幕坐标，并给出它的缩小系数（cos）。
 *  `sep` 必须由 `eyeSepAngle` 按当前表情的眼宽算出来 —— 固定角距会让宽眼重叠。 */
export function projectEye(o: { ax: number; ay: number; side: -1 | 1; R: number; sep: number }): { x: number; y: number; cos: number } {
  const th = ((o.ax + o.side * o.sep / 2) * Math.PI) / 180;
  const tv = (o.ay * Math.PI) / 180;
  // 球面上的点 (sinθ, sinφ, cosθ·cosφ)，正交投影只取前两维；cosθ·cosφ 就是"正对镜头的比例"。
  return {
    x: o.R * Math.sin(th),
    y: o.R * Math.sin(tv),
    cos: Math.max(0, Math.cos(th) * Math.cos(tv)),
  };
}

/** 一只眼在屏幕上的可见几何（x/y 是相对球心，w 是透视收窄后的可见宽）。 */
export interface ScreenEye { x: number; y: number; w: number; cos: number }

/**
 * 渲染器真正使用的那条几何链：`eyeFrame` → `eyeSepAngle` → `projectEye` → 透视收窄。
 *
 * WHY 单独抽出来：单测如果只验 `eyeSepAngle` 的逆运算，渲染器哪怕退回固定 sep 也照样全绿
 * —— 这正是 2026-10-24 live 上“两只眼叠成暂停符号”漏过去的原因。渲染器与 QA 必须吃同一份数字。
 *
 * 球缘保护：宽眼/横扫时外缘会越过球的轮廓，被 `g.clip` 切平。**先收横向滑移**（`eye.x` 是风格
 * 位移，不该把眼带出球），只有宽眼本身越界时才反解一个更小的有效角距 —— 反过来的顺序会让
 * 角距被压到接近 0、两只眼重新叠成“暂停”符号。1.05R 是允许的轻微擦边（旧实现最坏也是 1.05R）。
 */
export function projectEyes(o: {
  mood: TusMood;
  left: EyeFrame;
  right: EyeFrame;
  gaze: { ax: number; ay: number };
  ballR?: number;
  k?: number;
}): { left: ScreenEye; right: ScreenEye; gap: number; sep: number } {
  const kk = o.k ?? 1;
  const k = Number.isFinite(kk) && kk > 0 ? kk : 1;
  const br = o.ballR;
  const R = (br !== undefined && Number.isFinite(br) && br > 0 ? br : 98) * k;
  const design = eyeSepAngle({ mood: o.mood, leftW: o.left.w, rightW: o.right.w, ballR: o.ballR });
  const one = (e: EyeFrame, side: -1 | 1, sep: number, panScale: number): ScreenEye => {
    const pj = projectEye({ ax: o.gaze.ax, ay: o.gaze.ay, side, R, sep });
    const foreshorten = 0.55 + 0.45 * pj.cos;
    return {
      x: pj.x + e.x * k * 0.5 * panScale,
      y: pj.y + e.y * k,
      w: Math.max(2, e.w * k * e.xScale * foreshorten),
      cos: pj.cos,
    };
  };
  const cap = 1.05 * R;
  const build = (sep: number, panScale: number) => {
    const l = one(o.left, -1, sep, panScale), r = one(o.right, 1, sep, panScale);
    return { l, r, out: Math.max(Math.abs(l.x) + l.w / 2, Math.abs(r.x) + r.w / 2) };
  };
  let sep = design;
  let b = build(sep, 1);
  if (b.out > cap) {
    if (build(sep, 0).out <= cap) {
      let lo = 0, hi = 1;
      for (let i = 0; i < 18; i++) {
        const mid = (lo + hi) / 2;
        if (build(sep, mid).out > cap) hi = mid; else lo = mid;
      }
      b = build(sep, lo);
    } else {
      // 眼宽本身在视点边缘放不下：二分找“刚好放得下”的最大角距（pan 已收到 0）。
      let lo = 0, hi = design;
      for (let i = 0; i < 18; i++) {
        const mid = (lo + hi) / 2;
        if (build(mid, 0).out > cap) hi = mid; else lo = mid;
      }
      sep = lo;
      b = build(sep, 0);
    }
  }
  return { left: b.l, right: b.r, gap: b.r.x - b.r.w / 2 - (b.l.x + b.l.w / 2), sep };
}
