// 语音播报总结的后半段（issue #36）：输入不再被静默截断、思考开着但只给 200 token、以及
// 「会话自己的模型」这条路由真的能解析出 DeepSeek。
//
// 三件事各自都以「旧行为会红」为判据：
//
//   1) 截断：旧代码把输入切成 `maxChars × 20`（120 字档 → 2400 字符），后半直接丢掉，只在
//      记账条上写一句「原文过长，只总结了前半」。现在整段照发；超出 20000 字符改由路由拒绝
//      （409 too_long，见 index.ts）。
//   2) 思考：qwen3.8-flash 默认开思考、默认预算 4000，实测一句 40 字的请求烧了 235 个输出
//      token。现在带 `thinking_budget: 200`，并且用 `max_completion_tokens`（思考模式下
//      `max_tokens` 被限死在 32768，且推理 token 会吃掉可见输出）。
//   3) 路由：本机会话报的是 `deepseek/deepseek-v4-flash`（斜杠形态），而 `splitModelId()` 只认
//      冒号，于是每次都被判成「不知道该模型属于哪个 provider」，静默回落到语音端点的
//      qwen-flash。现在斜杠形态只要是已知 provider 就能解析。
//
// 全部本地：一个 stub HTTP server 接请求、真 `routeForModel()` 读本机 config.yaml。
// 不碰 live、不花 token。
//
//   npx tsx scripts/qa/speech-summary-sweep.mts
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { summarizeForSpeech } = await import("../../packages/server/src/dashscope.ts");
const { routeForModel } = await import("../../packages/server/src/speech/route.ts");
const settings = await import("../../packages/server/src/settings.ts");
const { SUMMARY_MODEL_DEFAULT, SUMMARY_THINKING_BUDGET, SUMMARY_MAX_INPUT_CHARS } = settings;

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  — ${detail}` : ""}`);
};

/** Settings live in a module-level cache keyed by the data dir; point it at a scratch file so the
 *  operator's own summary prompt/timeout never decides what this sweep measures. */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-summary-sweep-"));

// ---- stub vendor -------------------------------------------------------------------------
type Body = Record<string, unknown>;
const seen: Body[] = [];
/** Flipped to a 4xx to prove the route carries the vendor's own status out (#85). */
let stubStatus = 200;
const stub = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    try { seen.push(JSON.parse(raw) as Body); } catch { seen.push({}); }
    if (stubStatus !== 200) {
      res.writeHead(stubStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "model_not_allowed", error: "model_not_allowed: qwen3.8-flash" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { content: "这是摘要。" }, finish_reason: "stop" }],
    }));
  });
});
await new Promise<void>((r) => stub.listen(0, "127.0.0.1", () => r()));
const addr = stub.address();
const baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

/** Run one summarize call and hand back the request body it actually put on the wire. */
async function call(text: string, thinkingBudget?: number): Promise<{ body: Body; input: string; out: string; result: Record<string, unknown> }> {
  seen.length = 0;
  const r = await summarizeForSpeech({
    text,
    maxChars: 120,
    prompt: "把下面这段压成 {maxChars} 字以内",
    model: "qwen3.8-flash",
    timeoutSec: 10,
    endpoint: { baseUrl, apiKey: "sk-stub" },
    ...(thinkingBudget === undefined ? {} : { thinkingBudget }),
  });
  const body = seen[0] ?? {};
  const messages = (body.messages ?? []) as { role: string; content: string }[];
  const user = messages.find((m) => m.role === "user");
  return { body, input: String(user?.content ?? ""), out: r.text, result: r as unknown as Record<string, unknown> };
}

// ---- 1) no silent truncation --------------------------------------------------------------
const LONG = "太长的一段落。".repeat(700); // 700 × 7 chars = 4900 chars, far past 120 × 20 = 2400
const long = await call(LONG);
check("长文本整段发出，不再是 maxChars × 20 的头一段", long.input.length === LONG.length,
  `${long.input.length} / ${LONG.length} chars`);
check("没有「后面还有 N 字没发」这种半成品标记", !/后面还有\s*\d+\s*字没发/.test(long.input));
check("返回值不再带 truncated（前端那句「只总结了前半」的开关没了）",
  !Object.prototype.hasOwnProperty.call(long.result, "truncated") && long.out === "这是摘要。",
  Object.keys(long.result).join(","));

