## Highlights

- Complete the rename in public distribution: the repository now lives at `hermes-studio-org/hermes-studio`, and the pinned Hermes fork build uses the `studio/` tag namespace. No functionality changed — this release makes the published artifacts match the Hermes Studio name.

## Fixes

- Repository URL and changelog links point to `hermes-studio-org/hermes-studio`; old URLs redirect automatically.
- The fork build pin and release gate now read the `studio/` tag prefix; the historical `agentus/*` tags are kept for reference and no longer participate in version discovery.

## Notes

- Install: `npx hermes-studio@0.25.1` or `npm i -g hermes-studio@0.25.1`.
- Fork build: `studio/v0.23.0/merge-20261123-1847` on LiangYang666/hermes-agent — this build accepts the renamed cockpit keys (`_meta.hermesStudio`, `HERMES_STUDIO_SESSION_ROLE`) with legacy fallback. The code is unchanged from v0.25.0; only the tag namespace was renamed.
- No restart required: this is a docs and gate-only release. The running server code is unchanged; `/api/version` stays at the same commit as v0.25.0.
- Full changelog: https://github.com/hermes-studio-org/hermes-studio/compare/v0.25.0...v0.25.1

---

Release readback (internal, not part of the public notes):
- fork tag: studio/v0.23.0/merge-20261123-1847 (823b953942), no new fork build, code unchanged from v0.25.0
- repo: hermes-studio-org/hermes-studio (transferred from agentus-org/agentus; old URL 301-redirects)
- studio tag: v0.25.1 -> c168ad1 (annotated)
- npm shasum: c1716e4c946cb6eadc877dacac7eb84865b24a4e (matches publish output, landed after staged window)
- CI: 45174897152 success (head c168ad1)
- gate: 12 passed, 0 failed, 2 warnings GREEN
- package-smoke: PASS
- live: no restart (346dddf is ancestor of v0.25.1)
