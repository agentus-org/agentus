// QA: the session rail (one-line rows, agent avatars, inline rename, per-session menu).
// Drives the user's Edge over raw CDP against the scratch instance on :8901.
//   node m_rail_qa.mjs
const CDP = "http://127.0.0.1:9222";
const BASE = process.env.BASE ?? "http://127.0.0.1:8901";   // scratch instance (launch_scratch.py)
const U = process.env.QA_USER ?? "scratch", P = process.env.QA_PASS ?? "scratch-pass-1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.SHOTS ?? new URL("../../../../tasks/20261001-agentus/screens", import.meta.url).pathname;
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

// --- 前置条件自己建立，别指望上一轮留下什么（2026-10-07 实测的假红）
// 这一轮的两个"默认值"断言会被残留状态污染，产生与代码无关的 FAIL：
//   · auto-read 开关的初始态来自服务端 prefs（上几轮点过之后 autoRead=true）→ 断言 OFF 必红
//   · 浏览器 localStorage（本 origin 的 agentus.voice）同理
//   · 重命名阶段断言「全库只有一条『重构 · 会话列表』」，上一轮没清干净就会红
// 所以：先把 prefs 归零、把浏览器那个键删掉、把残留的重命名行清掉。测的是代码，不是环境。
const PREP = await ev(`(async () => {
  localStorage.removeItem('agentus.voice');
  // A previous run may have left a rail SECTION folded (it is a persisted preference now), which
  // would make the rail assertions below read an empty rail. Start from the default layout.
  localStorage.removeItem('agentus.railSections');
  const st = await fetch('/api/settings',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({prefs:{autoRead:false}})}).then(r=>r.status);
  const list = await fetch('/api/sessions').then(r=>r.json());
  const stale = [...(list.live||[]),...(list.archived||[])].filter((s)=>s.title==='重构 · 会话列表');
  for (const s of stale) await fetch('/api/sessions/'+s.id+'/rename',{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify({title:''})});
  return { settings: st, clearedStale: stale.length };
})()`).catch((e) => ({ error: String(e) }));
console.log("prep:", JSON.stringify(PREP));
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

// --- the rail reads as two sections, and 团队 is an honest placeholder -------------------
// 团队 is deliberately not implemented: the assertions below pin the two things that would make
// it a lie — a row that can be clicked/keyboard-focused, or one that does not say what it is.
const sections = await ev(`(() => {
  const labels = [...document.querySelectorAll('.rail-section')].map((e) => ({ text: e.textContent.trim(), y: Math.round(e.getBoundingClientRect().top) }));
  const team = document.querySelector('[data-placeholder="team"]');
  const r = team?.getBoundingClientRect();
  const g = document.querySelector('.rail-group')?.getBoundingClientRect();
  return {
    labels,
    tag: team?.tagName ?? null,
    ariaDisabled: team?.getAttribute('aria-disabled') ?? null,
    focusables: team ? team.querySelectorAll('button, a, input, select, textarea, [tabindex]').length : -1,
    text: team?.textContent?.trim() ?? '',
    teamY: r ? Math.round(r.top) : null,
    groupsTop: g ? Math.round(g.top) : null,
    inside: r ? r.left >= 0 && r.right <= window.innerWidth : false,
  };
})()`);
check("the rail names two sections, 团队 above 工作空间",
  sections.labels.length === 2 && sections.labels[0].text === "团队" && sections.labels[1].text === "工作空间" && sections.labels[0].y < sections.labels[1].y,
  JSON.stringify(sections.labels));
check("团队 sits above the first workspace",
  sections.teamY !== null && (sections.groupsTop === null || sections.teamY < sections.groupsTop),
  JSON.stringify({ teamY: sections.teamY, groupsTop: sections.groupsTop }));
check("the 团队 row is inert and says so (a div, nothing focusable, aria-disabled)",
  sections.tag === "DIV" && sections.focusables === 0 && sections.ariaDisabled === "true" && sections.text.includes("还没做") && sections.inside,
  JSON.stringify(sections));

