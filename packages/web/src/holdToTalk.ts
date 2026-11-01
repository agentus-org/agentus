// 按住说话（issue #82）—— 麦克风按钮 / 输入框上的指针手势，与按住 Ctrl 那条通道同构。
//
// 为什么单独一个文件：这一层全是时间与位移的判断（按住多久算说话、指针漂多远算拖选、松手算长按还是
// 短按），与 DOM 无关，能像 mention.ts 那样用单测钉住；App.tsx 只负责把事件接上来。
//
// 三条规矩（都来自操作者的真机反馈）：
//  1) **只认 pointerup / pointercancel，不认 pointerleave**。按住说话时输入框会变高、状态条会出现，
//     按钮会自己往下移 —— 指针没动，却「离开」了元素边界。手机端已经因此断过一次录音。
//  2) **位移阈值放宽到 12px**。布局自己动时，指针相对视口静止、相对元素却在漂。
//  3) **短按保留原行为**。鼠标用户不该因为这次改动失去「点一下开始/停止」。
//
// 手势结果只有三种：`hold`（够久、没漂 → 说话）、`tap`（短按 → 调用方照旧处理）、`null`（被取消）。

export const HOLD_TO_TALK_MS = 480;
/** 指针相对按下点漂这么远就当作"他在拖选/挪动"，不是按住说话。 */
export const HOLD_MOVE_TOLERANCE_PX = 12;

export type HoldGesture = "hold" | "tap" | null;

export interface HoldToTalk {
  /** 指针按下。返回 false = 这一路不接（例如已经在按住）。 */
  down(x: number, y: number): boolean;
  /** 指针移动。越过阈值则本次手势作废（让浏览器的原生拖选照常进行）。 */
  move(x: number, y: number): void;
  /** 指针抬起。`hold` = 该停录音；`tap` = 按原样处理点击；`null` = 本次不算数。 */
  up(): HoldGesture;
  /** 外部取消（pointercancel / blur / 选了别的模式）。 */
  cancel(): void;
  /** 已经进入"按住说话"状态了吗（调用方据此决定松手要不要 stop）。 */
  holding(): boolean;
  /** 这一次按下还没结算（用来吞掉长按之后紧跟的 click）。 */
  pending(): boolean;
}

export interface HoldToTalkOptions {
  thresholdMs?: number;
  moveTolerance?: number;
  /** 够久了：调用方在这里开始收音。 */
  onHold: () => void;
}

export function createHoldToTalk(opts: HoldToTalkOptions): HoldToTalk {
  const threshold = Math.max(80, opts.thresholdMs ?? HOLD_TO_TALK_MS);
  const tol = Math.max(2, opts.moveTolerance ?? HOLD_MOVE_TOLERANCE_PX);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let origin: { x: number; y: number } | null = null;
  let fired = false;
  let done = false;

  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    down(x, y) {
      if (origin) return false;
      origin = { x, y };
      fired = false;
      done = false;
      timer = setTimeout(() => {
        timer = null;
        if (done) return;
        fired = true;
        opts.onHold();
      }, threshold);
      return true;
    },
    move(x, y) {
      // 已经进入"按住说话"之后，位移不再作废手势：他正在说话，而布局会自己把按钮/输入框挪位置
      // （状态条出现、输入框长高）。真正把录音交给浏览器原生行为的是**按下到开火之前**这一段。
      if (fired) return;
      if (!origin || done) return;
      if (Math.hypot(x - origin.x, y - origin.y) <= tol) return;
      // 漂出阈值 = 他在拖选。放弃本次手势，别去碰录音，也别拦浏览器。
      clear();
      done = true;
      origin = null;
    },
    up() {
      const wasHolding = fired;
      const wasDone = done;
      clear();
      origin = null;
      fired = false;
      if (wasDone) return null;
      done = true;
      // 长按已触发 → 松手就是「我说完了」；否则这是一次普通点击，交给调用方的原有行为。
      return wasHolding ? "hold" : "tap";
    },
    cancel() {
      clear();
      origin = null;
      fired = false;
      done = true;
    },
    holding() {
      return fired && !done;
    },
    pending() {
      return origin !== null;
    },
  };
}

/** 一次性提示的键（「按住这里说话」只该在第一次真正用上听写时出现一次）。 */
export const HOLD_HINT_KEY = "agentus.hint.hold-to-talk";

/** 桌面端才补「在输入框里长按鼠标左键」那句 —— 手机上那条路不存在，许诺它就是骗人。 */
export function finePointer(): boolean {
  try {
    return typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches;
  } catch {
    return false;
  }
}

export function holdHintText(desktop: boolean): string {
  return desktop
    ? "想更快？按住麦克风说话，松手就落字；在输入框里长按鼠标左键也行"
    : "想更快？按住麦克风说话，松手就落字";
}