// ---- 2) thinking: on, but capped ---------------------------------------------------------
check("默认模型是 qwen3.8-flash", SUMMARY_MODEL_DEFAULT === "qwen3.8-flash", SUMMARY_MODEL_DEFAULT);
check("思考预算常量是 200", SUMMARY_THINKING_BUDGET === 200, String(SUMMARY_THINKING_BUDGET));
check("超长拒绝的阈值是 20000 字", SUMMARY_MAX_INPUT_CHARS === 20_000, String(SUMMARY_MAX_INPUT_CHARS));

const think = await call("一段需要压成口播的话。", SUMMARY_THINKING_BUDGET);
check("qwen3 请求带 enable_thinking=true", think.body.enable_thinking === true, String(think.body.enable_thinking));
check("qwen3 请求带 thinking_budget=200", think.body.thinking_budget === 200, String(think.body.thinking_budget));
check("不再发 max_tokens（思考模式下会被限死 32768）", !("max_tokens" in think.body));
check("改用 max_completion_tokens，且留出思考的位置",
  Number(think.body.max_completion_tokens) >= 1200 + 200, String(think.body.max_completion_tokens));
check("不把 reasoning_effort 一起发（厂商会拒这一对）", !("reasoning_effort" in think.body));

const plain = await call("一段需要压成口播的话。");
check("非 qwen3 模型不带思考字段", !("enable_thinking" in plain.body) && !("thinking_budget" in plain.body));
check("非 qwen3 也走 max_completion_tokens", !("max_tokens" in plain.body) && Number(plain.body.max_completion_tokens) >= 1200);

// (the stub stays up: §5 below asks it to answer 403)

// ---- 3) the session's own model actually resolves ----------------------------------------
const home = process.env.HERMES_HOME ?? path.join(os.homedir(), ".hermes");
const slash = routeForModel("deepseek/deepseek-v4-flash", home);
check("斜杠形态 deepseek/deepseek-v4-flash 解析出 provider", slash.route?.provider === "deepseek",
  slash.route ? `${slash.route.provider} ${slash.route.model}` : slash.why);
check("斜杠形态的 model 名去掉前缀，交给厂商的是裸名字", slash.route?.model === "deepseek-v4-flash",
  String(slash.route?.model));
check("baseUrl 是 DeepSeek 官方端点", (slash.route?.baseUrl ?? "").includes("api.deepseek.com"),
  String(slash.route?.baseUrl));

const colon = routeForModel("deepseek:deepseek-v4-flash", home);
check("冒号形态照旧可用（回归）", colon.route?.provider === "deepseek", colon.route?.model ?? colon.why);

const noModel = routeForModel(null, home);
check("没有模型时给出「agent 未握手」而不是编一个 provider", noModel.route === null && /未握手/.test(noModel.why), noModel.why);

const catalogue = routeForModel("anthropic/claude-x", home);
check("未知前缀的目录名不被硬掰成 provider（anthropic 不是本机 provider）",
  catalogue.route === null || catalogue.route.provider !== "anthropic",
  catalogue.route ? `${catalogue.route.provider} ${catalogue.route.model}` : catalogue.why);

const openrouter = routeForModel("openrouter:anthropic/claude-x", home);
check("冒号形态的目录名保留斜杠（openrouter:anthropic/claude-x）",
  openrouter.route === null || openrouter.route.model === "anthropic/claude-x",
  openrouter.route ? `${openrouter.route.provider} ${openrouter.route.model}` : openrouter.why);

// ---- 4) `custom:<provider>:<model>` resolves to that provider entry (#85) ------------------
// The id the agent reports looks like `custom:lab:qwen38-27b`: `custom` is the NAMESPACE, `lab` is a
// `config.yaml providers` entry. Treating `custom` as the provider found nothing and every such
// session fell back to the voice endpoint — a 403 there, reported as 502.
const customHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-custom-home-"));
fs.writeFileSync(path.join(customHome, "config.yaml"), [
  "providers:",
  "  lab:",
  "    base_url: https://lab.example.invalid/v1",
  "    api_key: sk-lab-from-config",
  "    model: qwen38-27b",
  "model:",
  "  default: lab:qwen38-27b",
  "  provider: lab",
].join("\n"));