// --- both sections FOLD (the operator asked for it after comparing the two rails) --------------
// What has to hold: the head IS the control (a real button, aria-expanded), folding really empties
// the section, the choice survives a reload (a layout preference, stored per browser), and a search
// always opens it again — a match the operator cannot see is not a match.
const snapshot = `(() => {
  const expanded = Object.fromEntries([...document.querySelectorAll('.rail-section')].map((e) => [e.dataset.section, e.getAttribute('aria-expanded')]));
  return {
    expanded,
    tag: document.querySelector('.rail-section')?.tagName ?? null,
    groups: document.querySelectorAll('.rail-group').length,
    rows: document.querySelectorAll('.session-item').length,
    placeholder: !!document.querySelector('[data-placeholder="team"]'),
    stored: JSON.parse(localStorage.getItem('agentus.railSections') || '{}'),
  };
})()`;
const foldBefore = await ev(snapshot);
const foldAfter = await ev(`(async () => {
  document.querySelector('.rail-section[data-section="workspaces"]').click();
  await new Promise((r) => setTimeout(r, 300));
  return ${snapshot};
})()`);
check("both section heads are fold controls (a button that reports aria-expanded)",
  foldBefore.tag === "BUTTON" && foldBefore.expanded.team === "true" && foldBefore.expanded.workspaces === "true",
  JSON.stringify({ tag: foldBefore.tag, expanded: foldBefore.expanded }));
check("folding 工作空间 really empties it (groups gone, the choice stored)",
  foldAfter.groups === 0 && foldAfter.rows === 0 && foldAfter.expanded.workspaces === "false" && foldAfter.stored.workspaces === true,
  JSON.stringify({ groups: foldAfter.groups, rows: foldAfter.rows, stored: foldAfter.stored }));

await send("Page.reload", { ignoreCache: true });
await sleep(3200);
const foldReload = await ev(snapshot);
check("the fold survives a reload (a preference, not a transient)",
  foldReload.expanded.workspaces === "false" && foldReload.groups === 0 && foldReload.rows === 0,
  JSON.stringify(foldReload));

const foldSearch = await ev(`(async () => {
  const input = document.querySelector('.rail-search');
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  const type = (v) => { set.call(input, v); input.dispatchEvent(new Event('input', { bubbles: true })); };
  type('mock');
  await new Promise((r) => setTimeout(r, 400));
  const searching = { groups: document.querySelectorAll('.rail-group').length, rows: document.querySelectorAll('.session-item').length,
    expanded: document.querySelector('.rail-section[data-section="workspaces"]').getAttribute('aria-expanded'),
    stored: JSON.parse(localStorage.getItem('agentus.railSections') || '{}') };
  type('');
  await new Promise((r) => setTimeout(r, 300));
  // put the rail back the way the rest of this sweep expects to find it
  document.querySelector('.rail-section[data-section="workspaces"]').click();
  await new Promise((r) => setTimeout(r, 300));
  const restored = { groups: document.querySelectorAll('.rail-group').length,
    expanded: document.querySelector('.rail-section[data-section="workspaces"]').getAttribute('aria-expanded') };
  // and prove the 团队 section folds too, then leave it open
  document.querySelector('.rail-section[data-section="team"]').click();
  await new Promise((r) => setTimeout(r, 250));
  const teamFolded = { placeholder: !!document.querySelector('[data-placeholder="team"]'),
    expanded: document.querySelector('.rail-section[data-section="team"]').getAttribute('aria-expanded') };
  document.querySelector('.rail-section[data-section="team"]').click();
  await new Promise((r) => setTimeout(r, 250));
  return { searching, restored, teamFolded, teamBack: !!document.querySelector('[data-placeholder="team"]') };
})()`);
check("a search opens a folded section (and does not overwrite the preference)",
  foldSearch.searching.groups > 0 && foldSearch.searching.rows > 0 && foldSearch.searching.expanded === "true"
    && foldSearch.searching.stored.workspaces === true,
  JSON.stringify(foldSearch.searching));
