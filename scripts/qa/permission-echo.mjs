// QA: an approval must LEAVE the screen — and the operator must see his click land before any
// server round trip can come back. Drives the user's Edge over raw CDP against the DEV instance.
//
//   npm run permission-echo          (dev: :8901, mock backend, no tokens spent)
//   BASE=http://127.0.0.1:8788 npm run permission-echo     # any instance you can log into
//
// Why this exists next to `permission-sweep.mjs`: that sweep proves the request REACHES the
// operator and his answer lands in the agent. This one is about the three ways a request left the
// screen while the operator still saw it (all measured 2026-10-11, from the operator's own report
// 「我点了允许，它还在那儿，切到别的会话也还在」):
//
//   A. TWO requests in one session. The dialog draws only `perms[0]`, so answering the first swaps
//      in the second — same buttons, same layout, only the file name differs. Reads as a stuck
//      card. So: the dialog must SAY how many are behind it, and a click must be answered locally
//      (「✓ 已提交」) — measured with the network cut, where no server reply can arrive to clear
//      the surface for us. A second click on the same request must be impossible.
//   B. The agent process DIES with a request pending. The client's only ways to drop a request are
//      the `permission-resolved` event or a fresh `sessions` snapshot; four server-side paths used
//      to clear the map without either, so the dialog, the card and the ⚿ badge stayed for a
//      request that no longer existed.
//   C. A request on a row the rail FOLDS AWAY. The rail is the only place a waiting request is
//      announced for a session the operator is not in (`⚿ N` on the row, and the row is the way
//      in), and the dialog only draws the ACTIVE session's request — so a folded row is not a
//      hidden list item, it is a hidden request.
//
// The mock's `[tool2]` turn raises the two requests of A (packages/server/mock/agent.mjs).
//
// NOTE on identity: this script logs in over HTTP against `BASE` with the QA account and never
// reads a token file, so the host shell's `AGENTUS_DATA` (which points at the LIVE tree) cannot
// make it talk to the wrong instance — but it warns, because that trap has bitten three times.
const CDP = process.env.CDP ?? "http://127.0.0.1:9222";
const BASE = process.env.BASE ?? "http://127.0.0.1:8901";
const U = process.env.QA_USER ?? "scratch", P = process.env.QA_PASS ?? "scratch-pass-1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cp = await import("node:child_process");

if (process.env.AGENTUS_DATA?.includes("/worktrees/agentus/")) {
  console.log(`[permission-echo] note: your shell's AGENTUS_DATA points at the LIVE tree; this run`
    + ` talks to ${BASE} with the QA login and ignores it.`);
}

let ok = 0, bad = 0;
const check = (name, cond, detail = "") => {
  if (cond) { ok++; console.log(`  ok   ${name}`); }
  else { bad++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(2600);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const w = new Map(); const wire = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Network.webSocketFrameReceived") {
    try { const p = JSON.parse(m.params.response.payloadData); if (p?.t) wire.push(p.t); } catch { /* not ours */ }
  }
  if (m.id && w.has(m.id)) { const x = w.get(m.id); w.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); }
};
const send = (m, p = {}, to = 40000) => new Promise((res, rej) => {
  const mid = ++id; const timer = setTimeout(() => { w.delete(mid); rej(new Error("TIMEOUT " + m)); }, to);
  w.set(mid, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method: m, params: p }));
});
const ev = async (x, to = 40000) => {
  const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }, to);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};

/** Everything the approval surface shows, in one read: the popup, the transcript cards, the header
 *  chip, the rail badges and the fold label. `answered` is the LOCAL state a click produces. */
