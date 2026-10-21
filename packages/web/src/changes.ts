// 回合级「它到底改了我哪些文件」 —— 纯数据面，#38。
//
// 为什么不放到 server：ACP 的 `tool_call` / `tool_call_update` payload 已经**整条**落库
// （`store.upsertToolMessage` 合并后 `JSON.stringify`，不截断），前端手上本来就有 shape。
// 再在服务端算一遍 diff 只会多出第二处真相源，而审批那条路（`boundedDiff`）是**为手机卡片
// 有界**才截断的，跟这里要的「事后回看」是两件事 —— 这个模块不读审批、不看权限模式，
// `accept_edits` 那种不问就写的回合照样有变更行。
//
// 形状照 AionUi 的 FileChangesPanel 契约（文件名 + `+N/-M` + 点开看 diff），实现是自己的：
// AionUi 是 Apache-2.0，但本仓 NOTICE 明确只致谢灵感、未拷贝代码。

/** One rendered diff line; `gap` is a collapsed unchanged run. */
export type DiffLine = { kind: "ctx" | "add" | "del" | "gap"; text: string; oldNo: number | null; newNo: number | null };

/** Unified, hunk-only line diff of the agent's before/after.
 *
 *  Hermes' edit approval hands over the WHOLE file twice (`acp.tool_diff_content`: old_text and
 *  new_text are entire file contents), and the operator's question is never "what is in this
 *  file" — it is "what changes". So: drop the common head and tail, diff the middle, then keep
 *  only changed lines plus 3 lines of context and collapse the rest into a counted gap. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.length ? oldText.replace(/\n$/, "").split("\n") : [];
  const b = newText.length ? newText.replace(/\n$/, "").split("\n") : [];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const headCtx: DiffLine[] = [];
  const CTX = 3;
  if (head > CTX) headCtx.push({ kind: "gap", text: `⋯ 上面 ${head - CTX} 行未变 ⋯`, oldNo: null, newNo: null });
  for (let i = Math.max(0, head - CTX); i < head; i++) headCtx.push({ kind: "ctx", text: a[i], oldNo: i + 1, newNo: i + 1 });

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const pairs: DiffLine[] = [];
  // LCS over the middle; a pathological pair of files would blow up memory, so fall back to
  // "the whole middle was replaced" — coarser, but still honest about what the request does.
  if (midA.length * midB.length > 250_000) {
    midA.forEach((t, i) => pairs.push({ kind: "del", text: t, oldNo: head + i + 1, newNo: null }));
    midB.forEach((t, i) => pairs.push({ kind: "add", text: t, oldNo: null, newNo: head + i + 1 }));
  } else {
    const n = midA.length, m = midB.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { pairs.push({ kind: "ctx", text: midA[i], oldNo: head + i + 1, newNo: head + j + 1 }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { pairs.push({ kind: "del", text: midA[i], oldNo: head + i + 1, newNo: null }); i++; }
      else { pairs.push({ kind: "add", text: midB[j], oldNo: null, newNo: head + j + 1 }); j++; }
    }
    while (i < n) { pairs.push({ kind: "del", text: midA[i], oldNo: head + i + 1, newNo: null }); i++; }
    while (j < m) { pairs.push({ kind: "add", text: midB[j], oldNo: null, newNo: head + j + 1 }); j++; }
  }
  const tailCtx: DiffLine[] = [];
  for (let i = 0; i < Math.min(tail, CTX); i++) {
    tailCtx.push({ kind: "ctx", text: a[a.length - tail + i], oldNo: a.length - tail + i + 1, newNo: b.length - tail + i + 1 });
  }
  if (tail > CTX) tailCtx.push({ kind: "gap", text: `⋯ 下面 ${tail - CTX} 行未变 ⋯`, oldNo: null, newNo: null });

  // hunk selection over the middle: changed lines ±3, everything else becomes a counted gap
  const keep = new Array(pairs.length).fill(false);
  pairs.forEach((p, k) => {
    if (p.kind === "ctx") return;
    for (let c = Math.max(0, k - CTX); c <= Math.min(pairs.length - 1, k + CTX); c++) keep[c] = true;
  });
  const body: DiffLine[] = [];
  let skipped = 0;
  pairs.forEach((p, k) => {
    if (!keep[k]) { skipped++; return; }
    if (skipped) { body.push({ kind: "gap", text: `⋯ 中间 ${skipped} 行未变 ⋯`, oldNo: null, newNo: null }); skipped = 0; }
    body.push(p);
  });
  if (skipped) body.push({ kind: "gap", text: `⋯ 中间 ${skipped} 行未变 ⋯`, oldNo: null, newNo: null });
  return [...headCtx, ...body, ...tailCtx];
}

/** 一条工具调用里能看出来的文件变更（还没按 path 合并）。 */
export interface ToolChange {
  path: string;
  /** 改前/改后全文；带 `diffText` 的那种没有这两项 */
  oldText?: string;
  newText?: string;
  /** agent 只给了 diff 文本时（其它 ACP 后端），计数从这里数 */
  diffText?: string;
}

