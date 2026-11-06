// #94/#95 的手机形态：这次改动全是「多一个入口、多一层折叠、多一种拖动」，
// 每一样在 390px 上都会换一种坏法 —— 入口够不到、折叠行点不中、手指一划页面不动、
// 拖一下卡片就飞了。桌面 sweep 一条都测不到这些，所以单独一份。
//
//   AGENTUS_BASE=http://127.0.0.1:8901 CDP_URL=http://127.0.0.1:9223 node scripts/qa/topology-mobile-dom.mjs
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
const touch = (type, x, y) => send("Input.dispatchTouchEvent", {
  type, touchPoints: type === "touchEnd" ? [] : [{ x, y, radiusX: 8, radiusY: 8, force: 1 }],
});
const tap = async (x, y, hold = 40) => { await touch("touchStart", x, y); await sleep(hold); await touch("touchEnd", x, y); };
const waitFor = async (expr, ms = 5000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(150); }
  return false;
};

await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 780, deviceScaleFactor: 2, mobile: true });
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
await send("Page.navigate", { url: BASE });
await sleep(2800);
const login = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({username:${JSON.stringify(USER)},password:${JSON.stringify(PASS)}})}).then(r=>r.status)`);
check("logged in", login === 200, `status ${login}`);
// 上一轮 sweep 可能把折叠/位置存进了同一 origin 的 localStorage：清掉，让「默认」这条真的被测到。
await ev(`localStorage.removeItem('agentus.topo.collapsed'); localStorage.removeItem('agentus.topo.pos'); localStorage.removeItem('agentus.topo.groupPos'); true`);
await send("Page.reload");
await sleep(2800);

// ---- ① 入口在手指能够到的地方：抽屉里的 rail -----------------------------------
// reload 之后 shell 要重新挂：先等 rail 出现，否则下面量到的全是 null。
for (let i = 0; i < 50; i++) {
  if (await ev(`!!document.querySelector('.sidebar')`)) break;
  await sleep(200);
}
const drawerBefore = await ev(`document.querySelector('.sidebar')?.classList.contains('open')`);
check("#94 phone: the rail starts off-canvas", drawerBefore === false, String(drawerBefore));
// reload 之后 shell 要重新挂：等菜单按钮出现，别在「加载中」上量 null。
for (let i = 0; i < 50; i++) {
  if (await ev(`!!document.querySelector('button.menu-btn')`)) break;
  await sleep(200);
}
const menu = await ev(`JSON.stringify((() => {
  const b = document.querySelector('button.menu-btn');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
})())`).then((s) => (s ? JSON.parse(s) : null));
check("#94 phone: there is a hamburger big enough for a finger", Boolean(menu) && menu.w >= 32 && menu.h >= 32,
  JSON.stringify(menu));
await tap(menu.x, menu.y);
// 抽屉是滑入动画：等到它真的停在 0 再量坐标，否则量到的是「还在屏幕外」的中间帧。
const opened = await waitFor(`(() => { const s = document.querySelector('.sidebar');
  return !!s && s.classList.contains('open') && s.getBoundingClientRect().left >= -1; })()`, 5000);
check("#94 phone: the drawer slides fully in", opened === true);
await sleep(300);
const navBox = await ev(`JSON.stringify((() => {
  const n = document.querySelector('[data-nav="topology"]');
  if (!n) return null;
  const r = n.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
           w: Math.round(r.width), h: Math.round(r.height),
           overlapsHeader: r.top < (document.querySelector('.rail-search-wrap')?.getBoundingClientRect().top ?? 0) };
})())`).then((s) => (s ? JSON.parse(s) : null));
check("#94 phone: the 会话拓扑 entry sits in the drawer and is tappable",
  Boolean(navBox) && navBox.w > 80 && navBox.h >= 28, JSON.stringify(navBox));
await tap(navBox.x, navBox.y);
check("#94 phone: tapping it opens the board",
  await waitFor(`!!document.querySelector('[data-topo-board]')`, 6000) === true);

// ---- ② 折叠行：手指点得中、默认只开一组 ---------------------------------------
await waitFor(`document.querySelectorAll('[data-topo-group]').length > 0`, 6000);
const g = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-topo-group]')].map(x => {
  const r = x.getBoundingClientRect();
  const head = x.querySelector('.topo-group-head').getBoundingClientRect();
  return { label: x.getAttribute('data-topo-group'), collapsed: x.getAttribute('data-topo-collapsed'),
           h: Math.round(r.height), headH: Math.round(head.height),
           x: Math.round(r.left + r.width / 2), y: Math.round(head.top + head.height / 2) };
}))`));
check("#95 phone: there are still group headers to fold", g.length >= 1, JSON.stringify(g.map((x) => x.label)));
check("#95 phone: the header is a 44px touch target", g.every((x) => x.headH >= 43), JSON.stringify(g.map((x) => x.headH)));
const foldedOne = g.find((x) => x.collapsed === "1");
if (foldedOne) {
  const before = await ev(`document.querySelectorAll('[data-topo-node]').length`);
  // 折叠行可能整块在视口外（第一组展开后列表很长）：先把它滚进屏幕，否则点的是空气。
  await ev(`document.querySelector('[data-topo-group="${foldedOne.label}"]').scrollIntoView({ block: 'center' })`);
  await sleep(500);
  const spot = JSON.parse(await ev(`JSON.stringify((() => {
    const h = document.querySelector('[data-topo-group="${foldedOne.label}"] .topo-group-head').getBoundingClientRect();
    return { x: Math.round(h.left + h.width / 2), y: Math.round(h.top + h.height / 2) };
  })())`));
  check("#95 phone: the folded row is reachable where we tap it",
    await ev(`(() => { const e = document.elementFromPoint(${spot.x}, ${spot.y}); return !!e && ${spot.y} < window.innerHeight - 24; })()`),
    JSON.stringify(spot));
  await tap(spot.x, spot.y);
  await waitFor(`document.querySelector('[data-topo-group="${foldedOne.label}"]').getAttribute('data-topo-collapsed') === '0'`, 4000);
  await sleep(300);
  const now = await ev(`document.querySelector('[data-topo-group="${foldedOne.label}"]').getAttribute('data-topo-collapsed')`);
  const after = await ev(`document.querySelectorAll('[data-topo-node]').length`);
  check("#95 phone: tapping a folded header opens it", now === "0", `collapsed=${now}`);
  check("#95 phone: …and its cards show up", after > before, `${before} → ${after}`);
} else {
  check("#95 phone: tapping a folded header opens it", false, "no folded group to tap (fixture missing)");
  check("#95 phone: …and its cards show up", false, "same");
}

