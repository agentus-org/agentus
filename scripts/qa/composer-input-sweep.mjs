// The composer's input layer, measured on the real page: three issues that all live in "what a key or
// the clipboard does before the message is a message".
//
// #31 — Cmd+V of a screenshot must become an attachment card, and a TEXT paste must stay the browser's
//       own (not intercepted, text lands in the box).
// #29 — Enter while an IME is composing is 「选词」, not 「提交」 — on the session-rename box, the one
//       inline input a Chinese user hits most. Both signals are exercised: the composition ref (Safari
//       fires keydown before compositionend) and `isComposing` (Chrome).
// #25 — ↑/↓ walk this session's own messages, ↓ at the newest restores the draft, Esc restores it, and
//       inside a multi-line draft the arrows are still CARET movement.
//
//   PORT=8901 node scripts/qa/composer-input-sweep.mjs
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
const closeTab = async () => { await fetch(`${CDP}/json/close/${t.id}`).catch(() => {}); };
const waitFor = async (expr, ms = 15_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await ev(expr).catch(() => 0)) return true; await sleep(200); }
  return false;
};
/** Type into the composer the way a person does (a real input event, so React sees it). */
const typeInto = async (text) => {
  await ev(`(document.querySelector('.composer textarea').focus(), 1)`);
  await send("Input.insertText", { text });
};
const key = async (k, mods = {}) => ev(`(async () => {
  const ta = document.querySelector('.composer textarea');
  const e = new KeyboardEvent('keydown', ${JSON.stringify({ key: k, code: k, bubbles: true, cancelable: true, ...mods })});
  ta.dispatchEvent(e);
  // React applies setText on its own schedule; read the box AFTER the commit, or the assertion is
  // comparing the recall against the value it replaced.
  await new Promise((r) => setTimeout(r, 120));
  return { prevented: e.defaultPrevented, value: document.querySelector('.composer textarea').value };
})()`);

let chat = null;
const SEED = [`第一条历史 ${Date.now().toString(36)}`, `第二条历史 ${Date.now().toString(36)}`];

