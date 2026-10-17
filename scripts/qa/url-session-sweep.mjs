// The address bar as a session locator (issue #20), measured on the REAL page.
//
// Clicking a session used to leave the URL at `/`, so 「把这条链接发给我自己」 opened nothing in
// particular and a reload fell back to localStorage. Now the URL carries `?session=`, a URL that
// disagrees is followed, and anything already holding this document (the Android companion's
// notification tap) moves INSIDE it instead of reloading — the last part is why a marker is planted
// in the window: if it survives, the document was never torn down.
//
//   PORT=8901 node scripts/qa/url-session-sweep.mjs
const CDP = process.env.CDP ?? "http://127.0.0.1:9222";
const BASE = process.env.BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8901}`;
const U = process.env.QA_USER ?? "scratch", P = process.env.QA_PASS ?? "scratch-pass-1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

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
await send("Page.enable"); await send("Runtime.enable");
const closeTab = async () => { await fetch(`${CDP}/json/close/${t.id}`).catch(() => {}); };
const waitFor = async (expr, ms = 15_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await ev(expr).catch(() => 0)) return true; await sleep(250); }
  return false;
};
const sessionParam = () => ev(`new URL(location.href).searchParams.get('session')`);
const activeRow = () => ev(`document.querySelector('.session-item.active')?.dataset.session ?? null`);

const cleanup = [];
try {
  const login = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
  if (login !== 200) throw new Error(`QA login returned ${login} — wrong instance (AGENTUS_DATA?)`);
  const api = async (path, init = {}) => ev(`(async () => {
    const r = await fetch(${JSON.stringify(path)}, ${JSON.stringify({ headers: { "content-type": "application/json" }, ...init })});
    const body = await r.text();
    try { return { status: r.status, body: JSON.parse(body) }; } catch { return { status: r.status, body }; }
  })()`);
  const mkSession = async (title) => {
    const made = await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "mock", cwd: "/tmp", title }) });
    if (made.body?.id) cleanup.push(made.body.id);
    return made.body?.id;
  };

  const one = await mkSession("url 定位 A（自动删除）");
  const two = await mkSession("url 定位 B（自动删除）");
  for (const s of [one, two]) {
    await waitFor(`fetch('/api/sessions',{credentials:'include'}).then(r=>r.json()).then(j=>((j.live||[]).some(x=>x.id===${JSON.stringify(s)}&&x.status==='ready'))?1:0)`, 20_000);
  }
  await waitFor(`document.querySelectorAll('.session-item').length >= 2 ? 1 : 0`, 20_000);

  // ── clicking a row puts it in the address bar, without a document load ───────────────────────
  await ev(`window.__urlSweepMarker = 'alive-' + Math.random()`);
  const marker0 = await ev(`window.__urlSweepMarker`);
  const clicked = await ev(`(() => {
    const row = document.querySelector('.session-item[data-session=' + JSON.stringify(${JSON.stringify(one)}) + ']');
    if (!row) return 'no-row';
    row.scrollIntoView({ block: 'center' });
    row.click();
    return 'clicked';
  })()`);
  check("the probe session has a rail row to click", clicked === "clicked", clicked);
  await sleep(600);
  check("clicking a session writes ?session=<id> into the address bar (issue #20)", (await sessionParam()) === one,
    String(await sessionParam()));
  check("…and the active row agrees", (await activeRow()) === one, String(await activeRow()));
  check("…with no page reload (the document is the same one)", (await ev(`window.__urlSweepMarker`)) === marker0,
    "marker survived");

  // ── switching rewrites it, and does not stack history entries ────────────────────────────────
  const historyBefore = await ev(`history.length`);
  await ev(`document.querySelector('.session-item[data-session=' + JSON.stringify(${JSON.stringify(two)}) + ']').click()`);
  await sleep(600);
  check("switching sessions rewrites the parameter (the URL never names the session you left)",
    (await sessionParam()) === two, String(await sessionParam()));
  check("…via replaceState: no new history entry to press Back on",
    (await ev(`history.length`)) === historyBefore, `${historyBefore} → ${await ev(`history.length`)}`);

  // ── the in-page hook the phone uses: move, don't reload ─────────────────────────────────────
  const moved = await ev(`window.__agentusOpenSession ? window.__agentusOpenSession(${JSON.stringify(one)}) : 'missing'`);
  check("window.__agentusOpenSession exists for the companion App to call", moved === true, String(moved));
  await sleep(500);
  check("…it switches the view", (await activeRow()) === one, String(await activeRow()));
  check("…it updates the URL", (await sessionParam()) === one, String(await sessionParam()));
  check("…and it did NOT reload the page", (await ev(`window.__urlSweepMarker`)) === marker0);

  const unknown = await ev(`window.__agentusOpenSession('sess_nope_never_heard_of')`);
  check("an id this page has never seen answers false (the App then does a real load)", unknown === false, String(unknown));
  check("…and the view is untouched", (await activeRow()) === one, String(await activeRow()));

  // ── a URL that disagrees is followed (link pasted, popstate) ────────────────────────────────
  await ev(`history.replaceState(null, '', location.pathname + '?session=' + ${JSON.stringify(two)}); window.dispatchEvent(new PopStateEvent('popstate'))`);
  await sleep(600);
  check("a URL naming another session is followed (popstate / pasted link)", (await activeRow()) === two,
    String(await activeRow()));

  // ── and a reload lands on the session the URL names, not on whatever was last stored ─────────
  await ev(`history.replaceState(null, '', location.pathname + '?session=' + ${JSON.stringify(one)})`);
  await send("Page.reload", { ignoreCache: false });
  await waitFor(`document.querySelector('.composer textarea') ? 1 : 0`, 25_000);
  await waitFor(`document.querySelector('.session-item.active') ? 1 : 0`, 20_000);
  check("after a reload the URL still names the session, so the page opens IT", (await sessionParam()) === one,
    String(await sessionParam()));
  check("…and the active row is that session (shareable, bookmarkable, reloadable)",
    (await activeRow()) === one, String(await activeRow()));
} finally {
  const api = async (path) => ev(`fetch(${JSON.stringify(path)},{method:'DELETE'}).then(r=>r.status)`).catch(() => 0);
  for (const s of cleanup) { await api(`/api/sessions/${s}`); await api(`/api/sessions/${s}`); }
  await closeTab();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