const customLab = routeForModel("custom:lab:qwen38-27b", customHome);
check("custom:lab:qwen38-27b 解析到 providers.lab（不是「provider custom」）",
  customLab.route?.provider === "lab" && customLab.route?.model === "qwen38-27b",
  customLab.route ? `${customLab.route.provider} ${customLab.route.model} · ${customLab.route.source}` : customLab.why);
check("端点是配置里那一行，key 也是那一行的",
  customLab.route?.baseUrl === "https://lab.example.invalid/v1" && customLab.route?.apiKey === "sk-lab-from-config",
  String(customLab.route?.baseUrl));

const customQoder = routeForModel("custom:qoder:qwen3.8-flash", home);
check("本机真配置的 custom:qoder:… 也能解析（qoder 是 providers 里的具名条目）",
  customQoder.route?.provider === "qoder" && customQoder.route?.model === "qwen3.8-flash",
  customQoder.route ? `${customQoder.route.provider} ${customQoder.route.baseUrl}` : customQoder.why);

const customUnknown = routeForModel("custom:nope-provider:some-model", customHome);
check("custom 指向不存在的 provider 时，失败原因点名那条 provider（并指路 config.yaml）",
  customUnknown.route === null
    && /nope-provider/.test(customUnknown.why)
    && /providers/.test(customUnknown.why)
    && /custom_providers/.test(customUnknown.why)
    && !/provider「custom」/.test(customUnknown.why),
  customUnknown.why);

// ---- 4b) the LEGACY `custom_providers` list is the same declaration (#86) -------------------
// Upgraded deployments still carry the pre-v12 list form; hermes reads both shapes as one view, so
// answering 「providers 里没有这一条」 about an endpoint that is right there in `custom_providers`
// meant chat worked and every side call (voice summary) failed.
const legacyHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-legacy-home-"));
fs.writeFileSync(path.join(legacyHome, ".env"), "LEGACY_KEY=fake-legacy-key\n");
fs.writeFileSync(path.join(legacyHome, "config.yaml"), [
  "custom_providers:",
  "  - name: legacy-lab",
  "    base_url: https://legacy.example.invalid/v1",
  "    api_key: fake-legacy-inline",
  "    model: legacy-model",
  "  - name: legacy-env",
  "    api: https://legacy-env.example.invalid/v1",
  "    key_env: LEGACY_KEY",
  "    default_model: legacy-env-model",
  "  - name: legacy-off",
  "    base_url: https://legacy-off.example.invalid/v1",
  "    api_key: fake-legacy-off",
  "    enabled: false",
  "  - provider_key: legacy-keyname",
  "    base_url: https://legacy-key.example.invalid/v1",
  "    api_key: fake-legacy-keyname",
  "  - name: both",
  "    base_url: https://from-legacy.example.invalid/v1",
  "    api_key: fake-from-legacy",
  "providers:",
  "  both:",
  "    base_url: https://from-map.example.invalid/v1",
  "    api_key: fake-from-map",
].join("\n"));

const legacyInline = routeForModel("custom:legacy-lab:legacy-model", legacyHome);
check("legacy custom_providers 列表里的条目也能路由（name + base_url + api_key 字面量）",
  legacyInline.route?.baseUrl === "https://legacy.example.invalid/v1"
    && legacyInline.route?.apiKey === "fake-legacy-inline"
    && /custom_providers\.legacy-lab/.test(String(legacyInline.route?.source)),
  legacyInline.route ? `${legacyInline.route.source} ${legacyInline.route.baseUrl}` : legacyInline.why);

const legacyEnv = routeForModel("custom:legacy-env:whatever", legacyHome);
check("legacy 条目用 key_env + api 别名时，key 从该 home 的 .env 取、模型回落到 default_model",
  legacyEnv.route?.apiKey === "fake-legacy-key"
    && legacyEnv.route?.model === "whatever"
    && legacyEnv.route?.baseUrl === "https://legacy-env.example.invalid/v1",
  legacyEnv.route ? `${legacyEnv.route.model} ${legacyEnv.route.apiKey === "fake-legacy-key" ? "key:env" : "key:?"}` : legacyEnv.why);

