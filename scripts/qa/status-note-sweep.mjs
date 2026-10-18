// QA: agent 的状态公告是「会话记录里的一行」，不是「处理中」后面的尾巴。
//
// 操作者的判断（2026-10-18）：「它不只是这一个状态，压缩什么的也会显示，所以应该放在会话聊天记录框
// 里面」。这条改动有三个必须被守住的点，缺一个就退化成噪音或谎报历史：
//
//   1. 一行 = 一次事件，同类心跳必须合并 —— 一次压缩会发「summarizing…」再发若干次
//      「still summarizing…」；每帧一行的话，一次压缩就是十几行。
//   2. 顺序 = 真实发生顺序（每行记它出现时最新那条消息，插回那个位置），时间戳递增。
//   3. 它绝不能进 `msgs`：不进存储、不进导出、不进回放 —— 刷新即失是设计，不是缺陷。
//
// 顺带守住同一块的老契约：`.stream-hint` 只剩转圈 + 「处理中 (12 秒)」，在任何宽度都必须是一行
// （它曾经被长状态挤到换行，这才是把状态搬走的起因）。
//
//   CDP=http://127.0.0.1:9222 PORT=8901 node scripts/qa/status-note-sweep.mjs
const CDP = process.env.CDP ?? "http://127.0.0.1:9222";
const BASE = process.env.BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8901}`;
const U = process.env.QA_USER ?? "scratch", P = process.env.QA_PASS ?? "scratch-pass-1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(1500);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const waiting = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { const x = waiting.get(m.id); waiting.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); } };
const send = (method, params = {}, to = 25000) => new Promise((res, rej) => {
  const mid = ++id; const timer = setTimeout(() => { waiting.delete(mid); rej(new Error(`TIMEOUT ${method}`)); }, to);
  waiting.set(mid, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expr, to = 25000) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, to);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};
const until = async (expr, to = 20000) => {
  const end = Date.now() + to;
  for (;;) { if (await ev(expr)) return true; if (Date.now() > end) return false; await sleep(400); }
};
await send("Page.enable"); await send("Runtime.enable");

let sid = null;
try {
  await send("Page.navigate", { url: `${BASE}/` });
  await sleep(1500);
  const who = await ev(`fetch('/api/auth/login',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
  check("logged in to the instance under test", who === 200, `HTTP ${who}`);

  const made = await ev(`fetch('/api/sessions',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({backend:'mock',cwd:'/tmp',title:'status-note sweep'})}).then(async r=>r.status+' '+await r.text())`);
  sid = JSON.parse(String(made).slice(4))?.id;
  check("created a mock session", Boolean(sid), String(made).slice(0, 100));
  await until(`fetch('/api/sessions',{credentials:'same-origin'}).then(r=>r.json()).then(d=>(d.live||[]).some(s=>s.id===${JSON.stringify(sid)}&&s.status==='ready'))`, 30000);
  await send("Page.navigate", { url: `${BASE}/?session=${sid}` });
  await sleep(1800);

  const prompt = (text) => ev(`fetch('/api/sessions/${sid}/prompt',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({text:${JSON.stringify(text)}})}).then(r=>r.status)`);
  const notes = () => ev(`JSON.stringify([...document.querySelectorAll('.status-note')].map(e=>({
    time: e.querySelector('.status-note-time')?.textContent,
    text: e.querySelector('.status-note-text')?.textContent,
    kind: e.dataset.kind,
    after: e.previousElementSibling?.className || '',
    of: e.scrollWidth - e.clientWidth,
    h: Math.round(e.getBoundingClientRect().height),
  })))`).then(JSON.parse);

  // ---- 1. 第一轮：一条 lifecycle 状态 + 「处理中」那行还剩什么 -------------------------
  await prompt("[status] 状态行 sweep 第一轮");
  const appeared = await until(`document.querySelectorAll('.status-note').length >= 1`, 20000);
  check("a status line becomes a row in the transcript", appeared, `rows=${(await notes()).length}`);
  const first = (await notes())[0];
  check("the row carries a HH:MM:SS clock", /^\d\d:\d\d:\d\d$/.test(first?.time ?? ""), String(first?.time));
  check("the row keeps the kind the server sent", first?.kind === "lifecycle", String(first?.kind));
  check("the row is placed after a transcript message, not floated at the top", /msg/.test(first?.after ?? ""), String(first?.after));
  check("the sentence is the agent's, verbatim", /Hindsight/.test(first?.text ?? ""), String(first?.text).slice(0, 60));
  check("nothing overflows the row horizontally", (first?.of ?? 99) <= 1, `overflow=${first?.of}px`);

  // 「处理中」那行：只剩转圈 + 词 + 秒，且在任何宽度都是单行。
  // 量的时候必须有一轮在跑 —— 这行只在 busy 时存在，所以每个宽度都重新发一次 `[status]`，等它出现
  // 再量（第一版是先量两档、后发第二句，结果 1280 那次量在回合结束之后，四项全假失败）。
  for (const [label, width, mobile] of [["phone 390", 390, true], ["desktop 1280", 1280, false]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: mobile ? 844 : 900, deviceScaleFactor: mobile ? 2 : 1, mobile });
    await sleep(500);
    if (!(await ev(`Boolean(document.querySelector('.stream-hint'))`))) {
      await prompt(`[status] 状态行 sweep 1 行检查 ${label}`);
      await until(`Boolean(document.querySelector('.stream-hint'))`, 15000);
    }
    await sleep(200);
    const row = await ev(`(() => {
      const el = document.querySelector('.stream-hint');
      if (!el) return { found: false };
      const cs = getComputedStyle(el), r = el.getBoundingClientRect();
      const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
      return { found: true, h: Math.round(r.height), lineH: Math.round(lineH),
        of: el.scrollWidth - el.clientWidth, status: el.querySelectorAll('.turn-status').length };
    })()`);
    check(`${label}: the turn line is still there while the turn runs`, row.found === true);
    check(`${label}: the turn line is ONE line (no status squeezed in beside it)`, row.found && row.h <= row.lineH + 8, `h=${row.h} lineH=${row.lineH}`);
    check(`${label}: no status span left inside the turn line (it is a row now)`, row.status === 0);
    check(`${label}: the turn line does not overflow`, (row.of ?? 99) <= 1, `overflow=${row.of}px`);
  }
  await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });

  // ---- 2. 一次压缩 = 两行（开始/完成），心跳合并进开始那行 --------------------------
  await until(`fetch('/api/sessions/${sid}',{credentials:'same-origin'}).then(r=>r.json()).then(d=>d.busy!==true)`, 25000).catch(() => {});
  await sleep(500);
  const before = (await notes()).length;
  await prompt("[status:compacting#3] 压缩中");
  await sleep(3000);
  const mid = (await notes()).length;
  check("3 compaction frames collapse into ONE row (heartbeats fold)", mid - before === 1, `added ${mid - before}`);
  await prompt("[status:compacted] 压缩完成");
  await until(`document.querySelectorAll('.status-note').length >= ${mid + 1}`, 20000);
  const all = await notes();
  check("the completion is its own row", all.length === mid + 1, `rows=${all.length}`);
  check("kinds read in the order they happened", all.map((n) => n.kind).join(",") === "lifecycle,compacting,compacted", all.map((n) => n.kind).join(","));
  check("the clock never goes backwards", all.every((n, i) => i === 0 || n.time >= all[i - 1].time), all.map((n) => n.time).join(" "));
  check("the compaction row shows the LAST heartbeat, not the first frame", /still summarizing/.test(all[1]?.text ?? ""), String(all[1]?.text).slice(0, 60));

  // ---- 3. 长句子：折行，不横向溢出（在 390px 量 —— 宽屏这一句本来就放得进一行）-------
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(600);
  const wrap = await ev(`(() => {
    const el = document.querySelector('.status-note');
    const t = el?.querySelector('.status-note-text');
    if (!t) return { found: false };
    const before = Math.round(el.getBoundingClientRect().height);
    t.textContent = '👁️ Hindsight — recalled 8 memories · 上下文 256K/512K · 已保存 3 条新事实 · provider 等待 12 秒 · 压缩已排队';
    const after = Math.round(el.getBoundingClientRect().height);
    return { found: true, before, after, of: el.scrollWidth - el.clientWidth,
      lines: Math.round(t.getBoundingClientRect().height / (parseFloat(getComputedStyle(t).lineHeight) || 18)) };
  })()`);
  check("a long status sentence wraps instead of overflowing", wrap.found && wrap.of <= 1, `overflow=${wrap.of}px`);
  check("…and it really did take more than one line", wrap.after > wrap.before, `${wrap.before}px → ${wrap.after}px (${wrap.lines} lines)`);

  // ---- 4. 不进历史：存储里没有这些句子，刷新后页面上也没有 ---------------------------
  const stored = await ev(`fetch('/api/sessions/${sid}/messages?tail=1',{credentials:'same-origin'}).then(r=>r.text())`);
  check("the status text never reaches the stored transcript", !/Hindsight|Compacting context/.test(String(stored)), `${String(stored).length} bytes scanned`);
  // 先让回合停下来再刷新：一轮还在跑的时候刷新，新起的回合会照常发自己的状态行，那不是「没清掉」。
  await ev(`fetch('/api/sessions/${sid}/cancel',{method:'POST'}).then(r=>r.status)`).catch(() => {});
  await sleep(800);
  await send("Page.navigate", { url: `${BASE}/?session=${sid}` });
  await sleep(2500);
  // 刷新后**早先那些行**必须一个都回不来。不能直接断言「0 行」：一轮若恰好在刷新前后还在发帧，
  // 新来的那一条是真的新事件（第一版就撞上这个，红了一次）。所以断言的是「没有回放」。
  const reloaded = await notes();
  check("a reload brings back none of the earlier rows (in-memory by design)",
    !reloaded.some((n) => /Hindsight/.test(n.text ?? "")),
    JSON.stringify(reloaded.map((n) => n.text)));
} catch (e) {
  console.log(`\nERROR ${e.message}`);
  fail++;
} finally {
  if (sid) await ev(`fetch('/api/sessions/${sid}',{method:'DELETE'}).then(r=>r.status)`).catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
