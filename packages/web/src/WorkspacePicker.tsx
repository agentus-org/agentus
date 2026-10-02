// Workspace picker for the new-slot dialog: browse the server's directories and pick
// one, instead of typing an absolute path from memory (hermes-studio's FolderPicker
// lineage — its tree is lazy-loaded from a folder endpoint; this is the navigator
// flavour: breadcrumbs + one level at a time, which behaves better on a phone).
//
// The list is directories only, hidden entries are skipped, and everything comes from
// /api/fs/dirs — the same origin the cockpit already trusts with the file system.
import { useEffect, useState } from "react";
import { IconChevronRight, IconFolder, IconHome, IconArrowUp, IconResume } from "./Icons";

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

export function WorkspacePicker({ value, onChange }: { value: string; onChange: (path: string) => void }): JSX.Element {
  const [listing, setListing] = useState<Listing | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = async (path: string): Promise<void> => {
    setBusy(true);
    setErr("");
    try {
      const q = path ? `?path=${encodeURIComponent(path)}` : "";
      const res = await fetch(`/api/fs/dirs${q}`);
      const body = (await res.json().catch(() => ({}))) as Listing & { error?: string };
      if (!res.ok) {
        setErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setListing(body);
      setTyped(body.path);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  // open on the directory the operator is already in (or their home)
  useEffect(() => {
    void load(value || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const crumbs = ((): { label: string; path: string }[] => {
    if (!listing) return [];
    const parts = listing.path.split("/").filter(Boolean);
    const out: { label: string; path: string }[] = [{ label: "/", path: "/" }];
    let acc = "";
    for (const p of parts) {
      acc += `/${p}`;
      out.push({ label: p, path: acc });
    }
    // keep the tail visible; the root chip is always there to get back
    return out.length > 5 ? [out[0], ...out.slice(-4)] : out;
  })();

  return (
    <div className="wp">
      <div className="wp-bar">
        <input
          className="wp-path"
          value={typed}
          spellCheck={false}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void load(typed);
            }
          }}
          placeholder="~/project or /abs/path — Enter to browse"
          aria-label="browse directory"
        />
        <button className="icon-btn" title="home" aria-label="home" disabled={busy} onClick={() => void load(listing?.home ?? "")}>
          <IconHome size={14} />
        </button>
        <button
          className="icon-btn"
          title="parent directory"
          aria-label="parent directory"
          disabled={busy || !listing?.parent}
          onClick={() => listing?.parent && void load(listing.parent)}
        >
          <IconArrowUp size={14} />
        </button>
      </div>

      {crumbs.length > 1 && (
        <div className="wp-crumbs">
          {crumbs.map((c, i) => (
            <span key={c.path}>
              {i > 0 && <IconChevronRight size={11} />}
              <button className="wp-crumb" onClick={() => void load(c.path)} title={c.path}>{c.label}</button>
            </span>
          ))}
        </div>
      )}

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
            title={`use ${d.path}`}
          >
            <IconFolder size={13} />
            <span className="wp-name">{d.name}</span>
            <button
              className="wp-enter"
              title={`open ${d.name}`}
              aria-label={`open ${d.name}`}
              onClick={(e) => { e.stopPropagation(); void load(d.path); }}
            >
              <IconChevronRight size={13} />
            </button>
          </div>
        ))}
        {listing && !listing.entries.length && !err ? (
          <div className="wp-note">no subfolders here — “use this folder” works anyway</div>
        ) : null}
        {listing?.truncated ? <div className="wp-note">list truncated at 300 entries</div> : null}
      </div>

      {listing?.recent?.length ? (
        <div className="wp-recent">
          <span className="wp-recent-label">recent</span>
          {listing.recent.slice(0, 6).map((r) => (
            <button
              key={r}
              className={`wp-chip ${value === r ? "sel" : ""}`}
              title={`use ${r}`}
              onClick={() => onChange(r)}
              onDoubleClick={() => void load(r)}
            >
              {r.split("/").filter(Boolean).pop() ?? r}
            </button>
          ))}
        </div>
      ) : null}

      <div className="wp-picked">
        <button className="wp-use" disabled={!listing} onClick={() => listing && onChange(listing.path)}>
          <IconResume size={12} /> use this folder
        </button>
        <span className="wp-picked-path" title={value || listing?.path}>
          {value || listing?.path || "(none)"}
        </span>
      </div>
    </div>
  );
}
