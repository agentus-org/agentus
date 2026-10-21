// 记忆召回抽屉（#37 第二版）在 REAL 页面上的形状断言。
//
// 操作者两次反馈：「一展开就是刷屏」（第一版就修成了定高 + 内部滚动）、「展示效果不好」（第二版重做
// 版式：换行独占一块、表头写共 N 条、条目带序号、标签降到正文下面、滚得动才给渐隐和提示）。
// 这两个要求都不是「有没有渲染出来」，而是版式 —— 只有浏览器能判，所以这里量的是几何：
//
//   · 抽屉必须在**状态句下面另起一行**（第一版实测被挤在同一行右边，标题左、抽屉右各占半屏，
//     原因是 flex 行分割用的是夹紧到 max-width 之后的假设主尺寸）；
//   · 高度固定（≤ 200px 上下），条目多时框内可滚，而不是把转录顶出去；
//   · 条目有 1..N 序号、标签在正文下方；
//   · 收起后高度回到单行附近，转录滚动位置不因为展开而跳到底部。
//
//   PORT=8901 AGENTUS_DATA=/tmp/agentus-qa-account node scripts/qa/status-note-drawer.mjs
const CDP = process.env.CDP ?? "http://127.0.0.1:9222";
const BASE = process.env.BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8901}`;
const U = process.env.QA_USER ?? "scratch", P = process.env.QA_PASS ?? "scratch-pass-1";
const DATA_RAW = process.env.AGENTUS_DATA ?? "/tmp/agentus-qa-account";
// 环境里常残留 live 树的 AGENTUS_DATA（`worktrees/agentus/packages/server/.data`）：读它不会写坏什么，
// 但那库里的会话在 dev 实例上根本不存在，测出来的「找不到按钮」是假红。QA 只认 QA 账号目录。
const DATA = /worktrees\/agentus\//.test(DATA_RAW) ? "/tmp/agentus-qa-account" : DATA_RAW;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

// ---- 找一个真的带 items 的召回行（直接读库，不靠接口猜）-------------------------------------
// 只挑「这条 note 就在会话尾部」的会话：抽屉只存在于已经渲染出来的那段转录里，挑一条翻页翻到
// 几十条之前的 note，页面上根本不会有它的 toggle —— 那是脚本的错，不是版式的错（第一版就这么
// 误报过一次 `a 「20 条」toggle is on the page`）。
const { execFileSync } = await import("node:child_process");
const { existsSync } = await import("node:fs");
// `sqlite3 -json` + execFileSync（参数数组）而不是把 SQL 拼进 shell 字符串：payload 是 JSON（含引号、
// 换行），过 shell 一次就会被转义成 `\n` 字面量，sqlite 报 `unrecognized token`。第一版还因此读到
// 了**错的库**（继承了环境里的 AGENTUS_DATA，指到 live 树），于是造出库里不存在的 session id。
const dbPath = existsSync(`${DATA}/agentus.sqlite`) ? `${DATA}/agentus.sqlite` : "/tmp/agentus-qa-account/agentus.sqlite";
const q = (sql) => execFileSync("sqlite3", ["-json", dbPath, sql], { encoding: "utf8" }).trim();
console.log(`      db = ${dbPath}`);
let cands = [];
try {
  const rows = q(`select session_id as sid, seq,
                         (select max(seq) from messages m2 where m2.session_id = m1.session_id) as maxseq,
                         payload
                  from messages m1
                  where kind = 'note' and payload like '%"items"%'
                  order by created_at desc limit 40;`);
  for (const r of JSON.parse(rows || "[]")) {
    let n = 0;
    try { n = JSON.parse(r.payload).items?.length ?? 0; } catch { continue; }
    if (n >= 6) cands.push({ sid: r.sid, want: n, dist: Number(r.maxseq) - Number(r.seq) });
  }
  // 离尾部越近越稳：抽屉只存在于已经渲染出来的那段转录里
  cands.sort((a, b) => a.dist - b.dist);
} catch (e) {
  console.log(`note: could not read ${DATA}/agentus.sqlite — ${e.message}`);
}
if (!cands.length) {
  console.log(`SKIP  no recall note with ≥6 items in ${DATA}`);
  console.log(`0 passed, 0 failed, 1 skipped`);
  process.exit(0);
}
console.log(`      candidates = ${cands.map((c) => `${c.sid}(${c.want},+${c.dist})`).join(", ")}`);

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
await send("Page.enable"); await send("Runtime.enable");
const waitFor = async (expr, ms = 15_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await ev(expr).catch(() => 0)) return true; await sleep(250); }
  return false;
};

let code = 1;
try {
  const login = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
  check("logged in to the dev instance (a login wall is not a transcript)", login === 200, `status=${login}`);

  let sid = "", want = 0, landed = false;
  for (const c of cands) {
    await ev(`location.href = ${JSON.stringify(BASE)} + '/?session=' + ${JSON.stringify(c.sid)}`);
    // SPA 在登录后会自己改写 URL（回到「上次的会话」），所以不能只等 composer —— 要等到地址栏
    // 真的停在目标会话、并且那一行的 toggle 出现为止，否则测的是别人的转录。
    const arrived = await waitFor(`location.search.includes(${JSON.stringify(c.sid)}) ? 1 : 0`, 12_000);
    if (!arrived) continue;
    const seen = await waitFor(`[...document.querySelectorAll('.status-note-toggle')]
      .some(b => b.textContent.trim() === ${JSON.stringify(String(c.want) + " 条")}) ? 1 : 0`, 8_000);
    if (seen) { sid = c.sid; want = c.want; landed = true; break; }
  }
  check("a rendered status row carries a 「N 条」toggle", landed, landed ? `${sid} (${want} items)` : "none of the candidates rendered one");
  if (!landed) throw new Error("no 条 toggle on the page — the probe note is not in the rendered page");

  // 展开前：把读者放到转录中间并**派发一次真实 scroll**。
  // 只改 `scrollTop` 不派发事件是不够的：客户端仍以为自己在「跟随底部」，下一条渲染会把它拉回底部 ——
  // 那一刻量的不是「展开会不会甩走读者」，而是「跟随逻辑还在不在」（第一版就是这么误报的）。
  // 还要等页面**静止**：刚 navigate 过来的 1~2 秒里客户端仍处在「初始贴底」阶段，此时滚动会被
  // 立刻拉回底部（第二版在这里误报过 11 条 FAIL，手工在静止页面上复测是 PASS）。
  let before = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = await ev(`(async () => {
      const s = document.querySelector('.stream');
      const max = s.scrollHeight - s.clientHeight;
      s.scrollTop = Math.round(max * 0.3);
      s.dispatchEvent(new Event("scroll", { bubbles: true }));
      await new Promise(res => setTimeout(res, 500));
      const pos1 = Math.round(s.scrollTop);
      await new Promise(res => setTimeout(res, 500));
      const pos2 = Math.round(s.scrollTop);
      const t = [...document.querySelectorAll('.status-note-toggle')].find(b => b.textContent.includes(${JSON.stringify(String(want))}));
      const n = t ? t.closest('.status-note') : null;
      return { found: !!t, noteH: n ? Math.round(n.getBoundingClientRect().height) : 0,
               scrollTop: pos2, max: s.scrollHeight - s.clientHeight, stable: Math.abs(pos2 - pos1) <= 2 };
    })()`);
    before = r;
    if (r.stable && r.scrollTop < r.max - 8) break;
    await sleep(600);
  }
  check(`a 「${want} 条」toggle is on the page`, before.found);

  const opened = await ev(`(async () => {
    const t = [...document.querySelectorAll('.status-note-toggle')].find(b => b.textContent.includes(${JSON.stringify(String(want))}));
    t.click();
    await new Promise(r => setTimeout(r, 450));
    const note = t.closest('.status-note');
    const dr = note.querySelector('.status-note-drawer');
    const ol = note.querySelector('.status-note-items');
    const head = note.querySelector('.status-note-drawer-head');
    // 旧版式（0.8.0）没有 drawer 这一层：要报成一条 FAIL，而不是让脚本抛异常 —— 异常收场时
    // 「区分度」这件事本身就没被证明（旧构建的跑分只留下 3 条 PASS）。
    if (!dr || !ol) return { drawerExists: false, ownLine: false, alignedWithNote: false, width: 0,
      listH: 0, maxH: "", overflowY: "", canScroll: false, dataScroll: "", hint: "", count: 0,
      numbered: false, tagsBelowText: false, hOverflow: true, scrollTopAfter: document.querySelector('.stream').scrollTop };
    const items = [...ol.children];
    const firstText = items[0]?.querySelector('.status-note-item-n');
    const tagEl = items.map(li => li.querySelector('.status-note-item-tags')).find(Boolean);
    const tagText = tagEl ? tagEl.closest('.status-note-item-text') : null;
    const nr = note.getBoundingClientRect(), drr = dr.getBoundingClientRect();
    return {
      toggle: t.textContent,
      drawerExists: true,
      ownLine: drr.top >= nr.top + 12,          // 抽屉起点明显低于状态句所在行
      alignedWithNote: Math.abs(drr.left - nr.left) < 24,
      width: Math.round(drr.width),
      listH: Math.round(ol.getBoundingClientRect().height),
      maxH: getComputedStyle(ol).maxHeight,
      overflowY: getComputedStyle(ol).overflowY,
      canScroll: ol.scrollHeight - ol.clientHeight > 4,
      dataScroll: dr.dataset.scroll,
      hint: head ? head.textContent : "",
      numbered: !!firstText && firstText.textContent.trim() === "1",
      tagsBelowText: !!(tagEl && tagText) ? tagEl.getBoundingClientRect().top >= tagText.getBoundingClientRect().top : null,
      hOverflow: ol.scrollWidth > ol.clientWidth + 1,
      count: items.length,
      scrollTopAfter: document.querySelector('.stream').scrollTop,
    };
  })()`);

  check("clicking the toggle opens a drawer", opened.drawerExists);
  check("the drawer starts on its OWN line under the status row", opened.ownLine,
    `drawer.top − note.top = ${opened.ownLine ? "positive" : "not"}`);
  check("the drawer is aligned with the note's left edge", opened.alignedWithNote);
  check("the drawer is width-capped instead of spanning the transcript", opened.width <= 700, `${opened.width}px`);
  check("the list is a fixed height (not the length of the memories)", opened.listH <= 210 && opened.listH >= 120, `${opened.listH}px, max-height=${opened.maxH}`);
  check("overflow is scrollable inside the box", opened.overflowY === "auto" && opened.canScroll,
    `overflow-y=${opened.overflowY}, scrollHeight>clientHeight=${opened.canScroll}`);
  check("the fade + 「滚轮查看」hint appear only when it really scrolls", opened.dataScroll === "1" && opened.hint.includes("滚轮查看"), opened.hint.replace(/\s+/g, " ").trim());
  // 表头写的是**记忆条数**，而列表里多一行「…还有更多，已截断」，所以不能拿 children.length 对账。
  check("the header states how many memories there are", opened.hint.includes(String(want)),
    `header=「${opened.hint.replace(/\s+/g, " ").trim()}」, items=${want}, rows=${opened.count}`);
  check("items are numbered, starting at 1", opened.numbered);
  check("the tag line sits BELOW its own text, not floating at the line end", opened.tagsBelowText !== false);
  check("no horizontal overflow inside the list", !opened.hOverflow);

  const closed = await ev(`(async () => {
    const t = [...document.querySelectorAll('.status-note-toggle')].find(b => b.textContent === '收起');
    t.click();
    await new Promise(r => setTimeout(r, 350));
    const note = t.closest('.status-note');
    return { drawer: !!note.querySelector('.status-note-drawer'), noteH: Math.round(note.getBoundingClientRect().height), label: t.textContent };
  })()`);
  check("收起 collapses it back to the one-line row", !closed.drawer && closed.noteH <= before.noteH + 4,
    `note ${before.noteH}px → ${closed.noteH}px, toggle=「${closed.label}」`);
  // 读者已经滚离底部时，展开抽屉是「我主动看这里」，不能把人家甩到最新一条去。
  const jump = Math.abs(opened.scrollTopAfter - before.scrollTop);
  check("expanding did not fling a reader who had scrolled up",
    before.scrollTop < before.max - 8 && jump <= 8,
    `scrollTop ${before.scrollTop} → ${opened.scrollTopAfter} (max ${before.max})`);

  code = fail ? 1 : 0;
} catch (e) {
  console.log(`ERROR ${e.message}`);
} finally {
  await fetch(`${CDP}/json/close/${t.id}`).catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(code);
}
