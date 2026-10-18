// 工作播报 in the REAL page (issue #16): the header's speaker button is a three-way menu, and the
// 观察智能体 card in 设置 exists, is editable, and persists through the server.
//
//   PORT=8901 node scripts/qa/speak-menu-dom.mjs
const CDP = process.env.CDP ?? "http://127.0.0.1:9222";
const BASE = process.env.BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8901}`;
const U = process.env.QA_USER ?? "scratch", P = process.env.QA_PASS ?? "scratch-pass-1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const t = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(1500);
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
const waitFor = async (expr, ms = 20_000) => { const until = Date.now() + ms; while (Date.now() < until) { if (await ev(expr).catch(() => 0)) return true; await sleep(250); } return false; };
await send("Page.enable"); await send("Runtime.enable");

const apiPrefs = () => ev(`(async () => { const s = await (await fetch('/api/settings')).json(); return { prefs: s.prefs, observer: s.observer }; })()`);
const original = await (async () => {
  const tok = (await import("node:fs")).readFileSync("/tmp/agentus-qa-account/auth.token", "utf8").trim();
  return (await (await fetch(`${BASE}/api/settings`, { headers: { authorization: `Bearer ${tok}` } })).json());
})();

try {
  const login = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
  if (login !== 200) throw new Error(`QA login returned ${login} — wrong instance (AGENTUS_DATA?)`);
  await ev(`location.reload()`);
  await sleep(1600);

  // Pick a session so the header (and its speaker) is on screen.
  const opened = await waitFor(`Boolean(document.querySelector('.chat-head'))`);
  check("a session is on screen (the header exists to carry the speaker)", opened);
  const hasButton = await waitFor(`Boolean(document.querySelector('.speak-wrap button.icon-btn'))`);
  check("the header draws the speaker as a one-click switch that also owns a menu", hasButton);
  const attrs = await ev(`(() => { const b = document.querySelector('.speak-wrap button.icon-btn'); return { mode: b.getAttribute('data-speak-mode'), popup: b.getAttribute('aria-haspopup') }; })()`);
  check("…it starts in a known mode and declares the menu", ["off", "reply", "brief"].includes(attrs.mode) && attrs.popup === "menu", JSON.stringify(attrs));

  // Real pointer events, not element.click(): the long press is timed, and a scripted click would
  // prove nothing about whether the release afterwards also fires the toggle.
  const spot = () => ev(`(() => { const b = document.querySelector('.speak-wrap button.icon-btn').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  const press = async (ms, button = "left") => {
    const p = await spot();
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button, buttons: button === "left" ? 1 : 2, clickCount: 1 });
    await sleep(ms);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button, buttons: 0, clickCount: 1 });
    await sleep(350);
  };

  // A short click is the switch: it must NOT open the menu.
  const modeBefore = (await ev(`document.querySelector('.speak-wrap button.icon-btn').getAttribute('data-speak-mode')`));
  await press(90);
  const modeAfterClick = await ev(`document.querySelector('.speak-wrap button.icon-btn').getAttribute('data-speak-mode')`);
  const menuAfterClick = await ev(`Boolean(document.querySelector('.speak-menu'))`);
  check("a short click toggles the mode and opens no menu", modeAfterClick !== modeBefore && !menuAfterClick, `${modeBefore} → ${modeAfterClick}`);

  // A long press opens the menu and must NOT toggle (the release would otherwise click through).
  await press(650);
  const menuAfterHold = await ev(`Boolean(document.querySelector('.speak-menu'))`);
  const modeAfterHold = await ev(`document.querySelector('.speak-wrap button.icon-btn').getAttribute('data-speak-mode')`);
  check("a 650ms hold opens the menu", menuAfterHold);
  check("…and the release does not also toggle the mode", modeAfterHold === modeAfterClick, `${modeAfterClick} → ${modeAfterHold}`);

  const options = await ev(`[...document.querySelectorAll('.speak-menu [data-speak-option]')].map(b => b.getAttribute('data-speak-option'))`);
  // issue #24: the menu is flat and carries the beat, so 「每 1/2/5 分钟」 are first-class options.
  check("the menu offers 关 / 自动朗读 / 四个工作播报档位 / 自定义",
    JSON.stringify(options) === JSON.stringify(["off", "reply", "brief", "brief-60", "brief-120", "brief-300", "custom"]),
    JSON.stringify(options));
  const checkedCount = await ev(`document.querySelectorAll('.speak-menu [aria-checked="true"]').length`);
  check("exactly ONE item is checked (自动朗读 and 工作播报 are one switch, never two)", checkedCount === 1, String(checkedCount));
  const replyLabel = await ev(`document.querySelector('.speak-menu [data-speak-option="reply"] .speak-name').textContent`);
  check("自动朗读 is labelled as the click default", /默认/.test(replyLabel), JSON.stringify(replyLabel));

  // Choosing 工作播报 persists the new pref AND keeps the old boolean in step.
  const before = await apiPrefs();
  await ev(`document.querySelector('.speak-menu [data-speak-option="brief"]').click()`);
  await sleep(1200);
  const afterBrief = await apiPrefs();
  check("choosing 工作播报 writes speakMode=brief (and autoRead=false)",
    afterBrief.prefs.speakMode === "brief" && afterBrief.prefs.autoRead === false, JSON.stringify(afterBrief.prefs));

  // ---- 节拍 (issue #24): picking 「每 2 分钟」 writes the beat in ONE click, and the ✓ moves ----
  await press(650);
  await ev(`document.querySelector('.speak-menu [data-speak-option="brief-120"]').click()`);
  await sleep(1200);
  const afterBeat = await apiPrefs();
  check("…and 「每 2 分钟」 writes observer.intervalSec=120 with the same speakMode=brief",
    afterBeat.prefs.speakMode === "brief" && afterBeat.observer?.intervalSec === 120, JSON.stringify(afterBeat.observer));
  await press(650);
  const beatChecked = await ev(`document.querySelector('.speak-menu [aria-checked="true"]')?.getAttribute('data-speak-option')`);
  const checkedNow = await ev(`document.querySelectorAll('.speak-menu [aria-checked="true"]').length`);
  check("the ✓ is on the beat that is actually in use, and only there",
    beatChecked === "brief-120" && checkedNow === 1, JSON.stringify({ beatChecked, checkedNow }));
  const headTitle = await ev(`document.querySelector('.speak-wrap button.icon-btn').getAttribute('title') ?? ''`);
  check("the header says which beat is on", /每 2 分钟/.test(headTitle), JSON.stringify(headTitle));
  await ev(`document.querySelector('.speak-menu [data-speak-option="brief"]').click()`);
  await sleep(800);
  check("…and the menu closed on the click", !(await ev(`Boolean(document.querySelector('.speak-menu'))`)));
  const dot = await ev(`Boolean(document.querySelector('.speak-dot'))`);
  check("…with a badge so the mode is visible without opening the menu", dot);

  await press(650);
  await ev(`document.querySelector('.speak-menu [data-speak-option="reply"]').click()`);
  await sleep(1000);
  const afterReply = await apiPrefs();
  check("choosing 自动朗读 writes speakMode=reply and autoRead=true",
    afterReply.prefs.speakMode === "reply" && afterReply.prefs.autoRead === true, JSON.stringify(afterReply.prefs));

  // Right-click is the desktop half of the long press.
  await press(90, "right");
  check("right-click opens the same menu", await ev(`Boolean(document.querySelector('.speak-menu'))`));
  // A real press somewhere neutral: the dismiss hook listens on pointerdown (capture), which a
  // scripted .click() never fires — testing it with .click() would have proven nothing.
  const gone = await (async () => {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 320, y: 240, button: "left", buttons: 1, clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 320, y: 240, button: "left", buttons: 0, clickCount: 1 });
    await sleep(300);
    return !(await ev(`Boolean(document.querySelector('.speak-menu'))`));
  })();
  check("…and clicking elsewhere dismisses it", gone);

  // ---- 设置 → 观察智能体 ----
  await ev(`document.querySelector('.rail-gear')?.click()`);
  await sleep(700);
  await ev(`[...document.querySelectorAll('.set-nav-cat')].find(b => b.textContent.trim() === '智能体')?.click()`);
  await sleep(400);
  const navItem = await ev(`[...document.querySelectorAll('.set-nav-item')].some(b => b.textContent.trim() === '观察智能体')`);
  check("设置 lists 观察智能体 under 智能体", navItem);
  await ev(`[...document.querySelectorAll('.set-nav-item')].find(b => b.textContent.trim() === '观察智能体')?.click()`);
  await sleep(500);
  const card = await waitFor(`Boolean(document.getElementById('set-observer'))`);
  check("the card renders", card);
  const cardText = await ev(`document.getElementById('set-observer')?.innerText ?? ''`);
  check("…says where the observer runs (its own scratch directory, not the project)",
    /observers/.test(cardText));
  check("…and what a brief costs (a model call only on turn-end)",
    /token/.test(cardText) && cardText.includes("回合结束"));
  const builtin = await ev(`document.querySelector('#set-observer .set-builtin-text')?.textContent ?? ''`);
  check("…showing the built-in persona it will actually send", builtin.includes("观察员") && builtin.includes("60"));

  // Toggle the switch and prove the server learned it.
  const beforeObserver = (await apiPrefs()).observer;
  await ev(`document.querySelector('#set-observer input[type=checkbox]').click()`);
  await sleep(1200);
  const afterObserver = (await apiPrefs()).observer;
  check("toggling 启用观察员 persists",
    afterObserver.enabled === !beforeObserver.enabled, JSON.stringify(afterObserver));

  // Typing a persona persists on blur. The textarea is disabled while the observer is off, so put the
  // switch back on first — a disabled box silently ignores typing, which is exactly what a sweep that
  // greps for "saved" would get wrong.
  if (!(await apiPrefs()).observer.enabled) {
    await ev(`document.querySelector('#set-observer input[type=checkbox]').click()`);
    await sleep(1000);
  }
  // Typing a persona persists on blur.
  await ev(`(() => {
    const ta = document.querySelectorAll('#set-observer textarea')[0];
    if (!ta) return false;
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, '你是我的播报员，只说事实，不超过三十字。');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    ta.blur();
    // React listens on focusout, not blur: dispatch both so the onBlur save really runs.
    ta.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    return true;
  })()`);
  await sleep(1200);
  const withPrompt = (await apiPrefs()).observer;
  check("the observer's own wording is saved as written",
    withPrompt.systemPrompt.includes("只说事实"), JSON.stringify(withPrompt.systemPrompt));
} finally {
  // put everything back
  await ev(`(async () => { await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prefs: { speakMode: ${JSON.stringify(original.prefs.speakMode)} }, observer: ${JSON.stringify(original.observer)} }) }); })()`).catch(() => {});
  await fetch(`${CDP}/json/close/${t.id}`).catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
