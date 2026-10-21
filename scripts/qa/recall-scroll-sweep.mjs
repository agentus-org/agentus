// QA (issue #37) — 召回条目展开是「定高滚动框」，不是把转录顶下去。
//
// 操作者 2026-10-21 的原话：「召回的信息展示用定高的框上下可滚动，要不然一展开就是刷屏了，
// 还有就是展示效果不好」。所以这条测两件事，都是**量出来的**，不是看着像：
//   · 展开后 `.status-note-items` 有上限高度（200px）且 overflow-y:auto，内容比框高 →
//     真的能滚（scrollHeight > clientHeight，scrollTop 写得进去）；
//   · 展开让整个转录只长了「那个框」那么多（<= 300px），而不是条目总高（20 条 > 1000px）。
// 另外断言标签是正文下面的注脚小字（0.8.1 版式：不再是行尾胶囊），以及折叠状态下不渲染条目。
//
// Usage: PORT=8901 node scripts/qa/recall-scroll-sweep.mjs [--shot /tmp/recall.png]
const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";
const PORT = Number(process.env.PORT || 8901);
const BASE = process.env.AGENTUS_BASE || `http://127.0.0.1:${PORT}`;
const U = process.env.QA_USER ?? "scratch", P = process.env.QA_PASS ?? "scratch-pass-1";
const shotIdx = process.argv.indexOf("--shot");
const SHOT = shotIdx > 0 ? process.argv[shotIdx + 1] : "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = await import("node:fs/promises");

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

