## Fixes

- Dragging text in the session transcript no longer loses the selection on mouse-up. The label-drag cleanup was clearing the window selection on every global `pointerup`, which made text anywhere on the page unselectable and disrupted composer interaction.
- Existing sessions imported from older builds now start in Unclassified. The previous one-time backfill inferred In progress from the presence of a transcript, which classified work nobody had assigned. Labels set by hand through the rail, context menu, or CLI are preserved.

## Notes

- Install: `npx hermes-studio@0.27.2` or `npm i -g hermes-studio@0.27.2`.
- Fork build: `studio/v0.23.0/merge-20261124-1432` on LiangYang666/hermes-agent — unchanged in this release; no new fork build was produced.
- Installations upgrading from v0.27.1 keep every hand-set label; only labels written by the old automatic backfill are re-filed to Unclassified, once per store.
- Full changelog: https://github.com/hermes-studio-org/hermes-studio/compare/v0.27.1...v0.27.2

## Upgrading

This release changes `packages/server`. Restart `:8788` to activate it; running slots disconnect and resume automatically. A hard refresh is required to load the corrected front-end bundle.
