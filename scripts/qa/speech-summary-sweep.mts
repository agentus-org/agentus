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
const stub = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    try { seen.push(JSON.parse(raw) as Body); } catch { seen.push({}); }
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

stub.close();

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

// ---- verdict ------------------------------------------------------------------------------
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
