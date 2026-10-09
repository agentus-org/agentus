// The file a workspace-panel click opens: one component that decides HOW to draw a file
// (markdown · image · pdf · code · csv · audio/video · plain text) and, when the file is
// text-ish, lets the operator edit and save it.
//
// Where this came from: the panel used to render every file as one `<pre>` and tell binary
// files "no preview", so clicking a screenshot, a PDF or a .md showed nothing useful. AionUi's
// PreviewPanel (renderer per file type, markdown rendered through the same pipeline as a reply)
// and hermes-webui's workspace editor (dirty tracking + save) are the two references this
// follows; the file-type table and the save rules live on the SERVER (packages/server/src/fs.ts)
// so both sides cannot drift.
//
// Editing rules worth stating:
//  * the editor holds the hash the file had when it was loaded; a save sends it back and the
//    server refuses (409 + the current bytes) if the agent rewrote the file meanwhile. Losing
//    either side's work silently is the one outcome that is never acceptable, so a conflict is
//    a banner with an explicit choice, not a retry.
//  * while the panel is open the file is polled (cheap stat). If it changes and nothing is
//    dirty, the view reloads by itself — the agent rewriting the file you are reading is the
//    normal case in this cockpit.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cockpit, rawFileUrl } from "./state";
import { renderMarkdown } from "./Markdown";
import { enhanceTables } from "./tableSort";
import { IconArrowLeft, IconDownload, IconFile } from "./Icons";

interface StatInfo {
  path: string;
  name: string;
  kind: string;
  contentType: string;
  size: number;
  mtimeMs: number;
  hash: string;
  editable: boolean;
}

interface Loaded extends StatInfo {
  content: string;
  truncated: boolean;
  binary: boolean;
}

function humanSize(bytes?: number): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** Kinds whose bytes are text and therefore come through /api/fs/file. Everything else is
 *  served to an <img>/<iframe>/<audio> straight from /api/fs/raw. */
const TEXT_KINDS = new Set(["markdown", "code", "text", "csv", "html"]);

function isConflict(e: unknown): { content: string; hash: string } | null {
  const body = (e as { httpBody?: { error?: string; content?: string; hash?: string } } | null)?.httpBody;
  if (!body || body.error !== "changed_on_disk") return null;
  return { content: body.content ?? "", hash: body.hash ?? "" };
}

