// QA: 会话拓扑的**版式**（纯函数，不起浏览器）。
//
// 这个面板会悄悄坏掉的地方全在几何里：卡片叠在一起、边连到空气里、分区和分区重叠、
// 窄屏还是一列四张。代码照样跑、页面照样出图，所以坐标必须被断言。
//
//   npx tsx scripts/qa/topology-units.mts
import type { TopologyEdge, TopologyNode } from "../../packages/shared/src/index.js";
import {
  CARD_H, CARD_W, filterTopology, layoutTopology, orderWithinGroup, statusLabel, windowSince, workspaceLabel,
} from "../../packages/web/src/topology-layout.js";

let passed = 0;
const failures: string[] = [];
function check(ok: boolean, name: string, detail = ""): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const now = Date.now();
function node(id: string, ws: string, extra: Partial<TopologyNode> = {}): TopologyNode {
  return {
    id, title: `会话 ${id}`, backend: "hermes", workspace: ws, role: null, status: "ready",
    cold: false, archived: false, lastAt: now, createdAt: now, ...extra,
  };
}
function edge(from: string, to: string, extra: Partial<TopologyEdge> = {}): TopologyEdge {
  return { from, to, kind: "dispatch", n: 1, firstAt: now, lastAt: now, ...extra };
}

// ---- 1. 标签 ---------------------------------------------------------------
check(workspaceLabel("/Users/x/agent-dev-workspace") === "agent-dev-workspace", "工作空间显示名取最后一段");
check(workspaceLabel("/") === "/", "根目录不变成空串");

// ---- 2. 树序：父在子前 -----------------------------------------------------
const ids = ["child", "parent", "other"];
const order = orderWithinGroup(ids, [edge("parent", "child")], (id) => (id === "parent" ? now : now - 1000));
check(order.indexOf("parent") < order.indexOf("child"), "父排在子前", order.join(","));
check(order.length === 3, "没有丢节点", order.join(","));

// 环：数据坏掉时不能死循环，也不能把节点丢掉
const cyc = orderWithinGroup(["a", "b"], [edge("a", "b"), edge("b", "a")], () => now);
check(cyc.length === 2, "环里的两个节点都还在", cyc.join(","));

// ---- 3. 网格：不重叠、不越界 ----------------------------------------------
const ws = "/Users/liang/Workspace/agent-dev-workspace";
const nodes = [node("a", ws), node("b", ws), node("c", ws), node("d", ws), node("e", ws), node("f", "/other")];
const lay = layoutTopology(nodes, [edge("a", "b")], {});
check(lay.groups.length === 2, "按工作空间分成两个分区", `实际 ${lay.groups.length}`);
const g0 = lay.groups[0];
check(g0.nodes.length === 5, "第一个分区 5 张卡", `实际 ${g0.nodes.length}`);
// 同一分区里的两张卡不许重叠（矩形相交）
let overlap = "";
for (let i = 0; i < g0.nodes.length; i++) {
  for (let j = i + 1; j < g0.nodes.length; j++) {
    const a = g0.nodes[i];
    const b = g0.nodes[j];
    if (a.x < b.x + CARD_W && b.x < a.x + CARD_W && a.y < b.y + CARD_H && b.y < a.y + CARD_H) {
      overlap = `${a.node.id}×${b.node.id}`;
    }
  }
}
check(!overlap, "同一分区的卡片互不重叠", overlap);
// 4 列：前 4 张同一行，第 5 张换行
check(g0.nodes[0].y === g0.nodes[3].y && g0.nodes[4].y > g0.nodes[0].y, "4 列网格在第五张换行");
check(g0.w >= 4 * CARD_W, "分区宽度容得下四张卡", `${g0.w}`);
check(g0.nodes.every((p) => p.x + CARD_W <= g0.w && p.y - g0.y + CARD_H <= g0.h), "卡片都在分区框内");
// 分区之间不重叠（垂直排布）
check(lay.groups[1].y >= g0.y + g0.h, "分区之间不重叠", `${lay.groups[1].y} vs ${g0.y + g0.h}`);
// 窄屏：一列
const tight = layoutTopology(nodes, [edge("a", "b")], { cols: 1 });
check(tight.groups[0].nodes.every((p, i, all) => i === 0 || p.y > all[i - 1].y), "窄屏单列（y 严格递增）");
check(tight.width <= CARD_W + 64, "窄屏宽度只有一张卡", `${tight.width}`);

