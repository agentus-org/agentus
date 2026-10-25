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
//   · 原子写（临时文件 + rename）并保持原权限；只动 `model.default` / `model.provider` 两行。
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export interface WriteBackResult {
  ok: boolean;
  changed: boolean;
  /** 写进去的 provider；null = 没写（推不出或不安全） */
  provider: string | null;
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

  const provider = options.provider ? String(options.provider).trim() : null;
  const indent = blockIndent(lines);
  let work = lines;
  if (provider) work = setKey(work, "provider", provider, indent);
  work = setKey(work, "default", modelId, indent);

  const next = work.join("\n");
  if (next === text) return { ok: true, changed: false, provider };

  // 写盘前的最后一道闸：真解析一遍，两个值都得读回来。任何一个不成立就一个字都不写。
  let doc: unknown;
  try {
    doc = parseYaml(next);
  } catch (e) {
    return { ok: false, changed: false, provider, reason: `refusing to write: result would not parse (${(e as Error).message.split("\n")[0]})` };
  }
  const model = (doc as { model?: { default?: unknown; provider?: unknown } } | null)?.model;
  if (!model || model.default !== modelId) {
    return { ok: false, changed: false, provider, reason: "refusing to write: model.default would not read back" };
  }
  if (provider && model.provider !== provider) {
    return { ok: false, changed: false, provider, reason: "refusing to write: model.provider would not read back" };
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
    return { ok: false, changed: false, provider, reason: `write failed: ${(e as Error).message}` };
  }
  return { ok: true, changed: true, provider };
}
