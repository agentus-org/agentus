// Layout sweep (manual QA — needs a real browser, so it is not in CI).
//
// One round, six reports from the operator, and this file is the evidence for four of them:
//   ③ 「工作空间的目录颜色应该和会话颜色一样比较亮，工作空间这四个字暗一点没关系」
//   ④ 「目录应该显示原始大小写，不要统一变成大写…最左边的箭头删掉吧，直接用文件夹的开合状态来指示
//      就行…然后也要有缩进哈，会话要缩进，这样有层次感」
//   ⑤ 「左侧栏能否鼠标点击拉动啊，右侧栏也是…现在文件预览是直接放在文件浏览器下面的，只有一半的
//      空间，太小了吧，你看下aionui，是单独加个侧栏到中间的吧」 + 「你还要考虑下手机上的展示」
//   ⑥ 「任务计划和上下文长度的那个都对齐左边，但是输入框和聊天对话消息泡都没有自动拉起到最边缘」
//
// Every assertion reads the RENDERED page (computed styles, real geometry, real pointer drags), and
// the drags go through `Input.dispatchMouseEvent` so the pane handles get true pointer events.
//
// Usage: start Edge/Chrome with --remote-debugging-port=9222, then
//        PORT=8901 node scripts/qa/layout-sweep.mjs
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';
const PORT = Number(process.env.PORT || 8901);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RAIL_KEYS = ['agentus.rail-width', 'agentus.panel-width', 'agentus.explorer-width'];

let pass = 0, fail = 0;
const check = (ok, what, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${what}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? `  — ${detail}` : ''}`); }
};

const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: 'PUT' })).json();
await sleep(2600);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const waiting = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) {
    const w = waiting.get(m.id); waiting.delete(m.id);
    m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result);
  }
};
const send = (method, params = {}, timeout = 20000) => new Promise((res, rej) => {
  const mid = ++id; const t = setTimeout(() => { waiting.delete(mid); rej(new Error('TIMEOUT ' + method)); }, timeout);
  waiting.set(mid, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expr, timeout = 20000) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeout);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval err');
  return r.result.value;
};
const until = async (expr, ms = 15000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await ev(expr)) return true; await sleep(300); }
  return false;
};
/** The panel's open state is React state, so every section that needs it opens it the same way. */
const openPanel = async () => {
  if (await ev(`Boolean(document.querySelector('.tool-panel'))`)) return true;
  await until(`Boolean(document.querySelector('button[aria-label="workspace panel"]'))`, 8000);
  await ev(`(() => { const b = document.querySelector('button[aria-label="workspace panel"]'); if (b) b.click(); return !!b })()`);
  return until(`Boolean(document.querySelector('.tool-panel'))`, 6000);
};
/** Open a FILE in the tree, which is what gives the panel its preview column. */
const openAFile = async () => {
  // the tree streams in, so give it a moment to have rows at all before looking for one
  await until(`document.querySelectorAll('.tool-panel .file-row').length > 0`, 8000);
  const hit = await ev(`(() => { const n = [...document.querySelectorAll('.tool-panel .file-row .file-name')]
    .find((s) => /\\.(md|txt|json|ts|py|js|log|css)$/i.test((s.textContent || '').trim())); if (n) n.closest('.file-row').click(); return !!n; })()`);
  if (!hit) return false;
  return until(`Boolean(document.querySelector('.preview-col'))`, 6000);
};
/** Real pointer drag on a pane handle (CDP synthesises pointer events from these). */
const drag = async (selector, dx) => {
  const box = await ev(`(() => { const h = document.querySelector(${JSON.stringify(selector)}); if (!h) return null;
    const r = h.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 3) }); })()`);
  if (!box) throw new Error(`no handle: ${selector}`);
  const { x, y } = JSON.parse(box);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + Math.round((dx * i) / steps), y, button: 'left', buttons: 1 });
    await sleep(40);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + Math.round((dx * i) / steps), y, button: 'left', buttons: 1 });
    await sleep(40);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(400);
};
const rect = async (sel) => JSON.parse(await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
  if (!e) return JSON.stringify(null); const r = e.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }); })()`));