const READ = `(() => {
  const d = document.querySelector('.perm-dialog');
  return {
    hasDialog: Boolean(d),
    dialogReq: d ? d.dataset.requestId : null,
    dialogWaiting: d ? d.dataset.waiting : null,
    queue: d ? (d.querySelector('.perm-queue')?.innerText.replace(/\\n/g, ' ') ?? null) : null,
    answered: d ? (d.querySelector('.perm-answered')?.innerText.replace(/\\n/g, ' ') ?? null) : null,
    cards: [...document.querySelectorAll('.perm-card')].map((c) => ({
      text: c.innerText.replace(/\\n/g, ' | ').slice(0, 70),
      answered: (c.querySelector('.perm-answered')?.innerText.replace(/\\n/g, ' ') ?? null),
    })),
    chip: (document.querySelector('.perm-chip') || {}).innerText ?? null,
    railBadges: [...document.querySelectorAll('.badge.perm')].map((b) => b.innerText.trim()),
    rows: [...document.querySelectorAll('.session-item')].map((r) => ({
      title: (r.querySelector('.title') || {}).textContent ?? '',
      badge: (r.querySelector('.badge.perm') || {}).innerText ?? null,
    })),
    moreLabel: [...document.querySelectorAll('.rail-more')].map((b) => b.innerText.trim()),
    text: (document.querySelector('.stream') || {}).innerText ?? '',
  };
})()`;
const status = (sid) => ev(`fetch('/api/sessions').then(r=>r.json()).then(d=>(d.live||[]).find(s=>s.id===${JSON.stringify(sid)})?.status||'gone')`);
const pendingFor = async (sid) => (await ev("fetch('/api/sessions').then(r=>r.json()).then(d=>(d.pending||[]).map(p=>({sid:p.sessionId,rid:p.requestId})))"))
  .filter((p) => p.sid === sid);
