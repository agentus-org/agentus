// The head's pane doors and their glyphs, on a real page (issues #80 §1, #88).
//
// #88 was found by adding a third pane and seeing it arrive worse than the two that shipped: no head
// button (a `headEntry: false` copied from the neighbouring row) and, once it got one, the terminal's
// icon under a title that said `desktop`. Both were found with eyes on a wide window — so the claims
// below are the same two, read off the DOM:
//
//  1. the head's doors are exactly the panes that are available (minus `files`, which has its own
//     folder button) — not a hand-kept list that can disagree with the panel;
//  2. each door's glyph is the registry row's glyph — byte-identical to the same pane's tab in the
//     panel, and different from its neighbour's — so a new pane cannot silently ship the wrong icon;
//  3. the IDE glyph is a titled window (a bar across the top), not the old `<>` that read as a second
//     terminal at 16px.
//
//   AGENTUS_BASE=http://127.0.0.1:8901 CDP_URL=http://127.0.0.1:9222 node scripts/qa/pane-head-dom.mjs
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
const goto = async (url) => { await send("Page.navigate", { url }); await sleep(3500); };

await goto(BASE);
const status = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({username:${JSON.stringify(USER)},password:${JSON.stringify(PASS)}})}).then(r=>r.status)`);
check("logged in (the cockpit lives behind the login)", status === 200, `status ${status}`);

// A wide window: the head's own buttons are a wide-window affordance by design (a phone keeps the
// `⋯` menu). 1200px is above the 721px breakpoint useWide() reads from the media query.
await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
await goto(BASE);

// Get a session on screen — the head only exists when one is open.
const opened = await ev(`(() => {
  const row = document.querySelector('.session-item:not(.rail-main-bot .session-item)')
    || [...document.querySelectorAll('.session-item')][0];
  if (!row) return false; row.click(); return true;
})()`);
check("a session is on screen (the head needs one)", opened);
await sleep(2500);

/* The shape of a glyph, as a string: the SVG primitives and their path data, in document order. Two
 * doors showing the same glyph give the same string; a door showing its neighbour's glyph gives a
 * different one, which is exactly the failure #88 describes. */
const SHAPES = `(el) => [...(el ? el.querySelectorAll('svg rect, svg path, svg circle, svg line, svg polyline') : [])]
  .map(n => n.tagName.toLowerCase() + ':' + (n.getAttribute('d')
    || [n.getAttribute('x'), n.getAttribute('y'), n.getAttribute('width'), n.getAttribute('height')].join(','))).join('|')`;

const headDoors = () => ev(`JSON.stringify([...document.querySelectorAll('.chat-head button.icon-btn')]
  .filter(b => ['files','terminal','ide'].includes(b.getAttribute('aria-label')))
  .map(b => ({ label: b.getAttribute('aria-label'), shapes: (${SHAPES})(b) })))`);

const doors = JSON.parse(await headDoors());
check("the head offers the terminal and the IDE", doors.some((d) => d.label === "terminal") && doors.some((d) => d.label === "ide"),
  doors.map((d) => d.label).join(","));
check("files does NOT get its own head button (it has the folder door) — the one opt-out (#88 §1)",
  !doors.some((d) => d.label === "files"), doors.map((d) => d.label).join(","));
check("no two head doors share a glyph", new Set(doors.map((d) => d.shapes)).size === doors.length,
  doors.map((d) => `${d.label}:${d.shapes.slice(0, 24)}`).join(" / "));

// The panel's tab bar is built from the same table, so the same pane must draw the same glyph there.
const openPanel = await ev(`(() => { const b = document.querySelector('.chat-head button[aria-label="file browser"]');
  if (!b) return false; b.click(); return true; })()`);
check("the panel opens (its tab bar is the other view of this table)", openPanel);
await sleep(2500);
const tabShapes = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('.tool-tab')]
  .map(b => ({ label: (b.textContent || '').trim().split(/\\s+/).pop(), shapes: (${SHAPES})(b) })))`));
for (const d of doors) {
  const t = tabShapes.find((x) => x.label === d.label);
  check(`head 与面板的 ${d.label} 是同一个图标（同一张表，不是两份手写）`,
    Boolean(t) && t.shapes === d.shapes,
    t ? `${t.shapes.slice(0, 40)} vs ${d.shapes.slice(0, 40)}` : "no tab");
}

// The IDE glyph: a window with a title bar (a full-width line across the top) — at 16px the old
// `<>` chevrons collapsed into dots and read as a second terminal (「ide 的那个图标不明显啊」).
const ideShapes = (doors.find((d) => d.label === "ide") || {}).shapes || "";
check("IDE 图标是「带标题栏的窗口」（横贯顶部的线），不再是挤成两个点的 <>",
  ideShapes.includes("path:M2 8h20") && ideShapes.includes("rect:"), ideShapes.slice(0, 120));
const termShapes = (doors.find((d) => d.label === "terminal") || {}).shapes || "";
check("IDE 与终端不再画成同一类形状（窗口带标题栏 vs 窗口带提示符）", ideShapes !== termShapes);

// ---- the phone (issue #88's other half: the `⋯` menu is fed by the SAME list) --------------
// A narrow head has no room for one button per pane, so the doors move into `⋯`. The menu reads the
// same derived list, which is why a pane missing from the head is missing from the phone entirely —
// the failure #88 describes ("on a phone not even through the menu").
await send("Emulation.setDeviceMetricsOverride", { width: 700, height: 900, deviceScaleFactor: 2, mobile: true });
await sleep(1200);
check("手机宽度下 head 不再放个别按钮（宽窗专属 affordance）",
  (await ev(`document.querySelectorAll('.chat-head button.icon-btn[aria-label="terminal"], .chat-head button.icon-btn[aria-label="ide"]').length`)) === 0);
const more = await ev(`(() => { const b = document.querySelector('button[aria-label="more panes"]');
  if (!b) return false; b.click(); return true; })()`);
await sleep(600);
const menu = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('.speak-menu-item')]
  .map(b => ((b.textContent || '').replace(/已打开|打开/g, '')).trim()))`));
check("⋯ 菜单里两个 pane 都在（同一份派生列表，不是第二份手写）",
  Boolean(more) && menu.join(",").includes("terminal") && menu.join(",").includes("ide"),
  `more=${more} menu=[${menu.join("|")}]`);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
await send("Page.close").catch(() => {});
ws.close();
process.exit(fail === 0 ? 0 : 1);
