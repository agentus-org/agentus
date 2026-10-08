/** What the head's turn dot is saying, and what it is called.
 *
 *  Agentus used to put the turn's state at the transcript tail as two text lines (`▸ turn in
 *  progress…`, then `⏳ still waiting for the agent…`). The operator deleted them — 「太占地方了…
 *  下面的按钮显示终止态其实就能看出来在运行」 — and he is right about "is a turn running": the
 *  composer's stop button says it, and streaming output animates by itself.
 *
 *  The half worth keeping is the QUIET turn: a long tool call or a stalled agent looks exactly like a
 *  finished one, and that is the failure the operator has reported more than once. It lives on now as
 *  a breathing dot beside the session title — no row, no height — going amber with the numbers in the
 *  tooltip.
 *
 *  The decision is a pure function of two stamps, for the same reason `time.ts` takes an explicit
 *  `now`: the 60-second boundary cannot be waited for inside a browser sweep, so the boundary is
 *  asserted here (scripts/qa/turn-pulse.mts) and the browser sweep only checks that the dot is drawn.
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

/** "45 秒" / "1 分 30 秒" — the operator reads a duration, not a timestamp. */
function gapWords(ms: number): string {
  const secs = Math.round(ms / 1000);
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
      ? `agent 已经 ${gapWords(gapMs)} 没有输出了 —— 回合还在跑，可以点下面的停止`
      : "agent 正在工作（有输出就会重置这个计时）",
  };
}
