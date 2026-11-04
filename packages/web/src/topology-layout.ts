/**
 * 会话拓扑的**布局**，纯函数 —— 不碰 DOM、不发请求。
 *
 * 单独一个模块，因为「谁摆在谁下面」是这个面板唯一会悄悄坏掉的东西：一棵树画歪了、两个分区
 * 叠上了、边连到了空气里，代码照样跑、页面照样出。放在这里就能用 `scripts/qa/topology-units.mts`
 * 直接量坐标，不用起浏览器。
 *
 * 版式（实测过的形状，见 tasks/20261103-agentus-session-topology）：
 *
 *   ┌ 工作空间 A · 6 会话 ────────────────────────────┐
 *   │  [会话] [会话] [会话] [会话]                     │   ← 网格，默认 4 列
 *   │  [会话] [会话]                                   │
 *   └─────────────────────────────────────────────────┘
 *   ┌ 工作空间 B · 2 会话 ────────────────────────────┐
 *   ...
 *
 * 为什么不是「一棵树一张图」：实测 live 库里 7 天只有 2 条派活边，只画有边的会话会是一片空地。
 * 所以**所有会话都画**，关系是叠加层；树只是决定「同一分区里的先后顺序」（父在子前）。
 */
import type { EdgeKind, TopologyEdge, TopologyNode } from "../../shared/src/index.js";

export const CARD_W = 232;
export const CARD_H = 84;
export const GAP_X = 18;
export const GAP_Y = 44;
export const GROUP_PAD = 16;
export const GROUP_HEAD = 34;
export const GROUP_GAP = 26;
export const COLS = 4;

export interface PlacedNode {
  node: TopologyNode;
  /** 卡片左上角（画布坐标，不含滚动）。 */
  x: number;
  y: number;
  /** 它在这棵树里的深度：0 = 分区里的根（没人派给它活）。 */
  depth: number;
}

export interface PlacedGroup {
  workspace: string;
  /** 显示名：路径最后一段（`/Users/x/agent-dev-workspace` → `agent-dev-workspace`）。 */
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  nodes: PlacedNode[];
  /** 这个分区里「有边连出去」的条数（分区头上的小字）。 */
  links: number;
}

export interface PlacedEdge extends TopologyEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface TopoLayout {
  groups: PlacedGroup[];
  edges: PlacedEdge[];
  width: number;
  height: number;
}

export interface LayoutOpts {
  cols?: number;
  cardW?: number;
  cardH?: number;
  gapX?: number;
  gapY?: number;
}

/** 路径最后一段；`~` 与根目录不该变成空串。 */
export function workspaceLabel(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path || "/";
}

/**
 * 一棵树的顺序：父在子前，同一层的按「最近有动静」排。
 *
 * 只用来决定卡片先后的顺序（网格是先横后竖），不是几何意义上的树。环与孤儿都要安全：
 * 拓扑里出现环的唯一可能是数据坏了（自环已被写入侧拒掉），这里宁可少画一条也不许死循环。
 */
export function orderWithinGroup(ids: string[], edges: TopologyEdge[], lastAt: (id: string) => number): string[] {
  const inside = new Set(ids);
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const e of edges) {
    if (!inside.has(e.from) || !inside.has(e.to) || e.from === e.to) continue;
    children.set(e.from, [...(children.get(e.from) ?? []), e.to]);
    hasParent.add(e.to);
  }
  const byRecency = (a: string, b: string): number => lastAt(b) - lastAt(a);
  const roots = ids.filter((i) => !hasParent.has(i)).sort(byRecency);
  const seen = new Set<string>();
  const out: string[] = [];
  const walk = (id: string): void => {
    if (seen.has(id) || !inside.has(id)) return;
    seen.add(id);
    out.push(id);
    for (const c of (children.get(id) ?? []).slice().sort(byRecency)) walk(c);
  };
  for (const r of roots) walk(r);
  // 环里的节点没有任何根能走到它们：按时间补在后面，不要丢。
  for (const i of ids.slice().sort(byRecency)) walk(i);
  return out;
}

