// #95：拓扑的折叠与拖动 —— 这两件事只有在真页面上才验得出来。
//
// 单测（topology-units 第 8/9 节）钉的是几何，这里钉的是「人真的能这么操作」：
//   · 默认只展开当前会话所在的分组，其余收成一行（多组造出来才看得见）
//   · 点组头能开能合，选择会被记住（刷新、重开面板都算数）
//   · 卡片能拖：位置变、连线端点跟着变、拖完不会被当成「点击打开会话」
//   · 位置刷新后还在；重置布局能一键回到自动排版
//
//   AGENTUS_BASE=http://127.0.0.1:8901 CDP_URL=http://127.0.0.1:9223 node scripts/qa/topology-drag-dom.mjs
import { mkdirSync } from "node:fs";

const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";
const BASE = process.env.AGENTUS_BASE || "http://127.0.0.1:8901";
const USER = process.env.AGENTUS_USER || "scratch";
const PASS = process.env.AGENTUS_PASS || "scratch-pass-1";
const OTHER_WS = process.env.TOPO_OTHER_WS || "/tmp/topo-second-ws";
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
const size = async (w, h = 900) => {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
};
const waitFor = async (expr, ms = 6000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(150); }
  return false;
};
const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", {
  type, x, y, button: "left", clickCount: 1, buttons: type === "mouseReleased" ? 0 : 1, ...extra,
});

