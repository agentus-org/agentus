// QA (issue #38) — 回合末尾的「N 个文件变更」面板，页面级。
//
// 这条要证明的是「回合跑完，操作者一眼看到它改了哪些文件」，和审批**无关**：
//   · mock 的 `[tool-many]` 一回合改三个文件，**不发权限请求**（= accept_edits 那种不问就写的
//     回合）→ 面板照样出现，这就是「不依赖审批」的证据；
//   · 同一文件改两刀 → 合并成一条，行上写「改了 2 次」，计数是累计 diff；
//   · 40 行文件只改一行 → 点开是 hunk 折叠的 diff（有 gap 行），不是 40 行全量；
//   · 新文件 → 不编造删除行；
//   · `[tool]`（只写、不给 diff）的回合 → 没有面板（不draw 一个空壳）；
//   · 下一回合再说一句话 → 老面板不重复出现（一回合一块）。
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

const panel = () => ev(`(() => {
  const p = document.querySelector('.file-changes');
  if (!p) return null;
  return {
    one: p.classList.contains('one'),
    head: (p.querySelector('.fc-title')?.textContent || '').trim(),
    rows: [...p.querySelectorAll('.fc-row')].map((r) => ({
      name: (r.querySelector('.fc-name')?.textContent || '').replace(/\\s+/g, ' ').trim(),
      counts: (r.querySelector('.fc-counts')?.textContent || '').replace(/\\s+/g, ' ').trim(),
      disabled: r.querySelector('.fc-counts')?.disabled ?? null,
      open: r.querySelector('.fc-counts')?.getAttribute('aria-expanded'),
      diffLines: r.querySelectorAll('.perm-diff-line').length,
      gaps: r.querySelectorAll('.perm-diff-gap').length,
    })),
    count: document.querySelectorAll('.file-changes').length,
  };
})()`);

// --- 1. 一回合改三个文件（不发审批） -------------------------------------------------------
check("发送 [tool-many] 回合", (await prompt("[tool-many] 改三个文件")) === 202);
await idle();
await sleep(600);

let snap = await panel();
check("回合末尾出现了文件变更面板", Boolean(snap), snap ? "" : "no .file-changes");
check("标题是「3 个文件变更」", snap?.head === "3 个文件变更", snap?.head ?? "");
check("一个文件一条（3 条）", snap?.rows.length === 3, String(snap?.rows.length));
const app = snap?.rows.find((r) => r.name.startsWith("app.ts"));
const big = snap?.rows.find((r) => r.name.startsWith("big.ts"));
const neu = snap?.rows.find((r) => r.name.startsWith("new.md"));
check("同一文件改两刀 → 合并成一条并注明次数", (app?.name || "").includes("改了 2 次"), app?.name ?? "");
check("app.ts 计数 = 累计 diff（+2 −1）", (app?.counts || "").includes("+2") && (app?.counts || "").includes("−1"), app?.counts ?? "");
check("新文件写「新文件 · 2 行」而不是 −0", (neu?.counts || "").includes("新文件"), neu?.counts ?? "");
check("三个文件的计数按钮都可点", snap?.rows.every((r) => r.disabled === false), JSON.stringify(snap?.rows.map((r) => r.disabled)));

// --- 2. 点开计数 = 逐行 diff；大文件走 hunk 折叠 ------------------------------------------
await ev(`(() => {
  const rows = [...document.querySelectorAll('.file-changes .fc-row')];
  const big = rows.find((r) => (r.querySelector('.fc-name')?.textContent || '').includes('big.ts'));
  big?.querySelector('.fc-counts')?.click();
})()`);
await sleep(300);
snap = await panel();
const bigOpen = snap?.rows.find((r) => r.name.startsWith("big.ts"));
check("点开 big.ts 有 diff 行", (bigOpen?.diffLines ?? 0) > 0, String(bigOpen?.diffLines));
check("40 行文件只改一行 → 有折叠 gap", (bigOpen?.gaps ?? 0) >= 1, `${bigOpen?.gaps} 个 gap`);
check("不是把 40 行全画出来", (bigOpen?.diffLines ?? 99) < 20, String(bigOpen?.diffLines));

await ev(`(() => {
  const rows = [...document.querySelectorAll('.file-changes .fc-row')];
  const app = rows.find((r) => (r.querySelector('.fc-name')?.textContent || '').includes('app.ts'));
  app?.querySelector('.fc-counts')?.click();
})()`);
await sleep(300);
snap = await panel();
const appOpen = snap?.rows.find((r) => r.name.startsWith("app.ts"));
check("app.ts 点开：latest 的 +1 那行在 diff 里", (appOpen?.diffLines ?? 0) >= 3, String(appOpen?.diffLines));

// --- 3. 刷新页面后仍在（落库的不是内存状态） ------------------------------------------------
await ev(`location.reload()`);
await sleep(3400);
snap = await panel();
check("刷新页面后面板还在（历史回放）", snap?.rows.length === 3, String(snap?.rows.length));
check("刷新后仍只有一块", snap?.count === 1, String(snap?.count));

// --- 4. 下一个回合：老面板不重复，新回合不给 diff 就不画 ------------------------------------
check("发送一个没有 diff 的回合", (await prompt("[tool] 只写不报 diff")) === 202);
await idle();
await sleep(600);
snap = await panel();
check("仍然只有一块面板（一回合一块）", snap?.count === 1, String(snap?.count));
check("无 diff 的回合没有往面板里塞行", snap?.rows.length === 3, String(snap?.rows.length));

// --- 5. 一回合只改一个文件：单文件形态（没有多余的头行） --------------------------------------
const sess2 = await ev(`fetch('/api/sessions',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({backend:'mock',cwd:'/tmp',title:'file-changes one'})}).then(r=>r.json())`);
await ev(`location.href = ${JSON.stringify(BASE + "/?session=")} + ${JSON.stringify(sess2.id)}`);
await sleep(3200);
await ev(`fetch('/api/sessions/${sess2.id}/prompt',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({text:'[tool-hermes] 改一个文件'})}).then(r=>r.status)`);
await sleep(1200);
const dismiss = await ev(`(() => { const b = document.querySelector('.perm-dialog .btn.allow, .perm-dialog button'); if (b) { b.click(); return true; } return false; })()`);
await sleep(3000);
snap = await panel();
check("单文件回合：面板是单行形态", snap?.one === true, String(snap?.one));
check("单文件没有「N 个文件变更」标题行", !snap?.head, snap?.head ?? "(no head)");
if (dismiss) console.log("  note 单文件回合出现过审批卡，已点掉（不影响断言）");

console.log(`\n${fail === 0 ? "OK" : "FAILED"} — ${pass} passed, ${fail} failed`);
try { await fetch(`${CDP}/json/close/${tab.id}`); } catch { /* best effort */ }
process.exit(fail === 0 ? 0 : 1);