check("unfolding restores the rail for the rest of the sweep", foldSearch.restored.groups > 0 && foldSearch.restored.expanded === "true",
  JSON.stringify(foldSearch.restored));
check("团队 folds too — its placeholder row goes away and comes back",
  foldSearch.teamFolded.placeholder === false && foldSearch.teamFolded.expanded === "false" && foldSearch.teamBack === true,
  JSON.stringify(foldSearch.teamFolded));

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

// --- the head's action cluster: phone + auto-read + workspace + panel, one tight strip
const cluster = await ev(`(() => {
  const head = document.querySelector('.chat-head');
  const group = head?.querySelector('.head-actions');
  if (!group) return { present: false };
  const btns = [...group.querySelectorAll('.icon-btn')];
  const rects = btns.map((b) => b.getBoundingClientRect());
  const gaps = rects.slice(1).map((r, i) => Math.round(r.left - rects[i].right));
  // what the EYE spaces is the glyphs, not the boxes: measure icon edge to icon edge
  const glyphs = btns.map((b) => (b.querySelector('svg') ?? b).getBoundingClientRect());
  const glyphGaps = glyphs.slice(1).map((r, i) => Math.round(r.left - glyphs[i].right));
  const glyphW = Math.round(glyphs[0].width);
  const phone = group.querySelector('button[aria-label="开始语音通话"]');
  const sr = phone?.getBoundingClientRect();
  return {
    present: true,
    labels: btns.map((b) => b.getAttribute("aria-label")),
    gapCss: getComputedStyle(group).gap,
    gaps, glyphGaps, glyphW, boxW: Math.round(rects[0].width),
    sameRow: rects.every((r) => Math.abs(r.top - rects[0].top) < 1),
    phoneLeftOfSpeaker: !!sr && sr.right <= rects[1].left + 1,
    clusterRight: Math.round(Math.max(...rects.map((r) => r.right))),
    headRight: Math.round(head.getBoundingClientRect().right),
    phones: document.querySelectorAll('button[aria-label="开始语音通话"]').length,
    phoneInComposer: !!document.querySelector(".composer-bar button[aria-label=\\"开始语音通话\\"]"),
  };
})()`);
check("the call button moved into the chat head, LEFT of the auto-read speaker",
  cluster.present === true && cluster.labels[0] === "开始语音通话" && cluster.phoneLeftOfSpeaker,
  JSON.stringify({ labels: cluster.labels, phoneLeftOfSpeaker: cluster.phoneLeftOfSpeaker }));
check("it is the only way in (no leftover phone button in the composer tool row)",
  cluster.phones === 1 && cluster.phoneInComposer === false,
  JSON.stringify({ phones: cluster.phones, phoneInComposer: cluster.phoneInComposer }));
check("the head's four action buttons read as one tight strip, flush to the right edge",
  cluster.gapCss === "0px" && cluster.gaps.every((g) => g === 0) && cluster.sameRow
    && cluster.headRight - cluster.clusterRight <= 12,
  JSON.stringify({ gap: cluster.gapCss, gaps: cluster.gaps, sameRow: cluster.sameRow, edge: cluster.headRight - cluster.clusterRight }));
// The operator said "间距太大" twice; the second time it was not the gap but the air INSIDE
// each box (a 16px glyph in a 30px box). So assert on the glyph spacing the eye reads:
// on desktop the icons must be closer together than the icon is wide.
check("the icons themselves sit close (glyph gap well under one icon width)",
  cluster.glyphW >= 16 && cluster.glyphGaps.every((g) => g <= 12),
  JSON.stringify({ glyphW: cluster.glyphW, glyphGaps: cluster.glyphGaps, boxW: cluster.boxW }));

