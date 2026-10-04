// QA: the session rail (one-line rows, agent avatars, inline rename, per-session menu).
// Drives the user's Edge over raw CDP against the scratch instance on :8901.
//   node m_rail_qa.mjs
const CDP = "http://127.0.0.1:9222";
const BASE = process.env.BASE ?? "http://127.0.0.1:8901";   // scratch instance (launch_scratch.py)
const U = process.env.QA_USER ?? "scratch", P = process.env.QA_PASS ?? "scratch-pass-1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.SHOTS ?? new URL("../../../../tasks/20261001-agentslot/screens", import.meta.url).pathname;
const fs = await import("node:fs");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const t = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(2600);
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const w = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && w.has(m.id)) { const x = w.get(m.id); w.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); } };
const send = (m, p = {}, to = 25000) => new Promise((res, rej) => {
  const mid = ++id; const timer = setTimeout(() => { w.delete(mid); rej(new Error("TIMEOUT " + m)); }, to);
  w.set(mid, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method: m, params: p }));
});
const ev = async (x, to = 25000) => {
  const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }, to);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};
const setViewport = async (W, H) => {
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: W < 700 });
  await send("Emulation.setTouchEmulationEnabled", { enabled: W < 700, maxTouchPoints: 5 }).catch(() => {});
  await sleep(400);
};
await send("Page.enable"); await send("Runtime.enable");

// --- login + a few sessions so the rail has rows
await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
await ev(`Promise.all([0,1,2].map((i)=>fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({backend:'mock',cwd:i%2?'/tmp':'/Users/liang'})}).then(r=>r.json())))`);
await send("Page.reload", { ignoreCache: true });
await sleep(3200);

await setViewport(1440, 900);
const rail = await ev(`(() => {
  const rows = [...document.querySelectorAll('.session-item')];
  return {
    rows: rows.length,
    titles: rows.filter((r) => r.querySelector('.title')).length,
    metas: document.querySelectorAll('.session-item .meta').length,
    heights: rows.map((r) => Math.round(r.getBoundingClientRect().height)),
    avatars: rows.map((r) => r.querySelector('.be-avatar')?.dataset.backend ?? null),
    letters: [...document.querySelectorAll('.session-item .be-avatar')].map((a) => a.dataset.letter ?? a.textContent.trim()),
    menuButtons: document.querySelectorAll('.row-menu').length,
  };
})()`);
check("every session row renders exactly one title line", rail.titles === rail.rows && rail.rows > 0, JSON.stringify({ rows: rail.rows, titles: rail.titles }));
check("the two-line metadata block is gone from the rows", rail.metas === 0, `metas=${rail.metas}`);
check("a row is one line tall (<= 36px)", Math.max(...rail.heights) <= 36, `heights=${JSON.stringify(rail.heights)}`);
check("every row carries an agent avatar with its backend", rail.avatars.length === rail.rows && rail.avatars.every(Boolean), JSON.stringify(rail.avatars));
check("avatar shows the backend's monogram", rail.letters.every((l) => ["H", "Q", "M"].includes(l)), JSON.stringify(rail.letters));
const brand = await ev(`(() => { const imgs=[...document.querySelectorAll('.be-avatar img')];
  return { n: imgs.length, complete: imgs.every((i)=>i.complete && i.naturalWidth>0),
    src: imgs.map((i)=>i.getAttribute('src')) }; })()`);
check("every live row shows its brand icon (or a monogram fallback), and it actually loaded",
  brand.n === 0 || brand.complete, JSON.stringify(brand));
const assets = await ev(`(async () => { const r = {};
  for (const p of ['/coding-agents/hermes.png', '/coding-agents/qoder.svg']) {
    const resp = await fetch(p); r[p] = resp.status + ' ' + (resp.headers.get('content-type') || '');
  } return r; })()`);
check("both brand icons are served", Object.values(assets).every((s) => s.startsWith("200")), JSON.stringify(assets));
check("every row has a settings (⋯) button", rail.menuButtons === rail.rows, `buttons=${rail.menuButtons}`);

