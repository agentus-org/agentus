// Terminal probe (manual QA — real browser, real pty).
//
// Asserts the things that separate a terminal from a text box:
//   1. xterm is mounted and is the thing on screen (not a <pre> + input row)
//   2. a command typed at the prompt is ECHOED by the shell  -> proves a tty, not a pipe
//   3. its output arrives
//   4. colour reaches the screen                (SGR escapes are not stripped)
//   5. resizing the pane changes the pty size   (the shell reports the new geometry)
//
// Usage: start Edge/Chrome with --remote-debugging-port=9222, then
//        PORT=8901 node scripts/qa/terminal-sweep.mjs
const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";
const PORT = Number(process.env.PORT || 8901);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (ok, what, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${what}${detail ? `  — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? `  — ${detail}` : ""}`); }
};

const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(2600);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
// Close our own tab, always: a sweeps that throws before its close leaves the tab behind, and a
// browser full of stale Agentus tabs starts handing `/json/new` tabs that are still about:blank —
// which then shows up as an unrelated sweep failing with "Failed to parse URL from /api/auth/me".
const closeTab = () => { try { send("Target.closeTarget", { targetId: tab.id }); } catch {} };
process.on("exit", closeTab);
 const waiting = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) {
    const w = waiting.get(m.id); waiting.delete(m.id);
    m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result);
  }
};
const send = (method, params = {}, timeout = 20000) => new Promise((res, rej) => {
  const mid = ++id; const t = setTimeout(() => { waiting.delete(mid); rej(new Error("TIMEOUT " + method)); }, timeout);
  waiting.set(mid, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expr, timeout = 20000) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, timeout);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval err");
  return r.result.value;
};
/** Wait until the on-screen text matches — the regex runs HERE, so it never goes through a
 *  template literal and gets eaten by escaping. */
const waitScreen = async (re, ms = 12000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (re.test(await screen())) return true; await sleep(250); }
  return false;
};
const until = async (expr, ms = 15000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await ev(expr)) return true; await sleep(250); }
  return false;
};
/** Everything the emulator currently has on screen, as one string. */
const screen = () => ev(`(() => {
  const buf = document.querySelector('.term-host .xterm-screen');
  if (!buf) return '';
  const rows = [...document.querySelectorAll('.term-host .xterm-rows > div')];
  return rows.map((r) => r.textContent).join('\\n');
})()`);
/** Type into the terminal the way a person does: real text input, then Enter. */
const typeLine = async (line) => {
  await ev(`(() => { const t = document.querySelector('.term-host .xterm-helper-textarea'); if (t) t.focus(); return !!t })()`);
  await send("Input.insertText", { text: line });
  await sleep(400);
  // keyDown MUST carry text:'\\r' or the app's handler never sees the Enter
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
};

send("Page.enable");
send("Page.navigate", { url: BASE });
// about:blank reports readyState 'complete' too, so wait for the URL to actually be the app
for (let i = 0; i < 60; i++) {
  await sleep(500);
  if (await ev(`document.readyState === 'complete' && location.href.includes(':${PORT}')`)) break;
}
await sleep(1500);
const authed = await ev(`fetch('/api/auth/me',{credentials:'same-origin'}).then(r=>r.json()).then(j=>j.authenticated)`);
check(Boolean(authed), "the browser is logged in (a sweep drives a real session)");
// A shell needs a session with a running agent: take a live one, and if the instance has none (a
// dev server restart closes them all) resume the newest archived one — that is what the operator
// does by hand, and it is the same call (POST /api/sessions/<id>/resume).
const pick = `(async () => { const r = await fetch('/api/sessions',{credentials:'same-origin'}).then(r=>r.json());
  const l = r.live || []; if (l[0]) return 'live:' + l[0].id;
  const a = r.archived || []; if (a[0]) return 'cold:' + a[0].id; return ''; })()`;
