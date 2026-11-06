// 定时作业面板的真页面证据（issue #92 / v0.19.1）。
//
// 这个面板的价值全在「点下去真的动到了 hermes 的作业」，所以断言分两半：
//   ① 页面画对了（行数/调度/状态/详情/历史/账本），且这些数字与 `/api/cron` 一致；
//   ② 四个动作真的穿过 CLI 落到了 jobs.json —— 用**一个临时 HERMES_HOME**（/tmp/agentus-cron-qa）
//      承载作业，所以这份 sweep 一个字节也碰不到操作者自己的 cron。
//
// 临时 home 通过 POST /api/backends 建成一行 `cron-qa`，页面用 `?cronBackend=cron-qa` 钉到它 ——
// 这正是那个 query 参数存在的理由（QA 与多 profile 切换）。
//
//   AGENTUS_BASE=http://127.0.0.1:8901 CDP_URL=http://127.0.0.1:9223 node scripts/qa/cron-board-dom.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";
const BASE = process.env.AGENTUS_BASE || "http://127.0.0.1:8901";
const USER = process.env.AGENTUS_USER || "scratch";
const PASS = process.env.AGENTUS_PASS || "scratch-pass-1";
const QA_HOME = process.env.CRON_QA_HOME || "/tmp/agentus-cron-qa";
const QA_BACKEND = "cron-qa";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// ---- ① 临时 home：两个作业（一个正常、一个暂停） --------------------------------------------
//
// 造作业必须用**后端行自己那个 hermes 二进制**，不是 PATH 上的 `hermes` —— 这台机 PATH 首个
// `~/Project/hermes-agent/.hermes/bin/hermes` 缺 ruamel，跑不了 CLI（`backend-smoke` 的老毛病），
// 而驾驶舱 spawn 用的是 installs 下那份 venv 里的 hermes。拿错二进制会让整份 sweep 假红。
fs.rmSync(QA_HOME, { recursive: true, force: true });
fs.mkdirSync(path.join(QA_HOME, "cron"), { recursive: true });
const QA_DATA = process.env.AGENTUS_DATA || "/tmp/agentus-qa-account";
let hermesCmd = "hermes";
let hermesArgs = ["acp"];
// 服务器可能刚被 tsx watch 重启过（这份 sweep 本身就会碰服务端文件），先等它起来。
// 鉴权走**登录会话的 cookie**，和浏览器后面做的那次登录同一条路 —— Bearer 是服务端给脚本用的
// 另一套，两套混用会让你在「401 但 curl 明明通」上耗掉半小时。
let cookie = "";
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: USER, password: PASS }),
    });
    if (r.ok) {
      cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
      break;
    }
  } catch { /* not up yet */ }
  await sleep(500);
}
check("脚本侧登录（拿 cookie）", Boolean(cookie));
try {
  const raw = await fetch(`${BASE}/api/backends`, { headers: { cookie } }).then((r) => r.json());
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.backends) ? raw.backends : [];
  const tpl = rows.find((r) => r.kind === "hermes");
  if (tpl?.cmd) hermesCmd = tpl.cmd;
  if (Array.isArray(tpl?.args)) hermesArgs = tpl.args;
} catch (e) {
  console.log("note: could not read backend rows —", String(e?.message || e).slice(0, 120));
}
console.log(`using hermes cli: ${hermesCmd}`);
const hermes = (args) => execFileSync(hermesCmd, args, {
  env: { ...process.env, HERMES_HOME: QA_HOME },
  encoding: "utf8", timeout: 90_000,
});
const created = [];
try {
  hermes(["cron", "create", "0 9 * * *", "QA：每日巡检（sweep 造，跑完即删）", "--name", "QA 每日巡检", "--deliver", "local"]);
  hermes(["cron", "create", "every 30m", "QA：暂停中的作业", "--name", "QA 暂停作业", "--deliver", "local", "--paused", "--paused-reason", "sweep"]);
  const doc = JSON.parse(fs.readFileSync(path.join(QA_HOME, "cron", "jobs.json"), "utf8"));
  doc.jobs.forEach((j) => created.push(j.id));
} catch (e) {
  console.log("FAIL  造 QA 作业  —", String(e?.stderr || e?.message || e).slice(0, 300));
  fail++;
}
check("临时 home 里造出两个作业", created.length === 2, created.join(","));

// 执行历史：把操作者真库的一份副本放进去，让「历史区」在页面里真的有东西可画。
const realDb = path.join(process.env.HOME || "", ".hermes", "cron", "executions.db");
if (fs.existsSync(realDb)) fs.copyFileSync(realDb, path.join(QA_HOME, "cron", "executions.db"));
check("执行历史样本就位（真库副本）", fs.existsSync(path.join(QA_HOME, "cron", "executions.db")));

