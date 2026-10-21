// QA (issue #37) — 记忆召回那行能展开成「召回的是哪几条」，页面级。
//
// 要证明的是：`👁️ Hindsight — recalled 3 memories` 这句话后面多了一个「3 条」，点开是三条记忆
// 本身（带 tags、超长条目换行、`truncated` 说「还有更多」），而且**刷新之后还在**（这行是落库的，
// 展开这件事也必须跟着落库的 payload 走）。反面同时钉住：没有条目的状态行（压缩、别的 agent
// 发来的状态）一个按钮都不多 —— 老行为一个像素不改。
//
// Usage: PORT=8901 node scripts/qa/recall-items-sweep.mjs
const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";
const PORT = Number(process.env.PORT || 8901);
const BASE = process.env.AGENTUS_BASE || `http://127.0.0.1:${PORT}`;
const U = process.env.QA_USER ?? "scratch", P = process.env.QA_PASS ?? "scratch-pass-1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(2600);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const waiting = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) {
    const w = waiting.get(m.id); waiting.delete(m.id);
    m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result);
  }
};
const send = (method, params = {}, timeout = 30000) => new Promise((res, rej) => {
  const mid = ++id; const t = setTimeout(() => { waiting.delete(mid); rej(new Error("TIMEOUT " + method)); }, timeout);
  waiting.set(mid, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expr, timeout = 30000) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, timeout);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval err");
  return r.result.value;
};

