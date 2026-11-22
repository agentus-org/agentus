/**
 * #112 — 把「按模型记住的上下文窗口」回写进 agent 的 config.yaml。
 *
 * 选模型时 `model-default.ts` 回写 `model.default`；窗口这一项回写
 *   model_overrides:
 *     <provider>:
 *       <model>:
 *         context_window: <int>
 * 这是 Hermes 解析优先级里最高的一档（per-model explicit patch），只影响这个模型，
 * 不碰 profile 级 `model.context_length`（issue #112 §3 明确不要写那里）。
 *
 * 安全范式照抄 `model-default.ts`：只做「行级定点编辑」不重排别人的文件；写盘前用
 * `yaml.parse` 真解析一遍并回读确认；备份 → 临时文件 → 原子 rename；收紧权限到 0600
 * （配置里可能有 api_key）。任何一步不放心就整次拒写。
 */
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export interface ContextWriteResult {
  ok: boolean;
  changed: boolean;
  reason?: string;
}

/** 把 usage 行的预算值解析成 token 数。`auto` → null（清空语义）。非法 → undefined。 */
export function parseBudget(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s || /^auto$/i.test(s)) return null;
  const m = /^(\d+(?:\.\d+)?)\s*([KkMmGg])?$/.exec(s);
  if (!m) return undefined;
  const mult = m[2] ? { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase() as "k" | "m" | "g"] : 1;
  const n = Math.floor(parseFloat(m[1]) * mult);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const isTopLevel = (line: string): boolean => /^\S/.test(line.replace(/\r$/, ""));

/** 顶层块 `key:` 的行号（只认行内无值的纯块头；`key: {…}` / `key: &a` 不是块）。 */
function topBlockAt(lines: string[], key: string): number {
  return lines.findIndex((l) => new RegExp(`^${key}:\\s*(#.*)?\\r?$`).test(l));
}

/** 在给定块范围里找某个 indent 层级的键行；列 0 的 `#` 是注释不结束块。 */
function keyAtInBlock(lines: string[], start: number, key: string, indent: number): number {
  const prefix = " ".repeat(indent);
  for (let i = start + 1; i < lines.length; i++) {
    const bare = lines[i].replace(/\r$/, "");
    if (!bare.trim()) continue;
    if (isTopLevel(bare)) break;
    // 冒号后可能是行尾（块头 `model:` 无值），也可能有空格（`context_window: 524288`）。
    if (new RegExp(`^${prefix}${key}:(?:\\s|$)`).test(bare)) return i;
  }
  return -1;
}