let picked = String(await ev(pick));
if (picked.startsWith("cold:")) {
  const id = picked.slice(5);
  const code = await ev(`fetch('/api/sessions/${id}/resume',{method:'POST',credentials:'same-origin'}).then(r=>r.status)`);
  console.log(`  .. no live session: resumed archived ${id.slice(0, 8)} -> HTTP ${code}`);
  await sleep(4000);
  picked = String(await ev(pick));
}
const sid = picked.replace(/^(live|cold):/, "");
check(Boolean(sid) && picked.startsWith("live:"), "a live session to open a shell in", sid ? sid.slice(0, 8) : "none on this instance");
await ev(`location.href = ${JSON.stringify(`${BASE}/?session=`)} + ${JSON.stringify(String(sid))}`);
await sleep(3200);

// ---- open the workspace panel on its terminal tab ------------------------------------------
if (!(await ev(`Boolean(document.querySelector('.tool-panel'))`))) {
  await until(`Boolean(document.querySelector('button[aria-label="workspace panel"]'))`, 8000);
  await ev(`(() => { const b = document.querySelector('button[aria-label="workspace panel"]'); if (b) b.click(); return !!b })()`);
  await until(`Boolean(document.querySelector('.tool-panel'))`, 6000);
}
check(await ev(`Boolean(document.querySelector('.tool-panel'))`), "the workspace panel is open");
await ev(`(() => { const t = [...document.querySelectorAll('.tool-tab')].find((x) => /terminal/i.test(x.textContent)); if (t) t.click(); return !!t })()`);

console.log("== the terminal is a terminal, not a text box ==");
check(await until(`Boolean(document.querySelector('.term-host .xterm'))`, 10000), "xterm.js is mounted in the panel");
check(!(await ev(`Boolean(document.querySelector('.term-input input'))`)), "the old line-input row is gone");
check(await until(`!!document.querySelector('.term-dot.ready')`, 15000), "the shell socket reports ready");
// A connector that opens a socket twice (a remount while the first is still handshaking) must not
// leave the first socket's failure on screen: the panel said "terminal socket failed" while the
// live socket was connected and streaming.
await sleep(1200);
check(!(await ev(`Boolean(document.querySelector('.tool-panel .tool-error'))`)),
  "and no stale socket error is on screen while it is streaming",
  String(await ev(`(document.querySelector('.tool-panel .tool-error')||{}).textContent||''`)));
const ttyWord = await ev(`(() => { const s = document.querySelector('.term-status'); return s ? s.textContent : '' })()`);
check(!!ttyWord, "the bar says which kind of shell this is", String(ttyWord));