/** 回合末尾那一条：按 path 合并后的文件变更。 */
export interface FileChange {
  path: string;
  name: string;
  insertions: number;
  deletions: number;
  /** 同一文件在这一回合被改了几次 */
  edits: number;
  oldText: string;
  newText: string;
  diffText?: string;
}

const isStr = (v: unknown): v is string => typeof v === "string";

/** basename, both separators (a Windows cwd is possible). */
export function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

/** 从一段 unified diff 文本里读 path 与增删行数。
 *
 *  为什么要有这一条：Hermes 的 diff 内容是 `{type:"diff", path, oldText, newText}`，但 ACP
 *  只规定「content 里可能有 diff」，别的后端（qoder 一类）常常把 `git diff` 的**文本**放进
 *  一个 text block。只看 oldText/newText 会让那些后端一条变更都读不出来 —— 而它们恰恰是
 *  这个面板最需要覆盖的场景（没有审批卡可以翻）。 */
export function parseUnifiedDiff(text: string): { path: string; insertions: number; deletions: number } | null {
  if (!text || !/^(\+\+\+|---) /m.test(text)) return null;
  let path = "";
  let insertions = 0;
  let deletions = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim().replace(/^b\//, "").replace(/\t.*$/, "");
      if (p && p !== "/dev/null") path = p;
      continue;
    }
    if (line.startsWith("--- ")) continue;
    if (line.startsWith("+")) insertions++;
    else if (line.startsWith("-")) deletions++;
  }
  if (!path) return null;
  return { path, insertions, deletions };
}

type Block = {
  type?: string;
  path?: string;
  oldText?: string | null;
  newText?: string | null;
  text?: string;
  content?: { type?: string; text?: string };
};

/** 一个 tool payload（`tool_call` 或 `tool_call_update`，可能已经合并过）→ 变更列表。
 *
 *  三种来源，按可靠性排序：
 *  1. `{type:"diff", path, oldText, newText}` —— Hermes 的形状，能量出真正的 diff；
 *  2. `{path, oldText|newText}` 但不带 type —— 同义写法；
 *  3. text block 里的一段 unified diff —— 只有计数，看不了逐行（够画 `+N/-M`）。
 *
 *  没有 path 的调用（bash、搜索、读文件）一条都不产出：它们改了什么是另一回事，
 *  这里只回答「哪些文件变了」。 */
export function changesOfTool(payload: unknown): ToolChange[] {
  const p = (payload ?? {}) as { content?: unknown };
  const blocks = Array.isArray(p.content) ? (p.content as Block[]) : [];
  const out: ToolChange[] = [];
  const seen = new Set<string>();
  const push = (c: ToolChange): void => {
    if (seen.has(c.path)) return;   // 同一条 payload 里同文件只留第一份
    seen.add(c.path);
    out.push(c);
  };
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (isStr(b.path) && b.path && (b.oldText != null || b.newText != null || b.type === "diff")) {
      push({ path: b.path, oldText: b.oldText ?? "", newText: b.newText ?? "" });
      continue;
    }
    const text = isStr(b.text) ? b.text : isStr(b.content?.text) ? b.content.text : "";
    if (!text) continue;
    const parsed = parseUnifiedDiff(text);
    if (parsed) push({ path: parsed.path, diffText: text });
  }
  return out;
}

/** 按 path 合并一回合里的所有变更：删改次数相加，diff 用「最早的改前 → 最新的改后」。
 *
 *  为什么要合并：agent 常在一个回合里对同一文件连改两三刀（写 → 修 → 再修），
 *  两次中间态的 diff 单独画出来只是在重复自己；操作者要看的是「这个文件最终长什么样」。 */
export function mergeChanges(list: ToolChange[]): FileChange[] {
  const order: string[] = [];
  const acc = new Map<string, { first: ToolChange; last: ToolChange; edits: number; diffText?: string }>();
  for (const c of list) {
    const hit = acc.get(c.path);
    if (!hit) {
      order.push(c.path);
      acc.set(c.path, { first: c, last: c, edits: 1, diffText: c.diffText });
      continue;
    }
    hit.last = c;
    hit.edits++;
    // 有全文的优先：一个只有 diff 文本的更新不该把已经能逐行看的内容盖掉
    if (c.oldText != null || c.newText != null) hit.diffText = undefined;
    else if (!hit.diffText) hit.diffText = c.diffText;
  }
  return order.map((path) => {
    const { first, last, edits, diffText } = acc.get(path)!;
    const base = { path, name: baseName(path), edits };
    // 有全文就画逐行 diff；只有 diff 文本就只给计数（画不了行，但 `+N/-M` 仍然是真的）
    if (first.oldText != null || last.newText != null) {
      const oldText = first.oldText ?? "";
      const newText = last.newText ?? last.oldText ?? "";
      const lines = diffLines(oldText, newText);
      return {
        ...base,
        insertions: lines.filter((l) => l.kind === "add").length,
        deletions: lines.filter((l) => l.kind === "del").length,
        oldText, newText,
      };
    }
    if (diffText) {
      const parsed = parseUnifiedDiff(diffText);
      return { ...base, insertions: parsed?.insertions ?? 0, deletions: parsed?.deletions ?? 0, oldText: "", newText: "", diffText };
    }
    return { ...base, insertions: 0, deletions: 0, oldText: "", newText: "" };
  });
}