const legacyKeyName = routeForModel("custom:legacy-keyname:x", legacyHome);
check("legacy 条目缺 name 时用 provider_key 当条目名",
  legacyKeyName.route?.baseUrl === "https://legacy-key.example.invalid/v1",
  legacyKeyName.route ? String(legacyKeyName.route.source) : legacyKeyName.why);

const legacyOff = routeForModel("custom:legacy-off:x", legacyHome);
check("enabled: false 的条目不可路由（不能给停用的端点花钱）",
  legacyOff.route === null && /legacy-off/.test(legacyOff.why),
  legacyOff.route ? String(legacyOff.route.baseUrl) : legacyOff.why);

const bothForms = routeForModel("custom:both:m", legacyHome);
check("同一个名字在两处都声明时，沿用 hermes 的顺序：legacy 列表先声明先赢",
  bothForms.route?.baseUrl === "https://from-legacy.example.invalid/v1",
  String(bothForms.route?.baseUrl));

// ---- 4c) `${VAR}` in api_key is expanded, exactly as the runtime does it (#87) ---------------
// `api_key: ${MY_KEY}` is the documented way to keep the secret in .env. Read literally, the
// placeholder is a NON-EMPTY string — it passes every emptiness check and goes to the vendor as the
// credential, so the summary fails with the vendor's own 401 while chat on the same provider works.
const phHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-placeholder-home-"));
fs.writeFileSync(path.join(phHome, ".env"), "PLACEHOLDER_KEY=fake-expanded-key\n");
fs.writeFileSync(path.join(phHome, "config.yaml"), [
  "custom_providers:",
  "  - name: ph-ok",
  "    base_url: https://ph.example.invalid/v1",
  "    api_key: ${PLACEHOLDER_KEY}",
  "providers:",
  "  ph-missing:",
  "    base_url: https://ph2.example.invalid/v1",
  "    api_key: ${NOT_IN_ANY_ENV}",
  "  ph-plain:",
  "    base_url: https://ph3.example.invalid/v1",
  "    api_key: fake-plain-key",
].join("\n"));

const phOk = routeForModel("custom:ph-ok:m", phHome);
check("api_key 写成 ${VAR} 时按运行时语义展开（不再把占位符当密钥发出去）",
  phOk.route?.apiKey === "fake-expanded-key",
  phOk.route ? (phOk.route.apiKey === "fake-expanded-key" ? "expanded" : "not expanded") : phOk.why);

const phPlain = routeForModel("custom:ph-plain:m", phHome);
check("api_key 写明文时照旧原样使用（展开不能误伤明文）",
  phPlain.route?.apiKey === "fake-plain-key",
  phPlain.route ? "literal" : phPlain.why);

const phMissing = routeForModel("custom:ph-missing:m", phHome);
check("占位符指向不存在的变量时拒绝路由，并点名那个变量（不带着假密钥打上游）",
  phMissing.route === null && phMissing.why.includes("${NOT_IN_ANY_ENV}") && !phMissing.why.includes("\\$"),
  phMissing.why);

// ---- 5) the vendor's own status survives the error path (#85) ------------------------------
// A 403 `model_not_allowed` used to arrive as 502 「网关故障」. The error object now carries the
// status, which is what index.ts maps back onto the response.
const { DashscopeError } = await import("../../packages/server/src/dashscope.ts");
stubStatus = 403;
let thrown: unknown = null;
try {
  await summarizeForSpeech({
    text: "一段需要压成口播的话。", maxChars: 120, prompt: "压成 {maxChars} 字", model: "qwen3.8-flash",
    timeoutSec: 5, endpoint: { baseUrl, apiKey: "sk-stub" },
  });
} catch (e) { thrown = e; }
check("上游 403 时抛的是 DashscopeError（不是被吞掉）", thrown instanceof DashscopeError,
  thrown instanceof DashscopeError ? "" : String(thrown));
check("错误里带着上游真实状态码 403（路由据此不再一律 502）",
  (thrown as { upstreamStatus?: number } | null)?.upstreamStatus === 403,
  String((thrown as { upstreamStatus?: number } | null)?.upstreamStatus));
check("错误文本保留上游原话（model_not_allowed）",
  /model_not_allowed/.test(String((thrown as Error)?.message ?? "")),
  String((thrown as Error)?.message ?? "").slice(0, 90));
stubStatus = 200;

stub.close();

// ---- verdict ------------------------------------------------------------------------------
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
