/**
 * 输入框里的 `@`：跨工作空间转交的选择器（纯逻辑，DOM 在 App.tsx 里）。
 *
 * 两段式是口述定下的形状，别改：
 *   1. 打 `@` → 列工作空间，**当前所在的排第一**（标「当前」），其余按最后对话时间倒序 ——
 *      和 rail 一个规则（`lastAt ?? createdAt`），不引入频次权重。
 *   2. 选完空间 → 同一个弹层立刻换成第二段：第一行固定「新会话」，下面按最近使用倒序列出
 *      该空间的会话。
 *
 * 放在这里而不是组件里，是因为"哪一行排在前面、过滤后还剩几条、退格该不该带走整块"这些
 * 判断能脱离浏览器被测（`scripts/qa/mention-units.mts`）；组件只负责把结果画出来。
 */

/** 只用到这几个字段，好让单测不必构造整条 SessionInfo。 */
export interface MentionSession {
  id: string;
  cwd: string;
  workspace?: string | null;
  title: string;
  lastAt?: number | null;
  createdAt: number;
}

export interface MentionWorkspace {
  /** 分组键 = 实际目录（有 workspace 用它，没有用 cwd，和 rail 一致） */
  path: string;
  /** 显示名 = 路径最后一段 */
  label: string;
  /** 组内最新的对话时间 */
  lastAt: number;
  /** 是不是操作员当前所在的工作空间 */
  current: boolean;
  sessions: MentionSession[];
}

export interface MentionChoice {
  key: string;
  kind: "new" | "session";
  /** 弹层里右边那列：新会话 / 会话标题 */
  label: string;
  /** 弹层里左边那列：空间名（新会话时多一句「在这个空间里开一个」） */
  hint: string;
  workspace: string;
  id?: string;
}

/** 一个会话最后一次被说话的时间；与 rail 的 `lastOf` 是同一个定义。 */
export function lastOf(s: MentionSession): number {
  return s.lastAt ?? s.createdAt;
}

/** 路径 → 分组键。`workspace` 是面板所在目录，`cwd` 是 agent 的工作目录，rail 认前者优先。 */
export function pathOf(s: MentionSession): string {
  return s.workspace || s.cwd;
}

export function labelOf(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/**
 * 工作空间列表。当前空间钉在第一行，其余按组内最新时间倒序、同时间按名字排。
 *
 * 「钉第一」不是排序的一部分：它是唯一一条**不随时间变化**的规则，因为操作员打 `@` 时通常
 * 就是想转到别处，但当前空间必须可以在列表里被看见（他要的可能是在当前空间里另开一个会话）。
 */
export function mentionWorkspaces(all: readonly MentionSession[], currentPath: string): MentionWorkspace[] {
  const byPath = new Map<string, MentionWorkspace>();
  for (const s of all) {
    const path = pathOf(s);
    const g = byPath.get(path) ?? { path, label: labelOf(path), lastAt: 0, current: false, sessions: [] };
    g.sessions.push(s);
    g.lastAt = Math.max(g.lastAt, lastOf(s));
    byPath.set(path, g);
  }
  const norm = (p: string): string => `/${p.split("/").filter(Boolean).join("/")}`;
  const current = norm(currentPath);
  const groups = [...byPath.values()].map((g) => ({
    ...g,
    current: norm(g.path) === current,
    sessions: [...g.sessions].sort((a, b) => lastOf(b) - lastOf(a) || b.createdAt - a.createdAt),
  }));
  groups.sort((a, b) => Number(b.current) - Number(a.current) || b.lastAt - a.lastAt || a.label.localeCompare(b.label));
  return groups;
}

/**
 * 第二段：第一行永远是「新会话」，然后是该空间的会话（已按时间倒序）。
 *
 * `query` 是 `@` 之后打的字：空串时全给（截到 limit），有字时按标题/ID 过滤 —— 过滤时不截断，
 * 因为"我打了字搜出来的"这条判断必须覆盖全部候选，否则会漏掉排在后面但确实匹配的会话。
 */
export function mentionChoices(ws: MentionWorkspace, query: string, limit = 20, excludeId?: string): MentionChoice[] {
  const q = query.trim().toLowerCase();
  const fresh: MentionChoice = {
    key: `new:${ws.path}`,
    kind: "new",
    label: "新会话",
    hint: ws.label,
    workspace: ws.path,
  };
  // `excludeId` = 你自己：转交给自己的会话会 cancel 掉正在跑的回合，还给自己贴一张「来自别处」的标签。
  const hits = ws.sessions
    .filter((s) => s.id !== excludeId)
    .filter((s) => !q || s.title.toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
    .map<MentionChoice>((s) => ({
      key: `session:${s.id}`,
      kind: "session",
      label: s.title || s.id,
      hint: ws.label,
      workspace: ws.path,
      id: s.id,
    }));
  // 「新会话」也参与过滤：打了字还把它钉在最上面，会让"我要找的那个已有会话"多按一次 ↓。
  const rows = q && !"新会话".includes(q) && !"new session".includes(q) ? hits : [fresh, ...hits];
  return q ? rows : rows.slice(0, limit + 1);
}

/** 输入框里那块标签的文本（连同后面那个空格）。发送前整块去掉，不靠正则反解。 */
export function tokenText(label: string): string {
  return `@${label} `;
}

export interface MentionToken {
  start: number;
  /** 整块（含 `@` 与结尾空格）的长度 */
  len: number;
  label: string;
}

/** 把一个标签插到光标处，并把光标放到它后面（调用方负责把 value 设回去）。 */
export function insertToken(text: string, at: number, label: string): { text: string; token: MentionToken; caret: number } {
  const t = tokenText(label);
  const before = text.slice(0, at);
  const after = text.slice(at);
  return {
    text: `${before}${t}${after}`,
    token: { start: before.length, len: t.length, label },
    caret: before.length + t.length,
  };
}

/** 标签还在原地吗？（用户在中间插字或删字后就散了，此时必须放弃它，而不是继续按旧下标切） */
export function tokenIntact(text: string, token: MentionToken | null): boolean {
  if (!token) return false;
  return text.slice(token.start, token.start + token.len) === tokenText(token.label);
}

/** 去掉标签后的正文 —— 这就是发给目标会话的那句话。 */
export function stripToken(text: string, token: MentionToken | null): string {
  if (!tokenIntact(text, token) || !token) return text.trim();
  return `${text.slice(0, token.start)}${text.slice(token.start + token.len)}`.trim();
}

/**
 * 退格落在标签右边界时，整块消失（打一个字打不掉半块标签）。
 * 返回 null 表示"这不是标签边界，按普通退格走"。
 */
export function backspaceToken(text: string, caret: number, token: MentionToken | null): { text: string; caret: number } | null {
  if (!token || !tokenIntact(text, token)) return null;
  const end = token.start + token.len;
  if (caret < end || caret > end) return null;
  const before = text.slice(0, token.start);
  const after = text.slice(end);
  return { text: `${before}${after}`, caret: before.length };
}

/** 光标是否落在标签内部（任何编辑都会毁掉它的身份，于是调用方直接丢弃标签）。 */
export function caretInsideToken(caret: number, token: MentionToken | null): boolean {
  if (!token) return false;
  return caret > token.start && caret < token.start + token.len;
}