const toggled = await ev(`(async () => {
  const btn = document.querySelector('.chat-head .icon-btn.auto-read');
  const before = JSON.parse(localStorage.getItem('agentus.voice') || '{}').autoRead;
  const iconBefore = btn.innerHTML;
  btn.click();
  await new Promise((r) => setTimeout(r, 300));
  const mid = { pressed: btn.getAttribute('aria-pressed'), cls: btn.className.includes('on'),
    stored: JSON.parse(localStorage.getItem('agentus.voice') || '{}').autoRead, title: btn.getAttribute('title'),
    iconChanged: btn.innerHTML !== iconBefore };
  btn.click();                                   // leave the pref where we found it
  await new Promise((r) => setTimeout(r, 300));
  const after = JSON.parse(localStorage.getItem('agentus.voice') || '{}').autoRead;
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
  const g = document.querySelector('.chat-head .head-actions');
  const els = [...g.querySelectorAll('.icon-btn')];
  const btns = els.map((x) => Math.round(x.getBoundingClientRect().width));
  const rs = els.map((x) => x.getBoundingClientRect());
  const gl = els.map((x) => (x.querySelector('svg') ?? x).getBoundingClientRect());
  const glyphGaps = gl.slice(1).map((y, i) => Math.round(y.left - gl[i].right));
  const t = document.querySelector('.chat-head .title').getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), vw: innerWidth,
    btns, glyphW: Math.round(gl[0].width), glyphGaps,
    oneRow: rs.every((x) => Math.abs(x.top - rs[0].top) < 1),
    minW: Math.min(...btns), clusterLeft: Math.round(rs[0].left),
    titleRight: Math.round(t.right), titleW: Math.round(t.width) }; })()`);
check("every head action is thumb-sized on a phone and still on one row",
  !!phoneHead && phoneHead.minW >= 28 && phoneHead.h >= 28 && phoneHead.right <= phoneHead.vw && phoneHead.oneRow,
  JSON.stringify(phoneHead));
check("on a phone the four head buttons leave the session title room (no overlap)",
  !!phoneHead && phoneHead.titleW >= 40 && phoneHead.titleRight <= phoneHead.clusterLeft + 1,
  JSON.stringify({ titleW: phoneHead?.titleW, titleRight: phoneHead?.titleRight, clusterLeft: phoneHead?.clusterLeft }));
// phone is where the space is scarce: glyphs grow (20px) while the boxes come back to 36px,
// so the strip is both tighter and narrower than the 4x40px one it replaced.
check("on a phone the glyphs stay modest (18px, not the 24px 'too big' version) and the strip is narrower than the 4x40px one it replaced",
  !!phoneHead && phoneHead.glyphW >= 17 && phoneHead.glyphW <= 19
    && phoneHead.glyphGaps.every((g) => g <= 12)
    && phoneHead.btns[0] >= 28 && 4 * phoneHead.btns[0] <= 4 * 28,
  JSON.stringify({ glyphW: phoneHead?.glyphW, glyphGaps: phoneHead?.glyphGaps, box: phoneHead?.btns?.[0], cluster: phoneHead?.btns?.reduce((a, b) => a + b, 0) }));
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

// --- ordering: the rail is a launch pad, so the session (and the workspace) you last TALKED
//     to comes first. Creation time is the wrong key — a session chatted a minute ago can be the
//     oldest row in the list, and `lastSeq` is a per-session counter, so it cannot order them.
// the cwd is validated ("cwd not a directory"), so the probe owns its directories
fs.mkdirSync("/tmp/as-order-A", { recursive: true });
fs.mkdirSync("/tmp/as-order-B", { recursive: true });
const seeded = await ev(`(async () => {
  const j = (r) => r.json();
  const post = (u, b) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(j);
  const older = await post('/api/sessions', { backend: 'mock', cwd: '/tmp/as-order-A' });
  const newer = await post('/api/sessions', { backend: 'mock', cwd: '/tmp/as-order-B' });
  const sibling = await post('/api/sessions', { backend: 'mock', cwd: '/tmp/as-order-A' });
  return { older: older.id, newer: newer.id, sibling: sibling.id };
})()`);
await sleep(1500);   // the two creations must be clearly apart on the clock
await ev(`fetch('/api/sessions/${seeded.older}/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '排序测试：这条会话是刚聊过的' }) })`);
let list = [];
for (let i = 0; i < 40; i++) {
  await sleep(500);
  list = await ev(`fetch('/api/sessions').then((r) => r.json()).then((d) => d.live.map((s) => ({ id: s.id, lastAt: s.lastAt, createdAt: s.createdAt })))`);
  if (list[0]?.id === seeded.older) break;
}
const at = (id) => list.find((s) => s.id === id);
const me = at(seeded.older), rival = at(seeded.newer);
check("the ordering probe could seed its own sessions (cwd must exist, and it does)",
  Boolean(seeded.older && seeded.newer && seeded.sibling), JSON.stringify(seeded));
