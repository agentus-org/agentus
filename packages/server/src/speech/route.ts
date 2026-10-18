/**
 * Where a 语音总结 call should GO.
 *
 * The rule the operator asked for: use the provider and model this session is already running on
 * — I am on `deepseek:deepseek-v4-flash`, so the summary must cost money on DeepSeek, not on a
 * second provider (Bailian) that exists only because the voice pipeline needed it.
 *
 * Nothing is configured twice. The endpoint and the key are read from the SAME places the agent
 * reads its own:
 *
 *   1. `<home>/config.yaml` → `providers.<id>.{base_url,api_key,model}` — a provider the operator
 *      declared by hand (the `lab` row is the live example), literal values;
 *   2. `<home>/config.yaml` → `model_aliases.<alias>.{provider,base_url}` — a labelled shortcut;
 *   3. the builtin table below + `<home>/.env` / process env — the vendors the agent knows
 *      without being told (DeepSeek, OpenAI, OpenRouter, …).
 *
 * The table is deliberately SHORT and only holds providers whose chat surface is OpenAI-compatible
 * `/v1/chat/completions` (that is the only shape this call speaks). Anything else — Anthropic
 * Messages, Bedrock, Vertex, OAuth-only providers — resolves to null with a reason and the caller
 * falls back to the configured summary model. Silence would be the bug; a made-up endpoint is worse.
 */
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export interface SpeechRoute {
  provider: string;
  model: string;
  /** Base URL of an OpenAI-compatible surface, no trailing slash (`…/v1`). */
  baseUrl: string;
  apiKey: string;
  /** Where the endpoint came from — printed in the settings card and in errors. */
  source: string;
}

/** Vendors the agent supports out of the box, OpenAI-compatible only.
 *  Mirrors `hermes_cli/auth.py`'s registry rows (id, base url, key env, base-url env); keep it in
 *  sync when a vendor is added there. A vendor that is NOT here still works if it is declared in
 *  `config.yaml` → `providers.<id>` — that is the escape hatch, not a second config in Agentus. */