// ---- ② 浏览器 -------------------------------------------------------------------------------
const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(1500);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const waiting = new Map(); const exceptions = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") exceptions.push(m.params.exceptionDetails.text);
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
const goto = async (url) => { await send("Page.navigate", { url }); await sleep(2800); };

await send("Runtime.enable");
await goto(BASE);
const status = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({username:${JSON.stringify(USER)},password:${JSON.stringify(PASS)}})}).then(r=>r.status)`);
check("logged in", status === 200, `status ${status}`);
await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 950, deviceScaleFactor: 1, mobile: false });

// 建一行 backend，指向临时 home（跑完删掉）
// 上一次跑崩可能留下这一行（409 会让后面所有断言假红）—— 先删掉再建，脚本可重复执行
await ev(`fetch('/api/backends/${QA_BACKEND}', { method: 'DELETE' }).then(r => r.status)`);
const reg = await ev(`(async () => {
  const rows = await fetch('/api/backends').then(r => r.json()).then(j => j.backends || j);
  const tpl = (rows || []).find(r => r.kind === 'hermes') || {};
  const r = await fetch('/api/backends', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: ${JSON.stringify(QA_BACKEND)}, label: 'Cron QA', kind: 'hermes',
      cmd: ${JSON.stringify(hermesCmd)}, args: ${JSON.stringify(hermesArgs)}, env: {}, home: ${JSON.stringify(QA_HOME)}, profile: '' }) });
  return r.status + ':' + (await r.text()).slice(0, 200);
})()`);
check("注册临时 backend 行", /^20[01]:/.test(String(reg)), String(reg).slice(0, 160));

await goto(`${BASE}/?cronBackend=${QA_BACKEND}`);

// ① 入口在 head，点开是替换主区的面板
const entry = await ev(`(() => { const b = document.querySelector('[data-nav="cron"]'); return b ? b.getBoundingClientRect().width > 0 : false; })()`);
check("rail 上有定时任务入口（#94 搬过去的）", entry === true);
await ev(`document.querySelector('[data-nav="cron"]').click()`);
await sleep(1200);
const shape = JSON.parse(await ev(`JSON.stringify((() => {
  const p = document.querySelector('[data-cron-panel]');
  return p ? { panel: true, w: Math.round(p.getBoundingClientRect().width), chat: !!document.querySelector('.chat-col') } : { panel: false };
})())`));
check("点开后是替换主区的面板（不是浮层）", shape.panel === true && shape.chat === false, JSON.stringify(shape));

// ② 行数与 `/api/cron` 一致，且字段真是 Hermes 的那份
const api = JSON.parse(await ev(`fetch('/api/cron?backend=${QA_BACKEND}').then(r => r.json()).then(j => JSON.stringify(j))`));
check("API 可用且两个作业都在", api.available === true && (api.jobs || []).length === 2, `available=${api.available} n=${(api.jobs || []).length}`);
const rows = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-cron-job]')].map(tr => ({
  id: tr.getAttribute('data-cron-job'), tone: tr.getAttribute('data-tone'),
  text: tr.innerText.replace(/\\s+/g, ' ')
})))`));
check("页面行数 == API 行数", rows.length === 2, `rows=${rows.length}`);
const daily = rows.find((r) => r.id === created[0]) || {};
const pausedRow = rows.find((r) => r.id === created[1]) || {};
check("正常作业显示 cron 表达式原文", /0 9 \* \* \*/.test(daily.text || ""), daily.text?.slice(0, 90));
check("暂停的作业被画成 idle（不是 ok/error）", pausedRow.tone === "idle", `tone=${pausedRow.tone}`);
check("暂停原因来自 Hermes（paused_reason 透出）", /paused/.test(pausedRow.text || ""), pausedRow.text?.slice(0, 90));

// ③ 展开详情
await ev(`document.querySelector('[data-cron-job="${created[0]}"] .cron-name').click()`);
await sleep(500);
const detail = await ev(`(() => { const d = document.querySelector('[data-cron-detail="${created[0]}"]'); return d ? d.innerText.replace(/\\s+/g,' ').slice(0, 200) : ''; })()`);
check("点名字展开详情（调度/重复/投递）", /调度/.test(detail) && /重复/.test(detail) && /投递/.test(detail), detail.slice(0, 120));

// ④ 历史与失败账本
const runRows = await ev(`document.querySelectorAll('[data-cron-run]').length`);
const incRows = await ev(`document.querySelectorAll('[data-cron-incident]').length`);
check("执行历史区画出了记录", runRows > 0, `${runRows} 条`);
check("失败账本区画出了记录", incRows > 0, `${incRows} 条`);