// ---- 4. 边的两端落在卡片边框上 --------------------------------------------
const e0 = lay.edges[0];
const a = g0.nodes.find((p) => p.node.id === "a") as { x: number; y: number };
const b = g0.nodes.find((p) => p.node.id === "b") as { x: number; y: number };
check(e0.x1 === a.x + CARD_W / 2 && e0.y1 === a.y + CARD_H, "起点 = A 的底边中点");
check(e0.x2 === b.x + CARD_W / 2 && e0.y2 === b.y, "终点 = B 的顶边中点");
// 悬空的边（目标不在窗口里）必须被丢掉，不能画到 (0,0)
const dangling = layoutTopology([node("a", ws)], [edge("a", "ghost")], {});
check(dangling.edges.length === 0, "一端不存在的边不画");

// ---- 5. 时间窗 -------------------------------------------------------------
check(windowSince("all") === 0, "全部 = 不下界");
check(Math.round((Date.now() - windowSince("3d")) / 86_400_000) === 3, "3 天窗");
check(windowSince("1d") > windowSince("7d"), "24 小时窗比 7 天窗更窄");

// ---- 6. 过滤 ---------------------------------------------------------------
const view = { nodes: [node("a", ws, { title: "修拓扑" }), node("b", ws, { title: "别的活" }), node("c", "/x")], edges: [edge("a", "b")] };
check(filterTopology(view, { query: "拓扑" }).nodes.length === 1, "按标题搜索");
check(filterTopology(view, { query: "agent-dev" }).nodes.length === 2, "按工作空间搜索");
check(filterTopology(view, { onlyLinked: true }).nodes.length === 2, "只看有关系的：孤立节点被收走");
check(filterTopology(view, { onlyLinked: true }).edges.length === 1, "只看有关系的：边留着");
const filtered = filterTopology(view, { query: "别的" });
check(filtered.edges.length === 0, "过滤掉一端之后，边也跟着消失");

// ---- 7. 状态文案（冷/归档压过 ACP status）---------------------------------
check(statusLabel({ status: "running", cold: false, archived: false }).tone === "run", "在跑");
check(statusLabel({ status: "running", cold: true, archived: false }).text === "冷", "冷压过 running");
check(statusLabel({ status: "ready", cold: false, archived: true }).text === "已归档", "归档压过 ready");

// ---- 8. 折叠（issue #95）：收起来的分区只占一行行程 -------------------------
const two = [
  node("m1", "/w/alpha"), node("m2", "/w/alpha"),
  node("b1", "/w/beta"), node("b2", "/w/beta"), node("b3", "/w/beta"),
];
const openLayout = layoutTopology(two, [edge("m1", "b1")], { cols: 4 });
const foldAlpha = layoutTopology(two, [edge("m1", "b1")], { cols: 4, collapsed: new Set(["/w/alpha"]) });
const alphaOpen = openLayout.groups.find((g) => g.workspace === "/w/alpha")!;
const alphaFold = foldAlpha.groups.find((g) => g.workspace === "/w/alpha")!;
check(alphaOpen.collapsed === false && alphaFold.collapsed === true, "折叠标记照实落到分区上");
check(alphaFold.nodes.length === 0, "折叠的分区不再排卡片", `nodes=${alphaFold.nodes.length}`);
check(alphaFold.nodeCount === 2, "折叠后仍数得出里面有几个会话", `nodeCount=${alphaFold.nodeCount}`);
check(alphaFold.h < alphaOpen.h, "折叠的高度真的更矮", `${alphaOpen.h} → ${alphaFold.h}`);
check(alphaFold.links === 1, "跨分区的边也算进「几条关系」", `links=${alphaFold.links}`);
// 折叠一个分区不能把别的分区推歪：剩下的仍按顺序堆叠、互不重叠
const betaFold = foldAlpha.groups.find((g) => g.workspace === "/w/beta")!;
check(betaFold.y >= alphaFold.y + alphaFold.h, "下一个分区接在折叠行的下面", `${alphaFold.y + alphaFold.h} → ${betaFold.y}`);
check(foldAlpha.edges.length === 0, "一端收起来的边不画（它连不到空气）", `edges=${foldAlpha.edges.length}`);
check(foldAlpha.width > 0 && foldAlpha.height > 0, "全折叠时画布仍有尺寸", `${foldAlpha.width}×${foldAlpha.height}`);

