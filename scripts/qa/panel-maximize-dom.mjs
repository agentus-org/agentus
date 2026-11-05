// 工作空间面板的「最大化 / 还原」（issue #91）。
//
// 操作者的原话：在 IDE / 终端里干活时 760px 不够用，但会话列表还要留着切会话。所以「最大化」不是
// 全屏 —— 右侧面板占满 main-body，左侧 rail 一动不变。
//
// 这里钉的是七条会「看着能点、其实坏」的地方：
//   ① 按钮存在，点它面板占满右侧区域；rail 宽度不变、仍然可点。
//   ② 聊天列 display:none 而**没有卸载**：草稿、滚动位置都还在（还原后立刻检查）。
//   ③ 还原回到放大前的宽度 —— 不是 760 默认值，也不是全宽（放大期间 --panel-w 不动）。
//   ④ 放大态没有可拖的左手柄；窗口 resize 后面板**不会自己缩回**带 MIN_CHAT 保底的宽度。
//   ⑤ 放大态下上下分屏照常（两行都变宽，divider 还在两行之间）。
//   ⑥ 放大态点 × 关面板 → 标记清掉，重开是原宽度而不是全宽。
//   ⑦ <721px 不出现该按钮（手机上它本来就是全屏 sheet）。
//
//   AGENTUS_BASE=http://127.0.0.1:8901 CDP_URL=http://127.0.0.1:9223 node scripts/qa/panel-maximize-dom.mjs
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
const viewport = async (width, height = 900) =>
  send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width <= 720 });

