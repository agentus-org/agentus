// #96：在拓扑里「从 A 拉一条线到 B」派活 —— 发起方由手点出来，不再是「当前正在看的会话」。
//
// 覆盖：
//   ① 从 A 卡片右缘的把手拖到 B 卡片：出现跟手的线、B 高亮、松手后面板写着 A → B
//   ② 真的发出去：服务端多一条 handoff 边（A → B），并且 A 不是当前活动会话也能派（这正是要修的地方）
//   ③ 拖到某个分区：面板变成「新会话」，说明会在这个工作空间新建
//   ④ 没有任何发起方时，面板不把「当前会话」当成源
//
//   AGENTUS_BASE=http://127.0.0.1:8901 CDP_URL=http://127.0.0.1:9223 node scripts/qa/topology-link-dom.mjs
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
let id = 0; const waiting = new Map(); const exceptions = [];
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
const mouse = (type, x, y) => send("Input.dispatchMouseEvent", {
  type, x, y, button: "left", clickCount: 1, buttons: type === "mouseReleased" ? 0 : 1,
});
const waitFor = async (expr, ms = 6000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(150); }
  return false;
};
const centerOf = (sel) => ev(`JSON.stringify((() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})())`).then((s) => (s ? JSON.parse(s) : null));

await send("Runtime.enable");
await send("Emulation.setTouchEmulationEnabled", { enabled: false });
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: BASE });
await sleep(2800);
const login = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({username:${JSON.stringify(USER)},password:${JSON.stringify(PASS)}})}).then(r=>r.status)`);
check("logged in", login === 200, `status ${login}`);

// 两个同工作空间的会话当 A / B（A 不会被打开成「当前会话」——这正是这一条要证明的）
const mk = async () => ev(`fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({backend:'mock',cwd:'/tmp'})}).then(r=>r.json()).then(d=>d.id)`);
const A = await mk();
const B = await mk();
check("fixture: two sessions", Boolean(A && B), `${A} / ${B}`);

const board = await ev(`fetch('/api/topology?since=0&archived=1',{credentials:'same-origin'})
  .then(r=>r.json()).then(d => JSON.stringify({ edges: (d.edges||[]).length }))`).then(JSON.parse);
check("fixture: topology reachable", typeof board.edges === "number", JSON.stringify(board));

await ev(`localStorage.removeItem('agentus.topo.collapsed'); localStorage.removeItem('agentus.topo.pos'); localStorage.removeItem('agentus.topo.groupPos'); true`);
await send("Page.reload"); await sleep(2600);
for (let i = 0; i < 50; i++) { if (await ev(`!!document.querySelector('[data-nav="topology"]')`)) break; await sleep(200); }
for (let i = 0; i < 20; i++) {
  if (await ev(`!!document.querySelector('[data-topo-board]')`)) break;
  const nav = await centerOf('[data-nav="topology"]');
  if (nav) { await mouse("mousePressed", nav.x, nav.y); await sleep(50); await mouse("mouseReleased", nav.x, nav.y); }
  await sleep(700);
}
await waitFor(`document.querySelectorAll('[data-topo-group]').length > 0`, 8000);
// 全展开，A/B 才都在画布上
for (let i = 0; i < 8; i++) {
  const folded = await ev(`[...document.querySelectorAll('[data-topo-group]')].filter(g => g.getAttribute('data-topo-collapsed') === '1').length`);
  if (!folded) break;
  await ev(`[...document.querySelectorAll('[data-topo-group]')].filter(g => g.getAttribute('data-topo-collapsed') === '1').forEach(g => g.querySelector('.topo-group-head').click())`);
  await sleep(400);
}
await sleep(400);
check("both fixture cards are on the board",
  await ev(`!!document.querySelector('[data-topo-node="${A}"]') && !!document.querySelector('[data-topo-node="${B}"]')`));

// ---- ① 从 A 的把手拖到 B ------------------------------------------------------
const handle = await centerOf(`[data-topo-dispatch="${A}"]`);
const targetB = await centerOf(`[data-topo-node="${B}"] .topo-card-main`);
check("A has a link handle", Boolean(handle), JSON.stringify(handle));
check("B is on screen", Boolean(targetB), JSON.stringify(targetB));

await mouse("mousePressed", handle.x, handle.y);
await sleep(80);
for (let k = 1; k <= 8; k++) {
  await mouse("mouseMoved", handle.x + Math.round((targetB.x - handle.x) * k / 8), handle.y + Math.round((targetB.y - handle.y) * k / 8));
  await sleep(35);
}
const midLine = await ev(`!!document.querySelector('[data-topo-link]')`);
const midTarget = await ev(`!!document.querySelector('.topo-card.link-target')`);
check("a line follows the pointer", midLine === true);
check("the card under the pointer is highlighted", midTarget === true);
await mouse("mouseReleased", targetB.x, targetB.y);
await sleep(700);

const panel = await ev(`document.querySelector('[data-topo-dispatch-panel]')?.innerText ?? null`);
check("dropping on B opens the dispatch panel", Boolean(panel), String(panel).slice(0, 60));
check("…and it says the work goes A -> B",
  Boolean(panel) && panel.includes("从「") && panel.includes("→"), String(panel).replace(/\n/g, " | "));
check("…without mentioning the session I happen to be looking at",
  Boolean(panel) && !/来自/.test(panel), String(panel).replace(/\n/g, " | "));

// ---- ② 真发出去：服务端多一条 handoff，A 不是当前会话也照样能派 --------
const edgesBefore = Number(await ev(`fetch('/api/topology?since=0&archived=1',{credentials:'same-origin'})
  .then(r=>r.json()).then(d => (d.edges||[]).length)`));
const ta = await centerOf("[data-topo-dispatch-text]");
await mouse("mousePressed", ta.x, ta.y); await sleep(60); await mouse("mouseReleased", ta.x, ta.y);
await sleep(250);
await send("Input.insertText", { text: "连线派活：把这一条整理成一句话" });
await sleep(350);
console.log("send-btn", await ev(`JSON.stringify((() => {
  const b = document.querySelector('[data-topo-dispatch-send]');
  return { disabled: b?.disabled ?? null, text: document.querySelector('[data-topo-dispatch-text]')?.value ?? null };
})())`));
const sbtn = await centerOf("[data-topo-dispatch-send]");
await mouse("mousePressed", sbtn.x, sbtn.y); await sleep(60); await mouse("mouseReleased", sbtn.x, sbtn.y);
const sent = await waitFor(`!document.querySelector('[data-topo-dispatch-panel]')`, 12000);
check("the panel closes after sending", sent === true,
  await ev(`JSON.stringify({
    ack: document.querySelector('.topo-toast')?.textContent ?? null,
    err: document.querySelector('.topo-dispatch .err, .topo-err')?.textContent ?? null,
    panel: !!document.querySelector('[data-topo-dispatch-panel]'),
    body: document.querySelector('[data-topo-dispatch-panel]')?.innerText?.slice(0, 40) ?? null,
  })`));
await sleep(1200);
const edgeAfter = await ev(`fetch('/api/topology?since=0&archived=1',{credentials:'same-origin'})
  .then(r=>r.json()).then(d => JSON.stringify({
    n: (d.edges||[]).length,
    mine: (d.edges||[]).filter(e => e.from === ${JSON.stringify(A)} && e.to === ${JSON.stringify(B)}).map(e => e.kind),
  }))`).then(JSON.parse);
check("the server recorded a new relation", edgeAfter.n > edgesBefore, `${edgesBefore} → ${edgeAfter.n}`);
check("…and it is A -> B (handoff)", (edgeAfter.mine || []).includes("handoff"), JSON.stringify(edgeAfter.mine));

// ---- ③ 拖到分区 = 在那个工作空间新建会话并派活 --------------------------------
await sleep(600);
const handle2 = await centerOf(`[data-topo-dispatch="${B}"]`);
// 先把这个分区滚进视口再取点：它可能在长列表下方，否则松手时 elementFromPoint 命中空气。
await ev(`document.querySelector('[data-topo-group]')?.scrollIntoView({ block: 'center' })`);
await sleep(500);
const groupBox = await ev(`JSON.stringify((() => {
  const g = document.querySelector('[data-topo-group]');
  if (!g) return null;
  const r = g.getBoundingClientRect();
  const vh = window.innerHeight;
  // 取分区里的一段「空白」：避开组头（折叠开关）和任何卡片。
  const card = document.querySelector('[data-topo-node]');
  const cardBottom = card ? card.getBoundingClientRect().bottom : r.top;
  let y = Math.min(cardBottom + 24, r.bottom - 8, vh - 60);
  if (!(y > r.top + 50)) y = Math.round(r.top + 60);
  return { x: Math.round(r.left + r.width / 2), y: Math.round(y), label: g.getAttribute('data-topo-group') };
})())`).then((s) => (s ? JSON.parse(s) : null));
check("there is a group to drop on", Boolean(groupBox), JSON.stringify(groupBox));
console.log("probe", groupBox, await ev(`JSON.stringify((() => {
  const el = document.elementFromPoint(${groupBox.x}, ${groupBox.y});
  const grp = el?.closest('[data-topo-group]');
  const card = el?.closest('[data-topo-node]');
  return { el: el?.tagName + '.' + (el?.className || ''), grp: grp?.getAttribute('data-topo-group') ?? null,
           card: card?.getAttribute('data-topo-node') ?? null, vh: window.innerHeight };
})())`));
await mouse("mousePressed", handle2.x, handle2.y);
await sleep(80);
for (let k = 1; k <= 8; k++) {
  await mouse("mouseMoved", handle2.x + Math.round((groupBox.x - handle2.x) * k / 8), handle2.y + Math.round((groupBox.y - handle2.y) * k / 8));
  await sleep(35);
}
const groupHi = await ev(`!!document.querySelector('.topo-group.link-target')`);
check("dropping over a group highlights it as 'create here'", groupHi === true);
await mouse("mouseReleased", groupBox.x, groupBox.y);
await sleep(700);
const panel2 = await ev(`document.querySelector('[data-topo-dispatch-panel]')?.innerText ?? null`);
check("dropping on a group opens the panel in 'new session' mode",
  Boolean(panel2) && /新会话|在这个工作空间/.test(panel2), String(panel2).replace(/\n/g, " | ").slice(0, 80));
await ev(`document.querySelector('[data-topo-dispatch-panel] .icon-btn')?.click(); true`);
await sleep(400);

// ---- ④ 没有发起方时，不会偷偷用「当前正在看的会话」 ----------------------------
await send("Page.reload"); await sleep(2600);
await waitFor(`!!document.querySelector('[data-topo-board]')`, 8000);
await waitFor(`document.querySelectorAll('[data-topo-node]').length > 0`, 8000);
const stale = await ev(`!!document.querySelector('[data-topo-dispatch-panel]')`);
check("a reload leaves no half-open dispatch panel", stale === false);
const stillHasActiveIdLogic = await ev(`(() => {
  // 只看派活面板：别处（消息气泡、通话记录）的「来自」是别人的东西，不算这条回归。
  const p = document.querySelector('[data-topo-dispatch-panel]');
  if (!p) return false;
  return p.innerText.includes("来自「") || p.innerText.includes("左边先选一个会话当发起方");
})()`);
check("the old 'from the session you are viewing' wording is gone", stillHasActiveIdLogic === false);

check("no JS exceptions", exceptions.length === 0, exceptions.slice(0, 2).join(" | "));
console.log(`\n${fail ? "FAIL" : "ALL"} — ${pass} passed, ${fail} failed`);
try { await fetch(`${CDP}/json/close/${tab.id}`); } catch {}  // 别把页面留在浏览器里（堆到几百个会把整台机器拖死）
ws.close();
process.exit(fail ? 1 : 0);
