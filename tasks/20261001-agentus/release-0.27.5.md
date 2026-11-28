## Highlights

- Route cross-session dispatch, completion notices, and live-call boundaries through the Hermes `surface_v1` sidecar so durable transcripts keep only the operator's own words.
- Remove repeated full-table scans from session listing and stop service restarts from marking idle sessions as errors.
- Show a live microphone level in the dictation chip, with silent input rendered as a flat trace.

## Changes

### Surface-v1 metadata transport (#120)

Cross-session dispatch, completion notices, and call-boundary instructions were previously assembled into ACP text or resource blocks. Hermes treated those blocks as user utterances: they were persisted in the transcript, used to derive session titles, and forwarded to external memory sync.

Studio now sends provenance and system instructions in `_meta.hermesStudio` surfaces: `studio-dispatch` for handoff and delegation, `studio-completion` for completion notices, and `voice-live` with a `studio_context` note for calls. ACP text carries the operator's original words only; completion turns carry an empty body. The Hermes fork admits these fields into `surface_v1` notes on the `api_content` sidecar. System deliveries skip title derivation and external memory sync. Handoff envelopes are kept in Studio's local transcript but no longer reach the agent as user text.

Capability negotiation is explicit. The fork advertises `initialize.agentCapabilities._meta.hermesStudio.surfaceV1`; Studio refuses a surface turn against an older backend with `SURFACE_UNSUPPORTED` instead of silently dropping a completion or call boundary. The fork persistence rule now accepts a string override for plain-text list content while still protecting native image/audio content and compaction summaries.

### Session listing (#119)

`GET /api/sessions` built each row by calling full-table `lastActivityAt()` and `maxSeq()` helpers. On the reported 211-session workload this produced roughly 1,260 repeated scans per request. Listing now snapshots both values once, paginates before constructing DTOs, and passes the snapshot through every multi-row call site. The earlier cold-row trim remains in place; this change removes the remaining per-row work.

### Restart ownership (#118)

`reclaimOrphans()` marked every row whose owning process had disappeared as `error` with a close timestamp. A service restart takes down its own idle child processes, so healthy idle sessions were reported as failed. Reclaim now distinguishes a normal service generation change from an abnormal exit: idle rows fall back to `reaped`/cold without a close timestamp; running rows and handshakes that never obtained an ACP session id remain errors with a recoverable reason.

### Voice input level

The dictation chip now renders the measured microphone level from the existing stream meter. Silence renders as a flat trace; speech produces a rising trace. The indicator is isolated per composer, respects the active theme cache, and clears residual level on stop. Backends without a level signal are called out explicitly instead of showing a simulated waveform.

## Fixes

- Completion receipts no longer appear as `[Image attachment]` in direct ACP transcript views.
- Oversized `studio_context` payloads are clipped before JSON serialisation, so the note never ends in a broken JSON fragment.
- Old backends that ignore `_meta` are rejected on surface turns; the error is routed to the lost-turn recovery path and returned to the composer.
- Empty cold pages in the session-list QA sweep assert their `omitted` field, closing the R2 review gap.

## Notes

- Install: `npx hermes-studio@0.27.5` or `npm i -g hermes-studio@0.27.5`.
- Fork build: `studio/v0.23.0/merge-20261124-1432` on `LiangYang666/hermes-agent` — **unchanged in this release**; no new fork tag was produced. The surface-v1 transport is developed on `fix/v0.23.0/surface-v1-injection` (`99d5201214`, pushed as a feature branch only; upstream PR pending). The pinned fork build does not contain it.
- Verification: fork `scripts/run_tests.sh` 7 files / 348 tests passed / 0 failed; Studio `typecheck`, `build`, `voice-mode-sweep` 42/42, `surface-injection-sweep` 12/12, `voice-mode-call-sweep` 35/35, `reply-on-done` 36/36, smoke 88 checks, auth/package smoke PASS, `sessions-list-perf` 12/12, `reclaim-owner-sweep` 20/20.
- End-to-end: three real dev paths passed — dispatch kept the original task text in `content` with the provenance note only in `api_content`; completion kept an empty `content` with a system-delivery notice; call mode kept the spoken text in `content` with the boundary note in `api_content`. A temporary Hindsight bank confirmed the injected notes did not enter long-term memory.
- Full changelog: https://github.com/hermes-studio-org/hermes-studio/compare/v0.27.4...v0.27.5

## Upgrading

This release changes `packages/server`, so the `:8788` service must be restarted before the Studio side takes effect. Running slots disconnect and resume automatically; a hard refresh is required to load the new web bundle (`index-ClBLL1sl.js`).

The surface-v1 transport also requires a Hermes fork that advertises `hermesStudio.surfaceV1`. Restarting Studio alone is not sufficient: the Hermes gateway/tree must be moved to the surface-v1 fork build as well. Until both sides are active, dispatch, completion, and voice turns are rejected with `SURFACE_UNSUPPORTED` rather than being silently misrouted.

---

发布回读（内部记录，不进入 Release 页面）：

- tag:
- tag object:
- npm shasum:
- CI:
- 闸门:
- Release:
