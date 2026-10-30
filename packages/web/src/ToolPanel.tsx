// The workspace panel behind the head's ▤ button: a file browser, a preview/editor and a
// terminal, all rooted in the slot's workspace.
//
// Studio study (hermes-studio's FilesPanel/TerminalPanel) settled two questions:
//  * one panel with tabs, not two floating drawers — the head has room for exactly
//    one toggle, and "files or shell" is a choice the operator makes once;
//  * the panel is rooted at the *session workspace*, so switching slots switches the
//    tree (their `activeWorkspacePath`), which is why workspace is a field on the
//    slot rather than a global setting.
// What we did not copy, and then did: their tree does lazy loading with an expanded-path cache
// and a per-file editor with dirty tracking. We deliberately skipped the editor ("writing files
// is the agent's job"), and the operator overruled that on 2026-10-09 — so the preview pane
// (FilePreview.tsx) now renders per file type and can save, with the conflict rule that makes
// an editor safe next to an agent: see writeTextFile in packages/server/src/fs.ts.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { SessionView } from "./state";
import { cockpit } from "./state";
import { FilePreviewPane } from "./FilePreview";
import { useEscape } from "./useDismiss";
import { usePaneHeight, usePaneWidth } from "./paneWidth";
import { ansi16, ansiExtended } from "./terminalPalette";
import { resolveDark, themeConfig, useResolvedDark } from "./theme";
import {
  IconArrowLeft, IconChevronRight, IconClose, IconFile, IconFolder, IconHome,
  IconCode, IconPanelLeft, IconPanelRight, IconPlus, IconRefresh, IconSplitRows, IconSwap, IconTerminal,
} from "./Icons";

interface Entry {
  name: string;
  path: string;
  kind: "dir" | "file";
  size?: number;
}

interface Listing {
  path: string;
  parent: string | null;
  home: string;
  entries: Entry[];
  truncated: boolean;
  root?: string | null;
}

/** A file the panel should open — set by a click in the tree, or pushed in from elsewhere
 *  (a file link inside a reply: see fileBus.ts). */
export interface PanelTarget {
  path: string;
  line?: number;
}

/** What /api/ide/status answers (server: packages/server/src/ide/proxy.ts). `start` is the command
 *  the tab prints when the upstream is configured but not up — the failure mode this whole feature
 *  is most likely to hit, and one that shows up as an empty iframe unless it is said out loud. */
interface IdeStatus {
  configured: boolean;
  reachable: boolean;
  base: string | null;
  prefix: string;
  start: string;
}

/** The preview column's floor: the tree may not eat below this, or the file being read becomes a
 *  letterbox (the operator's original complaint about the preview's size). */
const PREVIEW_MIN = 300;

/* The two column-fold switches (see the state below). Their names say which key holds which. */
const FOLD_TREE_KEY = "agentus.panel-tree-folded";
const FOLD_PREVIEW_KEY = "agentus.panel-preview-folded";
/* Desktop split (2026-10-30): the IDE above, the terminal below, both alive at once. Two remembered
 * facts, both layout preferences like the widths and folds beside them: whether the split is on, and
 * which of the two panes is the top one. */
const PAIR_KEY = "agentus.panel-pair";
// 0.15.10 stored the split as two booleans (splitOn + ideOnTop) and one global ratio. #78's pair
// model replaces all three; `readPair`/`readRatio` migrate the old values once so an operator who
// had IDE-on-top keeps IDE-on-top after the upgrade.
const SPLIT_KEY = "agentus.panel-split";
const SPLIT_IDE_TOP_KEY = "agentus.panel-split-ide-top";
const RATIO_KEY = "agentus.panel-split-ratio";

/** The pane registry (issue #78). The tab bar and the split are BOTH built from this array, so
 *  adding a pane — a box desktop, a preview — is one entry here plus one branch in the row
 *  renderer, and the split core never changes again. `files` stays out on purpose: it is a column
 *  layout (tree | preview), not a row — a 50%-tall file browser is not a pane, it is a shrunk one. */
interface PaneSpec {
  id: PaneId;
  label: string;
  /** Is this pane something the operator can use on THIS machine right now? A pane that is not
   *  available gets no tab, cannot enter a pair, and is pruned out of a stored pair (#78 §4:
   *  别留死框). */
  available: (ide: IdeStatus | null) => boolean;
}
type PaneId = "terminal" | "ide";
type ViewTab = "files" | PaneId;

const PANES: PaneSpec[] = [
  { id: "terminal", label: "terminal", available: () => true },
  { id: "ide", label: "ide", available: (ide) => Boolean(ide?.configured) },
];

/** Which pane sits where: [top, bottom] or null = no split. One JSON value, one write path —
 *  the two booleans of 0.15.10 could disagree with each other (`splitOn` true while `tab` was
 *  "files"), this shape cannot. */
function writePair(pair: PaneId[] | null): void {
  try {
    if (pair === null) localStorage.removeItem(PAIR_KEY);
    else localStorage.setItem(PAIR_KEY, JSON.stringify(pair));
  } catch { /* private mode: the layout still applies for this session */ }
}