// ⑤ 暂停 → 真的落到 jobs.json
const stateOf = (jid) => {
  const doc = JSON.parse(fs.readFileSync(path.join(QA_HOME, "cron", "jobs.json"), "utf8"));
  return (doc.jobs.find((j) => j.id === jid) || {}).state;
};
await ev(`document.querySelector('[data-cron-job="${created[0]}"] [aria-label^="暂停"]').click()`);
let pausedOk = false;
for (let i = 0; i < 24 && !pausedOk; i++) { await sleep(250); pausedOk = stateOf(created[0]) === "paused"; }
check("点「暂停」真把 Hermes 的作业改了（jobs.json state=paused）", pausedOk, `state=${stateOf(created[0])}`);
// 回执是 fetch 回来才渲染的；等它出现，别在点击后立刻读（第一版就是这么假红的）
let ack = "";
for (let i = 0; i < 24 && !/pause/.test(ack); i++) {
  await sleep(250);
  ack = await ev(`(() => { const a = document.querySelector('[data-cron-ack]'); return a ? a.innerText : ''; })()`);
}
check("回执贴出 CLI 自己那句话", /Paused job|pause/.test(ack), ack.slice(0, 90));

// ⑥ 恢复
// 暂停成功后那一行会重绘成「恢复」按钮 —— 等它真出现再点，否则点到的还是旧的「暂停」，
// 于是又 pause 一次（第一版就是这么假红的：ack 说 Paused，state 没回来）
let resumeBtn = false;
for (let i = 0; i < 24 && !resumeBtn; i++) {
  await sleep(250);
  resumeBtn = await ev(`!!document.querySelector('[data-cron-job="${created[0]}"] [aria-label^="恢复"]')`);
}
check("暂停后按钮翻成「恢复」", resumeBtn === true);
await ev(`document.querySelector('[data-cron-job="${created[0]}"] [aria-label^="恢复"]').click()`);
let resumedOk = false;
for (let i = 0; i < 24 && !resumedOk; i++) { await sleep(250); resumedOk = stateOf(created[0]) !== "paused"; }
check("点「恢复」把它改回可调度状态", resumedOk, `state=${stateOf(created[0])}`);

// ⑦ 删除（会弹确认框 —— 覆盖 window.confirm）
await ev(`window.confirm = () => true`);
await ev(`document.querySelector('[data-cron-job="${created[1]}"] [aria-label^="删除"]').click()`);
let removedOk = false;
for (let i = 0; i < 24 && !removedOk; i++) {
  await sleep(250);
  const doc = JSON.parse(fs.readFileSync(path.join(QA_HOME, "cron", "jobs.json"), "utf8"));
  removedOk = !doc.jobs.some((j) => j.id === created[1]);
}
check("点「删除」真把作业从 Hermes 侧删掉", removedOk);
let rowsAfter = 2;
for (let i = 0; i < 24 && rowsAfter !== 1; i++) {
  await sleep(250);
  rowsAfter = await ev(`document.querySelectorAll('[data-cron-job]').length`);
}
check("删完页面只剩一行", rowsAfter === 1, `rows=${rowsAfter}`);

// ⑧ 窄屏不横向溢出（390px，手机档把「下次」列让掉）
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 780, deviceScaleFactor: 2, mobile: true });
await sleep(800);
const narrow = JSON.parse(await ev(`JSON.stringify((() => {
  const p = document.querySelector('[data-cron-panel]');
  return { overflow: p ? p.scrollWidth - p.clientWidth : -1, w: p ? p.clientWidth : 0 };
})())`));
check("390px 下面板不横向溢出", narrow.overflow <= 1, JSON.stringify(narrow));

// ⑨ Esc 退出面板
await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 950, deviceScaleFactor: 1, mobile: false });
await sleep(400);
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
await sleep(700);
const gone = await ev(`!document.querySelector('[data-cron-panel]') && !!document.querySelector('.chat-col')`);
check("Esc 退出面板回到会话页", gone === true);
check("页面无 JS 异常", exceptions.length === 0, exceptions.slice(0, 2).join(" | "));

// ---- 清理 -----------------------------------------------------------------------------------
try {
  await ev(`fetch('/api/backends/${QA_BACKEND}', { method: 'DELETE' }).then(r => r.status)`);
} catch { /* tab may be gone */ }
fs.rmSync(QA_HOME, { recursive: true, force: true });
console.log(`\n${fail ? "FAIL" : "ALL"} — ${pass} passed, ${fail} failed`);
try { await fetch(`${CDP}/json/close/${tab.id}`); } catch {}  // 别把页面留在浏览器里（堆到几百个会把整台机器拖死）
ws.close();
process.exit(fail ? 1 : 0);
