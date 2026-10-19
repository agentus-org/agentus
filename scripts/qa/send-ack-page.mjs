// Issue #26, the half the server cannot prove: what the OPERATOR sees when his ready-session prompt
// goes into a socket that is dead but still `OPEN`.
//
// The frame is swallowed in-page — `WebSocket.prototype.send` drops `t:"prompt"` frames while the
// socket stays perfectly healthy from the browser's point of view. That is the exact shape of the
// reported bug (Wi-Fi switch / sleep / NAT timeout: no FIN, no onclose, `send()` returns true), and
// it is the only way to reproduce it without unplugging the machine.
//
// What must happen now:
//   1. the box is cleared (his words are claimed), but
//   2. after SEND_ACK_MS the message is back IN THE QUEUE, marked 未送达 — not gone;
//   3. it is NOT auto-drained (that is how one message becomes two);
//   4. pressing ↑ on that row sends it for real: the row disappears and the transcript holds it.
//
//   PORT=8901 node scripts/qa/send-ack-page.mjs
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

const MARK = `#26 吞帧探针 ${Date.now().toString(36)}`;
let chat = null;

try {
  const login = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
  if (login !== 200) throw new Error(`QA login returned ${login} — wrong instance (AGENTUS_DATA?)`);
  const api = async (path, init = {}) => ev(`(async () => {
    const r = await fetch(${JSON.stringify(path)}, ${JSON.stringify({ headers: { "content-type": "application/json" }, ...init })});
    const body = await r.text();
    try { return { status: r.status, body: JSON.parse(body) }; } catch { return { status: r.status, body }; }
  })()`);

  chat = (await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "mock", cwd: "/tmp", title: "ack probe（自动删除）" }) })).body?.id;
  if (!chat) throw new Error("could not create the probe session");
  await api(`/api/sessions/${chat}/resume`, { method: "POST" }).catch(() => {});
  await ev(`location.href = ${JSON.stringify(BASE)} + '/?session=' + ${JSON.stringify(chat)}`);
  const booted = await waitFor(`document.querySelector('.composer textarea') ? 1 : 0`);
  if (!booted) throw new Error("the composer never appeared");
  const ready = await waitFor(`(async () => {
    const r = await fetch('/api/sessions'); const j = await r.json();
    const row = [...(j.live ?? []), ...(j.cold ?? [])].find((s) => s.id === ${JSON.stringify(chat)});
    return row && row.status === 'ready' ? 1 : 0;
  })()`);
  check("the probe session is ready (the ack path only exists for ready+idle)", ready);

  // ---- swallow every prompt frame, keeping the socket alive (the half-open shape) --------------
  await ev(`(() => {
    window.__swallowed = 0;
    window.__drop = [];
    window.__origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        const m = JSON.parse(data);
        if (m && m.t === 'prompt') { window.__swallowed += 1; (window.__drop = window.__drop || []).push({ pid: m.pid, text: String(m.text).slice(0, 40), at: Date.now() }); return; }
      } catch (e) { /* not JSON: pass through */ }
      return window.__origSend.call(this, data);
    };
    return 1;
  })()`);

  await ev(`document.querySelector('.composer textarea').focus(), 1`);
  await send("Input.insertText", { text: MARK });
  await ev(`(() => {
    const ta = document.querySelector('.composer textarea');
    const e = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
    return ta.dispatchEvent(e) ? 'not-prevented' : 'prevented';
  })()`);

  await sleep(1200);
  check("the frame really was swallowed (the probe dropped it)", (await ev("window.__swallowed")) >= 1, `swallowed=${await ev("window.__swallowed")}`);
  check("the input box was cleared, as it is for any send", (await ev(`document.querySelector('.composer textarea').value`)) === "");
  check("…and no bubble claims it was sent", !(await ev(`[...document.querySelectorAll('.msg, .msg-user, .bubble')].some((e) => e.textContent.includes(${JSON.stringify(MARK)}))`)));

  // ---- the acknowledgement budget expires: the words come back into the queue ------------------
  const back = await waitFor(`document.querySelector('.queue-row.unsure') ? 1 : 0`, 14_000);
  check("after the ack timeout the message is back in the queue, marked 未送达", back,
    back ? "" : "no .queue-row.unsure appeared");
  if (back) {
    check("it is the operator's own text", await ev(`document.querySelector('.queue-row.unsure .queue-text')?.textContent === ${JSON.stringify(MARK)}`));
    check("the row is explicitly marked", await ev(`document.querySelector('.queue-row.unsure .queue-flag')?.textContent?.includes('未送达') === true`));
    check("the queue head explains what to do", await ev(`document.querySelector('.queue-hint')?.textContent?.includes('未确认送达') === true`));

    // Not auto-sent: an unconfirmed message may have landed after all, so the drain leaves it alone.
    await sleep(2500);
    check("it was NOT auto-resent", await ev(`document.querySelectorAll('.queue-row.unsure').length`) === 1
      && (await ev("window.__swallowed")) === 1, `swallowed=${await ev("window.__swallowed")}`);

    // ---- the operator's ↑ is the retry — and it is guarded too --------------------------------
    // The socket is STILL swallowing frames, so pressing ↑ must not glue the row into "sending…":
    // its own ack budget expires and the row comes back, because a retry into the same dead socket
    // is exactly the same bug one click later.
    await ev(`(document.querySelector('.queue-row.unsure .queue-btn').click(), 1)`);
    const stillSwallowed = await waitFor(`document.querySelector('.queue-row.unsure')?.textContent.includes(${JSON.stringify(MARK)}) ? 1 : 0`, 14_000);
    check("a retry into the still-dead socket comes back as 未送达 (not stuck in sending…)", stillSwallowed);
    check("…and that retry did go out (swallowed twice)", (await ev("window.__swallowed")) === 2, `swallowed=${await ev("window.__swallowed")}`);

    // ---- the socket is healthy again: ↑ lands it, exactly once --------------------------------
    await ev(`(WebSocket.prototype.send = window.__origSend, 1)`);
    await ev(`(document.querySelector('.queue-row.unsure .queue-btn').click(), 1)`);
    const landed = await waitFor(`[...document.querySelectorAll('.msg, .msg-user, .bubble')].some((e) => e.textContent.includes(${JSON.stringify(MARK)})) ? 1 : 0`, 12_000);
    check("pressing ↑ on a live socket really sends it (a user bubble appears)", landed);
    await sleep(1200);
    check("no queue row is left behind", (await ev(`document.querySelectorAll('.queue-row').length`)) === 0,
      `rows=${await ev("document.querySelectorAll('.queue-row').length")}`);
    const server = await api(`/api/sessions/${chat}/messages`);
    const rows = server.body?.messages ?? server.body ?? [];
    const hits = Array.isArray(rows) ? rows.filter((m) => m.kind === "user" && JSON.stringify(m).includes(MARK)) : [];
    check("the server holds exactly one copy of it (no duplicate)", hits.length === 1,
      `copies=${hits.length} ${JSON.stringify(hits.map((m) => ({ kind: m.kind, seq: m.seq, at: m.createdAt })))}`);
  }
} catch (e) {
  fail++;
  console.log(`FAIL  harness error: ${e?.message ?? e}`);
} finally {
  if (chat) {
    await ev(`fetch(${JSON.stringify(`/api/sessions/${chat}`)},{method:'DELETE'})`).catch(() => {});
  }
  await closeTab();
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