try {
  const login = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
  if (login !== 200) throw new Error(`QA login returned ${login} — wrong instance (AGENTUS_DATA?)`);
  const api = async (path, init = {}) => ev(`(async () => {
    const r = await fetch(${JSON.stringify(path)}, ${JSON.stringify({ headers: { "content-type": "application/json" }, ...init })});
    const body = await r.text();
    try { return { status: r.status, body: JSON.parse(body) }; } catch { return { status: r.status, body }; }
  })()`);

  // A session with two known user messages in its transcript = the history to walk (#25).
  chat = (await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "mock", cwd: "/tmp", title: "input sweep（自动删除）" }) })).body?.id;
  if (!chat) throw new Error("could not create the probe session");
  for (const [i, line] of SEED.entries()) {
    // Send, then WAIT for it to appear: a prompt into a turn that is still finishing is refused
    // ("turn already running") and the row count silently stays put — which is exactly how a
    // history test ends up walking a one-item list.
    for (let attempt = 0; attempt < 5; attempt++) {
      await api(`/api/sessions/${chat}/prompt`, { method: "POST", body: JSON.stringify({ text: line }) });
      const got = await waitFor(`(async () => {
        const r = await fetch(${JSON.stringify(`/api/sessions/${chat}/messages`)}); const j = await r.json();
        return (j.messages ?? []).filter((m) => m.kind === 'user').length > ${i} ? 1 : 0;
      })()`, 6000);
      if (got) break;
      await sleep(800);
    }
  }
  const seeded = await api(`/api/sessions/${chat}/messages`);
  const userRows = (seeded.body?.messages ?? []).filter((m) => m.kind === "user");
  check("the probe transcript holds both seeded messages", userRows.length === SEED.length, `user rows=${userRows.length}`);
  await ev(`location.href = ${JSON.stringify(BASE)} + '/?session=' + ${JSON.stringify(chat)}`);
  if (!(await waitFor(`document.querySelector('.composer textarea') ? 1 : 0`))) throw new Error("the composer never appeared");
  await sleep(1200);

  // ================= #31: paste =================
  const imgPaste = await ev(`(() => {
    const dt = new DataTransfer();
    const png = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);
    dt.items.add(new File([png], 'shot.png', { type: 'image/png' }));
    const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector('.composer textarea').dispatchEvent(e);
    return e.defaultPrevented;
  })()`);
  check("pasting an image is intercepted (the browser would otherwise drop it)", imgPaste === true);
  const card = await waitFor(`document.querySelector('.draft.image') ? 1 : 0`, 5000);
  check("…and it becomes an attachment card", card,
    card ? "" : `drafts=${await ev("document.querySelectorAll('.draft').length")}`);
  check("the card carries the pasted name", await ev(`document.querySelector('.draft.image .draft-name')?.textContent === 'shot.png'`));
  await ev(`(document.querySelector('.draft-clear')?.click(), 1)`);

  const textPaste = await ev(`(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', '纯文本粘贴');
    const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector('.composer textarea').dispatchEvent(e);
    return e.defaultPrevented;
  })()`);
  check("a text-only paste is NOT intercepted (typing keeps working)", textPaste === false);
  check("…and no attachment appears for it", (await ev(`document.querySelectorAll('.draft').length`)) === 0);

  // ================= #29: IME guard on the rename box =================
  await ev(`(() => {
    const row = document.querySelector('.session-item');
    const title = row?.querySelector('.title');
    if (!title) return 0;
    title.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return 1;
  })()`);
  const renaming = await waitFor(`document.querySelector('.title-input') ? 1 : 0`, 5000);
  check("the rename box opened (the inline input under test)", renaming);

  if (renaming) {
    // Chrome's signal: keydown carries isComposing while the IME candidate list is up.
    const chrome = await ev(`(() => {
      const el = document.querySelector('.title-input');
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      const e = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, isComposing: true });
      el.dispatchEvent(e);
      return { still: Boolean(document.querySelector('.title-input')), prevented: e.defaultPrevented };
    })()`);
    await sleep(400);
    check("Enter while the IME is composing does not commit the rename (isComposing)", chrome.still === true
      && (await ev(`Boolean(document.querySelector('.title-input'))`)) === true);
    check("…and the key is left to the IME (not preventDefault-ed)", chrome.prevented === false);

    // Safari's shape: compositionend is late, so only the ref knows; isComposing is already false here.
    const safari = await ev(`(() => {
      const el = document.querySelector('.title-input');
      document.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      const e = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, isComposing: false });
      el.dispatchEvent(e);
      return { still: Boolean(document.querySelector('.title-input')) };
    })()`);
    await sleep(400);
    check("…and it still does not commit when only the composition ref says so (Safari)", safari.still === true
      && (await ev(`Boolean(document.querySelector('.title-input'))`)) === true);

    // A real confirm (composition ended) must still work — the guard must not disable the box.
    const commit = await ev(`(() => {
      const el = document.querySelector('.title-input');
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      const e = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, isComposing: false });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    })()`);
    const closed = await waitFor(`document.querySelector('.title-input') ? 0 : 1`, 6000);
    check("a plain Enter still commits the rename", commit === true && closed);
  }

  // ================= #25: ↑/↓ history =================
  await ev(`(document.querySelector('.composer textarea').focus(), 1)`);
  await typeInto("草稿还没发");
  const up1 = await key("ArrowUp");
  check("↑ recalls the newest message instead of moving the caret", up1.value === SEED[1], `value=${JSON.stringify(up1.value)}`);
  const up2 = await key("ArrowUp");
  check("↑ again walks one further back", up2.value === SEED[0], `value=${JSON.stringify(up2.value)}`);
  const up3 = await key("ArrowUp");
  check("↑ at the oldest stays there (clamped, no wrap)", up3.value === SEED[0]);
  const down1 = await key("ArrowDown");
  check("↓ walks forward again", down1.value === SEED[1]);
  const down2 = await key("ArrowDown");
  check("↓ past the newest restores the draft that was in the box", down2.value === "草稿还没发", `value=${JSON.stringify(down2.value)}`);

  const again = await key("ArrowUp");
  check("…and the walk can start again from there", again.value === SEED[1]);
  const esc = await key("Escape");
  check("Esc leaves the walk and restores the draft", esc.value === "草稿还没发", `value=${JSON.stringify(esc.value)}`);

  // A multi-line draft: the arrows belong to the CARET, not to history.
  await ev(`(() => {
    const ta = document.querySelector('.composer textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '第一行\\n第二行');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.focus();
    return 1;
  })()`);
  const multiline = await key("ArrowUp");
  check("↑ inside a multi-line draft is caret movement, not recall", multiline.value === "第一行\n第二行"
    && multiline.prevented === false, `prevented=${multiline.prevented}`);

  // A modifier is never a recall (⌘↑ / Ctrl+↑ belong to the browser).
  const modified = await key("ArrowUp", { metaKey: true });
  check("⌘↑ is left to the browser", modified.prevented === false);
} catch (e) {
  fail++;
  console.log(`FAIL  harness error: ${e?.message ?? e}`);
} finally {
  if (chat) await ev(`fetch(${JSON.stringify(`/api/sessions/${chat}`)},{method:'DELETE'})`).catch(() => {});
  await closeTab();
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
