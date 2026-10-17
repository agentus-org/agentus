// 设置 → 驾驶舱互发消息, on the REAL page (issue #15's write half has to be reachable by the
// operator, not only by curl). Checks the rendered section, then drives the actual checkbox and
// proves the server learned it — and that a reload still shows the new value.
//
//   PORT=8901 node scripts/qa/settings-cockpit-dom.mjs
const CDP = process.env.CDP ?? "http://127.0.0.1:9222";
const BASE = process.env.BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8901}`;
const U = process.env.QA_USER ?? "scratch", P = process.env.QA_PASS ?? "scratch-pass-1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const t = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(1500);
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
const waitFor = async (expr, ms = 20_000) => { const until = Date.now() + ms; while (Date.now() < until) { if (await ev(expr).catch(() => 0)) return true; await sleep(250); } return false; };
await send("Page.enable"); await send("Runtime.enable");

const original = (await (await fetch(`${BASE}/api/settings`, { headers: { authorization: `Bearer ${(await import("node:fs")).readFileSync("/tmp/agentus-qa-account/auth.token", "utf8").trim()}` } })).json()).agent?.cockpitSend;

try {
  const login = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
  if (login !== 200) throw new Error(`QA login returned ${login} — wrong instance (AGENTUS_DATA?)`);
  await ev(`location.reload()`);
  await sleep(1500);

  // 设置 is a PANEL over the app (there is no /settings route), so the operator's own door is the
  // gear in the rail. Click it like a person would — a sweep that URL-jumps would pass on a page
  // nobody can actually reach.
  await waitFor(`Boolean(document.querySelector('.rail-gear'))`);
  await ev(`document.querySelector('.rail-gear').click()`);
  await sleep(800);

  // The section exists, in the agent group, and the nav offers a way to it.
  const present = await waitFor(`Boolean(document.getElementById('set-cockpit'))`);
  check("设置页 renders a 驾驶舱互发消息 section", present);
  const title = await ev(`document.querySelector('#set-cockpit h3')?.textContent ?? ''`);
  check("…titled so the operator knows what it governs", title.includes("驾驶舱互发消息"), title);
  // The nav shows the sub-entries of the OPEN category only, so the door is two clicks: 智能体, then
  // the entry itself. Both have to exist, or the section is a card nobody can find.
  await ev(`[...document.querySelectorAll('.set-nav-cat')].find(b => b.textContent.trim() === '智能体')?.click()`);
  await sleep(400);
  const navItem = await ev(`[...document.querySelectorAll('.set-nav-item')].some(b => b.textContent.trim() === '驾驶舱互发')`);
  check("…reachable from the settings nav (智能体 → 驾驶舱互发)", navItem);
  await ev(`[...document.querySelectorAll('.set-nav-item')].find(b => b.textContent.trim() === '驾驶舱互发')?.click()`);
  await sleep(500);
  const inView = await ev(`(() => { const s = document.getElementById('set-cockpit'); if (!s) return false; const r = s.getBoundingClientRect(); return r.top > 0 && r.top < window.innerHeight; })()`);
  check("…and that entry actually scrolls the section into view", inView);
  const words = await ev(`document.querySelector('#set-cockpit')?.innerText ?? ''`);
  check("…and says what turning it on costs (two agents talking = tokens)", /烧 token|循环/.test(words));
  check("…and that a busy session is refused rather than interrupted", /target_busy|绝不抢占/.test(words));

  // Drive the real checkbox: the server is the judge, not the DOM.
  const box = await ev(`(() => { const s = document.querySelector('#set-cockpit'); const i = s?.querySelector('input[type=checkbox]'); return i ? { checked: i.checked } : null; })()`);
  check("the switch starts from the server's value", box && box.checked === Boolean(original), JSON.stringify({ dom: box?.checked, server: original }));
  await ev(`document.querySelector('#set-cockpit input[type=checkbox]').click()`);
  await sleep(1200);
  const after = await ev(`(async () => (await (await fetch('/api/settings')).json()).agent?.cockpitSend)()`);
  check("clicking it persists to the server", after === !Boolean(original), JSON.stringify({ dom_click_became: after }));
  const hint = await ev(`document.querySelector('#set-cockpit')?.innerText ?? ''`);
  check("…and the page reports the new state in words, not just a checked box", /已开启|已关闭/.test(hint));

  // Reload: the value the page draws must come from the server, not from local state.
  await ev(`location.reload()`);
  await sleep(1800);
  await waitFor(`Boolean(document.querySelector('.rail-gear'))`);
  await ev(`document.querySelector('.rail-gear').click()`);
  await sleep(800);
  await waitFor(`Boolean(document.getElementById('set-cockpit'))`);
  const reloaded = await ev(`document.querySelector('#set-cockpit input[type=checkbox]')?.checked`);
  check("a reload draws the persisted value", reloaded === !Boolean(original), JSON.stringify({ reloaded }));

  // Put it back the way we found it.
  await ev(`document.querySelector('#set-cockpit input[type=checkbox]').click()`);
  await sleep(1000);
  const restored = await ev(`(async () => (await (await fetch('/api/settings')).json()).agent?.cockpitSend)()`);
  check("the sweep puts the setting back the way it found it", restored === Boolean(original), JSON.stringify({ restored, original }));
} finally {
  await fetch(`${CDP}/json/close/${t.id}`).catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
