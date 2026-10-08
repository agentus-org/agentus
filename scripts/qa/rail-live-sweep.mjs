// QA: the rail's 「运行中」 marking — "which of these sessions is working RIGHT NOW".
//
// The operator fires a turn in one row, walks away to another session and comes back, so the rail
// has to answer that question without opening the session. Before this change the only signal was a
// 7px static dot on the agent mark's corner, which nobody reads at that size.
//
// What it asserts (all off the RENDERED page, not the server's word):
//   1. a session mid-turn wears `.be-avatar.live` and its status dot runs the `pulse` animation;
//   2. a session that is NOT mid-turn wears neither — stillness is what makes the moving row findable;
//   3. the turn ending TAKES the marking off the row (no stale "still working" row);
//   4. the halo does not resize the row (the avatar box stays 20x20 and the row stays inside the rail);
//   5. the row is actually ON SCREEN (a marking scrolled out of view has not arrived).
//
//   PORT=8901 node scripts/qa/rail-live-sweep.mjs
const CDP = process.env.CDP ?? "http://127.0.0.1:9222";
const BASE = process.env.BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8901}`;
const U = process.env.QA_USER ?? "scratch", P = process.env.QA_PASS ?? "scratch-pass-1";
const SHOTS = process.env.SHOTS ?? "/Users/liang/Workspace/agent-dev-workspace/tasks/20261001-agentus/screens";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

// ---- CDP plumbing (same shape as the other sweeps) ----------------------------------------------
const t = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(2000);
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
await send("Page.enable"); await send("Runtime.enable");
const closeTab = async () => { await fetch(`${CDP}/json/close/${t.id}`, { method: "PUT" }).catch(() => {}); };

try {
  const login = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
  if (login !== 200) throw new Error(`QA login returned ${login} — the QA account is not this instance (AGENTUS_DATA?)`);

  // Two fresh mock sessions: one to run a turn in, one to leave still. A fresh session per run, so a
  // leftover from the previous run cannot be mistaken for this one.
  const mk = async () => (await ev(`fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({backend:'mock',cwd:'/tmp'})}).then(r=>r.json())`))?.id;
  const busy = await mk(), idle = await mk();
  if (!busy || !idle) throw new Error("could not create the two probe sessions");
  console.log(`      busy=${busy}  idle=${idle}`);

  // Make the IDLE session the active one and point the UI at it: the running row must be findable
  // while the operator is looking at a different session — that is the whole ask.
  await sleep(500); // let the login cookie land before the reload that reads it
  await ev(`location.href = ${JSON.stringify(BASE)} + '/?session=' + ${JSON.stringify(idle)}`).catch(() => {});
  // Wait for the boot instead of sleeping a guessed number of ms: the reload right after a login
  // can land before the cookie is readable, and a fixed sleep then measures the login wall — a
  // setup failure that reads exactly like "the rail lost its marking".
  const waitFor = async (expr, ms = 12_000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (await ev(expr).catch(() => 0)) return true; await sleep(300); }
    return false;
  };
  const composerUp = await waitFor(`document.querySelector('.composer textarea') ? 1 : 0`);
  check("the composer is up (an assertion here means the page, not the rail)", composerUp);
  const activeOk = await waitFor(`document.querySelector('[data-session="' + ${JSON.stringify(idle)} + '"].active') ? 1 : 0`);
  // the app consumes ?session= and strips it, so the active row is read from the DOM
  const activeId = await ev(`(() => document.querySelector('.session-item.active')?.dataset.session ?? '')()`);
  check("the other session is the one on screen (running row = a non-active row)", activeOk && activeId === idle, `active=${activeId}`);

  // A turn that lasts: [slow] makes the mock stream at 900 ms a chunk.
  const sent = await ev(`fetch('/api/sessions/'+${JSON.stringify(busy)}+'/prompt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'[slow] rail live marking'})}).then(r=>r.status)`);
  check("the probe turn was accepted (a prompt during another turn is refused: 409)", sent === 202, `HTTP ${sent}`);

  // ---- the reading, taken while the turn is in flight ------------------------------------------
  const running = await ev(`(() => {
    const row = document.querySelector('[data-session="' + ${JSON.stringify(busy)} + '"]');
    if (!row) return { found: false };
    const av = row.querySelector('.be-avatar');
    const dot = row.querySelector('.be-dot');
    const ar = av.getBoundingClientRect(), rr = row.getBoundingClientRect();
    return {
      found: true,
      avatarClass: av.className,
      dotClass: dot ? dot.className : "",
      avatarAnim: getComputedStyle(av).animationName,
      avatarShadow: getComputedStyle(av).boxShadow,
      dotAnim: dot ? getComputedStyle(dot).animationName : "",
      box: [Math.round(ar.width), Math.round(ar.height)],
      onScreen: rr.top >= 0 && rr.bottom <= innerHeight,
      title: av.getAttribute('title'),
    };
  })()`);
  check("the running row is rendered", running.found === true);
  check("its agent mark wears the live class", /\blive\b/.test(running.avatarClass ?? ""), running.avatarClass);
  check("with a halo animation attached", (running.avatarAnim ?? "").includes("rail-live"), `animation=${running.avatarAnim} / shadow=${running.avatarShadow}`);
  check("its status dot is the running one, and it pulses", /running/.test(running.dotClass ?? "") && (running.dotAnim ?? "").includes("pulse"), `${running.dotClass} anim=${running.dotAnim}`);
  check("the halo does not resize the mark (still 20x20)", running.box?.[0] === 20 && running.box?.[1] === 20, `box=${running.box}`);
  check("the running row is on screen", running.onScreen === true);
  check("the row's tooltip says 运行中, not the protocol word", /运行中/.test(running.title ?? ""), running.title);

  // ---- the still row: the contrast that makes the moving one findable ---------------------------
  const still = await ev(`(() => {
    const row = document.querySelector('[data-session="' + ${JSON.stringify(idle)} + '"]');
    if (!row) return { found: false };
    const av = row.querySelector('.be-avatar');
    return { found: true, avatarClass: av.className, anim: getComputedStyle(av).animationName,
             dot: (row.querySelector('.be-dot') || {className:''}).className,
             dotAnim: getComputedStyle(row.querySelector('.be-dot') || av).animationName };
  })()`);
  check("an idle session keeps a still mark (no halo, no pulse)", still.found && !/\blive\b/.test(still.avatarClass) && still.anim === "none" && !still.dotAnim.includes("pulse"), `${still.avatarClass} anim=${still.anim} dot=${still.dot}`);

  try {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(`${SHOTS}/rail-live-running.png`, Buffer.from(shot.data, "base64"));
    console.log(`      screenshot ${SHOTS}/rail-live-running.png`);
  } catch (e) { console.log(`      (screenshot skipped: ${e.message})`); }

  // ---- turn over: the marking must come off ----------------------------------------------------
  const deadline = Date.now() + 45_000;
  let status = "";
  while (Date.now() < deadline) {
    status = await ev(`fetch('/api/sessions').then(r=>r.json()).then(j=>((j.live||[]).find(s=>s.id===${JSON.stringify(busy)})||{}).status ?? 'gone')`);
    if (status !== "running") break;
    await sleep(700);
  }
  check("the probe turn really ended (fixture precondition for the next check)", status !== "running", `status=${status}`);
  await sleep(800); // one publish + one paint
  const after = await ev(`(() => {
    const row = document.querySelector('[data-session="' + ${JSON.stringify(busy)} + '"]');
    const av = row?.querySelector('.be-avatar');
    return { cls: av?.className ?? "", anim: av ? getComputedStyle(av).animationName : "" };
  })()`);
  check("the finished row carries NO running marking (no stale 'still working')", !/\blive\b/.test(after.cls) && after.anim === "none", `${after.cls} anim=${after.anim}`);

  // clean up the two probe rows so the QA rail does not accumulate them
  for (const sid of [busy, idle]) {
    await ev(`fetch('/api/sessions/'+${JSON.stringify(sid)},{method:'DELETE'}).then(r=>r.status)`).catch(() => {});
  }
} finally {
  await closeTab();
  ws.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
