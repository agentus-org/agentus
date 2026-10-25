// #62-3 的回归：回写 agent 配置文件只动那两行、原子写、保持 0600、幂等。
//   npx tsx scripts/qa/model-default.mts
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { providerFromDescription, writeModelDefault } from "../../packages/server/src/model-default.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

/** 造一个 home，里面有一份 0600 的 .hermes/config.yaml。 */
function mkCfg(body: string): { home: string; file: string } {
  const home = mkdtempSync(path.join(tmpdir(), "agentus-cfg-"));
  mkdirSync(path.join(home, ".hermes"), { recursive: true });
  const file = path.join(home, ".hermes", "config.yaml");
  writeFileSync(file, body, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { home, file };
}

const BASE = `model:
  default: deepseek-v4-flash
  provider: deepseek
agent:
  idleKillMin: 5
toolsets:
  - terminal
`;

// ---- 1. 改 default，别的不动
{
  const { home, file } = mkCfg(BASE);
  const r = writeModelDefault("hermes", home, "qwen3.8-flash");
  const after = readFileSync(file, "utf8");
  check("a plain switch rewrites model.default", r.ok && r.changed && after.includes("  default: qwen3.8-flash"), r.reason ?? "");
  check("…and leaves every other line byte-identical",
    after.replace("default: qwen3.8-flash", "default: deepseek-v4-flash") === BASE);
  check("…keeping the file 0600", (statSync(file).mode & 0o777) === 0o600, (statSync(file).mode & 0o777).toString(8));
}

// ---- 2. provider 一起写
{
  const { home, file } = mkCfg(BASE);
  const r = writeModelDefault("hermes", home, "qwen3.8-flash", { provider: "alibaba" });
  const after = readFileSync(file, "utf8");
  check("provider is written alongside", r.ok && after.includes("  provider: alibaba") && after.includes("  default: qwen3.8-flash"));
}

// ---- 3. 幂等
{
  const { home } = mkCfg(BASE);
  writeModelDefault("hermes", home, "qwen3.8-flash", { provider: "alibaba" });
  const again = writeModelDefault("hermes", home, "qwen3.8-flash", { provider: "alibaba" });
  check("re-writing the same value is a no-op", again.ok && !again.changed);
}

// ---- 4. 没有 model 块 → 追加而不是炸
{
  const { home, file } = mkCfg("agent:\n  idleKillMin: 5\n");
  const r = writeModelDefault("hermes", home, "qwen3.8-flash");
  const after = readFileSync(file, "utf8");
  check("a config without a model block gets one",
    r.ok && after.startsWith("agent:") && /^model:\n {2}default: qwen3\.8-flash$/m.test(after), r.reason ?? "");
}

// ---- 5. 别的后端不动（没有已知配置形状）
{
  const { home } = mkCfg(BASE);
  const r = writeModelDefault("qoder", home, "qwen3.8-flash");
  check("an unknown backend is refused, not guessed", !r.ok, r.reason ?? "");
}

// ---- 6. description 取 provider
{
  check("provider comes from the agent's own description",
    providerFromDescription("Provider: Alibaba · current") === "Alibaba",
    String(providerFromDescription("Provider: Alibaba · current")));
  check("…and a description without one yields null", providerFromDescription("just a model") === null);
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