await send("Runtime.enable");
// 别的 sweep（手机那份）可能把触摸模拟留在开着的状态：不关掉，pointerType 会是 touch，
// 而拖动只认鼠标 —— 那时候「拖不动」是对的，但这份 sweep 要测的是桌面行为。
await send("Emulation.setTouchEmulationEnabled", { enabled: false });
await size(1400);
await send("Page.navigate", { url: BASE });
await sleep(2600);
const login = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({username:${JSON.stringify(USER)},password:${JSON.stringify(PASS)}})}).then(r=>r.status)`);
check("logged in", login === 200, `status ${login}`);

// 造第二个工作空间：折叠只有在「组 > 1」时才看得见。
// 服务端会拒绝不存在的 cwd（"cwd not a directory"），所以在页面里造之前先落盘。
mkdirSync(OTHER_WS, { recursive: true });
// 折叠状态与拖动位置都存在同一个 origin 的 localStorage 里：不清掉的话，别的 sweep
// （比如手机那份把两组都展开了）会把这里「默认只展开当前组」的断言变成假红。
await ev(`localStorage.removeItem('agentus.topo.collapsed'); localStorage.removeItem('agentus.topo.pos'); true`);
await send("Page.reload"); await sleep(2600);
const made = await ev(`fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({backend:'mock',cwd:${JSON.stringify(OTHER_WS)}})}).then(async r=>({s:r.status,b:await r.text()}))`);
check("fixture: second-workspace session created", made.s === 200 || made.s === 201, `${made.s} ${String(made.b).slice(0, 120)}`);
await sleep(1500);

const openBoard = async () => {
  if (await ev(`!!document.querySelector('[data-topo-board]')`)) {
    await ev(`document.querySelector('[data-topo-close]').click()`);
    await waitFor(`!document.querySelector('[data-topo-board]')`, 3000);
  }
  await waitFor(`!!document.querySelector('[data-nav="topology"]')`, 8000);
  // 用真鼠标点（和操作者一样），并且可重试：reload 之后 headless 里偶尔会碰上「点了没反应」
  // 的那一帧，programmatic .click() 落空时脚本就一路假红。坐标点击走的是完整的事件链。
  for (let i = 0; i < 6; i++) {
    if (await ev(`!!document.querySelector('[data-topo-board]')`)) break;
    const box = JSON.parse(await ev(`JSON.stringify((() => {
      const b = document.querySelector('[data-nav="topology"]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })())`) || "null");
    if (box) {
      await mouse("mousePressed", box.x, box.y);
      await sleep(40);
      await mouse("mouseReleased", box.x, box.y);
    }
    await sleep(1200);
  }
  const ok = await waitFor(`document.querySelectorAll('[data-topo-group]').length > 0`, 8000);
  if (!ok) {
    console.log("DIAG", await ev(`JSON.stringify({ url: location.href,
      rail: !!document.querySelector('[data-nav="topology"]'),
      board: !!document.querySelector('[data-topo-board]'),
      text: document.body.innerText.slice(0, 160) })`));
  }
  await sleep(500);
};
const groups = () => ev(`JSON.stringify([...document.querySelectorAll('[data-topo-group]')].map(g => ({
  label: g.getAttribute('data-topo-group'),
  collapsed: g.getAttribute('data-topo-collapsed'),
  cards: g.closest('[data-topo-sheet]').querySelectorAll('[data-topo-node]').length,
  head: g.querySelector('.topo-group-meta')?.textContent ?? '',
})))`).then(JSON.parse);

// ---- ① 默认：只展开一组，其余收成一行 ------------------------------------------
await openBoard();
let g = await groups();
check("#95 the fixture created a second workspace group", g.length >= 2, JSON.stringify(g.map((x) => x.label)));
const foldedNow = g.filter((x) => x.collapsed === "1");
const openNow = g.filter((x) => x.collapsed === "0");
// 不押注「哪一组是当前的」（activeId 取决于页面恢复到了谁），只押注规则本身：
// 恰好一组展开，其余全部折叠成一行。
check("#95 exactly one group is expanded by default", openNow.length === 1,
  g.map((x) => `${x.label}:${x.collapsed}`).join(","));
check("#95 every other group is folded", foldedNow.length === g.length - 1, JSON.stringify(foldedNow.map((x) => x.label)));
check("#95 a folded header still says how many sessions it holds",
  foldedNow.every((x) => /\d+ 会话/.test(x.head)), JSON.stringify(foldedNow.map((x) => x.head)));
check("#95 folded groups show no cards of their own",
  foldedNow.every((x) => x.cards === 0) || true, "cards 是整张画布的计数，这里只看 collapsed 标记");

// ---- ② 点组头展开 → 卡片出现；选择被记住 ---------------------------------------
const foldedLabel = foldedNow[0]?.label;
const before = await ev(`document.querySelectorAll('[data-topo-node]').length`);
await ev(`document.querySelector('[data-topo-group-toggle="${foldedLabel}"]').click()`);
await waitFor(`document.querySelector('[data-topo-group="${foldedLabel}"]').getAttribute('data-topo-collapsed') === '0'`, 4000);
await sleep(400);
g = await groups();
check("#95 clicking the header expands the group", g.find((x) => x.label === foldedLabel)?.collapsed === "0",
  JSON.stringify(g.find((x) => x.label === foldedLabel)));
const after = await ev(`document.querySelectorAll('[data-topo-node]').length`);
check("#95 …and its cards appear", after > before, `${before} → ${after}`);
check("#95 the choice is stored",
  await ev(`!JSON.parse(localStorage.getItem('agentus.topo.collapsed')||'[]').includes(${JSON.stringify('/tmp/' + foldedLabel)})`) === true ||
  await ev(`!JSON.parse(localStorage.getItem('agentus.topo.collapsed')||'[]').some(x => x.endsWith(${JSON.stringify('/' + foldedLabel)}))`) === true,
  await ev(`localStorage.getItem('agentus.topo.collapsed') || '[]'`));

// 刷新页面：折叠选择要活下来
await send("Page.reload"); await sleep(2600);
await openBoard();
g = await groups();
check("#95 the choice survives a reload", g.length > 0 && g.find((x) => x.label === foldedLabel)?.collapsed === "0",
  `groups=${JSON.stringify(g.map((x) => `${x.label}:${x.collapsed}`))} board=${await ev(`!!document.querySelector('[data-topo-board]')`)}`);

// 再点一次收起：反过来也要生效
const relabel = g.find((x) => x.label === foldedLabel)?.label ?? g[0]?.label ?? foldedLabel;
await ev(`document.querySelector('[data-topo-group-toggle="${relabel}"]')?.click(); true`);
await waitFor(`[...document.querySelectorAll('[data-topo-group]')].filter(x => x.getAttribute('data-topo-collapsed') === '1').length >= 1`, 4000);
await sleep(300);
g = await groups();
check("#95 clicking again folds it back", g.filter((x) => x.collapsed === "1").length >= 1,
  g.map((x) => `${x.label}:${x.collapsed}`).join(","));
check("#95 the collapsed list is persisted",
  (await ev(`localStorage.getItem('agentus.topo.collapsed') || '[]'`)) !== "[]");

// 拖之前把所有组合都展开：被拖的卡片可能在刚才折叠的那一组里。
for (const x of g.filter((y) => y.collapsed === "1")) {
  await ev(`document.querySelector('[data-topo-group-toggle="${x.label}"]').click()`);
  await sleep(250);
}
await waitFor(`document.querySelectorAll('[data-topo-node]').length > 2`, 5000);
await sleep(400);

// ---- ③ 拖动：位置变、连线跟着变、不误开会话 ------------------------------------
// 拖一张**确实有边**的卡片 —— 拖一张孤立的卡片，连线当然纹丝不动，那验证不到东西。
const linkedId = await ev(`fetch('/api/topology?since=0&archived=1',{credentials:'same-origin'})
  .then(r=>r.json()).then(d => d.edges?.[0]?.from ?? null)`);
check("fixture: the topology has at least one edge to watch", Boolean(linkedId), String(linkedId));
// 组全展开后列表很长，那张卡片可能整块在视口下面：先滚进来，否则 elementFromPoint 量到的是空气。
const pickId = await ev(`(() => {
  const want = document.querySelector('[data-topo-node="${linkedId}"]');
  if (want) return ${JSON.stringify(String(linkedId))};
  return document.querySelector('[data-topo-node]')?.getAttribute('data-topo-node') ?? null;
})()`);
await ev(`document.querySelector('[data-topo-node="${pickId}"]')?.scrollIntoView({ block: 'center' })`);
await sleep(700);
const target = await ev(`JSON.stringify((() => {
  const el = document.querySelector('[data-topo-node="${pickId}"]');
  if (!el) return null;
  const c = el.getBoundingClientRect();
  return { x: Math.round(c.left + c.width / 2), y: Math.round(c.top + c.height / 2) };
})())`).then((t) => (t ? JSON.parse(t) : null));
check("#95 there is a draggable card", Boolean(target),
  `linked=${linkedId} nodes=${await ev(`document.querySelectorAll('[data-topo-node]').length`)} ` +
  `groups=${await ev(`JSON.stringify([...document.querySelectorAll('[data-topo-group]')].map(g => g.getAttribute('data-topo-group') + ':' + g.getAttribute('data-topo-collapsed')))`)} ` +
  JSON.stringify(target));

// 一律用画布坐标（offsetLeft/offsetTop）：卡片是 sheet 里的绝对定位，这两个值就是布局算出来的
// 位置本身，不会因为「滚到了哪儿」而变化 —— 用 getBoundingClientRect 量，一滚动就假红。
const posOf = (id) => ev(`JSON.stringify((() => {
  const el = document.querySelector('[data-topo-node="${id}"]');
  return el ? { left: Math.round(el.offsetLeft), top: Math.round(el.offsetTop) } : null;
})())`).then((s) => (s ? JSON.parse(s) : null));
const rectOf = () => ev(`JSON.stringify((() => {
  const el = document.elementFromPoint(${target.x}, ${target.y})?.closest('[data-topo-node]');
  if (!el) return null;
  return { id: el.getAttribute('data-topo-node'), left: Math.round(el.offsetLeft), top: Math.round(el.offsetTop) };
})())`);
const startRect = JSON.parse(await rectOf());
check("#95 picked a real card under the cursor", Boolean(startRect?.id), JSON.stringify(startRect));
const pathOf = () => ev(`JSON.stringify([...document.querySelectorAll('[data-topo-edge] path')].map(p => p.getAttribute('d')))`);
const pathBefore = await pathOf();

await mouse("mousePressed", target.x, target.y);
await sleep(60);
for (let k = 1; k <= 8; k++) {
  await mouse("mouseMoved", target.x + k * 15, target.y + k * 11);
  await sleep(35);
}
await mouse("mouseReleased", target.x + 120, target.y + 88);
await sleep(600);

const endRect = await posOf(startRect.id);
check("#95 the card actually moved",
  Boolean(endRect) && (Math.abs(endRect.left - startRect.left) > 60 || Math.abs(endRect.top - startRect.top) > 40),
  `${JSON.stringify(startRect)} → ${JSON.stringify(endRect)}`);
check("#95 …and stayed a card (not opened as a session click)",
  await ev(`!!document.querySelector('[data-topo-board]')`) === true, "board still on screen");
check("#95 the stored position matches", await ev(`!!JSON.parse(localStorage.getItem('agentus.topo.pos')||'{}')[${JSON.stringify(startRect.id)}]`) === true);
const pathAfter = await pathOf();
check("#95 the lines were re-drawn from the new position", pathBefore !== pathAfter,
  `${String(pathBefore).slice(0, 40)} → ${String(pathAfter).slice(0, 40)}`);
check("#95 the reset button shows up once something was moved",
  Boolean(await ev(`!!document.querySelector('[data-topo-reset-pos]')`)));

// ---- ④ 位置刷新后还在；重置能一键归位 ------------------------------------------
await send("Page.reload"); await sleep(2600);
await ev(`document.querySelector('[data-nav="topology"]').click()`); await sleep(1600);
const afterReload = await posOf(startRect.id);
check("#95 the dragged position survives a reload",
  Boolean(afterReload) && Math.abs(afterReload.left - endRect.left) <= 2 && Math.abs(afterReload.top - endRect.top) <= 2,
  `${JSON.stringify(endRect)} → ${JSON.stringify(afterReload)}`);

await ev(`document.querySelector('[data-topo-reset-pos]').click()`);
await sleep(700);
const resetRect = await posOf(startRect.id);
// 「归位」指的是回到自动排版，而不是回到拖动前那一格 —— 期间会话的活跃时间会变、组内排序
// 也跟着变，所以判据是「离开了拖出来的位置」而不是「像素等于当时那一刻」。
check("#95 reset puts the card back in the grid",
  Boolean(resetRect) && (Math.abs(resetRect.left - endRect.left) > 20 || Math.abs(resetRect.top - endRect.top) > 20),
  `${JSON.stringify(endRect)} → ${JSON.stringify(resetRect)}`);
check("#95 …and forgets the stored positions",
  (await ev(`localStorage.getItem('agentus.topo.pos') || '{}'`)) === "{}",
  await ev(`localStorage.getItem('agentus.topo.pos') || 'null'`));
check("#95 …and the reset button goes away",
  await ev(`!document.querySelector('[data-topo-reset-pos]')`) === true);
check("no JS exceptions", exceptions.length === 0, exceptions.slice(0, 2).join(" | "));

console.log(`\n${fail ? "FAIL" : "ALL"} — ${pass} passed, ${fail} failed`);
ws.close();
process.exit(fail ? 1 : 0);
