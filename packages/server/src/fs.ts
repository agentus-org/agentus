// Directory browsing for the new-slot workspace picker.
//
// The operator already has the right to point an agent at any directory (that is the
// product), so this adds no new power — it just makes the choice discoverable instead
// of demanding a path typed from memory. Listing is deliberately narrow: directories
// only, one level at a time, capped, and never followed through symlinks we cannot stat.
import crypto from "node:crypto";
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
  /** how the panel should draw it (see FileKind) */
  kind: FileKind;
  contentType: string;
  mtimeMs: number;
  /** sha1 of the bytes on disk: the editor hands this back on save so a rewrite the agent made
   *  while the operator was typing is refused instead of silently overwritten */
  hash: string;
  editable: boolean;
}

/** What the panel should DRAW for a file. Decided here, once, so the browser does not carry a
 *  second extension table that can drift from this one. */
export type FileKind =
  | "markdown" | "image" | "pdf" | "html" | "csv" | "code" | "text"
  | "audio" | "video" | "office" | "archive" | "binary";

const KIND_BY_EXT: Record<string, FileKind> = {
  md: "markdown", markdown: "markdown", mdx: "markdown",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image",
  bmp: "image", ico: "image", svg: "image", tiff: "image", heic: "image",
  pdf: "pdf",
  html: "html", htm: "html",
  csv: "csv", tsv: "csv",
  // languages the panel can syntax-highlight (the web side has the hljs set; anything not
  // listed still renders as text, which is the honest outcome)
  js: "code", mjs: "code", cjs: "code", jsx: "code", ts: "code", tsx: "code", json: "code",
  py: "code", rb: "code", go: "code", rs: "code", java: "code", c: "code", h: "code",
  cpp: "code", cc: "code", hpp: "code", cs: "code", php: "code", swift: "code", kt: "code",
  sh: "code", bash: "code", zsh: "code", fish: "code", ps1: "code",
  css: "code", scss: "code", less: "code", sql: "code", yml: "code", yaml: "code",
  toml: "code", ini: "code", conf: "code", env: "code", xml: "code", plist: "code",
  dockerfile: "code", gitignore: "code", patch: "code", diff: "code",
  txt: "text", log: "text", text: "text", lock: "text",
  mp3: "audio", wav: "audio", ogg: "audio", m4a: "audio", flac: "audio", aac: "audio", opus: "audio",
  mp4: "video", webm: "video", mov: "video", mkv: "video", m4v: "video",
  docx: "office", doc: "office", xlsx: "office", xls: "office", pptx: "office", ppt: "office",
  odt: "office", ods: "office", odp: "office", rtf: "office",
  zip: "archive", tar: "archive", gz: "archive", bz2: "archive", xz: "archive", "7z": "archive",
};

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml",
  tiff: "image/tiff", heic: "image/heic",
  pdf: "application/pdf",
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8",
  xml: "application/xml; charset=utf-8", svgz: "image/svg+xml",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac",
  aac: "audio/aac", opus: "audio/opus",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska", m4v: "video/mp4",
  txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8", tsv: "text/tab-separated-values; charset=utf-8",
  zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** Extension of a path, lowercased, without the dot. Dotfiles like `.env` report `env`. */
function extOf(target: string): string {
  return path.extname(target).replace(/^\./, "").toLowerCase() || path.basename(target).replace(/^\./, "").toLowerCase();
}

export function fileKind(target: string): FileKind {
  return KIND_BY_EXT[extOf(target)] ?? "text"; // unknown extensions are shown as text, never refused
}

/** Only ever used for `inline` preview; unknown types fall back to a neutral binary type
 *  rather than a wrong one, so the browser does not try to parse e.g. a .dmg as HTML. */
export function contentTypeFor(target: string): string {
  return MIME_BY_EXT[extOf(target)] ?? "application/octet-stream";
}

export interface FileStatInfo {
  path: string;
  name: string;
  /** what the panel should draw for this file (one table, see KIND_BY_EXT) */
  kind: FileKind;
  contentType: string;
  size: number;
  mtimeMs: number;
  hash: string;
  /** the file kind is editable in the panel (text-ish only; binaries are not) */
  editable: boolean;
}

const EDITABLE: ReadonlySet<FileKind> = new Set<FileKind>(["markdown", "text", "code", "csv", "html"]);

function statOrThrow(target: string): fs.Stats {
  try {
    return fs.statSync(target);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new FsError(`no such file: ${target}`, "not_found");
    if (code === "EACCES") throw new FsError(`permission denied: ${target}`, "permission_denied");
    throw new FsError(`cannot read ${target}: ${code ?? String(e)}`, "bad_path");
  }
}