const code = await ev(`fetch('/api/auth/login',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
check("QA login", code === 200, `status ${code}`);
const sess = await ev(`fetch('/api/sessions',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({backend:'mock',cwd:'/tmp',title:'recall scroll'})}).then(r=>r.json())`);
check("打开 mock 会话", Boolean(sess?.id), String(sess?.id));
const sid = sess.id;
await ev(`location.href = ${JSON.stringify(BASE + "/?session=" + sid)}`);
await sleep(3200);
await ev(`fetch('/api/sessions/${sid}/prompt',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({text:'[recall:20] 看看记忆'})}).then(r=>r.status)`);
await sleep(3500);

const state = () => ev(`(() => {
  const row = document.querySelector('.status-note');
  if (!row) return null;
  const box = row.querySelector('.status-note-items');
  const range = document.createRange();
  range.selectNodeContents(document.querySelector('.stream-inner'));
  const inner = document.querySelector('.stream-inner');
  const tag = row.querySelector('.status-note-item-tags');
  return {
    text: (row.querySelector('.status-note-text')?.textContent || '').trim(),
    toggle: (row.querySelector('.status-note-toggle')?.textContent || '').trim(),
    expanded: row.querySelector('.status-note-toggle')?.getAttribute('aria-expanded'),
    items: row.querySelectorAll('.status-note-item:not(.more)').length,
    more: row.querySelectorAll('.status-note-item.more').length,
    streamHeight: inner ? inner.getBoundingClientRect().height : 0,
    contentHeight: range.getBoundingClientRect().height,
    box: box ? {
      maxHeight: getComputedStyle(box).maxHeight,
      overflowY: getComputedStyle(box).overflowY,
      height: box.getBoundingClientRect().height,
      clientHeight: box.clientHeight,
      scrollHeight: box.scrollHeight,
      scrollTop: box.scrollTop,
      radius: tag ? getComputedStyle(tag).borderRadius : null,
    } : null,
  };
})()`);

const collapsed = await state();
check("召回行出现了", Boolean(collapsed), collapsed ? "" : "no .status-note");
// 条数不设上限（2026-10-21：只按 12K 总量截），这里的 20 条是**测试自己放进去的量** ——
// 线上 budget 高时一轮召回就是这个量级，够量出「装不下 → 可滚」。多几条也照样成立。
check("折叠时写着「20 条」", (collapsed?.toggle || "").includes("20 条"), collapsed?.toggle ?? "");
check("折叠时不渲染条目", collapsed?.items === 0 && collapsed?.box === null, `items=${collapsed?.items}`);
const tallBefore = collapsed?.streamHeight ?? 0;

await ev(`document.querySelector('.status-note-toggle')?.click()`);
await sleep(350);
const open = await state();
check("展开后 aria-expanded=true", open?.expanded === "true", String(open?.expanded));
check("展开出 20 条（截断提示单独一行，不算一条记忆）", open?.items === 20 && open?.more === 1, `${open?.items} 条 + ${open?.more} 行提示`);
check("条目框是定高（200px）", open?.box?.maxHeight === "200px", String(open?.box?.maxHeight));
check("条目框竖向滚动", open?.box?.overflowY === "auto", String(open?.box?.overflowY));
check("框高没有超过上限", (open?.box?.height ?? 9999) <= 220, String(open?.box?.height?.toFixed(1)));
check("内容比框高（20 条装不下 → 必须滚）", (open?.box?.scrollHeight ?? 0) > (open?.box?.clientHeight ?? 0) + 40,
  `${open?.box?.scrollHeight} vs ${open?.box?.clientHeight}`);
const grew = (open?.streamHeight ?? 0) - tallBefore;
check("展开只让转录长了一个框（不刷屏）", grew > 0 && grew <= 300, `长高 ${grew.toFixed(0)}px（条目总高 ${open?.contentHeight?.toFixed(0)}px）`);
check("条目总高远大于框高（说明确实有 20 条内容）", (open?.contentHeight ?? 0) > (open?.box?.height ?? 0) * 2,
  `${open?.contentHeight?.toFixed(0)} vs ${open?.box?.height?.toFixed(0)}`);

const scrolled = await ev(`(() => {
  const box = document.querySelector('.status-note-items');
  box.scrollTop = 120;
  return { top: box.scrollTop, maxTop: box.scrollHeight - box.clientHeight };
})()`);
check("框内滚动真的生效（scrollTop 写得进去）", scrolled.top > 0, JSON.stringify(scrolled));
const tag = await ev(`(() => { const t = document.querySelector('.status-note-item-tags'); if (!t) return null; const cs = getComputedStyle(t); const body = t.closest('.status-note-item-body'); return { radius: cs.borderRadius, size: cs.fontSize, dim: cs.color !== getComputedStyle(document.body).color, text: t.textContent, below: body ? t.getBoundingClientRect().top >= body.querySelector('.status-note-item-text').getBoundingClientRect().bottom - 1 : null }; })()`);
// 0.8.1 的版式：标签是正文下面一行小字（不是行尾胶囊）。判据是「没有圆角 + 比正文小 + 在正文下方」，
// 而不是「圆角够不够大」—— 那正是操作者说「展示效果不好」时被换掉的那一版。
check("标签是正文下面的注脚小字（不再是胶囊）", Boolean(tag) && parseFloat(tag.radius || "0") < 4 && parseFloat(tag.size || "99") <= 10.5 && tag.below === true, JSON.stringify(tag));

await ev(`(() => { const s = document.querySelector('.stream'); if (s) s.scrollTop = s.scrollHeight; })()`);
await sleep(200);
if (SHOT) {
  const jpg = await send("Page.captureScreenshot", { format: "png" });
  await fs.writeFile(SHOT, Buffer.from(jpg.data, "base64"));
  console.log(`  shot → ${SHOT}`);
}

// 收起重来一次：再点一下应当是收回去，且高度还原
await ev(`document.querySelector('.status-note-toggle')?.click()`);
await sleep(300);
const again = await state();
check("再点一次收起", again?.expanded === "false" && again?.items === 0, String(again?.expanded));
check("收起后转录高度回到展开前", Math.abs((again?.streamHeight ?? 0) - tallBefore) < 40,
  `${(again?.streamHeight ?? 0).toFixed(0)} vs ${tallBefore.toFixed(0)}`);

console.log(`\n${fail === 0 ? "OK" : "FAILED"} — ${pass} passed, ${fail} failed`);
try { await fetch(`${CDP}/json/close/${tab.id}`); } catch { /* best effort */ }
process.exit(fail === 0 ? 0 : 1);
