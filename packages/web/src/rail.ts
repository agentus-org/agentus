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
  opts: { limit?: number; searching?: boolean; expanded?: boolean; isActive?: (item: T) => boolean } = {},
): { shown: T[]; hidden: number } {
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? RAIL_RECENT)));
  const all = [...items];
  if (opts.searching || opts.expanded || all.length <= limit) {
    return { shown: all, hidden: 0 };
  }
  const shown = all.slice(0, limit);
  // The conversation the operator is IN stays on screen: it is the one row whose absence would lose
  // work rather than save space, and the rail highlights it — dropping it would leave the open session
  // with no row pointing at it. Pin it in place of the OLDEST shown row, so the count stays `limit`
  // instead of growing by one.
  if (opts.isActive) {
    const at = all.findIndex((x) => opts.isActive!(x));
    if (at >= limit) shown[shown.length - 1] = all[at];
  }
  return { shown, hidden: all.length - shown.length };
}
