// The plan's NAME on the card, and one size down on a phone.
//
// The agent has been able to name its plan since #11 (`update_plan`'s `title`, ≤40 chars) — but the
// name was only ever consumed by the completion notification. On the card the header said 「任务计划」
// for every plan, which is a LABEL, not an answer to 「这是哪个计划」 when several slots are open.
// This measures the real page: the name reaches `.plan-title`, it truncates instead of pushing the
// dots/count/state off the line, and a plan WITHOUT a name still shows the old label (nothing changes
// for agents that never send one).
//
// The second half is the phone: at 390px the step text must be 12px (desktop stays 13px) — the panel
// sits above the composer, so its height costs input room.
//
//   PORT=8901 node scripts/qa/plan-card-title-sweep.mjs
const CDP = process.env.CDP ?? "http://127.0.0.1:9222";
const BASE = process.env.BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8901}`;
const U = process.env.QA_USER ?? "scratch", P = process.env.QA_PASS ?? "scratch-pass-1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

// A token file of our own: the mock writes the handshake's plan token there (its opt-in QA hook), so
// the sweep can act as the agent without a credential ever reaching the page.
const TOKEN_FILE = path.join(os.tmpdir(), `agentus-card-title-${process.pid}.json`);

const t = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(1500);
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const w = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && w.has(m.id)) { const x = w.get(m.id); w.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); } };
const send = (m, p = {}, to = 30000) => new Promise((res, rej) => {
  const mid = ++id; const timer = setTimeout(() => { w.delete(mid); rej(new Error("TIMEOUT " + m)); }, to);
  w.set(mid, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method: m, params: p }));
});
const ev = async (x, to = 30000) => {
  const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }, to);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};
await send("Page.enable"); await send("Runtime.enable");
const closeTab = async () => { await fetch(`${CDP}/json/close/${t.id}`).catch(() => {}); };
const waitFor = async (expr, ms = 20_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await ev(expr).catch(() => 0)) return true; await sleep(250); }
  return false;
};
const goto = async (url) => { await send("Page.navigate", { url }); await sleep(1200); };

// Everything that talks to the cockpit runs INSIDE the page, so it rides the login cookie.
const api = async (p, init = {}) => ev(`(async () => {
  const r = await fetch(${JSON.stringify(p)}, ${JSON.stringify({ headers: { "content-type": "application/json" }, ...init })});
  const body = await r.text();
  try { return { status: r.status, body: JSON.parse(body) }; } catch { return { status: r.status, body }; }
})()`);

let backendBefore = null, sid = null, planToken = null;
try {
  const login = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
  if (login !== 200) throw new Error(`QA login returned ${login} — wrong instance (AGENTUS_DATA?)`);

  // --- 1: a session whose handshake carries the plan token --------------------------------
  const rows = (await api("/api/backends")).body ?? [];
  backendBefore = rows.find((r) => r.id === "mock");
  await api("/api/backends/mock", {
    method: "PATCH",
    body: JSON.stringify({ ...backendBefore, env: { ...(backendBefore?.env ?? {}), MOCK_PLAN_TOKEN_FILE: TOKEN_FILE } }),
  });
  try { fs.unlinkSync(TOKEN_FILE); } catch {}

  const created = await api("/api/sessions", {
    method: "POST", body: JSON.stringify({ backend: "mock", cwd: "/tmp", title: "card title sweep" }),
  });
  sid = created.body?.id;
  check("the sweep could open a mock session", Boolean(sid), JSON.stringify(created.body).slice(0, 160));
  if (!sid) throw new Error("no session");

  // wait for `ready`, then for the child to have written the token
  await waitFor(`(async () => {
    const r = await fetch('/api/sessions'); const b = await r.json();
    const st = (b.live ?? []).find(s => s.id === ${JSON.stringify(sid)})?.status;
    return st === "ready";
  })()`, 30_000);
  const tokReady = await (async () => {
    for (let i = 0; i < 80; i++) { if (fs.existsSync(TOKEN_FILE)) return true; await sleep(250); }
    return false;
  })();
  check("the mock wrote the handshake's plan token out (QA hook)", tokReady, TOKEN_FILE);
  if (tokReady) planToken = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")).AGENTUS_PLAN_TOKEN;

  // --- 2: the agent names its plan ---------------------------------------------------------
  const TITLE = "清空 agentus 六个 issue";
  const items = [
    { content: "rail 不再出现重复行", status: "completed" },
    { content: "⌘Enter 直接插话", status: "in_progress" },
    { content: "通知重放不再重复弹", status: "pending" },
  ];
  const upd = await ev(`(async () => {
    const r = await fetch('/api/plan/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agentus-plan-token': ${JSON.stringify(planToken)} },
      body: JSON.stringify({ session: ${JSON.stringify(sid)}, op: 'update', title: ${JSON.stringify(TITLE)}, items: ${JSON.stringify(items)} }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  })()`);
  check("the plan tool accepted the name", upd?.status === 200 && upd?.body?.plan?.title === TITLE,
    `status=${upd?.status} plan.title=${upd?.body?.plan?.title}`);

  // --- 3: the card shows it ---------------------------------------------------------------
  await goto(`${BASE}/?session=${encodeURIComponent(sid)}`);
  const rowClicked = await waitFor(`!!document.querySelector('.session-item[data-session=${JSON.stringify(sid)}]')`);
  check("the sweep's session is on the rail", rowClicked);
  const barUp = await waitFor(`!!document.querySelector('.plan-bar .plan-title')`);
  check("the live plan bar rendered", barUp);
  const shown = await ev(`(() => {
    const head = document.querySelector('.plan-bar .plan-title');
    return { headText: head?.textContent ?? null,
      dotsVisible: !!document.querySelector('.plan-bar .plan-dots'),
      count: document.querySelector('.plan-bar .plan-count')?.textContent ?? null,
      nameInHead: head ? head.textContent.includes('清空') : null };
  })()`);
  check("the HEADER stays the label 任务计划 — the name never lives there",
    shown?.headText === "任务计划" && shown?.nameInHead === false, JSON.stringify(shown));
  check("the dots and the step count own that whole line",
    shown?.dotsVisible === true && /^\d+\/\d+$/.test(shown?.count ?? ""), `dots=${shown?.dotsVisible} count=${shown?.count}`);
  check("the name is not rendered while the card is COLLAPSED (a closed card is one line)",
    (await ev(`document.querySelectorAll('.plan-bar .plan-name').length`)) === 0);

  // a name longer than the line must WRAP inside the card, not widen anything
  const LONG = "把 agentus 的任务计划面板在手机上重新排一遍包括标题和每一步的字号";
  await ev(`(async () => {
    const r = await fetch('/api/plan/mcp', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agentus-plan-token': ${JSON.stringify(planToken)} },
      body: JSON.stringify({ session: ${JSON.stringify(sid)}, op: 'update', title: ${JSON.stringify(LONG)}, items: ${JSON.stringify(items)} }) });
    return r.status;
  })()`);
  await sleep(600);
  await ev(`document.querySelector('.plan-bar .plan-head')?.click()`);
  const nameUp = await waitFor(`!!document.querySelector('.plan-bar .plan-name')`, 4000);
  check("opening the card reveals the name as its first line", nameUp);
  const wide = await ev(`(() => {
    const bar = document.querySelector('.plan-bar');
    const head = document.querySelector('.plan-bar .plan-head');
    const el = document.querySelector('.plan-bar .plan-name');
    const first = document.querySelector('.plan-bar .plan-body > *');
    const lines = el ? Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight || '18')) : 0;
    return { barOverflow: bar ? bar.scrollWidth - bar.clientWidth : -1,
      headOverflow: head ? head.scrollWidth - head.clientWidth : -1,
      isFirstRow: first === el, wraps: lines > 1, lines,
      text: el?.textContent ?? null };
  })()`);
  check("a 40-character name does not widen the bar or the header",
    wide.barOverflow <= 1 && wide.headOverflow <= 1, JSON.stringify(wide));
  check("…it is the card's FIRST row, verbatim (no ellipsis in the middle of a task name)",
    wide.isFirstRow === true && wide.text === LONG, JSON.stringify(wide));

  // --- 4: the phone: steps one size down ---------------------------------------------------
  // Section 3 left the card OPEN; a second click here would collapse it and `getComputedStyle` would
  // then be measuring a node that does not exist (that is how this suite went red for a day).
  const opened = await waitFor(`!!document.querySelector('.plan-bar .plan-step')`, 4000);
  check("the card is open, so its steps are real nodes", opened);
  const deskFont = await ev(`(() => { const s = document.querySelector('.plan-bar .plan-step');
    return s ? getComputedStyle(s).fontSize : null; })()`);
  check("desktop steps stay 13px", deskFont === "13px", deskFont);

  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await sleep(800);
  const phone = await ev(`(() => {
    const step = document.querySelector('.plan-bar .plan-step');
    const name = document.querySelector('.plan-bar .plan-name');
    const head = document.querySelector('.plan-bar .plan-title');
    const exp = document.querySelector('.plan-bar .plan-explanation');
    return { stepFont: step ? getComputedStyle(step).fontSize : null,
      nameFont: name ? getComputedStyle(name).fontSize : null,
      nameText: name?.textContent ?? null,
      headFont: head ? getComputedStyle(head).fontSize : null,
      expFont: exp ? getComputedStyle(exp).fontSize : null,
      nameVisible: name ? name.getBoundingClientRect().height > 10 : false,
      nameLines: name ? Math.round(name.getBoundingClientRect().height / parseFloat(getComputedStyle(name).lineHeight || '18')) : 0,
      nameOverflowsX: name ? name.scrollWidth - name.clientWidth : -1 };
  })()`);
  check("on a 390px phone a plan step is 12px (`稍微小一点点`, not unreadable)",
    phone?.stepFont === "12px", phone?.stepFont);
  check("…and the name is still there and still readable at that width",
    phone?.nameText === LONG && phone?.nameVisible === true, JSON.stringify(phone));
  check("…without outgrowing the steps it titles (12.5px vs 12px, header 12.5px)",
    phone?.nameFont === "12.5px" && phone?.headFont === "12.5px", JSON.stringify(phone));
  check("…and on that width the name WRAPS (it may never be clipped or scrolled sideways)",
    phone?.nameLines > 1 && phone?.nameOverflowsX <= 1, JSON.stringify(phone));

  await send("Emulation.clearDeviceMetricsOverride");
  await sleep(600);

  // --- 5: no name ⇒ the old label (no regression for agents that never send one) -----------
  await ev(`(async () => {
    const r = await fetch('/api/plan/mcp', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agentus-plan-token': ${JSON.stringify(planToken)} },
      body: JSON.stringify({ session: ${JSON.stringify(sid)}, op: 'update', title: null, items: ${JSON.stringify(items)} }) });
    return r.status;
  })()`);
  const fellBack = await waitFor(`document.querySelectorAll('.plan-bar .plan-name').length === 0`, 5000);
  check("the clear reached the page: the name row is gone", fellBack);
  const fallback = await ev(`({ head: document.querySelector('.plan-bar .plan-title')?.textContent ?? null,
    names: document.querySelectorAll('.plan-bar .plan-name').length,
    steps: document.querySelectorAll('.plan-bar .plan-step').length })`);
  check("an unnamed plan is only its label and its steps (no empty first row)",
    fallback?.head === "任务计划" && fallback?.names === 0 && fallback?.steps === 3, JSON.stringify(fallback));
  // put the name back: the next section archives THIS plan into the transcript
  await ev(`(async () => {
    const r = await fetch('/api/plan/mcp', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agentus-plan-token': ${JSON.stringify(planToken)} },
      body: JSON.stringify({ session: ${JSON.stringify(sid)}, op: 'update', title: ${JSON.stringify(TITLE)}, items: ${JSON.stringify(items)} }) });
    return r.status;
  })()`);
  check("…and a name can come back after being cleared",
    await waitFor(`document.querySelector('.plan-bar .plan-name')?.textContent === ${JSON.stringify(TITLE)}`, 5000));

  // --- 6: the name survives the trip into the transcript -----------------------------------
  // A plan is retired when a NEW turn's plan arrives: the old one becomes an ARCHIVED card in the
  // transcript, where it must keep its OWN name (the bug shape would be the header flipping back to
  // 任务计划, or — worse — the new name leaking onto the old card).
  await ev(`(async () => {
    const r = await fetch('/api/sessions/${sid}/prompt', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'next turn' }) });
    return r.status;
  })()`);
  const idleAgain = await waitFor(`(async () => {
    const b = await (await fetch('/api/sessions')).json();
    const st = (b.live ?? []).find(s => s.id === ${JSON.stringify(sid)})?.status;
    return st !== 'running' && st !== 'starting';
  })()`, 30_000);
  check("the session finished its turn (so the plan has somewhere to be archived)", idleAgain);
  const SECOND = "第二轮：换一份计划";
  const secondUpd = await ev(`(async () => {
    const r = await fetch('/api/plan/mcp', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agentus-plan-token': ${JSON.stringify(planToken)} },
      body: JSON.stringify({ session: ${JSON.stringify(sid)}, op: 'update', title: ${JSON.stringify(SECOND)},
        items: [{ content: '第二轮的步骤', status: 'in_progress' }] }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  })()`);
  check("the second update was accepted", secondUpd?.body?.accepted === true,
    `status=${secondUpd?.status} accepted=${secondUpd?.body?.accepted} reason=${secondUpd?.body?.reason} plan.title=${secondUpd?.body?.plan?.title}`);
  const archived = await waitFor(`[...document.querySelectorAll('.plan-card .plan-title')].length > 0`, 8000);
  check("a plan card was archived into the transcript", archived);
  // The archived card is COLLAPSED in the transcript (one line, like a tool row), so opening it is what
  // reveals its name — and the card must show its OWN name, not the live plan's.
  await ev(`[...document.querySelectorAll('.plan-card .plan-head')].pop()?.click()`);
  const archivedName = await waitFor(`[...document.querySelectorAll('.plan-card .plan-name')].length > 0`, 5000)
    ? await ev(`[...document.querySelectorAll('.plan-card .plan-name')].map(e => e.textContent)`)
    : [];
  check("the retired plan keeps its own name in the transcript", archivedName.includes(TITLE), JSON.stringify(archivedName));
  const nowBar = await waitFor(`document.querySelector('.plan-bar .plan-name')?.textContent === ${JSON.stringify(SECOND)}`, 5000)
    ? SECOND
    : await ev(`document.querySelector('.plan-bar .plan-name')?.textContent ?? null`);
  check("…and the live card opens on the NEW plan's name", nowBar === SECOND, String(nowBar));
} catch (e) {
  fail++;
  console.log("FAIL  sweep threw —", e.message);
} finally {
  try { await ev(`fetch('/api/sessions/${sid}', { method: 'DELETE' })`).catch(() => {}); } catch {}
  if (backendBefore) {
    try {
      await api("/api/backends/mock", {
        method: "PATCH",
        body: JSON.stringify({ ...backendBefore, env: (backendBefore.env ?? {}) }),
      });
    } catch {}
  }
  try { fs.unlinkSync(TOKEN_FILE); } catch {}
  await closeTab();
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