// ---- ③ 卡片不横向溢出（390px 下单列） ----------------------------------------
const overflowRaw = await ev(`JSON.stringify((() => {
  if (!document.querySelector('[data-topo-canvas]')) return null;
  const c = document.querySelector('[data-topo-canvas]');
  const sheet = document.querySelector('[data-topo-sheet]');
  const cards = [...document.querySelectorAll('[data-topo-node]')].map(n => {
    const r = n.getBoundingClientRect(); const cr = c.getBoundingClientRect();
    return { over: Math.round(r.right - cr.right), w: Math.round(r.width) };
  });
  return { scrollW: c.scrollWidth, clientW: c.clientWidth, sheetW: Math.round(sheet.getBoundingClientRect().width),
           worstOver: Math.max(0, ...cards.map(x => x.over)), cards: cards.length, cardW: cards[0]?.w ?? 0 };
})())`);
const overflow = overflowRaw ? JSON.parse(overflowRaw) : { scrollW: 0, clientW: 0, sheetW: 0, worstOver: 0, cards: 0, cardW: 0 };
check("#95 phone: the sheet fits the viewport (no sideways scroll)", overflow.scrollW <= overflow.clientW + 1,
  JSON.stringify(overflow));
check("#95 phone: no card is clipped by the right edge", overflow.worstOver <= 1, JSON.stringify(overflow));

// ---- ④ 手指滑动要能滚：触摸不能被拖动逻辑吃掉 --------------------------------
// 回到顶部再滑：这时候第一张卡才在屏幕里，而且还有一大段可以往下滚。
await ev(`document.querySelector('[data-topo-canvas]').scrollTop = 0`); await sleep(500);
const scrollTop0 = await ev(`document.querySelector('[data-topo-canvas]').scrollTop`);
const cardBox = await ev(`JSON.stringify((() => {
  const n = document.querySelector('[data-topo-node]');
  if (!n) return null;
  const r = n.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})())`).then((s) => (s ? JSON.parse(s) : null));
check("#95 phone: there is a card to swipe over", Boolean(cardBox), JSON.stringify(cardBox));

await touch("touchStart", cardBox.x, cardBox.y);
for (let k = 1; k <= 10; k++) { await touch("touchMove", cardBox.x, cardBox.y - k * 22); await sleep(28); }
await touch("touchEnd", cardBox.x, cardBox.y - 220);
await sleep(700);
const scrollTop1 = await ev(`document.querySelector('[data-topo-canvas]').scrollTop`);
check("#95 phone: swiping the canvas scrolls it (touch-action stayed auto)",
  scrollTop1 > scrollTop0 + 40, `${scrollTop0} → ${scrollTop1}`);
const posAfterSwipe = await ev(`localStorage.getItem('agentus.topo.pos') || '{}'`);
check("#95 phone: …and the swipe did not drag a card instead",
  posAfterSwipe === "{}" || Object.keys(JSON.parse(posAfterSwipe)).length === 0, posAfterSwipe);

check("no JS exceptions", exceptions.length === 0, exceptions.slice(0, 2).join(" | "));
console.log(`\n${fail ? "FAIL" : "ALL"} — ${pass} passed, ${fail} failed`);
try { await fetch(`${CDP}/json/close/${tab.id}`); } catch {}  // 别把页面留在浏览器里（堆到几百个会把整台机器拖死）
ws.close();
process.exit(fail ? 1 : 0);