const liveAll = () => ev("fetch('/api/sessions').then(r=>r.json()).then(d=>(d.live||[]).map(s=>s.id))");
const idle = async (sid, ms = 60000) => { const t0 = Date.now(); for (;;) { const st = await status(sid); if (st !== "running" && st !== "starting") return st; if (Date.now() - t0 > ms) return st; await sleep(300); } };
const newSession = (title) => ev(`fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({backend:'mock',cwd:'/tmp',title:${JSON.stringify(title)}})}).then(r=>r.json())`);
const prompt = (sid, text) => ev(`fetch('/api/sessions/${sid}/prompt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:${JSON.stringify(text)}})}).then(r=>r.status)`);
const goTo = async (sid) => { await send("Page.navigate", { url: BASE + "/?session=" + sid }); await sleep(4200); };
const offline = (on) => send("Network.emulateNetworkConditions", { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
const clickAllow = () => ev(`(() => {
  const b = [...document.querySelectorAll('.perm-dialog button')].find((x) => /allow|允许/i.test(x.innerText));
  if (!b) return 'no allow button';
  b.click();
  return b.innerText.trim();
})()`);
const expandToolRows = () => ev(`[...document.querySelectorAll('.tool-head')].forEach((b) => { if (b.getAttribute('aria-expanded') === 'false') b.click(); })`);
// The rail's 工作空间 section is remembered per browser profile; while folded, NO rows render at
// all — a property of the profile, not of the app.
const expandWorkspaces = () => ev(`(() => {
  const s = document.querySelector('.rail-section[data-section=workspaces]');
  if (s && s.getAttribute('aria-expanded') === 'false') s.click();
  return s ? s.getAttribute('aria-expanded') : 'missing';
})()`);

await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(700);
const login = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
check(`the sweep could log into ${BASE} as ${U}`, login === 200, `HTTP ${login}`);

// ---- clean slate: sessions left behind by an aborted earlier run still hold requests, and their
// ⚿ badges would be counted as this run's ------------------------------------------------------
const before = await liveAll();
await ev(`Promise.all(${JSON.stringify(before)}.map((s) => fetch('/api/sessions/' + s, { method: 'DELETE' }).then((r) => r.status).catch(() => 0)))`);
await sleep(1500);
check("the QA instance starts with no live session at all", (await liveAll()).length === 0,
  JSON.stringify({ deleted: before.length }));

// ═══ A. two requests in one session ═════════════════════════════════════════════════════════════
console.log("\n=== A. two requests at once ===");
const a = await newSession("QA echo — two approvals");
const sidA = a.id;
check("the mock session was created", Boolean(sidA), JSON.stringify(a).slice(0, 160));
await idle(sidA);
await goTo(sidA);
await expandWorkspaces();
await prompt(sidA, "[tool2] two writes at once");
let s = null;
for (let i = 0; i < 50; i++) { s = await ev(READ); if (s.hasDialog && s.cards.length >= 2) break; await sleep(300); }
check("the dialog is up for the requests", s.hasDialog, JSON.stringify(s.dialogReq));
check("…and says how many are waiting behind it (waiting=2, 「还有 1 个」)",
  s.dialogWaiting === "2" && /还有\s*1\s*个/.test(s.queue ?? ""), `waiting=${s.dialogWaiting} queue=${s.queue}`);
check("both requests are drawn in the transcript", s.cards.length === 2, JSON.stringify(s.cards.map((c) => c.text)));
check("the rail badges that row with the waiting count", s.railBadges.includes("⚿ 2"), JSON.stringify(s.railBadges));
check("the count belongs to that session only (exactly one badged row)",
  s.rows.filter((r) => r.badge).length === 1
  && s.rows.some((r) => r.title === "QA echo — two approvals" && r.badge === "⚿ 2"), JSON.stringify(s.rows));
check("the server holds exactly these two", (await pendingFor(sidA)).length === 2);

// ---- A2. the click has to be visible ON ITS OWN: cut the network, then click -------------------
console.log("\n  A2. clicking with the network down (the phone-on-a-tunnel case)");
await offline(true);
await sleep(500);
console.log("  offline click:", await clickAllow());
await sleep(900);
s = await ev(READ);
check("the click is answered in the dialog BEFORE any server reply can arrive",
  Boolean(s.answered) && /已提交/.test(s.answered), JSON.stringify(s.answered));
check("…and the transcript card says the same, so the state is not dialog-only",
  s.cards.some((c) => c.answered && /已提交/.test(c.answered)), JSON.stringify(s.cards));
// It is a STATE, not a flash: hold the network down and it is still there a second later. (What the
// server holds cannot be asked from here while the page has no network — checked on reconnect.)
await sleep(1200);
const held = await ev(`(() => {
  const d = document.querySelector('.perm-dialog'), c = document.querySelector('.perm-card');
  return { dialog: d ? d.querySelector('.perm-answered')?.innerText ?? null : null,
           card: c ? c.querySelector('.perm-answered')?.innerText ?? null : null };
})()`);
check("…and it stays put while the answer is still in flight",
  /已提交/.test(held.dialog ?? "") && /已提交/.test(held.card ?? ""), JSON.stringify(held));
check("…and the same request cannot be answered twice",
  (await clickAllow()) === "no allow button", "a second Allow was still clickable");

// ---- A3. back online: the queued answer lands, and the surface moves on ------------------------
await offline(false);
console.log("\n  A3. back online");
await sleep(2500);
s = await ev(READ);
check("the queued answer reached the server", (await pendingFor(sidA)).length === 1);
check("the surface moved to the SECOND request (never the same card twice)",
  s.hasDialog && s.dialogReq !== null && s.dialogWaiting === "1",
  JSON.stringify({ req: s.dialogReq, waiting: s.dialogWaiting }));
check("one request left, so no 「还有 N 个」 hint any more", s.queue === null, `queue=${s.queue}`);
check("one card left in the transcript", s.cards.length === 1, JSON.stringify(s.cards.map((c) => c.text)));
const firstReq = s.dialogReq;
await clickAllow();
for (let i = 0; i < 30; i++) { s = await ev(READ); if (!s.hasDialog && !s.cards.length) break; await sleep(300); }
check("no dialog left", !s.hasDialog, JSON.stringify(s.dialogReq));
check("no approval card left in the transcript", s.cards.length === 0, JSON.stringify(s.cards));
check("no ⚿ chip left in the header", !s.chip, String(s.chip));
check("no ⚿ badge left in the rail", !s.railBadges.length, JSON.stringify(s.railBadges));
check("…and it was a different request than the first one", firstReq !== null && s.dialogReq === null,
  `first=${firstReq}`);
await sleep(2500);
await expandToolRows();
s = await ev(READ);
const answered = (s.text.match(/chosen option: allow/g) || []).length;
check("the agent received BOTH answers (its own tool output says so twice)", answered >= 2, `${answered} in the transcript`);
check("no answer was dropped by the server", !wire.includes("permission-expired"), JSON.stringify(wire.slice(-6)));

// ═══ B. the agent process dies with a request pending ═══════════════════════════════════════════
console.log("\n=== B. the agent dies with a request pending ===");
const b = await newSession("QA echo — agent dies");
const sidB = b.id, pidB = b.pid;
await idle(sidB);
await goTo(sidB);
await expandWorkspaces();
await prompt(sidB, "[tool-hermes] write one file");
s = null;
for (let i = 0; i < 50; i++) { s = await ev(READ); if (s.hasDialog) break; await sleep(300); }
check("the request is up (nothing to clear otherwise)", s.hasDialog, JSON.stringify(s.dialogReq));
const rowB = () => s.rows.find((r) => r.title === "QA echo — agent dies");
check("its rail row carries the ⚿ badge while it waits", rowB()?.badge === "⚿ 1", JSON.stringify(s.rows));
wire.length = 0;
cp.execSync(`kill -9 ${pidB}`);
console.log(`  killed the mock child ${pidB}`);
for (let i = 0; i < 40; i++) { s = await ev(READ); if (!s.hasDialog && !s.cards.length) break; await sleep(300); }
check("the server ANNOUNCED the drop on the wire (permission-resolved)", wire.includes("permission-resolved"), JSON.stringify(wire));
check("the dialog went away by itself", !s.hasDialog, JSON.stringify(s.dialogReq));
check("the transcript card went away too", s.cards.length === 0, JSON.stringify(s.cards));
check("that row's ⚿ badge went away", !rowB()?.badge, JSON.stringify(s.rows));
check("the server no longer holds the request", (await pendingFor(sidB)).length === 0);
check("the turn is reported as failed, not left running", /sig=SIGKILL|process exited/.test(s.text), s.text.slice(-160));

// ═══ C. a request on a session the rail would fold away ═════════════════════════════════════════
console.log("\n=== C. a request below the rail's fold ===");
const target = await newSession("QA echo — folded target");
const sidC = target.id;
check("the target session was created", Boolean(sidC), JSON.stringify(target).slice(0, 160));
await idle(sidC);
await goTo(sidC);
await expandWorkspaces();
await prompt(sidC, "[tool-hermes] one write");
s = null;
for (let i = 0; i < 50; i++) { s = await ev(READ); if (s.cards.length) break; await sleep(300); }
check("the request is up on the target session", s.cards.length === 1, JSON.stringify(s.cards));
// …then five NEWER sessions in the SAME workspace push it past the rail's newest-five cut, and we
// sit on the newest of those (so no `isActive` pin can cover for the rule).
const filler = [];
for (let i = 1; i <= 5; i++) {
  const f = await newSession(`QA echo — filler ${i}`);
  check(`filler session ${i} was created`, Boolean(f.id), JSON.stringify(f).slice(0, 120));
  filler.push(f.id);
  await idle(f.id);
}
await goTo(filler[filler.length - 1]);
await expandWorkspaces();
await sleep(1500);
s = await ev(READ);
const rowC = s.rows.find((r) => r.title === "QA echo — folded target");
// Scoped to the TARGET'S OWN GROUP: the rail draws every workspace in one column, so a global row
// count says nothing about the fold (another group's cold rows are not this group's business).
const fold = await ev(`(() => {
  const row = [...document.querySelectorAll('.session-item')]
    .find((r) => ((r.querySelector('.title') || {}).textContent || '') === 'QA echo — folded target');
  if (!row) return { found: false };
  const group = row.closest('.rail-group');
  return { found: true, rows: group.querySelectorAll('.session-item').length,
           more: (group.querySelector('.rail-more') || {}).innerText ?? null };
})()`);
check("the group really holds more sessions than it shows (something IS folded)",
  /展开其余/.test(fold.more ?? ""), JSON.stringify(fold));
check("…and the row holding a request is on screen anyway, badged", Boolean(rowC) && rowC.badge === "⚿ 1", JSON.stringify(rowC));
check("…while that group still shows only its newest five rows", fold.rows === 5, JSON.stringify(fold));

// ═══ cleanup ════════════════════════════════════════════════════════════════════════════════════
const del = [sidA, sidB, sidC, ...filler].filter(Boolean);
await ev(`Promise.all(${JSON.stringify(del)}.map((s) => fetch('/api/sessions/' + s, { method: 'DELETE' }).then((r) => r.status).catch(() => 0)))`);
console.log("  sessions left behind:", JSON.stringify(await liveAll()));
await fetch(`${CDP}/json/close/${tab.id}`).catch(() => {});
console.log(`\n${bad === 0 ? "PASS" : "FAIL"} — ${ok} ok, ${bad} failed`);
ws.close();
process.exit(bad === 0 ? 0 : 1);
