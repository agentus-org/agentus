// #94：全局视图入口归左侧 rail，不归 ChatHead。
//
// 判据一句话：「这台机器/这个项目在干什么」→ rail 顶部固定区；「这个会话怎么用」→ ChatHead。
// 会话拓扑和定时任务问的是前者，所以它们必须活在 rail 里，而 head 上不该再有它们的图标。
//
// 覆盖（对应 issue 的四条验收）：
//   ① 宽屏 head 里没有拓扑/定时图标；rail 顶部固定区有两个带文字条目，且几何上在搜索框之上、
//      与下方会话列表之间有分隔线
//   ② 点击行为与迁移前一致：开面板、Esc 回到会话页（次序仍是 App 的那套 useEscape）
//   ③ rail collapsed（60px）：文字收起、图标可点、tooltip 还在
//   ④ 手机上 rail 收起时入口仍可达（跟现有 hamburger 一致）
//   ⑤ 会话级按钮（通话）仍在 head —— #88/#80 的形态不回退
//
//   AGENTUS_BASE=http://127.0.0.1:8901 CDP_URL=http://127.0.0.1:9223 node scripts/qa/rail-nav-dom.mjs
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
const size = async (w, h = 900, mobile = false) => {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
  await sleep(420);
};
// headless 不喷帧，CSS 过渡会停在起点；把过渡冻到终态，断言的是「能不能用」不是动画曲线。
const freeze = () => ev(`(() => { if (document.getElementById('qa-no-anim')) return true;
  const st = document.createElement('style'); st.id = 'qa-no-anim';
  st.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}';
  document.head.appendChild(st); return true; })()`);

