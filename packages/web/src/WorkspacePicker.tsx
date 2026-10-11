// Workspace picker for the new-slot dialog: browse the server's directories and pick
// one, instead of typing an absolute path from memory (hermes-studio's FolderPicker
// lineage — its tree is lazy-loaded from a folder endpoint; this is the navigator
// flavour: one level at a time, which behaves better on a phone).
//
// The list is directories only, hidden entries are skipped, and everything comes from
// /api/fs/dirs — the same origin the cockpit already trusts with the file system.
//
// The layout rule (operator, 2026-10-11: 「选定的路径显示是不是统一在输入栏哪里呢，为啥最下面有一个，
// 然后候选项和地址栏中间又有一个」): the CHOSEN path is displayed in ONE place — the field at the top,
// which is also the thing you edit. There used to be three: the field (holding the BROWSED directory),
// a breadcrumb strip between the field and the list, and a "selected" line at the bottom — the same
// fact three times, on a form that has to fit one phone screen. Now the breadcrumbs and the bottom
// line are gone, and browsing does not move the field: the LIST shows where you are, the FIELD shows
// what the session will be created in.
import { useEffect, useState } from "react";
import { IconChevronRight, IconFolder, IconHome, IconArrowUp } from "./Icons";

interface DirEntry {
  name: string;
  path: string;
}

interface Listing {
  path: string;
  parent: string | null;
  home: string;
  entries: DirEntry[];
  truncated: boolean;
  recent: string[];
}

/** How many one-tap shortcuts stand above the folder list. The operator asked for six (2026-10-11:
 *  「常用候选目录改多一点吧，改个 6 个…你改紧凑、改小一点」); the server sends up to eight, so the
 *  ceiling is ours. */
const RECENT_CHIPS = 6;

export function WorkspacePicker({ value, onChange }: { value: string; onChange: (path: string) => void }): JSX.Element {
  const [listing, setListing] = useState<Listing | null>(null);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const fetchDirs = async (path: string): Promise<Listing> => {
    const q = path ? `?path=${encodeURIComponent(path)}` : "";
    const res = await fetch(`/api/fs/dirs${q}`);
    const body = (await res.json().catch(() => ({}))) as Listing & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body;
  };

  const load = async (path: string, adopt = false): Promise<void> => {
    setBusy(true);
    setErr("");
    try {
      const body = await fetchDirs(path);
      setListing(body);
      if (!adopt) return;
      // Nothing is chosen yet (the 「新会话」 button passes no directory): arrive with a REAL one
      // instead of an empty field and a dead launch button. The source is the picker's own shortcut
      // list — the directory of the most recent session, which is what the old form effectively
      // offered through its first chip — and the listing follows it, so the field and the list can
      // never disagree about where this session will run. One tap still changes it.
      const pick = body.recent?.[0] || body.path;
      if (!pick) return;
      onChange(pick);
      if (pick !== body.path) setListing(await fetchDirs(pick));
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  // open on the directory the operator is already in (or their home), choosing it if nothing is chosen
  useEffect(() => {
    void load(value || "", !value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The field MIRRORS the choice — the dialog owns it — so a pick made anywhere (a chip, a row, the
  // caller restoring a stored workspace) lands in the one place that displays it.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  /** Take the directory in the field, and move the listing to it so the choice is visible. */
  const commit = (path: string): void => {
    const clean = path.trim();
    if (!clean) return;
    onChange(clean);
    void load(clean);
  };

  return (
    <div className="wp">
      {/* One bar does the work: the chosen path (editable; Enter or 「选中」 takes it), home, parent. */}
      <div className="wp-bar">
        <input
          className="wp-path"
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit(draft);
            }
          }}
          placeholder="~/project — Enter 选中"
          aria-label="选中的工作目录"
        />
        <button
          className="wp-use"
          disabled={busy || !draft.trim() || draft.trim() === value}
          title="选中这个目录"
          onClick={() => commit(draft)}
        >
          选中
        </button>
        <button className="icon-btn" title="home" aria-label="home" disabled={busy} onClick={() => void load(listing?.home ?? "")}>
          <IconHome size={14} />
        </button>
        <button
          className="icon-btn"
          title="上一级目录"
          aria-label="上一级目录"
          disabled={busy || !listing?.parent}
          onClick={() => listing?.parent && void load(listing.parent)}
        >
          <IconArrowUp size={14} />
        </button>
      </div>

      {listing?.recent?.length ? (
        <div className="wp-recent">
          {listing.recent.slice(0, RECENT_CHIPS).map((r) => (
            <button
              key={r}
              className={`wp-chip ${value === r ? "sel" : ""}`}
              title={`选中 ${r}`}
              onClick={() => commit(r)}
            >
              {r.split("/").filter(Boolean).pop() ?? r}
            </button>
          ))}
        </div>
      ) : null}

      <div className="wp-list" role="listbox" aria-label="folders">
        {busy && !listing ? <div className="wp-note">loading…</div> : null}
        {err ? <div className="wp-note err">{err}</div> : null}
        {listing?.entries.map((d) => (
          <div
            key={d.path}
            role="option"
            aria-selected={value === d.path}
            className={`wp-row ${value === d.path ? "sel" : ""}`}
            onClick={() => onChange(d.path)}
            title={`选中 ${d.path}`}
          >
            <IconFolder size={13} />
            <span className="wp-name">{d.name}</span>
            <button
              className="wp-enter"
              title={`进入 ${d.name}`}
              aria-label={`进入 ${d.name}`}
              onClick={(e) => { e.stopPropagation(); void load(d.path); }}
            >
              <IconChevronRight size={13} />
            </button>
          </div>
        ))}
        {listing && !listing.entries.length && !err ? (
          <div className="wp-note">这里没有子目录 —— 点这一行就是选中它</div>
        ) : null}
        {listing?.truncated ? <div className="wp-note">只列出前 300 项</div> : null}
      </div>
    </div>
  );
}
