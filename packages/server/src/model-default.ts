// 把"我刚选的模型"落成 agent 自己的全局默认（#62-3）。
//
// 为什么 server 直接改配置文件：agentus 换模型只影响当前会话，而 agent 侧的默认值住在它自己的
// 配置里（Hermes 是 `<HERMES_HOME>/config.yaml` 的 `model.default` + `model.provider`）。桌面/
// 沙箱部署一人一环境，"最近一次选择 = 我想要的默认"是正确语义，所以选定即回写，不弹确认。
//
// 三条纪律：
//   · 只在 server 的 setModel **成功之后**、且是操作者动作时调用（重放不算，见 session-manager）。
//   · 写完必须能读回来：写盘前用真 YAML 解析器验一遍 `model.default` 是不是那个值，验不过就**拒写**。
//     这是别人的全局配置文件，写坏了下次 spawn 直接起不来 —— 宁可不动，也不能"改成功但改坏"。
//   · 原子写（临时文件 + rename）并保持原权限。
//   · 写进去的必须是 hermes 的**配置形状**，不是 ACP 的线格式：`default: <裸模型名>` +
//     `provider: custom:<条目名>`。把选择器的三段 id（`custom:<条目>:<模型>`）直接塞进
//     `model.default`，新建会话会把它整体当模型名发出去（`404 model_not_found`），或者被按第一个
//     冒号切成 `provider=custom` + 剩下的整串 —— 静默跑到别的端点上（#72）。
//   · 端点跟着条目走：命名条目自己声明 api_url/api_mode，块里残留的是**上一个** provider 的口子
//     （`base_url` 指向旧云端点、`api_mode: codex_responses`），换 provider 时必须清掉，
//     否则它会盖掉条目的声明。
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export interface WriteBackResult {
  ok: boolean;
  changed: boolean;
  /** 写进去的 provider；null = 没写（推不出或不安全） */
  provider: string | null;
  /** 写进 `model.default` 的裸模型名（从 ACP choice id 拆出来的那个） */
  model?: string;
  reason?: string;
}

export interface WriteBackOptions {
  /** agent 在 `availableModels[].description` 里自己声明的 provider；推不出就别传 */
  provider?: string | null;
  /** hermes 的 `-p <profile>`：named profile 是**另一个** home，不能写到默认 profile 上 */
  profile?: string | null;
}

/** agent 的配置文件在哪。
 *
 *  `home` 是 `buildSpawnEnv().home`，对 hermes 而言**就是 HERMES_HOME 本身**（backends.ts 的
 *  `isolation.homeVar = "HERMES_HOME"`, `homeDefault = ~/.hermes`）—— 不能再拼一层 `.hermes`。
 *  同仓的 `speech/route.ts` 也是 `path.join(home, "config.yaml")`。 */
function configPath(backend: string, home: string | null | undefined, profile: string | null | undefined): string | null {
  if (backend !== "hermes" || !home) return null;
  const root = profile ? path.join(home, "profiles", profile) : home;
  return path.join(root, "config.yaml");
}

/** 从模型清单的 description（"Provider: DeepSeek"）里取 provider。
 *  前缀猜（deepseek-* → deepseek）在共享 key 的多端点部署里是错的，agent 自己声明的那个才对。
 *
 *  但描述会带杂质：hermes 的 named catalog 拼的是 `Provider: <label> • <desc> • current`，
 *  所以剥掉尾部的状态词之后还得**只接受标识符形状**（`Anthropic (Claude Sonnet 4.5)` 这种
 *  写进 `model.provider` 会让 agent 起不来）—— 不合格就当没推出来，只写 default。 */
export function providerFromDescription(description: string | null | undefined): string | null {
  const m = /^\s*provider:\s*(.+)$/i.exec(description ?? "");
  if (!m) return null;
  const name = m[1]
    .replace(/[•·|,-]?\s*\b(current|active|selected|default)\b\s*$/i, "")
    .replace(/[•·|,\s-]+$/g, "")
    .trim();
  return /^[A-Za-z0-9._:-]+$/.test(name) ? name : null;
}

