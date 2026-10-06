// QA: the approval surface — an agent's permission request must reach the operator
// WHERE THEY ARE LOOKING, and the answer must land back in the agent.
//
//   node scripts/qa/permission-sweep.mjs
//
// Drives the user's Edge over raw CDP against the DEV instance (:8901, scripts/dev.sh), with
// the MOCK backend so the whole loop costs no tokens: a prompt containing `[tool]` makes the
// mock send a real `session/request_permission` (three options: Allow / Always Allow / Reject)
// and then report the chosen outcome in its own tool_call_update.
//
// The failure this sweep exists for (measured 2026-10-06): the request was drawn ABOVE the
// whole transcript (App.tsx rendered `v.perms` before `v.msgs`), so in a conversation longer
// than one screen the operator saw nothing at all while the agent sat blocked — and the agent
// self-denied 60s later ("Edit approval denied by ACP client" arrived as a tool error).
const CDP = "http://127.0.0.1:9222";
const BASE = process.env.BASE ?? "http://127.0.0.1:8901";   // dev instance (scripts/dev.sh start)
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

/** Poll for the surface: a mock turn takes a moment, and a fixed sleep makes this sweep
 *  report "it never surfaced" for a request that was simply a beat late. */
const waitSurface = async (ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    const s = await ev(READ_SURFACE);
    if (s.hasCard || s.hasDialog) return s;
    if (Date.now() - t0 > ms) return s;
    await sleep(400);
  }
};

/** Everything the sweep reads off the page about the pending-request surface. */
const READ_SURFACE = `(() => {
  const dialog = document.querySelector('.perm-dialog');
  const card = document.querySelector('.perm-card');
  const host = dialog ?? card;
  const r = host ? host.getBoundingClientRect() : null;
  const stream = document.querySelector('.stream');
  const btns = host ? [...host.querySelectorAll('button')] : [];
  return {
    hasDialog: Boolean(dialog),
    hasCard: Boolean(card),
    rect: r ? { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) } : null,
    inViewport: Boolean(r) && r.top >= 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
    vw: innerWidth, vh: innerHeight,
    stream: stream ? { top: Math.round(stream.scrollTop), height: Math.round(stream.clientHeight), scroll: Math.round(stream.scrollHeight) } : null,
    labels: btns.map((b) => (b.textContent || '').trim()).filter(Boolean),
    reachable: btns.map((b) => {
      const q = b.getBoundingClientRect();
      const el = document.elementFromPoint((q.left + q.right) / 2, (q.top + q.bottom) / 2);
      return Boolean(el) && (b.contains(el) || el.contains(b));
    }),
    taps: btns.map((b) => { const q = b.getBoundingClientRect(); return [Math.round(q.width), Math.round(q.height)]; }),
  };
})()`;

// --- login + a session on the MOCK backend ------------------------------------------
await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
const sess = await ev(`fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({backend:'mock',cwd:'/tmp',title:'approval sweep'})}).then(r=>r.json())`);
check("the sweep could open a mock session (no tokens are spent by this sweep)", Boolean(sess?.id), JSON.stringify(sess).slice(0, 200));
const sid = sess.id;

// Fill the transcript past one screen — the request must reach an operator who is
// following a LONG conversation, not a one-bubble toy.
const status = async () => ev(`fetch('/api/sessions').then(r=>r.json()).then(d=>(d.live||[]).find(s=>s.id===${JSON.stringify(sid)})?.status||'')`).catch(() => "");
const idle = async (ms = 30000) => {
  const t0 = Date.now();
  for (;;) {
    const st = await status();
    if (st !== "running" && st !== "starting") return st;
    if (Date.now() - t0 > ms) return st;
    await sleep(300);
  }
};
const prompt = async (text) => {
  // A prompt sent while a turn is still running is REFUSED by the server ("turn already
  // running", measured): waiting for the previous turn first is what makes the sequence real
  // rather than a sweep quietly exercising nothing.
  await idle();
  const code = await ev(`fetch('/api/sessions/${sid}/prompt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:${JSON.stringify(text)}})}).then(r=>r.status)`);
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    if ((await status()) !== "running") break;
  }
  return code;
};
for (let i = 1; i <= 10; i++) await prompt(`filler ${i}: keep the conversation long enough to scroll`);
await ev(`location.href = ${JSON.stringify(BASE + "/?session=" + sid)}`);
await sleep(3200);

const filled = await ev(`(() => { const s = document.querySelector('.stream');
  return { bubbles: document.querySelectorAll('.msg').length, scroll: s.scrollHeight, client: s.clientHeight, top: s.scrollTop }; })()`);
check("the conversation is longer than one screen (otherwise this sweep proves nothing)",
  filled.scroll > filled.client * 2, JSON.stringify(filled));

// --- the request itself --------------------------------------------------------------
const firstCode = await prompt("[tool-diff]");
check("the prompting request was ACCEPTED (a refused prompt would test nothing)", firstCode === 202 || firstCode === 200, `HTTP ${firstCode}`);
const surfaced = await waitSurface();
const reached = surfaced.hasCard || surfaced.hasDialog;
// An edit approval must say WHICH file and WHAT changes — "the agent wants to edit
// something" is not an approval an operator can give.
const subject = await ev(`(() => {
  const d = document.querySelector('.perm-dialog') ?? document.querySelector('.perm-card');
  return {
    file: d?.querySelector('.perm-file code')?.textContent ?? '',
    old: d?.querySelector('.perm-side.old')?.textContent ?? '',
    neu: d?.querySelector('.perm-side.new')?.textContent ?? '',
  }; })()`);
