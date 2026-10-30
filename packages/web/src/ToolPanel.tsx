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
import { PANES, RATIO_KEY, readPair, splitSeed, useWide, writePair, type IdeStatus, type PaneId, type PaneSpec, type ViewTab } from "./panes";
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

/** The preview column's floor: the tree may not eat below this, or the file being read becomes a
 *  letterbox (the operator's original complaint about the preview's size). */
const PREVIEW_MIN = 300;

/* The two column-fold switches (see the state below). Their names say which key holds which. */
const FOLD_TREE_KEY = "agentus.panel-tree-folded";
const FOLD_PREVIEW_KEY = "agentus.panel-preview-folded";
/* Desktop split (2026-10-30): the IDE above, the terminal below, both alive at once. Two remembered
 * facts, both layout preferences like the widths and folds beside them: whether the split is on, and
 * which of the two panes is the top one. */
// 0.15.10 stored the split as two booleans (splitOn + ideOnTop) and one global ratio. #78's pair
// model replaces all three; `readPair`/`readRatio` (panes.ts) migrate the old values once so an
// operator who had IDE-on-top keeps IDE-on-top after the upgrade.

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

function humanSize(bytes?: number): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** The folder's own name, which is what a person calls a workspace. `/Users/liang/Workspace/agent-dev-workspace`
 *  is nine words of boilerplate the bar underneath already prints in full; the switcher row only has to
 *  answer "which place am I rooting the tree at". */
function workspaceName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

