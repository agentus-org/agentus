/** Wall-clock stamps, for the transcript and for the rail.
 *
 * The operator asked for two different things in one breath: on a MESSAGE he wants to know
 * 「什么时候发的、什么时候回复的」 (a fact about that line), and on a SESSION ROW he wants
 * 「如果是几天前的就显示日期，当天的就显示时间，或者几分钟前，比较智能那种」 (a sorting aid).
 * So there are two shapes here, and they are deliberately not the same function:
 *
 *   - `messageTime` never goes vaguer than the minute, and once a message is not from today it
 *     says WHICH day it was — a relative "3 分钟前" on a line you scroll past later would be a
 *     lie that rewrites itself as you read.
 *   - `relTime` is the relative, self-refreshing shape the rail wants.
 *
 * Both take an explicit `now` so the boundary cases (midnight, DST, a week ago) are testable
 * instead of being whatever the clock says while a sweep runs. Hand-rolled on purpose: two
 * formats do not justify a date library in the bundle, and these are three-line functions.
 */

const pad = (n: number): string => String(n).padStart(2, "0");
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** "14:32" — 24h time of day. The operator reads this next to a log, not a wristwatch. */
export function clockHM(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "2026-10-06 14:32" — the absolute instant, for `title=` attributes. Nothing in the UI should
 *  show only a fuzzy time: the exact stamp is always one hover away. */
export function stamp(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clockHM(ts)}`;
}

/** Same calendar day? (local time — "today" is the operator's today, not UTC's) */
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Whole days between two instants, by calendar date (so 23:59 → 00:01 counts as 1 day). */
function dayGap(ts: number, now: number): number {
  const a = new Date(ts);
  const b = new Date(now);
  const midnightA = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const midnightB = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.round((midnightB - midnightA) / 86_400_000);
}

/** A message's own time: "14:32" · "昨天 14:32" · "10月3日 14:32" · "2025-12-31 14:32".
 *  Shown on hover (desktop) / always-dim on touch; the full stamp rides in the `title`. */
export function messageTime(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const gap = dayGap(ts, now);
  if (gap <= 0) return clockHM(ts); // today (a future clock skew reads as today)
  if (gap === 1) return `昨天 ${clockHM(ts)}`;
  if (d.getFullYear() === new Date(now).getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${clockHM(ts)}`;
  return stamp(ts);
}

/** How long ago, for a session row: "刚刚" · "12 分钟前" · "14:32" · "昨天" · "周三" ·
 *  "10月3日" · "2025-12-31". Coarser than `messageTime` on purpose: a rail is scanned, not read. */
export function relTime(ts: number, now: number = Date.now()): string {
  const secs = Math.floor((now - ts) / 1000);
  if (secs < 0) return clockHM(ts); // clock skew: never say "in -3 minutes"
  if (secs < 45) return "刚刚";
  if (secs < 3600) return `${Math.max(1, Math.floor(secs / 60))} 分钟前`;
  const d = new Date(ts);
  const gap = dayGap(ts, now);
  if (gap <= 0) return clockHM(ts);
  if (gap === 1) return "昨天";
  if (gap < 7) return WEEKDAYS[d.getDay()];
  if (d.getFullYear() === new Date(now).getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
