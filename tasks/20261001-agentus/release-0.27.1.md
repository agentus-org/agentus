## Highlights

- Session lists now ship a lightweight summary for stopped sessions, cutting the `/api/sessions` response by more than 90% on installations with a long session history.
- Opening a session still renders its transcript immediately: the full session snapshot is fetched in the background and never blocks the click.

## Changes

- Stopped and archived sessions no longer carry the full ACP handshake snapshot (`configOptions`, `commands`, `modes`, `usage`, `models`) in list responses or WebSocket session broadcasts. All fields remain present with empty values so existing renderers stay safe; the model chosen for a stopped slot is preserved for resume.
- Add `GET /api/sessions/:id/detail` to fetch the full row for a stopped or archived session when it is opened. The view renders from the summary first and merges only the snapshot fields afterwards.
- Session frames received over WebSocket keep an already-loaded detail snapshot, so a background update no longer blanks the model and effort controls. Rows that become live drop the cached detail and use their own fresh snapshot.

## Fixes

- Manager-side session broadcasts are trimmed with the same rules as the REST endpoint, preventing every status change from re-broadcasting the oversized list.
- A detail response captured before a resume can no longer overwrite live process state; only snapshot fields are merged, guarded by a status/pid generation check.
- Archived sessions whose process is still running keep their full snapshot instead of being mistaken for stopped rows.
- The remembered context window is restored with the detail snapshot, while a freshly selected pending model is no longer overwritten by a stale cached value.

## Notes

- Install: `npx hermes-studio@0.27.1` or `npm i -g hermes-studio@0.27.1`.
- Fork build: `studio/v0.23.0/merge-20261124-1432` on LiangYang666/hermes-agent — unchanged in this release; no new fork build was produced.
- Measured on a 29-stopped-session dataset: list payload 191,785 B → 14,265 B (-92.6%); with the detail endpoint artificially delayed by 5 s, the transcript still rendered 117 ms after the click.
- Full changelog: https://github.com/hermes-studio-org/hermes-studio/compare/v0.27.0...v0.27.1

## Upgrading

This release changes `packages/server` and `packages/shared`. Restart `:8788` to activate it; running slots disconnect and resume automatically. Without the restart the old list payload is still served and the new detail endpoint is absent. A hard refresh is required to load the new front-end bundle.
