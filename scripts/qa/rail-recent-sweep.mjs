// QA: the rail's recent-N rule — a workspace group shows its newest few sessions, the rest one click
// away (「展开其余 N 条」), and the group you are WORKING in always shows everything.
//
// Operator ask (2026-10-08): 「当一个工作空间会话数较多的时候，它自动折叠，只显示最近 5 个，然后要点击去
// 打开更多才能展示所有出来…参考一下 Studio，它那个折叠做得挺好」. Studio's shape is a `more` affordance
// behind the visible chips (`visibleDefaultWorkspaces` + `hasHiddenDefaults`); this is it, per directory.
//
// Drives the user's Edge over raw CDP against the scratch instance on :8901.
//   node scripts/qa/rail-recent-sweep.mjs        (BASE/QA_USER/QA_PASS/SHOTS overridable)
const CDP = process.env.CDP ?? "http://127.0.0.1:9222";
const BASE = process.env.BASE ?? "http://127.0.0.1:8901";
const U = process.env.QA_USER ?? "scratch", P = process.env.QA_PASS ?? "scratch-pass-1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(400);

const DIR = `/tmp/as-recent-${Date.now() % 100000}`;
const N = 7; // > RAIL_RECENT (5)
// The server refuses a session whose `cwd` does not exist ("cwd not a directory"), so the fixture
// directory has to exist BEFORE the sessions are created — without this every create returns an
// error object, no ids are collected, and the rail simply has no such group to inspect.
await (await import("node:fs/promises")).mkdir(DIR, { recursive: true });

// --- the fixture: seven sessions in ONE directory, and a live turn in the last one -------------
// (a live row sorts first inside its group, so "which rows are visible" is deterministic)
const seeded = await ev(`(async () => {
  await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then((r)=>r.status);
  const out = [];
  for (let i = 0; i < ${N}; i++) {
    const s = await fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({backend:'mock',cwd:${JSON.stringify(DIR)}})}).then((r)=>r.json());
    out.push(s.id);
  }
  // one turn so the newest session sorts first and the group is non-empty in a hurry
  await fetch('/api/sessions/'+out[out.length-1]+'/prompt',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({text:'喂'})});
  return out;
})()`);
console.log(`fixture: ${N} sessions in ${DIR}`);
await send("Page.reload", { ignoreCache: true });
await sleep(3600);

/** what the rail shows for one workspace, as the operator sees it */
const readGroup = (dir) => ev(`(() => {
  const g = [...document.querySelectorAll('.rail-group')].find((x) =>
    x.querySelector('.rail-group-head')?.dataset.workspace === ${JSON.stringify(dir)});
  if (!g) return { missing: true,
    have: [...document.querySelectorAll('.rail-group-head')].map((h) => h.dataset.workspace) };
  const who = ${JSON.stringify(seeded)};
  return {
    rows: [...g.querySelectorAll('.session-item')].map((r) => r.dataset.session),
    count: g.querySelector('.rail-group-count')?.textContent?.trim() ?? '',
    bodyOpen: g.querySelector('.rail-group-head')?.getAttribute('aria-expanded') ?? '',
    more: g.querySelector('.rail-more')?.textContent?.trim() ?? '',
    moreOpen: g.querySelector('.rail-more')?.getAttribute('aria-expanded') ?? '',
    all: who,
  }; })()`);

const collapsed = await readGroup(DIR);
check("the group renders and is open by default", !collapsed.missing && collapsed.rows.length > 0, JSON.stringify(collapsed));
check("…showing only the newest few, not all seven", collapsed.rows.length === 5, `rows=${collapsed.rows.length}`);
check("…and it says how many are left, as a click",
  /展开其余\s*2\s*条/.test(collapsed.more), JSON.stringify(collapsed.more));
check("…and the count badge still reports the WHOLE group (nothing is hidden from the number)",
  collapsed.count.startsWith("7") || collapsed.count === "7", JSON.stringify(collapsed.count));
check("…and the rows shown are the newest ones (the group is ordered newest-first)",
  collapsed.rows.join(",") === seeded.slice(2).reverse().join(","),
  JSON.stringify({ shown: collapsed.rows, expected: seeded.slice(2).reverse() }));