/** sha1 of the file's bytes. Doubles as the "did the file change under the editor?" check, so
 *  a save can refuse to clobber a rewrite the agent made while the operator was typing. */
export function fileHash(target: string): string {
  const h = crypto.createHash("sha1");
  const fd = fs.openSync(target, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

/** Everything the panel needs to decide HOW to draw a file, without reading its bytes. */
export function statFile(input: string | null | undefined): FileStatInfo {
  const target = expandPath(input);
  const st = statOrThrow(target);
  if (st.isDirectory()) throw new FsError(`not a file: ${target}`, "not_a_file");
  const kind = fileKind(target);
  return {
    path: target,
    name: path.basename(target),
    kind,
    contentType: contentTypeFor(target),
    size: st.size,
    mtimeMs: st.mtimeMs,
    hash: fileHash(target),
    editable: EDITABLE.has(kind),
  };
}

export interface WriteResult {
  path: string;
  size: number;
  mtimeMs: number;
  hash: string;
}

const MAX_WRITE_BYTES = 8 * 1024 * 1024;

/** Save a text file the operator edited in the panel.
 *
 *  Deliberate limits: the file must ALREADY exist (this is an editor for files the agent and
 *  the operator are looking at, not a way to create them — a chat window should not be able to
 *  drop new files anywhere the process can write), it must be a text-ish kind, and it must fit
 *  in memory. The write goes through a temp file + rename so a crash mid-save cannot leave a
 *  half-written file where an agent might read it; mode is carried over from the original.
 *
 *  `ifHash` is the hash the editor loaded. When it no longer matches, the agent changed the
 *  file while the operator was typing: a 409 with the current bytes beats silently losing
 *  either side's work. */
export function writeTextFile(
  input: string | null | undefined,
  content: string,
  opts: { ifHash?: string } = {},
): WriteResult {
  const target = expandPath(input);
  const st = statOrThrow(target);
  if (st.isDirectory()) throw new FsError(`not a file: ${target}`, "not_a_file");
  const kind = fileKind(target);
  if (!EDITABLE.has(kind)) {
    throw new FsError(`not an editable file: ${path.basename(target)} (${kind})`, "not_a_file");
  }
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > MAX_WRITE_BYTES) {
    throw new FsError(`content too large (${bytes.length} > ${MAX_WRITE_BYTES})`, "bad_path");
  }
  const before = opts.ifHash ? fileHash(target) : "";
  if (opts.ifHash && opts.ifHash !== before) {
    const cur = readTextFile(target);
    throw new ChangedOnDiskError(target, before, cur.content, cur.truncated);
  }
  const tmp = `${target}.agentus-${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, bytes, { mode: st.mode & 0o7777 });
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* the temp file may never have existed */ }
    throw new FsError(`cannot write ${target}: ${String((e as NodeJS.ErrnoException).code ?? e)}`, "bad_path");
  }
  const after = fs.statSync(target);
  return { path: target, size: after.size, mtimeMs: after.mtimeMs, hash: fileHash(target) };
}

/** The operator's buffer is based on bytes that no longer exist on disk. Carries the CURRENT
 *  content so the panel can offer "reload theirs" without a second round trip. */
export class ChangedOnDiskError extends FsError {
  constructor(
    readonly target: string,
    readonly currentHash: string,
    readonly currentContent: string,
    readonly truncated: boolean,
  ) {
    super("changed_on_disk", "bad_path");
  }
}

const DEFAULT_PREVIEW_BYTES = 256 * 1024;

/** Read a file for the workspace panel.
 *
 *  This used to be read-only on the reasoning that "writing files is the agent's job, not the
 *  cockpit's". The operator overruled that (2026-10-09: 「可编辑一起搞吧」) and it is his call — a
 *  cockpit where he can fix a line of markdown without leaving for an editor is the point. So
 *  the read now also reports what the panel needs to EDIT safely (`hash`, `editable`), and
 *  `writeTextFile` below does the saving. Reading is still capped and still refuses to guess at
 *  binaries. */
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
    const kind = fileKind(target);
    return {
      path: target,
      name: path.basename(target),
      size: st.size,
      content: binary ? "" : buf.toString("utf8"),
      truncated: st.size > len,
      binary,
      kind,
      contentType: contentTypeFor(target),
      mtimeMs: st.mtimeMs,
      hash: fileHash(target),
      editable: EDITABLE.has(kind),
    };
  } finally {
    fs.closeSync(fd);
  }
}
