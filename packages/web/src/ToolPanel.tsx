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

/** Terminal output arrives with \r\n, ANSI colour and cursor moves. We are not
 *  xterm and do not pretend to be (no colour, no full-screen apps), so strip the
 *  escape sequences instead of printing them as garbage. */
function stripAnsi(input: string): string {
  return input
    .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "")   // OSC … BEL/ST
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")            // CSI (colours, cursor)
    .replace(/\u001b[@-Z\\-_]/g, "")                        // other 2-char escapes
    .replace(/\r(?!\n)/g, "");                              // bare CR: keep the line, drop the return
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

function TerminalTab({ v, root }: { v: SessionView; root: string }): JSX.Element {
  const [status, setStatus] = useState<TermStatus>("connecting");
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [line, setLine] = useState("");
  const outRef = useRef<HTMLPreElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const stick = useRef(true);
  // `nonce` re-runs the connect effect: a shell is a socket, and "restart" is a
  // new socket — not a state machine we should hand-roll.
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let closed = false;
    setStatus("connecting");
    setError("");
    setText("");
    // The socket is authenticated the same way the event bus is: a cookie for the
    // browser, ?token= for scripts (the WS handshake cannot carry headers).
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws/term?sessionId=${encodeURIComponent(v.info.id)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      setStatus("error");
      setError(String((e as Error)?.message ?? e));
      return;
    }
    wsRef.current = ws;
    ws.onopen = () => setStatus("ready");
    ws.onmessage = (ev) => {
      let msg: { t?: string; data?: string; error?: string; cwd?: string };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.t === "term-data" && typeof msg.data === "string") {
        const chunk = msg.data;
        setText((cur) => (cur + stripAnsi(chunk)).slice(-200_000));
        return;
      }
      if (msg.t === "term-ready") {
        setStatus("ready");
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
      if (closed) return;
      setStatus((cur) => (cur === "error" ? cur : "closed"));
    };
    ws.onerror = () => {
      // The browser gives no detail; the close handler reports the state.
      setError((cur) => cur || "terminal socket failed");
    };
    return () => {
      closed = true;
      try {
        ws.send(JSON.stringify({ t: "term-close" }));
      } catch {
        /* already closing */
      }
      ws.close();
      wsRef.current = null;
    };
    // `root` is a dependency on purpose: re-pointing the session's workspace must move
    // the shell too (the server starts it in sessionRoot(sessionId)), and a shell cannot
    // be re-cd'd from outside — it has to be a new one.
  }, [v.info.id, root, nonce]);

  // Follow the output unless the operator scrolled up (same rule as the chat stream).
  useEffect(() => {
    const el = outRef.current;
    if (!el || !stick.current) return;
    el.scrollTop = el.scrollHeight;
  }, [text]);

  const send = (data: string): void => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ t: "term-input", data }));
    stick.current = true;
  };

  const runLine = (): void => {
    send(`${line}\n`);
    setLine("");
  };

  return (
    <div className="tool-body term-body">
      <div className="term-bar">
        <span className={`term-dot ${status}`} />
        <span className="term-status">
          {status === "ready" ? "shell" : status === "connecting" ? "starting…" : status}
          {status === "ready" ? <span className="term-cwd" title={root}> {root.split("/").filter(Boolean).pop()}</span> : null}
        </span>
        <span className="head-spacer" />
        <button
          className="icon-btn"
          title="send Ctrl-C"
          aria-label="send interrupt"
          onClick={() => send("\u0003")}
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
      <pre
        className="term-out"
        ref={outRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
        }}
      >
        {text || (status === "connecting" ? "starting shell…\n" : "")}
      </pre>
      <div className="term-input">
        <span className="term-prompt">$</span>
        <input
          value={line}
          spellCheck={false}
          autoComplete="off"
          placeholder={status === "ready" ? "run a command…" : "waiting for the shell"}
          aria-label="terminal command"
          onChange={(e) => setLine(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              runLine();
            }
          }}
        />
        <button
          className="icon-btn"
          title="run"
          aria-label="run command"
          disabled={status !== "ready"}
          onClick={runLine}
        >
          <IconPlus size={15} />
        </button>
      </div>
      <div className="term-note">
        runs in {root} · line-based shell (no full-screen apps — set AGENTUS_TERM_PTY=1 for a pty)
      </div>
    </div>
  );
}
