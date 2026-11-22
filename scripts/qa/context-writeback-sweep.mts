// QA: #112 — context window write-back to the agent's config.yaml (model_overrides).
//
//   npm run context-writeback
//
// The config-option path used to only send the window to the agent: model_context and config.yaml
// never moved, so a new session of the same model always fell back to `auto`. The write-back now
// targets `model_overrides.<provider>.<model>.context_window` — the highest-priority per-model patch
// in Hermes — with `auto` clearing it. Guard the pure edit AND the atomic write here (no tokens).
import { mkdtempSync, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyContextWindow, parseBudget, writeContextWindow } from "../../packages/server/src/context-win-writeback.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

// ── value parsing ────────────────────────────────────────────────────────────
check("512K → 524288", parseBudget("512K") === 524288);
check("256K → 262144", parseBudget("256K") === 262144);
check("bare number passes through", parseBudget("100000") === 100000);
check("auto → null (clear)", parseBudget("auto") === null);
check("junk → undefined (never persisted)", parseBudget("hello") === undefined);

const base = [
  "# operator's config — comments and other blocks must survive untouched",
  "provider: deepseek",
  "model:",
  "  default: deepseek-v4-flash",
  "  provider: deepseek",
  "model_overrides:",
  "  deepseek:",
  "    deepseek-v4-flash:",
  "      context_window: 524288",
  "    deepseek-flash:",
  "      context_window: 524288",
  "custom_providers:",
  "  - name: my-lab",
  "    base_url: http://localhost:9999",
].join("\n") + "\n";

// ── pure edit ────────────────────────────────────────────────────────────────
const r1 = applyContextWindow(base, "deepseek", "deepseek-v4-flash", 262144);
check("change an existing value", r1.ok && r1.changed && /deepseek-v4-flash:\n[ \t]*context_window: 262144/.test(r1.text));
check("no duplicate model block", (r1.text.match(/deepseek-v4-flash:/g) ?? []).length === 1);
check("sibling model untouched", /deepseek-flash:\n[ \t]*context_window: 524288/.test(r1.text));
check("unrelated blocks untouched", /custom_providers:[\s\S]*my-lab/.test(r1.text) && /provider: deepseek\n/.test(r1.text));

const r2 = applyContextWindow(base, "deepseek", "deepseek-v4-flash", null);
check("auto removes the key", r2.changed && !/deepseek-v4-flash:\n[ \t]*context_window/.test(r2.text));
check("auto keeps the sibling", /deepseek-flash:\n[ \t]*context_window: 524288/.test(r2.text));

const r3 = applyContextWindow(base, "openrouter", "claude", 786432);
check("adds a provider+model that was not there", /openrouter:\n[ \t]*claude:\n[ \t]*context_window: 786432/.test(r3.text));

const noBlock = "provider: x\nmodel:\n  default: y\n";
check("creates model_overrides when absent",
  /model_overrides:\n[ \t]*deepseek:\n[ \t]*m:\n[ \t]*context_window: 1000/.test(applyContextWindow(noBlock, "deepseek", "m", 1000).text));

const four = "model_overrides:\n    deepseek:\n        m:\n            context_window: 1\n";
const r4 = applyContextWindow(four, "deepseek", "m", 2);
check("respects a 4-space indent", /context_window: 2/.test(r4.text) && !/^  context_window/m.test(r4.text));

// ── atomic write + read-back ─────────────────────────────────────────────────
const dir = mkdtempSync(path.join(tmpdir(), "ctx-writeback-"));
const f = path.join(dir, "config.yaml");
writeFileSync(f, base, { mode: 0o644 });
const w1 = writeContextWindow(f, "deepseek", "deepseek-v4-flash", 262144);
check("write lands on disk", w1.ok && w1.changed && /context_window: 262144/.test(readFileSync(f, "utf8")));
check("a backup was left", readdirSync(dir).some((n: string) => n.startsWith("config.yaml.bak-")));
const w2 = writeContextWindow(f, "deepseek", "deepseek-v4-flash", null);
check("auto clears on disk", w2.ok && w2.changed && !/deepseek-v4-flash:\n[ \t]*context_window/.test(readFileSync(f, "utf8")));
const w3 = writeContextWindow(f, "deepseek", "claude", 123);
const w3again = writeContextWindow(f, "deepseek", "claude", 123);
check("a second identical write reports changed=false", w3.changed === true && w3again.ok && w3again.changed === false);
check("config mode not world-writable", (statSync(f).mode & 0o077) === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
