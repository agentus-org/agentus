## Highlights

- Sessions can now be sorted into four hand-set labels — Unclassified, To do, In progress, Done — directly in the session rail. Nothing moves a label automatically: only a drag, the context menu, or an explicit CLI call changes it.
- The rail's 工作空间 section is now 会话, with a workspace/label switch at its head. Label grouping keeps all four groups visible as drop targets and collapses Done by default.

## Changes

- Add a `stage` label to each session, stored server-side in `sessions.stage` / `stage_source` / `stage_at` with a one-time migration for existing rows. New sessions start as Unclassified; the migration file carries the rationale and is idempotent.
- Add `POST /api/sessions/:id/stage` (rail drag, `source=manual`) and `POST /api/cockpit/stage` (CLI / agent-initiated, `source=cli`). Both validate the value and write the same row; neither touches the agent process or transcript.
- Add `hermes-studio session stage <id> <unclassified|todo|doing|done>` and a label column in `session list --table`. `todo` is accepted as a compatibility alias and stored as the real To do group.
- Label mode supports a floating card that follows the pointer during a drag, a highlighted drop target, and a context-menu label row with the current group highlighted. A first-time hint explains the two ways to change a label and closes only when the operator acknowledges it.
- The label grouping choice is a per-device view preference; the label itself is shared server-side across desktop and phone.

## Fixes

- Dragging a session no longer selects the session names along the way: label-mode rows disable text selection, the drag start clears any existing selection, and a body-level guard prevents selection while the pointer is down.

## Notes

- Install: `npx hermes-studio@0.27.0` or `npm i -g hermes-studio@0.27.0`.
- Fork build: `studio/v0.23.0/merge-20261124-1432` on LiangYang666/hermes-agent — unchanged in this release; no new fork build was produced.
- Full changelog: https://github.com/hermes-studio-org/hermes-studio/compare/v0.26.2...v0.27.0

## Upgrading

This release changes `packages/server` and `packages/shared` (new columns, migration, and stage endpoints). Restart `:8788` to activate it; running slots disconnect and resume automatically. Without the restart the stage endpoints are absent and label changes fail. A hard refresh is required to load the new front-end bundle.
