/** Paging for the COLD session list — the rows that exist on disk with no process behind them.
 *
 *  Issue #34: the page used to be ONE global top-N by `lastAt`. Every consumer (rail grouping, the
 *  rail's 展开其余 counter, search, `cockpit session list --workspace`) then treated that page as the
 *  complete set, so the busiest workspace ate the whole page and every other workspace's cold
 *  sessions vanished. It is not a cosmetic loss: a cold row is the ONLY handle that can wake that
 *  session, so "not in the page" means "unreachable from the UI, even though the transcript is fine".
 *
 *  The intent behind the old cap is still real — crash debris accumulates without anyone choosing it
 *  — so it is kept, but moved to the right axis: **N per workspace** (the same axis the rail already
 *  groups by) plus a much larger total ceiling as the anti-bloat backstop.
 *
 *  Pure on purpose: the caller decides which rows EXIST (the cockpit's own scope rule), this decides
 *  which of them survive the page. That way the rule is tested without a server or a browser. */

import type { SessionInfo } from "@agentus/shared";

/** How many cold rows a single workspace keeps by default. The rail shows `RAIL_RECENT` (5) before
 *  「展开其余」, so 20 is the expand depth, not the visible depth. */
export const COLD_PER_WORKSPACE = 20;

/** Hard ceiling across all workspaces. Chosen to be far above any real installation's workspace
 *  count × 20 while still bounding what a crash-storm can push into one WS frame. */
export const COLD_TOTAL_MAX = 400;

/** The cockpit CLI asks for a deeper page than the rail: an agent asking "what is going on in this
 *  workspace" is not browsing, and it filters by `--workspace` on top. */
export const COLD_PER_WORKSPACE_COCKPIT = 50;

export interface ColdPage<T> {
  /** Newest-first, at most `perWorkspace` per workspace and `totalMax` overall. */
  rows: T[];
  /** How many cold rows existed before paging — so a caller can tell an empty cockpit from a
   *  truncated one. */
  total: number;
  /** `total - rows.length`: the rows this page left out. Non-zero means "this is a partial view". */
  omitted: number;
}

/** Which bucket a cold row belongs to: the workspace the operator sees in the rail, falling back to
 *  the cwd exactly like `sessionRow()` does — the two must not disagree, or a row would be paged by
 *  one key and displayed under another. */
export function coldKeyOf(row: Pick<SessionInfo, "workspace" | "cwd">): string {
  return row.workspace || row.cwd || "/";
}

/** Sort rule shared with `list()`: recent activity first, ties broken by creation. */
export function byActivity(a: Pick<SessionInfo, "lastAt" | "createdAt">, b: Pick<SessionInfo, "lastAt" | "createdAt">): number {
  return (b.lastAt ?? 0) - (a.lastAt ?? 0) || b.createdAt - a.createdAt;
}

/**
 * Bucket-aware cold paging.
 *
 * `sorted` must already be in the caller's display order (newest first). Each workspace keeps the
 * first `perWorkspace` rows of that order; the survivors are merged and re-sorted so the overall list
 * still reads newest-first, then cut at `totalMax` only if the merge exceeds it.
 */
export function coldPage<T extends Pick<SessionInfo, "workspace" | "cwd" | "lastAt" | "createdAt">>(
  sorted: readonly T[],
  perWorkspace: number = COLD_PER_WORKSPACE,
  totalMax: number = COLD_TOTAL_MAX,
): ColdPage<T> {
  const total = sorted.length;
  const per = Math.max(1, Math.floor(perWorkspace));
  const cap = Math.max(per, Math.floor(totalMax));

  const buckets = new Map<string, T[]>();
  for (const row of sorted) {
    const key = coldKeyOf(row);
    const bucket = buckets.get(key);
    if (!bucket) buckets.set(key, [row]);
    else if (bucket.length < per) bucket.push(row);
    // else: this workspace already has its page — the rest of its rows are the ones we omit
  }

  const kept: T[] = [];
  for (const bucket of buckets.values()) kept.push(...bucket);
  kept.sort(byActivity);
  const rows = kept.length > cap ? kept.slice(0, cap) : kept;
  return { rows, total, omitted: total - rows.length };
}
