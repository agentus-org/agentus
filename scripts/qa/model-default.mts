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

/** 只读 `model:` 块本身：条目自己声明的 base_url/api_mode 不算残留。 */
const modelBlock = (text: string): Record<string, unknown> =>
  ((parseYaml(text) as { model?: Record<string, unknown> } | null)?.model ?? {});
const noEndpoint = (text: string): boolean => {
  const m = modelBlock(text);
  return m.base_url === undefined && m.api_mode === undefined;
};

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

// ---- 13. 块里与条目矛盾的那两行是「多余的」，不是「要拒写的」：删掉并写入
//
// 上一版把这种块整个拒写，于是条目一旦改过端口/协议，这个端点上的选模型就永久失败、且只有一行
// console.log —— 操作者看到的是「我选了模型，下次新会话还是旧的」。端点归条目所有（review F3）。
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
  const after = readFileSync(file, "utf8");
  check("a block that contradicts its own entry heals instead of wedging",
    r.ok && /default: Fast/.test(after) && !/base_url:/.test(after), r.reason ?? "");

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
  const after2 = readFileSync(second.file, "utf8");
  check("…including a contradictory api_mode", r2.ok && noEndpoint(after2), r2.reason ?? "");
}

// ---- 14. 端点字段：hermes 读 base_url / url / api，不读 api_url（那是 inventory 行字段）
{
  for (const key of ["base_url", "url", "api"]) {
    const body = `model:
  default: Old
  provider: some-cloud
  base_url: https://old.example/v1
  api_mode: codex_responses
providers:
  lab:
    ${key}: http://127.0.0.1:9000/v1
`;
    const { home, file } = mkHome(body);
    const r = writeModelDefault("hermes", home, "custom:lab:Fast", { provider: "lab" });
    const after = readFileSync(file, "utf8");
    check(`an entry declared with \`${key}:\` owns its endpoint`,
      r.ok && /provider: custom:lab/.test(after) && noEndpoint(after),
      `${r.reason ?? ""} ${JSON.stringify(modelBlock(after))}`);
  }
}

// ---- 15. custom → 内置 provider：上一个 provider 的 base_url/api_mode 也必须清掉（review F1）
{
  const body = `model:
  default: Fast
  provider: custom
  base_url: https://old.example/v1
  api_mode: codex_responses
`;
  const { home, file } = mkHome(body);
  const r = writeModelDefault("hermes", home, "openrouter:anthropic/claude", { provider: "OpenRouter" });
  const after = readFileSync(file, "utf8");
  check("leaving a custom endpoint for a built-in drops the stale endpoint",
    r.ok && /provider: openrouter/.test(after) && /default: anthropic\/claude/.test(after)
      && noEndpoint(after), `${r.reason ?? ""} ${JSON.stringify(modelBlock(after))}`);
}

// ---- 16. 名字里带冒号的模型不会被切（同一个模型在 openrouter 上是合法的）
{
  const { home, file } = mkHome(`model:
  default: Old
  provider: openrouter
`);
  const r = writeModelDefault("hermes", home, "openrouter:anthropic/claude-3.5-sonnet:beta", { provider: "OpenRouter" });
  const after = readFileSync(file, "utf8");
  check("a model name that carries a colon stays whole",
    r.ok && /default: anthropic\/claude-3.5-sonnet:beta/.test(after), r.reason ?? "");
}

// ---- 17. 指向本配置里不存在的条目 = 拒写（对话框拿旧快照时会走到）
{
  const body = `model:
  default: Old
  provider: lab
providers:
  lab:
    api_url: http://127.0.0.1:9000/v1
`;
  const { home, file } = mkHome(body);
  const r = writeModelDefault("hermes", home, "custom:gone:Fast", { provider: "lab" });
  check("a pick naming an unconfigured entry is refused, not stamped into the config",
    !r.ok && /does not declare/.test(r.reason ?? "") && readFileSync(file, "utf8") === body, r.reason ?? "");
}

// ---- 18. 显示名不是身份：描述里给的是 name，写下去必须是 custom:<键>
{
  const body = `model:
  default: Old
  provider: old
providers:
  sidecar:
    name: My Lab Box
    api_url: http://127.0.0.1:9000/v1
`;
  const { home, file } = mkHome(body);
  const r = writeModelDefault("hermes", home, "custom:Fast", { provider: "My Lab Box" });
  const after = readFileSync(file, "utf8");
  check("a display name resolves to the durable entry key",
    r.ok && /provider: custom:sidecar/.test(after) && /default: Fast/.test(after), r.reason ?? "");
}