/** 键行的实际缩进（照着同块下一个更深层键推断，4 空格文件别硬写 2）。 */
function childIndent(lines: string[], start: number, fallback: number): number {
  for (let i = start + 1; i < lines.length; i++) {
    const bare = lines[i].replace(/\r$/, "");
    if (!bare.trim() || /^#/.test(bare)) continue;
    if (isTopLevel(bare)) break;
    const m = /^(\s+)\S/.exec(bare);
    if (m) return m[1].length;
  }
  return fallback;
}

/**
 * 纯函数：把 (provider, model) 的 context_window 设成 value，返回新文本。
 * value=null → 删掉该键（auto 清空）。block 形状不认识就返回原文本 + ok:false。
 */
export function applyContextWindow(text: string, provider: string, model: string, value: number | null): { text: string } & ContextWriteResult {
  const eol = text.includes("\r\n") ? "\r" : "";
  const lines = text.split("\n");
  const root = topBlockAt(lines, "model_overrides");
  if (root < 0) {
    if (value === null) return { text, ok: true, changed: false }; // 没有覆盖块，清空本就是 no-op
    lines.push(`model_overrides:${eol}`, `  ${provider}:${eol}`, `    ${model}:${eol}`, `      context_window: ${value}${eol}`);
    return { text: lines.join("\n"), ok: true, changed: true };
  }
  const pIndent = childIndent(lines, root, 2);
  const mIndent = pIndent + 2;
  const cIndent = mIndent + 2;

  const pAt = keyAtInBlock(lines, root, provider, pIndent);
  if (pAt < 0) {
    if (value === null) return { text, ok: true, changed: false };
    const copy = [...lines];
    copy.splice(root + 1, 0, `${" ".repeat(pIndent)}${provider}:${eol}`, `${" ".repeat(mIndent)}${model}:${eol}`, `${" ".repeat(cIndent)}context_window: ${value}${eol}`);
    return { text: copy.join("\n"), ok: true, changed: true };
  }
  const pEnd = blockEnd(lines, pAt);
  const mAt = keyAtInBlock(lines, pAt, model, mIndent);
  if (mAt < 0 || mAt >= pEnd) {
    if (value === null) return { text, ok: true, changed: false };
    const copy = [...lines];
    copy.splice(pAt + 1, 0, `${" ".repeat(mIndent)}${model}:${eol}`, `${" ".repeat(cIndent)}context_window: ${value}${eol}`);
    return { text: copy.join("\n"), ok: true, changed: true };
  }
  const mEnd = blockEnd(lines, mAt);
  const cAt = keyAtInBlock(lines, mAt, "context_window", cIndent);
  const hasC = cAt >= 0 && cAt < mEnd;

  if (value === null) {
    if (!hasC) return { text, ok: true, changed: false };
    const copy = [...lines];
    copy.splice(cAt, 1);
    return { text: copy.join("\n"), ok: true, changed: true };
  }
  const rendered = `${" ".repeat(cIndent)}context_window: ${value}`;
  if (hasC) {
    if (lines[cAt].replace(/\r$/, "") === rendered) return { text, ok: true, changed: false };
    const copy = [...lines];
    copy[cAt] = `${rendered}${eol}`;
    return { text: copy.join("\n"), ok: true, changed: true };
  }
  const copy = [...lines];
  copy.splice(mAt + 1, 0, `${rendered}${eol}`);
  return { text: copy.join("\n"), ok: true, changed: true };
}

function blockEnd(lines: string[], start: number): number {
  for (let i = start + 1; i < lines.length; i++) {
    if (isTopLevel(lines[i].replace(/\r$/, ""))) return i;
  }
  return lines.length;
}

/** 回读校验：解析写后的文本，确认 context_window 真的等于目标（auto 则确认键不在了）。 */
function readsBack(text: string, provider: string, model: string, value: number | null): boolean {
  let doc: unknown;
  try { doc = parseYaml(text); } catch { return false; }
  const got = (doc as { model_overrides?: Record<string, Record<string, { context_window?: unknown }>> } | null)
    ?.model_overrides?.[provider]?.[model]?.context_window;
  return value === null ? got === undefined : Number(got) === value;
}

/** 原子写盘 + 校验。config.yaml 不存在时拒写（不替用户新建 agent 配置）。 */
export function writeContextWindow(
  file: string,
  provider: string,
  model: string,
  value: number | null,
): ContextWriteResult {
  let text: string;
  let mode = 0o644;
  try {
    text = readFileSync(file, "utf-8");
    mode = statSync(file).mode & 0o777;
  } catch (e) {
    return { ok: false, changed: false, reason: `unreadable: ${(e as Error).message}` };
  }
  const applied = applyContextWindow(text, provider, model, value);
  if (!applied.ok) return applied;
  if (!applied.changed) return { ok: true, changed: false };
  if (!readsBack(applied.text, provider, model, value)) {
    return { ok: false, changed: false, reason: "refusing to write: context_window would not read back" };
  }
  const targetMode = mode & 0o077 ? 0o600 : mode;
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    copyFileSync(file, `${file}.bak-${Date.now()}`);
    writeFileSync(tmp, applied.text, { mode: targetMode });
    chmodSync(tmp, targetMode);
    renameSync(tmp, file);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    return { ok: false, changed: false, reason: `write failed: ${(e as Error).message}` };
  }
  return { ok: true, changed: true };
}

/** agent 的 config.yaml 路径。与 model-default.ts:configPath() 同规则（hermes + home + 可选 profile）。 */
export function agentConfigPath(backend: string, home: string | null | undefined, profile: string | null | undefined): string | null {
  if (backend !== "hermes" || !home) return null;
  const root = profile ? path.join(home, "profiles", profile) : home;
  const file = path.join(root, "config.yaml");
  return existsSync(file) ? file : null;
}
