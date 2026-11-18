## Fixes

- Voice calls no longer clatter with keyboard sounds before the agent has said anything. Spoken lines and status cues now follow one clean three-state machine: silent while the agent is speaking, a soft chord while it thinks or runs tools, and a light keyboard sound layered on the chord only while a tool is actually running. Interrupting the agent silences everything at once.
- A short opening line ("starting now.") is no longer delayed until after a long tool call. When a tool starts, any short sentence still waiting to be merged is spoken immediately, so it does not bunch up with the next reply.
- Local file links and images with non-ASCII characters or spaces in their path now render correctly. Paths were being percent-encoded twice, so every such image 404'd; they are now decoded exactly once.
- Images that fail to load now show their alt text instead of collapsing into a tiny 2px dot.

## Notes

- Install: `npx agentus@0.23.3` or `npm i -g agentus@0.23.3`.
- Fork build: this release uses the existing fork tag `agentus/v0.23.0/merge-20261114-2214` — there is no new Hermes fork build in this version; all changes are in the cockpit.
- No restart required: this release only changes `packages/web`; the running `:8788` process needs no restart. Hard-refresh the page (Cmd+Shift+R) to pick up the new bundle.
- Full changelog: https://github.com/agentus-org/agentus/compare/v0.23.2...v0.23.3
