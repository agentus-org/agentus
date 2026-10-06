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
/** Answer an option the way a THUMB or a mouse does: real pointer events at the button's
 *  centre. A programmatic `.click()` succeeds even when something transparent covers the
 *  button — exactly the failure the operator reported ("弹窗点击不了") and exactly why the
 *  first version of this sweep was green while the surface was unusable for him. */
const clickAt = async (sel, re) => {
  const box = await ev(`(() => {
    const host = document.querySelector('.perm-dialog') ?? document.querySelector('.perm-card');
    if (!host) return null;
    const b = ${sel ? `host.querySelector(${JSON.stringify(sel)})` : `[...host.querySelectorAll('button')].find((x) => ${re}.test(x.textContent || ''))`};
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) };
  })()`);
  if (!box) return false;
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await sleep(350);
  return true;
};
const clickOption = (re) => clickAt("", re);

/** The same on a touch screen: a phone taps, it does not move a mouse. */
const tapOption = async (re) => {
  const box = await ev(`(() => {
    const host = document.querySelector('.perm-dialog') ?? document.querySelector('.perm-card');
    const b = host && [...host.querySelectorAll('button')].find((x) => ${re}.test(x.textContent || ''));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) };
  })()`);
  if (!box) return false;
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x, y: box.y }] });
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(350);
  return true;
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
// something" is not an approval an operator can give. (The assertions that used to live here —
// `.perm-file code` / `.perm-side` — moved to the change-row block below, which is what the
// surface actually renders now: a collapsed row you click, not two whole files.)
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

// --- "diff 太多了": the change is a ROW you click, collapsed by default -----------------
const collapsed = await ev(`(() => {
  const d = document.querySelector('.perm-dialog') ?? document.querySelector('.perm-card');
  const row = d?.querySelector('.perm-change-row');
  return {
    row: Boolean(row),
    path: row?.querySelector('code')?.textContent ?? '',
    counts: row?.querySelector('.perm-counts')?.textContent ?? '',
    aria: row?.getAttribute('aria-expanded') ?? '',
    diffShown: Boolean(d?.querySelector('.perm-diff')),
    note: Boolean(d?.querySelector('.perm-cut')),
    textLen: (d?.textContent ?? '').length,
  }; })()`);
check("the change starts as ONE collapsed row (file + ＋N −M), not a wall of text",
  collapsed.row && !collapsed.diffShown && /\+/.test(collapsed.counts) && collapsed.aria === "false",
  JSON.stringify(collapsed));
check("…and that row names the file the change is in",
  collapsed.path === "/tmp/mock-approval/demo-edit.txt", collapsed.path);
check("a change this small is the WHOLE proposal — no “only part of it is shown” note",
  collapsed.note === false, JSON.stringify({ note: collapsed.note }));

check("clicking the row with a real pointer opens the diff", await clickAt(".perm-change-row"));
const expanded = await ev(`(() => {
  const d = document.querySelector('.perm-dialog') ?? document.querySelector('.perm-card');
  const box = d?.querySelector('.perm-diff');
  return {
    open: Boolean(box),
    lines: d?.querySelectorAll('.perm-diff-line').length ?? 0,
    add: d?.querySelectorAll('.perm-diff-line.add').length ?? 0,
    del: d?.querySelectorAll('.perm-diff-line.del').length ?? 0,
    gaps: d?.querySelectorAll('.perm-diff-gap').length ?? 0,
    text: box?.textContent ?? "",
    total: (d?.textContent ?? "").length,
  }; })()`);
check("…and it shows the CHANGE: the added line, marked, not the whole file",
  expanded.open && expanded.add >= 1 && /你好/.test(expanded.text), JSON.stringify(expanded));
check("the unchanged parts are collapsed into a counted gap instead of reprinted",
  expanded.gaps >= 1 || expanded.lines <= 8, JSON.stringify(expanded));
await send("Page.captureScreenshot", { format: "png" }, 25000).then((s) =>
  fs.writeFileSync(`${SHOTS}/approval-diff-open.png`, Buffer.from(s.data, "base64")));
check("clicking again folds it back (the default state is the quiet one)", await clickAt(".perm-change-row"),
  "row toggled");
const refolded = await ev(`Boolean(document.querySelector('.perm-diff'))`);
check("…and it really is collapsed again", refolded === false, `diffShown=${refolded}`);