send('Page.enable');
send('Page.navigate', { url: BASE });
for (let i = 0; i < 60; i++) {
  await sleep(500);
  if (await ev(`document.readyState === 'complete' && location.href.includes(':${PORT}')`)) break;
}
await sleep(1500);
// a clean slate for the widths: these are the operator's, and a stale value would make "did the drag
// work" ambiguous
await ev(`(() => { ${JSON.stringify(RAIL_KEYS)}.forEach((k) => localStorage.removeItem(k)); return true })()`);
await ev('location.reload()');
await sleep(3000);
check(await until(`Boolean(document.querySelector('.sidebar .session-item'))`), 'the cockpit rendered with sessions');

const sid = await ev(`(async () => { const me = await fetch('/api/auth/me',{credentials:'same-origin'}).then(r=>r.json());
  if (!me.authenticated) return 'UNAUTHED';
  const r = await fetch('/api/sessions',{credentials:'same-origin'}).then(r=>r.json());
  const l = r.live || []; return (l[0] && l[0].id) || ''; })()`);
check(sid && sid !== 'UNAUTHED', 'a live session to measure against', String(sid));
await ev(`location.href = ${JSON.stringify(`${BASE}/?session=`)} + ${JSON.stringify(String(sid))}`);
await sleep(3200);
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
await sleep(400);

// ---------------------------------------------------------------------------- ③ ④ the rail
console.log('== ③ directory names read like session titles, section heads stay secondary ==');
{
  const styles = JSON.parse(await ev(`(() => {
    const cs = (el) => getComputedStyle(el);
    const group = document.querySelector('.rail-group-head');
    const name = document.querySelector('.rail-group-head .rail-group-name');
    const section = [...document.querySelectorAll('.rail-section')].find((s) => /工作空间/.test(s.textContent));
    const title = document.querySelector('.rail-group-body .session-item .title');
    // resolve the tokens the way the browser does, so hex-in-CSS and rgb-in-computed compare
    const probe = document.createElement('span');
    probe.style.color = 'var(--text-dim)';
    document.body.appendChild(probe);
    const dimRgb = getComputedStyle(probe).color;
    probe.style.color = 'var(--text)';
    const textRgb = getComputedStyle(probe).color;
    probe.remove();
    return JSON.stringify({
      nameColor: name && cs(name).color,
      groupColor: group && cs(group).color,
      sectionColor: section && cs(section).color,
      titleColor: title && cs(title).color,
      dim: dimRgb,
      text: textRgb,
      transform: name && cs(name).textTransform,
    });
  })()`));
  check(styles.nameColor === styles.titleColor,
    'the directory name is the same colour as a session title', `${styles.nameColor} vs title ${styles.titleColor}`);
  check(styles.sectionColor === styles.dim && styles.nameColor !== styles.dim,
    'and the section head above it is the dimmer token', `section ${styles.sectionColor} vs --text-dim ${styles.dim}`);
  check(styles.nameColor === styles.text,
    'so the directory uses the primary text token', `${styles.nameColor} vs --text ${styles.text}`);
  check(styles.transform === 'none', 'the directory name is NOT uppercased by CSS', `text-transform: ${styles.transform}`);

  console.log('== ④ the folder icon carries the open/closed state, sessions are indented ==');
  const shapes = JSON.parse(await ev(`(() => {
    const head = document.querySelector('.rail-group-head');
    const svg = head && head.querySelector('.rail-group-folder');
    return JSON.stringify({
      chevrons: document.querySelectorAll('.rail-group-chev').length,
      folder: Boolean(svg),
      path: svg ? [...svg.querySelectorAll('path')].map((p) => p.getAttribute('d')).join('|') : '',
    });
  })()`));
  check(shapes.folder && shapes.chevrons === 0,
    'the group row has a folder icon and no chevron beside it', `chevrons=${shapes.chevrons}`);
  await ev(`document.querySelector('.rail-group-head').click()`);
  await sleep(400);
  const closed = JSON.parse(await ev(`(() => { const svg = document.querySelector('.rail-group-head .rail-group-folder');
    return JSON.stringify({ path: svg ? [...svg.querySelectorAll('path')].map((p) => p.getAttribute('d')).join('|') : '',
                            open: Boolean(document.querySelector('.rail-group-head.open')) }); })()`));
  check(closed.path !== shapes.path && closed.path.length > 0,
    'and the icon itself changes when the group is collapsed', `open? ${closed.open}`);
  await ev(`document.querySelector('.rail-group-head').click()`);
  await sleep(500);

  const indent = JSON.parse(await ev(`(() => {
    const section = [...document.querySelectorAll('.rail-section')].find((s) => /工作空间/.test(s.textContent));
    const head = document.querySelector('.rail-group-head');
    const name = document.querySelector('.rail-group-head .rail-group-name');
    const folder = document.querySelector('.rail-group-head .rail-group-folder');
    const title = document.querySelector('.rail-group-body .session-item .title');
    const x = (e) => (e ? Math.round(e.getBoundingClientRect().x) : null);
    return JSON.stringify({ section: x(section), folder: x(folder), name: x(name), title: x(title),
      label: x(section && section.querySelector('span:not(.rail-section-chev)')) });
  })()`));
  check(indent.folder < indent.name, 'the folder icon comes before the name', `${indent.folder} < ${indent.name}`);
  check(indent.name < indent.title, 'a session title is indented past the directory name',
    `name ${indent.name} < title ${indent.title}`);
  check(indent.folder > indent.label, 'and the directory sits inside the section head',
    `folder ${indent.folder} > section label ${indent.label}`);
}