await goto(BASE);
const status = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({username:${JSON.stringify(USER)},password:${JSON.stringify(PASS)}})}).then(r=>r.status)`);
check("logged in", status === 200, `status ${status}`);
await viewport(1400);
await ev(`(() => { localStorage.removeItem('agentus.panel-maximized'); localStorage.removeItem('agentus.panel-width'); return true; })()`);
await goto(BASE);
await ev(`(() => { const row = document.querySelector('.session-item'); if (row) row.click(); return Boolean(row); })()`);
await sleep(2000);

const MAX = `[aria-label="maximize the panel"]`;
const layout = async () => JSON.parse(await ev(`(() => {
  const body = document.querySelector('.main-body').getBoundingClientRect();
  const rail = document.querySelector('.sidebar, .rail')?.getBoundingClientRect();
  const panel = document.querySelector('.tool-panel')?.getBoundingClientRect();
  const chat = document.querySelector('.chat-col');
  const chatRect = chat?.getBoundingClientRect();
  return JSON.stringify({
    bodyW: Math.round(body.width),
    railW: rail ? Math.round(rail.width) : null,
    panelW: panel ? Math.round(panel.width) : null,
    panelRight: panel ? Math.round(panel.right) : null,
    bodyRight: Math.round(body.right),
    chatDisplay: chat ? getComputedStyle(chat).display : null,
    chatVisibility: chat ? getComputedStyle(chat).visibility : null,
    chatInDom: Boolean(chat),
    chatW: chatRect ? Math.round(chatRect.width) : null,
    handle: (() => { const h = document.querySelector('.tool-panel > .pane-handle');
      return h ? getComputedStyle(h).display : null; })(),
    stored: localStorage.getItem('agentus.panel-width'),
    maxFlag: localStorage.getItem('agentus.panel-maximized'),
    pressed: document.querySelector('${MAX}')?.getAttribute('aria-pressed') ?? null,
  });
})()`));

// 打开面板（宽窗下的 📁 按钮）
// 面板是懒加载的：点完不能只数两秒，没挂上来的时候下面会一口气假红十几条。
const waitPanel = async () => {
  for (let i = 0; i < 40; i++) {
    if (await ev(`!!document.querySelector('.tool-panel')`)) return true;
    await sleep(150);
  }
  return false;
};
await ev(`(() => { const b = document.querySelector('.chat-head button[aria-label="file browser"]');
  if (b && !document.querySelector('.tool-panel')) b.click(); return true; })()`);
await waitPanel();
await sleep(400);
const before = await layout();
check("宽窗面板 tab 栏有「最大化」按钮", before.pressed !== null, JSON.stringify({ pressed: before.pressed }));
check("起始不是放大态（pressed=false，聊天列可见）",
  before.pressed === "false" && before.chatDisplay !== "none", JSON.stringify({ pressed: before.pressed, chat: before.chatDisplay }));

// ---- ③ 先手动设一个可识别的宽度，验证还原回到的是它 ----------------------------------------
await ev(`localStorage.setItem('agentus.panel-width', '620'); true`);
await goto(BASE);
await ev(`(() => { const b = document.querySelector('.chat-head button[aria-label="file browser"]'); if (b) b.click(); return true; })()`);
await waitPanel();
await sleep(400);
const start = await layout();
check("面板用了操作者自己的宽度（620）", Math.abs((start.panelW ?? 0) - 620) <= 2, String(start.panelW));

// ---- ② 放大前留下「状态」：草稿 + 滚动位置 -------------------------------------------------
await ev(`(() => { const ta = document.querySelector('.composer textarea, .composer-input textarea, textarea.composer-input');
  if (!ta) return false; ta.focus(); return true; })()`);
/* React keeps the composer's text in state, so assigning `.value` is overwritten by the next render.
   The native setter + a bubbling `input` event is the way to type into a controlled input from
   outside; without it this test would "pass" only because nothing re-rendered. */
const draftOk = await ev(`(() => { const ta = document.querySelector('textarea'); if (!ta) return false;
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  set.call(ta, '这是放大前写的草稿');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return true; })()`);
check("能在输入框写下草稿（放大前后的对照）", draftOk === true);
const scrollBefore = await ev(`(() => { const s = document.querySelector('.stream'); if (!s) return null;
  s.scrollTop = Math.max(0, Math.round(s.scrollHeight * 0.6)); return Math.round(s.scrollTop); })()`);

// ---- ① 放大 --------------------------------------------------------------------------------
await ev(`document.querySelector('${MAX}').click(); true`);
await sleep(1200);
const max = await layout();
check("放大后面板占满右侧区域（右缘与 main-body 右缘对齐）",
  Math.abs((max.panelRight ?? -1) - max.bodyRight) <= 1 && (max.panelW ?? 0) > (start.panelW ?? 0),
  JSON.stringify({ panel: max.panelW, right: max.panelRight, bodyRight: max.bodyRight }));
check("…左侧会话列表宽度不变（rail 保留）", max.railW === before.railW, `${max.railW} vs ${before.railW}`);
check("…会话列表仍然可点（rail 里还有会话行）",
  (await ev(`document.querySelectorAll('.session-list .session-item').length`)) > 0);
check("…聊天列不可见但没有卸载，也没有丢掉自己的盒子（否则滚动位置会被「贴底」逻辑吃掉）",
  max.chatVisibility === "hidden" && max.chatInDom === true && (max.chatW ?? 0) > 0,
  JSON.stringify({ v: max.chatVisibility, dom: max.chatInDom, w: max.chatW }));
check("…按钮变成「还原」态（aria-pressed=true 且有 on）",
  max.pressed === "true" && (await ev(`document.querySelector('${MAX}').classList.contains('on')`)) === true, String(max.pressed));
check("…放大期间不写 --panel-w（存储里还是 620）", max.stored === "620", String(max.stored));
check("…左手拖拽手柄消失（没有可拖的宽度）", max.handle === "none", String(max.handle));
check("…放大标记已持久化", max.maxFlag === "1", String(max.maxFlag));

// ---- ④ 窗口 resize 后面板保持全宽 ----------------------------------------------------------
await viewport(1200);
await sleep(800);
const resized = await layout();
check("窗口变窄到 1200 后面板仍是全宽（不会缩回 MIN_CHAT 保底的宽度）",
  Math.abs((resized.panelRight ?? -1) - resized.bodyRight) <= 1 && (resized.panelW ?? 0) > 700,
  JSON.stringify({ panel: resized.panelW, right: resized.panelRight, bodyRight: resized.bodyRight }));
await viewport(1400);

// ---- ⑤ 放大态下分屏照常 --------------------------------------------------------------------
await ev(`[...document.querySelectorAll('.tool-tab')].find(t=>/^terminal/.test(t.textContent.trim())).click(); true`);
await sleep(1000);
await ev(`(() => { const b = document.querySelector('.pane-picker [aria-label="put ide below"]'); if (b) b.click(); return Boolean(b); })()`);
await sleep(1800);
const rows = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('.panel-stack .stack-pane:not([hidden])')]
  .map(p => ({ pane: p.dataset.pane, w: Math.round(p.getBoundingClientRect().width), top: Math.round(p.getBoundingClientRect().top) }))
  .sort((a,b)=>a.top-b.top))`));
