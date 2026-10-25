// #62-3 的回归：回写 agent 配置只动那两行、原子写、保持/收紧权限、写前自校验。
//
// 上一版这个脚本把 bug 的假设写进了测试：它按"用户 home + .hermes/config.yaml"造目录，
// 而真实调用方传进来的 `home` 是 **HERMES_HOME 本身**（`buildSpawnEnv().home`）。于是配置
// 永远写在 `~/.hermes/.hermes/config.yaml` 这个不存在的路径上，而测试全绿。所以第一条断言
// 就是用真的 `buildSpawnEnv` 走一遍形状。
//
//   npx tsx scripts/qa/model-default.mts
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKENDS, buildSpawnEnv } from "../../packages/server/src/acp/backends.js";
import { providerFromDescription, writeModelDefault } from "../../packages/server/src/model-default.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

/** 造一个 **HERMES_HOME**（不是用户 home），里面一份 config.yaml。 */
function mkHome(body: string, mode = 0o600): { home: string; file: string } {
  const home = mkdtempSync(path.join(tmpdir(), "agentus-hermes-home-"));
  const file = path.join(home, "config.yaml");
  writeFileSync(file, body, { mode });
  chmodSync(file, mode);
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

// ---- 0. 形状：调用方传的 home 就是 HERMES_HOME，配置就在它下面（上一版的 bug 在这里）
{
  const { home, file } = mkHome(BASE);
  const spec = { ...BACKENDS.hermes, isolation: { homeVar: "HERMES_HOME", homeDefault: home } };
  const plan = buildSpawnEnv(spec);
  check("buildSpawnEnv().home is the HERMES_HOME itself", plan.home === home, String(plan.home));
  const r = writeModelDefault("hermes", plan.home, "qwen3.8-flash");
  check("…so the config it touches is <home>/config.yaml",
    r.ok && r.changed && readFileSync(file, "utf8").includes("default: qwen3.8-flash"), r.reason ?? "");
}

// ---- 1. 只改那两行
{
  const { home, file } = mkHome(BASE);
  const r = writeModelDefault("hermes", home, "qwen3.8-flash");
  const after = readFileSync(file, "utf8");
  check("a plain switch rewrites model.default", r.ok && r.changed && after.includes("  default: qwen3.8-flash"), r.reason ?? "");
  check("…leaving every other line byte-identical",
    after.replace("default: qwen3.8-flash", "default: deepseek-v4-flash") === BASE);
  check("…keeping the file 0600", (statSync(file).mode & 0o777) === 0o600, (statSync(file).mode & 0o777).toString(8));
  check("…and leaving a .bak next to it", readdirSync(home).some((f) => f.startsWith("config.yaml.bak-")),
    readdirSync(home).join(","));
}

// ---- 2. provider 一起写；带人话标签的描述不写 provider
{
  const { home, file } = mkHome(BASE);
  const r = writeModelDefault("hermes", home, "qwen3.8-flash", { provider: "alibaba" });
  const after = readFileSync(file, "utf8");
  check("provider is written alongside", r.ok && after.includes("  provider: alibaba") && after.includes("  default: qwen3.8-flash"));
  check("a description with a human label yields no provider",
    providerFromDescription("Provider: Alibaba · current") === "Alibaba" &&
    providerFromDescription("Provider: Anthropic (Claude Sonnet 4.5)") === null,
    String(providerFromDescription("Provider: Anthropic (Claude Sonnet 4.5)")));
}

// ---- 3. 幂等
{
  const { home } = mkHome(BASE);
  writeModelDefault("hermes", home, "qwen3.8-flash", { provider: "alibaba" });
  const again = writeModelDefault("hermes", home, "qwen3.8-flash", { provider: "alibaba" });
  check("re-writing the same value is a no-op", again.ok && !again.changed);
}

// ---- 4. 没有 model 块 → 追加
{
  const { home, file } = mkHome("agent:\n  idleKillMin: 5\n");
  const r = writeModelDefault("hermes", home, "qwen3.8-flash");
  const after = readFileSync(file, "utf8");
  check("a config without a model block gets one",
    r.ok && after.startsWith("agent:") && /^ {2}default: qwen3\.8-flash$/m.test(after), r.reason ?? "");
}

// ---- 5. 坏形状不许写坏：要么拒写（文件原样），要么写成功且真能读回、没有重复顶层键
{
  const shapes: Array<[string, string]> = [
    ["inline flow", `model: {default: x, provider: y}\nagent:\n  a: 1\n`],
    ["anchor", `model: &m\n  default: x\n`],
    ["column-0 comment inside the block", `model:\n  provider: deepseek\n# note\n  default: x\n`],
    ["4-space indent", `model:\n    default: x\n`],
  ];
  for (const [label, body] of shapes) {
    const { home, file } = mkHome(body);
    const r = writeModelDefault("hermes", home, "qwen3.8-flash", { provider: "alibaba" });
    const after = readFileSync(file, "utf8");
    const untouched = !r.ok && after === body;
    const written_safe = r.ok && after !== body && /^ {2,4}default: qwen3\.8-flash$/m.test(after)
      && (after.match(/^model:/gm) ?? []).length <= 1;
    check(`bad shape stays valid: ${label}`, untouched || written_safe, `${r.ok ? "wrote" : "refused"} · ${r.reason ?? ""}`);
  }
}

// ---- 6. 需要引号的值：不引会被 YAML 截断
{
  const { home, file } = mkHome(BASE);
  const r = writeModelDefault("hermes", home, "weird #model: v1");
  const after = readFileSync(file, "utf8");
  check("a value YAML would truncate gets quoted", r.ok && after.includes("default: 'weird #model: v1'"), r.reason ?? "");
}

// ---- 7. CRLF 保留
{
  const { home, file } = mkHome(BASE.replace(/\n/g, "\r\n"));
  writeModelDefault("hermes", home, "qwen3.8-flash");
  const after = readFileSync(file, "utf8");
  check("a CRLF config stays CRLF", !/[^\r]\n/.test(after), JSON.stringify(after.match(/default: [^\r]*/)?.[0]));
}

// ---- 8. 宽权限收紧到 0600（配置里可能有 api_key）
{
  const { home, file } = mkHome(BASE, 0o644);
  writeModelDefault("hermes", home, "qwen3.8-flash");
  check("a 0644 config is tightened to 0600", (statSync(file).mode & 0o777) === 0o600,
    (statSync(file).mode & 0o777).toString(8));
}

// ---- 9. profile 是另一个 home
{
  const { home } = mkHome(BASE);
  mkdirSync(path.join(home, "profiles", "work"), { recursive: true });
  const pfile = path.join(home, "profiles", "work", "config.yaml");
  writeFileSync(pfile, BASE, { mode: 0o600 });
  const r = writeModelDefault("hermes", home, "qwen3.8-flash", { profile: "work" });
  check("a named profile writes its own config, not the default one",
    r.ok && readFileSync(pfile, "utf8").includes("default: qwen3.8-flash")
      && readFileSync(path.join(home, "config.yaml"), "utf8") === BASE, r.reason ?? "");
}

// ---- 10. 别的后端不动
{
  const { home } = mkHome(BASE);
  const r = writeModelDefault("qoder", home, "qwen3.8-flash");
  check("an unknown backend is refused, not guessed", !r.ok, r.reason ?? "");
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
