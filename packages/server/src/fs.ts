// Directory browsing for the new-slot workspace picker.
//
// The operator already has the right to point an agent at any directory (that is the
// product), so this adds no new power — it just makes the choice discoverable instead
// of demanding a path typed from memory. Listing is deliberately narrow: directories
// only, one level at a time, capped, and never followed through symlinks we cannot stat.
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListing {
  /** the directory that was listed (absolute, symlink-resolved) */
  path: string;
  /** parent directory, or null at the root */
  parent: string | null;
  home: string;
  entries: DirEntry[];
  /** hit the entry cap — the UI says so instead of pretending the list is complete */
  truncated: boolean;
}

const MAX_ENTRIES = 300;

/** `~`, `~/x`, relative and absolute all land on an absolute path. */
export function expandPath(input: string | null | undefined): string {
  const raw = String(input ?? "").trim();
  if (!raw) return homedir();
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return path.resolve(path.join(homedir(), raw.slice(2)));
  return path.resolve(raw);
}

export class FsError extends Error {
  constructor(message: string, readonly code: "not_found" | "not_a_directory" | "permission_denied" | "bad_path") {
    super(message);
  }
}

export function listDirs(input: string | null | undefined): DirListing {
  const target = expandPath(input);
  let st: fs.Stats;
  try {
    st = fs.statSync(target); // stat (not lstat): a symlinked workspace should work
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new FsError(`no such directory: ${target}`, "not_found");
    if (code === "EACCES") throw new FsError(`permission denied: ${target}`, "permission_denied");
    throw new FsError(`cannot read ${target}: ${code ?? String(e)}`, "bad_path");
  }
  if (!st.isDirectory()) throw new FsError(`not a directory: ${target}`, "not_a_directory");

  let names: fs.Dirent[] = [];
  try {
    names = fs.readdirSync(target, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EACCES") throw new FsError(`permission denied: ${target}`, "permission_denied");
    throw new FsError(`cannot list ${target}: ${code ?? String(e)}`, "bad_path");
  }

  const entries: DirEntry[] = [];
  for (const d of names) {
    // Hidden directories are the bulk of a home directory and almost never the answer;
    // the path input still accepts them when someone really wants one.
    if (d.name.startsWith(".")) continue;
    if (d.isDirectory()) {
      entries.push({ name: d.name, path: path.join(target, d.name) });
      continue;
    }
    // a symlink to a directory is a normal way to organise work: stat it
    if (d.isSymbolicLink()) {
      try {
        if (fs.statSync(path.join(target, d.name)).isDirectory()) {
          entries.push({ name: d.name, path: path.join(target, d.name) });
        }
      } catch {
        /* dangling symlink or unreadable target: skip */
      }
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

  const truncated = entries.length > MAX_ENTRIES;
  const trimmed = truncated ? entries.slice(0, MAX_ENTRIES) : entries;
  const parent = path.dirname(target);
  return {
    path: target,
    parent: parent === target ? null : parent,
    home: homedir(),
    entries: trimmed,
    truncated,
  };
}
