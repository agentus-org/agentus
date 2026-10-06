// QA sweep for the context-window UI, as the operator specified it (2026-10-06):
//   「上面那个像电量一样的横线…这里就只写这个上下文长度…上下文的更改不要到设置里面改，
//     就点这个上下文的地方…设置按钮就只做思考强度的事」
//
// Drives the real page (CDP) against the dev instance and asserts the four claims:
//   1. the strip above the input carries the window length + a battery-style bar, and no
//      effort/mode text (that was the noise being removed);
//   2. clicking that strip is where the window is SET (presets + free input, wired to the
//      agent's own context option) — not a read-only declaration;
//   3. a pick lands: the row's number follows the agent's reported window;
//   4. chat settings offers thinking depth and no longer offers any context option.
//
//   AGENTSLOT_BASE=http://127.0.0.1:8901 node scripts/qa/window-ui-sweep.mjs
const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";
const BASE = process.env.AGENTSLOT_BASE || "http://127.0.0.1:8901";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
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

  // A fresh session, then one turn: the strip only exists once the agent reported usage.
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
    if (await ev(`!!document.querySelector('.usage-row .usage-text')`)) break;
    await sleep(500);
  }
  const rowText = String(await ev(`document.querySelector('.usage-row .usage-text')?.textContent || ''`));
  const barBox = await ev(`(() => { const b = document.querySelector('.usage-bar'); if (!b) return null; const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()`);

  check("the strip above the input is rendered", !!rowText, rowText);
  check("it shows the window length", /\d+\s*[kK]|—/.test(rowText), rowText);
  // used / total · pct — the operator's ask: a bare length says nothing about how much is spent
  check("it shows USED and TOTAL and the percentage",
    /[\d.]+\s*k?\s*\/\s*[\d.]+/.test(rowText) && /%/.test(rowText), rowText);
  check("it does NOT spell out the thinking effort", !/effort/i.test(rowText), rowText);
  check("it does NOT spell out the mode", !/\bmode\b/i.test(rowText), rowText);
  check("a battery-style line is drawn next to it", !!barBox && barBox.w > 0 && barBox.h >= 3, JSON.stringify(barBox));
  check("the line is a thin strip, not a block", !!barBox && barBox.h <= 10, JSON.stringify(barBox));

  // 2. the window editor opens from that strip
  await ev(`document.querySelector('.usage-text').click()`);
  await sleep(500);
  const chips = await ev(`[...document.querySelectorAll('.usage-chip')].map(b => (b.textContent||'').trim())`);
  const hasInput = await ev(`!!document.querySelector('.usage-detail .usage-edit input')`);
  const head = String(await ev(`document.querySelector('.usage-set-head')?.textContent || ''`));
  check("clicking it opens the context-window editor", /上下文窗口/.test(head), head);
  check("the editor lists the agent's own presets", Array.isArray(chips) && chips.length >= 3, JSON.stringify(chips));
  check("the editor offers an arbitrary number", hasInput === true, String(hasInput));
  check("the presets come from the agent (256K/512K/768K/1M + auto)",
    ["256K", "512K", "768K", "1M"].every((n) => chips.includes(n)) && chips.length === 5, JSON.stringify(chips));

  // 3. a pick lands and the strip follows the agent's reported window
  const before = String(await ev(`document.querySelector('.usage-text')?.textContent || ''`));
  // Pick a preset that exists AND differs from the current window (the mock's list is
  // auto/256K/512K/768K/1M — asserting on a value the backend does not offer would only be
  // measuring this script).
  const target = String(await ev(`(() => {
    const b = [...document.querySelectorAll('.usage-chip')].find(e => /sel/.test(e.className) === false && (e.textContent||'').trim() === '256K');
    return b ? '256K' : '';
  })()`));
  check("a preset to pick is offered", target === "256K", target);
  await ev(`(() => { const b = [...document.querySelectorAll('.usage-chip')].find(e => (e.textContent||'').trim() === ${JSON.stringify(target)}); if (!b) return 0; b.click(); return 1; })()`);
  await sleep(1400);
  const selChip = String(await ev(`document.querySelector('.usage-chip.sel')?.textContent || ''`));
  check("the pick is reflected as the selected preset", selChip.trim() === "256K", selChip);

  // the strip's number is fed by the agent's usage_update, so it moves only after a new turn
  await ev(`(() => {
    const box = document.querySelector('textarea');
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(box, 'again');
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 1;
  })()`);
  let after = before;
  for (let i = 0; i < 24; i++) {
    after = String(await ev(`document.querySelector('.usage-text')?.textContent || ''`));
    if (after !== before) break;
    await sleep(500);
  }
  // 256K travels as 262144 tokens and the strip prints it compacted ("262k") — the claim is that
  // the number moved and follows the agent's report, not that it echoes the chip's label.
  check("the strip's length follows the agent's reported window",
    after !== before && /262k/.test(after), `${before} -> ${after}`);

  // 4. settings is thinking depth now — and no context window anywhere in it
  await ev(`document.querySelector('.usage-text')?.click()`);   // close the editor
  await sleep(250);
  await ev(`document.querySelector('button[aria-label="chat settings"]')?.click()`);
  await sleep(700);
  const groups = await ev(`[...document.querySelectorAll('.settings-pop .settings-label')].map(e => (e.textContent||'').trim())`);
  const settingsText = String(await ev(`document.querySelector('.settings-pop')?.textContent || ''`));
  check("settings offers thinking depth", JSON.stringify(groups).includes("thinking depth"), JSON.stringify(groups));
  check("settings no longer offers the context window",
    !/context budget/i.test(settingsText) && !/上下文/.test(settingsText), JSON.stringify(groups));
  const depthSel = String(await ev(`(() => {
    const group = [...document.querySelectorAll('.settings-pop .settings-group')]
      .find((g) => /thinking depth/i.test(g.querySelector('.settings-label')?.textContent || ''));
    return group?.querySelector('.settings-opt.sel')?.textContent || '';
  })()`));
  check("thinking depth marks the current level", depthSel.length > 0, depthSel);
} finally {
  try { await fetch(`${CDP}/json/close/${tab.id}`); } catch { /* best effort */ }
}
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
