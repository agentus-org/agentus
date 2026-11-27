## Fixes

- The session stage no longer runs any automatic backfill or repair pass. New sessions are filed under Unclassified when they are created, and legacy rows with no stage are shown as Unclassified by the rail. Nothing infers a label from whether a conversation has a transcript.
- Existing hand-set labels are unchanged. This release only removes the migration code; it does not rewrite any session data.

## Notes

- Install: `npx hermes-studio@0.27.3` or `npm i -g hermes-studio@0.27.3`.
- Fork build: `studio/v0.23.0/merge-20261124-1432` on LiangYang666/hermes-agent — unchanged in this release; no new fork build was produced.
- Full changelog: https://github.com/hermes-studio-org/hermes-studio/compare/v0.27.2...v0.27.3

## Upgrading

This release changes `packages/server`. Restart `:8788` to activate it; running slots disconnect and resume automatically. A hard refresh is required to load the corrected front-end bundle.