export function FilePreviewPane({ path, line, onClose }: {
  path: string;
  line?: number;
  onClose: () => void;
}): JSX.Element {
  const [file, setFile] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [conflict, setConflict] = useState<{ content: string; hash: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  // The path this pane believes it loaded — a poll must not apply an answer for an older file.
  const wantRef = useRef(path);

  const load = useCallback(async (target: string, opts: { keepDraft?: boolean } = {}): Promise<void> => {
    wantRef.current = target;
    setLoading(true);
    setError("");
    try {
      const st = await cockpit.statFile(target);
      if (wantRef.current !== target) return;
      // A file whose bytes are not text is drawn from its URL — no reason to pull megabytes
      // through the JSON endpoint (that is how every image used to become "binary file").
      if (!TEXT_KINDS.has(st.kind)) {
        setFile({ ...st, content: "", truncated: false, binary: true });
        setConflict(null);
        return;
      }
      const body = await cockpit.readFile(target);
      if (wantRef.current !== target) return;
      setFile({ ...st, content: body.content, truncated: body.truncated, binary: body.binary });
      if (!opts.keepDraft) {
        setDraft(body.content);
        setEditing(false);
      }
      setConflict(null);
    } catch (e) {
      if (wantRef.current === target) setError(String((e as Error)?.message ?? e));
    } finally {
      if (wantRef.current === target) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(path); }, [path, load]);

  // Switching files must not leave the previous file's text under the new file's name: clear
  // first (the poll below loads without clearing, so a reload does not blank the pane).
  useEffect(() => {
    setFile(null);
    setEditing(false);
    setDraft("");
    setNote("");
  }, [path]);

  // Follow the agent. A stat every 3s is ~nothing, and it is the only way to notice a rewrite
  // the server never tells us about (the agent edits files with its own tools).
  useEffect(() => {
    if (!file) return;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const st = await cockpit.statFile(path);
          if (wantRef.current !== path || st.hash === file.hash) return;
          if (editing) {
            setConflict({ content: "", hash: st.hash });
            return;
          }
          await load(path);
        } catch {
          /* a file that vanished mid-poll answers on the next click */
        }
      })();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [file, editing, path, load]);

  const dirty = Boolean(file && editing && draft !== file.content);

  const save = useCallback(async (): Promise<void> => {
    if (!file) return;
    setBusy(true);
    setNote("");
    try {
      const out = await cockpit.writeFile(file.path, draft, file.hash);
      setFile({ ...file, content: draft, hash: out.hash, mtimeMs: out.mtimeMs, size: out.size });
      setEditing(false);
      setNote("saved");
      window.setTimeout(() => setNote(""), 1500);
    } catch (e) {
      const c = isConflict(e);
      if (c) setConflict(c);
      else setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, [file, draft]);

  // ⌘S/^S saves — the one shortcut every editor has trained into the hand.
  useEffect(() => {
    if (!editing) return;
    const onKey = (ev: KeyboardEvent): void => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "s") {
        ev.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, save]);

  const canEdit = Boolean(file?.editable) && !file?.binary;

  const body = useMemo(() => {
    if (!file) return <div className="tool-note">loading…</div>;
    if (file.binary && !TEXT_KINDS.has(file.kind)) return <RichBody file={file} />;
    if (editing) {
      return (
        <textarea
          className="file-edit"
          value={draft}
          spellCheck={false}
          aria-label={`edit ${file.name}`}
          onChange={(e) => setDraft(e.target.value)}
        />
      );
    }
    return <TextBody file={file} line={line} />;
  }, [file, editing, draft, line]);

  return (
    <div className="file-preview">
      <div className="file-preview-head">
        <button className="icon-btn" title="close preview" aria-label="close preview" onClick={onClose}>
          <IconArrowLeft size={14} />
        </button>
        <IconFile size={13} />
        <span className="file-name" title={file?.path ?? path}>
          {(file?.name ?? path.split("/").pop() ?? path)}
          {dirty ? <span className="file-dirty" title="unsaved changes"> ●</span> : null}
        </span>
        <span className="file-size">
          {humanSize(file?.size)}
          {file?.truncated && !editing ? " · showing the head" : ""}
          {note ? ` · ${note}` : ""}
          {loading && file ? " · loading…" : ""}
        </span>
        <span className="head-spacer" />
        <button
          className="icon-btn"
          title={`open ${file?.name ?? "file"} in a new tab`}
          aria-label="open raw"
          onClick={() => window.open(rawFileUrl(file?.path ?? path), "_blank", "noopener")}
        >
          <IconDownload size={13} />
        </button>
        {canEdit ? (
          editing ? (
            <>
              <button
                className="icon-btn"
                title="save (⌘S)"
                aria-label="save"
                disabled={busy || !dirty}
                onClick={() => void save()}
              >
                save
              </button>
              <button
                className="icon-btn"
                title="discard and leave the editor"
                aria-label="cancel edit"
                onClick={() => { setEditing(false); setDraft(file?.content ?? ""); }}
              >
                cancel
              </button>
            </>
          ) : (
            <button className="icon-btn" title="edit this file" aria-label="edit" onClick={() => { setEditing(true); setDraft(file?.content ?? ""); }}>
              edit
            </button>
          )
        ) : null}
      </div>
      {conflict ? (
        <div className="file-conflict">
          <span>
            {conflict.content
              ? "this file changed on disk since you opened it"
              : "the agent changed this file while you were editing"}
          </span>
          <button
            className="icon-btn"
            onClick={() => {
              // "theirs" wins, but the operator's buffer must not vanish without a word.
              if (dirty && !window.confirm("discard your changes and load the file from disk?")) return;
              setConflict(null);
              void load(path);
            }}
          >
            reload theirs
          </button>
          <button className="icon-btn" onClick={() => setConflict(null)}>keep mine</button>
        </div>
      ) : null}
      {error ? <div className="tool-error">{error}</div> : null}
      <div className="file-preview-body">{body}</div>
    </div>
  );
}

/** Images/PDF/audio/video: the browser is the renderer, the bytes come from /api/fs/raw. */
function RichBody({ file }: { file: Loaded }): JSX.Element {
  const url = rawFileUrl(file.path);
  if (file.kind === "image") {
    return (
      <a className="file-image-wrap" href={url} target="_blank" rel="noopener noreferrer" title="open full size">
        <img className="file-image" src={url} alt={file.name} />
      </a>
    );
  }
  if (file.kind === "pdf") {
    return <iframe className="file-frame" src={url} title={file.name} />;
  }
  if (file.kind === "audio") {
    return <audio className="file-audio" src={url} controls preload="metadata" />;
  }
  if (file.kind === "video") {
    return <video className="file-video" src={url} controls preload="metadata" />;
  }
  // office / archive / anything else: say so plainly instead of pretending, and give the one
  // action that does work — open it with the tool that CAN read it.
  return (
    <div className="tool-note">
      no preview for this type yet ({file.kind})
      <div className="file-fallback">
        <a className="icon-btn" href={url} target="_blank" rel="noopener noreferrer">open in a new tab</a>
      </div>
    </div>
  );
}

/** Text-ish files: markdown is RENDERED (same pipeline as a reply), code/csv/text are shown as
 *  source. `line` (from a `#L12` / `:12` link) starts markdown in source so the pointed-at line
 *  is actually visible, and highlights it wherever source is shown. */
function TextBody({ file, line }: { file: Loaded; line?: number }): JSX.Element {
  const [showSource, setShowSource] = useState(Boolean(line) || file.kind !== "markdown");
  const ref = useRef<HTMLDivElement>(null);
  const mdRef = useRef<HTMLDivElement>(null);

  // A table in a previewed markdown file sorts exactly like one in a reply.
  useEffect(() => {
    if (!showSource) enhanceTables(mdRef.current);
  }, [showSource, file.content]);

  useEffect(() => {
    setShowSource(Boolean(line) || file.kind !== "markdown");
  }, [file.path, file.kind, line]);

  useEffect(() => {
    if (!line || !ref.current) return;
    const el = ref.current.querySelector<HTMLElement>(`[data-line="${line}"]`);
    el?.scrollIntoView({ block: "center" });
  }, [line, showSource, file.content]);

  if (file.binary) return <div className="tool-note">binary file — no preview</div>;

  return (
    <>
      {file.kind === "markdown" ? (
        <div className="file-view-toggle">
          <button className={`tool-tab ${showSource ? "" : "active"}`} onClick={() => setShowSource(false)}>rendered</button>
          <button className={`tool-tab ${showSource ? "active" : ""}`} onClick={() => setShowSource(true)}>source</button>
        </div>
      ) : null}
      {showSource ? (
        <div className="file-source" ref={ref}>
          {file.content.split("\n").map((text, i) => (
            <div className={`file-line ${line === i + 1 ? "hit" : ""}`} key={`${i}-${text}`} data-line={i + 1}>
              <span className="file-ln">{i + 1}</span>
              <span className="file-lt">{text || " "}</span>
            </div>
          ))}
        </div>
      ) : (
        <div
          className="md file-md"
          ref={mdRef}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(file.content, file.path.replace(/\/[^/]*$/, "") || "/") }}
        />
      )}
    </>
  );
}
