## Fixes

- Voice summaries on Tencent TokenHub sessions no longer fail with an empty answer and `finish_reason=length`. The summary request now disables thinking for Hy models, so the output budget goes to the spoken text instead of reasoning.

## Notes

- Install: `npx agentus@0.23.2` · `npm i -g agentus@0.23.2`
- Fork build unchanged: `agentus/v0.23.0/merge-20261114-2214`. This release has no new Hermes fork build.
- This release changes server code: restart `:8788` is required for the fix to take effect. Running sessions are interrupted and resume automatically.
- Full changelog: https://github.com/hermes-studio-org/hermes-studio/compare/v0.23.1...v0.23.2

---

## 发布回读（2026-11-16）

| 项 | 证据 |
|---|---|
| tag | `v0.23.2` → `ba757d8`，远端类型 `tag`（注解） |
| npm | `agentus@0.23.2`，registry shasum `fad23caa1579a1a583baa5ad7a55f9b0607927e9`（与本地 npm pack 一致），`dist-tags.latest=0.23.2` |
| Release | https://github.com/hermes-studio-org/hermes-studio/releases/tag/v0.23.2 · `isDraft=false`、`isPrerelease=false` |
| 闸门 | `preflight.sh` 13 passed / 0 failed（1 warning），GREEN |
| live | `:8788` pid `97893 → 4822`，`/api/version` commit `eed17ce → ba757d8`，6 个槽位 resume 全 200 |

### 验证

- `npx tsx scripts/qa/speech-summary-sweep.mts`：40 passed / 0 failed（新增 5 条断言，含复现空答案的 stub）。
- `npm run typecheck`、`npm run build` 通过。
- 实测 `hy4-flash`、`max_completion_tokens=1200`：baseline reasoning 496 字 / completion 351 tokens；`reasoning_effort:"none"` → 0 / 7。

### 踩坑

- npm staged publishing：`npm publish` 回 `PUT 202`，之后 `/pkg/0.23.2` 连续 404 约 10 分钟，重发得 `E409 … previously staged`（说明未重入），最终根 packument 的 `time["0.23.2"]=13:21:45Z`、`dist-tags.latest=0.23.2` 就位，而版本端点仍是旧缓存。**判据以根 packument 的 `time` 条目为准**，已把这一行写进 `agentus-release` skill 的判决表。