check("the session chatted just now is FIRST, even though the idle one was created later",
  list[0]?.id === seeded.older && (rival?.lastAt ?? 0) < (me?.lastAt ?? 0) && (rival?.createdAt ?? 0) > (me?.createdAt ?? 0),
  `head=${list.slice(0, 3).map((s) => s.id).join(",")} olderCreated=${me?.createdAt} newerCreated=${rival?.createdAt}`);
check("it reports a real last-chat time, not its creation time",
  (me?.lastAt ?? 0) > (me?.createdAt ?? 0) + 400, `lastAt-createdAt=${(me?.lastAt ?? 0) - (me?.createdAt ?? 0)}ms`);

await send("Page.reload", { ignoreCache: true });
await sleep(3400);
const readRail = async () => ev(`(() => [...document.querySelectorAll('.rail-group')].map((g) => ({
  path: g.querySelector('.rail-group-head')?.dataset.workspace ?? '',
  items: [...g.querySelectorAll('.session-item')].map((r) => r.dataset.session),
})))()`);
let ui = await readRail();
if (!ui.find((g) => g.path === '/tmp/as-order-A')?.items.length) {
  await ev(`document.querySelector('.rail-group-head[data-workspace="/tmp/as-order-A"]')?.click()`);
  await sleep(500);
  ui = await readRail();
}
const gi = (p) => ui.findIndex((g) => g.path === p);
check("the workspace you were just chatting in now sorts above the idle one",
  gi('/tmp/as-order-A') >= 0 && gi('/tmp/as-order-B') >= 0 && gi('/tmp/as-order-A') < gi('/tmp/as-order-B'),
  JSON.stringify(ui.map((g) => g.path)));
const gA = ui.find((g) => g.path === '/tmp/as-order-A');
check("inside a workspace, the session you last talked to sits above an idle sibling",
  Boolean(gA) && gA.items.indexOf(seeded.older) >= 0 && gA.items.indexOf(seeded.older) < gA.items.indexOf(seeded.sibling),
  `items=${JSON.stringify(gA?.items ?? null)} older=${seeded.older} sibling=${seeded.sibling}`);

// the receipt for this fix: a real rail screenshot, in the order the operator asked for
await setViewport(1440, 900);
await sleep(500);
const shotOrder = await send("Page.captureScreenshot", { format: "png" }, 25000);
fs.writeFileSync(`${SHOTS}/rail-order.png`, Buffer.from(shotOrder.data, "base64"));