const headerAt = (lines: string[]): number => lines.findIndex((l) => /^model:\s*(#.*)?\r?$/.test(l));

/** 在 `model:` 块里定位某个键的行号；列 0 的 `#` 是注释，不结束块（夹在块里是合法的）。 */
function findInModelBlock(lines: string[], key: string): number {
  const start = headerAt(lines);
  if (start < 0) return -1;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (!line.trim()) continue;
    if (/^#/.test(line)) continue; // 注释：不影响结构，继续找
    if (/^\S/.test(line)) break; // 下一个顶层键
    if (new RegExp(`^\\s+${key}:`).test(line)) return i;
  }
  return -1;
}

/** 块内第一个键的缩进（插入新键时用它，别硬编码 2 空格 —— 4 空格的文件会写出 nested mapping）。 */
function blockIndent(lines: string[]): string {
  const start = headerAt(lines);
  if (start < 0) return "  ";
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (!line.trim()) continue;
    if (/^#/.test(line)) continue;
    if (/^\S/.test(line)) break;
    const m = /^(\s+)\S/.exec(line);
    if (m) return m[1];
  }
  return "  ";
}

/** 只接受能安全裸写的标量；其余加单引号（`:`、`#`、`&`、`*` 会把标量改语义）。 */
function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9._:/@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

function setKey(lines: string[], key: string, value: string, indent: string): string[] {
  const eol = lines.some((l) => l.endsWith("\r")) ? "\r" : "";
  const rendered = `${indent}${key}: ${yamlScalar(value)}`;
  const at = findInModelBlock(lines, key);
  if (at >= 0) {
    if (lines[at].replace(/\r$/, "") === rendered) return lines;
    const copy = [...lines];
    copy[at] = `${rendered}${eol}`;
    return copy;
  }
  const start = headerAt(lines);
  if (start < 0) return [...lines, `model:${eol}`, `${rendered}${eol}`];
  const copy = [...lines];
  copy.splice(start + 1, 0, `${rendered}${eol}`);
  return copy;
}


/** 命名端点（`providers:` 的键 / `custom_providers:` 的 name）在配置里声明的端点与协议。
 *
 *  写回时这两样是**端点归属**的唯一来源：provider 认条目，端口跟着条目走。块级的
 *  `base_url` / `api_mode` 是上一个 provider 留下的，换 provider 时要清掉（#72）。 */
export interface EndpointInfo {
  /** 持久身份：`custom:<config 键>`（legacy 条目用规范化后的 name） */
  id: string;
  /** 条目自己声明的端点；`null` = 这个块没有端点（见 `namedEndpoints` 为什么跳过它） */
  apiUrl: string | null;
  apiMode: string | null;
  /** 条目声明的模型 id；`models:` 没写就是空数组（靠发现拿模型的那种条目） */
  models: string[];
}

/** 一张表两个命名空间：**键**是身份，**显示名**只是弱别名。 */
export interface NamedEndpoints {
  byKey: Map<string, EndpointInfo>;
  byAlias: Map<string, EndpointInfo>;
}

/** hermes 的 `custom_provider_slug`：小写、空格换连字符、补 `custom:` 前缀。 */
const customSlug = (display: string): string => {
  const normalized = display.trim().toLowerCase().replace(/ /g, "-");
  return normalized.startsWith("custom:") ? normalized : `custom:${normalized}`;
};

const bareName = (id: string): string => id.trim().toLowerCase().replace(/^custom:/, "");

/** hermes 的 `is_provider_enabled`：假值一律视为停用（非字符串非布尔的容器值按 truthiness）。 */
const isDisabled = (entry: Record<string, unknown>): boolean => {
  const raw = entry.enabled;
  if (raw === undefined || raw === null) return false;
  if (typeof raw === "boolean") return !raw;
  if (typeof raw === "string") {
    return ["false", "no", "off", "0", "disabled"].includes(raw.trim().toLowerCase());
  }
  return !raw;
};

/** 条目声明的模型 id（`models:` 里元素可以是字符串或 `{id|model|name}`）。 */
const declaredModels = (entry: Record<string, unknown>): string[] => {
  const raw = entry.models;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const value = typeof item === "string" ? item
      : item && typeof item === "object" ? ((item as Record<string, unknown>).id
        ?? (item as Record<string, unknown>).model ?? (item as Record<string, unknown>).name) : null;
    const text = typeof value === "string" ? value.trim() : "";
    if (text) out.push(text);
  }
  return out;
};

/** 配置里**真的能路由**的命名端点：键是持久身份 `custom:<条目>`，显示名另作弱别名。
 *
 *  三条判据都是 hermes 自己的：
 *
 *  1. **没有端点的块不是命名端点。** `providers.bedrock: {stale_timeout_seconds: 600}` 是给内置
 *     provider 调参的，`_pick_provider_base_url` 为空的条目会被 `get_compatible_custom_providers`
 *     丢掉、`resolve_user_provider` 也不认 —— 把它当端点写下去，`custom:bedrock` 是个谁都不认识的
 *     身份，还会顺手删掉块里唯一能路由的 `base_url`。所以这种块整条跳过。
 *  2. **停用条目不存在**（`enabled: false`）：写进 `model.provider` 等于让下一次 spawn 起不来。
 *  3. **别名永不覆盖键。** 条目 A 的 `name:` 可能与条目 B 的键同名；键是身份、别名只是「描述里印的
 *     是哪个名字」，所以别名只在键查不到时用，且先到先得（hermes 的解析也是取第一个匹配）。
 *
 *  端点字段顺序照 hermes 的 `_pick_provider_base_url`：`base_url` → `url` → `api`。
 *  `api_url` 是 inventory 行（运行时）的字段，不是 config 键；只作最后容错。 */
export function namedEndpoints(doc: unknown): NamedEndpoints {
  const byKey = new Map<string, EndpointInfo>();
  const byAlias = new Map<string, EndpointInfo>();
  const endpointOf = (entry: Record<string, unknown>): string | null => {
    for (const key of ["base_url", "url", "api", "api_url"]) {
      const value = entry[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  };
  const add = (id: string, entry: Record<string, unknown>): void => {
    const apiUrl = endpointOf(entry);
    if (!apiUrl) return; // 见上：调参块不是端点
    const info: EndpointInfo = {
      id, apiUrl,
      apiMode: typeof entry.api_mode === "string" ? entry.api_mode : null,
      models: declaredModels(entry),
    };
    // 同一个键写两遍时后者覆盖（YAML 本身也不允许），但别名绝不覆盖任何已存在的**键**。
    byKey.set(id, info);
    const display = typeof entry.name === "string" ? entry.name.trim() : "";
    if (display) {
      const alias = customSlug(display);
      if (!byKey.has(alias) && !byAlias.has(alias)) byAlias.set(alias, info);
    }
  };
  const d = (doc ?? {}) as { providers?: unknown; custom_providers?: unknown };
  const providers = d.providers;
  if (providers && typeof providers === "object" && !Array.isArray(providers)) {
    for (const [key, entry] of Object.entries(providers as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const raw = entry as Record<string, unknown>;
      if (isDisabled(raw)) continue;
      // 键是身份（显示名可以改），和 hermes 的 custom_provider_slug(display, key) 同一个取向。
      add(customSlug(key), raw);
    }
  }
  const legacy = d.custom_providers;
  if (Array.isArray(legacy)) {
    for (const entry of legacy) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const raw = entry as Record<string, unknown>;
      if (isDisabled(raw)) continue;
      const name = typeof raw.name === "string" ? raw.name.trim() : "";
      if (!name) continue;
      add(customSlug(name), raw);
    }
  }
  return { byKey, byAlias };
}

export interface ChoiceSplit {
  /** hermes `model.default` 该写的值：裸模型名 */
  model: string;
  /** hermes `model.provider` 该写的值；null = 推不出来，**保持原样**（不猜） */
  provider: string | null;
  /** true = 这个 id 描述了一个本配置里没有的条目，且连 provider 都定不下来：不许写 */
  unresolved?: boolean;
}

/** 把选择器的 choice id 拆回 `(裸模型名, 持久 provider 身份)`。
 *
 *  规则就是 hermes 自己的那条：provider 只在左半段是**已知 provider/条目**时才算分隔符，
 *  否则整串都是模型名（`anthropic/claude-3.5-sonnet:beta` 不能被切）。
 *
 *  描述（`Provider: <名字>`）只当**弱**信号用，这是这里最容易错的地方：
 *  - 它印的是条目的**显示名**，可能与另一个条目/内置 provider 重名，所以只有「条目自己声明了这个
 *    模型」时它才算证据（否则 `OpenRouter` 这个显示名会把内置 openrouter 的 pick 拽到本地代理上）；
 *  - 带前缀的 id（`<左段>:<模型>`）里左段不是键时一律按 canonical/provider 读，不看描述 —— 行自己
 *    带来的前缀比描述更权威；
 *  - 什么都推不出来时返回 `provider: null`（调用方保持 `model.provider` 原样），不写一个不存在的
 *    slug —— 那会让下一次 spawn 拿到一个解析不了的 provider。 */
export function splitChoiceId(
  modelId: string,
  providerHint: string | null,
  named: NamedEndpoints,
): ChoiceSplit {
  const raw = (modelId ?? "").trim();
  if (!raw) return { model: raw, provider: null };
  const lowered = raw.toLowerCase();
  const hintSlug = providerHint
    ? (providerHint.includes(":") ? providerHint.trim().toLowerCase() : customSlug(providerHint))
    : null;
  const keyInfo = hintSlug ? named.byKey.get(hintSlug) : undefined;
  const aliasInfo = hintSlug && !keyInfo ? named.byAlias.get(hintSlug) : undefined;
  /** 描述指向的条目身份（键优先，别名次之）。只在 `custom:` 前缀已经把「这是条目」说清的地方用。 */
  const hintEntryId = keyInfo?.id ?? aliasInfo?.id ?? null;
  /** 描述本身长得像一个 provider slug（而不是一句显示名）：`Alibaba` / `kimi-coding`。 */
  const hintIsSlug = Boolean(hintSlug && /^[a-z0-9][a-z0-9._-]*$/.test(hintSlug.replace(/^custom:/, "")));
  const declares = (info: EndpointInfo | undefined, model: string): boolean =>
    Boolean(info && model && info.models.some((m) => m.toLowerCase() === model.toLowerCase()));

  // 1) `custom:<…>` —— 前缀自己说明「这是个 custom 条目」，所以这里别名也算数（F5：显示名 → 键）。
  if (lowered.startsWith("custom:")) {
    const rest = raw.slice("custom:".length);
    const cut = rest.indexOf(":");
    if (cut > 0) {
      const head = customSlug(rest.slice(0, cut));
      const entry = named.byKey.get(head) ?? named.byAlias.get(head);
      if (entry) return { model: rest.slice(cut + 1).trim(), provider: entry.id };
      // 第二段不是条目，两种读法都说得通，只能让条目自己的声明白话：
      //  · 条目**声明了** `qwen3:32b` 这种带冒号的模型 → 旧形状（模型名是整段）
      //  · 条目声明了后半段 → 条目前缀是陈旧的（条目被改名/删掉过，对话框还是旧快照）
      // 两种都对上（或都没声明）才是真歧义：那时不写，让调用方看到原因。
      if (keyInfo && declares(keyInfo, rest)) return { model: rest.trim(), provider: keyInfo.id };
      if (keyInfo && declares(keyInfo, rest.slice(cut + 1).trim())) {
        return { model: rest.slice(cut + 1).trim(), provider: keyInfo.id };
      }
      // 真歧义：条目既没声明整段、也没声明后半段。写哪个都得赌一次，所以不写（reason 会带上）。
      return { model: raw, provider: null, unresolved: true };
    }
    // `custom:<模型>`：模型名是确定的那半，provider 只能靠描述推。
    return { model: rest.trim(), provider: hintEntryId };
  }

  // 2) `<左段>:<模型>`：左段是配置键 → 身份权威；否则整段就是模型名的一部分被行前缀带着，
  //    按 provider/canonical slug 原样写（`openrouter:claude` 绝不能因为显示名重名改成 custom:x）。
  const cut = raw.indexOf(":");
  if (cut > 0) {
    const left = raw.slice(0, cut).trim().toLowerCase();
    const tail = raw.slice(cut + 1).trim();
    const entry = named.byKey.get(customSlug(left));
    if (entry) return { model: tail, provider: entry.id };
    // 左段与描述指的是同一个名字，且那个名字是个 provider slug ⇒ 左段就是 provider（`alibaba:x`）。
    if (hintIsSlug && bareName(customSlug(left)) === bareName(hintSlug ?? "")) {
      // 只有**键**能当身份：别名说「描述里印的是这个名字」，而 cloud 与本地代理重名时
      // 正是靠这一条才不会把云 provider 的 pick 写成本地条目（MAJOR 3）。
      return { model: tail, provider: keyInfo?.id ?? left };
    }
    // 其余情况：左段不是已知条目/描述里的名字，那它可能只是模型名的一部分
    // （`anthropic/claude-3.5-sonnet:beta` 的冒号在斜杠后面）。整串留着，不猜。
    return { model: raw, provider: null };
  }

  // 3) 裸模型名：键就是证据；显示名要再对上「条目声明了这个模型」才算（重名时不敢认）。
  if (keyInfo) return { model: raw, provider: keyInfo.id };
  if (aliasInfo && declares(aliasInfo, raw)) return { model: raw, provider: aliasInfo.id };
  // 描述是个 slug 形状（`Alibaba`/`kimi-coding`）⇒ canonical provider，写下去 hermes 认得。
  // 一句显示名（`My Lab Box`）推不出任何身份，保持 `model.provider` 原样。
  if (hintIsSlug && hintSlug) return { model: raw, provider: bareName(hintSlug) };
  return { model: raw, provider: null };
}

function deleteKey(lines: string[], key: string): string[] {
  const at = findInModelBlock(lines, key);
  if (at < 0) return lines;
  const copy = [...lines];
  copy.splice(at, 1);
  return copy;
}

/** 把 modelId（以及可安全推断时的 provider）写进 agent 的配置文件。 */
export function writeModelDefault(
  backend: string,
  home: string | null | undefined,
  modelId: string,
  options: WriteBackOptions = {},
): WriteBackResult {
  const profile = options.profile ? String(options.profile).trim() || null : null;
  const file = configPath(backend, home, profile);
  if (!file) return { ok: false, changed: false, provider: null, reason: `${backend}: no known config file` };
  if (!existsSync(file)) return { ok: false, changed: false, provider: null, reason: `no config at ${file}` };
  if (!modelId) return { ok: false, changed: false, provider: null, reason: "empty model id" };

  let text: string;
  let mode: number;
  try {
    text = readFileSync(file, "utf8");
    mode = statSync(file).mode & 0o777;
  } catch (e) {
    return { ok: false, changed: false, provider: null, reason: `unreadable: ${(e as Error).message}` };
  }

  const lines = text.split("\n");
  // 行内 flow（`model: {…}`）和锚点（`model: &m`）都不是"块"：追加会造出第二个顶层 `model:`。
  // 这种形状一律拒写 —— 我们只改块，不重排别人的文件。
  const header = lines.find((l) => /^model:/.test(l));
  if (header !== undefined && headerAt(lines) < 0) {
    return { ok: false, changed: false, provider: null, reason: `model: is not a plain block (${header.trim().slice(0, 40)})` };
  }

  // 配置里有哪些命名端点，决定了 choice id 怎么拆、以及块内残留的端点要不要清。
  let before: unknown = null;
  try { before = parseYaml(text); } catch { before = null; }
  const named = namedEndpoints(before);
  const split = splitChoiceId(modelId, options.provider ?? null, named);
  const provider = split.provider;
  const desiredModel = split.model;
  if (split.unresolved) {
    // 对话框拿的是旧快照时会出现：条目已被改名/删除，pick 却还带着 `custom:<旧名>:<模型>`。
    // 把它当 model.default 写下去，等于把 #72 的病灶重新种进配置（模型名带条目前缀、或按第一个冒号
    // 切成 provider=custom），所以整次拒写，让调用方看到原因。
    return {
      ok: false, changed: false, provider, model: desiredModel,
      reason: `refusing to write: ${modelId} names an endpoint this config does not declare`,
    };
  }
  const previousProvider = (before as { model?: { provider?: unknown } } | null)?.model?.provider;
  const previous = typeof previousProvider === "string" ? previousProvider.trim() : null;
  const providerChanged = provider != null && provider !== previous;
  // 端点归属问的是「这个条目**声明了**端点吗」，不是「有这个条目吗」：没有端点的块是给内置
  // provider 调参用的（见 namedEndpoints），它既不拥有块里的 base_url，也当不了 model.provider。
  const entry = provider ? named.byKey.get(provider) : undefined;
  // 块级的 base_url/api_mode 是**上一个 provider 的口子**，两种情况下都必然过期或多余：
  //   · 换了 provider —— 它描述的是被换掉的那一个；
  //   · 新 provider 是命名条目 —— 端点归条目所有（条目改了端口/协议，块里那份就成了矛盾状态）。
  // 只按「换 provider 且端点归某个条目」判断，会漏掉 `custom → openrouter`（新 provider 不声明端点），
  // 于是写出「provider 是云厂商、base_url 还指着本地边车」的块，那正是 #72 B 段的错路由。
  const dropEndpointKeys = providerChanged || Boolean(entry?.apiUrl);

  const indent = blockIndent(lines);
  let work = lines;
  if (provider) work = setKey(work, "provider", provider, indent);
  work = setKey(work, "default", desiredModel, indent);
  if (dropEndpointKeys) {
    work = deleteKey(work, "base_url");
    work = deleteKey(work, "api_mode");
  }

  const next = work.join("\n");
  if (next === text) return { ok: true, changed: false, provider, model: desiredModel };

  // 写盘前的最后一道闸：真解析一遍。不只看"两行读得回"，要看**这个块自洽**——
  // provider 指向的条目和块里的端点必须是同一个端点，否则整次拒写（旧闸门会稳定放过矛盾状态）。
  // 常规路径上端点键已经在上面被删掉了，所以这里主要拦 `deleteKey` 正则认不出的写法
  // （`base_url :` 中间带空格之类）—— 门槛低但便宜，且它是唯一一处验证「磁盘上的块」而不是
  // 「我打算写的块」的地方。
  let doc: unknown;
  try {
    doc = parseYaml(next);
  } catch (e) {
    return { ok: false, changed: false, provider, model: desiredModel, reason: `refusing to write: result would not parse (${(e as Error).message.split("\n")[0]})` };
  }
  const model = (doc as { model?: { default?: unknown; provider?: unknown; base_url?: unknown; api_mode?: unknown } } | null)?.model;
  if (!model || model.default !== desiredModel) {
    return { ok: false, changed: false, provider, model: desiredModel, reason: "refusing to write: model.default would not read back" };
  }
  if (provider && model.provider !== provider) {
    return { ok: false, changed: false, provider, model: desiredModel, reason: "refusing to write: model.provider would not read back" };
  }
  if (entry?.apiUrl) {
    const norm = (v: unknown) => String(v ?? "").trim().replace(/\/+$/, "").toLowerCase();
    const blockUrl = norm(model.base_url);
    if (blockUrl && blockUrl !== norm(entry.apiUrl)) {
      return { ok: false, changed: false, provider, model: desiredModel, reason: `refusing to write: model.base_url (${String(model.base_url)}) is not where ${provider} lives (${entry.apiUrl})` };
    }
    if (model.api_mode && entry.apiMode && String(model.api_mode) !== entry.apiMode) {
      return { ok: false, changed: false, provider, model: desiredModel, reason: `refusing to write: model.api_mode (${String(model.api_mode)}) contradicts ${provider} (${entry.apiMode})` };
    }
  }

  // 配置里可能有 api_key：比 0600 宽的一律收紧。
  const targetMode = mode & 0o077 ? 0o600 : mode;
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    copyFileSync(file, `${file}.bak-${Date.now()}`); // 别人的配置，改之前留一份
    writeFileSync(tmp, next, { mode: targetMode });
    chmodSync(tmp, targetMode);
    renameSync(tmp, file);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    return { ok: false, changed: false, provider, model: desiredModel, reason: `write failed: ${(e as Error).message}` };
  }
  return { ok: true, changed: true, provider, model: desiredModel };
}
