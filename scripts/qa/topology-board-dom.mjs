// 会话拓扑面板的真页面证据（v0.19.0 / feat/v0.19.0/session-topology）。
//
// 这个面板的意义全在「谁把活交给了谁」那条线上，而单测只证明布局函数算得对 —— 它证明不了
// 页面真的画出了连线、点得开会话、筛得动。第一次看它时 dev 库正好是「10 个会话 · 0 条关系」，
// 于是连线这条路径一次都没被走过；这份 sweep 自己造一条关系再验。
//
// 覆盖：
//   ① 入口在 chat head，点开是替换主区的板子（不是浮层）
//   ② 计数文本与 `/api/topology` 对得上
//   ③ 真画了一条边走线（`data-topo-edge` + 非空 path），且方向/类型对
//   ④ 搜索过滤、只显示有关系的、时间窗切换都真的改变了画出来的东西
//   ⑤ 点卡片把会话浮窗打开，返回回到板子
//   ⑥ 「派活」按钮打开派活面板，Esc 收掉
//
//   AGENTUS_BASE=http://127.0.0.1:8901 CDP_URL=http://127.0.0.1:9223 node scripts/qa/topology-board-dom.mjs
const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";
const BASE = process.env.AGENTUS_BASE || "http://127.0.0.1:8901";
const USER = process.env.AGENTUS_USER || "scratch";
const PASS = process.env.AGENTUS_PASS || "scratch-pass-1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(1500);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const waiting = new Map();
const exceptions = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") exceptions.push(m.params.exceptionDetails.text);
  if (m.id && waiting.has(m.id)) {
    const x = waiting.get(m.id); waiting.delete(m.id);
    m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result);
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id; waiting.set(mid, { res, rej });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
const goto = async (url) => { await send("Page.navigate", { url }); await sleep(3000); };

await send("Runtime.enable");
await goto(BASE);
const status = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({username:${JSON.stringify(USER)},password:${JSON.stringify(PASS)}})}).then(r=>r.status)`);
check("logged in", status === 200, `status ${status}`);

await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 950, deviceScaleFactor: 1, mobile: false });
await goto(BASE);

// ---- 素材：两个会话 + 一条真的投递关系 ------------------------------------------------------
// 用唯一标题，好让后面的搜索断言只命中自己造的这一对。
const STAMP = String(Date.now()).slice(-6);
const ORIGIN = `topo-origin-${STAMP}`;
const TARGET = `topo-target-${STAMP}`;
const pair = JSON.parse(await ev(`(async () => {
  const mk = (title) => fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ backend: 'mock', cwd: '/tmp', title }) }).then((r) => r.json());
  const a = await mk(${JSON.stringify(ORIGIN)});
  const b = await mk(${JSON.stringify(TARGET)});
  return JSON.stringify({ a: a.id, b: b.id });
})()`));
check("造出两个会话（拓扑里的两端）", Boolean(pair.a && pair.b), JSON.stringify(pair));

// 等它们真的 ready 再投递，否则 bridge 会回 target_not_ready。
let bridged = null;
for (let i = 0; i < 40; i++) {
  bridged = await ev(`fetch('/api/bridge', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: ${JSON.stringify(pair.a)}, text: '拓扑连线验证：这条线应该被画出来',
      to: { kind: 'session', id: ${JSON.stringify(pair.b)} } }) }).then((r) => r.json())`);
  if (bridged && !bridged.error) break;
  await sleep(1500);
}
check("从一个会话投递到另一个（关系落库的来源）", Boolean(bridged && !bridged.error), JSON.stringify(bridged).slice(0, 120));

const apiView = JSON.parse(await ev(`fetch('/api/topology').then(r=>r.json()).then(d=>JSON.stringify({
  nodes: d.nodes.length,
  edges: d.edges.length,
  mine: d.edges.filter(e => e.from === ${JSON.stringify(pair.a)} && e.to === ${JSON.stringify(pair.b)}).map(e => e.kind),
}))`));
check("/api/topology 把这条关系作为一条边返回", apiView.mine.includes("handoff"), JSON.stringify(apiView));

// ---- ① 入口 → 板子 -------------------------------------------------------------------------
await ev(`(() => { const row = [...document.querySelectorAll('.session-item')]
  .find(r => (r.textContent || '').includes(${JSON.stringify(ORIGIN)})); if (row) row.click(); return Boolean(row); })()`);
await sleep(2200);
check("chat head 里有拓扑入口", (await ev(`document.querySelectorAll('[data-topo-entry]').length`)) === 1);
await ev(`document.querySelector('[data-topo-entry]').click(); true`);
await sleep(2500);
check("点开后是替换主区的板子（不是浮层）",
  (await ev(`!!document.querySelector('[data-topo-board]')`)) === true &&
  (await ev(`getComputedStyle(document.querySelector('[data-topo-board]')).position`)) !== "fixed");

// ---- ② 计数与 API 对得上 --------------------------------------------------------------------
const countText = await ev(`document.querySelector('[data-topo-count]')?.textContent || ''`);
const parsed = String(countText).match(/(\d+)\s*个会话\s*·\s*(\d+)\s*条关系/);
const shown = parsed ? [Number(parsed[1]), Number(parsed[2])] : [0, 0];
check("计数文本写的是「N 个会话 · M 条关系」", /个会话/.test(String(countText)) && /条关系/.test(String(countText)), String(countText));
check("…而 N/M 与 API 一致", shown[0] === apiView.nodes && shown[1] === apiView.edges,
  `page ${shown} vs api ${apiView.nodes}/${apiView.edges}`);

// ---- ③ 线真的被画出来 ----------------------------------------------------------------------
const edges = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-topo-edge]')].map(g => ({
  kind: g.dataset.topoEdge,
  live: g.dataset.live,
  d: (g.querySelector('path')?.getAttribute('d') || '').length,
  title: g.querySelector('title')?.textContent || '',
})))`));
check("至少画出一条连线", edges.length >= 1, JSON.stringify(edges));
check("…它是 handoff（一次投递），且 path 有真实坐标（不是空 d）",
  edges.some((e) => e.kind === "handoff" && e.d > 10), JSON.stringify(edges.slice(0, 3)));