// --- the per-directory 「+」: start a session in the directory you are ALREADY looking at
// (the operator's ask: "点这个加号就能直接在这个工作空间创建一个会话，最多再选一下 agent 类型")
await setViewport(1440, 900);
const target = ui.find((g) => g.path === "/tmp/as-order-A")?.path ?? ui[0]?.path ?? "/tmp";
const scrollToTarget = async () => {
  // The rail is a long list: the group we test may be far below the fold, where a synthetic
  // pointer event cannot land on it (measured: hover at y=1184 in a 900px viewport did
  // nothing). Put it in the middle of the screen first — that is also what an operator does.
  // scrollIntoView alone is not enough: the rail's own scroller is an ancestor, and the
  // document does not scroll, so the call can be a no-op and the row stays off-screen
  // (the failure is silent — the pointer just lands somewhere else). Scroll THAT element.
  for (let i = 0; i < 4; i++) {
    const box = await ev(`(() => {
      const head = document.querySelector('.rail-group-head[data-workspace=${JSON.stringify(target)}]');
      if (!head) return null;
      let el = head.parentElement;
      while (el && el.scrollHeight <= el.clientHeight + 2) el = el.parentElement;
      if (el) {
        const hr = head.getBoundingClientRect(), er = el.getBoundingClientRect();
        el.scrollTop += (hr.top - er.top) - Math.max(0, (er.height - hr.height) / 2);
      } else {
        head.scrollIntoView({ block: 'center' });
      }
      const r = head.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight,
        onScreen: r.top >= 0 && r.bottom <= innerHeight };
    })()`);
    if (!box) return;
    if (box.onScreen) return;
    await sleep(250);
  }
};
const hoverAndRead = async () => {
  await scrollToTarget();
  // Hover the group row: the 「+」 is revealed on hover on a pointer device (AionUi's
  // per-project + does the same; a touch screen shows it always). The pointer has to MOVE:
  // a synthetic mouseMoved to the coordinates it already sits on is not a hover change and
  // the reveal never fires (measured — the run after a long-press failed on exactly this).
  const box = await ev(`(() => { const head = document.querySelector('.rail-group-head[data-workspace=${JSON.stringify(target)}]');
    const r = head?.getBoundingClientRect(); return r ? { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) } : null; })()`);
  if (box) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 4 });
    await sleep(80);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.max(1, box.x - 60), y: box.y });
    await sleep(80);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      const o = await ev(`(() => { const g = [...document.querySelectorAll('.rail-group')].find((x) => x.querySelector('.rail-group-head')?.dataset.workspace === ${JSON.stringify(target)});
        const add = g?.querySelector('.group-add'); return add ? getComputedStyle(add).opacity : ''; })()`);
      if (Number(o) > 0.9) break;
    }
  }
  return await ev(`(() => {
    const g = [...document.querySelectorAll('.rail-group')].find((x) => x.querySelector('.rail-group-head')?.dataset.workspace === ${JSON.stringify(target)});
    const head = g?.querySelector('.rail-group-head');
    const add = g?.querySelector('.group-add');
    if (!head || !add) return { ok: false };
    const hr = head.getBoundingClientRect(), ar = add.getBoundingClientRect();
    const el = document.elementFromPoint((ar.left + ar.right) / 2, (ar.top + ar.bottom) / 2);
    const side = document.querySelector('.sidebar').getBoundingClientRect();
    return {
      ok: true,
      rightOfHead: ar.left >= hr.right - 1,
      insideSidebar: ar.right <= side.right + 1 && ar.left >= side.left - 1,
      opacity: getComputedStyle(add).opacity,
      reachable: Boolean(el) && (add.contains(el) || el.contains(add)),
      label: add.getAttribute('aria-label') || '',
      w: Math.round(ar.width), h: Math.round(ar.height),
      x: Math.round((ar.left + ar.right) / 2), y: Math.round((ar.top + ar.bottom) / 2),
    };
  })()`);
};
// A pending request from a previous run leaves its dialog (and its backdrop) on the page: it
// covers the rail, and this sweep is about the rail. Dismiss it the way the operator would.
const permCleared = await ev(`(() => {
  const bg = document.querySelector('.modal-bg.perm-bg');
  if (!bg) return { had: false };
  const btn = [...bg.querySelectorAll('button')].find((b) => /稍后处理|later/i.test(b.textContent || ''));
  btn?.click();
  return { had: true, via: btn ? 'later' : 'none' };
})()`);
if (permCleared.had) await sleep(500);

const plus = await hoverAndRead();
check("every workspace header carries a 「+」 next to the directory name", plus.ok,
  `target=${target} ${JSON.stringify(plus)}`);
