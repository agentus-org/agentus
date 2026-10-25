// 把"我刚选的模型"落成 agent 自己的全局默认（#62-3）。
//
// 为什么 server 直接改配置文件：agentus 换模型只影响当前会话，而 agent 侧的默认值住在它自己的
// 配置里（Hermes 是 `<home>/.hermes/config.yaml` 的 `model.default` + `model.provider`）。桌面/
// 沙箱部署一人一环境，"最近一次选择 = 我想要的默认"是正确语义，所以选定即回写，不弹确认。
//
// 三条纪律：
//   · 只在 server 的 setModel **成功之后**调用 —— 被 agent 拒掉的模型不落盘（与热度计数同一个收口点）。
//   · 原子写（临时文件 + rename）并保持原权限（0600）：配置文件写坏，下一次 spawn 直接起不来。
//   · 只动 `model.default` / `model.provider` 两行，其余字节原样保留 —— 这是别人的配置，不是我们的。
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface WriteBackResult {
  ok: boolean;
  changed: boolean;
  /** 写进去的 provider；null = 保持原值（无法可靠推断时宁可不动） */
  provider: string | null;
  reason?: string;
}

/** agent 的配置文件在哪。目前只有 Hermes 这条路是已知形状；别的后端返回 null（不回写）。 */
function configPath(backend: string, home: string | null | undefined): string | null {
  if (!home) return null;
  if (backend !== "hermes") return null;
  return path.join(home, ".hermes", "config.yaml");
}

/** 从模型清单的 description（"Provider: DeepSeek"）里取 provider。
 *  前缀猜（deepseek-* → deepseek）在共享 key 的多端点部署里是错的，agent 自己声明的那个才对。 */
export function providerFromDescription(description: string | null | undefined): string | null {
  const m = /^\s*provider:\s*(.+)$/i.exec(description ?? "");
  if (!m) return null;
  const name = m[1]
    .replace(/[•·|,-]?\s*\b(current|active|selected|default)\b\s*$/i, "")
    .replace(/[•·|,\s-]+$/g, "")
    .trim();
  return name || null;
}

/** 在 `model:` 块里定位某个键的行号。块 = `^model:` 之后所有缩进行。 */
function findInModelBlock(lines: string[], key: string): number {
  const start = lines.findIndex((l) => /^model:\s*(#.*)?$/.test(l));
  if (start < 0) return -1;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^\S/.test(line)) break; // 下一个顶层键
    if (new RegExp(`^\\s+${key}:`).test(line)) return i;
  }
  return -1;
}

function setKey(lines: string[], key: string, value: string): { lines: string[]; touched: boolean } {
  const at = findInModelBlock(lines, key);
  if (at >= 0) {
    const indent = /^(\s+)/.exec(lines[at])?.[1] ?? "  ";
    const next = `${indent}${key}: ${value}`;
    if (lines[at].trim() === next.trim()) return { lines, touched: false };
    const copy = [...lines];
    copy[at] = next;
    return { lines: copy, touched: true };
  }
  // 键不存在：插到 `model:` 之后（保持它是块里第一项，读者一眼能看见）
  const start = lines.findIndex((l) => /^model:\s*(#.*)?$/.test(l));
  if (start < 0) {
    return { lines: [...lines, "model:", `  ${key}: ${value}`], touched: true };
  }
  const copy = [...lines];
  copy.splice(start + 1, 0, `  ${key}: ${value}`);
  return { lines: copy, touched: true };
}

/** 把 modelId（以及可推断时的 provider）写进 agent 的配置文件。 */
export function writeModelDefault(
  backend: string,
  home: string | null | undefined,
  modelId: string,
  options: { provider?: string | null } = {},
): WriteBackResult {
  const file = configPath(backend, home);
  if (!file) return { ok: false, changed: false, provider: null, reason: `${backend} has no known config file` };
  if (!existsSync(file)) return { ok: false, changed: false, provider: null, reason: `no config at ${file}` };
  if (!modelId) return { ok: false, changed: false, provider: null, reason: "empty model id" };

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    return { ok: false, changed: false, provider: null, reason: `unreadable: ${(e as Error).message}` };
  }
  const lines = text.split("\n");
  let work = lines;

  const provider = options.provider ? String(options.provider).trim() : null;
  // provider 先写：如果它失败，default 也就不该动（否则会指到一个不存在的 provider 上）。
  if (provider) {
    const r = setKey(work, "provider", provider);
    work = r.lines;
  }
  const d = setKey(work, "default", modelId);
  work = d.lines;

  const changed = work.join("\n") !== text;
  if (!changed) return { ok: true, changed: false, provider };

  const mode = statSync(file).mode & 0o777;
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, work.join("\n"), { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    return { ok: false, changed: false, provider, reason: `write failed: ${(e as Error).message}` };
  }
  return { ok: true, changed: true, provider };
}