// ------------------------------------------------------------------- ⑥ one left edge for the column
console.log('== ⑥ the reply text, the input box and the widgets above it share one left edge ==');
{
  const before = JSON.parse(await ev(`(() => {
    const x = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().x) : null; };
    const w = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().width) : null; };
    const si = document.querySelector('.stream-inner');
    return JSON.stringify({ chat: x('.chat-col'), stream: x('.stream-inner'), streamW: w('.stream-inner'),
      streamPad: si ? parseFloat(getComputedStyle(si).paddingLeft) : null,
      composer: x('.composer-inner'), plan: x('.plan-bar'), usage: x('.usage-row'), msg: x('.stream-inner .msg'),
      scrollW: document.documentElement.scrollWidth, vw: window.innerWidth });
  })()`));
  check(before.stream === before.chat, 'the reply column starts at the chat column\'s own left edge',
    `chat ${before.chat} stream ${before.stream}`);
  check(before.streamW === before.chat !== undefined && before.streamW > 600,
    'and spans the column instead of a centred gutter', `${before.streamW}px wide`);
  // the reply TEXT (inside the stream's padding) and the input box must share one x
  check(before.composer === before.stream + before.streamPad,
    'the input box lines up with the reply text, not with the column edge',
    `composer ${before.composer} = stream ${before.stream} + ${before.streamPad}px padding`);
  if (before.msg !== null) check(before.msg === before.composer,
    'and a real message bubble starts at exactly that x', `msg ${before.msg}`);
  if (before.plan !== null) check(before.plan === before.composer, 'so does the plan bar', `plan ${before.plan}`);
  if (before.usage !== null) check(before.usage === before.composer, 'so does the usage row', `usage ${before.usage}`);
  check(before.scrollW <= before.vw + 1, 'nothing overflows horizontally', `scrollWidth ${before.scrollW} vs ${before.vw}`);
}

// ---------------------------------------------------------------------------- ⑤ the panel split
console.log('== ⑤ the panel opens as columns: preview beside the tree, not stacked ==');
check(await openPanel(), 'the panel opened');
check(await openAFile(), 'and a file is being previewed');
{
  const cols = JSON.parse(await ev(`(() => {
    const g = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect();
      return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) }; };
    return JSON.stringify({ split: g('.panel-split'), preview: g('.preview-col'), explorer: g('.explorer-col'),
      previewEl: g('.preview-col .file-preview'), list: g('.explorer-col .file-list') });
  })()`));
  check(Boolean(cols.preview && cols.explorer), 'both columns exist',
    `preview ${JSON.stringify(cols.preview)} explorer ${JSON.stringify(cols.explorer)}`);
  if (cols.preview && cols.explorer) {
    check(cols.preview.x < cols.explorer.x, 'the preview sits between the chat and the tree',
      `preview x ${cols.preview.x} < explorer x ${cols.explorer.x}`);
    check(cols.previewEl && cols.previewEl.h > 300, 'the preview gets the panel\'s full height, not half of it',
      `${cols.previewEl?.h}px tall, ${cols.previewEl?.w}px wide`);
    check(cols.previewEl && cols.previewEl.w >= 300, 'and a column floor of its own', `${cols.previewEl?.w}px wide`);
  }
}

