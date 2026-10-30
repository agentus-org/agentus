// The pane registry — ONE table that decides which panes exist, which are usable right now, and
// where their entry points live. Both the workspace panel (ToolPanel.tsx) and the head
// (App.tsx) read from here, so adding a pane means adding an entry, not editing two components
// (#78 §1, #80 §1).
//
// Two things this file deliberately does NOT own: the JSX for each pane's body (ToolPanel renders
// it) and the split geometry (the pair, the ratio, the divider — ToolPanel's business). What lives
// here is the fact-shaped part: an id, a label, an availability test, and whether the pane gets a
// button in the head outside the panel.
import { useEffect, useState } from "react";
import { cockpit } from "./state";

/** What /api/ide/status answers (server: packages/server/src/ide/proxy.ts). `start` is the command
 *  the tab prints when the upstream is configured but not up — the failure mode this feature is
 *  most likely to hit, and one that shows up as an empty iframe unless it is said out loud. */
export interface IdeStatus {
  configured: boolean;
  reachable: boolean;
  base: string | null;
  prefix: string;
  start: string;
}

export type PaneId = "terminal" | "ide";
export type ViewTab = "files" | PaneId;

export interface PaneSpec {
  id: PaneId;
  label: string;
  /** Is this pane something the operator can use on THIS machine right now? A pane that is not
   *  available gets no tab, cannot enter a pair, and is pruned out of a stored pair (#78 §4:
   *  别留死框). */
  available: (ide: IdeStatus | null) => boolean;
  /** #80 §1: on a wide window this pane also gets its own button in the head, beside the file
   *  browser's — 「终端和 IDE 不是浏览工作区，是两个独立的工具窗口」, and reaching them through
   *  panel-then-tab costs two clicks for something the operator opens all day. On a phone the head
   *  has no room, so the tab bar stays the only door there (phones never split either). */
  headEntry: boolean;
}

export const PANES: PaneSpec[] = [
  { id: "terminal", label: "terminal", available: () => true, headEntry: true },
  { id: "ide", label: "ide", available: (ide) => Boolean(ide?.configured), headEntry: true },
];

/** Desktop or phone? The split and the head entry points are WIDE-window affordances and nothing
 *  else: a phone sheet shows one pane at a time (≤720px rules), so the media query IS the rule —
 *  not a width we measure ourselves, which would drift from the CSS the moment the breakpoint
 *  moved. */
export function useWide(): boolean {
  const [wide, setWide] = useState<boolean>(() =>
    typeof window !== "undefined" && window.matchMedia("(min-width: 721px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 721px)");
    const on = (): void => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

/** The IDE status, asked once per session and re-asked when the workspace moves (the answer carries
 *  the upstream URL, not the folder, but the panel that shows it re-roots with the workspace, so
 *  one request here keeps the head's buttons in step with the panel's tab).
 *
 *  It lives in the head's owner (App.Main) rather than in the panel because the head needs the same
 *  answer to decide whether the `ide` button exists at all — two components asking would be two
 *  requests for one fact. A failed call is "no IDE", not an error banner: the panel's other panes
 *  are unaffected, and the operator asked to see files, not a health probe. */
export function useIdeStatus(sessionId: string, root: string): IdeStatus | null {
  const [ide, setIde] = useState<IdeStatus | null>(null);
  useEffect(() => {
    let alive = true;
    setIde(null);
    cockpit.ideStatus()
      .then((s) => { if (alive) setIde(s); })
      .catch(() => { if (alive) setIde(null); });
    return () => { alive = false; };
  }, [sessionId, root]);
  return ide;
}