console.log("== it behaves like a shell ==");
check(await waitScreen(/[$%#>]\s*$/, 15000), "the prompt is on screen (a pipe shell never prints one)");
await typeLine("echo TTY_PROBE_ONE");
const s1 = await waitScreen(/TTY_PROBE_ONE/, 8000);
const after1 = await screen();
check(s1, "the command's output arrives", after1.split("\n").filter((l) => l.includes("TTY_PROBE_ONE")).slice(-1)[0] || "");
// The echo is the proof of a tty: the terminal prints what was typed BEFORE the command runs, so the
// token lands on two lines (the echoed command line, then its output). A pipe shell echoes nothing.
// Wait for the second one instead of measuring once — the output line arrives a moment later.
let occurrences = 0;
for (let i = 0; i < 24; i++) {
  occurrences = ((await screen()).match(/TTY_PROBE_ONE/g) || []).length;
  if (occurrences >= 2) break;
  await sleep(250);
}
check(occurrences >= 2, "and the shell ECHOED what I typed — this is a tty", `token appears ${occurrences}x`);

console.log("== colours survive the trip ==");
await typeLine("printf '\\033[31mRED_PROBE\\033[0m\\n'");
// wait for the OUTPUT row specifically: the echoed command line also contains the token, and a
// repaint right after a resize can leave the rows momentarily empty
for (let i = 0; i < 32; i++) {
  const rows = await ev(`(() => [...document.querySelectorAll('.term-host .xterm-rows > div')]
    .filter((r) => /RED_PROBE/.test(r.textContent) && r.textContent.trim().length <= 24).length)()`);
  if (Number(rows) > 0) break;
  await sleep(250);
}
const colored = await ev(`(() => {
  const rows = [...document.querySelectorAll('.term-host .xterm-rows > div')];
  // the echoed command line contains the token too, and it is below the prompt; the OUTPUT row is the
  // short one. Take the last short match.
  const hits = rows.filter((r) => /RED_PROBE/.test(r.textContent) && r.textContent.trim().length <= 24);
  const row = hits[hits.length - 1];
  if (!row) return { found: false };
  // xterm paints each SGR run into its own span; a red span is the escape sequence surviving
  const spans = [...row.querySelectorAll('span')].map((s) => ({ t: s.textContent, c: getComputedStyle(s).color }));
  return { found: true, spans, html: row.outerHTML };
})()`);
const redSpan = (colored.spans || []).find((s) => /RED_PROBE/.test(s.t) && !/rgb\(227, 236, 243\)|rgb\(255, 255, 255\)/.test(s.c));
if (!redSpan) {
  console.log("     row markup:", String(colored.html || "(no matching row)").slice(0, 300));
  console.log("     screen tail:", String(await screen()).split("\n").slice(-4).join(" | "));
}
check(colored.found && Boolean(redSpan), "an SGR colour reached the screen (nothing strips escapes)", redSpan ? redSpan.c : "no coloured span");

console.log("== the pty follows the pane size ==");
// `stty size` output accumulates on screen, so the CURRENT size is the last match, not the first.
const colsOf = (text) => {
  const m = [...String(text).matchAll(/(\d+) (\d+)/g)];
  return m.length ? Number(m[m.length - 1][2]) : 0;
};
const hostSize = () => ev(`(() => { const h = document.querySelector('.term-host');
  return h ? JSON.stringify({ cols: Number(h.dataset.termCols || 0), rows: Number(h.dataset.termRows || 0) }) : '{}'; })()`);
const size0 = await typeLineAndRead("stty size");
const host0 = JSON.parse(String(await hostSize()));
check(/\d+ \d+/.test(String(size0)), "the shell reports a real tty size", String(size0).trim().split("\n").filter(Boolean).slice(-1)[0]);
check(host0.cols > 0 && host0.cols === colsOf(size0),
  "the pty agrees with the emulator about the width", `client ${host0.cols} vs shell ${colsOf(size0)}`);
// Drag the panel's own handle (left edge). Shrink FIRST: a pane sitting at its clamp ignores a drag
// in the direction it cannot move, so measure the plausible direction after it has room.
const hbRaw = await ev(`(() => { const h = document.querySelector('.tool-panel > .pane-handle');
  if (!h) return 'null'; const r = h.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 3) }); })()`);
if (hbRaw && hbRaw !== 'null') {
  const hb = JSON.parse(String(hbRaw));
  // Re-read the handle before every drag: the previous drag MOVED it (the panel's left edge is the
  // thing that moves), so the old coordinates would land on whatever is there now.
  const dragTo = async (dx) => {
    const live = JSON.parse(String(await ev(`(() => { const h = document.querySelector('.tool-panel > .pane-handle');
      const r = h.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 3) }); })()`)));
    const { x, y } = live;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 8; i++) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + Math.round((dx * i) / 8), y, button: "left", buttons: 1 });
      await sleep(40);
    }
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + dx, y, button: "left", buttons: 0, clickCount: 1 });
    await sleep(1000);
  };
  await dragTo(140);              // narrow the panel: now it is off its clamp
  const mid = JSON.parse(String(await hostSize()));
  await dragTo(-140);             // and widen it again
  const host1 = JSON.parse(String(await hostSize()));
  const size1 = await typeLineAndRead("stty size");
  check(host1.cols > mid.cols, "widening the panel re-fits the terminal", `cols ${mid.cols} -> ${host1.cols}`);
  check(colsOf(size1) === host1.cols,
    "and the shell was told (SIGWINCH path: the pty size follows the pane)", `shell ${colsOf(size1)} vs client ${host1.cols}`);
}
/** Type a line, wait for it to land, and hand back the screen. */
async function typeLineAndRead(line) {
  await typeLine(line);
  await sleep(1000);
  return screen();
}

console.log(`\n${pass} ok, ${fail} failed`);
closeTab();
ws.close();
process.exit(fail ? 1 : 0);
