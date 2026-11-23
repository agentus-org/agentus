## Highlights

- Files larger than 256kB are no longer a dead end. Non-image files now upload to a session-scoped directory on disk and travel to the agent as an ACP `resource_link` path reference instead of being refused — a 300kB CSV reaches the agent without inflating the transcript.
- The bundled Hermes fork build fixes a stale-history bug on `conversation` / `previous_response_id` API chains: queued turns no longer repeat the previous answer or re-compress an already-compressed transcript after an SSE interrupt.

## Changes

- Add `POST /api/upload` (multipart, behind the existing API auth gate): default 50MB limit, configurable with `HERMES_MAX_UPLOAD_SIZE`, randomized filenames and path-traversal protection; files land in `<data dir>/uploads/<sessionId>/`.
- Composer attachments that exceed the 256kB inline limit now produce a `link` attachment (the previously-unused third `PromptAttachment` variant); the acceptance message now points at a real channel instead of a nonexistent "attach as path" action.
- Small (<256kB) text attachments and image attachments keep their existing wire shapes and behaviour unchanged.

## Fixes

- Fork build: ResponseStore snapshots taken at admission are dropped at execution time so a queued turn reads the settled transcript; a per-session carrier key preserves the snapshot where the transcript cannot carry prefix rows (new-generation chains, client-owned history, multi-item input).

## Notes

- Install: `npx hermes-studio@0.26.0` or `npm i -g hermes-studio@0.26.0`.
- Fork build: `studio/v0.23.0/merge-20261123-2240` on LiangYang666/hermes-agent — required for the resource_link file path to be read back into the prompt and for the stale-history fix; without it a large attachment path would be a dead reference and queued API turns would keep repeating.
- Full changelog: https://github.com/hermes-studio-org/hermes-studio/compare/v0.25.1...v0.26.0

## Upgrading

This release changes `packages/server` (new upload endpoint). Restart `:8788` to activate it; in-running slots disconnect and resume automatically. Without the restart, large-file uploads return 404.

---

Release readback (internal, not part of the public notes):
- fork tag: studio/v0.23.0/merge-20261123-2240 (64b5826d0c), fork Release created (non-draft)
- studio tag: v0.26.0 -> 62e9b28 (annotated)
- npm shasum: 640f5b181bd99ab0e22cb8305a4dffb9a1690e27 (matches publish output, staged ~6min)
- CI: 45197063860 success (head 62e9b28)
- gate: 13 passed, 0 failed, 1 warnings GREEN
- package-smoke: PASS
- live: needs restart :8788 to activate the new upload endpoint (346dddf is in tag, not promoted yet)
- issues closed: #113, #114
