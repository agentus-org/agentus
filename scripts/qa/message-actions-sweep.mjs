// QA: message-level actions — copy on every message, fork on the LAST message only.
//   node m_msg_qa.mjs        (scratch instance on :8901, user's Edge over CDP)
const CDP = "http://127.0.0.1:9222";
const BASE = process.env.BASE ?? "http://127.0.0.1:8901";   // scratch instance (launch_scratch.py)
const U = process.env.QA_USER ?? "scratch", P = process.env.QA_PASS ?? "scratch-pass-1";
const SHOTS = process.env.SHOTS ?? new URL("../../../../tasks/20261001-agentslot/screens", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = await import("node:fs");
let pass = 0, fail = 0;
const check = (n, ok, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? `  — ${d}` : ""}`); };

const t = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(2600);
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const w = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && w.has(m.id)) { const x = w.get(m.id); w.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); } };
const send = (m, p = {}, to = 30000) => new Promise((res, rej) => {
  const mid = ++id; const timer = setTimeout(() => { w.delete(mid); rej(new Error("TIMEOUT " + m)); }, to);
  w.set(mid, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method: m, params: p }));
});
const ev = async (x, to = 30000) => {
  const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }, to);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(300);

await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
// one live session, two turns: enough to tell "last message" from "not last"
const sid = await ev(`(async () => {
  const s = await fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({backend:'mock',cwd:'/tmp'})}).then(r=>r.json());
  for (const text of ['第一条：把会话列表压成一行', '第二条：给每条消息加复制']) {
    await fetch('/api/sessions/'+s.id+'/prompt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})});
    await new Promise((r)=>setTimeout(r, 2500));
  }
  return s.id; })()`);
await send("Page.reload", { ignoreCache: true });
await sleep(3500);
await ev(`(async () => { const api = await fetch('/api/sessions').then(r=>r.json());
  const me = [...api.live,...api.archived].find(s=>s.id===${JSON.stringify(sid)});
  localStorage.setItem('agentslot.active', ${JSON.stringify(sid)});
  return me?.title; })()`);
await send("Page.reload", { ignoreCache: true });
await sleep(3500);

const shape = await ev(`(() => {
  const bubbles = [...document.querySelectorAll('.msg')].filter((m) => m.querySelector('.bubble'));
  const user = [...document.querySelectorAll('.msg.user')];
  const agent = [...document.querySelectorAll('.msg.agent')];
  const lastAgent = agent[agent.length - 1];
  return {
    users: user.length, agents: agent.length,
    userCopies: user.filter((m) => m.querySelector('.bubble-btn.copy')).length,
    agentCopies: agent.filter((m) => m.querySelector('.bubble-btn.copy')).length,
    forks: document.querySelectorAll('.bubble-btn.fork').length,
    forkOnLast: !!lastAgent?.querySelector('.bubble-btn.fork'),
    forkOnFirst: !!agent[0]?.querySelector('.bubble-btn.fork'),
    agentHasSpeak: agent.every((m) => m.querySelector('.bubble-btn:not(.copy):not(.fork)') || m.querySelector('button')),
    actionsOpacity: agent.length ? getComputedStyle(lastAgent.querySelector('.bubble-actions')).opacity : null,
  };
})()`);
check("every user message has a copy button", shape.users > 0 && shape.userCopies === shape.users, JSON.stringify({ users: shape.users, copies: shape.userCopies }));
check("every agent message has a copy button", shape.agents > 0 && shape.agentCopies === shape.agents, JSON.stringify({ agents: shape.agents, copies: shape.agentCopies }));
check("fork appears on the LAST message only", shape.forks === 1 && shape.forkOnLast && !shape.forkOnFirst, JSON.stringify({ forks: shape.forks, last: shape.forkOnLast, first: shape.forkOnFirst }));

// the copy button must put the RIGHT text on the clipboard — on this origin (plain http,
// LAN-style) navigator.clipboard is undefined, so the textarea fallback is what runs. Hook
// execCommand to capture exactly what the page handed to the clipboard.
// Force the FALLBACK path: 127.0.0.1 counts as a secure context, but the cockpit's LAN
// entry (http://192.168.x.x:8787) does not — so the textarea+execCommand branch is the one
// that runs out there. Two steps, because a synthetic .click() carries no user activation
// and Chromium then refuses the clipboard write: stage everything in one evaluate, press
// with a TRUSTED input event, then read the result back.
await ev(`(() => {
  window.__copied = null;
  window.__origExec = document.execCommand;
  document.execCommand = (cmd) => { window.__copied = document.querySelector('textarea[readonly]')?.value ?? null; return window.__origExec.call(document, cmd); };
  window.__desc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  // a trusted click is dispatched at viewport coordinates, so the target has to be IN the
  // viewport — the first user bubble sits above the fold in a scrolled transcript
  document.querySelector('.msg.user .bubble-btn.copy').scrollIntoView({ block: 'center' });
  return true; })()`);
await sleep(400);
const staged = await ev(`(() => { const btn = document.querySelector('.msg.user .bubble-btn.copy');
  const r = btn.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, onScreen: r.top >= 0 && r.bottom <= innerHeight,
    bubble: document.querySelector('.msg.user .bubble').innerText.trim() }; })()`);
check("the copy button under test is on screen (a trusted click needs viewport coords)", staged.onScreen === true, JSON.stringify({ y: Math.round(staged.y) }));
for (const type of ["mousePressed", "mouseReleased"]) {
  await send("Input.dispatchMouseEvent", { type, x: staged.x, y: staged.y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
}
await sleep(900);
const fallback = await ev(`(() => {
  const out = { state: document.querySelector('.msg.user .bubble-btn.copy').dataset.copyState, copied: window.__copied, bubble: ${JSON.stringify("")} };
  document.execCommand = window.__origExec;
  if (window.__desc) Object.defineProperty(navigator, 'clipboard', window.__desc); else delete navigator.clipboard;
  return out; })()`);
check("copy reports success through the no-secure-context fallback (trusted click)",
  fallback.state === "ok", JSON.stringify({ state: fallback.state }));
check("the fallback hands over exactly the message text",
  Boolean(fallback.copied) && fallback.copied === staged.bubble.replace(/\n+$/, ""),
  JSON.stringify({ copied: (fallback.copied ?? "").slice(0, 40), bubble: staged.bubble.slice(0, 40) }));

// And on the origin where the modern API exists (localhost/https), read the clipboard back.
await send("Browser.grantPermissions", { origin: BASE, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] }).catch(() => {});
const rect2 = await ev(`(() => { const b = document.querySelector('.msg.agent .bubble-btn.copy'); const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: document.querySelector('.msg.agent .bubble').innerText.trim() }; })()`);
for (const type of ["mousePressed", "mouseReleased"]) {
  await send("Input.dispatchMouseEvent", { type, x: rect2.x, y: rect2.y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
}
await sleep(900);
const roundTrip = await ev(`(async () => {
  const btn = document.querySelector('.msg.agent .bubble-btn.copy');
  let read = null;
  try { read = await navigator.clipboard.readText(); } catch (e) { read = "read-failed: " + String(e.message ?? e); }
  return { has: Boolean(navigator.clipboard?.writeText), state: btn.dataset.copyState, read: String(read).slice(0, 60) }; })()`);
check("on a secure origin the clipboard API round-trips the agent reply",
  roundTrip.has && roundTrip.state === "ok" && roundTrip.read.startsWith(rect2.text.slice(0, 20)),
  JSON.stringify({ state: roundTrip.state, read: roundTrip.read.slice(0, 40), expected: rect2.text.slice(0, 30) }));

const shot1 = await send("Page.captureScreenshot", { format: "png" }, 25000);
fs.writeFileSync(`${SHOTS}/desktop-msg-actions.png`, Buffer.from(shot1.data, "base64"));

// --- fork from the tail
const before = await ev(`document.querySelectorAll('.session-item').length`);
await ev(`document.querySelector('.bubble-btn.fork').click()`);
await sleep(4000);
const after = await ev(`(async () => { const titles=[...document.querySelectorAll('.session-item .title')].map((t)=>t.textContent);
  const api=await fetch('/api/sessions').then(r=>r.json());
  return { rows: titles.length, forked: titles.filter((x)=>x.includes('fork')), apiForked: [...api.live,...api.archived].filter(s=>s.title.includes('fork')).length, active: document.querySelector('.session-item.active .title')?.textContent ?? null }; })()`);
check("forking from the tail creates a new session", after.rows > before && after.forked.length >= 1, JSON.stringify({ before, after: after.rows, forked: after.forked }));
check("the fork is the session you land in", after.active && after.active.includes("fork"), `active=${after.active}`);

// --- phone: the message actions stay reachable (hover is not a thing on touch)
// (the fork above landed us in the new session, which is still loading its transcript —
//  go back to the conversation that has the two turns)
await ev(`localStorage.setItem('agentslot.active', ${JSON.stringify(sid)})`);
await send("Page.reload", { ignoreCache: true });
for (let i = 0; i < 20; i++) { await sleep(500); if (await ev(`document.querySelectorAll('.msg.agent').length > 0`)) break; }
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await sleep(600);
const phone = await ev(`(() => {
  const copy = document.querySelector('.msg.agent .bubble-btn.copy');
  const fork = document.querySelector('.bubble-btn.fork');
  const r = copy?.getBoundingClientRect();
  return { copyVisible: r ? Math.round(r.width) : 0, copyH: r ? Math.round(r.height) : 0,
    actionsOpacity: copy ? getComputedStyle(copy.closest('.bubble-actions')).opacity : null,
    forkExists: !!fork, overflowX: document.documentElement.scrollWidth - window.innerWidth }; })()`);
check("message actions are visible without hover on a phone", Number(phone.actionsOpacity) > 0.5, `opacity=${phone.actionsOpacity}`);
check("the copy/fork hit areas are thumb-sized", phone.copyVisible >= 28 && phone.copyH >= 20, JSON.stringify({ w: phone.copyVisible, h: phone.copyH }));
check("no horizontal overflow at 390px", phone.overflowX === 0, `overflow=${phone.overflowX}`);
const shot2 = await send("Page.captureScreenshot", { format: "png" }, 25000);
fs.writeFileSync(`${SHOTS}/phone-msg-actions.png`, Buffer.from(shot2.data, "base64"));

console.log(`\n${pass} passed, ${fail} failed`);
await fetch(`${CDP}/json/close/${t.id}`).catch(() => {});
process.exit(fail ? 1 : 0);
