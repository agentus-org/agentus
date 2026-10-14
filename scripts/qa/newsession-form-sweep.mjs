// QA: the NEW-SESSION form — its size, its folds, and where it shows the chosen path.
//
// The operator's report (2026-10-11): 「新建会话的那个表单…感觉好差啊，手机上一屏幕都放不下，runs 和上次检查
// 都不用显示在页面上吧…选定的路径显示是不是统一在输入栏哪里呢，为啥最下面有一个，然后候选项和地址栏中间
// 又有一个」. Three claims, three groups of assertions below:
//   · the form FITS a 390×844 phone (measured, not eyeballed) and its buttons are reachable;
//   · `runs:` and 上次检查 are not on the page at all (they moved behind 后端详情, which is closed by
//     default and still holds them — the fold is asserted open-and-closed, or the facts are gone);
//   · the chosen path appears in ONE place (the field), and the two extra display strips are gone;
//   · the backend strip is cards (mark above label) and scrolls sideways instead of squeezing.
//
//   PORT=8901 node scripts/qa/newsession-form-sweep.mjs
const CDP = process.env.CDP ?? "http://127.0.0.1:9222";
const BASE = process.env.BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8901}`;
const U = process.env.QA_USER ?? "scratch", P = process.env.QA_PASS ?? "scratch-pass-1";
const SHOTS = process.env.SHOTS ?? "/Users/liang/Workspace/agent-dev-workspace/tasks/20261001-agentus/screens";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  await sleep(450);
};
await send("Page.enable"); await send("Runtime.enable");
const closeTab = async () => { await fetch(`${CDP}/json/close/${t.id}`).catch(() => {}); };

try {
  const login = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
  if (login !== 200) throw new Error(`QA login returned ${login} — the QA account is not this instance (AGENTUS_DATA?)`);

  // The form is reached from the rail's own 「新会话」 button (the 「+」 inside a group passes a FIXED
  // directory and hides the picker — that path is rail-sweep's business, not this suite's).
  const dev = await ev(`fetch('/api/version',{cache:'no-store'}).then(r=>r.json()).then(j=>Boolean(j.dev))`);
  console.log(`      instance dev=${dev}  base=${BASE}`);
  // What the instance already held, so this run can put it back exactly as found — the start-page
  // block below creates sessions (and purges them).
  const preexisting = await ev(`fetch('/api/sessions', { cache: 'no-store' }).then(r => r.json())
    .then(j => [...(j.live ?? []), ...(j.cold ?? []), ...(j.archived ?? [])].map((s) => s.id))`);
  await setViewport(1440, 900);
  await ev(`document.querySelector('.new-btn')?.click()`);
  await sleep(1200);
  const opened = await ev(`Boolean(document.querySelector('.modal .backend-pick'))`);
  check("the 「新会话」 button opens the form", opened);

  // ---- one reading function, used at both viewports ---------------------------------------------
  const measure = () => ev(`(() => {
    const modal = document.querySelector('.modal');
    const picker = modal?.querySelector('.wp');
    const field = picker?.querySelector('.wp-path');
    const strip = modal?.querySelector('.backend-pick');
    const cards = [...(strip?.querySelectorAll('.be-card') ?? [])].filter((c) => !c.classList.contains('reload'));
    const cardGeom = cards.map((c) => {
      const mark = c.querySelector('.be-card-mark');
      const label = c.querySelector('.be-card-label');
      const mr = mark?.getBoundingClientRect() ?? null;
      const lr = label?.getBoundingClientRect() ?? null;
      return {
        backend: c.dataset.backend ?? '',
        label: (label?.textContent ?? '').trim(),
        markKind: mark?.querySelector('img') ? 'img' : (mark?.textContent ?? '').trim(),
        stacked: Boolean(mr && lr) && mr.bottom <= lr.top + 1,
        sameColumn: Boolean(mr && lr) && Math.abs((mr.left + mr.right) / 2 - (lr.left + lr.right) / 2) <= 6,
      };
    });
    const chips = [...(picker?.querySelectorAll('.wp-chip') ?? [])];
    const chipGeom = chips.map((c) => { const r = c.getBoundingClientRect();
      return { h: Math.round(r.height), font: parseFloat(getComputedStyle(c).fontSize) }; });
    const chosen = field ? field.value : '';
    // "the chosen path is displayed once": the field holds it (a property, not text), so ANY element
    // whose own text carries it is a second display of the same fact
    const dupes = modal ? [...modal.querySelectorAll('*')].filter((el) => el.children.length === 0
      && chosen && (el.textContent ?? '').includes(chosen)).map((el) => el.className || el.tagName) : [];
    const text = (modal?.textContent ?? '');
    const detail = modal?.querySelector('.be-detail');
    const head = detail?.querySelector('.be-detail-head');
    const r = modal?.getBoundingClientRect() ?? null;
    const go = modal?.querySelector('.row .go')?.getBoundingClientRect() ?? null;
    const goBtn = modal?.querySelector('.row .go') ?? null;
    return {
      present: Boolean(modal),
      modal: r ? { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), w: Math.round(r.width) } : null,
      viewport: { h: innerHeight, w: innerWidth },
      fitsScreen: Boolean(r) && r.top >= -1 && r.bottom <= innerHeight + 1,
      goReachable: Boolean(go) && go.top >= 0 && go.bottom <= innerHeight + 1,
      goEnabled: goBtn ? goBtn.disabled === false : null,
      hasRuns: /runs:/.test(text),
      hasHealth: /上次检查/.test(text),
      hasDetailFold: Boolean(head),
      detailOpen: head ? head.getAttribute('aria-expanded') === 'true' : null,
      // the fold must HOLD the facts when closed: 'runs:' absent from the visible text, present in
      // the DOM once opened (asserted separately below by clicking it)
      fieldValue: chosen,
      legacyPicked: Boolean(modal?.querySelector('.wp-picked')),
      legacyCrumbs: Boolean(modal?.querySelector('.wp-crumbs') || modal?.querySelector('.wp-now')),
      dupes,
      chips: chipGeom,
      chipCount: chips.length,
      cards: cardGeom,
      stripOverflowX: strip ? getComputedStyle(strip).overflowX : '',
    };
  })()`);

  // ---- the REAL phone case: a browser's own chrome eats ~140px of a 844pt screen ---------------
  // Measured: the old form was 755px tall. It "passed" at 844 (a bare viewport, which no phone
  // browser gives a page) and was CLIPPED at 700 — the launch button below the bottom edge, the
  // first field above the top, with no scroller anywhere (the operator's 「手机上一屏幕都放不下」).
  await setViewport(390, 700);
  const short = await measure();
  console.log(`      phone    modal h=${short.modal?.h} viewport=${short.viewport.h} (browser chrome subtracted)`);
  check("the form also fits a 390×700 viewport (a phone WITH its browser chrome)",
    short.fitsScreen === true && short.goReachable === true,
    `modal=${JSON.stringify(short.modal)} viewport=${JSON.stringify(short.viewport)}`);

  await setViewport(390, 844);
  const phone = await measure();
  console.log(`      phone    modal h=${phone.modal?.h} viewport=${phone.viewport.h} cards=${phone.cards.length} chips=${phone.chipCount} chipH=${phone.chips.map((c) => c.h).join("/")}`);
  const shotPhone = await send("Page.captureScreenshot", { format: "png" }, 25000);
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(`${SHOTS}/newsession-form-phone.png`, Buffer.from(shotPhone.data, "base64"));

  check("the form is on screen at 390×844", phone.present && phone.modal?.w <= phone.viewport.w);
  check("the whole form FITS the phone screen — no part of it off the top or the bottom",
    phone.fitsScreen === true, `modal=${JSON.stringify(phone.modal)} viewport=${JSON.stringify(phone.viewport)}`);
  check("…and the launch button is a reachable tap target inside that screen",
    phone.goReachable === true, JSON.stringify(phone.modal));
  check("`runs:` is gone from the page", phone.hasRuns === false);
  check("上次检查 is gone from the page", phone.hasHealth === false);
  check("…but the facts still exist behind 后端详情, and it is CLOSED by default",
    phone.hasDetailFold === true && phone.detailOpen === false, `fold=${phone.hasDetailFold} open=${phone.detailOpen}`);

  // the fold OPENS (the facts are folded away, not deleted — the home is the one warning that matters)
  await ev(`document.querySelector('.modal .be-detail-head')?.click()`);
  await sleep(500);
  const openedDetail = await ev(`(() => {
    const d = document.querySelector('.modal .be-detail');
    const body = d?.querySelector('.be-hint');
    return { expanded: d?.querySelector('.be-detail-head')?.getAttribute('aria-expanded') === 'true',
             text: (body?.textContent ?? '').slice(0, 120) };
  })()`);
  check("opening it reveals the row's mechanics (runs / home / env)",
    openedDetail.expanded === true && /runs:/.test(openedDetail.text), JSON.stringify(openedDetail));
  await ev(`document.querySelector('.modal .be-detail-head')?.click()`);   // fold it back
  await sleep(400);
  const refolded = await ev(`(() => document.querySelector('.modal .be-detail-head')?.getAttribute('aria-expanded') === 'false' && !/runs:/.test(document.querySelector('.modal')?.textContent ?? ''))()`);
  check("…and closing it takes them off the page again", refolded === true);

  check("the chosen path is shown in exactly one place (the field)", phone.dupes.length === 0 && phone.fieldValue.startsWith("/"),
    `dupes=${JSON.stringify(phone.dupes)} field=${phone.fieldValue}`);
  check("a fresh form arrives with a real directory chosen (no empty field)",
    phone.fieldValue.startsWith("/"), `field=${phone.fieldValue}`);
  // The surface leads with the MESSAGE now (issue #1): a composer on top, the picks under it, and
  // Enter creates. Which makes the empty box the one state where the button must NOT be pressable —
  // there would be nothing to hand the agent.
  const startBox = await ev(`(() => {
    const m = document.querySelector('.modal');
    const box = m?.querySelector('.start-input');
    const go = m?.querySelector('.row .go');
    return { hasBox: Boolean(box), boxOnTop: Boolean(box && m.querySelector('label') &&
               (box.compareDocumentPosition(m.querySelector('label')) & Node.DOCUMENT_POSITION_FOLLOWING)),
             emptyDisabled: Boolean(go && go.disabled), label: (go?.textContent ?? '').trim() };
  })()`);
  check("the message box is the FIRST control on the form", startBox.hasBox === true && startBox.boxOnTop === true,
    JSON.stringify(startBox));
  check("…and the message is REQUIRED: send is disabled while the box is empty",
    startBox.emptyDisabled === true, JSON.stringify(startBox));
  check("the two extra path strips are gone (no breadcrumbs, no bottom line)",
    phone.legacyPicked === false && phone.legacyCrumbs === false,
    `picked=${phone.legacyPicked} crumbs=${phone.legacyCrumbs}`);
  check("the shortcut chips are six at most, and small",
    phone.chipCount > 0 && phone.chipCount <= 6 && phone.chips.every((c) => c.h <= 28 && c.font <= 11.5),
    `n=${phone.chipCount} ${JSON.stringify(phone.chips)}`);
  check("the backend strip is cards: the mark ABOVE the label, centred in one column, one per backend",
    phone.cards.length >= 2 && phone.cards.every((c) => c.stacked && c.sameColumn && c.markKind),
    JSON.stringify(phone.cards));
  check("…and the strip scrolls sideways rather than squeezing the cards",
    phone.stripOverflowX === "auto", `overflow-x=${phone.stripOverflowX}`);
  if (dev) {
    check("on a DEV instance the mock backend IS offered (the QA backend stays reachable where it belongs)",
      phone.cards.some((c) => c.backend === "mock"), JSON.stringify(phone.cards.map((c) => c.backend)));
  } else {
    check("on a LIVE instance the mock backend is NOT offered (a QA backend is not a choice you can make by accident)",
      !phone.cards.some((c) => c.backend === "mock"), JSON.stringify(phone.cards.map((c) => c.backend)));
  }

  // ---- the desktop reading: same form, same facts, no phone-only regressions ---------------------
  await setViewport(1440, 900);
  const desk = await measure();
  console.log(`      desktop  modal h=${desk.modal?.h} viewport=${desk.viewport.h} cards=${desk.cards.length}`);
  const shotDesk = await send("Page.captureScreenshot", { format: "png" }, 25000);
  fs.writeFileSync(`${SHOTS}/newsession-form-desktop.png`, Buffer.from(shotDesk.data, "base64"));
  check("on a desktop viewport the form still fits and the same three facts hold",
    desk.fitsScreen === true && desk.hasRuns === false && desk.dupes.length === 0 && desk.legacyPicked === false,
    JSON.stringify(desk.modal));
  check("the desktop form is not wider than it needs to be (one column, room for a message)",
    desk.modal?.w <= 580, JSON.stringify(desk.modal));

  // ---- the picker still WORKS (a slimmed layout that cannot pick a folder is not an improvement) --
  const TYPED = "/Users/liang/Workspace";
  const picked = await ev(`(async () => {
    const modal = document.querySelector('.modal');
    const field = modal?.querySelector('.wp-path');
    if (!field) return { ok: false, why: 'no field' };
    const names = () => [...modal.querySelectorAll('.wp-row .wp-name')].map((e) => e.textContent);
    const before = names();
    // React keeps its own value tracker: assigning .value and firing 'input' is NOT a state change
    // (it reads as "same value, no event"). Go through the prototype setter, which is what a real
    // keystroke does.
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value');
    desc.set.call(field, ${JSON.stringify(TYPED)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    modal.querySelector('.wp-use')?.click();
    await new Promise((r) => setTimeout(r, 1200));
    const after = names();
    return { ok: true, field: modal.querySelector('.wp-path')?.value, before: before.slice(0, 3), rows: after.length, sample: after.slice(0, 3),
             moved: JSON.stringify(before) !== JSON.stringify(after) };
  })()`);
  check("typing a path into the field and confirming it moves the listing there",
    picked.ok === true && picked.field === TYPED && picked.rows > 0 && picked.moved === true,
    `field=${picked.field} rows=${picked.rows} moved=${picked.moved} sample=${JSON.stringify(picked.sample)}`);
  const chipPick = await ev(`(async () => {
    const modal = document.querySelector('.modal');
    const chip = modal?.querySelector('.wp-chip');
    if (!chip) return { ok: false, why: 'no chip' };
    const wanted = chip.getAttribute('title')?.replace(/^选中 /, '') ?? '';
    chip.click();
    await new Promise((r) => setTimeout(r, 900));
    return { ok: true, wanted, field: modal.querySelector('.wp-path')?.value, sel: Boolean(modal.querySelector('.wp-chip.sel')) };
  })()`);
  check("a shortcut chip picks that directory (and shows it as the chosen one)",
    chipPick.ok === true && chipPick.field === chipPick.wanted && chipPick.sel === true,
    JSON.stringify(chipPick));

  // close the dialog so the next sweep does not start on top of an open modal
  await ev(`document.querySelector('.modal-bg')?.click()`);
  await sleep(400);
  check("the dialog closes again (nothing left behind for the next run)",
    (await ev(`Boolean(document.querySelector('.modal'))`)) === false);

  // ---- the START-PAGE contract: the row exists before the agent does (issue #1) ------------------
  // The complaint was that 「新建会话」 held the request for the agent's whole handshake — 10–40 s on
  // hermes — behind a busy dialog. The proof belongs at the API, where no browser timing can flatter
  // it: the POST must answer with `starting`, and the slot must reach `ready` with nobody asking.
  const started = Date.now();
  const created = await ev(`(async () => {
    const r = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backend: 'mock', cwd: '/tmp' }) });
    const j = await r.json();
    return { http: r.status, status: j.status, id: j.id ?? null, acp: j.acpSessionId ?? null };
  })()`);
  const answeredIn = Date.now() - started;
  check("POST /api/sessions answers while the slot is still coming up — status 'starting', not 'ready'",
    created.http === 201 && created.status === "starting", `${JSON.stringify(created)} in ${answeredIn}ms`);
  check("…and it carries no agent-side id yet (the agent has not spoken)",
    created.acp === null, JSON.stringify(created));
  const liveStatus = async () => ev(`fetch('/api/sessions', { cache: 'no-store' }).then(r => r.json())
    .then(j => [...(j.live ?? []), ...(j.cold ?? [])].find((s) => s.id === ${JSON.stringify(created.id)})?.status ?? null)
    .catch(() => null)`);
  let came = null;
  for (let i = 0; i < 48 && came !== "ready"; i++) { await sleep(250); came = await liveStatus(); }
  check("the slot reaches 'ready' on its own (the server pushes it — the page asks for nothing)",
    came === "ready", `status=${came}`);

  // ---- a slot closed WHILE it was still coming up must stay wakeable ---------------------------------
  // `create()` no longer waits for the handshake (that wait is the whole of issue #1), so the operator
  // can close a slot before the agent has answered. The row still has to end up with the agent-side id
  // the handshake found: without it `resume()` refuses the row outright (「was never handed to an
  // agent」) and the transcript is stranded — a slot nobody can ever wake again.
  const fly = await ev(`(async () => {
    const c = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backend: 'mock', cwd: '/tmp' }) }).then((r) => r.json());
    if (!c.id) return { ok: false, why: 'create failed', c };
    const del = await fetch('/api/sessions/' + c.id, { method: 'DELETE' }).then((r) => r.status);
    const back = await fetch('/api/sessions/' + c.id + '/resume', { method: 'POST' });
    const body = await back.json().catch(() => null);
    return { ok: true, id: c.id, del, resume: back.status, acp: body?.acpSessionId ?? null };
  })()`);
  check("a slot closed WHILE it was starting still ends up carrying the agent-side id",
    fly.ok === true && fly.del === 200 && fly.acp != null, JSON.stringify(fly));
  check("…and can therefore be woken again (a row without that id is stranded forever)",
    fly.resume === 200, JSON.stringify(fly));

  // ---- the composer really creates: type, Enter, and the page is IN that session -----------------
  const typed = await ev(`(async () => {
    document.querySelector('.new-btn')?.click();
    await new Promise((r) => setTimeout(r, 900));
    const box = document.querySelector('.modal .start-input');
    if (!box) return { ok: false, why: 'no first-message box' };
    // React keeps its own value tracker: go through the prototype setter, which is what a keystroke does
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'value');
    desc.set.call(box, 'QA start-page probe');
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const go = document.querySelector('.modal .row .go');
    const enabled = Boolean(go && !go.disabled);
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 1500));
    return { ok: true, enabled, closed: !document.querySelector('.modal'),
             inStream: Boolean(document.querySelector('.stream-wrap')),
             text: (document.querySelector('.modal')?.textContent ?? '').slice(0, 80) };
  })()`);
  check("typing a first message ENABLES the send button", typed.ok === true && typed.enabled === true, JSON.stringify(typed));
  check("Enter creates the session and closes the start page (the page is now in that session)",
    typed.closed === true && typed.inStream === true, JSON.stringify(typed));

  // …and the message is not lost while the agent boots: it is in that session's queue, which drains
  // on the `ready` frame. Read it from the store the same way the UI does.
  let delivered = false;
  for (let i = 0; i < 40 && !delivered; i++) {
    await sleep(300);
    delivered = await ev(`document.body.textContent.includes('QA start-page probe')`);
  }
  check("the first message shows up in that session (queued, then sent when the agent was up)",
    delivered === true);

  // leave the instance as it was found: purge exactly the sessions that did not exist at login
  const purged = await ev(`(async () => {
    const keep = new Set(${JSON.stringify(preexisting)});
    const j = await fetch('/api/sessions', { cache: 'no-store' }).then((r) => r.json());
    const mine = [...(j.live ?? []), ...(j.cold ?? []), ...(j.archived ?? [])].filter((s) => !keep.has(s.id));
    let n = 0;
    for (const s of mine) { const r = await fetch('/api/sessions/' + s.id, { method: 'DELETE' }); if (r.ok) n++; }
    return { made: mine.length, purged: n, ids: mine.map((s) => s.id) };
  })()`);
  check("the run left nothing behind (every session it created was purged)",
    purged.made === purged.purged, JSON.stringify(purged));
} finally {
  await closeTab();
  ws.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
