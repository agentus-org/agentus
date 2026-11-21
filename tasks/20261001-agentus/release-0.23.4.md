## Highlights

- Voice calls now interrupt reliably by saying the wake word 摇摇 while the agent is speaking. Keyword barge-in is the default; the stale echo-evidence gate that swallowed the wake word is gone.
- Semantic end-of-turn detection (Smart Turn v3) makes the agent sense when you have finished speaking, so it stops talking over you and responds at the right moment.
- The transcript view now keeps the live microphone waveform visible, docked naturally between the caption sheet and the call buttons, so you can see your own level and ambient noise while reading captions.

## Fixes

- Switching to a model that only supports a low reasoning level (e.g. hy4-flash) no longer leaves a stale "medium" snapshot behind. Hanging up a call no longer pops a "Reasoning effort medium not applied, actual none" error: the call's internal lower/restore validates levels against what the current model actually offers, drops an illegal snapshot, and never surfaces an internal rejection as your own setting failing.

## Notes

- Install: `npx agentus@0.23.4` or `npm i -g agentus@0.23.4`.
- Fork build: this release uses the existing fork tag `agentus/v0.23.0/merge-20261114-2214` — there is no new Hermes fork build in this version; all changes are in the cockpit.
- Restart required: this release changes `packages/server` (thinking-snapshot handling). Restart `:8788` to activate it; in-running call slots disconnect and resume automatically.
- If you are upgrading from 0.23.3, hard-refresh the page (Cmd+Shift+R) after restart to pick up the new web bundle.
- Full changelog: https://github.com/agentus-org/agentus/compare/v0.23.3...v0.23.4
