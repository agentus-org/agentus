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
import {
  namedEndpoints, providerFromDescription, splitChoiceId, writeModelDefault,
} from "../../packages/server/src/model-default.js";
import { parse as parseYaml } from "yaml";

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


// ---- 11. #72：ACP 三段 id 必须拆成 hermes 的配置形状（裸模型 + custom:<条目>）
const NAMED = `model:
  default: old-model
  provider: old-provider
  base_url: https://old.example/v1
  api_mode: codex_responses
providers:
  local-sidecar:
    name: Local Sidecar
    api_url: http://127.0.0.1:9000/v1
    api_mode: chat_completions
    models:
      - DeepSeek-Flash
      - Fast
agent:
  idleKillMin: 5
`;
{
  const { home, file } = mkHome(NAMED);
  const r = writeModelDefault("hermes", home, "custom:local-sidecar:DeepSeek-Flash", { provider: "local-sidecar" });
  const after = readFileSync(file, "utf8");
  check("a three-part ACP id writes the bare model name",
    r.ok && /^ {2}default: DeepSeek-Flash$/m.test(after), r.reason ?? "");
  check("…and the durable entry identity as provider",
    r.ok && /^ {2}provider: custom:local-sidecar$/m.test(after), after.match(/^ {2}provider: .*$/m)?.[0] ?? "");
  check("…and drops the previous provider's endpoint keys",
    r.ok && !/^ {2}base_url:/m.test(after) && !/^ {2}api_mode:/m.test(after),
    (after.match(/^ {2}(base_url|api_mode): .*$/gm) ?? []).join(" · "));
  check("…leaving the entries themselves untouched",
    /local-sidecar:\n {4}name: Local Sidecar/.test(after));

  const again = writeModelDefault("hermes", home, "custom:local-sidecar:DeepSeek-Flash", { provider: "local-sidecar" });
  check("the same pick twice produces no diff", again.ok && !again.changed, again.reason ?? "");
}

// ---- 12. 已经自洽的块不会被改写（同一 provider 再选另一个模型）
{
  const body = `model:
  default: DeepSeek-Flash
  provider: custom:local-sidecar
providers:
  local-sidecar:
    api_url: http://127.0.0.1:9000/v1
`;
  const { home, file } = mkHome(body);
  const r = writeModelDefault("hermes", home, "custom:local-sidecar:Fast", { provider: "local-sidecar" });
  const after = readFileSync(file, "utf8");
  check("a self-consistent block only follows the model",
    r.ok && /default: Fast/.test(after) && /provider: custom:local-sidecar/.test(after), r.reason ?? "");
}

// ---- 13. 闸门：块与条目矛盾时整次拒写（旧闸门只校验两行读得回）
{
  const body = `model:
  default: DeepSeek-Flash
  provider: custom:local-sidecar
  base_url: https://wrong.example/v1
providers:
  local-sidecar:
    api_url: http://127.0.0.1:9000/v1
`;
  const { home, file } = mkHome(body);
  const r = writeModelDefault("hermes", home, "custom:local-sidecar:Fast", { provider: "local-sidecar" });
  check("a contradictory base_url is refused, not written",
    !r.ok && /base_url/.test(r.reason ?? "") && readFileSync(file, "utf8") === body, r.reason ?? "");

  const bad = `model:
  default: DeepSeek-Flash
  provider: custom:local-sidecar
  api_mode: codex_responses
providers:
  local-sidecar:
    api_url: http://127.0.0.1:9000/v1
    api_mode: chat_completions
`;
  const second = mkHome(bad);
  const r2 = writeModelDefault("hermes", second.home, "custom:local-sidecar:Fast", { provider: "local-sidecar" });
  check("a contradictory api_mode is refused, not written",
    !r2.ok && /api_mode/.test(r2.reason ?? "") && readFileSync(second.file, "utf8") === bad, r2.reason ?? "");
}

// ---- 14. #63 不退化：裸 custom + 旧 base_url（= lab 那条）也能收敛到条目
{
  const body = `model:
  default: DeepSeek-Flash
  provider: custom
  base_url: http://127.0.0.1:9000/v1
providers:
  local-sidecar:
    api_url: http://127.0.0.1:9000/v1
`;
  const { home, file } = mkHome(body);
  const r = writeModelDefault("hermes", home, "custom:local-sidecar:Fast", { provider: "local-sidecar" });
  const after = readFileSync(file, "utf8");
  check("a legacy bare `custom` heals to the entry that owns the endpoint",
    r.ok && /provider: custom:local-sidecar/.test(after) && !/base_url:/.test(after), r.reason ?? "");
}

// ---- 15. choice id 拆分本身：不认识的左半段就是模型名的一部分
{
  const endpoints = namedEndpoints(parseYaml(`providers:
  local-sidecar:
    api_url: http://127.0.0.1:9000/v1
`));
  const shape = (id: string, hint: string | null) => splitChoiceId(id, hint, endpoints);
  check("custom:<entry>:<model> splits into model + durable provider",
    JSON.stringify(shape("custom:local-sidecar:DeepSeek-Flash", null)) ===
      JSON.stringify({ model: "DeepSeek-Flash", provider: "custom:local-sidecar" }));
  check("a model whose own name carries a colon is left whole",
    JSON.stringify(shape("anthropic/claude-3.5-sonnet:beta", null)) ===
      JSON.stringify({ model: "anthropic/claude-3.5-sonnet:beta", provider: null }));
  check("a canonical provider prefix is split by the description hint",
    JSON.stringify(shape("deepseek:deepseek-flash", "DeepSeek")) ===
      JSON.stringify({ model: "deepseek-flash", provider: "deepseek" }));
  check("custom:<model> keeps the model and takes the provider from the hint",
    JSON.stringify(shape("custom:DeepSeek-Flash", "local-sidecar")) ===
      JSON.stringify({ model: "DeepSeek-Flash", provider: "custom:local-sidecar" }));
  check("a bare model with a named hint writes the durable identity",
    JSON.stringify(shape("Fast", "local-sidecar")) ===
      JSON.stringify({ model: "Fast", provider: "custom:local-sidecar" }));
  check("a bare model with no hint stays bare and provider-less",
    JSON.stringify(shape("Fast", null)) === JSON.stringify({ model: "Fast", provider: null }));
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
