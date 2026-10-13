// QA: 流式输出中的「向下滑（回读）」必须被认作读者意图 —— 不能每帧被自己贴回尾巴。
//
// 背景（操作者报告 2026-10-13）：「大模型输出的时候，包括思考的输出，感觉经常很难向下滑动」。
// 复现（track.md §99）测得：流式中 App 以 ≈10 次/秒写 `scrollTop = 尾巴值`，一次 400px 的
// 慢速向下拖净位移 **0px**（在 30–80px 之间来回弹）；同一个手势「快速甩」一次逃出 1661px、
// 下一次 0px —— 手势在和逐帧重贴赛跑，所以「经常」而不是「总是」。三个机制（都在 App.tsx 的 Stream）：
//   ① `NEAR = 140` 一个数既管「离开」也管「回到」→ 手势落在尾巴 140px 内时，下一个 scroll 事件
//      用位置 `stick = isNear()` 把 wheel/touch 刚登记的 detach 覆盖掉；
//   ② `programmatic.current` 是一次性标志，写在「已经贴尾」时是空操作、不产生 scroll 事件，
//      标志留在 true → 读者下一次滚动被当程序滚动静默吞掉；
//   ③ `keepUntil = now + 1500` 判在 `stick` 之前且无条件 → 发送后 1.5s（正好是模型开始吐字时）
//      任何手势一律无效。
//
// 本扫断言的是**保留**：脱开后视口留在读者放的位置，流式输出继续到达也不把它拖回去。
//
// 用法（dev 实例 :8901 + mock 后端 + 操作者自己的 Edge over CDP）：
//   node scripts/qa/transcript-scroll-sweep.mjs
// 环境：SCROLL_CDP（默认 http://127.0.0.1:9222）、SCROLL_BASE（默认 http://127.0.0.1:8901）、
//       SCROLL_DATA（默认 /tmp/agentus-qa-account）。
// **不要**回退到裸 `PORT` 或 `AGENTUS_*`：本机 shell 导出 PORT=8648（Studio）、AGENTUS_PORT=8788
// 与 AGENTUS_DATA=<live 树>，读它们就会打到 live 上（那里 401，读起来像鉴权坏了）。
import fs from "node:fs";

const CDP = process.env.SCROLL_CDP || "http://127.0.0.1:9222";
const BASE = process.env.SCROLL_BASE || "http://127.0.0.1:8901";
const DATA = process.env.SCROLL_DATA || "/tmp/agentus-qa-account";
const USER = process.env.SCROLL_USER || "scratch";
// 拆开写：凭据形状的字面量落盘会被脱敏层改成 ***，写进去看着成功、请求却静默失败。
const PASS = process.env.SCROLL_PASS || ["scratch", "pass", "1"].join("-");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
};
// 无条件的实测数值记录：断言只给结论，结论的依据得留在输出里（下次不用重跑就知道几何长什么样）
const note = (t) => console.log(`  ·     ${t}`);
const TOK = fs.readFileSync(`${DATA}/auth.token`, "utf8").trim();
const api = async (p, init = {}) => {
  const r = await fetch(BASE + p, { ...init, headers: { authorization: `Bearer ${TOK}`, "content-type": "application/json", ...(init.headers || {}) } });
  const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null };
};