// --- the operator's other complaint: "别的页面刷新的时候还看不到审批弹窗" ------------------
// A request that is still waiting is STATE, not an event: nothing can arrive on a page that was
// not there when it was raised, so the server has to hand it over with the session list.
const reqId = await ev(`document.querySelector('.perm-dialog')?.dataset.requestId ?? ''`);
const pendingNow = await ev(`fetch('/api/sessions').then((r) => r.json()).then((d) => (d.pending || []).map((p) => ({ id: p.requestId, sid: p.sessionId, file: p.diff?.path ?? p.path ?? '' })))`);
check("a request still waiting is part of what the server hands to a connecting page",
  pendingNow.some((p) => p.id === reqId && /demo-edit\.txt$/.test(p.file)), JSON.stringify({ reqId, pendingNow }));
await send("Page.reload");
await sleep(4000);
const reloaded = await waitSurface(20000);
check("…and a page that (re)loads AFTER the request was raised still shows it",
  reloaded.hasDialog || reloaded.hasCard, `card=${reloaded.hasCard} dialog=${reloaded.hasDialog}`);
check("the reloaded page drew it as a dialog again (not only as a transcript card)",
  reloaded.hasDialog, JSON.stringify({ card: reloaded.hasCard, dialog: reloaded.hasDialog }));

// --- 「稍后处理」 must unblock the UI, not drop the request ------------------------------
// The dialog is modal, and its backdrop covers everything — measured: while a request was up,
// the rail's own 「+」 hit-tested to `modal-bg perm-bg`, so a request in ONE session made every
// other session unreachable until it was answered (that is also what "弹窗点击不了" looks like
// from the operator's side). Dismissing has to leave the request answerable, not lose it.
await ev(`(() => { const b = [...document.querySelectorAll('.perm-dialog button')].find((x) => /稍后处理/.test(x.textContent || '')); b?.click(); return true; })()`);
await sleep(400);
const skipped = await ev(`(() => ({
  dialog: Boolean(document.querySelector('.perm-dialog')),
  backdrop: Boolean(document.querySelector('.modal-bg.perm-bg')),
  card: Boolean(document.querySelector('.perm-card')),
  chip: (document.querySelector('.perm-chip')?.textContent || '').trim(),
  railReachable: (() => {
    const add = document.querySelector('.group-add');
    if (!add) return null;
    const r = add.getBoundingClientRect();
    const el = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    return Boolean(el) && (add.contains(el) || el.contains(add));
  })(),
}))()`);
check("「稍后处理」 closes the dialog and lifts the backdrop off the UI",
  skipped.dialog === false && skipped.backdrop === false, JSON.stringify(skipped));
check("…the request is still there to answer: the inline card and the header chip survive",
  skipped.card === true && /⚿/.test(skipped.chip), JSON.stringify({ card: skipped.card, chip: skipped.chip }));
check("…and the rest of the cockpit is usable again (the rail hit-tests to itself)",
  skipped.railReachable === true, `railReachable=${skipped.railReachable}`);
const reopen = await ev(`(() => { const c = document.querySelector('.perm-chip'); if (!c) return false; c.click(); return true; })()`);
await sleep(300);
check("the ⚿ chip reopens the dialog for a request that was put aside",
  reopen && (await ev(`Boolean(document.querySelector('.perm-dialog'))`)) === true,
  `clicked=${reopen} dialog=${await ev(`Boolean(document.querySelector('.perm-dialog'))`)}`);

// --- answering it: allow -------------------------------------------------------------
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

