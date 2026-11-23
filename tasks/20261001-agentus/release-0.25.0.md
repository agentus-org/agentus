## Highlights

- The cockpit is now **Hermes Studio**: the brand, CLI (`hermes-studio`), npm package (`hermes-studio`), MCP tool (`studio-plan`), and internal contracts (environment variables, cookies, localStorage keys, data directory) have all been renamed. No functionality changed — this is a rename, not a behavior change.
- Existing installations migrate automatically and non-destructively: on startup the old data directory and `agentus.sqlite` are **copied** to `~/.hermes-studio` / `hermes-studio.sqlite`. The originals are left in place, so you can roll back by pointing the old build back at them.
- The bundled Hermes fork build now accepts the renamed cockpit keys (`_meta.hermesStudio`, `HERMES_STUDIO_SESSION_ROLE`) as well as the legacy Agentus names, so one fork serves both generations during and after the rename.

## Fixes

- The plan MCP tool is now named `studio-plan` (with `x-studio-plan-token`), matching the new product name.
- Fixed a startup crash in the CLI and plan MCP server where the environment shim import was inserted above the shebang line.

## Notes

- Install: `npx hermes-studio@0.25.0` or `npm i -g hermes-studio@0.25.0`. The old `agentus` package is not updated.
- Fork build: `agentus/v0.23.0/merge-20261123-1847` on LiangYang666/hermes-agent — adds the Hermes Studio key compatibility (new names with legacy fallback); without it a renamed cockpit's per-session toolset/observer settings would be ignored by the fork.
- Restart required: this release changes `packages/server` and `packages/shared` (startup, migration, contracts). Restart `:8788` to activate it; in-running slots disconnect and resume automatically. On first start the data migration copies (does not delete) the old store, so nothing is lost.
- Hard-refresh the browser tab (Cmd+Shift+R) after restart to pick up the new web bundle and asset hash.
- Full changelog: https://github.com/hermes-studio-org/hermes-studio/compare/v0.24.1...v0.25.0

---

Release readback (internal, not part of the public notes):
- fork tag: agentus/v0.23.0/merge-20261123-1847
- agentus tag: v0.25.0
- npm package: hermes-studio@0.25.0
