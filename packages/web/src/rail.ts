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
 *  · the group holding the ACTIVE session shows everything: hiding the conversation you are working
 *    in — or a session with an approval waiting in it — behind a click is not a convenience;
 *  · an unrolled group shows everything (that is what the click bought);
 *  · otherwise the newest `limit` are shown, and the count that is left is returned for the label.
 *
 * The caller passes items already sorted newest-first — a group is ordered once, for the sort, and
 * this rule must not disagree with what is on screen.
 */
export function splitRecent<T>(
  items: readonly T[],
  opts: { limit?: number; searching?: boolean; holdsActive?: boolean; expanded?: boolean } = {},
): { shown: T[]; hidden: number } {
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? RAIL_RECENT)));
  const all = [...items];
  if (opts.searching || opts.holdsActive || opts.expanded || all.length <= limit) {
    return { shown: all, hidden: 0 };
  }
  return { shown: all.slice(0, limit), hidden: all.length - limit };
}