console.log('== ⑤ / ⑥ the panes drag, persist and clamp ==');
{
  // A file has to be open before the panel has a preview column — that column is what carries the
  // third drag handle, so open one here and let the three-handle check depend on it.
  check(await openAFile(), 'a file is open, so the panel has its preview column');
  const handles = await ev(`JSON.stringify([...document.querySelectorAll('.pane-handle')].map((h) => h.getAttribute('aria-label')))`);
  check((JSON.parse(handles)).length === 3, 'three handles exist (rail, panel, tree)', handles);

  const rail0 = await rect('.sidebar');
  await drag('.sidebar > .pane-handle', 80);
  const rail1 = await rect('.sidebar');
  check(Math.abs((rail1.w - rail0.w) - 80) <= 6, 'dragging the rail handle widens the rail',
    `${rail0.w} -> ${rail1.w}`);
  const stored = await ev(`localStorage.getItem('agentus.rail-width')`);
  check(Number(stored) === rail1.w, 'and the width is written to localStorage', `stored ${stored} vs ${rail1.w}`);
  // A full page load is the honest test of persistence — and the app drops `?session=` from the URL
  // once it has opened a slot, so an explicit navigation is what a reload has to look like here.
  await ev(`location.href = ${JSON.stringify(`${BASE}/?session=`)} + ${JSON.stringify(String(sid))}`);
  const backUp = await until(`Boolean(document.querySelector('.sidebar .session-item'))`, 20000);
  check(backUp, 'the page loaded the slot again');
  const rail2 = await rect('.sidebar');
  check(rail2 && Math.abs(rail2.w - rail1.w) <= 2, 'a reload keeps it', `${rail1.w} -> ${rail2 && rail2.w}`);
  // the panel's OPEN state is React state (not persisted), so put it back before measuring it again
  check(await openPanel(), 'the panel is open again after the reload');

  // double-click resets to the default
  const box = JSON.parse(await ev(`(() => { const h = document.querySelector('.sidebar > .pane-handle');
    const r = h.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); })()`));
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 2 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 2 });
  await sleep(500);
  const rail3 = await rect('.sidebar');
  check(rail3.w === 268, 'double-clicking the handle puts it back to the default 268', `${rail3.w}px`);

  // A panel that is ALREADY at the clamp cannot grow, so shrink it first and drag from there — the
  // clamp is what the previous version of this test tripped over (it read a 90px drag as 80px).
  const panel0 = await rect('.tool-panel');
  await drag('.tool-panel > .pane-handle', 140);
  const panelA = await rect('.tool-panel');
  check(Math.abs((panel0.w - panelA.w) - 140) <= 8, 'dragging the panel handle right narrows the panel',
    `${panel0.w} -> ${panelA.w}`);
  await drag('.tool-panel > .pane-handle', -90);
  const panel1 = await rect('.tool-panel');
  check(Math.abs((panel1.w - panelA.w) - 90) <= 6, 'and left widens it again', `${panelA.w} -> ${panel1.w}`);

  // the clamp: drag the panel as far left as the pointer can go and the chat column must survive
  await drag('.tool-panel > .pane-handle', -900);
  const chat = await rect('.chat-col');
  const panel2 = await rect('.tool-panel');
  check(chat.w >= 355, 'the chat column is clamped at MIN_CHAT no matter how hard the panel is dragged',
    `chat ${chat.w}px, panel ${panel2.w}px`);

  // the tree's own handle only exists while a file is open, and the reload above closed the preview
  check(await openAFile(), 'a file is open again, so the tree has its handle');
  const ex0 = await rect('.explorer-col');
  await drag('.explorer-col > .pane-handle', -60);
  const ex1 = await rect('.explorer-col');
  const prev1 = await rect('.preview-col');
  check(Math.abs((ex1.w - ex0.w) - 60) <= 6, 'the tree column drags too', `${ex0.w} -> ${ex1.w}`);
  check(prev1.w >= 295, 'and it cannot eat the preview below its own floor', `preview ${prev1.w}px`);
}