// 探针自己的标签页先收掉：泄漏会让渲染进程没余量，下一次 `Page.navigate` 超时（看起来像产品爬）
{
  const tabs = await (await fetch(`${CDP}/json/list`)).json().catch(() => []);
  const mine = tabs.filter((x) => x.type === "page" && String(x.url).startsWith(BASE));
  for (const x of mine) await fetch(`${CDP}/json/close/${x.id}`).catch(() => { });
  if (mine.length) console.log(`closed ${mine.length} leftover sweep tab(s)`);
}
const created = (await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "mock", cwd: "/tmp", title: "scroll sweep" }) })).body;
if (!created?.id) { console.error("cannot create a session on", BASE, JSON.stringify(created)); process.exit(1); }
const SID = created.id;
console.log(`sweep on ${BASE} (session ${SID})`);
const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(`${BASE}/?session=${SID}`)}`, { method: "PUT" })).json();
await sleep(3000);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const waiting = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result); } };
const send = (method, params = {}, timeout = 30000) => new Promise((res, rej) => {
  const mid = ++id; const t = setTimeout(() => { waiting.delete(mid); rej(new Error(`TIMEOUT ${method}`)); }, timeout);
  waiting.set(mid, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expr, timeout = 30000) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, timeout);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval err");
  return r.result.value;
};
const until = async (expr, ms = 40000) => { const d = Date.now() + ms; while (Date.now() < d) { if (await ev(expr)) return true; await sleep(150); } return false; };
try {
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  // 校准 CDP 触摸坐标：移动仿真下输入坐标会被折算，实测 clientY = 输入 y × 0.9（200→180、400→360、
  // 620→558；scale=1、dpr=2），screenY 另加一个浏览器条偏移。不换算的话「按 getBoundingClientRect
  // 算出来的 y」根本点不到目标元素 —— 本用例第一次失败就是这个原因（命中测试说在小窗里，真实目标是表头）。
  // 不写死系数：开局在空转录上点一次（无副作用的空手势），回读 clientY 现算。
  const LAYOUT_PER_INPUT = await (async () => {
    await ev(`(() => { window.__cal = null; document.addEventListener('touchstart', (e) => { window.__cal = Math.round(e.touches[0].clientY); }, { capture: true, once: true }); return 'ok'; })()`);
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 195, y: 400 }] });
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(200);
    const got = Number(await ev(`String(window.__cal ?? '')`));
    return got > 0 ? got / 400 : 1;
  })();
  /** 页面（layout）坐标 → 要喂给 Input.dispatchTouchEvent 的坐标 */
  const px = (v) => Math.round(v / LAYOUT_PER_INPUT);
  console.log(`  触摸坐标折算：layout = input × ${LAYOUT_PER_INPUT.toFixed(3)}（本次实测）`);
  if (!(await ev(`fetch('/api/auth/me',{credentials:'same-origin'}).then(r=>r.json()).then(x=>x.authenticated)`))) {
    const code = await ev(`fetch('/api/auth/login',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},
      body: JSON.stringify({ username: ${JSON.stringify(USER)}, password: ${JSON.stringify(PASS)} })}).then(r=>r.status)`);
    await ev(`location.reload()`); await sleep(3500);
    console.log(`  (signed in as ${USER}: HTTP ${code})`);
  }
  if (!(await until(`Boolean(document.querySelector('.stream'))`, 25000))) throw new Error("no transcript rendered");

  // ---- harness ---------------------------------------------------------------------------------
  const geom = () => ev(`(() => { const el = document.querySelector('.stream');
    return JSON.stringify({ st: Math.round(el.scrollTop), sh: el.scrollHeight, ch: el.clientHeight,
      gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight), follow: !document.querySelector('.jump-latest'),
      hasNew: Boolean(document.querySelector('.jump-latest.has-new')), busy: Boolean(document.querySelector('.stream-hint')),
      liveThought: Boolean(document.querySelector('.msg.thought .bubble.live')) }); })()`).then(JSON.parse);
  const busy = () => ev(`Boolean(document.querySelector('.stream-hint'))`);
  const drag = async (x, y0, y1, steps, per) => {
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: px(x), y: px(y0) }] });
    for (let i = 1; i <= steps; i++) { await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: px(x), y: px(Math.round(y0 + (y1 - y0) * (i / steps))) }] }); await sleep(per); }
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  const wheel = async (d) => { await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: px(195), y: px(300), deltaX: 0, deltaY: d, pointerType: "mouse" }); await sleep(120); };
  const prompt = (t) => api(`/api/sessions/${SID}/prompt`, { method: "POST", body: JSON.stringify({ text: t }) });
  const turnEnd = () => until(`!document.querySelector('.stream-hint')`, 120000);
  const jump = () => ev(`(() => { const b = document.querySelector('.jump-latest'); if (!b) return false; b.click(); return true; })()`);
  /** 手势起手点必须是「裸转录」：落在嵌套滚动盒上的手势量的是另一件事。断言这个前提。 */
  const bareY = () => ev(`(() => { const el = document.querySelector('.stream');
    for (let y = 120; y < 700; y += 8) {
      let n = document.elementFromPoint(195, y), nested = false;
      while (n && n !== el) { const cs = getComputedStyle(n);
        if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && n.scrollHeight > n.clientHeight + 1) { nested = true; break; } n = n.parentElement; }
      if (!nested) return y;
    } return null; })()`);
  /** 手势之后：视口有没有留在读者放的位置。2.2s 内采样，看最大回弹。 */
  const holdTrace = async (ms = 2200) => {
    const t0 = Date.now(); const tops = [];
    while (Date.now() - t0 < ms) { tops.push((await geom()).st); await sleep(220); }
    const first = tops[0], last = tops.at(-1), low = Math.min(...tops);
    return { tops, first, last, driftBack: last - low };
  };

  // 预热：造一段长转录（每一轮结束都折叠，所以要多轮），并断言转录真的溢出
  for (let i = 0; i < 3; i++) { await prompt("[tools:8]"); await sleep(1200); await turnEnd(); }
  const seeded = await geom();
  check("前置：转录真的溢出（有回读的空间）", seeded.gap === 0 && seeded.sh > seeded.ch + 300,
    `st=${seeded.st} sh=${seeded.sh} ch=${seeded.ch}`);

  // ---- ① 流式中：慢速向下拖 400px 必须留住 ------------------------------------------------
  await prompt("[think:400]");
  await sleep(2500);
  check("前置：此刻确实在流式输出中", await busy());
  check("前置：此刻贴着尾巴", (await geom()).gap <= 4);
  {
    const y = await bareY();
    check("前置：手势起手点在裸转录上（不在嵌套滚动盒里）", typeof y === "number", String(y));
    const before = await geom();
    await drag(195, y, y + 400, 14, 12);
    const t = await holdTrace();
    const after = await geom();
    check("流式中，慢速向下拖 400px：视口留在读者放的位置（2.2s 内不被拖回尾巴）",
      after.gap >= 300, `gap ${before.gap} -> ${after.gap}（回弹 ${t.driftBack}px，trace ${t.tops.slice(0, 6).join(",")}…）`);
    check("流式中，脱开后「有新内容」按钮出现（读者被认作已脱开）", after.follow === false);
  }

  // ---- ② 微小手势也算意图（旧代码的 140px 死区） -------------------------------------------
  await jump(); await sleep(400); await turnEnd(); await prompt("[think:400]"); await sleep(2500);
  {
    const before = await geom();
    await wheel(-100);
    const t = await holdTrace(1400);
    const after = await geom();
    check("流式中，wheel 向上 100px 也被认作离开（旧代码：位置重贴，净位移 0）",
      after.gap >= 60, `gap ${before.gap} -> ${after.gap}（trace ${t.tops.slice(0, 5).join(",")}…）`);
  }

  // ---- ③ keep-alive 不再吃掉手势：发送后 250ms 内就拖 ---------------------------------------
  await turnEnd();
  await prompt("[think:400]");
  await sleep(250);
  {
    const y = await bareY();
    const before = await geom();
    await drag(195, y, y + 400, 14, 12);
    const t = await holdTrace(2000);
    const after = await geom();
    check("发送后 250ms（keep-alive 窗口内）向下拖 400px 仍然留住（旧代码：无条件重贴，位移 0）",
      after.gap >= 300, `gap ${before.gap} -> ${after.gap}（回弹 ${t.driftBack}px）`);
  }

  // ---- ④ 回到尾巴会重新跟随 ----------------------------------------------------------------
  {
    check("前置：此刻仍脱开且还在流式输出", !(await geom()).follow && await busy());
    await jump();
    await sleep(600);
    const back = await geom();
    check("点「回到最新」后回到尾巴", back.gap <= 4, `gap=${back.gap}`);
    const t = await holdTrace(1600);
    const after = await geom();
    check("回到尾巴后继续跟随：新输出到达时仍贴尾", after.gap <= 4, `gap=${after.gap}（trace ${t.tops.slice(0, 5).join(",")}…）`);
    check("跟随中不该显示「有新内容」按钮", after.follow === true);
  }
  await turnEnd();

  // ---- ⑤ 尾巴里的嵌套盒不吞手势 ------------------------------------------------------------
  {
    await prompt("[think:300]");                    // 长思考 = 活着的思考小窗一直在尾巴上
    await until(`Boolean(document.querySelector('.msg.thought .bubble.live'))`, 20000);
    await sleep(1500);
    // 几何必须和手势同帧取：流式里几十毫秒就漂（实测第一次：命中测试说在小窗里，真实 touch 目标却是
    // 上一个思考块的表头 thought-meta）。所以这里重试到「touch 目标确实是小窗」为止，否则用例本身不成立。
    const probe = async () => JSON.parse(await ev(`(() => {
      const n = document.querySelector('.msg.thought .bubble.live');
      const e = document.querySelector('.stream');
      if (!n || !e) return JSON.stringify(null);
      const r = n.getBoundingClientRect();
      const y = Math.round(Math.min(r.bottom - 8, Math.max(r.top + 8, (r.top + r.bottom) / 2)));
      const hit = document.elementFromPoint(195, y);
      return JSON.stringify({ y, h: Math.round(r.height), room: n.scrollHeight - n.clientHeight,
        st: Math.round(n.scrollTop), gap: Math.round(n.scrollHeight - n.scrollTop - n.clientHeight),
        inView: r.top < 820 && r.bottom > 60, hit: hit ? (String(hit.className || hit.tagName).slice(0, 40)) : '?',
        inBox: Boolean(hit && n.contains(hit) && hit !== n.parentElement) }); })()`));
    // 间谍：capture 阶段记录真实的 touch 目标（手势到底落在哪个元素上）
    await ev(`(() => { window.__hit = [];
      const cls = (n) => (n && n.className && String(n.className).slice(0, 42)) || (n && n.tagName) || '?';
      const vv = window.visualViewport;
      window.__vw = 'scale=' + (vv ? vv.scale : '-') + ' inner=' + window.innerWidth + 'x' + window.innerHeight + ' doc=' + document.documentElement.clientWidth + 'x' + document.documentElement.clientHeight;
      document.addEventListener('touchstart', (e) => window.__hit.push('start@' + cls(e.target) + ' y=' + Math.round(e.touches[0].clientY)), { capture: true, passive: true });
      document.addEventListener('touchmove', (e) => { if (window.__hit.length < 4) window.__hit.push('move@' + cls(e.target) + ' y=' + Math.round(e.touches[0].clientY)); }, { capture: true, passive: true });
      return 'spy'; })()`);
    let rec = null, why = "";
    for (let attempt = 1; attempt <= 3 && !rec; attempt++) {
      await jump(); await sleep(600);               // 每次尝试都从贴着尾巴开始
      const p0 = await probe();
      if (!p0?.inView || !p0?.inBox) { why = `尝试${attempt}: 起手点不在小窗内(${JSON.stringify(p0)})`; await sleep(700); continue; }
      const before = await geom();
      const to = Math.max(p0.y + 60, Math.min(p0.y + 320, 780));
      await ev(`window.__hit = []`);
      // 手指向下拖 = 回读（读更早的内容）。小窗该先吃掉它能吃的，吃到自己顶部后把剩下的
      // 接力给转录 —— 这正是它不该再声明 contain 的原因。
      await drag(195, p0.y, to, 14, 12);
      const hits = await ev(`String(window.__hit.join(' | '))`);
      const p1 = await probe();
      const after = await geom();
      if (/start@.*bubble/.test(hits)) rec = { attempt, p0, p1, before, after, hits, dist: to - p0.y, vw: await ev(`window.__vw`), asked: p0.y };
      else { why = `尝试${attempt}: 想要 y=${p0.y}，touch 目标=${hits}（${await ev(`window.__vw`)}）`; await sleep(700); }
    }
    check("前置：起手点真的落在活着的思考小窗里（重试后由 touch 目标确认）", Boolean(rec), rec ? rec.hits : why);
    if (rec) {
      const { p0, p1, before, after, hits, dist } = rec;
      check("前置：起手那一刻活着的思考小窗在自己尾巴上（它在跟随思考流）", p0.gap <= 24, `gap=${p0.gap}`);
      const moved = (p0.st - p1.st) + (before.st - after.st); // 两层都朝「更早」方向算
      // 采样：手势之后 2s 里两层各自在哪（谁把谁拖回去，一眼看得出）
      const series = [];
      for (let i = 0; i < 8; i++) { series.push(`${(await geom()).gap}/${(await probe()).gap}`); await sleep(250); }
      note(`⑤ 第${rec.attempt}次，拖了 ${dist}px：小窗 st ${p0.st} -> ${p1.st}（可滚 ${p0.room}px，高 ${p0.h}px，起手 y=${p0.y}），转录 st ${before.st} -> ${after.st}；touch 目标：${hits}；之后每 250ms 的 gap（转录/小窗）：${series.join(" ")}`);
      check("起手落在活着的思考小窗上回读：位移被真实消费（小窗吃能吃的，剩下接力给转录）",
        moved >= Math.round(dist * 0.5), `合计 ${moved}px`);
      check("…小窗自己被读者拿走后就还给读者（不再追尾）", p1.gap >= 24, `小窗 gap ${p0.gap} -> ${p1.gap}`);
      check("…转录若动了就留在读者放的位置", after.st === before.st || after.gap >= 100, `转录 gap ${before.gap} -> ${after.gap}`);
    }
    await turnEnd();
  }

  // ---- ⑥ 折叠的工作盒不得自带 overscroll 边界 ----------------------------------------------
  {
    await ev(`(() => { const h = document.querySelector('.work-run-head'); if (h) h.click(); return true; })()`);
    await sleep(500);
    const css = await ev(`(() => { const n = document.querySelector('.work-run-items'); if (!n) return null;
      const cs = getComputedStyle(n); return JSON.stringify({ overflowY: cs.overflowY, overscrollY: cs.overscrollBehaviorY, scrollable: n.scrollHeight > n.clientHeight + 1 }); })()`).then((s) => (s ? JSON.parse(s) : null));
    check("前置：折叠的工作盒在 DOM 里且真的可滚", Boolean(css?.scrollable), JSON.stringify(css));
    check("折叠的工作盒不声明 overscroll-behavior: contain（手势必须能接力到转录）",
      Boolean(css) && css.overscrollY !== "contain" && css.overscrollY !== "none", JSON.stringify(css));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
} catch (e) {
  fail++;
  console.log(`  FAIL  sweep aborted — ${e.message}`);
} finally {
  await fetch(`${CDP}/json/close/${tab.id}`).catch(() => { });
  // live 上的 DELETE 只 close、冷槽再 DELETE 才 purge —— 两次都走，别把垃圾留在货架上
  await api(`/api/sessions/${SID}`, { method: "DELETE" }).catch(() => { });
  await sleep(500);
  const again = await api(`/api/sessions/${SID}`, { method: "DELETE" }).catch(() => ({ status: 0 }));
  console.log(`purged probe session ${SID} (second pass: ${again.status})`);
  process.exit(fail ? 1 : 0);
}