export function ToolPanel({ v, onClose, onPickWorkspace, focus, panelWidth, panelHandle, tab, onTab, ide }: {
  v: SessionView;
  onClose: () => void;
  onPickWorkspace: () => void;
  /** Which pane is showing. OWNED BY THE HEAD (#80 §1): the head's terminal/ide buttons open the
   *  panel on that pane, so the choice cannot live below the panel's mount. */
  tab: ViewTab;
  onTab: (t: ViewTab) => void;
  /** The IDE status the head already asked for (panes.ts::useIdeStatus) — one request for one fact. */
  ide: IdeStatus | null;
  /** a file pushed in from outside the panel (a link in a reply); the panel opens on it */
  focus?: PanelTarget | null;
  /** the panel's own (resizable, persisted) width, and its handle — rendered on the LEFT edge,
   *  where it meets the chat column (`paneWidth.tsx`). */
  panelWidth: number;
  panelHandle: JSX.Element;
}): JSX.Element {
  // on a phone this panel is a full-screen sheet, so Escape is the keyboard way out
  useEscape(typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches, onClose);
  const setTab = onTab;
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
  /* Web IDE (issue #77). `ide` arrives as a prop from the head, which needs the same answer to know
   *  whether its `ide` button exists at all (#80 §1) — `configured` decides whether the pane is
   *  available, `reachable` whether it opens an editor or explains itself. */
  const ide0 = ide;
  /* The split is a preference, the same in every session (like the widths), and it is only OFFERED
   * when there is something to split with — a phantom toggle is worse than none. */
  const wide = useWide();
  const [pair, setPair] = useState<PaneId[] | null>(() => readPair());
  /* #78 §4: a pane that stops being available (IDE upstream unset later, or a status that never
   * arrives) is PRUNED from the pair — and a one-pane pair is no split at all. No dead frames,
   * no phantom halves. */
  const avail = (id: string): boolean => PANES.find((x) => x.id === id)?.available(ide0) ?? false;
  const livePair: PaneId[] | null = pair && pair.every(avail) ? pair : null;
  /* In split mode both panes are on screen, so the tab buttons mean "which one is on top". `files`
   * takes part like every other pane (2026-10-30: without an IDE it is the only partner a terminal
   * has), so there is no exception to carve out here any more. A phone never splits. */
  /* The split is on the screen only while the selected tab is one of its panes. That is what makes
   * `files` usable beside a remembered [terminal, ide]: clicking 📁 shows the browser full height and
   * LEAVES THE PAIR ALONE (it is still there when you click a pane tab again). Rewriting the pair on
   * every head click instead — the first thing I tried — silently ate it: 📁 turned [terminal, ide]
   * into [files, terminal] and the IDE pair was gone. */
  const splitActive = wide && Boolean(livePair?.includes(tab));
  /* Reopening the cockpit still lands on the operator's mode — but that decision now happens in the
   * HEAD, when the page loads and the panel's first tab is seeded from the stored pair (#80). Doing
   * it here instead is what made the head's 📁 button useless in a session with a stored split: the
   * button said "files", the panel's own restore effect pulled it back to the pair a moment later.
   * What is left for the panel is the mirror case: a tab that stopped being AVAILABLE (an `ide`
   * whose upstream went away) falls back to the file browser instead of showing a dead pane. */
  useEffect(() => {
    if (ide0 === null) return;   // wait for the status: until then no pane's availability is known
    if (!avail(tab)) setTab("files");
  }, [ide0, tab]);
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

  /* ONE hiding rule for the whole registry, stated once (issue #79). In split mode a pane is on
   * screen only if it is IN the pair; otherwise only the selected tab is.
   *
   * The 0.15.11 code said `!(splitActive || tab === id)` — "in split mode, show me too". That is
   * exactly right while the registry holds the two panes the pair can hold, and exactly wrong the
   * moment a third pane exists: `tab` can be that third pane, which takes no row from the split
   * (no `order`, no height) but was still released by `tab === id`, so it hung below the pair as a
   * THIRD row. Measured on a three-pane beta: pair ["ide","terminal"], three visible rows. */
  const paneShown = (id: PaneId): boolean =>
    splitActive ? Boolean(livePair?.includes(id)) : tab === id;

  /* The row shell every pane gets: the section, its hidden flag, its order, its head. A pane's own
   * JSX is the argument — that is the whole extension point (#78 §1). */
  const paneRow = (pane: PaneSpec, body: JSX.Element): JSX.Element => (
    <section
      key={pane.id}
      className={`stack-pane pane-${pane.id}`}
      data-pane={pane.id}
      hidden={!paneShown(pane.id)}
      style={splitActive ? rowStyle(livePair?.[0] === pane.id) : { order: 0 }}
      aria-label={pane.label}
    >
      {splitActive ? <PaneHead id={pane.id} label={pane.label} top={livePair?.[0] === pane.id} onSwap={swapPanes} /> : null}
      {body}
    </section>
  );

  /* Tab click (issue #78 §3): put me on top. Already on top: nothing moves. In the pair below:
   * swap. Not in the pair: I take the top slot and the old top becomes the bottom. Turning the
   * split ON with no stored pair seeds [this, the first other available pane]. */
  const chooseTool = (id: PaneId): void => {
    if (id === "files") { setTab("files"); return; }   // the browser is a view, not a row to swap into
    setTab(id);
    const seed = splitSeed(ide0);
    // The companion is the one the split would have seeded with, NOT "the next tab in the bar":
    // after `files` joined the registry that would pair a terminal with the file browser on a machine
    // that HAS an IDE, quietly changing what ⇅ and a tab click do.
    const partner = seed?.find((x) => x !== id) ?? null;
    if (!splitActive) {
      // turning the split ON from a pane's tab puts THAT pane on top — the click said what it meant
      if (wide && partner) { const next: PaneId[] = [id, partner]; setPair(next); writePair(next); }
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
      // closing the split shows the pane that WAS on top — the row the operator was reading.
      const top = livePair[0];
      setPair(null);
      writePair(null);
      setTab(top);
      return;
    }
    // The seed is DETERMINISTIC, not "whatever tab you happened to be on" (panes.ts::splitSeed):
    // IDE over terminal when there is an IDE, FILES over terminal when there is not — otherwise a
    // machine without code-server had no split at all, which is the point of this change.
    const seed = splitSeed(ide0);
    if (!wide || !seed) return;   // nothing to split with — no phantom toggle
    setPair(seed);
    writePair(seed);
    setTab(seed[0]);
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

  /* A mount latch PER PANE, driven by the pair: a pane that is in the pair (either row) or is the
   * shown tab has been mounted at least once, and afterwards it is only ever HIDDEN. Re-mounting the
   * iframe reloads code-server's whole front end; re-mounting the terminal opens a NEW pty (scrollback
   * gone, `cd` gone) — #77's rule, generalised: it now covers every pane the split can hold. */
  const [mounted, setMounted] = useState<Record<string, boolean>>({});
  useEffect(() => {
    // `tab` is ALWAYS a pane id now (files included), so nothing to exclude: whatever is on screen or
    // in the pair has been mounted at least once. (The old `tab !== "files"` guard is why the browser
    // came up empty for one build after files joined the registry.)
    const needed: string[] = [...(livePair ?? []), tab].filter((id) => !mounted[id]);
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

  /* A pane's BODY — the entire extension point (#78 §1): a new pane is one registry entry plus one
   * branch here. The row's shell, its hiding rule and its order all come from `paneRow`, so a pane
   * cannot invent a second visibility rule (that is exactly the #79 bug). */
  const paneBody = (id: PaneId): JSX.Element => {
    if (id === "files") {
      return (
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
            {/* #80 §2: the workspace switcher lives HERE, at the root of the tree, not as a second
                folderish button in the panel's tab bar. 「打开文件浏览器之后，你要切工作空间，本来就
                应该在文件浏览器里切 —— 文件树的根就是当前工作空间，在树顶上换根是最自然的。」 It is
                the same act as walking up the tree, said in one click; the tree, the preview, the
                terminal's cwd and the IDE's ?folder= all re-root from `v.info.workspace`. */}
            {/* The row says WHICH workspace and offers the act — separately. The whole row used to be
                one button carrying the full path plus a bare swap glyph, and the operator's report was
                that it read as text: 「这个不够明显，看不出来，我都不知道这是个按钮」. The path is not
                this row's job either (the bar under it already prints it in full) — so: folder name at
                the left, a button that actually says 切换 on the right. */}
            <div className="ws-row" title={`工作空间：${root}`}>
              <IconFolder size={13} />
              <span className="ws-root-name">{workspaceName(root)}</span>
              <button
                className="ws-swap-btn"
                title="切换工作空间"
                aria-label="change workspace"
                onClick={onPickWorkspace}
              >
                切换
              </button>
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
      );
    }
    if (id === "terminal") return <TerminalTab v={v} root={root} />;
    return (
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
    );
  };

  return (
    <aside
      className="tool-panel"
      aria-label="workspace panel"
      style={{ "--panel-w": `${panelWidth}px` } as CSSProperties}
    >
      {panelHandle}
      <div className="tool-tabs">
        {/* The tab bar is built from the registry (#78 §1): one entry per pane — `files` included,
            since 2026-10-30 — click = chooseTool (put me on top / start the split with me on top).
            No AGENTUS_IDE_UPSTREAM ⇒ no ide tab at all: a control that cannot do anything is worse
            than no control. */}
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
              {pane.id === "ide" ? <IconCode size={14} /> : pane.id === "files" ? <IconFile size={14} /> : <IconTerminal size={14} />} {pane.label}
              {pane.id === "ide" && ide0 && !ide0.reachable ? <span className="tab-dot" aria-label="not reachable" /> : null}
            </button>
          );
        })}
        {wide && splitSeed(ide0) ? (
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

      {/* Rows are rendered from the registry, in ONE fixed DOM order — the pair's order is pure CSS
          `order`. A pane is mounted on first use and only ever hidden after that (the #77 rule:
          re-mounting an iframe reloads code-server, re-mounting the terminal opens a new pty).

          The body is the only thing a new pane has to write (one branch below); the section, its
          hiding rule and its order come from `paneRow`, which is why a third pane cannot repeat the
          #79 bug: there is nowhere left to write a second, wrong `hidden` expression. */}
      {PANES.map((pane) => (mounted[pane.id] ? paneRow(pane, paneBody(pane.id)) : null))}

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
