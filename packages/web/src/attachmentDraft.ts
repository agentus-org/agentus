// Attachment draft shapes and the wire mapping shared by both composers (issue #113).
// Kept pure so the 256kB decision and the three attachment shapes can be tested without a browser.
import type { PromptAttachment } from "../../shared/src/index";

export interface Draft {
  id: string;
  name: string;
  kind: "image" | "text" | "link";
  mimeType: string;
  /** data: URL for the thumbnail (images only) */
  preview?: string;
  /** base64 payload for images, raw text for text files, empty for links */
  payload: string;
  bytes: number;
  /** path returned by /api/upload — the message carries this, never the bytes */
  uri?: string;
}

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_TEXT_BYTES = 256 * 1024;

/** What the box holds, in wire shape. The image/text branches are unchanged from #17/#31;
 *  link is the third (already-declared) PromptAttachment variant the UI never produced. */
export function draftToAttachment(d: Draft): PromptAttachment {
  if (d.kind === "image") return { kind: "image", mimeType: d.mimeType, data: d.payload, name: d.name };
  if (d.kind === "link") return { kind: "link", uri: d.uri ?? "", name: d.name };
  return { kind: "text", name: d.name, text: d.payload };
}

/** >256kB non-images go through /api/upload; images keep their own 4MB base64 channel. */
export function needsPathUpload(file: { type: string; size: number }): boolean {
  return !IMAGE_TYPES.includes(file.type) && file.size > MAX_TEXT_BYTES;
}

export function linkDraft(file: { name: string; type: string; size: number }, saved: { name: string; path: string }): Draft {
  return {
    id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 7)}`,
    name: file.name,
    kind: "link",
    mimeType: file.type || "application/octet-stream",
    payload: "",
    bytes: file.size,
    uri: saved.path,
  };
}

/** A refusal has to name a channel that exists. "attach it as a path instead" pointed at nothing;
 *  the workspace plus a path reference is real and needs no server feature at all. */
export function attachmentError(name: string, reason: string): string {
  const why = String(reason ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  return `${name}: 上传失败${why ? `（${why}）` : ""}。可改用真实通道：把文件放进会话工作区，在消息里引用它的路径。`;
}

/** Browser half of the upload. Same-origin cookie (or bearer set by the page) is sent like any
 *  other /api call; the server's own auth gate does the rest. */
export async function uploadAttachment(
  file: File,
  sessionId?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ name: string; path: string }> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  const r = await fetchImpl(`/api/upload${q}`, { method: "POST", body: fd, credentials: "same-origin" });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const b = await r.json() as { error?: unknown }; if (typeof b?.error === "string") msg = b.error; }
    catch { /* keep the status */ }
    throw new Error(msg);
  }
  const b = await r.json() as { name?: unknown; path?: unknown };
  if (typeof b?.path !== "string") throw new Error("server returned no path");
  return { name: typeof b.name === "string" ? b.name : file.name, path: b.path };
}
