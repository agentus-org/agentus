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
 * `openrouter:anthropic/claude-x`. Returns "" for a bare id with no prefix — the caller then has to
 * ask config.yaml who owns it. The `provider/model` form is NOT handled here (a prefix here can be
 * a vendor namespace rather than a provider); `slashProvider()` below resolves it with the provider
 * tables in hand (#36).
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
 * `provider/model` — the second id form a session can report. Only stripped when the prefix really
 * names a provider this box knows (declared in config.yaml or in the builtin table): a catalogue
 * slug like `anthropic/claude-x` must survive intact, or an OpenRouter model id would be mangled
 * into provider `anthropic` + model `claude-x`.
 */
function slashProvider(cfgProviders: Record<string, unknown>, model: string): { provider: string; model: string } {
  const slash = model.indexOf("/");
  if (slash <= 0) return { provider: "", model };
  const cand = model.slice(0, slash).trim().toLowerCase();
  if (!(cand in BUILTIN) && !(cand in cfgProviders)) return { provider: "", model };
  const rest = model.slice(slash + 1).trim();
  return rest ? { provider: cand, model: rest } : { provider: "", model };
}

/**
 * ONE declared custom endpoint, whichever generation of `config.yaml` declared it (issue #86).
 *
 * Mirrors hermes' `get_compatible_custom_providers()`: the legacy top-level `custom_providers` LIST
 * and the v12+ `providers` MAP are the same thing written two ways, and deployments upgraded from
 * older versions usually still carry the list. Field names follow the same aliases hermes accepts
 * (`base_url`/`api`, `model`/`default_model`, `api_key`/`key_env`/`api_key_env`), and an explicit
 * `enabled: false` hides an entry from both shapes — a disabled endpoint must not be routable.
 */
interface CustomEndpoint {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  source: string;
}

function customEndpointOf(
  raw: unknown,
  name: string,
  source: string,
  env: (n: string) => string,
): CustomEndpoint | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const flag = e.enabled;
  if (flag === false || (typeof flag === "string" && flag.trim().toLowerCase() === "false")) return null;
  const baseUrl = trimSlash(asString(e.base_url) || asString(e.api));
  const literal = asString(e.api_key);
  const envName = asString(e.key_env) || asString(e.api_key_env);
  const apiKey = literal || (envName ? env(envName) : "");
  if (!baseUrl || !apiKey) return null;
  return { name, baseUrl, apiKey, model: asString(e.model) || asString(e.default_model), source };
}

/** The merged view: legacy list first (its entries are what an upgraded deployment actually has),
 *  then the v12+ map, first declaration of a name winning. */
function customEndpoints(cfg: Record<string, unknown>, env: (n: string) => string): CustomEndpoint[] {
  const out: CustomEndpoint[] = [];
  const seen = new Set<string>();
  const push = (e: CustomEndpoint | null): void => {
    if (!e || seen.has(e.name)) return;
    seen.add(e.name);
    out.push(e);
  };
  const legacy = cfg.custom_providers;
  if (Array.isArray(legacy)) {
    for (const raw of legacy) {
      const e = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
      const name = (asString(e?.name) || asString(e?.provider_key)).toLowerCase();
      if (!name) continue;
      push(customEndpointOf(raw, name, `config.yaml custom_providers.${name}`, env));
    }
  }
  const map = cfg.providers && typeof cfg.providers === "object" ? (cfg.providers as Record<string, unknown>) : {};
  for (const [key, raw] of Object.entries(map)) {
    const name = key.trim().toLowerCase();
    if (!name) continue;
    push(customEndpointOf(raw, name, `config.yaml providers.${name}`, env));
  }
  return out;
}

function customEndpoint(cfg: Record<string, unknown>, name: string, env: (n: string) => string): CustomEndpoint | null {
  return customEndpoints(cfg, env).find((e) => e.name === name) ?? null;
}

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
  if (!parsed.model) return { route: null, why: "会话还没报出模型（agent 未握手）" };

  // `custom:<declared>:<model>` (issue #85, layer 2). The agent reports a model that lives on a
  // NAMED entry of `config.yaml providers`, and says so by putting that entry's name in the middle
  // (hermes' `has_named_custom_provider`). Reading `custom` as the provider name found nothing —
  // `providers.custom` does not exist and `custom` is not a vendor — so every such session resolved
  // to 「没有可用的 OpenAI 兼容端点」 forever, and the summary fell back to the voice endpoint.
  // The real provider is the MIDDLE segment; the model keeps whatever colons remain in its own name.
  const custom = parsed.provider === "custom" && parsed.model.includes(":")
    ? { name: parsed.model.slice(0, parsed.model.indexOf(":")).trim().toLowerCase(),
        model: parsed.model.slice(parsed.model.indexOf(":") + 1).trim() }
    : null;
  const bareModel = custom ? custom.model : parsed.model;
  if (!bareModel) return { route: null, why: "会话还没报出模型（agent 未握手）" };

  const cfg = readConfig(home);
  const envFile = home ? readEnvFile(path.join(home, ".env")) : {};
  const env = (name: string): string => String(process.env[name] ?? envFile[name] ?? "").trim();

  // A `custom:<name>:<model>` id names a declared endpoint, and there are TWO generations of that
  // declaration in the same file (issue #86): the legacy `custom_providers` LIST and the v12+
  // `providers` MAP. Hermes reads both through `get_compatible_custom_providers()` and treats them as
  // one view; a cockpit that only knew the map answered 「providers 里没有这一条」 to an operator whose
  // endpoint is right there in `custom_providers` — chat works, every side call fails. Same file, same
  // agents, so the same view.
  if (custom) {
    const hit = customEndpoint(cfg, custom.name, env);
    if (hit) {
      return {
        route: { provider: custom.name, model: custom.model || hit.model, baseUrl: hit.baseUrl, apiKey: hit.apiKey, source: hit.source },
        why: "",
      };
    }
    // NOT falling through to the alias/builtin rungs: a `custom:` id is a claim about a declared
    // endpoint, and guessing a vendor for it is how the wrong key gets billed.
    return {
      route: null,
      why: `会话跑在自定义 provider 「${custom.name}」（${modelId}），但 ${home ? `${home}/config.yaml` : "config.yaml"} 的 providers 与 custom_providers 里都没有这一条（或它缺 base_url / api_key）—— 补上凭据，或把会话换到别的模型`,
    };
  }

  // Slash form is a LAST resort after the colon form (#36): `deepseek/deepseek-v4-flash` is what
  // this session reports, and before this the split returned no provider at all, so the summary
  // silently fell back to the voice endpoint on `qwen-flash`.
  const slash = parsed.provider
    ? { provider: parsed.provider, model: parsed.model }
    : slashProvider(
        (cfg.providers && typeof cfg.providers === "object" ? cfg.providers : {}) as Record<string, unknown>,
        parsed.model,
      );
  const model = slash.model;
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
  let provider = slash.provider;
  if (!provider) {
    if (aliasNow) provider = asString(aliasNow.provider).toLowerCase();
  }
  if (!provider) {
    const def = (cfg.model && typeof cfg.model === "object" ? cfg.model : {}) as Record<string, unknown>;
    const defModel = asString(def.default) || asString(def.model);
    if (defModel && (defModel === model || defModel.endsWith(`:${model}`))) provider = asString(def.provider).toLowerCase();
  }
  if (!provider) return { route: null, why: `不知道该模型属于哪个 provider（会话报的是 ${modelId ?? "空"}）` };

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
