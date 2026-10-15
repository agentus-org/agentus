// QA: the NEW-SESSION start page — its SHAPE (a reduced copy of the chat page), its size, and the
// workspace button that replaced the on-page directory tree.
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
let MOBILE = false;
const setViewport = async (W, H) => {
  MOBILE = W < 700;
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: MOBILE });
  await send("Emulation.setTouchEmulationEnabled", { enabled: MOBILE, maxTouchPoints: 5 }).catch(() => {});
  await sleep(450);
};
/** A REAL pointer, not `el.click()`.
 *
 *  The workspace pill ignores a synthetic click: `el.click()` on it leaves the dialog closed and the
 *  same coordinates dispatched as a pointer event open it (measured, both viewports, no page error —
 *  see `scripts/qa/probe-ws-pill.mjs`). Since a phone viewport needs a TOUCH event anyway, anything
 *  the operator physically presses is asserted through here; `el.click()` stays for the controls
 *  where it demonstrably works. */
const clickEl = async (sel, wait = 900) => {
  const at = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return null; const b = e.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }); })()`);
  if (!at) return false;
  const { x, y } = JSON.parse(at);
  if (MOBILE) {
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }
  await sleep(wait);
  return true;
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
  // The start page is a REDUCED COPY OF THE CHAT PAGE (operator, 2026-10-14: 「相当于一个会话页面的一个
  // 缩小版…不包含那些聊天记录而已…选模型啊，相关的设置啊，还有语音输入啊，这个输入框啊，应该都是一样的」).
  // So what is asserted is the SHAPE it shares with the composer — and the one thing it deliberately
  // does NOT share, the transcript above it. The workspace is the other half of the same report: a
  // BUTTON with the folder tree behind it, never a section of this page.
  const measure = () => ev(`(() => {
    const modal = document.querySelector('.modal.start-page');
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
    const text = (modal?.textContent ?? '');
    const detail = modal?.querySelector('.be-detail');
    const head = detail?.querySelector('.be-detail-head');
    const r = modal?.getBoundingClientRect() ?? null;
    const send = modal?.querySelector('.composer-bar .send-btn') ?? null;
    const sr = send?.getBoundingClientRect() ?? null;
    const pill = modal?.querySelector('.ws-pill') ?? null;
    const box = modal?.querySelector('.composer-box') ?? null;
    const bar = modal?.querySelector('.composer-bar') ?? null;
    const ta = modal?.querySelector('.composer-box textarea') ?? null;
    return {
      present: Boolean(modal),
      modal: r ? { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), w: Math.round(r.width) } : null,
      viewport: { h: innerHeight, w: innerWidth },
      fitsScreen: Boolean(r) && r.top >= -1 && r.bottom <= innerHeight + 1,
      sendReachable: Boolean(sr) && sr.top >= 0 && sr.bottom <= innerHeight + 1,
      sendDisabled: send ? send.disabled === true : null,
      // the composer shape, shared with the chat page
      hasBox: Boolean(box), hasBar: Boolean(bar), hasTextarea: Boolean(ta),
      textareaOnTop: Boolean(ta && bar && (ta.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING)),
      controls: [...(bar?.children ?? [])]
        .filter((el) => el.tagName === 'BUTTON' || el.classList.contains('tb-wrap'))
        .map((el) => el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.className),
      // …and the workspace: a button here, a listing only behind it
      pill: Boolean(pill), pillLabel: (pill?.textContent ?? '').trim(), pillTitle: pill?.getAttribute('title') ?? '',
      workspaceListOnPage: Boolean(modal?.querySelector('.wp-list, .wp-row, .wp-chip')),
      // what this page is a copy of the chat page MINUS
      hasTranscript: Boolean(modal?.querySelector('.stream-wrap, .stream, .msg-row')),
      hasRuns: /runs:/.test(text),
      hasHealth: /上次检查/.test(text),
      hasDetailFold: Boolean(head),
      detailOpen: head ? head.getAttribute('aria-expanded') === 'true' : null,
      cards: cardGeom,
      stripOverflowX: strip ? getComputedStyle(strip).overflowX : '',
    };
  })()`);

  // ---- the REAL phone case: a browser's own chrome eats ~140px of a 844pt screen ---------------
  await setViewport(390, 700);
  const short = await measure();
  console.log(`      phone    modal h=${short.modal?.h} viewport=${short.viewport.h} (browser chrome subtracted)`);
  check("the start page also fits a 390×700 viewport (a phone WITH its browser chrome)",
    short.fitsScreen === true && short.sendReachable === true,
    `modal=${JSON.stringify(short.modal)} viewport=${JSON.stringify(short.viewport)}`);

  await setViewport(390, 844);
  const phone = await measure();
  console.log(`      phone    modal h=${phone.modal?.h} viewport=${phone.viewport.h} cards=${phone.cards.length} controls=${JSON.stringify(phone.controls)}`);
  const shotPhone = await send("Page.captureScreenshot", { format: "png" }, 25000);
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(`${SHOTS}/newsession-form-phone.png`, Buffer.from(shotPhone.data, "base64"));

  check("the start page is on screen at 390×844", phone.present && phone.modal?.w <= phone.viewport.w);
  check("the whole start page FITS the phone screen — no part of it off the top or the bottom",
    phone.fitsScreen === true, `modal=${JSON.stringify(phone.modal)} viewport=${JSON.stringify(phone.viewport)}`);
  check("…and 发送 is a reachable tap target inside that screen",
    phone.sendReachable === true, JSON.stringify(phone.modal));

  // ---- the shape it shares with the chat page ---------------------------------------------------
  check("it is a COMPOSER, not a form: the chat page's own input card, textarea above the bar",
    phone.hasBox === true && phone.hasBar === true && phone.hasTextarea === true && phone.textareaOnTop === true,
    JSON.stringify({ box: phone.hasBox, bar: phone.hasBar, ta: phone.hasTextarea, onTop: phone.textareaOnTop }));
  check("…and the bar carries the same controls the composer does (dictation + send at the least)",
    phone.controls.includes("send") && phone.controls.includes("dictate"),
    JSON.stringify(phone.controls));
  check("…and NOT the transcript it is a copy of (no messages on this page)",
    phone.hasTranscript === false, `transcript=${phone.hasTranscript}`);

  // ---- the workspace: a button, not a listing ---------------------------------------------------
  check("the workspace is a PILL BUTTON — no directory listing on the page itself",
    phone.pill === true && phone.workspaceListOnPage === false,
    `pill=${phone.pill} listing=${phone.workspaceListOnPage}`);
  check("…and it already names a directory (the placeholder is a choice, not an empty field)",
    phone.pillLabel.length > 0, `label=${phone.pillLabel}`);

  // the pill OPENS the picker — the folder tree is a STEP behind it
  await clickEl('.modal.start-page .ws-pill', 1200);
  const picker = await ev(`(() => {
    const m = document.querySelector('.ws-modal');
    const page = document.querySelector('.modal.start-page');
    return { open: Boolean(m), rows: m?.querySelectorAll('.wp-row').length ?? 0,
             chips: m?.querySelectorAll('.wp-chip').length ?? 0,
             hasField: Boolean(m?.querySelector('.wp-path')),
             // it has to be ABOVE the page it was launched from, not behind it
             z: m ? Number(getComputedStyle(m.parentElement).zIndex) : 0,
             pageZ: page ? Number(getComputedStyle(page.parentElement).zIndex) : 0 };
  })()`);
  check("the pill opens the workspace picker — a real folder browser, on top of the start page",
    picker.open === true && picker.rows > 0 && picker.hasField === true && picker.z > picker.pageZ,
    JSON.stringify(picker));
  check("…with the recent-directory shortcuts INSIDE the dialog (not on the page)",
    picker.chips > 0 && picker.chips <= 6, `chips=${picker.chips}`);

  const wanted = await ev(`document.querySelector('.ws-modal .wp-chip')?.getAttribute('title')?.replace(/^选中 /, '') ?? ''`);
  await clickEl('.ws-modal .wp-chip', 1000);
  const picked = await ev(`(() => { const pill = document.querySelector('.modal.start-page .ws-pill');
    return { closed: !document.querySelector('.ws-modal'), title: pill?.getAttribute('title') ?? '',
             label: (pill?.textContent ?? '').trim() }; })()`);
  check("…and picking a folder closes the dialog and renames the pill",
    Boolean(wanted) && picked.closed === true && picked.title === wanted
      && picked.label === wanted.split('/').filter(Boolean).pop(),
    JSON.stringify({ wanted, ...picked }));

  check("`runs:` is gone from the page", phone.hasRuns === false);
  check("上次检查 is gone from the page", phone.hasHealth === false);
  check("…but the facts still exist behind 后端详情, and it is CLOSED by default",
    phone.hasDetailFold === true && phone.detailOpen === false, `fold=${phone.hasDetailFold} open=${phone.detailOpen}`);

  // the fold OPENS (the facts are folded away, not deleted — the home is the one warning that matters)
  await ev(`document.querySelector('.modal.start-page .be-detail-head')?.click()`);
  await sleep(500);
  const openedDetail = await ev(`(() => {
    const d = document.querySelector('.modal.start-page .be-detail');
    const body = d?.querySelector('.be-hint');
    return { expanded: d?.querySelector('.be-detail-head')?.getAttribute('aria-expanded') === 'true',
             text: (body?.textContent ?? '').slice(0, 160) };
  })()`);
  check("opening it reveals the row's mechanics (runs / home / env)",
    openedDetail.expanded === true && /runs:/.test(openedDetail.text), JSON.stringify(openedDetail));
  await ev(`document.querySelector('.modal.start-page .be-detail-head')?.click()`);   // fold it back
  await sleep(400);
  const refolded = await ev(`(() => document.querySelector('.modal.start-page .be-detail-head')?.getAttribute('aria-expanded') === 'false' && !/runs:/.test(document.querySelector('.modal.start-page')?.textContent ?? ''))()`);
  check("…and closing it takes them off the page again", refolded === true);

  // The message is REQUIRED, and the button that sends it is the composer's own.
  check("the message is REQUIRED: 发送 is disabled while the box is empty",
    phone.sendDisabled === true, `disabled=${phone.sendDisabled}`);

  // The chat composer's own 「+」 lives on this page too. Feed the hidden input a real File through
  // DataTransfer — the same shape a picker hands it — because "the button exists" is not the claim:
  // the claim is that an attachment can be made BEFORE the session it belongs to does.
  const plusPresent = await ev(`Boolean(document.querySelector('.start-composer [aria-label="attach"]'))`);
  check("the bar carries the chat composer's own 「+」 (attach)", plusPresent === true);
  const fed = await ev(`(async () => {
    const input = document.querySelector('.start-composer input[type=file]');
    if (!input) return JSON.stringify({ error: 'no file input on the page' });
    const dt = new DataTransfer();
    dt.items.add(new File(['probe payload from the start page'], 'probe.txt', { type: 'text/plain' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    return JSON.stringify({
      chips: [...document.querySelectorAll('.start-composer .draft-row .draft .draft-name')].map((e) => e.textContent),
      sendEnabled: document.querySelector('.start-composer .send-btn')?.disabled === false,
      boxEmpty: (document.querySelector('.start-composer textarea')?.value ?? '') === '',
    });
  })()`);
  const attachment = JSON.parse(fed);
  check("…feeding it a file raises a draft chip above the box",
    (attachment.chips ?? []).includes("probe.txt"), fed);
  check("…and the attachment ALONE arms 发送 (an attachment is a message)",
    attachment.boxEmpty === true && attachment.sendEnabled === true, fed);
  await ev(`(() => { document.querySelector('.start-composer .draft-x')?.click(); return true; })()`);
  await sleep(400);
  const chipsLeft = await ev(`document.querySelectorAll('.start-composer .draft-row .draft').length`);
  check("…and the chip's ✕ takes it back off", chipsLeft === 0, String(chipsLeft));

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

  // ---- the desktop reading: same surface, same facts, no phone-only regressions -----------------
  await setViewport(1440, 900);
  const desk = await measure();
  console.log(`      desktop  modal h=${desk.modal?.h} viewport=${desk.viewport.h} cards=${desk.cards.length}`);
  const shotDesk = await send("Page.captureScreenshot", { format: "png" }, 25000);
  fs.writeFileSync(`${SHOTS}/newsession-form-desktop.png`, Buffer.from(shotDesk.data, "base64"));
  check("on a desktop viewport the same facts hold (composer, pill, no transcript)",
    desk.fitsScreen === true && desk.hasBox === true && desk.pill === true
      && desk.workspaceListOnPage === false && desk.hasRuns === false,
    JSON.stringify({ fits: desk.fitsScreen, box: desk.hasBox, pill: desk.pill, list: desk.workspaceListOnPage }));
  check("the desktop form is not wider than it needs to be (one column, room for a message)",
    desk.modal?.w <= 580, JSON.stringify(desk.modal));

  // ---- the picker still WORKS through the dialog (a slimmed layout that cannot pick a folder is
  //      not an improvement) ----------------------------------------------------------------------
  const TYPED = "/Users/liang/Workspace";
  await clickEl('.modal.start-page .ws-pill', 1200);
  const armed = await ev(`(async () => {
    const m = document.querySelector('.ws-modal');
    const field = m?.querySelector('.wp-path');
    if (!field) return { ok: false, why: 'no field' };
    // React keeps its own value tracker: assigning .value and firing 'input' is NOT a state change
    // (it reads as "same value, no event"). Go through the prototype setter, which is what a real
    // keystroke does.
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value');
    desc.set.call(field, ${JSON.stringify(TYPED)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    return { ok: true, field: m.querySelector('.wp-path')?.value,
             useEnabled: !(m.querySelector('.wp-use')?.disabled ?? true) };
  })()`);
  check("typing a path into the dialog's field arms 「选中」", 
    armed.ok === true && armed.field === TYPED && armed.useEnabled === true, JSON.stringify(armed));

  await clickEl('.ws-modal .wp-use', 1200);
  const used = await ev(`(() => { const pill = document.querySelector('.modal.start-page .ws-pill');
    return { title: pill?.getAttribute('title') ?? '', label: (pill?.textContent ?? '').trim(),
             closed: !document.querySelector('.ws-modal'),
             listBack: Boolean(document.querySelector('.modal.start-page .wp-list')) }; })()`);
  check("…and 选中 puts that directory on the pill — the ONE place the choice is shown",
    used.title === TYPED && used.label === "Workspace" && used.closed === true && used.listBack === false,
    JSON.stringify(used));

  // close the dialog so the next sweep does not start on top of an open modal
  await ev(`document.querySelector('.modal.start-page')?.parentElement?.click()`);
  await sleep(400);
  check("the dialog closes again (nothing left behind for the next run)",
    (await ev(`Boolean(document.querySelector('.modal.start-page'))`)) === false);

  // ---- the toolbar the operator reported: 权限 / 模型 / 语音输入 must not overlap ----------------
  // His words (2026-10-15): 「权限还有那个模型以及那个语音输入键…好像重合有一点交叉重叠」. The measured
  // cause was NOT tight spacing but a box that escaped: `.tb-wrap` is the flex item that shrinks
  // (flex 0 1 auto + min-width 0), while the `.tb-btn` inside it kept its own max-width — so at 390px
  // 权限 painted 12px onto 模型 and the model label ran 15px into the microphone (25px at 360px).
  // This is the contract that keeps it fixed: the three config controls are separate boxes at every
  // width the cockpit runs at, the microphone is never underneath one of them, and the MODE name
  // (the safety label) is never the one that gets cut.
  const barGeom = async (W, H) => {
    await setViewport(W, H);
    await ev(`document.querySelector('.new-btn')?.click()`);
    await sleep(1000);
    const g = JSON.parse(await ev(`(() => {
      const bar = document.querySelector('.modal.start-page .composer-bar');
      const btns = [...bar.querySelectorAll(':scope > .tb-wrap > .tb-btn')];
      const rs = btns.map((b) => b.getBoundingClientRect());
      const overlaps = [];
      for (let i = 1; i < rs.length; i += 1) {
        if (rs[i - 1].right > rs[i].left + 0.5) overlaps.push(Math.round(rs[i - 1].right - rs[i].left));
      }
      const mic = bar.querySelector('[aria-label="dictate"]')?.getBoundingClientRect() ?? null;
      const send = bar.querySelector('.send-btn')?.getBoundingClientRect() ?? null;
      const last = rs[rs.length - 1] ?? null;
      const modeLab = bar.querySelector('[data-testid="start-mode"] .tb-label');
      return JSON.stringify({
        overlaps,
        micGap: mic && last ? Math.round(mic.left - last.right) : null,
        sendInView: Boolean(send) && send.right <= window.innerWidth + 1,
        modeShown: modeLab ? Math.round(modeLab.getBoundingClientRect().width) >= modeLab.scrollWidth - 1 : null,
        controls: btns.length,
      });
    })()`));
    await ev(`document.querySelector('.modal.start-page')?.parentElement?.click()`);
    await sleep(350);
    return g;
  };
  // 1440 = the desktop reading, 390 = the phone the operator reported, 360/320 = the floor below it
  for (const [W, H] of [[1440, 900], [390, 844], [360, 780], [320, 700]]) {
    const g = await barGeom(W, H);
    check(`at ${W}px the config controls are separate boxes — none paints over its neighbour`,
      g.controls >= 3 && g.overlaps.length === 0, JSON.stringify({ W, ...g }));
    check(`…at ${W}px the microphone is not underneath the model pill`,
      g.micGap === null || g.micGap >= 0, `W=${W} micGap=${g.micGap}`);
    check(`…at ${W}px the permission mode still reads as its whole name (that is the safety label)`,
      g.modeShown !== false, `W=${W} modeShown=${g.modeShown}`);
    check(`…and 发送 is still on that screen`, g.sendInView === true, `W=${W}`);
  }

  // ---- dictation lands in the box you are LOOKING at --------------------------------------------
  // The operator's second report: 「语音录入完了，点停止后…没有把消息填充到输入框里面」. Two composers are
  // mounted at once while this dialog is up (it is an overlay), both sinks ran on the same dictation
  // snapshot, and the chat page's effect runs FIRST (it is earlier in the tree) — so it took the words
  // and the dialog's own box stayed empty. `window.__asFeed` is the seam the call sweep uses: the
  // injected text stands in for a microphone nobody has in CI.
  const sink = JSON.parse(await ev(`(async () => {
    document.querySelector('.new-btn')?.click();
    await new Promise((r) => setTimeout(r, 900));
    window.__asFeed = { level: 0.3, text: 'QA start-page dictation probe', interim: '' };
    document.querySelector('.modal.start-page [aria-label="dictate"]')?.click();
    await new Promise((r) => setTimeout(r, 700));
    const recording = Boolean(document.querySelector('.modal.start-page .dict-chip'));
    document.querySelector('.modal.start-page .dict-chip .dict-stop')?.click();
    await new Promise((r) => setTimeout(r, 900));
    const mine = document.querySelector('.modal.start-page textarea')?.value ?? '';
    const all = [...document.querySelectorAll('textarea')].map((t) => t.value);
    return JSON.stringify({ recording, mine, landed: all.filter((v) => v.includes('QA start-page dictation probe')).length });
  })()`));
  check("dictation runs INSIDE the dialog (the chip and its stop are on the start page)", sink.recording === true, JSON.stringify(sink));
  check("…and STOP fills the dialog's OWN box (the operator's report)", sink.mine.includes("QA start-page dictation probe"), JSON.stringify(sink));
  check("…and the transcript lands in exactly ONE box (the chat composer behind it does not swallow it)",
    sink.landed === 1, JSON.stringify(sink));
  await ev(`(() => { window.__asFeed = undefined; document.querySelector('.modal.start-page')?.parentElement?.click(); return true; })()`);
  await sleep(350);

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
    const box = document.querySelector('.modal.start-page .composer-box textarea');
    if (!box) return { ok: false, why: 'no first-message box' };
    // React keeps its own value tracker: go through the prototype setter, which is what a keystroke does
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'value');
    desc.set.call(box, 'QA start-page probe');
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const go = document.querySelector('.modal.start-page .composer-bar .send-btn');
    const enabled = Boolean(go && !go.disabled);
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 1500));
    return { ok: true, enabled, closed: !document.querySelector('.modal.start-page'),
             inStream: Boolean(document.querySelector('.stream-wrap')),
             text: (document.querySelector('.modal.start-page')?.textContent ?? '').slice(0, 80) };
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
