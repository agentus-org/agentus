// QA (issue #38) — 「改了什么文件」面板，页面级。位置契约（2026-10-21 操作者反馈后改）：
//   面板挂在**那次工具执行**的下面，不再攒到回合末尾。
//   原先一回合一块、落在回合尾巴：一轮里改了 5 个文件之后又跑了 20 分钟命令，那块「N 个文件变更」
//   离改动隔了一屏工具卡，读起来像最后那条命令改的。现在每次写文件的调用后面紧跟它自己那一行。
//
// 这条证明的事：
//   · mock 的 `[tool-many]` 一回合改三个文件、**不发权限请求**（accept_edits 那种不问就写的回合）
//     → 面板照样出现，与审批无关；
//   · 每一块面板的**前一个兄弟节点就是那次工具调用的卡片**（位置契约）；
//   · 面板不在回合尾巴：它后面还有内容（否则又是「一回合一块」）；
//   · 同一文件改两刀 → 两行，各自是那一次的计数（不再合并成回合尾巴一条）；
//   · 40 行文件只改一行 → 点开是 hunk 折叠的 diff（有 gap 行），不是 40 行全量；
//   · 新文件 → 不编造删除行；
//   · `[tool]`（只写、不给 diff）的回合 → 没有新增面板（不画空壳）；
//   · 刷新后仍在（落库的不是内存状态）。
//
// Usage: PORT=8901 node scripts/qa/file-changes-sweep.mjs
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

