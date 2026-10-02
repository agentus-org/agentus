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
  /** "dir" for directories, "file" for everything else the panel can show */
  kind: "dir" | "file";
  /** bytes, files only (the panel prints a human size) */
  size?: number;
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
  constructor(message: string, readonly code: "not_found" | "not_a_directory" | "not_a_file" | "permission_denied" | "bad_path") {
    super(message);
  }
}

export function listDirs(input: string | null | undefined, opts: { includeFiles?: boolean } = {}): DirListing {
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
    const full = path.join(target, d.name);
    let isDir = d.isDirectory();
    // a symlink to a directory is a normal way to organise work: stat it
    if (!isDir && d.isSymbolicLink()) {
      try {
        isDir = fs.statSync(full).isDirectory();
      } catch {
        continue; // dangling symlink or unreadable target: skip
      }
    }
    if (isDir) {
      entries.push({ name: d.name, path: full, kind: "dir" });
      continue;
    }
    // The file panel (head ▤) wants files too; the picker (new slot) must not
    // offer one as a working directory, so it stays opt-in.
    if (opts.includeFiles && !d.isSymbolicLink()) {
      let size: number | undefined;
      try {
        size = fs.statSync(full).size;
      } catch {
        /* unreadable: still list it, size unknown */
      }
      entries.push({ name: d.name, path: full, kind: "file", size });
    }
  }
  entries.sort((a, b) => (
    a.kind === b.kind
      ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
      : a.kind === "dir" ? -1 : 1  // directories first, like every file manager
  ));

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

export interface FilePreview {
  path: string;
  name: string;
  size: number;
  /** decoded utf-8 text, cut at maxBytes (the tail is reported, never faked) */
  content: string;
  truncated: boolean;
  /** looks like binary: the panel shows a "cannot preview" note instead of mojibake */
  binary: boolean;
}

const DEFAULT_PREVIEW_BYTES = 256 * 1024;

/** Read a file for the workspace panel. Read-only on purpose: this panel is a
 *  browser, not an editor — writing files is the agent's job, not the cockpit's. */
export function readTextFile(input: string, opts: { maxBytes?: number } = {}): FilePreview {
  const target = expandPath(input);
  const maxBytes = Math.max(1024, opts.maxBytes ?? DEFAULT_PREVIEW_BYTES);
  let st: fs.Stats;
  try {
    st = fs.statSync(target);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new FsError(`no such file: ${target}`, "not_found");
    if (code === "EACCES") throw new FsError(`permission denied: ${target}`, "permission_denied");
    throw new FsError(`cannot read ${target}: ${code ?? String(e)}`, "bad_path");
  }
  if (st.isDirectory()) throw new FsError(`not a file: ${target}`, "not_a_file");
  const fd = fs.openSync(target, "r");
  try {
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    // A NUL byte in the first 8KB is the classic binary tell.
    const binary = buf.subarray(0, Math.min(buf.length, 8192)).includes(0);
    return {
      path: target,
      name: path.basename(target),
      size: st.size,
      content: binary ? "" : buf.toString("utf8"),
      truncated: st.size > len,
      binary,
    };
  } finally {
    fs.closeSync(fd);
  }
}