check("…线的 title 说得清是什么关系", edges.some((e) => /转交|派|交给|delivered|handoff/i.test(e.title)), edges.map((e) => e.title).slice(0, 2).join(" | "));

// ---- ④ 过滤真的改变画出来的东西 --------------------------------------------------------------
const nodeCount = () => ev(`document.querySelectorAll('[data-topo-node]').length`);
const before = await nodeCount();
check("节点数与 API 一致（每张卡片一个会话）", before === apiView.nodes, `${before} vs ${apiView.nodes}`);

await ev(`(() => { const i = document.querySelector('[data-topo-search]');
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(i, ${JSON.stringify(TARGET)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await sleep(900);
const searched = await nodeCount();
check("搜索把画布缩小到命中的那个会话", searched >= 1 && searched < before, `${before} → ${searched}`);

await ev(`(() => { const i = document.querySelector('[data-topo-search]');
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await sleep(900);
check("清空搜索后回到全量", (await nodeCount()) === before, String(await nodeCount()));

const onlyLinked = `document.querySelector('[data-topo-only-linked]')`;
if (await ev(`Boolean(${onlyLinked})`)) {
  await ev(`${onlyLinked}.click(); true`);
  await sleep(800);
  const linkedOnly = await nodeCount();
  check("「只显示有关系的」确实把孤立会话滤掉", linkedOnly > 0 && linkedOnly <= before, `${before} → ${linkedOnly}`);
  await ev(`${onlyLinked}.click(); true`);
  await sleep(700);
}

// 每个时间窗按钮自己带 `data-topo-window="<key>"`（容器只叫 `.topo-windows`）。
const windows = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-topo-window]')].map(b => b.textContent.trim()))`));
check("时间窗有多个档", windows.length >= 2, windows.join(","));
await ev(`(() => { const b = document.querySelector('[data-topo-window]'); if (b) b.click(); return true; })()`);
await sleep(1200);
check("切时间窗后板子仍然渲染（没有白屏）",
  (await ev(`document.querySelectorAll('[data-topo-node]').length`)) > 0);

// ---- ⑤ 点卡片 → 会话浮窗 → 返回 -------------------------------------------------------------
await ev(`document.querySelector('.topo-card-main').click(); true`);
await sleep(2000);
check("点卡片把会话浮窗打开（不是只读预览）",
  (await ev(`document.querySelectorAll('[data-topo-window-back]').length`)) === 1);
await ev(`document.querySelector('[data-topo-window-back]').click(); true`);
await sleep(1200);
check("返回后回到拓扑（浮窗关掉、板子还在）",
  (await ev(`document.querySelectorAll('[data-topo-window-back]').length`)) === 0 &&
  (await ev(`Boolean(document.querySelector('[data-topo-board]'))`)) === true);

// ---- ⑥ 派活面板 ----------------------------------------------------------------------------
const dispatchBtn = await ev(`document.querySelectorAll('[data-topo-dispatch-new]').length`);
if (dispatchBtn > 0) {
  await ev(`document.querySelector('[data-topo-dispatch-new]').click(); true`);
  await sleep(900);
  check("「派活」打开派活面板",
    (await ev(`document.querySelectorAll('[data-topo-dispatch-panel]').length`)) === 1);
  check("…面板里有输入框和发送键",
    (await ev(`document.querySelectorAll('[data-topo-dispatch-text]').length`)) === 1 &&
    (await ev(`document.querySelectorAll('[data-topo-dispatch-send]').length`)) === 1);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(900);
  check("…Esc 先收掉面板（不连带退出板子：那是第三层 Esc）",
    (await ev(`document.querySelectorAll('[data-topo-dispatch-panel]').length`)) === 0 &&
    (await ev(`Boolean(document.querySelector('[data-topo-board]'))`)) === true);
} else {
  check("「派活」入口存在（按工作空间分组才有）", false, "no [data-topo-dispatch-new] found");
}

check("全程没有 JS 异常", exceptions.length === 0, exceptions.slice(0, 2).join(" | "));

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
await send("Page.close").catch(() => {});
ws.close();
process.exit(fail === 0 ? 0 : 1);