function readPair(): PaneId[] | null {
  try {
    const raw = localStorage.getItem(PAIR_KEY);
    if (raw !== null) {
      const p = JSON.parse(raw);
      return Array.isArray(p) && p.length === 2 && p[0] !== p[1] ? p : null;
    }
    // migration: splitOn + ideOnTop → a pair over the only two panes that ever split. The migrated
    // value is WRITTEN back, not just returned: a read that keeps deriving would move the ratio's
    // key under the hook the first time availability flips (livePair null → key = the global one →
    // hook re-reads → the migrated height evaporates; measured in QA).
    if (localStorage.getItem(SPLIT_KEY) !== null) {
      const on = localStorage.getItem(SPLIT_KEY) === "1";
      const migrated: PaneId[] | null = on
        ? (localStorage.getItem(SPLIT_IDE_TOP_KEY) === "0" ? ["terminal", "ide"] : ["ide", "terminal"])
        : null;
      if (migrated) writePair(migrated);
      // …and the global ratio into the pair's key, same one-time move
      const oldRatio = localStorage.getItem(RATIO_KEY);
      if (migrated && oldRatio !== null) {
        const key = `${RATIO_KEY}:${[...migrated].sort().join("+")}`;
        if (localStorage.getItem(key) === null) localStorage.setItem(key, oldRatio);
      }
      localStorage.removeItem(SPLIT_KEY);
      localStorage.removeItem(SPLIT_IDE_TOP_KEY);
      return migrated;
    }
  } catch { /* private mode / a hand-edited value — defaults are correct */ }
  return null;
}

/** The top row's height, PER PAIR (#78 §2: 从「IDE+终端」切到「桌面+IDE」不能沿用上一个组合的高度).
 *  Keyed by the SORTED pair, so swapping which pane is on top keeps the ratio — the heights belong
 *  to the combination, the order is a separate preference. */
function readRatio(pair: string[] | null): number | null {
  if (!pair) return null;
  try {
    const key = `${RATIO_KEY}:${[...pair].sort().join("+")}`;
    const raw = localStorage.getItem(key);
    const n = raw === null ? Number.NaN : Number.parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

/** A remembered on/off layout flag. Private mode has no localStorage, so folding then simply does
 *  not stick — same `try` shape as `usePaneWidth` beside it. */
function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : raw === "1";
  } catch { return fallback; }
}
function writeFlag(key: string, on: boolean): void {
  try { localStorage.setItem(key, on ? "1" : "0"); } catch { /* private mode */ }
}

/** Desktop or phone? The split is a WIDE-window affordance and nothing else: a phone sheet shows one
 *  pane at a time (≤720px rules), so the media query IS the rule — not a width we measure ourselves,
 *  which would drift from the CSS the moment the breakpoint moved. */
