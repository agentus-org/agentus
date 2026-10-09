// QA: 「在智能体设置中设置默认选中权限」 — the row's default permission mode.
//
//   PORT=8901 node scripts/qa/backend-default-mode-sweep.mjs
//
// Three claims, and the third is the one that costs the operator something if it is wrong:
//   1. the pick is OFFERED in 设置 → 智能体 → 某行 → 编辑, built from what that agent advertised the
//      last time it really started (the cached handshake — a stopped row's modes live nowhere else);
//   2. a NEW session from that row comes up in it (the chat settings popover shows it SELECTED, not
//      just set on the server — that is what the operator means by 「默认选中」);
//   3. a session that has its OWN pick keeps it across a resume. A default that overwrites the
//      permission a conversation was already using is worse than no default at all.
//
// Driven over raw CDP against the DEV cockpit (:8901) with the MOCK backend, so it costs no tokens.
// The server-level half of (2) and (3) also lives in scripts/backend-registry-smoke.mjs (self-contained
// server, no browser) — this one is the page the operator actually looks at.
const CDP = "http://127.0.0.1:9222";
const PORT = process.env.PORT ?? "8901";
const BASE = process.env.BASE ?? `http://127.0.0.1:${PORT}`;
const U = process.env.QA_USER ?? "scratch";
const P = process.env.QA_PASS ?? "scratch-pass-1";
const MODE_ID = "dont_ask";
const MODE_NAME = "Yolo"; // the mock's display name for dont_ask (packages/server/mock/agent.mjs)
const OTHER_ID = "accept_edits";
const OTHER_NAME = "Accept Edits";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = await import("node:fs");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

// The dev instance must be the one being driven, and it must be up (a watcher restart mid-run makes a
// single assertion fail at random — see the sweep notes in the skill).
const health = await fetch(`${BASE}/healthz`).then((r) => r.ok).catch(() => false);
if (!health) {
  console.log(`FAIL  ${BASE}/healthz did not answer — is the dev instance up? (bash scripts/dev.sh status)`);
  process.exit(1);
}
console.log(`  info  driving ${BASE} (dev), mock backend, no tokens`);

const t = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
const closeTab = () => { try { fetch(`${CDP}/json/close/${t.id}`); } catch { /* gone */ } };
process.on("exit", closeTab);
await sleep(2600);
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const w = new Map();
// One waiter for a RECEIVED WebSocket frame: the app's socket is only usable once it has received
// something, and `cockpit.send` DROPS a non-prompt command sent before open (state.ts only queues
// prompts and permission answers) — so a click on a popover option before that frame is silently
// lost, which is exactly how this sweep first reported a false failure.
let frameWaiter = null;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && w.has(m.id)) { const x = w.get(m.id); w.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); return; }
  if (m.method === "Network.webSocketFrameReceived" && frameWaiter) { const f = frameWaiter; frameWaiter = null; f(m.params); }
};
const waitFrame = (ms = 10000) => new Promise((res) => {
  const timer = setTimeout(() => { frameWaiter = null; res(false); }, ms);
  frameWaiter = () => { clearTimeout(timer); res(true); };
});
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
/** Wait for a JS expression to become truthy. Always returns a BOOLEAN-able value: returning a node
 *  kills the whole call with 「Object reference chain is too long」. */
const until = async (expr, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ev(`Boolean(${expr})`)) return true;
    await sleep(300);
  }
  return false;
};
/** Click an option in a popover GROUP by its visible text, as a real pointer does: hit-test first
 *  (a transparent overlay that swallows the click is a defect this repo has already shipped once),
 *  then press/release at its centre. */