check("放大态下上下分屏照常（两行都在，且都变宽到面板宽度）",
  rows.length === 2 && rows.every((r) => Math.abs(r.w - (max.panelW ?? 0)) <= 2),
  JSON.stringify(rows.map((r) => `${r.pane}:${r.w}`)));
check("…divider 仍在两行之间", (await ev(`Boolean(document.querySelector('.row-divider'))`)) === true);
// 收起分屏，回到单 pane，避免影响后面的宽度断言
await ev(`(() => { const b = document.querySelector('[aria-label="toggle the vertical split"]'); if (b) b.click(); return Boolean(b); })()`);
await sleep(800);

// ---- ③ 还原 ---------------------------------------------------------------------------------
await ev(`document.querySelector('${MAX}').click(); true`);
await sleep(1200);
const restored = await layout();
check("还原回放大前的宽度（620，不是 760 也不是全宽）",
  Math.abs((restored.panelW ?? 0) - 620) <= 2, String(restored.panelW));
check("…聊天列回来了（重新可见）", restored.chatVisibility === "visible", String(restored.chatVisibility));
check("…左手柄回来了（可以继续拖宽度）", restored.handle !== "none", String(restored.handle));
check("…放大标记清掉", restored.maxFlag === "0", String(restored.maxFlag));

// ---- ② 草稿与滚动位置没丢 ------------------------------------------------------------------
const draftNow = await ev(`(() => { const ta = document.querySelector('textarea'); return ta ? ta.value : null; })()`);
check("还原后草稿还在（聊天列没有被卸载）", draftNow === "这是放大前写的草稿", JSON.stringify(draftNow));
if (scrollBefore != null) {
  const scrollAfter = await ev(`(() => { const s = document.querySelector('.stream'); return s ? Math.round(s.scrollTop) : null; })()`);
  check("…滚动位置也还在", Math.abs((scrollAfter ?? 0) - scrollBefore) <= 4, `${scrollBefore} → ${scrollAfter}`);
}

// ---- ⑥ 放大态点 × 关面板 → 重开是原宽度 ----------------------------------------------------
await ev(`document.querySelector('${MAX}').click(); true`);
await sleep(1000);
check("再次放大", (await layout()).pressed === "true");
await ev(`document.querySelector('.tool-panel [aria-label="close panel"]').click(); true`);
await sleep(1000);
check("放大态点 × 关面板会清掉放大标记", (await ev(`localStorage.getItem('agentus.panel-maximized')`)) === "0");
await ev(`(() => { const b = document.querySelector('.chat-head button[aria-label="file browser"]'); if (b) b.click(); return true; })()`);
await sleep(1500);
const reopened = await layout();
check("重开面板是原来的宽度，不是全宽",
  Math.abs((reopened.panelW ?? 0) - 620) <= 2 && reopened.pressed === "false",
  JSON.stringify({ w: reopened.panelW, pressed: reopened.pressed }));

// ---- ⑦ 手机不出现该按钮 --------------------------------------------------------------------
await viewport(700);
// Poll rather than sleep a fixed time: the button's presence follows `useWide()`, which updates on
// the resize event, and one run raced it (the assertion is "it must not be there", not "it must be
// gone within 900 ms").
let phoneBtn = -1;
for (let i = 0; i < 12; i++) {
  await sleep(250);
  phoneBtn = await ev(`document.querySelectorAll('${MAX}').length`);
  if (phoneBtn === 0) break;
}
check("手机宽度下没有「最大化」按钮（那时它已经是全屏 sheet）", phoneBtn === 0, String(phoneBtn));
await viewport(1400);

// ---- 持久化：放大态刷新后仍然放大 ----------------------------------------------------------
await ev(`localStorage.setItem('agentus.panel-maximized', '1'); true`);
await goto(BASE);
await ev(`(() => { const b = document.querySelector('.chat-head button[aria-label="file browser"]'); if (b) b.click(); return true; })()`);
await sleep(1800);
const afterReload = await layout();
check("刷新后放大态保持（面板打开即全宽）",
  afterReload.pressed === "true" && Math.abs((afterReload.panelRight ?? -1) - afterReload.bodyRight) <= 1,
  JSON.stringify({ pressed: afterReload.pressed, w: afterReload.panelW }));
await ev(`localStorage.setItem('agentus.panel-maximized', '0'); true`);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
await send("Page.close").catch(() => {});
ws.close();
process.exit(fail === 0 ? 0 : 1);