// --- an answer for a request that is gone must SAY SO, not look like a broken button ----
// The server can no longer hold it (its own timeout fired, or the agent gave up first) and
// now answers the page with an event instead of silently returning false: a click that does
// nothing is the one failure an operator cannot tell from a broken button.
const tok = fs.readFileSync(`${process.env.AGENTSLOT_DATA ?? "/tmp/agentslot-qa-account"}/auth.token`, "utf8").trim();
const wsq = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(tok)}`);
const expired = await new Promise((res) => {
  wsq.addEventListener("open", () => {
    wsq.send(JSON.stringify({
      t: "respond-permission", sessionId: sid, requestId: "no-such-request",
      decision: { outcome: "cancelled" },
    }));
  });
  wsq.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "permission-expired") res(m);
  });
  setTimeout(() => res(null), 8000);
});
wsq.close();
check("an answer for a request the server no longer holds is reported back, not dropped",
  expired?.requestId === "no-such-request", JSON.stringify(expired));

// --- the REAL hermes shape: two options, one whole file before and after ----------------
// Mirrors hermes' `acp_adapter/edit_approval.py`: the options are `allow_once` "Allow edit"
// and `deny` "Deny", and the payload is the ENTIRE file in oldText and newText. The cockpit
// must not invent options, must reduce 83 lines to the one that changed, and must hand back the
// optionId the agent offered — `allow_once` is the only thing hermes accepts as an approval.
await prompt("[tool-hermes]");
const hSurf = await waitSurface(30000);
check("a hermes-shaped edit request surfaces", hSurf.hasDialog, JSON.stringify(hSurf));
const hOpts = await ev(`[...document.querySelectorAll('.perm-dialog button')].map((b) => (b.textContent || '').trim())`);
check("the options are the AGENT's (Allow edit / Deny) — nothing invented on top",
  hOpts.includes("Allow edit") && hOpts.includes("Deny"), JSON.stringify(hOpts));
const hRow = await ev(`(() => { const r = document.querySelector('.perm-change-row');
  return {
    path: r?.querySelector('code')?.textContent ?? '',
    counts: r?.querySelector('.perm-counts')?.textContent ?? '',
    diffShown: Boolean(document.querySelector('.perm-diff')),
  }; })()`);
check("an 83-line file is still ONE row with ＋1 −1 counts, not 166 printed lines",
  /hermes-real-shape\.txt$/.test(hRow.path) && /\+1/.test(hRow.counts) && !hRow.diffShown,
  JSON.stringify(hRow));
check("expanding that row opens the change", await clickAt(".perm-change-row"));
const hDiff = await ev(`(() => { const d = document.querySelector('.perm-diff');
  return {
    lines: d?.querySelectorAll('.perm-diff-line').length ?? 0,
    gaps: d?.querySelectorAll('.perm-diff-gap').length ?? 0,
    del: d?.querySelectorAll('.perm-diff-line.del').length ?? 0,
    add: d?.querySelectorAll('.perm-diff-line.add').length ?? 0,
    note: Boolean(d?.parentElement?.querySelector('.perm-cut')),
    text: d?.textContent ?? '',
  }; })()`);
check("…and shows the changed line with the 80 unchanged ones folded into a counted gap",
  hDiff.add >= 1 && hDiff.gaps >= 1 && hDiff.lines <= 14, JSON.stringify(hDiff));
check("…and SAYS that the 83-line file was narrowed down for it", hDiff.note === true,
  JSON.stringify({ note: hDiff.note }));
check("…and the “before” line is there, so the operator sees what is being replaced",
  /hello/.test(hDiff.text), hDiff.text.slice(0, 60));
check("answering picks the agent's own option", await clickOption(/allow edit/i));
// the transcript already holds an earlier "chosen option: allow" — count them, so this reads
// the NEW answer rather than the first one it happens to find
const optCount = await ev(`[...((document.querySelector('.stream') || {}).textContent || '').matchAll(/chosen option: \\w+/g)].length`);
let hLoop = null;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  await ev(`[...document.querySelectorAll('.tool-head')].forEach((b) => { if (b.getAttribute('aria-expanded') === 'false') b.click(); })`);
  hLoop = await ev(`(() => { const txt = document.querySelector('.stream')?.textContent || '';
    const all = [...txt.matchAll(/chosen option: \\w+/g)].map((m) => m[0]);
    return { out: all[all.length - 1] ?? '', count: all.length,
      pending: Boolean(document.querySelector('.perm-card') || document.querySelector('.perm-dialog')) }; })()`);
  if (hLoop.count > optCount) break;
}
check("the agent got back EXACTLY the optionId it offered (allow_once — hermes takes nothing else)",
  hLoop?.out === "chosen option: allow_once", JSON.stringify({ ...hLoop, optCount }));

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
await tapOption(/reject|拒绝/i);

console.log(`\n${pass} passed, ${fail} failed`);
console.log("shots: approval-desktop.png, approval-phone.png");
await fetch(`${CDP}/json/close/${t.id}`).catch(() => {});
process.exit(fail ? 1 : 0);