// --- the chat header carries the auto-read switch, LEFT of the folder/panel pair
const headToggle = await ev(`(() => {
  const head = document.querySelector('.chat-head');
  const btn = head?.querySelector('.icon-btn.auto-read');
  if (!btn) return { present: false };
  const folder = head.querySelector('button[aria-label="workspace"]');
  const panel = head.querySelector('button[aria-label="workspace panel"]');
  const r = btn.getBoundingClientRect(), f = folder?.getBoundingClientRect(), p = panel?.getBoundingClientRect();
  return { present: true, pressed: btn.getAttribute('aria-pressed'), title: btn.getAttribute('title'),
    offClass: !btn.className.includes('on'), disabled: btn.disabled,
    leftOfFolder: !!f && r.right <= f.left + 1, leftOfPanel: !!p && r.right <= p.left + 1,
    order: [...head.querySelectorAll('.icon-btn')].map((b) => b.getAttribute('aria-label')),
    w: Math.round(r.width), h: Math.round(r.height) };
})()`);
check("the chat header has the auto-read switch", headToggle.present === true, JSON.stringify(headToggle));
check("it sits LEFT of the folder and panel buttons", headToggle.leftOfFolder && headToggle.leftOfPanel, JSON.stringify(headToggle.order));
check("it reports its state (aria-pressed, off by default) and can speak on this machine",
  headToggle.pressed === "false" && headToggle.disabled === false, JSON.stringify({ pressed: headToggle.pressed, disabled: headToggle.disabled }));

const toggled = await ev(`(async () => {
  const btn = document.querySelector('.chat-head .icon-btn.auto-read');
  const before = JSON.parse(localStorage.getItem('agentslot.voice') || '{}').autoRead;
  const iconBefore = btn.innerHTML;
  btn.click();
  await new Promise((r) => setTimeout(r, 300));
  const mid = { pressed: btn.getAttribute('aria-pressed'), cls: btn.className.includes('on'),
    stored: JSON.parse(localStorage.getItem('agentslot.voice') || '{}').autoRead, title: btn.getAttribute('title'),
    iconChanged: btn.innerHTML !== iconBefore };
  btn.click();                                   // leave the pref where we found it
  await new Promise((r) => setTimeout(r, 300));
  const after = JSON.parse(localStorage.getItem('agentslot.voice') || '{}').autoRead;
  return { before, mid, after, pressedNow: btn.getAttribute('aria-pressed') };
})()`);
check("clicking it turns auto-read ON, visibly and in storage",
  toggled.mid.pressed === "true" && toggled.mid.cls === true && toggled.mid.stored === true,
  JSON.stringify(toggled.mid));
check("the icon and the title change with the state (not just a colour)",
  toggled.mid.iconChanged === true && /自动朗读：开/.test(toggled.mid.title || ""), JSON.stringify({ icon: toggled.mid.iconChanged, title: toggled.mid.title }));
check("clicking again turns it OFF and the pref is back where it started",
  toggled.pressedNow === "false" && toggled.after === (toggled.before ?? false), JSON.stringify({ before: toggled.before, after: toggled.after }));

// --- ⋯ opens the menu, and it lands INSIDE the viewport (geometry, not presence)
await ev(`document.querySelector('.session-item .row-menu').click()`);
await sleep(500);
const menu = await ev(`(() => {
  const m = document.querySelector('.sess-menu');
  if (!m) return { open: false };
  const r = m.getBoundingClientRect();
  return {
    open: true, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    inside: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
    offsetParentIsBody: m.offsetParent === document.body,
    items: [...m.querySelectorAll('.sess-menu-item')].map((b) => b.textContent.trim()),
    head: m.querySelector('.sess-menu-head .be-avatar')?.dataset.backend ?? null,
  };
})()`);
check("the ⋯ button opens the per-session menu", menu.open === true);
check("the menu is inside the viewport", Boolean(menu.inside), JSON.stringify({ x: menu.x, y: menu.y, w: menu.w, h: menu.h }));
check("the menu shows which session it belongs to", Boolean(menu.head), `avatar=${menu.head}`);
check("the menu carries rename/fork/workspace/export/id/archive",
  ["重命名", "工作目录…", "导出会话（Markdown）", "复制会话 ID"].every((n) => menu.items.includes(n))
  && menu.items.some((i) => i.includes("fork")) && menu.items.some((i) => i.includes("归档会话")),
  JSON.stringify(menu.items));