function useWide(): boolean {
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

function humanSize(bytes?: number): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function ToolPanel({ v, onClose, onPickWorkspace, focus, panelWidth, panelHandle }: {
  v: SessionView;
  onClose: () => void;
  onPickWorkspace: () => void;
  /** a file pushed in from outside the panel (a link in a reply); the panel opens on it */
  focus?: PanelTarget | null;
  /** the panel's own (resizable, persisted) width, and its handle — rendered on the LEFT edge,
   *  where it meets the chat column (`paneWidth.tsx`). */
  panelWidth: number;
  panelHandle: JSX.Element;
}): JSX.Element {
  // on a phone this panel is a full-screen sheet, so Escape is the keyboard way out
  useEscape(typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches, onClose);
  const [tab, setTab] = useState<ViewTab>("files");
  const root = v.info.workspace || v.info.cwd;
  const [path, setPath] = useState(root);
  // The tree keeps its own column next to the preview instead of splitting the panel vertically:
  // the operator's complaint was 「文件预览只有一半的空间，太小了吧」 — and the reference splits the
  // row, not the column (AionUi partitions it as chat | preview | explorer, `ProjectPanelHost.tsx`).
  // Only the explorer's width is stored here; the preview takes whatever is left.
  const explorer = usePaneWidth({
    storage: "agentus.explorer-width",
    fallback: 300,
    min: 220,
    max: () => Math.max(220, Math.min(460, panelWidth - PREVIEW_MIN)),
    rightEdge: false,
    label: "resize the file tree",
  });
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [target, setTarget] = useState<PanelTarget | null>(null);
  const [loading, setLoading] = useState(false);
  /* Each column folds on its own — the reference does (AionUi's ProjectPanelHost dismisses the
   * explorer and the preview independently), and before this the only way to give the preview the
   * full panel was to drag the tree down to its 220px floor, which still left it on screen.
   *
   * Remembered in localStorage exactly like the panel width and the explorer width beside it:
   * folding is a LAYOUT preference (one choice, the same in every session), not a per-file one.
   * They cannot BOTH be down — the panel would be an empty box with nothing on screen offering a
   * way back — so folding one unfolds the other. */
  /* Web IDE (issue #77). The status is asked ONCE per panel open, not per tab switch: the answer
   *  changes only when the operator starts or stops code-server, and polling it would be a request
   *  every few seconds for a fact that is almost always the same. `configured` decides whether the
   *  tab exists at all; `reachable` decides whether it opens an editor or explains itself. */
  const [ide0, setIde0] = useState<IdeStatus | null>(null);
  /* The split is a preference, the same in every session (like the widths), and it is only OFFERED
   * when there is something to split with — a phantom toggle is worse than none. */
  const wide = useWide();
  const [pair, setPair] = useState<PaneId[] | null>(() => readPair());
  /* #78 §4: a pane that stops being available (IDE upstream unset later, or a status that never
   * arrives) is PRUNED from the pair — and a one-pane pair is no split at all. No dead frames,
   * no phantom halves. */
  const avail = (id: string): boolean => PANES.find((x) => x.id === id)?.available(ide0) ?? false;
  const livePair: PaneId[] | null = pair && pair.every(avail) ? pair : null;
  /* In split mode both panes are on screen, so the tab buttons mean "which one is on top"; `files`
   * leaves the split (it is a column layout, not a row). A phone never splits. */
  const splitActive = wide && Boolean(livePair) && tab !== "files";
  /* Reopening the panel lands on the operator's mode, not on `files`: the pair is a layout
   * preference that outlives the tab. Runs ONCE per panel mount, after the IDE status arrives (that
   * status is what makes a stored `ide` pane available at all). */
  const [pairRestored, setPairRestored] = useState(false);
  useEffect(() => {
    if (pairRestored || ide0 === null) return;
    setPairRestored(true);
    if (livePair && tab === "files") setTab(livePair[0]);
  }, [ide0, livePair, tab, pairRestored]);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const ratioStorage = livePair
    ? `${RATIO_KEY}:${[...livePair].sort().join("+")}`
    : RATIO_KEY;
  /* readRatio takes the pair; the hook's own `storage` key already carries it. The fallback covers
   * the one-time migration from the 0.15.10 global key. */
  const rows = usePaneHeight({
    storage: ratioStorage,
    fallbackPx: readRatio(livePair),
    label: "resize the stacked panes",
    min: 96,
    containerPx: () => stackRef.current?.getBoundingClientRect().height ?? 0,
  });
  /* ONE rule for both rows, stated once: the TOP row carries the divider's height, the BOTTOM row takes
   * whatever is left. Writing it per-pane is how a swap ends up with two fixed rows and an overflow
   * (measured: 363px + 363px in a 600px panel, the lower pane clipped).
   *
   * ORDERS ARE INTEGERS, and that is load-bearing (#78): CSS `order` parses as <integer>, so the
   * 1.5 we shipped for the divider in 0.15.10 was a DISCARDED declaration — the divider fell back to
   * order:0 and painted at the TOP of the panel, above both panes. It still dragged, which is why no
   * test that only checks "is the divider present" caught it. 1 / 2 / 3 it is; a test asserts the
   * divider sits BETWEEN the panes geometrically, not by class name. */
  const rowStyle = (isTop: boolean) => (isTop
    ? { order: 1, flex: "0 0 auto", height: `${rows.height}px` }
    : { order: 3, flex: "1 1 0", height: "auto" });
  const dividerStyle = { order: 2 } as CSSProperties;

  /* Tab click (issue #78 §3): put me on top. Already on top: nothing moves. In the pair below:
   * swap. Not in the pair: I take the top slot and the old top becomes the bottom. Turning the
   * split ON with no stored pair seeds [this, the first other available pane]. */
  const chooseTool = (id: PaneId): void => {
    setTab(id);
    const others = PANES.filter((x) => x.id !== id && x.available(ide0)).map((x) => x.id);
    if (!splitActive) {
      // turning the split ON from a pane's tab puts THAT pane on top — the click said what it meant
      if (wide && others.length) { const next: PaneId[] = [id, others[0] as PaneId]; setPair(next); writePair(next); }
      return;
    }
    const live = livePair as PaneId[];
    if (live[0] === id) return;   // already the top row — a no-op, not a shake
    // #78 §3: in the bottom row it swaps; not in the pair at all it takes the top slot and the old
    // top slides down. Same result either way — which is why there is no branch here.
    const next: PaneId[] = [id, live[0]];
    setPair(next);
    writePair(next);
  };
  const swapPanes = (): void => {
    if (!livePair) return;
    const next = [livePair[1], livePair[0]];
    setPair(next);
    writePair(next);
  };
  const toggleSplit = (): void => {
    if (livePair) {
      setPair(null);
      writePair(null);
      // closing the split shows the pane that WAS on top, not whatever the tab says
      setTab((t) => (t === "files" ? "terminal" : t));
      return;
    }
    // The seed is DETERMINISTIC, not "whatever tab you happened to be on": IDE on top, terminal
    // below — the shape 0.15.10 documented, and the one a first-time operator can predict from the
    // docs. With only one pane available there is no pair to seed.
    const ids = PANES.filter((x) => x.available(ide0)).map((x) => x.id);
    if (!wide || ids.length < 2) return;   // nothing to split with — no phantom toggle
    const first: PaneId = ids.includes("ide") ? "ide" : ids[0];
    const second = (first === "ide" ? "terminal" : "ide") as PaneId;
    const next: PaneId[] = [first, second];
    setPair(next);
    writePair(next);
    setTab(first);
  };
  const [treeFolded, setTreeFolded] = useState<boolean>(() => readFlag(FOLD_TREE_KEY, false));
  const [previewFolded, setPreviewFolded] = useState<boolean>(() => readFlag(FOLD_PREVIEW_KEY, false));

  const foldTree = (next?: boolean): void => {
    const v0 = next ?? !treeFolded;
    setTreeFolded(v0);
    writeFlag(FOLD_TREE_KEY, v0);
    if (v0 && previewFolded) { setPreviewFolded(false); writeFlag(FOLD_PREVIEW_KEY, false); }
  };
  const foldPreview = (next?: boolean): void => {
    const v0 = next ?? !previewFolded;
    setPreviewFolded(v0);
    writeFlag(FOLD_PREVIEW_KEY, v0);
    if (v0 && treeFolded) { setTreeFolded(false); writeFlag(FOLD_TREE_KEY, false); }
  };

  // Switching slots re-roots the panel: the tree belongs to the slot's workspace.
  useEffect(() => {
    setPath(root);
    setTarget(null);
  }, [root, v.info.id]);

  // A file link clicked in a reply: show the files tab, follow the browser to that file's
  // directory, and open it. Separate from the click path above because the operator may be
  // looking at the terminal tab when the click lands.
  useEffect(() => {
    if (!focus) return;
    setTab("files");
    setTarget(focus);
    foldPreview(false);
    const dir = focus.path.replace(/\/[^/]*$/, "") || "/";
    setPath(dir);
  }, [focus]);

  // One status call per panel open. A failed call is "no IDE" rather than an error banner: the
  // panel's other two tabs are unaffected, and the operator asked to see files, not a health probe.
  useEffect(() => {
    let alive = true;
    cockpit.ideStatus()
      .then((s) => { if (alive) setIde0(s); })
      .catch(() => { if (alive) setIde0(null); });
    return () => { alive = false; };
  }, []);

  /* A mount latch PER PANE, driven by the pair: a pane that is in the pair (either row) or is the
   * shown tab has been mounted at least once, and afterwards it is only ever HIDDEN. Re-mounting the
   * iframe reloads code-server's whole front end; re-mounting the terminal opens a NEW pty (scrollback
   * gone, `cd` gone) — #77's rule, generalised: it now covers every pane the split can hold. */
  const [mounted, setMounted] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const needed: string[] = [...(livePair ?? []), ...(tab !== "files" ? [tab] : [])].filter((id) => !mounted[id]);
    if (needed.length) setMounted((m) => ({ ...m, ...Object.fromEntries(needed.map((id) => [id, true])) }));
  }, [livePair, tab, mounted]);

  const load = useCallback(async (target0: string) => {
    setLoading(true);
    setError("");
    try {
      const data = await cockpit.listEntries(target0);
      setListing(data);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(path); }, [path, load]);

  const open = (entry: Entry): void => {
    if (entry.kind === "dir") {
      setPath(entry.path);
      setTarget(null);
      return;
    }
    setTarget({ path: entry.path });
    // Clicking a file is a request to READ it: a folded preview unfolds (otherwise the click
    // silently does nothing visible, which is the bug this column pair is meant to remove).
    foldPreview(false);
  };

  // Breadcrumbs are relative to the workspace root when we are inside it: absolute
  // paths are long and the interesting part is the tail.
  const crumbs = useMemo(() => {
    if (!listing) return [] as { label: string; path: string }[];
    const sep = listing.path.startsWith("/") ? "/" : "\\";
    const insideRoot = listing.root && (listing.path === listing.root || listing.path.startsWith(`${listing.root}${sep}`));
    if (!insideRoot || !listing.root) {
      return [{ label: listing.path === listing.home ? "~" : listing.path, path: listing.path }];
    }
    const rel = listing.path.slice(listing.root.length).split(sep).filter(Boolean);
    const out = [{ label: root.split(sep).filter(Boolean).pop() ?? root, path: listing.root }];
    let acc = listing.root;
    for (const part of rel) {
      acc = `${acc}${sep}${part}`;
      out.push({ label: part, path: acc });
    }
    return out;
  }, [listing, root]);

  const crumbsText = crumbs.map((c) => c.label).join(" / ");

  return (
    <aside
      className="tool-panel"
      aria-label="workspace panel"
      style={{ "--panel-w": `${panelWidth}px` } as CSSProperties}
    >
      {panelHandle}
      <div className="tool-tabs">
        <button
          className={`tool-tab ${tab === "files" ? "active" : ""}`}
          onClick={() => setTab("files")}
        >
          <IconFile size={14} /> files
        </button>
        {/* The tab bar is built from the registry (#78 §1): one entry per pane, click = chooseTool
            (put me on top / start the split with me on top). No AGENTUS_IDE_UPSTREAM ⇒ no ide tab at
            all: a control that cannot do anything is worse than no control. */}
        {PANES.map((pane) => {
          if (!pane.available(ide0)) return null;
          const isTop = splitActive && livePair?.[0] === pane.id;
          const inPair = splitActive && Boolean(livePair?.includes(pane.id));
          const title = splitActive
            ? (isTop ? `${pane.label} 已经在上半屏` : inPair ? `把 ${pane.label} 放到上面` : `用 ${pane.label} 替换上半屏`)
            : pane.id === "ide" && ide0
              ? (ide0.reachable ? `Web IDE · ${ide0.base}` : "code-server is not reachable")
              : undefined;
          return (
            <button
              key={pane.id}
              className={`tool-tab ${tab === pane.id || inPair ? "active" : ""}`}
              title={title}
              onClick={() => chooseTool(pane.id)}
            >
              {pane.id === "ide" ? <IconCode size={14} /> : <IconTerminal size={14} />} {pane.label}
              {pane.id === "ide" && ide0 && !ide0.reachable ? <span className="tab-dot" aria-label="not reachable" /> : null}
            </button>
          );
        })}
        {wide && PANES.filter((x) => x.available(ide0)).length >= 2 ? (
          <button
            className={`icon-btn ${splitActive ? "on" : ""}`}
            title={splitActive ? "取消分屏（一次只看一个）" : "上下分屏：两块 pane 同时看"}
            aria-label="toggle the vertical split"
            aria-pressed={splitActive}
            onClick={toggleSplit}
          >
            <IconSplitRows size={15} />
          </button>
        ) : null}
        <span className="head-spacer" />
        {tab === "files" ? (
          <>
            <button
              className={`icon-btn ${target && !previewFolded ? "on" : ""}`}
              disabled={!target}
              title={previewFolded || !target ? "展开预览列" : "收起预览列"}
              aria-label="toggle the preview column"
              aria-pressed={Boolean(target) && !previewFolded}
              onClick={() => foldPreview()}
            >
              <IconPanelLeft size={15} />
            </button>
            <button
              className={`icon-btn ${treeFolded ? "" : "on"}`}
              title={treeFolded ? "展开文件树" : "收起文件树"}
              aria-label="toggle the file tree column"
              aria-pressed={!treeFolded}
              onClick={() => foldTree()}
            >
              <IconPanelRight size={15} />
            </button>
          </>
        ) : null}
        <button
          className="icon-btn"
          title={`workspace: ${root}\nclick to point this session at another directory`}
          aria-label="change workspace"
          onClick={onPickWorkspace}
        >
          <IconSwap size={15} />
        </button>
        <button className="icon-btn" title="close panel" aria-label="close panel" onClick={onClose}>
          <IconClose size={15} />
        </button>
      </div>

      {/* THREE PANES IN ONE DOM ORDER, chosen for a reason (split + #77, 2026-10-30): the IDE frame
          and the terminal are mounted once and afterwards only hidden. An iframe re-mount reloads
          code-server's whole front end (unsaved buffers, extension host) and a terminal re-mount
          opens a NEW pty, so the panes may not move around in the tree. Which one is on top is CSS
          `order`, not DOM position — a swap is then a repaint, not a reload. */}
      <div className={`panel-stack ${splitActive ? "is-split" : ""}`} ref={stackRef}>
      {tab === "files" ? (
        /* The ROW is split, not the column. The operator: 「现在文件预览是直接放在文件浏览器下面的，
           只有一半的空间，太小了吧…你看下aionui，是单独加个侧栏到中间的吧」 — and the reference does
           exactly that: `ProjectPanelHost.tsx` partitions the layout as chat | preview | explorer. So
           the preview gets its own column beside the chat column, the tree keeps its own, and each has
           a draggable edge whenever both are on screen. On a phone (one pane at a time, see the
           ≤720px rules) opening a file replaces the tree and its own close button brings it back. */
        <div className={`panel-split ${target ? "has-preview" : ""} ${treeFolded ? "tree-folded" : ""} ${previewFolded ? "preview-folded" : ""}`}>
          {target ? (
            <div className="preview-col">
              <FilePreviewPane path={target.path} line={target.line} onClose={() => setTarget(null)} />
            </div>
          ) : null}
          <div className="explorer-col" style={{ "--explorer-w": `${explorer.width}px` } as CSSProperties}>
            {target ? explorer.handle : null}
            <div className="ws-root" title={root}>
              <IconFolder size={13} />
              <span className="ws-root-name">{crumbsText || root}</span>
            </div>
            <div className="file-bar">
              <button
                className="icon-btn"
                title="parent directory"
                aria-label="parent directory"
                disabled={!listing?.parent}
                onClick={() => listing?.parent && setPath(listing.parent)}
              >
                <IconArrowLeft size={15} />
              </button>
              <button
                className="icon-btn"
                title={`home (${listing?.home ?? "~"})`}
                aria-label="home"
                onClick={() => listing?.home && setPath(listing.home)}
              >
                <IconHome size={15} />
              </button>
              <span className="file-bar-path" title={listing?.path ?? path}>{listing?.path ?? path}</span>
              <button className="icon-btn" title="refresh" aria-label="refresh" onClick={() => void load(path)}>
                <IconRefresh size={14} />
              </button>
            </div>
            {error ? <div className="tool-error">{error}</div> : null}
            {loading && !listing ? <div className="tool-note">loading…</div> : null}
            <div className="file-list">
              {listing?.entries.map((e) => (
                <button
                  key={e.path}
                  className={`file-row ${target?.path === e.path ? "sel" : ""}`}
                  title={e.path}
                  onClick={() => open(e)}
                >
                  {e.kind === "dir" ? <IconFolder size={14} /> : <IconFile size={14} />}
                  <span className="file-name">{e.name}</span>
                  {e.kind === "file" ? <span className="file-size">{humanSize(e.size)}</span> : null}
                  {e.kind === "dir" ? <IconChevronRight size={13} className="file-enter" /> : null}
                </button>
              ))}
              {listing && !listing.entries.length ? <div className="tool-note">empty directory</div> : null}
              {listing?.truncated ? <div className="tool-note">list capped at {listing.entries.length} entries</div> : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* Rows are rendered from the registry, in ONE fixed DOM order — the pair's order is pure CSS
          `order`. A pane is mounted on first use and only ever hidden after that (the #77 rule:
          re-mounting an iframe reloads code-server, re-mounting the terminal opens a new pty). */}
      {mounted.terminal && (
        <section
          className="stack-pane pane-term"
          hidden={!(splitActive || tab === "terminal")}
          style={splitActive ? rowStyle(livePair?.[0] === "terminal") : { order: 0 }}
          aria-label="terminal"
        >
          {splitActive ? <PaneHead id="terminal" label="terminal" top={livePair?.[0] === "terminal"} onSwap={swapPanes} /> : null}
          <TerminalTab v={v} root={root} />
        </section>
      )}

      {mounted.ide && (
        <section
          className="stack-pane pane-ide"
          hidden={!(splitActive || tab === "ide")}
          style={splitActive ? rowStyle(livePair?.[0] === "ide") : { order: 0 }}
          aria-label="web ide"
        >
          {splitActive ? <PaneHead id="ide" label="ide" top={livePair?.[0] === "ide"} onSwap={swapPanes} /> : null}
        <div className="ide-frame">
          {ide0?.reachable ? (
            /* `folder` comes from the slot, never from an input: the panel is rooted at the session
               workspace, so "open the IDE" means "open the place this agent is working in". */
            <iframe
              className="ide-iframe"
              title={`Web IDE — ${root}`}
              src={`${ide0.prefix}/?folder=${encodeURIComponent(root)}`}
            />
          ) : (
            <div className="ide-help">
              <div className="ide-help-title">code-server 不可达</div>
              <p>
                {ide0?.configured
                  ? `已配置 ${ide0.base ?? ""}，但连不上。先把 code-server 起起来：`
                  : "没有配置 IDE 上游。"}
              </p>
              <pre className="ide-cmd">{ide0?.start ?? ""}</pre>
              <p className="ide-help-note">
                然后设 <code>AGENTUS_IDE_UPSTREAM=http://127.0.0.1:8133</code> 并重启 agentus。
                只监听回环是刻意的：<code>--auth none</code> 只有在回环上才安全，鉴权由驾驶舱的 cookie 这一跳承担。
              </p>
            </div>
          )}
        </div>
        </section>
      )}

      {/* ONE divider between the two rows — and its order is the integer 2, NOT the 1.5 this shipped
          with: CSS `order` is <integer>, 1.5 was a discarded declaration, the divider fell back to
          order 0 and painted ABOVE both panes (issue #78; it still dragged, which is the nasty part).
          Top row = 1, divider = 2, bottom row = 3: whole integers, always between. */}
      {splitActive ? <div className="row-divider" style={dividerStyle}>{rows.handle}</div> : null}
      </div>
    </aside>
  );
}

/** One row's title bar in split mode: the pane's name, and a ⇅ that swaps the two rows. It exists
 *  because a bare divider reads as a border — a label that says what the rows are is the minimum
 *  affordance for "this line between you and the other pane is draggable" (issue #78 §1). */
function PaneHead({ id, label, top, onSwap }: { id: PaneId; label: string; top: boolean; onSwap: () => void }): JSX.Element {
  return (
    <div className="split-head">
      {id === "ide" ? <IconCode size={13} /> : <IconTerminal size={13} />} <span>{label}</span>
      <span className="head-spacer" />
      <button
        className="icon-btn"
        title={top ? `把 ${label} 移到下面` : `把 ${label} 移到上面`}
        aria-label={`move the ${label} pane`}
        onClick={onSwap}
      >
        <IconSwap size={14} />
      </button>
    </div>
  );
}

type TermStatus = "connecting" | "ready" | "closed" | "error";

/** The terminal is xterm.js over a real pty (see packages/server/src/term.ts): keystrokes go out
 *  raw, the server's pty stream comes back raw, and xterm — not a <pre> — interprets the escape
 *  sequences. That is what makes colours, the prompt, cursor movement and full-screen programs work;
 *  stripping ANSI (what the old line-input panel did) is only sensible if you have no terminal
 *  emulator, and at that point it is not a terminal.
 *
 *  The wire protocol is three messages: term-input (raw bytes up), term-data (raw bytes down),
 *  term-resize (cols/rows). Resizing matters as much as input: without it `vim` draws at 80x24
 *  forever. */
/** The palette follows the cockpit's own theme tokens, so the terminal is not a foreign body in
 *  either palette. Read at construction time (the panel remounts when the terminal tab is opened)
 *  with the theme resolved through `resolveDark` — the same reading the page's own palette uses.
 *  Asking `data-theme` instead is WRONG: its third value is `system`, so `!== "light"` called a
 *  light cockpit dark and a `system`-mode operator on a light OS got a dead-black terminal in a
 *  white page. `TerminalTab` re-applies this when the resolved palette changes, so an OS flip or a
 *  theme switch does not leave the panel wearing the other one.
 *
 *  The 16 ANSI colours come from `terminalPalette.ts` and are PER THEME: the dark panel paints
 *  `--bg-panel` #121a22, on which the shared Tango palette's `black` sat at 1.5:1 and simply was not
 *  there (ls output, diagnostics, diff context). `extendedAnsi` does the same job for the 256-
 *  colour ramp, whose dark end has the identical problem on a dark background. */
function terminalTheme(dark: boolean): ITheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback;
  return dark
    ? { background: v("--bg-panel", "#121a22"), foreground: v("--text", "#e3ecf3"),
        cursor: v("--accent", "#4aacdf"), selectionBackground: "rgba(74,172,223,0.30)",
        ...ansi16(true), extendedAnsi: ansiExtended(true) }
    : { background: v("--bg-panel", "#ffffff"), foreground: v("--text", "#1c2735"),
        cursor: v("--accent", "#2679a5"), selectionBackground: "rgba(38,121,165,0.25)",
        ...ansi16(false), extendedAnsi: ansiExtended(false) };
}

/** Flow-control watermarks, in BYTES of output handed to xterm but not yet parsed.
 *
 *  A pty has no upper bound on how fast it can produce, and xterm buffers whatever we give it:
 *  a program that keeps repainting (a full-screen TUI mid-resize, `yes`, `cat` of a huge file)
 *  queues write callbacks faster than the emulator drains them until keystrokes stop being
 *  answered at all. xterm's own flow-control guide puts the practical ceiling near 500 KB and
 *  says in as many words that past it the emulator "might not respond to keystrokes anymore".
 *
 *  So the panel counts what it has handed over and tells the server where to stop: above HIGH
 *  the server stops draining the pty, below LOW it starts again. The brake walks back the whole
 *  chain (node stops reading the child's stdout -> the pty helper blocks in write(1) -> the shell
 *  blocks in write(2)), which is the only honest way to slow the producer down. */
const HIGH_WATER = 384 * 1024;
const LOW_WATER = 96 * 1024;

function TerminalTab({ v, root }: { v: SessionView; root: string }): JSX.Element {
  const [status, setStatus] = useState<TermStatus>("connecting");
  const [error, setError] = useState("");
  // A shell is a socket, and "restart" is a new socket — not a state machine we should hand-roll.
  const [nonce, setNonce] = useState(0);
  const [tty, setTty] = useState<boolean | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sendRef = useRef<(data: string) => void>(() => {});

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let closed = false;
    // flow control state (see the watermarks above): bytes handed to xterm, and whether we have
    // already told the server to stop draining the pty.
    let pendingBytes = 0;
    let paused = false;
    // last size the pty was told about, so an unchanged fit() does not become a message
    let lastCols = 0;
    let lastRows = 0;
    setStatus("connecting");
    setError("");
    setTty(null);

    const dark = resolveDark(themeConfig());
    const term = new Terminal({
      theme: terminalTheme(dark),
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      // xterm measures by rendering into the host; the panel sets the size, so no width guessing.
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    try { fit.fit(); } catch { /* the host is not laid out yet; the observer below will fit */ }

    const cols = term.cols || 80;
    const rows = term.rows || 24;
    // The pty is born at this size (it rides the socket URL below), so it starts out in sync.
    lastCols = cols;
    lastRows = rows;
    // The socket is authenticated the same way the event bus is: a cookie for the browser, ?token=
    // for scripts (the WS handshake cannot carry headers). The viewport size rides along so the pty
    // is BORN at the right size instead of flashing 80x24.
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws/term?sessionId=${encodeURIComponent(v.info.id)}&cols=${cols}&rows=${rows}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      setStatus("error");
      setError(String((e as Error)?.message ?? e));
      return;
    }
    wsRef.current = ws;
    // A superseded socket must not touch the UI. The effect can run again (a StrictMode remount, or
    // the workspace being re-pointed) while the first socket is still handshaking, and its `error` /
    // `close` events would otherwise stick: the panel said "terminal socket failed" *while* the
    // current socket was connected and streaming, which is worse than no message at all.
    const live = (): boolean => wsRef.current === ws;
    ws.onopen = () => { if (!live()) return; setStatus("ready"); setError(""); };
    ws.onmessage = (ev) => {
      if (!live()) return;
      let msg: { t?: string; data?: string; error?: string; cwd?: string; tty?: boolean };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.t === "term-data" && typeof msg.data === "string") {
        // Raw, straight into the emulator: colours, cursor moves, alternate screen — all of it.
        // The write callback is the commit point, so it is what drains the watermark.
        const size = msg.data.length;
        pendingBytes += size;
        term.write(msg.data, () => {
          pendingBytes -= size;
          if (paused && pendingBytes <= LOW_WATER && live() && ws.readyState === WebSocket.OPEN) {
            paused = false;
            ws.send(JSON.stringify({ t: "term-resume" }));
          }
        });
        if (!paused && pendingBytes >= HIGH_WATER && ws.readyState === WebSocket.OPEN) {
          paused = true;
          ws.send(JSON.stringify({ t: "term-pause" }));
        }
        return;
      }
      if (msg.t === "term-ready") {
        setStatus("ready");
        setError("");
        if (typeof msg.tty === "boolean") setTty(msg.tty);
        return;
      }
      if (msg.t === "term-exit") {
        setStatus("closed");
        return;
      }
      if (msg.t === "term-error") {
        setStatus("error");
        setError(msg.error ?? "terminal error");
      }
    };
    ws.onclose = () => {
      if (closed || !live()) return;
      setStatus((cur) => (cur === "error" ? cur : "closed"));
    };
    ws.onerror = () => {
      if (!live()) return;
      // The browser gives no detail; the close handler reports the state.
      setError((cur) => cur || "terminal socket failed");
    };

    const send = (data: string): void => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ t: "term-input", data }));
    };
    sendRef.current = send;
    const onData = term.onData(send);
    // Fit on every layout change (the panel is resizable, the window is resizable, the phone
    // rotates) and tell the pty, so the shell's idea of the size keeps up with the pixels.
    const pushSize = (): void => {
      try { fit.fit(); } catch { return; }
      // Publish the emulator's own idea of its size on the host element. QA asserts against it:
      // "the pty reports what the client thinks" is the whole contract of a web terminal, and
      // without this the only way to see it is to read pixels.
      host.dataset.termCols = String(term.cols);
      host.dataset.termRows = String(term.rows);
      // A size the pty already knows is not news. Every term-resize makes a full-screen program
      // repaint the entire screen, so echoing an unchanged size on every observer tick turns a
      // layout twitch into a redraw storm — and the pty was born at this size anyway.
      if (term.cols === lastCols && term.rows === lastRows) return;
      lastCols = term.cols;
      lastRows = term.rows;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "term-resize", cols: term.cols, rows: term.rows }));
      }
    };
    // Observe the CONTAINER, not the element xterm paints into: `fit()` sizes the terminal to its
    // box, and observing that same box is how a fit -> resize -> fit feedback loop starts (the
    // documented FitAddon pitfall). The container's height comes from the panel, which is the
    // signal we actually want.
    const ro = new ResizeObserver(() => pushSize());
    ro.observe(host.parentElement ?? host);
    const onWinResize = (): void => pushSize();
    window.addEventListener("resize", onWinResize);
    term.focus();

    return () => {
      closed = true;
      ro.disconnect();
      window.removeEventListener("resize", onWinResize);
      onData.dispose();
      try { ws.send(JSON.stringify({ t: "term-close" })); } catch { /* already closing */ }
      ws.close();
      wsRef.current = null;
      term.dispose();
      termRef.current = null;
    };
    // `root` is a dependency on purpose: re-pointing the session's workspace must move the shell too
    // (the server starts it in sessionRoot(sessionId)), and a shell cannot be re-cd'd from outside.
  }, [v.info.id, root, nonce]);

  // The palette is chosen at construction, so a palette that CHANGES while the panel is open would
  // leave the terminal on the one it was born with: an OS light/dark flip under `system` mode, or the
  // operator switching the theme in settings. `useResolvedDark` is the reactive reading of the same
  // question `terminalTheme` was answered with above (the brand mark asks it for the same reason —
  // xterm's palette cannot be a CSS variable). Handler deps stay [v.info.id, root, nonce]: only the theme moves.
  const resolvedDark = useResolvedDark();
  useEffect(() => {
    const t = termRef.current;
    if (t) t.options.theme = terminalTheme(resolvedDark);
  }, [resolvedDark]);

  const statusWord = status === "ready" ? (tty === false ? "shell (no tty)" : "shell")
    : status === "connecting" ? "starting…" : status;

  return (
    <div className="tool-body term-body">
      <div className="term-bar">
        <span className={`term-dot ${status}`} />
        <span className="term-status" title={tty === false ? "this shell runs on pipes, not a tty: no prompt, no colours, no full-screen apps" : undefined}>
          {statusWord}
          {status === "ready" ? <span className="term-cwd" title={root}> {root.split("/").filter(Boolean).pop()}</span> : null}
        </span>
        <span className="head-spacer" />
        <button
          className="icon-btn"
          title="send Ctrl-C"
          aria-label="send interrupt"
          onClick={() => sendRef.current("\u0003")}
        >
          <IconClose size={13} />
        </button>
        <button
          className="icon-btn"
          title="new shell"
          aria-label="new shell"
          onClick={() => setNonce((n) => n + 1)}
        >
          <IconRefresh size={14} />
        </button>
      </div>
      {error ? <div className="tool-error">{error}</div> : null}
      <div className="term-host" ref={hostRef} data-term-host="1" onClick={() => termRef.current?.focus()} />
      {tty === false ? (
        <div className="term-note">
          no tty on this machine (python3 missing) — pipe shell: no prompt, no colours, no full-screen apps
        </div>
      ) : null}
    </div>
  );
}
