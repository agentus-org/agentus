/**
 * The rail's own rule: a workspace group shows its newest few sessions, everything else is one click
 * away. In its own module because the rule is the thing being tested (`scripts/qa/rail-recent.mts`
 * drives it without a DOM), the same reason studio keeps `partitionRecentSessions` apart from the
 * component that renders it.
 */

/** How many sessions a workspace group shows before the rest go behind 「展开其余 N 条」. Five is the
 *  number the operator asked for: enough that the work you are doing right now is all there, few
 *  enough that four projects still fit on one screen. */
export const RAIL_RECENT = 5;

/**
 * Split one group into what is visible and how much is hidden.
 *
 * Rules, in order — and each one is a case where hiding a row costs the operator something real:
 *  · a search shows every match (that view claims to have found them);
 *  · an unrolled group shows everything (that is what the click bought);
 *  · otherwise the newest `limit` are shown, and the count that is left is returned for the label.
 *
 * The group holding the ACTIVE session does NOT get a pass any more (it used to): a workspace with
 * twelve sessions was the one place the rail refused to fold, which is where folding was wanted most
 * (operator, 2026-10-08). Instead the active row is KEPT INSIDE the limit — see `isActive` below — so
 * the count never grows past `limit` while the conversation you are in can never be hidden.
 *
 * The caller passes items already sorted newest-first — a group is ordered once, for the sort, and
 * this rule must not disagree with what is on screen.
 */
export function splitRecent<T>(
  items: readonly T[],
  opts: {
    limit?: number;
    searching?: boolean;
    expanded?: boolean;
    isActive?: (item: T) => boolean;
    /**
     * Rows that must stay on screen even when they are older than the newest `limit`.
     *
     * The rail is where a waiting approval is ANNOUNCED (`⚿ N` on the row, and the row is what the
     * operator clicks to get to it), so folding such a row away does not hide a list item — it hides
     * a request. The dialog does not cover for it either: it only ever draws the ACTIVE session's
     * request. Measured 2026-10-11: a workspace with more than five sessions could hold an approval
     * the rail never showed, and nothing else in the cockpit would say so.
     */
    mustShow?: (item: T) => boolean;
  } = {},
): { shown: T[]; hidden: number } {
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? RAIL_RECENT)));
  const all = [...items];
  if (opts.searching || opts.expanded || all.length <= limit) {
    return { shown: all, hidden: 0 };
  }
  const shown = all.slice(0, limit);
  const keep = (x: T): boolean => Boolean(opts.isActive?.(x) || opts.mustShow?.(x));
  // A row that must stay and is already among the newest `limit` needs nothing (the ordinary case:
  // the request is in the conversation you are working in).
  const kept = all.slice(limit).filter(keep);
  if (!kept.length) return { shown, hidden: all.length - shown.length };
  // Pin each one in the place of the OLDEST shown rows, so the count stays `limit` for the ordinary
  // case of one or two: the conversation the operator is IN — its absence loses work, and the rail
  // highlights it — and any row with an approval waiting. Relative order is kept (both lists are
  // newest-first), so the fold still reads as one newest-first column.
  const drop = Math.max(0, Math.min(shown.length, kept.length));
  const next = [...shown.slice(0, shown.length - drop), ...kept];
  // More must-keep rows than the limit is the one case where the limit YIELDS: a hidden approval is a
  // request nobody answers, which costs more than the folding was saving.
  return { shown: next, hidden: all.length - next.length };
}