check("the surface names the FILE the request is about (not just “an edit”)",
  subject.file === "/tmp/mock-approval/demo-edit.txt", JSON.stringify(subject.file));
check("…and shows the change itself: before and after, verbatim from the agent",
  /hello/.test(subject.old) && /你好/.test(subject.neu), JSON.stringify({ old: subject.old.slice(0, 40), neu: subject.neu.slice(0, 40) }));
check("the agent's permission request reaches the page", reached,
  `card=${surfaced.hasCard} dialog=${surfaced.hasDialog}`);
check("the request is drawn INSIDE the viewport the operator is looking at", surfaced.inViewport,
  `rect=${JSON.stringify(surfaced.rect)} viewport=${surfaced.vw}x${surfaced.vh} stream=${JSON.stringify(surfaced.stream)}`);
check("it is not the transcript's first child (a request is about the turn happening NOW)",
  await ev(`(() => { const host = document.querySelector('.perm-dialog') ?? document.querySelector('.perm-card');
    const first = document.querySelector('.stream-inner')?.firstElementChild;
    return Boolean(host) && host !== first && !first?.contains(host); })()`), "");

if (!reached) {
  console.log("\nthe request never surfaced — nothing further can be checked");
  console.log(`\n${pass} passed, ${fail} failed`);
  await fetch(`${CDP}/json/close/${t.id}`).catch(() => {});
  process.exit(1);
}

await send("Page.captureScreenshot", { format: "png" }, 25000).then((s) =>
  fs.writeFileSync(`${SHOTS}/approval-desktop.png`, Buffer.from(s.data, "base64")));

// --- answering it: allow -------------------------------------------------------------
const clickOption = async (re) => ev(`(() => {
  const host = document.querySelector('.perm-dialog') ?? document.querySelector('.perm-card');
  if (!host) return false;
  const btn = [...host.querySelectorAll('button')].find((b) => ${re}.test(b.textContent || ''));
  if (!btn) return false;
  btn.click(); return true; })()`);
check("an allow option is offered with the AGENT's own label", await clickOption(/allow|允许/i),
  JSON.stringify(surfaced.labels));

// the mock reports the chosen outcome in its own tool_call_update — that is the proof the
// answer travelled all the way back to the agent, not merely into our own store.
let loop = null;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  // the agent's own tool output lives in the tool card, which is collapsed by default —
  // expand whatever has a body so the assertion reads what the operator can read
  await ev(`[...document.querySelectorAll('.tool-head')].forEach((b) => { if (b.getAttribute('aria-expanded') === 'false') b.click(); })`);
  loop = await ev(`(() => { const txt = document.querySelector('.stream')?.textContent || '';
    return { wrote: /wrote 24 bytes to \\.\\/demo\\.txt/.test(txt), pending: Boolean(document.querySelector('.perm-card') || document.querySelector('.perm-dialog')) }; })()`);
  if (loop.wrote) break;
}
check("the answer reached the agent (its own tool output says the write happened)", loop?.wrote,
  JSON.stringify(loop));
check("the request surface is gone once answered", loop && !loop.pending, JSON.stringify(loop));

// --- a second request, answered with the reject option -------------------------------
await prompt("[tool]");
const second = await waitSurface();
check("a second request surfaces as well (and the surface is not a one-shot)", second.hasCard || second.hasDialog,
  `card=${second.hasCard} dialog=${second.hasDialog} inViewport=${second.inViewport}`);
check("the reject path is offered too", await clickOption(/reject|拒绝/i), JSON.stringify(second.labels));
let rejected = null;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  await ev(`[...document.querySelectorAll('.tool-head')].forEach((b) => { if (b.getAttribute('aria-expanded') === 'false') b.click(); })`);
  rejected = await ev(`(() => { const txt = document.querySelector('.stream')?.textContent || '';
    return { ok: /rejected by the operator/.test(txt), pending: Boolean(document.querySelector('.perm-card') || document.querySelector('.perm-dialog')) }; })()`);
  if (rejected.ok) break;
}
check("a reject reaches the agent too (nothing is written)", rejected?.ok, JSON.stringify(rejected));

// --- the phone: the surface must be usable on 390x844 --------------------------------
await setViewport(390, 844);
await ev(`document.querySelector('.stream').scrollTop = document.querySelector('.stream').scrollHeight`);
await sleep(400);
await prompt("[tool]");
const phone = await waitSurface();
const phoneShot = await send("Page.captureScreenshot", { format: "png" }, 25000);
fs.writeFileSync(`${SHOTS}/approval-phone.png`, Buffer.from(phoneShot.data, "base64"));
check("on a 390x844 phone the request is on screen", phone.inViewport,
  `rect=${JSON.stringify(phone.rect)} viewport=${phone.vw}x${phone.vh}`);
check("every option is a real tap target (>= 32px tall) and nothing covers it",
  phone.taps.length > 0 && phone.taps.every(([, h]) => h >= 32) && phone.reachable.every(Boolean),
  `taps=${JSON.stringify(phone.taps)} reachable=${JSON.stringify(phone.reachable)}`);
await clickOption(/reject|拒绝/i);

console.log(`\n${pass} passed, ${fail} failed`);
console.log("shots: approval-desktop.png, approval-phone.png");
await fetch(`${CDP}/json/close/${t.id}`).catch(() => {});
process.exit(fail ? 1 : 0);
