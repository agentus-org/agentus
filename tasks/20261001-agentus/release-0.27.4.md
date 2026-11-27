## Fixes

- Resuming a busy session no longer fails with `session_busy` when another window holds the turn. Stop-and-take-over can wake the slot, deliver the cancel, and complete again.
- Sessions created by older releases are healed on the next idle resume: the plan MCP token is rebound to the session's stable token instead of staying frozen at a random value.
- Manual session labels survive a resume. A session dragged to Done or To Do no longer falls back to Unclassified when its agent process is restarted.
- Forked sessions now receive their own plan-token identity instead of inheriting the parent's.

## Notes

- Install: `npx hermes-studio@0.27.4` or `npm i -g hermes-studio@0.27.4`.
- Fork build: `studio/v0.23.0/merge-20261124-1432` on LiangYang666/hermes-agent — unchanged in this release; no new fork build was produced.
- Session labels are never inferred or migrated. If you upgraded from v0.27.1 or older and skipped v0.27.2, any sessions that had been auto-labelled In Progress by the old migration keep that label; reset them yourself by dragging the card or using `session stage`. This is deliberate: no release rewrites operator labels.
- Full changelog: https://github.com/hermes-studio-org/hermes-studio/compare/v0.27.3...v0.27.4

## Upgrading

This release changes `packages/server`. Restart `:8788` to activate it; running slots disconnect and resume automatically. A hard refresh is required to load the corrected front-end bundle.