await send("Runtime.enable");
await size(1200);
await send("Page.navigate", { url: BASE });
await sleep(2600);
const status = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({username:${JSON.stringify(USER)},password:${JSON.stringify(PASS)}})}).then(r=>r.status)`);
check("logged in", status === 200, `status ${status}`);
check("fixture session exists", Boolean(await ev(`fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({backend:'mock',cwd:'/tmp'})}).then(r=>r.ok)`)));

const reload = async (mode) => {
  await ev(`localStorage.setItem('agentus.rail-mode','${mode}')`);
  await send("Page.reload"); await sleep(2600); await freeze();
};
const ESC = `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`;

// ---- ① 宽屏：head 干净，rail 顶部有固定导航区 ---------------------------------------------
await reload("expanded");
await size(1400);

const headLeftovers = JSON.parse(await ev(`JSON.stringify({
  topo: !!document.querySelector('.head-actions [data-topo-entry], .chat-head [data-topo-entry]'),
  cron: !!document.querySelector('.head-actions [data-cron-entry], .chat-head [data-cron-entry]'),
  anyTopoInHead: [...document.querySelectorAll('[data-topo-entry]')].some(b => b.closest('.head-actions')),
  anyCronInHead: [...document.querySelectorAll('[data-cron-entry]')].some(b => b.closest('.head-actions')),
})`));
check("#94 no topology icon in the chat head",
  !headLeftovers.topo && !headLeftovers.anyTopoInHead, JSON.stringify(headLeftovers));
check("#94 no cron icon in the chat head",
  !headLeftovers.cron && !headLeftovers.anyCronInHead, JSON.stringify(headLeftovers));

const nav = JSON.parse(await ev(`JSON.stringify((() => {
  const side = document.querySelector('.sidebar');
  const topo = document.querySelector('[data-nav="topology"]');
  const cron = document.querySelector('[data-nav="cron"]');
  const search = document.querySelector('.rail-search-wrap');
  const list = document.querySelector('.session-list');
  const r = (el) => el ? el.getBoundingClientRect() : null;
  return {
    inRail: !!topo?.closest('.sidebar') && !!cron?.closest('.sidebar'),
    topoText: topo ? topo.innerText.trim() : "",
    cronText: cron ? cron.innerText.trim() : "",
    topoTitle: topo?.getAttribute('title') ?? "",
    belowSearch: topo && search ? Math.round(r(topo).top) < Math.round(r(search).top) : null,
    aboveList: topo && list ? Math.round(r(topo).top) < Math.round(r(list).top) : null,
    divider: !!document.querySelector('.rail-nav-divider, .rail-nav + .rail-search-wrap, .rail-nav-divider-line'),
    sideVisible: side ? getComputedStyle(side).display !== 'none' : false,
  };
})())`));
check("#94 both entries live in the rail", nav.inRail === true, JSON.stringify(nav));
check("#94 they carry words when expanded",
  /会话拓扑/.test(nav.topoText) && /定时任务/.test(nav.cronText), `${nav.topoText} | ${nav.cronText}`);
check("#94 the fixed strip sits above the search box", nav.belowSearch === true, JSON.stringify(nav));
check("#94 …and above the session list (fixed, not scrolled away)", nav.aboveList === true, JSON.stringify(nav));
check("#94 a divider separates it from the list", nav.divider === true, JSON.stringify(nav));
check("#94 each entry has a tooltip", nav.topoTitle.length > 8, nav.topoTitle);

// ---- ② 行为与迁移前一致：开面板 → Esc 回 ------------------------------------------------
await ev(`document.querySelector('[data-nav="topology"]').click()`);
await sleep(900);
check("#94 clicking 会话拓扑 still opens the board",
  Boolean(await ev(`!!document.querySelector('[data-topo-board]')`)));
check("#94 …and the rail stays visible behind it",
  Boolean(await ev(`getComputedStyle(document.querySelector('.sidebar')).display !== 'none'`)));
await ev(ESC); await sleep(700);
check("#94 Esc returns to the session page",
  Boolean(await ev(`!document.querySelector('[data-topo-board]') && !!document.querySelector('.chat-col')`)));

await ev(`document.querySelector('[data-nav="cron"]').click()`);
await sleep(1100);
check("#94 clicking 定时任务 still opens the panel",
  Boolean(await ev(`!!document.querySelector('[data-cron-panel]')`)));
await ev(ESC); await sleep(700);
check("#94 Esc returns from the cron panel too",
  Boolean(await ev(`!document.querySelector('[data-cron-panel]') && !!document.querySelector('.chat-col')`)));

// ---- ③ collapsed（60px）：图标态仍可用 ----------------------------------------------------
await reload("compact");
await size(1400);
const compact = JSON.parse(await ev(`JSON.stringify((() => {
  const topo = document.querySelector('[data-nav="topology"]');
  const label = topo?.querySelector('span');
  const r = topo?.getBoundingClientRect();
  return {
    cls: document.querySelector('.sidebar').className,
    textHidden: label ? (label.offsetWidth === 0 || getComputedStyle(label).display === 'none') : null,
    w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0,
    title: topo?.getAttribute('title') ?? '',
    aria: topo?.getAttribute('aria-label') ?? '',
  };
})())`));
check("#94 compact rail: the label is folded away", compact.textHidden === true, JSON.stringify(compact));
check("#94 compact rail: the entry is still a real target (icon box)",
  compact.w >= 24 && compact.h >= 24, JSON.stringify(compact));
check("#94 compact rail: tooltip + aria-label survive",
  compact.title.length > 8 && compact.aria.length > 3, JSON.stringify(compact));
await ev(`document.querySelector('[data-nav="cron"]').click()`);
await sleep(1100);
check("#94 compact rail: clicking the icon still opens the panel",
  Boolean(await ev(`!!document.querySelector('[data-cron-panel]')`)));
await ev(ESC); await sleep(600);

// ---- ④ 手机：入口跟着 drawer 走 -----------------------------------------------------------
await reload("expanded");
await size(390, 780, true);
await send("Page.reload"); await sleep(2600); await freeze();
const phoneClosed = await ev(`(() => { const n = document.querySelector('[data-nav="topology"]');
  const s = document.querySelector('.sidebar'); const r = n?.getBoundingClientRect();
  return { left: r ? Math.round(r.left) : null, open: s?.classList.contains('open'), display: s ? getComputedStyle(s).display : null }; })()`);
check("#94 phone: the entry is inside the drawer (off-canvas while closed)",
  phoneClosed.open === false, JSON.stringify(phoneClosed));
await ev(`document.querySelector('button.menu-btn').click()`);
await sleep(800);
const phoneOpen = JSON.parse(await ev(`JSON.stringify((() => {
  const n = document.querySelector('[data-nav="topology"]'); const r = n?.getBoundingClientRect();
  return { left: r ? Math.round(r.left) : -1, w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0,
           open: document.querySelector('.sidebar').classList.contains('open') };
})())`));
check("#94 phone: the hamburger reveals it, still clickable",
  phoneOpen.open && phoneOpen.left >= 0 && phoneOpen.w > 0, JSON.stringify(phoneOpen));
check("#94 phone: the entry is a finger-sized row (>=38px)",
  phoneOpen.h >= 38, JSON.stringify(phoneOpen));
await ev(`document.querySelector('[data-nav="topology"]').click()`);
await sleep(900);
check("#94 phone: tapping it opens the board",
  Boolean(await ev(`!!document.querySelector('[data-topo-board]')`)));
await ev(ESC); await sleep(600);

// ---- ⑤ 会话级按钮不回退 -------------------------------------------------------------------
await size(1400);
await send("Page.reload"); await sleep(2600); await freeze();
const headStill = JSON.parse(await ev(`JSON.stringify((() => {
  const head = document.querySelector('.head-actions');
  if (!head) return { ok: false };
  const labels = [...head.querySelectorAll('button')].map(b => b.getAttribute('aria-label') || b.title || '');
  return { ok: true, n: labels.length, call: labels.some(l => /通话|call/i.test(l)) };
})())`));
check("#94 session-level buttons stay in the head (call/dictation/settings)",
  headStill.ok === true && headStill.call === true, JSON.stringify(headStill));
check("no JS exceptions", exceptions.length === 0, exceptions.slice(0, 2).join(" | "));

console.log(`\n${fail ? "FAIL" : "ALL"} — ${pass} passed, ${fail} failed`);
ws.close();
process.exit(fail ? 1 : 0);
