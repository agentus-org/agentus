// Issue #113, frontend half. A >256kB non-image file must become a LINK draft, travel as an ACP
// resource_link (name + uri, NO inline body), and the old image/text shapes must be byte-for-byte
// unchanged. Pure functions only — the real HTTP half is covered by attach-upload-sweep.mts.
//
//   npx tsx scripts/qa/attach-draft-units.mts
import {
  MAX_TEXT_BYTES, attachmentError, draftToAttachment, linkDraft, needsPathUpload, uploadAttachment,
} from "../../packages/web/src/attachmentDraft.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const show = (v: unknown): string => JSON.stringify(v);

// ── the 256kB decision (image uses its own 4MB channel, never this one) ────────────────────────
check("threshold is 256kB", MAX_TEXT_BYTES === 256 * 1024, String(MAX_TEXT_BYTES));
check("300kB CSV must take the path channel", needsPathUpload({ type: "text/csv", size: 300 * 1024 }));
check("256kB exactly stays inline (boundary unchanged)", !needsPathUpload({ type: "text/csv", size: MAX_TEXT_BYTES }));
check("256kB + 1 takes the path channel", needsPathUpload({ type: "text/csv", size: MAX_TEXT_BYTES + 1 }));
check("small text stays inline", !needsPathUpload({ type: "text/plain", size: 1024 }));
check("images are never routed through the path channel", !needsPathUpload({ type: "image/png", size: 5 * 1024 * 1024 }));

// ── link draft -> resource_link block, with no inline body ────────────────────────────────────
const saved = { name: "big.csv", path: "/data/uploads/sess-113/ab12-big.csv" };
const link = linkDraft({ name: "big.csv", type: "text/csv", size: 300 * 1024 }, saved);
const linkAtt = draftToAttachment(link);
check("link draft has kind=link", link.kind === "link", show(link));
check("a link draft becomes {kind:link, uri, name}", show(linkAtt) === show({ kind: "link", uri: saved.path, name: "big.csv" }), show(linkAtt));
check("link carries NO inline body field", !("text" in linkAtt) && !("payload" in linkAtt) && !("data" in linkAtt), show(linkAtt));
check("link block is small (no 300kB inlined)", JSON.stringify(linkAtt).length < 300, String(JSON.stringify(linkAtt).length));

// ── regressions: image and text drafts map exactly as before ──────────────────────────────────
const textDraft = { id: "t", name: "notes.md", kind: "text" as const, mimeType: "text/markdown", payload: "# hi\n附件正文", bytes: 9 };
check("text attachment shape unchanged", show(draftToAttachment(textDraft)) === show({ kind: "text", name: "notes.md", text: textDraft.payload }), show(draftToAttachment(textDraft)));
const imageDraft = { id: "i", name: "shot.png", kind: "image" as const, mimeType: "image/png", payload: "aGVsbG8=", preview: "data:image/png;base64,aGVsbG8=", bytes: 5 };
check("image attachment shape unchanged", show(draftToAttachment(imageDraft)) === show({ kind: "image", mimeType: "image/png", data: "aGVsbG8=", name: "shot.png" }), show(draftToAttachment(imageDraft)));

// ── a refusal must point at a channel that actually exists ────────────────────────────────────
const err = attachmentError("big.csv", "HTTP 413 file too large");
check("refusal names the file and a real channel (workspace + path)", err.includes("big.csv") && err.includes("工作区") && err.includes("路径"), err);
check("refusal no longer points at the dead end", !err.includes("attach it as a path instead"), err);

// ── the browser's multipart POST (injectable fetch, no browser needed) ────────────────────────
const file = new File(["x"], "big.csv", { type: "text/csv" });
let seenUrl = "", seenInit: RequestInit | undefined;
const okFetch = async (url: string | URL | Request, init?: RequestInit) => {
  seenUrl = String(url); seenInit = init;
  return { ok: true, json: async () => ({ name: "big.csv", path: saved.path }) } as Response;
};
// The production signature's third argument is an injectable fetch.
const r = await uploadAttachment(file, "sess-113", okFetch as typeof fetch);
check("upload posts to /api/upload scoped to the session", seenUrl.includes("/api/upload") && seenUrl.includes("sessionId=sess-113"), seenUrl);
check("upload uses POST with a FormData body", seenInit?.method === "POST" && seenInit?.body instanceof FormData, String(seenInit?.method));
check("upload returns {name, path}", r.path === saved.path && r.name === "big.csv", show(r));
let thrown = "";
try {
  await uploadAttachment(file, undefined, (async () => ({ ok: false, status: 413, json: async () => ({ error: "file too large" }) }) as Response) as typeof fetch);
} catch (e) { thrown = (e as Error).message; }
check("upload surfaces the server's reason on failure", thrown.includes("file too large"), thrown);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