/** 主入口：节点 + 边 → 画布坐标。 */
export function layoutTopology(nodes: TopologyNode[], edges: TopologyEdge[], opts: LayoutOpts = {}): TopoLayout {
  const cols = Math.max(1, opts.cols ?? COLS);
  const cardW = opts.cardW ?? CARD_W;
  const cardH = opts.cardH ?? CARD_H;
  const gapX = opts.gapX ?? GAP_X;
  const gapY = opts.gapY ?? GAP_Y;

  const byWorkspace = new Map<string, TopologyNode[]>();
  for (const n of nodes) {
    const ws = n.workspace || "";
    byWorkspace.set(ws, [...(byWorkspace.get(ws) ?? []), n]);
  }
  const lastAt = (id: string): number => nodes.find((n) => n.id === id)?.lastAt ?? 0;
  // 分区顺序：最近有动静的在上。和 rail 的分组同一条规矩 —— 操作者找的是「我昨天在干的活」。
  const groupsInOrder = [...byWorkspace.entries()].sort((a, b) => {
    const newest = (list: TopologyNode[]): number => Math.max(...list.map((n) => n.lastAt));
    return newest(b[1]) - newest(a[1]);
  });

  const out: PlacedGroup[] = [];
  const pos = new Map<string, PlacedNode>();
  let y = 0;
  for (const [workspace, list] of groupsInOrder) {
    const ids = list.map((n) => n.id);
    const order = orderWithinGroup(ids, edges, lastAt);
    const rows = Math.ceil(order.length / cols);
    const w = Math.min(order.length, cols) * cardW + (Math.min(order.length, cols) - 1) * gapX + GROUP_PAD * 2;
    const h = GROUP_HEAD + rows * cardH + (rows - 1) * gapY + GROUP_PAD;
    const group: PlacedGroup = {
      workspace,
      label: workspaceLabel(workspace),
      x: 0,
      y,
      w,
      h,
      nodes: [],
      links: edges.filter((e) => ids.includes(e.from) && ids.includes(e.to)).length,
    };
    // 深度只用于卡片左侧的一条竖线（「它挂在谁下面」），网格本身不按深度分列：分区里通常只有
    // 一两个 depth>0 的节点，按深度分列会让整块版式为一棵树空掉三分之二。
    const depthOf = new Map<string, number>();
    for (const e of edges) if (ids.includes(e.from) && ids.includes(e.to)) depthOf.set(e.to, 1);
    order.forEach((id, k) => {
      const node = list.find((n) => n.id === id) as TopologyNode;
      const col = k % cols;
      const row = Math.floor(k / cols);
      const placed: PlacedNode = {
        node,
        x: GROUP_PAD + col * (cardW + gapX),
        y: y + GROUP_HEAD + row * (cardH + gapY),
        depth: depthOf.get(id) ?? 0,
      };
      group.nodes.push(placed);
      pos.set(id, placed);
    });
    out.push(group);
    y += h + GROUP_GAP;
  }

  const placedEdges: PlacedEdge[] = [];
  for (const e of edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    placedEdges.push({
      ...e,
      // 从 A 的底边中点连到 B 的顶边中点：边落在边框上，不压在文字上。
      x1: a.x + cardW / 2,
      y1: a.y + cardH,
      x2: b.x + cardW / 2,
      y2: b.y,
    });
  }

  const width = out.reduce((m, g) => Math.max(m, g.w), 0);
  const height = out.length ? out[out.length - 1].y + out[out.length - 1].h : 0;
  return { groups: out, edges: placedEdges, width, height };
}

/** 三档时间窗 + 'all'。默认 3 天是操作者定的（2026-11-03）。 */
export type TopoWindow = "1d" | "3d" | "7d" | "all";

export function windowSince(w: TopoWindow, now = Date.now()): number {
  const day = 86_400_000;
  return w === "all" ? 0 : now - (w === "1d" ? day : w === "3d" ? 3 * day : 7 * day);
}

/** 过滤：搜索词（标题/工作空间/id 前缀）、只看有边的树、隐藏已归档。 */
export function filterTopology(
  view: { nodes: TopologyNode[]; edges: TopologyEdge[] },
  opts: { query?: string; onlyLinked?: boolean; hideArchived?: boolean },
): { nodes: TopologyNode[]; edges: TopologyEdge[] } {
  const q = (opts.query ?? "").trim().toLowerCase();
  let nodes = view.nodes;
  if (opts.hideArchived) nodes = nodes.filter((n) => !n.archived);
  if (q) {
    nodes = nodes.filter((n) =>
      n.title.toLowerCase().includes(q) || n.workspace.toLowerCase().includes(q) || n.id.toLowerCase().startsWith(q));
  }
  const keep = new Set(nodes.map((n) => n.id));
  let edges = view.edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  if (opts.onlyLinked) {
    // 「只看有边的树」= 保留与边相连的连通块，孤立的会话收起来。
    const linked = new Set<string>();
    for (const e of edges) {
      linked.add(e.from);
      linked.add(e.to);
    }
    nodes = nodes.filter((n) => linked.has(n.id));
    edges = edges.filter((e) => linked.has(e.from) && linked.has(e.to));
  }
  return { nodes, edges };
}

/** 卡片上那句「什么状态」。冷/归档压过 ACP 的 status —— 它们描述的是这个槽位现在在哪，不是
 *  agent 自己的报告。 */
export function statusLabel(n: Pick<TopologyNode, "status" | "cold" | "archived">): { text: string; tone: string } {
  if (n.archived) return { text: "已归档", tone: "muted" };
  if (n.cold) return { text: "冷", tone: "muted" };
  switch (n.status) {
    case "running": return { text: "在跑", tone: "run" };
    case "ready": return { text: "就绪", tone: "ok" };
    case "starting": return { text: "启动中", tone: "warn" };
    case "error": return { text: "出错", tone: "bad" };
    case "reaped": return { text: "已回收", tone: "muted" };
    case "closed": return { text: "已关闭", tone: "muted" };
    default: return { text: String(n.status), tone: "muted" };
  }
}

/** 边的说明文案（悬停）。`n` 是来回次数，`kind` 决定它是「派活」「转交」还是「建会话」。 */
export function edgeLabel(kind: EdgeKind, n: number): string {
  const base = kind === "spawn" ? "建了这个会话" : kind === "handoff" ? "转交" : "派活";
  return n > 1 ? `${base} · ${n} 次` : base;
}
