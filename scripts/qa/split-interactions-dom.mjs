// 上下分屏的三处交互（issue #90）。panel-split-dom 证的是「分屏本身对不对」，这一份证的是
// 「操作者能对每一行做什么」：
//
//   ① 换位按钮是垂直双箭头（⇅）—— 两行是上下叠的，水平箭头在说反话。
//   ② 每行行头有 ×：点它，剩下一行占满全高并成为 tab，状态写回 localStorage（重开仍是单屏）。
//      两个 × 结果一样（剩谁谁全屏），因为操作者脑子里只有「我只想看这个」。
//   ③ 开分屏时下方是选择态：只有「图标 + 名字」的可用工具（不含上方那个），点一个才成行；
//      按 Esc 或点 × 等于放弃（回到单屏），且选择态本身不落盘。
//
//   AGENTUS_BASE=http://127.0.0.1:8901 CDP_URL=http://127.0.0.1:9223 node scripts/qa/split-interactions-dom.mjs
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
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
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

await goto(BASE);
const status = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({username:${JSON.stringify(USER)},password:${JSON.stringify(PASS)}})}).then(r=>r.status)`);
check("logged in", status === 200, `status ${status}`);
await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
await ev(`(() => { for (const k of Object.keys(localStorage)) if (/panel-pair|panel-split/.test(k)) localStorage.removeItem(k); return true; })()`);
await goto(BASE);
await ev(`(() => { const row = document.querySelector('.session-item'); if (row) row.click(); return Boolean(row); })()`);
await sleep(2000);

const SPLIT = `[aria-label="toggle the vertical split"]`;
const openPanel = async () => {
  const open = await ev(`(() => { const b = document.querySelector('.chat-head button[aria-label="file browser"]');
    if (!b) return false; if (!document.querySelector('.tool-panel')) b.click(); return true; })()`);
  await sleep(1500);
  return open;
};
const state = async () => JSON.parse(await ev(`(() => {
  const rows = [...document.querySelectorAll('.panel-stack .stack-pane:not([hidden])')]
    .map(p => ({ pane: p.dataset.pane, top: Math.round(p.getBoundingClientRect().top),
      h: Math.round(p.getBoundingClientRect().height) })).sort((a, b) => a.top - b.top);
  const stack = document.querySelector('.panel-stack')?.getBoundingClientRect();
  return JSON.stringify({ rows, stackH: stack ? Math.round(stack.height) : 0,
    picker: Boolean(document.querySelector('.pane-picker')),
    pair: localStorage.getItem('agentus.panel-pair'),
    tab: document.querySelector('.tool-tab.active')?.textContent?.trim().split(/\\s+/).pop() ?? null });
})()`));
const closeSplitIfAny = async () => {
  if (await ev(`Boolean(document.querySelector('${SPLIT}'))`) && await ev(`document.querySelector('${SPLIT}').getAttribute('aria-pressed') === 'true'`)) {
    await ev(`document.querySelector('${SPLIT}').click(); true`);
    await sleep(800);
  }
};

check("面板能打开", await openPanel());

// ---- ① 换位按钮是垂直双箭头 ---------------------------------------------------------------
// 开一个分屏才有行头。用当前 tab 开，然后选一个下方工具。
await ev(`[...document.querySelectorAll('.tool-tab')].find(t=>/^terminal/.test(t.textContent.trim())).click(); true`);
await sleep(1200);
await ev(`(() => { const b = document.querySelector('.pane-picker [aria-label="put ide below"]'); if (b) b.click(); return Boolean(b); })()`);
await sleep(2000);
const swappedHead = JSON.parse(await ev(`(() => {
  const b = document.querySelector('.split-head button[aria-label^="move the"]');
  if (!b) return JSON.stringify({ found: false });
  const paths = [...b.querySelectorAll('svg path')].map(p => p.getAttribute('d')).join('|');
  return JSON.stringify({ found: true, paths, title: b.getAttribute('title') });
})()`));
check("行头有换位按钮", swappedHead.found === true, JSON.stringify(swappedHead));
check("换位按钮是垂直双箭头 ⇅（路径里有向上和向下的箭头，不是一对横箭头）",
  /M8 20V5/.test(swappedHead.paths || "") && /M16 4v15/.test(swappedHead.paths || ""),
  String(swappedHead.paths));
check("…不再是水平换位图标的路径（#90 前的那一个）", !/M4 8h13/.test(swappedHead.paths || ""), String(swappedHead.paths));

// ---- ② × 关掉一行：剩下的占满全高，并写回 localStorage -------------------------------------
{
  const before = await state();
  check("两行都在（上方 terminal、下方 ide）",
    before.rows.length === 2 && before.rows[0].pane === "terminal" && before.rows[1].pane === "ide",
    JSON.stringify(before.rows));
  // 关掉上方那一行 → 下方 ide 占满
  await ev(`document.querySelector('[data-pane="terminal"] .split-head [aria-label="close the terminal pane"]').click(); true`);
  await sleep(1200);
  const after = await state();
  check("关掉上方行后只剩另一行", after.rows.length === 1 && after.rows[0].pane === "ide", JSON.stringify(after.rows));
  check("…它占满全高（不是留着分屏的一半）",
    Math.abs(after.rows[0].h - after.stackH) <= 2, `${after.rows[0].h} vs ${after.stackH}`);
  check("…tab 栏显示的也是它", after.tab === "ide", String(after.tab));
  check("…localStorage 已写回单屏（重开不会回到分屏）", after.pair === null, String(after.pair));
  check("…分屏开关已回落到关闭态",
    (await ev(`document.querySelector('${SPLIT}')?.getAttribute('aria-pressed')`)) === "false");
}

// 从另一侧再验一次：关掉下方那一行
{
  await ev(`[...document.querySelectorAll('.tool-tab')].find(t=>/^terminal/.test(t.textContent.trim())).click(); true`);
  await sleep(1000);
  await ev(`(() => { const b = document.querySelector('.pane-picker [aria-label="put ide below"]'); if (b) b.click(); return Boolean(b); })()`);
  await sleep(1800);
  const two = await state();
  check("再开一次分屏仍是两行（上 terminal、下 ide）",
    two.rows.length === 2 && two.rows[0].pane === "terminal", JSON.stringify(two.rows));
  await ev(`document.querySelector('[data-pane="ide"] .split-head [aria-label="close the ide pane"]').click(); true`);
  await sleep(1200);
  const after = await state();
  check("关掉下方行后只剩上方那一行", after.rows.length === 1 && after.rows[0].pane === "terminal", JSON.stringify(after.rows));
  check("…同样占满全高并写回单屏",
    Math.abs(after.rows[0].h - after.stackH) <= 2 && after.pair === null, `${after.rows[0].h}/${after.stackH} pair=${after.pair}`);
}

// ---- ③ 选择态可以放弃：Esc / × ------------------------------------------------------------
{
  await ev(`[...document.querySelectorAll('.tool-tab')].find(t=>/^terminal/.test(t.textContent.trim())).click(); true`);
  await sleep(1000);
  check("开分屏时下方是选择态", (await state()).picker === true);
  const items = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('.pane-picker-item')]
    .map(b => ({ label: (b.textContent||'').trim(), icon: Boolean(b.querySelector('svg')) })))`));
  check("选择态里每一项都有图标和名字", items.length > 0 && items.every((i) => i.icon && i.label), JSON.stringify(items));
  check("…不含上方已经在用的工具", !items.some((i) => i.label === "terminal"), items.map((i) => i.label).join(","));
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true`);
  await sleep(900);
  const afterEsc = await state();
  check("按 Esc 放弃选择态（回到单屏，不残留）",
    afterEsc.picker === false && afterEsc.rows.length === 1 && afterEsc.pair === null,
    JSON.stringify(afterEsc));

  await ev(`[...document.querySelectorAll('.tool-tab')].find(t=>/^terminal/.test(t.textContent.trim())).click(); true`);
  await sleep(1000);
  await ev(`document.querySelector('.pane-picker [aria-label="close the picker"]').click(); true`);
  await sleep(900);
  const afterX = await state();
  check("点 × 也放弃选择态",
    afterX.picker === false && afterX.rows.length === 1 && afterX.pair === null, JSON.stringify(afterX));
}

// ---- 回归：#79 只有两行，永远不多出第三行 --------------------------------------------------
{
  await ev(`[...document.querySelectorAll('.tool-tab')].find(t=>/^terminal/.test(t.textContent.trim())).click(); true`);
  await sleep(900);
  await ev(`(() => { const b = document.querySelector('.pane-picker [aria-label="put ide below"]'); if (b) b.click(); return Boolean(b); })()`);
  await sleep(1500);
  const vis = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('.panel-stack .stack-pane:not([hidden])')].map(p => p.dataset.pane))`));
  check("#79 回归：屏幕上只有两行，第三块 pane 不会溜进来", vis.length === 2, vis.join(","));
  const overflow = await ev(`document.querySelector('.panel-stack').scrollWidth <= document.querySelector('.panel-stack').clientWidth + 1`);
  check("…且没有横向溢出", overflow === true);
}

await closeSplitIfAny();
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
await send("Page.close").catch(() => {});
ws.close();
process.exit(fail === 0 ? 0 : 1);
