/** The two places a turn announces itself, and the words they use.
 *
 *  Where the turn's state lives is a decision the operator made in two steps, and he was right both
 *  times. First he deleted the transcript's two static lines (`▸ turn in progress…`, then
 *  `⏳ still waiting for the agent…`) — 「太占地方了…下面的按钮显示终止态其实就能看出来在运行」: "is a turn
 *  running" is already said by the composer's stop button and by the output itself animating. The half
 *  worth keeping is the QUIET turn (a long tool call or a stalled agent looks exactly like a finished
 *  one), and that half went to a zero-height breathing dot beside the session title.
 *
 *  Then he asked for the reference implementations' shape — studio's `LiveReasoningStatus.vue` and
 *  AionUi's `ThoughtDisplay.tsx` both carry a spinner, a word, and ONE NUMBER we had nowhere: the
 *  elapsed time. So the tail gets a single line back (`处理中 (1 分 30 秒)`), counted from the send,
 *  and the head keeps the dot as the pinned marker for a reader who has scrolled away from the tail.
 *
 *  Every decision below is a pure function of two stamps, for the same reason `time.ts` takes an
 *  explicit `now`: a 60-second boundary cannot be waited for inside a browser sweep, so the boundary
 *  is asserted here (scripts/qa/turn-pulse.mts) and the browser sweeps only check what got DRAWN.
 */

/** How long the agent may be quiet before the dot stops saying 「在跑」 and starts saying 「安静很久」.
 *  A Hermes turn routinely spends tens of seconds inside a single tool call, so anything much below a
 *  minute would turn every normal turn amber. (The deleted line fired at 5s — its code comment
 *  claimed 3 minutes.) */
export const SILENT_AFTER_MS = 60_000;

export interface TurnPulseState {
  /** green + breathing = output is flowing; amber + slower = the agent has gone quiet */
  quiet: boolean;
  /** ms since the last thing the agent produced (never negative: a clock skew is not a negative wait) */
  gapMs: number;
  /** the tooltip / aria text — the dot itself has no words */
  said: string;
}

/** "45 秒" / "1 分 30 秒" — the operator reads a duration, not a timestamp. Clamped at zero: a clock
 *  that jumped backwards is not a negative wait. Used by BOTH indicators, because one number stated
 *  two ways (「已静默 45 秒」 at the head, 「处理中 (45 秒)」 at the tail) must not be worded twice. */
export function durationWords(ms: number): string {
  const secs = Math.round(Math.max(0, ms) / 1000);
  if (secs < 60) return `${secs} 秒`;
  return `${Math.floor(secs / 60)} 分 ${secs % 60} 秒`;
}

export function turnPulseState(lastAt: number, now: number): TurnPulseState {
  const gapMs = Math.max(0, now - lastAt);
  const quiet = gapMs >= SILENT_AFTER_MS;
  return {
    quiet,
    gapMs,
    said: quiet
      ? `agent 已经 ${durationWords(gapMs)} 没有输出了 —— 回合还在跑，可以点下面的停止`
      : "agent 正在工作（有输出就会重置这个计时）",
  };
}