const loginCode = await ev(`fetch('/api/auth/login',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
check("QA login", loginCode === 200, `status ${loginCode}`);
const sess = await ev(`fetch('/api/sessions',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({backend:'mock',cwd:'/tmp',title:'recall-items sweep'})}).then(r=>r.json())`);
check("打开了 mock 会话（不烧 token）", Boolean(sess?.id), JSON.stringify(sess).slice(0, 120));
const sid = sess.id;
const status = async () => ev(`fetch('/api/sessions',{credentials:'same-origin'}).then(r=>r.json()).then(d=>(d.live||[]).find(s=>s.id===${JSON.stringify(sid)})?.status||'')`).catch(() => "");
const idle = async (ms = 60000) => {
  const t0 = Date.now();
  for (;;) {
    const st = await status();
    if (st !== "running" && st !== "starting") return st;
    if (Date.now() - t0 > ms) return st;
    await sleep(250);
  }
};
const prompt = async (text) => ev(`fetch('/api/sessions/${sid}/prompt',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({text:${JSON.stringify(text)}})}).then(r=>r.status)`);

const notes = () => ev(`[...document.querySelectorAll('.status-note')].map((n) => ({
  kind: n.getAttribute('data-kind'),
  text: (n.querySelector('.status-note-text')?.textContent || '').trim(),
  toggle: n.querySelector('.status-note-toggle')?.textContent?.trim() || null,
  expanded: n.querySelector('.status-note-toggle')?.getAttribute('aria-expanded') || null,
  items: [...n.querySelectorAll('.status-note-item')].map((i) => ({
    text: (i.querySelector('.status-note-item-text')?.textContent || '').trim(),
    tags: (i.querySelector('.status-note-item-tags')?.textContent || '').trim() || null,
    more: i.classList.contains('more'),
  })),
}))`);

await ev(`location.href = ${JSON.stringify(BASE + "/?session=" + sid)}`);
await sleep(3200);

// --- 1. 带条目的记忆行 ------------------------------------------------------------------
check("prompt 1 accepted", (await prompt("[recall] 回忆一下")) === 202);
await idle();
await sleep(700);
let rows = await notes();
const mem = rows.find((r) => /recalled 3 memories/.test(r.text));
check("记忆召回行出现了", Boolean(mem), JSON.stringify(rows.map((r) => r.text)));
check("…行上有一个「3 条」按钮", mem?.toggle === "3 条", String(mem?.toggle));
check("…默认是折叠的（不展开就不是噪音）", mem?.expanded === "false" && mem?.items.length === 0, JSON.stringify(mem?.items));

await ev(`(() => { const b = document.querySelector('.status-note-toggle'); b?.click(); })()`);
await sleep(400);
rows = await notes();
const openMem = rows.find((r) => /recalled 3 memories/.test(r.text));
check("点开后是三条记忆", openMem?.items.length === 4, JSON.stringify(openMem?.items.map((i) => i.text.slice(0, 12))));
check("…第一条就是原文，不是摘要", openMem?.items[0]?.text.includes("回复一律中文") === true, openMem?.items[0]?.text);
check("…带 tags 的条目把 tags 画出来了", openMem?.items.some((i) => i.tags === "port · agentus") === true, JSON.stringify(openMem?.items.map((i) => i.tags)));
check("…最后一行说「还有更多」（truncated 不静默）", openMem?.items.some((i) => i.more) === true, JSON.stringify(openMem?.items.at(-1)));
check("…按钮变成「收起」", openMem?.toggle === "收起", String(openMem?.toggle));
const overflow = await ev(`(() => { const li = document.querySelectorAll('.status-note-item')[2]; if (!li) return null; const r = li.getBoundingClientRect(); return { h: Math.round(r.height), w: Math.round(r.width), panel: Math.round(document.querySelector('.status-note-items').getBoundingClientRect().width) }; })()`);
check("…超长条目换行而不是把行撑破（高度 > 单行、宽度不溢出）", (overflow?.h ?? 0) > 22 && (overflow?.w ?? 1e9) <= (overflow?.panel ?? 0) + 1, JSON.stringify(overflow));

// --- 2. 刷新之后还在（落库，不是内存里的装饰） ------------------------------------------
await ev(`location.reload()`);
await sleep(3200);
rows = await notes();
const afterReload = rows.find((r) => /recalled 3 memories/.test(r.text));
check("刷新后这行还在", Boolean(afterReload));
check("…而且是折叠状态（展开状态不落库，重进从安静开始）", afterReload?.expanded === "false" && afterReload?.items.length === 0, JSON.stringify(afterReload?.expanded));
await ev(`(() => { const b = document.querySelector('.status-note-toggle'); b?.click(); })()`);
await sleep(350);
rows = await notes();
check("…再点开，三条记忆是从库里读出来的", (rows.find((r) => /recalled 3 memories/.test(r.text))?.items.length ?? 0) === 4);

// --- 3. 没有条目的状态行：一个按钮都不多 -------------------------------------------------
check("prompt 2 accepted（压缩行）", (await prompt("[status:compacting#2] 压一下")) === 202);
await idle();
await sleep(700);
rows = await notes();
const compact = rows.find((r) => /Compacting context/.test(r.text));
check("压缩行照旧出现", Boolean(compact), JSON.stringify(rows.map((r) => r.text)));
check("…它没有「N 条」按钮（老行为一个像素不改）", compact?.toggle === null, String(compact?.toggle));

// --- 4. 落库的是 payload 本身（truncated 从库里读出来，不是渲染时现算） --------------------
const stored = await ev(`fetch('/api/sessions/${sid}/messages?limit=100',{credentials:'same-origin'}).then(r=>r.json()).then(d=>(d.messages||[]).filter(m=>m.kind==='note').map(m=>({cat:m.payload?.category, n:(m.payload?.items||[]).length, trunc:m.payload?.truncated===true})))`);
const memRow = stored.find((r) => r.cat === "memory");
check("库里的 memory 行带着 3 条 items", memRow?.n === 3, JSON.stringify(stored));
check("truncated 也落库了", memRow?.trunc === true, JSON.stringify(memRow));
check("压缩行没有 items（同一个 appendNote 不许给别家塞字段）", !stored.find((r) => r.cat === "compaction")?.n, JSON.stringify(stored));

console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed`);
try { await fetch(`${CDP}/json/close/${tab.id}`); } catch {}
process.exit(fail ? 1 : 0);
