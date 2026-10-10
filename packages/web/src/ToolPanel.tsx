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
import { usePaneWidth } from "./paneWidth";
import {
  IconArrowLeft, IconChevronRight, IconClose, IconFile, IconFolder, IconHome,
  IconPlus, IconRefresh, IconSwap, IconTerminal,
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
  const [tab, setTab] = useState<"files" | "terminal">("files");
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
    const dir = focus.path.replace(/\/[^/]*$/, "") || "/";
    setPath(dir);
  }, [focus]);

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
        <button
          className={`tool-tab ${tab === "terminal" ? "active" : ""}`}
          onClick={() => setTab("terminal")}
        >
          <IconTerminal size={14} /> terminal
        </button>
        <span className="head-spacer" />
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

      {tab === "files" ? (
        /* The ROW is split, not the column. The operator: 「现在文件预览是直接放在文件浏览器下面的，
           只有一半的空间，太小了吧…你看下aionui，是单独加个侧栏到中间的吧」 — and the reference does
           exactly that: `ProjectPanelHost.tsx` partitions the layout as chat | preview | explorer. So
           the preview gets its own column beside the chat column, the tree keeps its own, and each has
           a draggable edge whenever both are on screen. On a phone (one pane at a time, see the
           ≤720px rules) opening a file replaces the tree and its own close button brings it back. */
        <div className={`panel-split ${target ? "has-preview" : ""}`}>
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
      ) : (
        <TerminalTab v={v} root={root} />
      )}
    </aside>
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
const ANSI_16 = {
  black: "#2e3436", red: "#cc0000", green: "#4e9a06", yellow: "#c4a000",
  blue: "#3465a4", magenta: "#75507b", cyan: "#06989a", white: "#d3d7cf",
  brightBlack: "#555753", brightRed: "#ef2929", brightGreen: "#8ae234", brightYellow: "#fce94f",
  brightBlue: "#729fcf", brightMagenta: "#ad7fa8", brightCyan: "#34e2e2", brightWhite: "#eeeeec",
};

/** The palette follows the cockpit's own theme tokens, so the terminal is not a foreign body in
 *  either palette. Read at construction time: the panel remounts when the terminal tab is opened. */
function terminalTheme(dark: boolean): ITheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback;
  return dark
    ? { background: v("--bg-1", "#0e1518"), foreground: v("--text", "#e3ecf3"),
        cursor: v("--accent", "#4aacdf"), selectionBackground: "rgba(74,172,223,0.30)", ...ANSI_16 }
    : { background: v("--bg-1", "#ffffff"), foreground: v("--text", "#1c2735"),
        cursor: v("--accent", "#2679a5"), selectionBackground: "rgba(38,121,165,0.25)", ...ANSI_16 };
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

    const dark = document.documentElement.getAttribute("data-theme") !== "light";
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