check("it sits to the RIGHT of the directory row and inside the rail",
  plus.ok && plus.rightOfHead && plus.insideSidebar, JSON.stringify(plus));
check("it is really reachable once shown (not under something)", plus.ok && plus.reachable && Number(plus.opacity) > 0.9,
  `opacity=${plus.opacity} reachable=${plus.reachable}`);

// clicking it must OPEN the new-session dialog POINTED AT THAT DIRECTORY — not at an empty
// picker: the whole point is that the folder is already decided.
const clickPlus = async (p) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 });
  await sleep(900);
};
await clickPlus(plus);
const dialog = await ev(`(() => {
  const modal = document.querySelector('.modal');
  const fixed = modal?.querySelector('.ns-fixed-dir code')?.textContent ?? '';
  return {
    open: Boolean(modal),
    heading: modal?.querySelector('h3')?.textContent ?? '',
    fixed,
    hasPicker: Boolean(modal?.querySelector('.wp')),
    backends: [...(modal?.querySelectorAll('.backend-pick button') ?? [])].map((b) => (b.textContent || '').trim()),
    groupOpen: Boolean(document.querySelector('.rail-group-head[data-workspace=${JSON.stringify(target)}]')?.classList.contains('open')),
  };
})()`);
check("the 「+」 opens the new-session dialog", dialog.open, JSON.stringify(dialog));
check("the dialog is POINTED AT that directory (no browsing step left)", dialog.fixed === target && !dialog.hasPicker,
  JSON.stringify({ fixed: dialog.fixed, hasPicker: dialog.hasPicker, want: target }));
check("only the agent type is left to choose, and the row it will run is named",
  dialog.backends.length > 0, JSON.stringify(dialog.backends));

// create it for real, on the MOCK backend (no tokens), and prove it landed in that directory
// (a session that merely EXISTS in that directory proves nothing — it must be one this run made)
const runStart = Date.now();
let create = false;
for (let attempt = 0; attempt < 3 && !create; attempt++) {
  if (attempt > 0) { await hoverAndRead(); await clickPlus(plus); }
  create = await ev(`(async () => {
    const modal = document.querySelector('.modal');
    if (!modal) return false;
    const pick = [...modal.querySelectorAll('.backend-pick button')].find((b) => /mock/i.test(b.textContent || ''));
    if (pick) pick.click();
    await new Promise((r) => setTimeout(r, 250));
    const go = modal.querySelector('.row .go');
    if (!go) return false;
    go.click();
    return true;
  })()`);
  await sleep(600);
}
check("the dialog could actually be launched (no tokens: the mock backend)", create, `create=${create}`);
let made = null;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  made = await ev(`fetch('/api/sessions').then((r) => r.json()).then((d) => {
    const live = (d.live || []).filter((s) => (s.workspace || s.cwd) === ${JSON.stringify(target)} && (s.createdAt || 0) >= ${runStart});
    live.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return live[0] ? { id: live[0].id, backend: live[0].backend, cwd: live[0].cwd, at: live[0].createdAt } : null; })`);
  if (made) break;
}
check("the session it creates really runs IN that directory (and was made by THIS run)",
  Boolean(made) && made.cwd === target, JSON.stringify(made));
const after = await ev(`(() => {
  const g = [...document.querySelectorAll('.rail-group')].find((x) => x.querySelector('.rail-group-head')?.dataset.workspace === ${JSON.stringify(target)});
  return { rows: g ? g.querySelectorAll('.session-item').length : 0, modal: Boolean(document.querySelector('.modal')) };
})()`);
check("the new session shows up under that directory's group (and the dialog closed)",
  after.rows >= 2 && !after.modal, JSON.stringify(after));