// ------------------------------------------------- ⑧ short rows stay short, ⑨ my turns hug the right
console.log('== ⑧ a short row is not stretched, ⑨ the operator\'s own turns hug the right ==');
{
  // This run has deliberately mangled the pane widths; put the desktop layout back so the measurement
  // happens at a realistic column width (a 360px column would make every card look "stretched").
  await ev(`(() => {
    for (const h of document.querySelectorAll('.pane-handle')) {
      const b = h.getBoundingClientRect();
      h.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window,
        clientX: Math.round(b.x + b.width / 2), clientY: Math.round(b.y + b.height / 2) }));
    }
    const btn = document.querySelector('button[aria-label="workspace panel"]');
    if (btn && btn.getAttribute('aria-expanded') === 'true') btn.click();
    return true;
  })()`);
  await sleep(900);
  // ⑧ is about the CSS rule (a block is as wide as what it holds), and the dev server here runs a
  // MOCK agent — a real prompt never produces a tool card, so waiting for one would assert nothing.
  // Instead: measure any real work row the slot happens to have, AND inject a short one with the
  // real class names, measure it, and remove it. That is the honest test of the rule itself (before
  // the fix its right edge sat exactly on the column edge, which is what the operator reported).
  const m = JSON.parse(await ev(`(() => {
    const stream = document.querySelector('.stream-inner');
    if (!stream) return JSON.stringify({ none: true });
    const sr = stream.getBoundingClientRect();
    const cs = getComputedStyle(stream);
    const textLeft = Math.round(sr.x + parseFloat(cs.paddingLeft));
    const streamRight = Math.round(sr.right - parseFloat(cs.paddingRight));
    const box = (e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), x: Math.round(r.x), right: Math.round(r.right) }; };
    const rows = [...stream.querySelectorAll('.msg')];
    const before = stream.querySelectorAll('.tool-card, .thought-head, .work-run-head').length;
    const users = rows.filter((r) => r.classList.contains('user'));
    const one = (sel) => { const e = stream.querySelector(sel); return e ? box(e) : null; };
    const mk = (html) => { const d = document.createElement('div'); d.innerHTML = html; const el = d.firstElementChild; stream.appendChild(el); return el; };
    const rowTool = mk('<div class="msg"><div class="tool-card completed"><button class="tool-head"><span class="tool-title">read_file</span></button></div></div>');
    const rowThought = mk('<div class="msg thought"><button class="role thought-head">thinking</button></div>');
    const rowFold = mk('<div class="msg"><div class="work-run"><button class="work-run-head"><span class="work-run-count">3 calls</span></button></div></div>');
    const injected = {
      tool: box(rowTool.querySelector('.tool-card')),
      thought: box(rowThought.querySelector('.thought-head')),
      fold: box(rowFold.querySelector('.work-run-head')),
    };
    rowTool.remove(); rowThought.remove(); rowFold.remove();
    return JSON.stringify({
      textLeft, streamRight, streamW: Math.round(sr.width), before,
      after: stream.querySelectorAll('.tool-card, .thought-head, .work-run-head').length,
      tool: injected.tool, fold: injected.fold, thought: injected.thought,
      agent: one('.msg.agent .bubble'),
      user: users.length ? {
        count: users.length,
        bubbles: users.map((u) => { const b = u.querySelector('.bubble'); return b ? box(b) : null; }).filter(Boolean),
        labels: users.map((u) => { const l = u.querySelector('.role'); return l ? box(l) : null; }).filter(Boolean),
        rowRight: Math.round(users[users.length - 1].getBoundingClientRect().right),
      } : null,
    });
  })()`));
  check(!m.none, 'a stream to measure');
  check(m.after === m.before, 'the probe rows are gone again', `${m.before} → ${m.after}`);

  // ⑧ — a short block keeps its own width: its right edge stops short of the column's, while its left
  // edge is still the one common text edge (that is ⑥: nothing floats in a centred gutter).
  const shortRows = [['tool card', m.tool], ['folded work run', m.fold], ['thinking header', m.thought]].filter(([, b]) => b);
  check(shortRows.length > 0, 'the session shows at least one tool/thought row to measure',
    shortRows.map(([n]) => n).join(', ') || 'none rendered');
  for (const [name, b] of shortRows) {
    check(b.right <= m.streamRight - 8, `a short ${name} stops short of the right edge, not stretched to it`,
      `right ${b.right} vs column ${m.streamRight}`);
    check(Math.abs(b.x - m.textLeft) <= 3, `and it still starts on the shared left text edge`, `x ${b.x} vs ${m.textLeft}`);
  }
  if (m.agent) check(m.agent.x >= m.textLeft - 3, 'agent prose keeps the same left edge', `x ${m.agent.x}`);

  // ⑨ — the operator's turns sit against the right edge, label included, and do not stretch when short.
  if (!m.user) {
    check(false, 'the session has an operator turn to measure', 'no .msg.user rows in this session');
  } else {
    const last = m.user.bubbles[m.user.bubbles.length - 1];
    check(Math.abs(last.right - m.streamRight) <= 3, 'my own bubble hugs the right edge',
      `bubble right ${last.right} vs column ${m.streamRight}`);
    const lab = m.user.labels[m.user.labels.length - 1];
    check(Math.abs(lab.right - m.streamRight) <= 3, 'and the YOU label is on the right with it',
      `label right ${lab.right} vs column ${m.streamRight}`);
    const narrowest = Math.min(...m.user.bubbles.map((b) => b.w));
    check(narrowest < m.streamW - 40, 'a short turn does not stretch to the full width', `narrowest ${narrowest}px of ${m.streamW}px`);
    check(Math.max(...m.user.bubbles.map((b) => b.w)) <= m.streamW, 'and a long one never overflows the column');
  }
}