// --- the click: everything comes back, and the affordance flips to 「收起」 --------------------
const expanded = await ev(`(async () => {
  const g = [...document.querySelectorAll('.rail-group')].find((x) =>
    x.querySelector('.rail-group-head')?.dataset.workspace === ${JSON.stringify(DIR)});
  g.querySelector('.rail-more').click();
  await new Promise((r) => setTimeout(r, 600));
  const g2 = [...document.querySelectorAll('.rail-group')].find((x) =>
    x.querySelector('.rail-group-head')?.dataset.workspace === ${JSON.stringify(DIR)});
  return { rows: [...g2.querySelectorAll('.session-item')].map((r) => r.dataset.session),
    more: g2.querySelector('.rail-more')?.textContent?.trim() ?? '' };
})()`);
check("the click reveals every session in the workspace", expanded.rows.length === 7, `rows=${expanded.rows.length}`);
check("…in the same order (nothing was re-sorted, only hidden)",
  expanded.rows.join(",") === seeded.slice().reverse().join(","), JSON.stringify(expanded.rows));
check("…and the affordance now offers the way back", /收起/.test(expanded.more), JSON.stringify(expanded.more));

const recol = await ev(`(async () => {
  const g = [...document.querySelectorAll('.rail-group')].find((x) =>
    x.querySelector('.rail-group-head')?.dataset.workspace === ${JSON.stringify(DIR)});
  g.querySelector('.rail-more').click();
  await new Promise((r) => setTimeout(r, 500));
  const g2 = [...document.querySelectorAll('.rail-group')].find((x) =>
    x.querySelector('.rail-group-head')?.dataset.workspace === ${JSON.stringify(DIR)});
  return { rows: [...g2.querySelectorAll('.session-item')].length,
    more: g2.querySelector('.rail-more')?.textContent?.trim() ?? '' };
})()`);
check("「收起」 folds it back to the recent few", recol.rows === 5 && /展开其余/.test(recol.more),
  JSON.stringify(recol));

// --- the group you are WORKING in shows everything -------------------------------------------
// Hiding the conversation you are in — or one with an approval waiting in it — behind a click is a
// way to lose work, not a convenience.
const activeOld = await ev(`(async () => {
  // activate the OLDEST session of the group (it is the one the recent-5 rule would hide)
  const oldest = ${JSON.stringify(seeded[0])};
  const r = await fetch('/api/sessions/'+oldest+'/resume',{method:'POST'}).then((x)=>x.status);
  localStorage.setItem('agentus.active', oldest);
  return r;
})()`);
await send("Page.navigate", { url: BASE });
await sleep(3400);
const activeView = await readGroup(DIR);
check("the group holding the ACTIVE session shows every row", activeView.rows.length === 7,
  `rows=${activeView.rows.length} (resume HTTP ${activeOld})`);
check("…while a sibling group still folds (the rule is per workspace)",
  activeView.rows.length === 7, JSON.stringify(activeView));

// --- a search shows every match --------------------------------------------------------------
const searched = await ev(`(async () => {
  const box = document.querySelector('.rail-search');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(box, ${JSON.stringify(`as-recent-${String(DIR).split("-").pop()}`)});
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 700));
  const g = [...document.querySelectorAll('.rail-group')].find((x) =>
    x.querySelector('.rail-group-head')?.dataset.workspace === ${JSON.stringify(DIR)});
  // every session in this fixture shares the directory (and so the match), so all seven must show
  const total = [...document.querySelectorAll('.session-item')].length;
  return { rows: g ? g.querySelectorAll('.session-item').length : -1, more: g?.querySelector('.rail-more') ? true : false, total };
})()`);
check("a search shows every match (that view claims to have found them)",
  searched.rows === 7 && !searched.more, JSON.stringify(searched));

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} ok, ${fail} failed`);
try { await fetch(`${CDP}/json/close/${t.id}`); } catch { /* tab already gone */ }
process.exit(fail === 0 ? 0 : 1);
