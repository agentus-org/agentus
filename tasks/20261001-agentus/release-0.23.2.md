## Fixes

- Voice summaries on Tencent TokenHub sessions no longer fail with an empty answer and `finish_reason=length`. The summary request now disables thinking for Hy models, so the output budget goes to the spoken text instead of reasoning.

## Notes

- Install: `npx agentus@0.23.2` · `npm i -g agentus@0.23.2`
- Fork build unchanged: `agentus/v0.23.0/merge-20261114-2214`. This release has no new Hermes fork build.
- This release changes server code: restart `:8788` is required for the fix to take effect. Running sessions are interrupted and resume automatically.
- Full changelog: https://github.com/agentus-org/agentus/compare/v0.23.1...v0.23.2
