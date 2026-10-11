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
const closeTab = async () => { await fetch(`${CDP}/json/close/${t.id}`, { method: "PUT" }).catch(() => {}); };

try {
  const login = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
  if (login !== 200) throw new Error(`QA login returned ${login} — the QA account is not this instance (AGENTUS_DATA?)`);

  // The form is reached from the rail's own 「新会话」 button (the 「+」 inside a group passes a FIXED
  // directory and hides the picker — that path is rail-sweep's business, not this suite's).
  const dev = await ev(`fetch('/api/version',{cache:'no-store'}).then(r=>r.json()).then(j=>Boolean(j.dev))`);
  console.log(`      instance dev=${dev}  base=${BASE}`);
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
  check("a fresh form arrives with a real directory chosen (no empty field, no dead launch button)",
    phone.fieldValue.startsWith("/") && phone.goEnabled === true,
    `field=${phone.fieldValue} go=${phone.goEnabled}`);
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
  check("the desktop form is not taller than it needs to be (a phone-shaped dialog, ~1 column)",
    desk.modal?.w <= 460, JSON.stringify(desk.modal));

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
} finally {
  await closeTab();
  ws.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