// ---- 19. 停用条目不算端点归属（也不会被写成 provider）
{
  const body = `model:
  default: Old
  provider: old
providers:
  off:
    name: Off
    api_url: http://127.0.0.1:9000/v1
    enabled: false
`;
  const { home, file } = mkHome(body);
  const r = writeModelDefault("hermes", home, "custom:off:Fast", { provider: "Off" });
  check("a disabled entry cannot be resurrected as the default provider",
    !r.ok && readFileSync(file, "utf8") === body, r.reason ?? "");
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

// ---- 20. 调参块不是端点：`providers.deepseek: {stale_timeout_seconds: 600}` 是给内置 provider
// 调参的（hermes 的 resolve_user_provider 会跳过没有 base_url 的条目）。把它当端点写成
// `provider: custom:deepseek`，hermes 解析不出来，块里唯一能路由的 base_url 还会被删掉。
{
  const body = `model:
  default: deepseek-v4-flash
  provider: deepseek
  base_url: https://my-gateway.example/v1
providers:
  deepseek:
    context_length: 64000
    stale_timeout_seconds: 600
`;
  const { home, file } = mkHome(body);
  const r = writeModelDefault("hermes", home, "deepseek:deepseek-flash", { provider: "DeepSeek" });
  const after = readFileSync(file, "utf8");
  check("a tuning-only providers block is not an endpoint (and keeps its base_url)",
    r.ok && /provider: deepseek$/m.test(after) && /base_url: https:\/\/my-gateway\.example\/v1/.test(after)
      && !/custom:deepseek/.test(after), `${r.reason ?? ""} :: ${JSON.stringify(modelBlock(after))}`);
}

// ---- 21. 别名永不覆盖键：A 的 name 与 B 的键同名时，custom:B:Fast 必须还是 B
{
  const body = `model:
  default: Old
  provider: old
providers:
  local:
    name: Lab
    base_url: http://127.0.0.1:9001/v1
  lab:
    name: Local
    base_url: http://127.0.0.1:9002/v1
`;
  const { home, file } = mkHome(body);
  const r = writeModelDefault("hermes", home, "custom:local:Fast", { provider: "local" });
  const after = readFileSync(file, "utf8");
  check("a display-name alias never steals another entry's key",
    r.ok && /provider: custom:local$/m.test(after), r.reason ?? "");
}

// ---- 22. 别名也不许把内置 provider 的 pick 拖到本地条目上（云 → 本地代理是 #72-B 的翻版）
{
  const body = `model:
  default: Old
  provider: old
providers:
  or-proxy:
    name: OpenRouter
    base_url: http://127.0.0.1:9100/v1
    models:
      - anthropic/claude
`;
  const { home, file } = mkHome(body);
  const r = writeModelDefault("hermes", home, "openrouter:anthropic/claude-3.5-sonnet", { provider: "OpenRouter" });
  const after = readFileSync(file, "utf8");
  check("a canonical pick is not captured by a same-named local entry",
    r.ok && /provider: openrouter$/m.test(after) && !/custom:or-proxy/.test(after), r.reason ?? "");
}

// ---- 23. 旧形状 `custom:<带冒号的模型>`：条目自己声明了这个模型 ⇒ 按旧读法写下去
{
  const body = `model:
  default: Old
  provider: old
providers:
  lab:
    base_url: http://127.0.0.1:9000/v1
    models:
      - qwen3:32b
`;
  const { home, file } = mkHome(body);
  const r = writeModelDefault("hermes", home, "custom:qwen3:32b", { provider: "lab" });
  const after = readFileSync(file, "utf8");
  check("a legacy custom:<model:tag> id its entry declares is written whole",
    r.ok && /default: qwen3:32b$/m.test(after) && /provider: custom:lab$/m.test(after), r.reason ?? "");
}

// ---- 24. 端点字段要真的被读到（上一版的断言只看 provider/残留，删掉修复也过 = 假绿）
{
  for (const key of ["base_url", "url", "api"]) {
    const named = namedEndpoints(parseYaml(`providers:\n  lab:\n    ${key}: http://127.0.0.1:9000/v1\n    api_mode: chat_completions\n`));
    const info = named.byKey.get("custom:lab");
    check(`namedEndpoints reads the endpoint from \`${key}:\``,
      info?.apiUrl === "http://127.0.0.1:9000/v1" && info?.apiMode === "chat_completions",
      JSON.stringify(info ?? null));
  }
  const tuning = namedEndpoints(parseYaml("providers:\n  deepseek:\n    context_length: 64000\n"));
  check("…and registers no entry for a block that declares no endpoint",
    tuning.byKey.size === 0 && tuning.byAlias.size === 0, JSON.stringify([...tuning.byKey.keys()]));
}

console.log(`\n${pass} passed / ${fail} failed`);

process.exit(fail ? 1 : 0);