check("the menu hugs its content (no wide-plank floor; head row is its widest line)",
  menu.w <= 320 && menu.w >= 150, `w=${menu.w}`);
// the reported bug: the menu must follow the ROW it belongs to, not sit in a screen corner
const anchored = await ev(`(() => {
  const row = document.querySelector('.session-item');
  const rb = row.getBoundingClientRect();
  const m = document.querySelector('.sess-menu');
  const mr = m.getBoundingClientRect();
  return { rowBottom: Math.round(rb.bottom), rowLeft: Math.round(rb.left), rowRight: Math.round(rb.right),
    menuTop: Math.round(mr.top), menuLeft: Math.round(mr.left), menuRight: Math.round(mr.right),
    vh: innerHeight, vw: innerWidth };
})()`);
check("the menu is anchored to its own row (not the screen corner)",
  Math.abs(anchored.menuTop - anchored.rowBottom) <= 150
  && anchored.menuLeft >= anchored.rowLeft - 20 && anchored.menuLeft <= anchored.rowRight,
  JSON.stringify(anchored));

// --- right-click opens the same menu at the pointer
await ev(`(() => { const r = document.querySelectorAll('.session-item')[1]; const b = r.getBoundingClientRect();
  r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: b.left + 40, clientY: b.top + 10 })); return true; })()`);
await sleep(400);
const ctx = await ev(`(() => { const m = document.querySelector('.sess-menu'); if (!m) return null; const r = m.getBoundingClientRect();
  return { inside: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, y: Math.round(r.y) }; })()`);
check("right-click opens it too, clamped inside the viewport", ctx && ctx.inside, JSON.stringify(ctx));

// --- rename, in place
const before = await ev(`document.querySelectorAll('.session-item')[1].querySelector('.title').textContent`);
await ev(`(() => { const rows=[...document.querySelectorAll('.session-item')]; const m=document.querySelector('.sess-menu');
  void m; const btn=[...m.querySelectorAll('.sess-menu-item')].find((b)=>b.textContent.trim()==='重命名'); btn.click(); return true; })()`);
await sleep(400);
const editing = await ev(`(() => { const i=document.querySelector('.title-input'); return { present: !!i, focused: document.activeElement === i, value: i?.value ?? null }; })()`);
check("rename turns the row into a focused input seeded with the name", editing.present && editing.focused, JSON.stringify(editing));
await ev(`(() => { const i=document.querySelector('.title-input');
  const set=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i),'value').set; set.call(i,'重构 · 会话列表'); i.dispatchEvent(new Event('input',{bubbles:true}));
  i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return true; })()`);
await sleep(1200);
const renamed = await ev(`(async () => { const t=[...document.querySelectorAll('.session-item .title')].map((x)=>x.textContent);
  const api=await fetch('/api/sessions').then(r=>r.json());
  const titles=[...api.live,...api.archived].map((s)=>s.title);
  return { dom: t, api: titles.filter((x)=>x.includes('重构')), input: !!document.querySelector('.title-input') }; })()`);
check("the new name lands in the row", renamed.dom.includes("重构 · 会话列表"), JSON.stringify(renamed.dom.slice(0, 4)));
check("the new name is persisted (server agrees)", renamed.api.length === 1, JSON.stringify(renamed.api));
check("the input closes when the rename is committed", renamed.input === false);

// --- clearing it goes back to the generated name
await ev(`(async () => { const api=await fetch('/api/sessions').then(r=>r.json());
  const s=[...api.live,...api.archived].find((x)=>x.title==='重构 · 会话列表');
  await fetch('/api/sessions/'+s.id+'/rename',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:''})});
  return true; })()`);
await sleep(3000);
const cleared = await ev(`[...document.querySelectorAll('.session-item .title')].map((x)=>x.textContent)`);
check("clearing a rename falls back to the generated name", cleared.some((t) => t.includes("Mock Agent")) && !cleared.includes("重构 · 会话列表"), JSON.stringify(cleared.slice(0, 4)));

const shot1 = await send("Page.captureScreenshot", { format: "png" }, 25000);
fs.writeFileSync(`${SHOTS}/desktop-rail-oneline.png`, Buffer.from(shot1.data, "base64"));