// ---------------------------------------------------------------------------- on a phone
console.log('== on a phone: one pane at a time, no dead handles ==');
// the pane bookkeeping above left the panel closed; a phone shows the panel as a full-screen sheet,
// so put it back (with a file open) before measuring that.
check(await openPanel(), 'the panel is open for the phone check');
check(await openAFile(), 'with a file open');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(1200);
{
  const ph = JSON.parse(await ev(`(() => {
    const vis = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e); return { w: Math.round(r.width), h: Math.round(r.height), display: cs.display }; };
    return JSON.stringify({ handles: [...document.querySelectorAll('.pane-handle')].filter((h) => getComputedStyle(h).display !== 'none').length,
      preview: vis('.preview-col'), explorer: vis('.explorer-col'), panel: vis('.tool-panel'),
      overflowX: document.documentElement.scrollWidth - window.innerWidth });
  })()`));
  check(ph.handles === 0, 'no drag handles on a phone', `${ph.handles} visible`);
  check(ph.panel && ph.panel.w <= 391, 'the panel is a full-screen sheet, not a 760px column', JSON.stringify(ph.panel));
  check(!ph.explorer || ph.explorer.display === 'none',
    'the tree steps aside while a file is being read, so the preview has the whole screen',
    JSON.stringify(ph.explorer));
  check(ph.preview && ph.preview.w >= 300, 'and the preview actually gets the room', JSON.stringify(ph.preview));
  check(ph.overflowX <= 1, 'nothing overflows a 390px screen', `overflowX ${ph.overflowX}`);
}
await send('Emulation.clearDeviceMetricsOverride');
await ev(`(() => { ${JSON.stringify(RAIL_KEYS)}.forEach((k) => localStorage.removeItem(k)); return true })()`);

console.log(`\n${pass} ok, ${fail} failed`);
// Close the socket and END the process: a live CDP WebSocket keeps node's event loop alive, so a
// sweep that only prints its summary hangs forever — and a caller chaining two sweeps with `;` then
// never reaches the second one (measured: three sweeps sat "running" for 25 minutes after their
// last check).
ws.close();
process.exit(fail ? 1 : 0);