const clickPopoverOption = async (groupLabel, optionText) => {
  const box = await ev(`(() => {
    const g = [...document.querySelectorAll('.settings-pop .settings-group')]
      .find((x) => (x.querySelector('.settings-label')?.textContent || '').includes(${JSON.stringify(groupLabel)}));
    if (!g) return null;
    const b = [...g.querySelectorAll('.settings-opt')].find((x) => x.textContent.trim() === ${JSON.stringify(optionText)});
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    const x = Math.round((r.left + r.right) / 2), y = Math.round((r.top + r.bottom) / 2);
    const hit = document.elementFromPoint(x, y);
    return { x, y, hitIsOption: Boolean(hit && b.contains(hit)) }; })()`);
  if (!box) throw new Error(`no 「${optionText}」 option in the ${groupLabel} group`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, ...(type === "mouseMoved" ? {} : { button: "left", clickCount: 1 }) });
  }
  await sleep(600);
  return box.hitIsOption;
};
const clickSel = async (sel) => {
  const box = await ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)});
    if (!b) return null; b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) }; })()`);
  if (!box) throw new Error(`no element for ${sel}`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
  await sleep(250);
};
const clickByText = async (sel, text) => {
  const ok = await ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})]
      .find((x) => (x.textContent || '').includes(${JSON.stringify(text)}));
    if (!b) return false; b.scrollIntoView({ block: 'center' }); return true; })()`);
  if (!ok) throw new Error(`no ${sel} containing 「${text}」`);
  const box = await ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})]
      .find((x) => (x.textContent || '').includes(${JSON.stringify(text)}));
    const r = b.getBoundingClientRect();
    return { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) }; })()`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
  await sleep(300);
  return true;
};
/** A REST call from INSIDE the page: the cockpit is authenticated there, a node-side fetch would 401. */
const api = (path, opts) => ev(`fetch(${JSON.stringify(path)}, ${JSON.stringify(opts ?? {})})
  .then((r) => r.text().then((t) => ({ status: r.status, body: t })))`);

const mockRow = async () => JSON.parse((await api("/api/backends")).body).find((b) => b.id === "mock");
const newMockSession = async (title) =>
  JSON.parse((await api("/api/sessions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ backend: "mock", cwd: "/tmp", title }),
  })).body).id;
const liveMode = async (sid) => {
  const d = JSON.parse((await api("/api/sessions")).body);
  return ((d.live ?? []).find((s) => s.id === sid) ?? (d.archived ?? []).find((s) => s.id === sid))?.modes?.currentModeId ?? null;
};

let warm = null, session = null, session2 = null;
try {
  // ── 0. this sweep sets its OWN preconditions ────────────────────────────────────────────────
  if (!(await ev("fetch('/api/auth/me',{credentials:'same-origin'}).then(r=>r.json()).then(d=>d.authenticated)"))) {
    const login = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
      body: JSON.stringify({ username: ${JSON.stringify(U)}, password: ${JSON.stringify(P)} })}).then((r) => r.status)`);
    check("logged in as the QA user on the dev instance", login === 200, `status=${login}`);
    await send("Page.reload", { ignoreCache: true });
    await sleep(2600);
  }
  // the QA store's mock row is shared with other sweeps: clear the default it may carry, then warm its
  // handshake with one real (mock) session — the picker can only offer what THIS agent advertised, and
  // a handshake cached by an OLDER build has ids without names.
  await api("/api/backends/mock", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ defaultMode: "" }) });
  if (!(await mockRow())?.handshake?.modes?.names) {
    warm = await newMockSession("default-mode sweep: handshake warm-up");
    await sleep(2500);
  }
  const modes = (await mockRow())?.handshake?.modes;
  check("the mock row's cached handshake lists its permission modes",
    Array.isArray(modes?.available) && modes.available.includes(MODE_ID),
    JSON.stringify(modes ?? null));

  // ── 1. the pick is OFFERED in 设置 → 智能体 ─────────────────────────────────────────────────
  await until("document.querySelector('.rail-gear')");
  await clickSel(".rail-gear");
  check("the settings page opens", await until("document.querySelector('[data-set-scroll]')"));
  await clickByText(".set-nav-cat", "智能体");
  check("the 智能体 category shows the backend table",
    await until("document.querySelector('#set-backends .be-row')"));

  const openMockEditor = async () => {
    await until("document.querySelector('#set-backends .be-row')");
    const opened = await ev(`(() => {
      const row = [...document.querySelectorAll('#set-backends .be-row')]
        .find((r) => (r.querySelector('code')?.textContent || '') === 'mock');
      if (!row) return false;
      // 编辑, not the FIRST button: the row's actions are 探测/编辑/复制/删除 in that order.
      const b = [...row.querySelectorAll('.be-row-actions .set-mini')]
        .find((x) => (x.textContent || '').includes('编辑'));
      if (!b) return false;
      b.click();
      return true; })()`);
    if (!opened) throw new Error("no mock row 编辑 button in the backend table");
    return await until("document.querySelector('.be-modal')");
  };
  check("the row editor opens for the mock row", await openMockEditor());

  // The picker itself: a `.set-row` labelled 默认权限 with a select whose options come from the cache.
  const selectInfo = () => ev(`(() => {
    const row = [...document.querySelectorAll('.be-modal .set-row')]
      .find((r) => (r.querySelector('label')?.textContent || '').trim() === '默认权限');
    if (!row) return { found: false };
    const sel = row.querySelector('select');
    return { found: Boolean(sel), value: sel?.value ?? null,
      options: [...(sel?.options ?? [])].map((o) => o.textContent.trim()) }; })()`);
  const info0 = await selectInfo();
  check("the editor offers a 默认权限 picker", info0.found === true, JSON.stringify(info0));
  check("the picker lists THIS agent's modes, by display name",
    info0.options?.some((o) => o.includes(MODE_NAME)) && info0.options?.some((o) => o.includes(OTHER_NAME)),
    JSON.stringify(info0.options));

  // Pick it and save. A controlled <select> needs the native setter + a bubbling change event.
  const picked = await ev(`(() => {
    const row = [...document.querySelectorAll('.be-modal .set-row')]
      .find((r) => (r.querySelector('label')?.textContent || '').trim() === '默认权限');
    const sel = row.querySelector('select');
    if (![...sel.options].some((o) => o.value === ${JSON.stringify(MODE_ID)})) return false;
    sel.value = ${JSON.stringify(MODE_ID)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true; })()`);
  check("the pick can be made in the picker", picked === true);
  await clickSel(".be-modal-foot .set-save");
  check("the pick is stored on the row",
    (await mockRow())?.defaultMode === MODE_ID, `defaultMode=${(await mockRow())?.defaultMode}`);
  check("the row line now says which permission a new session starts in",
    await until(`[...document.querySelectorAll('#set-backends .be-row')]
      .some((r) => r.textContent.includes('默认权限'))`));

  // Persisted across a re-open, AND still offered: saving the pick must not cost the row its cached
  // mode list. (It did, before the editor learned to PATCH only what changed: a full-body save reads
  // as "this row was redefined", which clears the handshake the picker is built from.)
  await clickByText(".set-nav-cat", "外观");
  await clickByText(".set-nav-cat", "智能体");
  await openMockEditor();
  const info1 = await selectInfo();
  check("re-opening the editor shows the stored pick selected", info1.value === MODE_ID, JSON.stringify(info1));
  check("...and the row still knows this agent's modes (the save did not wipe the handshake)",
    info1.options?.some((o) => o.includes(MODE_NAME)) && info1.options?.some((o) => o.includes(OTHER_NAME)),
    JSON.stringify(info1.options));
  await clickSel(".be-modal-x");

  // ── 2. a NEW session comes up in it, VISIBLY ─────────────────────────────────────────────────
  session = await newMockSession("default-mode sweep: new session");
  await until(`fetch('/api/sessions').then(r=>r.json()).then(d=>(d.live||[]).some(s=>s.id===${JSON.stringify(session)}))`);
  check("a new session from the row starts in the default mode (server)", (await liveMode(session)) === MODE_ID,
    `mode=${await liveMode(session)}`);

  await ev(`location.href = '/?session=' + ${JSON.stringify(session)}`);
  check("the session page renders its composer", await until("document.querySelector('.composer textarea')"));
  // the page's socket must have RECEIVED something before a popover pick can land: cockpit.send drops
  // a non-prompt command while the socket is not open (state.ts), and a click during that window is
  // lost without an error — the false failure this sweep reported before the gate existed.
  await send("Network.enable");
  check("the page's socket is live (a frame arrived)", await waitFrame(10000));
  await clickSel('button[aria-label="chat settings"]');
  check("the chat settings popover opens", await until("document.querySelector('.settings-pop')"));
  const shown = await ev(`(() => {
    const grp = [...document.querySelectorAll('.settings-pop .settings-group')]
      .find((g) => (g.querySelector('.settings-label')?.textContent || '').includes('permission mode'));
    if (!grp) return null;
    return { sel: grp.querySelector('.settings-opt.sel')?.textContent?.trim() ?? null,
      options: [...grp.querySelectorAll('.settings-opt')].map((b) => b.textContent.trim()) }; })()`);
  check("the popover offers the modes this agent advertises", Boolean(shown?.options?.length), JSON.stringify(shown));
  check("...with the row's default mode SELECTED (「默认选中权限」)",
    shown?.sel && shown.sel.includes(MODE_NAME), `selected=${shown?.sel}`);

  // ── 3. a session with its OWN pick keeps it across a resume ──────────────────────────────────
  check("the option is really under the pointer (not covered)",
    (await clickPopoverOption("permission mode", OTHER_NAME)) === true);
  check("the operator's own pick lands on the session", (await liveMode(session)) === OTHER_ID, `mode=${await liveMode(session)}`);
  await api(`/api/sessions/${session}`, { method: "DELETE" });
  await sleep(800);
  // fired WITHOUT awaiting: Resume.evaluate has a 5 s budget and a cold resume is a spawn + loadSession
  await ev(`fetch('/api/sessions/${session}/resume', { method: 'POST' })`);
  let back = null;
  for (let i = 0; i < 60 && back !== OTHER_ID; i++) { await sleep(1000); back = await liveMode(session); }
  check("a resumed session keeps ITS pick — the row default does not overwrite it", back === OTHER_ID, `mode=${back}`);

  // ── 4. a pick this agent never advertised is not sent, and the row says so ────────────────────
  await api("/api/backends/mock", { method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ defaultMode: "no_such_mode" }) });
  const warned = await mockRow();
  check("a default this agent never advertised is called out on the row",
    (warned?.warnings ?? []).some((x) => String(x).includes("no_such_mode")), JSON.stringify(warned?.warnings ?? []));
  session2 = await newMockSession("default-mode sweep: unadvertised default");
  await sleep(2500);
  check("...and it is NOT sent (the session keeps the agent's own mode)", (await liveMode(session2)) === "default",
    `mode=${await liveMode(session2)}`);
} catch (e) {
  check("the sweep ran to completion", false, String(e?.message ?? e));
} finally {
  // leave the shared QA store as we found it
  try { await api("/api/backends/mock", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ defaultMode: "" }) }); } catch { /* page may be gone */ }
  for (const s of [warm, session, session2]) {
    if (s) { try { await api(`/api/sessions/${s}`, { method: "DELETE" }); } catch { /* best effort */ } }
  }
  console.log(`\n${fail ? `${fail} check(s) FAILED` : "all checks passed"}  (${pass + fail} checks)`);
  closeTab();
  try { ws.close(); } catch { /* already closed */ }
  process.exit(fail ? 1 : 0);
}
void fs;
