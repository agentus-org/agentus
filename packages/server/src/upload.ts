// Multipart attachment upload helpers (issue #113). The browser's FormData is the only producer:
// one file part, so a small boundary splitter is enough — no dependency on a multipart library.
// The bytes land on disk; the message that references them carries a path, never the bytes.
import { randomBytes } from "node:crypto";
import path from "node:path";

export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** HERMES_MAX_UPLOAD_SIZE is a byte count; `50mb` / `512k` shorthands are accepted too.
 *  A malformed or non-positive value falls back to the default rather than opening the door wide. */
export function maxUploadBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = String(env.HERMES_MAX_UPLOAD_SIZE ?? "").trim();
  if (!raw) return DEFAULT_MAX_UPLOAD_BYTES;
  const m = /^(\d+)\s*(mb|m|kb|k|b)?$/i.exec(raw);
  if (!m) return DEFAULT_MAX_UPLOAD_BYTES;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_UPLOAD_BYTES;
  const unit = (m[2] ?? "b").toLowerCase();
  const mult = unit.startsWith("m") ? 1024 * 1024 : unit.startsWith("k") ? 1024 : 1;
  return n * mult;
}

/** The display name kept in the message: basename only, no control chars, bounded. Unicode kept. */
export function safeUploadName(name: string): string {
  const base = String(name ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
  return cleaned || "attachment";
}

/** The on-disk name: random prefix + ASCII-only basename. file.name is NEVER used as a path. */
export function diskFileName(name: string): string {
  const stem = safeUploadName(name).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 80) || "file";
  return `${randomBytes(8).toString("hex")}-${stem}`;
}

/** Where an attachment lands: under the instance data dir, scoped to the session. */
export function uploadDir(dataDir: string, sessionId?: string | null): string {
  const seg = String(sessionId ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "global";
  return path.join(dataDir, "uploads", seg);
}

export interface MultipartFile { name: string; bytes: Buffer; mimeType?: string }

/** Minimal single-file multipart/form-data reader. Header bytes are UTF-8 (browsers send the
 *  filename unescaped), body bytes are kept verbatim so binary files are not mangled. */
export function parseMultipart(buf: Buffer, contentType: string): MultipartFile | null {
  const m = /^multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return null;
  const marker = Buffer.from(`--${m[1] || m[2].trim()}`);
  let pos = buf.indexOf(marker);
  while (pos !== -1) {
    const headStart = pos + marker.length;
    if (buf.subarray(headStart, headStart + 2).toString() === "--") break; // closing boundary
    const headEnd = buf.indexOf("\r\n\r\n", headStart);
    if (headEnd === -1) return null;
    const header = buf.subarray(headStart, headEnd).toString("utf8");
    const fn = /filename="([^"]*)"/i.exec(header) ?? /filename=([^;\r\n]+)/i.exec(header);
    const next = buf.indexOf(marker, headEnd + 4);
    if (next === -1) return null;
    if (fn) {
      let end = next;
      if (buf[end - 2] === 13 && buf[end - 1] === 10) end -= 2;
      const mime = /^content-type:\s*([^\r\n;]+)/im.exec(header)?.[1]?.trim();
      return { name: fn[1], bytes: buf.subarray(headEnd + 4, end), mimeType: mime };
    }
    pos = next;
  }
  return null;
}