// and the phone: the rail is an off-canvas drawer there, so open it the way the operator
// does, then check the 「+」 is visible WITHOUT hovering and big enough for a thumb
await setViewport(390, 844);
await ev(`document.querySelector('.chat-head .menu-btn')?.click()`);
await sleep(600);
await scrollToTarget();
const phonePlus = await ev(`(() => {
  const g = [...document.querySelectorAll('.rail-group')].find((x) => x.querySelector('.rail-group-head')?.dataset.workspace === ${JSON.stringify(target)});
  const add = g?.querySelector('.group-add');
  if (!add) return { ok: false };
  const r = add.getBoundingClientRect();
  const el = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
  return { ok: true, opacity: getComputedStyle(add).opacity, w: Math.round(r.width), h: Math.round(r.height),
    reachable: Boolean(el) && (add.contains(el) || el.contains(add)),
    inViewport: r.top >= 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }; })()`);
check("on a 390x844 phone the 「+」 is visible without hovering and is a real tap target",
  phonePlus.ok && Number(phonePlus.opacity) > 0.5 && phonePlus.w >= 28 && phonePlus.h >= 28
    && phonePlus.inViewport && phonePlus.reachable,
  JSON.stringify(phonePlus));
const phonePlusShot = await send("Page.captureScreenshot", { format: "png" }, 25000);
fs.writeFileSync(`${SHOTS}/phone-rail-add.png`, Buffer.from(phonePlusShot.data, "base64"));
await setViewport(1440, 900);

// --- the input box grows with what is in it (operator: "输入框能不能根据字数自动拉高") ----
// Studio's ChatInput does `height = min(scrollHeight, 100px)`; a fixed 42px box is exactly what
// makes editing a long multi-line message painful. Programmatic value changes count too
// (dictation, the slash palette, a restored draft), so this drives the native setter, not keys.
const grow = await ev(`(async () => {
  const ta = document.querySelector('.composer textarea');
  if (!ta) return { ok: false };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  const height = () => Math.round(ta.getBoundingClientRect().height);
  const type = async (v) => { setter.call(ta, v); ta.dispatchEvent(new Event('input', { bubbles: true })); await new Promise((r) => setTimeout(r, 150)); };
  const empty = height();
  await type('one line');
  const one = height();
  await type(Array.from({ length: 12 }, (_, i) => 'line ' + (i + 1)).join('\\n'));
  const many = height();
  const cap = Math.round(window.innerHeight * 0.4);
  const scrolls = ta.scrollHeight > ta.clientHeight + 2;
  await type('');
  return { empty, one, many, cap, scrolls, cleared: height() };
})()`);
check("the composer starts small and grows as lines are typed in",
  typeof grow.many === "number" && grow.one <= grow.empty + 4 && grow.many >= grow.one + 40,
  JSON.stringify(grow));
check("…it stops at 40% of the screen and scrolls inside instead of eating the page",
  grow.many <= grow.cap + 24 && (grow.scrolls || grow.many < grow.cap), JSON.stringify(grow));
check("…and it shrinks back when the text is sent (or cleared)", grow.cleared <= grow.empty,
  `cleared=${grow.cleared} empty=${grow.empty}`);

// --- a page must be able to tell that it is running OLD code ---------------------------
// A WebView keeps whatever bundle it loaded, so "the fix isn't there" and "the fix is broken"
// look identical to the operator — this round's entire problem. One tiny endpoint says which.
const ver = await ev(`fetch('/api/version').then((r) => r.json()).then((j) => ({
  asset: j.asset,
  loaded: ((document.querySelector('script[src*="/assets/index-"]') || {}).src || '').match(/index-([A-Za-z0-9_-]+)\\.js/)?.[1] ?? null,
}))`);
check("the server can say which bundle it is serving, and this page loaded that one",
  Boolean(ver.asset) && ver.asset === ver.loaded, JSON.stringify(ver));
const banner = await ev(`Boolean(document.querySelector('.stale-banner'))`);
check("…so a page that is not stale shows no nagging banner", banner === false, `banner=${banner}`);

console.log(`\n${pass} passed, ${fail} failed`);
console.log("shots: desktop-rail-oneline.png, phone-session-menu.png");
await fetch(`${CDP}/json/close/${t.id}`).catch(() => {});
process.exit(fail ? 1 : 0);