const BUILTIN: Record<string, { baseUrl: string; keys: string[]; baseEnv?: string }> = {
  deepseek: { baseUrl: "https://api.deepseek.com/v1", keys: ["DEEPSEEK_API_KEY"], baseEnv: "DEEPSEEK_BASE_URL" },
  openai: { baseUrl: "https://api.openai.com/v1", keys: ["OPENAI_API_KEY"], baseEnv: "OPENAI_BASE_URL" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", keys: ["OPENROUTER_API_KEY"], baseEnv: "OPENROUTER_BASE_URL" },
  alibaba: { baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", keys: ["DASHSCOPE_API_KEY"], baseEnv: "DASHSCOPE_BASE_URL" },
  "alibaba-coding-plan": {
    baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
    keys: ["ALIBABA_CODING_PLAN_API_KEY", "DASHSCOPE_API_KEY"],
    baseEnv: "ALIBABA_CODING_PLAN_BASE_URL",
  },
  xai: { baseUrl: "https://api.x.ai/v1", keys: ["XAI_API_KEY"], baseEnv: "XAI_BASE_URL" },
  "kimi-coding-cn": { baseUrl: "https://api.moonshot.cn/v1", keys: ["KIMI_CN_API_KEY"] },
  nvidia: { baseUrl: "https://integrate.api.nvidia.com/v1", keys: ["NVIDIA_API_KEY"], baseEnv: "NVIDIA_BASE_URL" },
  huggingface: { baseUrl: "https://router.huggingface.co/v1", keys: ["HF_TOKEN"], baseEnv: "HF_BASE_URL" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", keys: ["GROQ_API_KEY"], baseEnv: "GROQ_BASE_URL" },
};

/**
 * ACP model ids arrive as `deepseek:deepseek-v4-flash` (provider prefix, wire form) or
 * `openrouter:anthropic/claude-x`; older agents use `provider/model`. Returns "" for a bare id
 * with no prefix — the caller then has to ask config.yaml who owns it.
 */
export function splitModelId(raw: string | null | undefined): { provider: string; model: string } {
  const id = String(raw ?? "").trim();
  if (!id) return { provider: "", model: "" };
  const colon = id.indexOf(":");
  if (colon > 0) return { provider: id.slice(0, colon).trim().toLowerCase(), model: id.slice(colon + 1).trim() };
  return { provider: "", model: id };
}

function readEnvFile(p: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const i = t.indexOf("=");
      out[t.slice(0, i)] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* missing/unreadable: no env file */ }
  return out;
}

function readConfig(home: string | null): Record<string, unknown> {
  if (!home) return {};
  try {
    const doc = parseYaml(fs.readFileSync(path.join(home, "config.yaml"), "utf8"));
    return doc && typeof doc === "object" ? (doc as Record<string, unknown>) : {};
  } catch { return {}; }
}

const asString = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const trimSlash = (u: string): string => u.replace(/\/+$/, "");

/**
 * Resolve the route for one session's model. `home` is the home of the backend that session runs
 * on (`planFor(row).home`) — reading a DIFFERENT agent's config would hand this call a key its
 * model was never entitled to use.
 */
export function routeForModel(modelId: string | null | undefined, home: string | null): {
  route: SpeechRoute | null;
  why: string;
} {
  const parsed = splitModelId(modelId);
  const model = parsed.model;
  if (!model) return { route: null, why: "会话还没报出模型（agent 未握手）" };

  const cfg = readConfig(home);
  // An alias row may rename the model as well as point at a provider (`lab-qwen38-27b` →
  // `qwen38-27b`); the wire id is not the name the vendor knows.
  const aliasRow = (aliases: Record<string, unknown>): Record<string, unknown> | null => {
    const hit = aliases[String(modelId ?? "").trim()] ?? aliases[model];
    return hit && typeof hit === "object" ? (hit as Record<string, unknown>) : null;
  };
  const aliasNow = aliasRow(
    (cfg.model_aliases && typeof cfg.model_aliases === "object" ? cfg.model_aliases : {}) as Record<string, unknown>,
  );
  const aliasModel = aliasNow ? asString(aliasNow.model) : "";
  const providers = (cfg.providers && typeof cfg.providers === "object" ? cfg.providers : {}) as Record<string, unknown>;
  const aliases = (cfg.model_aliases && typeof cfg.model_aliases === "object" ? cfg.model_aliases : {}) as Record<string, unknown>;

  // Who owns this model? The id's own prefix wins; otherwise config.yaml's default provider, and
  // only when the model really is that default (a session can be running a model the default no
  // longer names — then guessing the provider would send the request to the wrong vendor).
  let provider = parsed.provider;
  if (!provider) {
    if (aliasNow) provider = asString(aliasNow.provider).toLowerCase();
  }
  if (!provider) {
    const def = (cfg.model && typeof cfg.model === "object" ? cfg.model : {}) as Record<string, unknown>;
    const defModel = asString(def.default) || asString(def.model);
    if (defModel && (defModel === model || defModel.endsWith(`:${model}`))) provider = asString(def.provider).toLowerCase();
  }
  if (!provider) return { route: null, why: `不知道该模型属于哪个 provider（会话报的是 ${modelId ?? "空"}）` };

  const envFile = home ? readEnvFile(path.join(home, ".env")) : {};
  const env = (name: string): string => String(process.env[name] ?? envFile[name] ?? "").trim();

  // 1) declared in config.yaml by the operator — the literal values win
  const declared = providers[provider] && typeof providers[provider] === "object"
    ? (providers[provider] as Record<string, unknown>) : null;
  if (declared) {
    const baseUrl = trimSlash(asString(declared.base_url));
    const apiKey = asString(declared.api_key);
    const cfgModel = asString(declared.model);
    if (baseUrl && apiKey) {
      return {
        route: { provider, model: aliasModel || model || cfgModel, baseUrl, apiKey, source: `config.yaml providers.${provider}` },
        why: "",
      };
    }
  }

  // 2) an explicit alias that carries its own base_url
  if (aliasNow) {
    const a = aliasNow;
    const baseUrl = trimSlash(asString(a.base_url));
    const apiKey = env(asString(a.api_key_env) || `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`);
    if (baseUrl && apiKey) {
      return { route: { provider, model: aliasModel || asString(a.model) || model, baseUrl, apiKey, source: `config.yaml model_aliases` }, why: "" };
    }
  }

  // 3) a vendor the agent knows: base url from the table (overridable by its env), key from env
  const builtin = BUILTIN[provider];
  if (!builtin) {
    return {
      route: null,
      why: `provider「${provider}」没有可用的 OpenAI 兼容端点（config.yaml providers 里没声明，也不在已知列表内）`,
    };
  }
  const baseUrl = trimSlash((builtin.baseEnv ? env(builtin.baseEnv) : "") || builtin.baseUrl);
  const keyName = builtin.keys.find((k) => env(k));
  if (!keyName) {
    return { route: null, why: `provider「${provider}」在本机没有 key（${builtin.keys.join(" / ")} 都没找到）` };
  }
  const from = String(process.env[keyName] ?? "").trim() ? "process env" : `${home ?? "?"}/.env`;
  return {
    route: { provider, model: aliasModel || model, baseUrl, apiKey: env(keyName), source: `${keyName}（${from}）` },
    why: "",
  };
}
