// The two shapes from issues #13 / #14, measured on the REAL page in the operator's own viewport.
//
// #13 — waking an ACP session used to draw the same rail row 2~3 times (every copy highlighted, then
//       it healed itself). The rail renders two client buckets by concatenation, and a spawn is a
//       storm of single-row `t:"session"` frames, so the previous copy lived on in `cold`. This samples
//       the rendered rail every 100 ms ACROSS a real wake (create → close → resume) and asserts no id
//       is ever drawn twice. The unit half is scripts/qa/rail-dup.mts.
// #14 — ⌘/Ctrl+Enter must take the floor: a synthetic keydown with the modifier on the composer has to
//       put the text on the WIRE (the server's transcript is the proof), while a plain Enter on the
//       same box only files it. The unit half is scripts/qa/insert-sweep.mts.
//
//   PORT=8901 node scripts/qa/composer-insert-sweep.mjs
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
  while (Date.now() < until) { if (await ev(expr).catch(() => 0)) return true; await sleep(250); }
  return false;
};

try {
  const login = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
  if (login !== 200) throw new Error(`QA login returned ${login} — wrong instance (AGENTUS_DATA?)`);
  const api = async (path, init = {}) => ev(`(() => {
    const r = await fetch(${JSON.stringify(path)}, ${JSON.stringify({ headers: { "content-type": "application/json" }, ...init })});
    const body = await r.text();
    try { return { status: r.status, body: JSON.parse(body) }; } catch { return { status: r.status, body }; }
  })()`.replace("(() => {", "(async () => {"));
  const mkSession = async (title) => (await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "mock", cwd: "/tmp", title }) })).body?.id;

  // ================= #13: waking a session must not duplicate its rail row =================
  const woke = await mkSession("wake-dup probe（自动删除）");
  if (!woke) throw new Error("could not create the wake probe");
  console.log(`      wake probe = ${woke}`);
  // close it so it becomes COLD (no process) — that is the bucket the duplicate copy lived in
  await api(`/api/sessions/${woke}`, { method: "DELETE" });
  await sleep(1200);
  await ev(`location.href = ${JSON.stringify(BASE)} + '/?session=' + ${JSON.stringify(woke)}`).catch(() => {});
  const booted = await waitFor(`document.querySelector('.composer textarea') ? 1 : 0`);
  check("the page booted before the rail is sampled (a login wall is not a rail)", booted);

  // Sample ACROSS the wake: the duplicate was transient, so a single reading after it settles proves
  // nothing. `maxSeen` is the number the operator would have seen at the worst moment.
  const resume = api(`/api/sessions/${woke}/resume`, { method: "POST" });
  let maxSeen = 0, samples = 0, detail = "";
  const t0 = Date.now();
  while (Date.now() - t0 < 9_000) {
    const n = await ev(`(() => {
      const rows = [...document.querySelectorAll('.session-item')].map((e) => e.dataset.session).filter(Boolean);
      const hit = rows.filter((x) => x === ${JSON.stringify(woke)}).length;
      const dups = rows.filter((v, i) => rows.indexOf(v) !== i);
      return { hit, dups: dups.length };
    })()`);
    samples += 1;
    if (n.hit > maxSeen) { maxSeen = n.hit; detail = `${n.hit} rows for the waking session, ${n.dups} duplicated ids in the whole rail`; }
    if (maxSeen > 1) break;
    await sleep(100);
  }
  const resumed = await resume;
  check("the wake really happened (the probe was cold and is now live)", resumed.status === 200, `HTTP ${resumed.status}`);
  check("the waking session is never drawn TWICE in the rail (issue #13)", maxSeen <= 1,
    `${detail || `${maxSeen} max over ${samples} samples`}`);

  // ================= #14: ⌘/Ctrl+Enter takes the floor =================
  const chat = await mkSession("insert probe（自动删除）");
  if (!chat) throw new Error("could not create the composer probe");
  console.log(`      chat probe = ${chat}`);
  await ev(`location.href = ${JSON.stringify(BASE)} + '/?session=' + ${JSON.stringify(chat)}`).catch(() => {});
  const up = await waitFor(`document.querySelector('.composer textarea') && document.querySelector('.session-item.active') ? 1 : 0`);
  check("the composer is up for the probe session", up);
  const idle = await waitFor(`fetch('/api/sessions',{credentials:'include'}).then(r=>r.json()).then(j=>((j.live||[]).find(s=>s.id===${JSON.stringify(chat)})||{}).status==='ready'?1:0)`, 20_000);
  check("the probe session reached `ready` (fixture precondition)", idle);

  // A turn that lasts LONGER than the assertion window: `[slow]` raises the mock's per-chunk delay to
  // 900 ms and its echo is ~20 words, measured 17.4 s on this box. That is what makes the next check
  // discriminating — a plain Enter only FILES the text, and the queue drains at turn-end, so a message
  // stored inside 7 s can only have come from the interrupt path.
  const started = await ev(`fetch('/api/sessions/'+${JSON.stringify(chat)}+'/prompt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'[slow] 先跑一会儿，等下我要插话'})}).then(r=>r.status)`);
  check("the slow turn was accepted", started === 202, `HTTP ${started}`);
  // Read the hint ONCE, after the turn is confirmed in flight — never "wait until the hint appears":
  // on a build that does not have it that wait burns the whole slow turn, and the next check needs
  // that turn still running to be discriminating.
  const running = await waitFor(`fetch('/api/sessions',{credentials:'include'}).then(r=>r.json()).then(j=>((j.live||[]).find(s=>s.id===${JSON.stringify(chat)})||{}).status==='running'?1:0)`, 10_000);
  check("the probe turn really is in flight (fixture precondition for the shortcut check)", running);
  await sleep(500); // one publish + one paint
  const busyPh = await ev(`document.querySelector('.composer textarea')?.placeholder ?? '(no textarea)'`);
  // Assert the BEHAVIOUR the hint advertises, not one wording: it must name the interrupt shortcut
  // AND the queueing fallback, on whichever viewport this run has (headless defaults to wide).
  check("a busy composer says how to 插话 (discoverability, #14)",
    /Enter interrupts/.test(busyPh) && /Enter queues/.test(busyPh), busyPh);

  // Type through the real input path (React's onChange sees a native input event), then press the key.
  await ev(`document.querySelector('.composer textarea').focus()`);
  await send("Input.insertText", { text: "插话：先停一下，改成跑测试" });
  const typed = await ev(`document.querySelector('.composer textarea').value`);
  check("the text landed in the composer", typed.includes("插话"), JSON.stringify(typed));
  const dispatched = await ev(`(() => {
    const ta = document.querySelector('.composer textarea');
    const e = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true });
    return ta.dispatchEvent(e) ? 'not-prevented' : 'prevented';
  })()`);
  check("the shortcut was handled by the composer (default prevented)", dispatched === "prevented", dispatched);

  // The far side: the server's own transcript is the proof the words reached the agent — AND WHEN it
  // did. The first turn is still streaming (~18 s); anything stored before that ends is the interrupt,
  // because Enter can only file into a queue that drains at turn-end.
  let rows = [];
  const keyedAt = Date.now();
  while (Date.now() - keyedAt < 7_000) {
    rows = (await api(`/api/sessions/${chat}/messages`)).body?.messages ?? [];
    if (rows.some((m) => m.kind === "user" && JSON.stringify(m.payload ?? "").includes("改成跑测试"))) break;
    await sleep(300);
  }
  const elapsed = Date.now() - keyedAt;
  const landed = rows.some((m) => m.kind === "user" && JSON.stringify(m.payload ?? "").includes("改成跑测试"));
  check("⌘Enter took the floor — the words reached the agent WHILE the turn was still running (issue #14)",
    landed && elapsed < 7_000, landed ? `stored after ${elapsed} ms` : "not stored inside 7 s (that is Enter's queue-and-wait, not 插话)");
  const still = (await api(`/api/sessions`)).body;
  check("…and the interrupted session was running its replacement turn, not idle",
    ((still.live ?? []).find((s) => s.id === chat) ?? {}).status === "running",
    String(((still.live ?? []).find((s) => s.id === chat) ?? {}).status));
  const box = await ev(`document.querySelector('.composer textarea').value`);
  check("…and the box was cleared (the words are a message now, not a draft)", box === "", JSON.stringify(box));

  for (const sid of [woke, chat]) await api(`/api/sessions/${sid}`, { method: "DELETE" });
  for (const sid of [woke, chat]) await api(`/api/sessions/${sid}`, { method: "DELETE" }); // cold → purge
} finally {
  await closeTab();
  ws.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