// ---- 9. 拖动覆盖：人工坐标压过网格，且画布容得下拖出去的那张 -----------------
const dragged = layoutTopology(two, [], { cols: 4, overrides: { m1: { x: 900, y: 640 } } });
const m1 = dragged.groups.flatMap((g) => g.nodes).find((p) => p.node.id === "m1")!;
check(m1.x === 900 && m1.y === 640, "拖过的坐标原样生效", `${m1.x},${m1.y}`);
check(m1.x !== (openLayout.groups.flatMap((g) => g.nodes).find((p) => p.node.id === "m1")!.x), "确实压过了自动排版");
check(dragged.width >= 900 + CARD_W, "画布向右扩到装得下它", `width=${dragged.width}`);
check(dragged.height >= 640 + CARD_H, "画布向下也扩", `height=${dragged.height}`);
// 覆盖只影响被拖的那张：别的卡片还在原来的格子上
const m2 = dragged.groups.flatMap((g) => g.nodes).find((p) => p.node.id === "m2")!;
const m2open = openLayout.groups.flatMap((g) => g.nodes).find((p) => p.node.id === "m2")!;
check(m2.x === m2open.x && m2.y === m2open.y, "没拖的卡片不动", `${m2.x},${m2.y}`);
// 线跟着卡片走：拖开之后边的端点落在新位置上
const linked = layoutTopology(two, [edge("m1", "b1")], { cols: 4, overrides: { m1: { x: 900, y: 640 } } });
check(linked.edges.length === 1 && linked.edges[0].y1 === 640 + CARD_H, "边的起点跟着卡片走",
  `y1=${linked.edges[0]?.y1}`);
// 折叠 + 拖动同时生效：折叠的还是折叠，拖过的那张仍在自己的坐标
const both = layoutTopology(two, [], { cols: 4, collapsed: new Set(["/w/beta"]), overrides: { m1: { x: 40, y: 300 } } });
check(both.groups.find((g) => g.workspace === "/w/beta")!.collapsed === true, "两个开关互不打扰");
check(both.groups.flatMap((g) => g.nodes).find((p) => p.node.id === "m1")!.x === 40, "折叠时被拖的卡片坐标不被重置");

// ---- 10. 分区拖动（#95 追加）：组的位置压过顺序堆叠，卡片跟着组走 ---------------
const moved = layoutTopology(two, [], { cols: 4, groupOverrides: { "/w/beta": { x: 300, y: 40 } } });
const betaMoved = moved.groups.find((g) => g.workspace === "/w/beta")!;
const betaBefore = openLayout.groups.find((g) => g.workspace === "/w/beta")!;
check(betaMoved.x === 300 && betaMoved.y === 40, "拖过的分区按操作者坐标摆", `${betaMoved.x},${betaMoved.y}`);
check(betaMoved.x !== betaBefore.x || betaMoved.y !== betaBefore.y, "确实压过了顺序堆叠");
const b1Moved = moved.groups.flatMap((g) => g.nodes).find((p) => p.node.id === "b1")!;
const b1Before = openLayout.groups.flatMap((g) => g.nodes).find((p) => p.node.id === "b1")!;
check(b1Moved.y - betaMoved.y === b1Before.y - betaBefore.y, "组里的卡片跟着组平移（相对位置不变）",
  `${b1Before.y - betaBefore.y} vs ${b1Moved.y - betaMoved.y}`);
check(moved.width >= 300 + betaMoved.w, "画布向右扩到装得下挪走的组", `width=${moved.width}`);
// 组拖动和单卡拖动可以同时存在：卡的绝对坐标压过一切
const bothMoved = layoutTopology(two, [], { cols: 4, groupOverrides: { "/w/beta": { x: 300, y: 40 } }, overrides: { b2: { x: 10, y: 600 } } });
check(bothMoved.groups.flatMap((g) => g.nodes).find((p) => p.node.id === "b2")!.y === 600,
  "单卡坐标仍压过组的位置");

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  FAIL ${f}`); process.exit(1); }
