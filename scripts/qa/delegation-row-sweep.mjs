// QA (issue #39) — 子任务（delegate_task background）在驾驶舱里要有自己的一行。
//
// 这条测的是「看不见」这件事的反面：`[bg-delegation]` 发的是一帧 `kind=background`，
// tasks 里那一行 `kind=delegation`（没有 pid、没有命令行，只有目标和几个子代理）。
// 断言：
//   · 台头读得出「含 2 个子任务」，而不是把它当成一个 shell 进程；
//   · 展开后那一行带「子任务」徽章、显示目标原文、显示「2 个子代理 · 运行 …」，且**不显示 pid**；
//   · 完成后那一行消失（快照被清空），不留一个永远转圈的行。
//
// Usage: PORT=8901 node scripts/qa/agentus-dev-sweep-delegation.mjs
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
await sleep(2500);
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

const code = await ev(`fetch('/api/auth/login',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
check("QA login", code === 200, `status ${code}`);
const sess = await ev(`fetch('/api/sessions',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({backend:'mock',cwd:'/tmp',title:'subagent row'})}).then(r=>r.json())`);
check("打开 mock 会话", Boolean(sess?.id), String(sess?.id));
const sid = sess.id;
await ev(`location.href = ${JSON.stringify(BASE + "/?session=" + sid)}`);
await sleep(3000);

const head = () => ev(`(() => {
  const row = document.querySelector('.bg-row');
  if (!row) return null;
  const li = row.querySelector('.bg-item[data-kind="delegation"]');
  return {
    text: (row.querySelector('.bg-text')?.textContent || '').trim(),
    hint: (row.querySelector('.bg-hint')?.textContent || '').trim(),
    open: row.querySelector('.bg-head')?.getAttribute('aria-expanded'),
    item: li ? {
      tag: (li.querySelector('.bg-tag')?.textContent || '').trim(),
      goal: (li.querySelector('.bg-cmd-full')?.textContent || '').trim(),
      meta: (li.querySelector('.bg-meta')?.textContent || '').replace(/\\s+/g, ' ').trim(),
    } : null,
  };
})()`);

await ev(`fetch('/api/sessions/${sid}/prompt',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({text:'[bg-delegation] 派两个子任务'})}).then(r=>r.status)`);
await sleep(1400);
let snap = await head();
check("子任务让「后台任务」行出现", Boolean(snap), "no .bg-row");
check("台头把它算成子任务（含 2 个子任务）", (snap?.text || "").includes("含 2 个子任务"), snap?.text ?? "");
check("空闲提示仍在（会话已收工、子任务还在跑）", (snap?.hint || "").includes("后台仍在跑"), snap?.hint ?? "");

const expanded = await ev(`(() => {
  const b = document.querySelector('.bg-row .bg-head');
  if (!b) return false;
  b.click();
  return true;
})()`);
await sleep(350);
snap = await head();
check("点开台头（bg-head）", expanded === true && snap?.open === "true", String(snap?.open));
check("展开后有 delegation 行", Boolean(snap?.item), "no li[data-kind=delegation]");
check("行上带「子任务」徽章", snap?.item?.tag === "子任务", snap?.item?.tag ?? "");
check("显示的是目标原文，不是命令行", (snap?.item?.goal || "").includes("读一遍 packages/web"), snap?.item?.goal ?? "");
check("写明「2 个子代理 · 运行 …」", (snap?.item?.meta || "").includes("2 个子代理") && (snap?.item?.meta || "").includes("运行"), snap?.item?.meta ?? "");
check("不编造 pid", !/pid/.test(snap?.item?.meta || ""), snap?.item?.meta ?? "");

// 完成 + 快照清空之后：那一行必须消失，别留一个永远在跑的假行。
await sleep(2600);
snap = await head();
check("完成后子任务行消失（没有永远转圈的假行）", !snap?.item, snap?.item ? JSON.stringify(snap.item) : "(gone)");

console.log(`\n${fail === 0 ? "OK" : "FAILED"} — ${pass} passed, ${fail} failed`);
try { await fetch(`${CDP}/json/close/${tab.id}`); } catch { /* best effort */ }
process.exit(fail === 0 ? 0 : 1);
