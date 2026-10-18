// 语音播报总结 in the REAL page: long-press a message's speaker → the menu → the summary is bought
// once, replayed from cache, and forgotten on demand — plus the server's own edges (verbatim / 409 /
// 404 / truncated) called directly, so a regression in the route fails here rather than in review.
//
//   PORT=8901 node scripts/qa/speech-summary-dom.mjs
const CDP = process.env.CDP ?? "http://127.0.0.1:9222";
const BASE = process.env.BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8901}`;
const U = process.env.QA_USER ?? "scratch", P = process.env.QA_PASS ?? "scratch-pass-1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

// The provider half of this sweep needs a session whose stored model carries a provider prefix
// (`deepseek:deepseek-v4-flash`) — a mock-backed QA session has none, and without one the route can
// only ever prove the fallback. The fixture is written into the QA store and put back at the end,
// so a re-run starts from the same place and the operator's data is untouched on exit.
const QA_DB = process.env.QA_DB ?? "/tmp/agentus-qa-account/agentus.sqlite";
const FIXTURE = "deepseek:deepseek-v4-flash";
let sqlite = null, restoreModels = [];
try {
  const { DatabaseSync } = await import("node:sqlite");
  sqlite = new DatabaseSync(QA_DB);
  const rows = sqlite.prepare("select id, models from sessions where models is null or models not like '%:%'").all();
  for (const r of rows) {
    restoreModels.push({ id: r.id, models: r.models ?? null });
    sqlite.prepare("update sessions set models = ? where id = ?").run(JSON.stringify({ currentModelId: FIXTURE, availableModels: [] }), r.id);
  }
  console.log(`fixture: ${restoreModels.length} session(s) set to ${FIXTURE} for this run`);
} catch (e) {
  console.log(`fixture: skipped (${String(e).slice(0, 80)}) — the provider assertion will only see the fallback route`);
}

const t = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(1500);
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const w = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && w.has(m.id)) { const x = w.get(m.id); w.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); } };
const send = (m, p = {}, to = 40000) => new Promise((res, rej) => {
  const mid = ++id; const timer = setTimeout(() => { w.delete(mid); rej(new Error("TIMEOUT " + m)); }, to);
  w.set(mid, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method: m, params: p }));
});
const ev = async (x, to = 40000) => {
  const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }, to);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};
const waitFor = async (expr, ms = 20_000) => { const until = Date.now() + ms; while (Date.now() < until) { if (await ev(expr).catch(() => 0)) return true; await sleep(250); } return false; };
await send("Page.enable"); await send("Runtime.enable");

try {
  const login = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
  if (login !== 200) throw new Error(`QA login returned ${login} — wrong instance (AGENTUS_DATA?)`);
  await ev(`location.reload()`);
  await sleep(1800);

  // ---- 服务端四条边，直接打接口（不经过 UI）----
  // /api/sessions is bucketed ({live, cold, archived, ...}), not a flat array — and the session the
  // browser just opened is the one whose speakers this sweep is about.
  const pickedIds = await ev(`(async () => {
    const d = await (await fetch('/api/sessions')).json();
    const all = [...(d.live ?? []), ...(d.cold ?? [])].map((s) => ({ id: s.id, model: s.models?.currentModelId ?? null }));
    return { all, firstPrefixed: all.find((s) => (s.model ?? '').includes(':')) ?? null };
  })()`);
  // A session whose model carries a provider prefix (`deepseek:deepseek-v4-flash`) is the one that
  // can prove 语音总结 follows the session's own provider; otherwise fall back to the first session.
  const sid = (pickedIds.firstPrefixed ?? pickedIds.all[0])?.id ?? null;
  const sessionModel = (pickedIds.firstPrefixed ?? pickedIds.all[0])?.model ?? null;
  check("found a session to read messages from", Boolean(sid), String(sid));
  const picked = await ev(`(async () => {
    const d = await (await fetch('/api/sessions/${sid}/messages?tail=1')).json();
    const agent = (d.messages ?? []).filter((m) => m.kind === 'agent');
    return agent.length ? { n: agent.length } : null;
  })()`);
  check("…with agent messages in it (the speaker only exists there)", Boolean(picked), JSON.stringify(picked));

  const edges = await ev(`(async () => {
    const call = async (key) => {
      const r = await fetch('/api/sessions/${sid}/speech-summary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const nope = await call('definitely-not-a-key');
    const s = await (await fetch('/api/settings')).json();
    const enabled = s.summary?.enabled ?? true;
    await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ summary: { enabled: false } }) });
    const off = await call('definitely-not-a-key');
    await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ summary: { enabled } }) });
    return { nope: nope.status, off: off.status, offMsg: off.body?.error ?? '' , charsRange: s.summaryCharsRange, model: s.summaryModelDefault, followSession: s.summary?.followSession };
  })()`);
  check("an unknown message key is a 404", edges.nope === 404, String(edges.nope));
  check("the switch being off refuses with 409 (never a silent verbatim fallback)", edges.off === 409, `${edges.off} ${edges.offMsg}`);
  check("…and the settings name the default model and the allowed range", Boolean(edges.model) && Array.isArray(edges.charsRange), JSON.stringify([edges.model, edges.charsRange]));
  check("…followSession is on by default (the summary is billed to the session's own provider)", edges.followSession === true, String(edges.followSession));

  // The provider half: the response says which account paid, and a session running
  // `deepseek:…` must produce route=session / provider=deepseek — not a silent Bailian fallback.
  // The browser's key is `agent:<messageId>` (transcript.ts blockKeyOf) — the REST rows do not carry
  // the stored block_key, so pick the LONGEST agent block that has a messageId (it must exceed
  // maxChars, or the route answers verbatim and never touches a model).
  const lastKey = await ev(`(async () => {
    const d = await (await fetch('/api/sessions/${sid}/messages?tail=1')).json();
    const agent = (d.messages ?? []).filter((m) => m.kind === 'agent' && typeof m.payload?.messageId === 'string');
    if (!agent.length) return null;
    agent.sort((a, b) => String(b.payload?.content?.text ?? '').length - String(a.payload?.content?.text ?? '').length);
    return 'agent:' + agent[0].payload.messageId;
  })()`);
  const route = lastKey ? await ev(`(async () => {
    const r = await fetch('/api/sessions/${sid}/speech-summary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: ${JSON.stringify(lastKey)} }) });
    const b = await r.json().catch(() => ({}));
    return { status: r.status, route: b.route, provider: b.provider, model: b.model, note: b.routeNote, via: b.via };
  })()`) : null;
  const expectProvider = String(sessionModel ?? '').split(':')[0];
  if (route && route.status === 200 && route.via === 'model') {
    check("a model call reports which account paid (route/provider)", route.route === "session" && route.provider === expectProvider,
      JSON.stringify({ route: route.route, provider: route.provider, expectProvider, note: route.note }));
    check("…and the model it used is the session's own", String(route.model ?? '').includes(String(sessionModel ?? '').split(':').slice(1).join(':')), JSON.stringify(route.model));
  } else {
    check("a model call reports which account paid (route/provider)", false, JSON.stringify(route));
  }

  // ---- UI：长按 → 菜单 → 播报稿 ----
  await ev(`(() => { window.__sumCalls = 0; const f = window.fetch; window.fetch = (...a) => { const u = String(a[0]); if (u.includes('/speech-summary')) window.__sumCalls++; return f(...a); }; })()`);
  const speaks = `.bubble-actions .bubble-btn.speak`;
  check("messages carry a speaker", await waitFor(`document.querySelectorAll('${speaks}').length > 0`));
  // The note grows the bubble, so the last speaker moves between presses: scroll it into view
  // first, otherwise a y beyond the viewport is a click on nothing (and the menu never opens).
  const spot = () => ev(`(() => {
    const el = [...document.querySelectorAll('${speaks}')].pop();
    el.scrollIntoView({ block: 'center' });
    const b = el.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  })()`);
  const press = async (ms) => {
    const p = await spot();
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", buttons: 1, clickCount: 1 });
    await sleep(ms);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", buttons: 0, clickCount: 1 });
    await sleep(350);
  };

  await press(650);
  check("a 650ms hold on the message speaker opens its menu", await ev(`Boolean(document.querySelector('.bubble-menu'))`));
  check("…without buying anything yet", (await ev(`window.__sumCalls`)) === 0);
  const label = await ev(`document.querySelector('.bubble-menu [data-speak-summary]')?.textContent ?? ''`);
  check("…offering 语音播报总结", label.includes("总结"), label);

  await ev(`document.querySelector('.bubble-menu [data-speak-summary]').click()`);
  const noted = await waitFor(`Boolean(document.querySelector('.speech-note'))`, 40_000);
  check("clicking it produces a 播报稿 line", noted);
  const note = await ev(`(() => { const n = document.querySelector('.speech-note'); if (!n) return null; return {
    chars: Number(n.getAttribute('data-summary-chars') || 0),
    text: n.querySelector('.speech-note-text')?.textContent ?? '',
    meta: n.querySelector('.speech-note-meta')?.textContent ?? '',
    lines: Math.round(n.getBoundingClientRect().height / 20),
  }; })()`);
  check("…with the字数 the server reported", note && note.chars > 0, JSON.stringify(note?.chars));
  check("…a single line of speech, not the original transcript", note && !note.text.includes("\n"), JSON.stringify(note?.text?.slice(0, 40)));
  check("…and how long it took / which model", note && /字/.test(note.meta) && /(s|秒)/.test(note.meta), note?.meta);
  check("…naming the provider that paid", /deepseek|openrouter|voice|语音端点/i.test(note?.meta ?? ""), note?.meta);
  const afterFirst = await ev(`window.__sumCalls`);
  check("exactly one model call for it", afterFirst === 1, String(afterFirst));

  // 再长按再点：缓存命中，不再买第二段
  await press(650);
  await ev(`document.querySelector('.bubble-menu [data-speak-summary]').click()`);
  await sleep(900);
  check("a second long press replays the cached summary (no second call)", (await ev(`window.__sumCalls`)) === 1, String(await ev(`window.__sumCalls`)));

  // ✕ → 作废 → 下一次重新生成
  await ev(`document.querySelector('.speech-note-x').click()`);
  await sleep(250);
  check("✕ drops the note", !(await ev(`Boolean(document.querySelector('.speech-note'))`)));
  await press(650);
  await ev(`document.querySelector('.bubble-menu [data-speak-summary]').click()`);
  const again = await waitFor(`Boolean(document.querySelector('.speech-note'))`, 40_000);
  check("…and the next press buys a fresh one", again && (await ev(`window.__sumCalls`)) === 2, String(await ev(`window.__sumCalls`)));
  // ---- 设置 → 语音 → 语音总结 ----
  await ev(`document.querySelector('.rail-gear')?.click()`);
  await sleep(700);
  await ev(`[...document.querySelectorAll('.set-nav-cat')].find(b => b.textContent.trim() === '语音')?.click()`);
  await sleep(400);
  const navItem = await ev(`[...document.querySelectorAll('.set-nav-item')].some(b => b.textContent.trim() === '语音总结')`);
  check("设置 lists 语音总结 under 语音", navItem);
  await ev(`[...document.querySelectorAll('.set-nav-item')].find(b => b.textContent.trim() === '语音总结')?.click()`);
  await sleep(500);
  check("the card renders with its switch, chips and prompt", await waitFor(`Boolean(document.querySelector('#set-summary input[type=checkbox]'))`));
  const cardText = await ev(`document.getElementById('set-summary')?.innerText ?? ''`);
  check("…explaining it does not go through the agent and carries no history",
    cardText.includes("不经过") && cardText.includes("历史"), "…");
  check("…showing the built-in prompt it will actually send",
    /改写|摘要/.test(await ev(`document.querySelector('#set-summary .set-builtin-text')?.textContent ?? ''`)));

  const beforeChars = await ev(`(async () => (await (await fetch('/api/settings')).json()).summary.maxChars)()`);
  await ev(`(() => {
    const n = document.querySelector('#set-summary input[type=number]');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(n, "130");
    n.dispatchEvent(new Event('input', { bubbles: true }));
    n.focus(); n.blur();
    n.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    return true;
  })()`);
  await sleep(1200);
  const afterChars = await ev(`(async () => (await (await fetch('/api/settings')).json()).summary.maxChars)()`);
  check("changing 字数上限 lands on the server", afterChars === 130, `${beforeChars} → ${afterChars}`);
  await ev(`(async () => { await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ summary: { maxChars: ${Number(beforeChars)} } }) }); })()`);
  await sleep(400);
  check("…and the sweep puts it back", (await ev(`(async () => (await (await fetch('/api/settings')).json()).summary.maxChars)()`)) === beforeChars);
} finally {
  if (sqlite) {
    for (const r of restoreModels) {
      sqlite.prepare("update sessions set models = ? where id = ?").run(r.models, r.id);
    }
    sqlite.close();
  }
  await fetch(`${CDP}/json/close/${t.id}`).catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