// --- phone: the same menu becomes a bottom sheet, opened by LONG PRESS
await setViewport(390, 844);
await ev(`document.querySelectorAll('.session-item')[0].scrollIntoView({ block: 'center' })`);
await sleep(300);
const longPress = await ev(`(() => {
  const row = document.querySelectorAll('.session-item')[0];
  const b = row.getBoundingClientRect();
  const x = b.left + b.width / 2, y = b.top + b.height / 2;
  const mk = (type) => { const e = new Event(type, { bubbles: true }); e.touches = [{ clientX: x, clientY: y }]; e.changedTouches = e.touches; return e; };
  row.dispatchEvent(mk('touchstart'));
  return { x, y };
})()`);
await sleep(700);   // > the 500ms hold
const sheet = await ev(`(() => { const m=document.querySelector('.sess-menu'); if(!m) return { open:false };
  const r=m.getBoundingClientRect();
  return { open:true, x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width), h:Math.round(r.height),
    inside: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
    itemHeight: Math.round(m.querySelector('.sess-menu-item').getBoundingClientRect().height) }; })()`);
check("a 500ms long-press on a row opens the menu on a phone", sheet.open === true, JSON.stringify(longPress));
check("on a phone the menu is laid out as a sheet inside the viewport", Boolean(sheet.inside), JSON.stringify(sheet));
check("the phone menu has thumb-sized rows (>= 34px)", (sheet.itemHeight ?? 0) >= 34, `itemHeight=${sheet.itemHeight}`);
// regression guard: with `width:max-content` on the base rule, the sheet shrank to its
// content and pinned itself to the bottom-LEFT corner ("不跟会话" — operator report).
const sheetW = await ev(`(() => { const m=document.querySelector('.sess-menu'); const r=m.getBoundingClientRect();
  return { w: Math.round(r.width), x: Math.round(r.x), vw: innerWidth, bottom: Math.round(r.bottom), vh: innerHeight }; })()`);
check("the phone sheet stretches across the screen (no content-width left-hug)",
  sheetW.w >= sheetW.vw - 24 && sheetW.x <= 12, JSON.stringify(sheetW));
const phoneHead = await ev(`(() => { const b = document.querySelector('.chat-head .icon-btn.auto-read');
  if (!b) return null; const r = b.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), vw: innerWidth }; })()`);
check("the header switch is thumb-sized on a phone too",
  !!phoneHead && phoneHead.w >= 28 && phoneHead.h >= 28 && phoneHead.right <= phoneHead.vw,
  JSON.stringify(phoneHead));
await ev(`document.querySelectorAll('.session-item')[0].dispatchEvent((() => { const e=new Event('touchend',{bubbles:true}); e.changedTouches=[{clientX:0,clientY:0}]; return e; })())`);
const shot2 = await send("Page.captureScreenshot", { format: "png" }, 25000);
fs.writeFileSync(`${SHOTS}/phone-session-menu.png`, Buffer.from(shot2.data, "base64"));

// --- a long press must not also switch the session
await ev(`document.querySelector('.sess-menu') && document.body.click()`);   // dismiss
await sleep(300);
const activeBefore = await ev(`document.querySelector('.session-item.active')?.dataset.session ?? null`);
await ev(`(() => {
  // press row #2 and only then let the click through (what a phone does after a long hold)
  const row = document.querySelectorAll('.session-item')[2];
  const b = row.getBoundingClientRect();
  const mk = (type) => { const e = new Event(type, { bubbles: true }); e.touches=[{clientX:b.left+5,clientY:b.top+5}]; e.changedTouches=e.touches; return e; };
  row.dispatchEvent(mk('touchstart'));
  window.__row2 = row;
  return true; })()`);
await sleep(700);
await ev(`(() => { const row = window.__row2; row.click(); return true; })()`);
await sleep(600);
const activeAfter = await ev(`document.querySelector('.session-item.active')?.dataset.session ?? null;`);
check("the click that follows a long press does not switch sessions", activeAfter === activeBefore, `before=${activeBefore} after=${activeAfter}`);

console.log(`\n${pass} passed, ${fail} failed`);
console.log("shots: desktop-rail-oneline.png, phone-session-menu.png");
await fetch(`${CDP}/json/close/${t.id}`).catch(() => {});
process.exit(fail ? 1 : 0);
