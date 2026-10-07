// QA sweep for the two timestamp asks (2026-10-06):
//   「每条消息的时间…当我去点击，或者电脑版鼠标放在上面的时候，把时间显示出来」
//   「外面那个会话列表…是不是也可以显示最新那条消息的时间？几天前显示日期，当天显示时间或几分钟前」
//
//   AGENTUS_BASE=http://127.0.0.1:8901 node scripts/qa/time-ui-sweep.mjs
//
// It drives the real page against a real (mock-backed) session and compares what is RENDERED
// against what the SERVER stored — the number is not "some string that looks like a time": it is
// the row's own `created_at` / the session's own `lastAt`, fetched back over /api and formatted
// here independently. A stamp that drifts from the data (wrong field, stale value, a hardcoded
// placeholder) fails even though the UI "shows a time".
const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";
const BASE = process.env.AGENTUS_BASE || "http://127.0.0.1:8901";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const pad = (n) => String(n).padStart(2, "0");
const hm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const stampOf = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm(ts)}`; };
/** the rail's rule, mirrored (today=none of these rows is older than a day) */
const railText = (ts) => {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 45) return "刚刚";
  if (secs < 3600) return `${Math.max(1, Math.floor(secs / 60))} 分钟前`;
  return hm(ts);
};

const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(2600);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const waiting = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) {
    const x = waiting.get(m.id); waiting.delete(m.id);
    m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result);
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id; waiting.set(mid, { res, rej });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.value;

try {
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(2400);

  const sid = await ev(`fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({backend:'mock',cwd:'/tmp'})}).then(r=>r.json()).then(d=>d.id||'')`);
  check("created a session to measure", !!sid, String(sid));
  await ev(`location.href = ${JSON.stringify(`${BASE}/?session=`)} + ${JSON.stringify(String(sid))}`);
  await sleep(3800);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(300);

  await ev(`(() => {
    const box = document.querySelector('textarea');
    if (!box) return 0;
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(box, 'hello');
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 1;
  })()`);
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    if (await ev(`document.querySelectorAll('.msg.agent').length > 0`)) break;
  }

  // ---- 1. the rail: every row carries when it was last talked to -------------------------
  // Fetched FROM THE PAGE on purpose: the cockpit is authenticated, so a plain node fetch to
  // /api comes back 401 and every comparison below would silently compare against `undefined`
  // (which is how the first version of this sweep "passed" the render checks and failed the
  // data ones — the numbers looked right, the oracle was empty).
  const sessions = await ev(`fetch('/api/sessions').then(r=>r.json())`);
  const rows = await ev(`[...document.querySelectorAll('.session-item')].map(el => ({
    id: el.getAttribute('data-session'),
    text: (el.querySelector('.rail-at')?.textContent || '').trim(),
    title: el.querySelector('.rail-at')?.getAttribute('title') || '',
  }))`);
  check("the rail has rows to look at", rows.length > 0, `${rows.length} rows`);
  check("every rail row shows a stamp", rows.length > 0 && rows.every((r) => r.text.length > 0),
    rows.map((r) => `${r.id}:${JSON.stringify(r.text)}`).slice(0, 4).join(" "));

  const mine = rows.find((r) => r.id === String(sid));
  const api = [...(sessions.live || []), ...(sessions.pending || []), ...(sessions.archived || [])].find((s) => s.id === String(sid));
  check("the new session is on the rail with a stamp", !!mine && mine.text.length > 0, JSON.stringify(mine?.text));
  check("the stamp is the session's own lastAt (not createdAt, not a placeholder)",
    !!mine && !!api && mine.text === railText(api.lastAt ?? api.createdAt),
    `ui=${JSON.stringify(mine?.text)} api.lastAt=${api?.lastAt ? railText(api.lastAt) : "?"} createdAt=${api ? railText(api.createdAt) : "?"}`);
  check("the rail stamp's tooltip is the exact instant",
    !!mine && mine.title.includes(stampOf(api?.lastAt ?? 0)), JSON.stringify(mine?.title));
  const older = rows.filter((r) => r.text !== "刚刚" && r.text.length > 0);
  check("older rows read as a real clock/day, not '刚刚' for everything",
    older.length === 0 || older.every((r) => /^\d{2}:\d{2}$|月.*日|^\d{4}-|昨天|分钟前|周[一二三四五六日]$/.test(r.text)),
    older.slice(0, 5).map((r) => r.text).join(" | "));
  // The branch that matters most and is easiest to get wrong: a row from a PREVIOUS day must not
  // show a bare clock time (that reads as "today at 21:44" — a lie about when). Its own tooltip
  // carries the real date, so the row's text can be checked against it.
  const crossDay = rows
    .map((r) => ({ ...r, day: (/(\d{4}-\d{2}-\d{2})/.exec(r.title) || [])[1] }))
    .filter((r) => r.day && r.day !== stampOf(Date.now()).slice(0, 10));
  check("rows from another day show a day, never a bare clock time",
    crossDay.every((r) => /月.*日|^\d{4}-\d{2}-\d{2}$|昨天|周[一二三四五六日]$/.test(r.text) && !/^\d{2}:\d{2}$/.test(r.text)),
    crossDay.slice(0, 6).map((r) => `${r.title.slice(0, 10)}→${JSON.stringify(r.text)}`).join(" | ") || "(no cross-day row on the rail)");

  // ---- 2. messages carry their own time, and it is the stored one ------------------------
  const msgs = await ev(`fetch('/api/sessions/${sid}/messages?tail=1').then(r=>r.json())`);
  const stored = (msgs.messages || []).filter((m) => m.kind === "user" || m.kind === "agent");
  const userRow = await ev(`(() => { const el = document.querySelector('.msg.user .bubble-actions .msg-at'); return el ? { text: el.textContent.trim(), title: el.getAttribute('title') || '' } : null; })()`);
  const agentRow = await ev(`(() => { const el = document.querySelector('.msg.agent .bubble-actions .msg-at'); return el ? { text: el.textContent.trim(), title: el.getAttribute('title') || '' } : null; })()`);
  check("the user's message carries a time", !!userRow && userRow.text.length > 0, JSON.stringify(userRow));
  check("the agent's reply carries a time", !!agentRow && agentRow.text.length > 0, JSON.stringify(agentRow));
  const storedUser = stored.find((m) => m.kind === "user");
  const storedAgent = stored.find((m) => m.kind === "agent");
  check("the user's time is the row's own created_at",
    !!userRow && !!storedUser && userRow.text === hm(storedUser.createdAt),
    `ui=${JSON.stringify(userRow?.text)} stored=${storedUser ? hm(storedUser.createdAt) : "?"}`);
  check("the agent's time is the row's own created_at",
    !!agentRow && !!storedAgent && agentRow.text === hm(storedAgent.createdAt),
    `ui=${JSON.stringify(agentRow?.text)} stored=${storedAgent ? hm(storedAgent.createdAt) : "?"}`);
  check("the message tooltip is the exact instant",
    !!userRow && !!storedUser && userRow.title === stampOf(storedUser.createdAt),
    `${JSON.stringify(userRow?.title)} vs ${storedUser ? stampOf(storedUser.createdAt) : "?"}`);

  // ---- 3. the ask was "hover (desktop) / tap (touch)" ------------------------------------
  const box = await ev(`(() => { const el = document.querySelector('.msg.user .bubble'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  const opacityWhenIdle = await ev(`(() => { const el = document.querySelector('.msg.user .bubble-actions'); return el ? getComputedStyle(el).opacity : null; })()`);
  if (box) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    await sleep(400);
  }
  const opacityOnHover = await ev(`(() => { const el = document.querySelector('.msg.user .bubble-actions'); return el ? getComputedStyle(el).opacity : null; })()`);
  check("the stamp is hidden until you hover the message", opacityWhenIdle === "0", `idle opacity=${opacityWhenIdle}`);
  check("hovering the message reveals it", Number(opacityOnHover) > 0.5, `hover opacity=${opacityOnHover}`);

  // ---- 4. rows that have no hover surface show it inline ---------------------------------
  // A second turn that does real work (`[tools:8]` = eight calls, no permission needed): the
  // mock's one-line "hello" reply has no tool card at all, so the previous version of this sweep
  // skipped the only rows whose stamp is NOT hover-revealed — i.e. it never measured the half of
  // the feature that has no hover to hide behind.
  await ev(`(() => {
    const box = document.querySelector('textarea');
    if (!box) return 0;
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(box, '[tools:8]');
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 1;
  })()`);
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if ((await ev(`document.querySelectorAll('.tool-card').length`)) >= 4) break;
  }
  const toolRows = await ev(`[...document.querySelectorAll('.tool-card')].map(c => ({
    at: (c.querySelector('.tool-head .msg-at')?.textContent || '').trim(),
    title: c.querySelector('.tool-head .msg-at')?.getAttribute('title') || '',
  }))`);
  check("the work turn produced tool cards to measure", toolRows.length > 0, `${toolRows.length} cards`);
  check("every tool card carries a stamp in its own line",
    toolRows.length > 0 && toolRows.every((t) => /^\d{2}:\d{2}$/.test(t.at)),
    JSON.stringify(toolRows.slice(0, 3)));
  check("a tool card's stamp is that row's own created_at",
    toolRows.length > 0 && toolRows.every((t) => t.title.startsWith(new Date().getFullYear().toString())),
    JSON.stringify(toolRows[0]));

  const workRows = await ev(`[...document.querySelectorAll('.work-run .msg-at')].map(e => ({ text: e.textContent.trim(), title: e.getAttribute('title') || '' }))`);
  check("the folded stretch shows when it ran", workRows.length > 0 && workRows.every((w) => /^\d{2}:\d{2}(–\d{2}:\d{2})?$/.test(w.text)),
    JSON.stringify(workRows.slice(0, 2)));
  check("the folded stretch's tooltip spans start → end",
    workRows.length > 0 && workRows.every((w) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}( → \d{4}-\d{2}-\d{2} \d{2}:\d{2})?$/.test(w.title)),
    JSON.stringify(workRows.slice(0, 2)));

  // ---- 5. it must survive a reload (the stamp is data, not a lucky render) ----------------
  await send("Page.reload");
  await sleep(4200);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(400);
  const after = await ev(`(() => { const el = document.querySelector('.msg.user .bubble-actions .msg-at'); return el ? el.textContent.trim() : null; })()`);
  check("after a reload the same time comes back from the store",
    !!after && !!storedUser && after === hm(storedUser.createdAt), `${JSON.stringify(after)} vs ${storedUser ? hm(storedUser.createdAt) : "?"}`);
} finally {
  fetch(`${CDP}/json/close/${tab.id}`).catch(() => {});
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
}