// --- login + a mock session -------------------------------------------------------------
const code = await ev(`fetch('/api/auth/login',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
check("QA login", code === 200, `status ${code}`);
const sess = await ev(`fetch('/api/sessions',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({backend:'mock',cwd:'/tmp',title:'file-changes sweep'})}).then(r=>r.json())`);
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

await ev(`location.href = ${JSON.stringify(BASE + "/?session=" + sid)}`);
await sleep(3200);

/** Every block in the stream, with where it sits and what it says. */
const blocks = () => ev(`(() => {
  const inner = document.querySelector('.stream-inner');
  if (!inner) return null;
  const kids = [...inner.children];
  const rowsOf = (p) => [...p.querySelectorAll('.fc-row')].map((r) => ({
    name: (r.querySelector('.fc-name')?.textContent || '').replace(/\\s+/g, ' ').trim(),
    counts: (r.querySelector('.fc-counts')?.textContent || '').replace(/\\s+/g, ' ').trim(),
    disabled: r.querySelector('.fc-counts')?.disabled ?? null,
    open: r.querySelector('.fc-counts')?.getAttribute('aria-expanded'),
    diffLines: r.querySelectorAll('.perm-diff-line').length,
    gaps: r.querySelectorAll('.perm-diff-gap').length,
  }));
  return kids.map((k, i) => ({
    i,
    cls: k.className,
    isFc: k.classList.contains('file-changes'),
    one: k.classList.contains('one'),
    head: (k.querySelector('.fc-title')?.textContent || '').trim(),
    rows: k.classList.contains('file-changes') ? rowsOf(k) : [],
    // 位置契约：这一块的前一个兄弟必须是承载那次工具调用的卡片（或包含它的折叠段）。
    prevCls: i > 0 ? kids[i - 1].className : null,
    prevHasWork: i > 0 ? kids[i - 1].querySelectorAll('.work-run').length > 0 : false,
  }));
})()`);

const allRows = (snap) => snap.filter((p) => p.isFc).flatMap((p) => p.rows);

// --- 1. 一回合改三个文件（不发审批） -------------------------------------------------------
check("发送 [tool-many] 回合", (await prompt("[tool-many] 改三个文件")) === 202);
await idle();
await sleep(700);

let snap = await blocks();
let fc = snap.filter((p) => p.isFc);
check("出现了文件变更面板", fc.length > 0, `${fc.length} 块`);
check("每块都在自己那次工具调用下面（前一个兄弟是工具卡/折叠段）",
  fc.every((p) => /msg/.test(p.prevCls || "") || p.prevHasWork),
  JSON.stringify(fc.map((p) => [p.prevCls, p.prevHasWork])));
check("面板不在回合尾巴（每块后面都还有内容）",
  fc.every((p) => p.i < snap.length - 1), JSON.stringify(fc.map((p) => [p.i, snap.length])));

let rows = allRows(snap);
check("三次写文件调用 → 四条行（app.ts 改两刀 = 两行）",
  rows.length === 4, `${rows.length} 行：${rows.map((r) => r.name).join(", ")}`);
const appRows = rows.filter((r) => r.name.startsWith("app.ts"));
const neuRow = rows.find((r) => r.name.startsWith("new.md"));
check("app.ts 的两刀各占一行（位置跟随执行，不合并到回合尾巴）", appRows.length === 2, String(appRows.length));
check("行上是那次改动自己的计数（不是回合累计）",
  (appRows[0]?.counts || "").includes("−1") && (appRows[1]?.counts || "").includes("−0"),
  JSON.stringify(appRows.map((r) => r.counts)));
check("新文件写「新文件 · N 行」而不是 −0", (neuRow?.counts || "").includes("新文件"), neuRow?.counts ?? "");
check("计数按钮可点（不是 disabled 的空壳）", rows.every((r) => r.disabled === false), JSON.stringify(rows.map((r) => r.disabled)));
check("单文件块不带多余的头行", fc.every((p) => p.one === true && !p.head), JSON.stringify(fc.map((p) => [p.one, p.head])));

// --- 2. 点开计数 = 逐行 diff；大文件走 hunk 折叠 ------------------------------------------
await ev(`(() => {
  const rows = [...document.querySelectorAll('.file-changes .fc-row')];
  const big = rows.find((r) => (r.querySelector('.fc-name')?.textContent || '').includes('big.ts'));
  big?.querySelector('.fc-counts')?.click();
})()`);
await sleep(300);
snap = await blocks();
const bigOpen = allRows(snap).find((r) => r.name.startsWith("big.ts"));
check("点开 big.ts 有 diff 行", (bigOpen?.diffLines ?? 0) > 0, String(bigOpen?.diffLines));
check("40 行文件只改一行 → 有折叠 gap", (bigOpen?.gaps ?? 0) >= 1, `${bigOpen?.gaps} 个 gap`);
check("不是把 40 行全画出来", (bigOpen?.diffLines ?? 99) < 20, String(bigOpen?.diffLines));

await ev(`(() => {
  const rows = [...document.querySelectorAll('.file-changes .fc-row')];
  const app = rows.find((r) => (r.querySelector('.fc-name')?.textContent || '').includes('app.ts'));
  app?.querySelector('.fc-counts')?.click();
})()`);
await sleep(300);
snap = await blocks();
const appOpen = allRows(snap).find((r) => r.name.startsWith("app.ts"));
check("app.ts 点开：+1 那行在 diff 里", (appOpen?.diffLines ?? 0) >= 3, String(appOpen?.diffLines));

// --- 3. 刷新页面后仍在（落库的不是内存状态） ------------------------------------------------
// 注意：刷新/重放后相邻的工具卡会被折进一段 WorkRun，四块单文件面板合理地合成「一段一块」。
// 所以这里断言的是「文件行还在、位置契约还在」，不是「块数不变」——否则测的是折叠策略，不是落库。
const before = fc.length;
await ev(`location.reload()`);
await sleep(3400);
snap = await blocks();
fc = snap.filter((p) => p.isFc);
const namesAfter = new Set(allRows(snap).map((r) => r.name.split("/")[0]));
check("刷新页面后面板还在（历史回放）", fc.length > 0, String(fc.length));
check("刷新后三个文件都还在", ["app.ts", "big.ts", "new.md"].every((n) => namesAfter.has(n)), [...namesAfter].join(", "));
check("刷新后位置契约不变（每块都跟在工具卡/折叠段后面）",
  fc.every((p) => /msg/.test(p.prevCls || "") || p.prevHasWork), JSON.stringify(fc.map((p) => p.prevCls)));

// --- 4. 下一个回合：新回合不给 diff 就不画 --------------------------------------------------
// `[tool]` 会发权限请求（写 ./demo.txt 但 content 不带 diff），所以先把卡点掉再看。
check("发送一个没有 diff 的回合", (await prompt("[tool] 只写不报 diff")) === 202);
await sleep(1500);
const dismissed = await ev(`(() => { const b = document.querySelector('.perm-dialog .btn.allow, .perm-dialog button'); if (b) { b.click(); return true; } return false; })()`);
await idle(30000);
await sleep(800);
snap = await blocks();
const namesNow = [...new Set(allRows(snap).map((r) => r.name.split("/")[0]))].sort();
check("无 diff 的回合没有多出文件行（demo.txt 不该出现）", !namesNow.includes("demo.txt"), namesNow.join(", "));
check("面板块数没有增长", snap.filter((p) => p.isFc).length <= before, `${snap.filter((p) => p.isFc).length} vs ${before}`);
if (dismissed) console.log("  note [tool] 回合的审批卡已点掉");

// --- 5. 一回合只改一个文件：单文件形态（没有多余的头行） --------------------------------------
const sess2 = await ev(`fetch('/api/sessions',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({backend:'mock',cwd:'/tmp',title:'file-changes one'})}).then(r=>r.json())`);
await ev(`location.href = ${JSON.stringify(BASE + "/?session=")} + ${JSON.stringify(sess2.id)}`);
await sleep(3200);
await ev(`fetch('/api/sessions/${sess2.id}/prompt',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({text:'[tool-hermes] 改一个文件'})}).then(r=>r.status)`);
await sleep(1200);
const dismiss = await ev(`(() => { const b = document.querySelector('.perm-dialog .btn.allow, .perm-dialog button'); if (b) { b.click(); return true; } return false; })()`);
await sleep(3000);
snap = await blocks();
const one = snap.filter((p) => p.isFc);
check("单文件回合：面板是单行形态", one.length === 1 && one[0].one === true, JSON.stringify(one.map((p) => [p.one, p.head])));
check("单文件没有「N 个文件变更」标题行", !one[0]?.head, one[0]?.head ?? "(no head)");
if (dismiss) console.log("  note 单文件回合出现过审批卡，已点掉（不影响断言）");

console.log(`\n${fail === 0 ? "OK" : "FAILED"} — ${pass} passed, ${fail} failed`);
try { await fetch(`${CDP}/json/close/${tab.id}`); } catch { /* best effort */ }
process.exit(fail === 0 ? 0 : 1);
