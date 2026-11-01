// 主 agent（issue #84）—— 形状、门、以及那道豁免。
//
// 这个 sweep 证的是四件事，每一条都是会在真实使用里被踩到的：
//   ① 只能由驾驶舱创建：`POST /api/main-bot` 建一次，第二次回同一个会话（created:false）。
//      没有任何「把已有会话升为主」的入口 —— 那是权限放大，操作者明确否过。
//   ② 工作空间是内置的：`<data>/main-bot`，0700，AGENTS.md 0600 且只在缺失时重建
//      （人改过的不覆盖 —— server 不写 prompt 这条红线就靠这个守住）。
//   ③ 不能归档：`main_bot_not_archivable`（400，不是 404：会话在，是动作不允许）。
//   ④ 写闸只豁免这一条：`驾驶舱互发消息` 关着的时候，主 agent 仍能派活；普通会话仍然 403。
//      这一条必须用真的两份进程环境里的 token 去调 CLI，而不是读一遍自己的代码。
//
// 自给自足：临时数据目录 + 把内置 hermes 后端临时指到 mock agent + 随机端口。
//   node scripts/qa/main-bot-sweep.mjs
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createTcp } from "node:net";
import { WebSocket } from "ws";

const ROOT = path.resolve(import.meta.dirname, "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const freePort = () => new Promise((res, rej) => {
  const s = createTcp();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});

const PORT = await freePort();
const dataDir = mkdtempSync(path.join(tmpdir(), "agentus-mainbot-"));
const emptyHome = mkdtempSync(path.join(tmpdir(), "agentus-mainbot-home-"));
const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
  detached: true,
  cwd: ROOT,
  env: {
    ...process.env, NODE_ENV: "development", HOME: emptyHome,
    AGENTUS_PORT: String(PORT), AGENTUS_DATA: dataDir, AGENTUS_AUTH: "off",
    MOCK_SLOW_MS: "30",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
proc.stdout.on("data", (d) => { log += String(d); });
proc.stderr.on("data", (d) => { log += String(d); });
const BASE = `http://127.0.0.1:${PORT}`;
const cleanup = () => { try { process.kill(-proc.pid, "SIGKILL"); } catch { /* gone */ } };
process.on("exit", cleanup);

for (let i = 0; i < 160 && !log.includes(`:${PORT}`); i++) await sleep(150);
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }

const api = async (p, init = {}) => {
  const res = await fetch(`${BASE}${p}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
};

// ---- 0. 把内置 hermes 后端临时指向 mock agent -------------------------------------------
// 主 agent 固定 backend=hermes（这是形态的一部分，不改），但 sweep 不能真起一个 hermes：
// 它要用操作者的 live home、还要几十秒。改 cmd 不改形态。
{
  const { body: rows } = await api("/api/backends");
  const hermes = (rows ?? []).find((r) => r.id === "hermes");
  check("内置 hermes 后端存在", Boolean(hermes));
  const row = {
    ...hermes, cmd: process.execPath, args: [path.join(ROOT, "packages/server/mock/agent.mjs")],
    home: null, env: [], profile: null, cwd: null,
  };
  const { status } = await api("/api/backends/hermes", { method: "PUT", body: JSON.stringify(row) });
  check("hermes 行已临时改到 mock（形态不变，只换可执行文件）", status === 200 || status === 204, `HTTP ${status}`);
}

const mainDir = path.join(dataDir, "main-bot");
const brief = path.join(mainDir, "AGENTS.md");

// ---- ① 唯一创建路径 + 幂等 ---------------------------------------------------------------
const first = await api("/api/main-bot", { method: "POST" });
check("POST /api/main-bot 建出主 agent", first.status === 201 && first.body?.created === true, `HTTP ${first.status}`);
const mainId = first.body?.session?.id ?? "";
check("回执里带 role=main", first.body?.session?.role === "main", String(first.body?.session?.role));
check("cwd 是 <data>/main-bot", first.body?.session?.cwd === mainDir, String(first.body?.session?.cwd));

const second = await api("/api/main-bot", { method: "POST" });
check("再点一次是同一个会话，不是第二个", second.body?.session?.id === mainId && second.body?.created === false,
  `${second.body?.session?.id} created=${second.body?.created}`);

const { body: all } = await api("/api/sessions");
const liveRoles = (all?.live ?? []).filter((s) => s.role === "main");
check("整份列表里 role=main 只有一条", liveRoles.length === 1, `live 里 ${liveRoles.length} 条`);
check("主 agent 没有被 system 标记藏起来（它要能被看见）", (all?.live ?? []).some((s) => s.id === mainId && s.system !== true));

// ---- ② 内置工作空间与 AGENTS.md 的生命周期 -----------------------------------------------
check("目录 <data>/main-bot 被建出来", existsSync(mainDir));
check("目录 0700（别人的账号看不见）", (statSync(mainDir).mode & 0o777) === 0o700, (statSync(mainDir).mode & 0o777).toString(8));
check("预置 AGENTS.md", existsSync(brief));
check("AGENTS.md 0600", existsSync(brief) && (statSync(brief).mode & 0o777) === 0o600,
  existsSync(brief) ? (statSync(brief).mode & 0o777).toString(8) : "missing");
const seeded = existsSync(brief) ? readFileSync(brief, "utf8") : "";
check("AGENTS.md 说清了它是什么（不是一句空话）", /Main Bot/.test(seeded) && /session send/.test(seeded), `${seeded.length} 字符`);
// 操作者 2026-11-01 明确要求：别把内部概念讲给它 —— 它只需要知道「我是 Main Bot、能干什么」，
// 不需要读一段关于「会话」的架构说明。
check("AGENTS.md 不把身份解释成「会话」（身份是恒定的，不是某条会话）",
  !/其它会话/.test(seeded) && /一直是|不随回合变/.test(seeded), seeded.split("\n")[2]?.slice(0, 40));

// 人改过的，绝不覆盖
writeFileSync(brief, "# 我自己改的\n\n别覆盖我。\n", "utf8");
await api("/api/main-bot", { method: "POST" });
check("已存在的 AGENTS.md 不会被覆盖（server 不写 prompt）", readFileSync(brief, "utf8").includes("别覆盖我"));

// 文件被删了才重建
rmSync(brief);
await api("/api/main-bot", { method: "POST" });
check("文件被删掉会重建（新装/误删不至于让 Main Bot 变成空白人格）", existsSync(brief) && /你是 \*\*Main Bot\*\*/.test(readFileSync(brief, "utf8")));

// ---- ③ 不能归档 -------------------------------------------------------------------------
{
  const { status, body } = await api(`/api/sessions/${mainId}/archive`, { method: "POST" });
  check("归档主 agent 被拒（400）", status === 400, `HTTP ${status}`);
  check("拒绝有机器可读的码", body?.code === "main_bot_not_archivable", String(body?.code));
  check("拒绝有给人看的话，而且指向正确的替代动作", /删除/.test(String(body?.error ?? "")), String(body?.error ?? "").slice(0, 40));
  const { body: after } = await api("/api/sessions");
  check("被拒之后它没被归档（拒绝不是「悄悄成功」）",
    (after?.live ?? []).some((s) => s.id === mainId) && !(after?.archived ?? []).some((s) => s.id === mainId));
}

// ---- ③b 名字是产品名，不许被 agent 或人改掉 ---------------------------------------------
// Hermes 每一轮都会重新生成会话标题并通过 `session_info_update` 送回来 —— live 上看到的就是这个：
// 名字在一轮对话之后变成了会话标题。主 agent 的名字不是「对内容的概括」，它是「你是 Main Bot」。
{
  const { status, body } = await api(`/api/sessions/${mainId}/rename`, {
    method: "POST", body: JSON.stringify({ title: "用一句话说明你是谁的会话" }),
  });
  check("重命名主 agent 被拒（400）", status === 400, `HTTP ${status}`);
  check("拒绝有机器可读的码", /main_bot_title_fixed/.test(String(body?.error ?? "")), String(body?.error ?? ""));
  const { body: still } = await api("/api/sessions");
  const row = [...(still?.live ?? []), ...(still?.cold ?? [])].find((s) => s.id === mainId);
  check("名字还是 Main Bot", row?.title === "Main Bot", String(row?.title));
}

// ---- ④ 写闸：只有主 agent 拿到豁免 ------------------------------------------------------
// 造两个普通会话：A 是被派活的目标，B 是「普通调用者」。
const mkSession = async (title) => {
  const { body } = await api("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ backend: "mock", cwd: dataDir, title }),
  });
  const id = body?.id ?? body?.session?.id ?? "";
  for (let i = 0; i < 80; i++) {
    const { body: list } = await api("/api/sessions");
    const row = (list?.live ?? []).find((s) => s.id === id);
    if (row?.status === "ready") return { id, pid: row.pid };
    await sleep(150);
  }
  return { id, pid: null };
};

const waitPid = async (id) => {
  for (let i = 0; i < 80; i++) {
    const { body: list } = await api("/api/sessions");
    const row = (list?.live ?? []).find((s) => s.id === id);
    if (row?.status === "ready" && row.pid) return row.pid;
    await sleep(150);
  }
  return null;
};

const target = await mkSession("sweep · 被派活的那个");
const caller = await mkSession("sweep · 普通调用者");
const mainPid = await waitPid(mainId);
check("主 agent 进程起来了（真的能跑，不只是登记了一行）", Boolean(mainPid), String(mainPid));

/** 从进程环境里读出驾驶舱发的身份 —— 和 agent 自己拿到的完全是同一份。 */
const identityOf = (pid) => {
  const cmd = execFileSync("ps", ["eww", "-p", String(pid), "-o", "command="], { encoding: "utf8" });
  const pick = (k) => new RegExp(`${k}=(\\S+)`).exec(cmd)?.[1] ?? "";
  return {
    endpoint: pick("AGENTUS_COCKPIT_ENDPOINT"),
    token: pick("AGENTUS_COCKPIT_TOKEN"),
    session: pick("AGENTUS_COCKPIT_SESSION"),
  };
};

// 「驾驶舱互发消息」必须真的关着，否则下面两条都在测一个开着闸的世界。
{
  const { body: prefs } = await api("/api/settings");
  // 闸门住在 `agent` 块里：顶层写 `{cockpitSend:false}` 是无效 patch（saveSettings 只认 voice
  // 那一组键），于是「前置：闸是关的」曾因为默认值本来就是 false 而假绿。
  const on = prefs?.agent?.cockpitSend === true;
  if (on) await api("/api/settings", { method: "PUT", body: JSON.stringify({ agent: { cockpitSend: false } }) });
  const { body: after } = await api("/api/settings");
  check("前置：驾驶舱互发消息是关的", after?.agent?.cockpitSend === false);
}

/** 以某个会话的 agent 身份，跑一次真正的 cockpit CLI。 */
const asAgent = (pid, args) => {
  const ident = identityOf(pid);
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, "bin/cli.mjs"), ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        AGENTUS_COCKPIT_ENDPOINT: ident.endpoint,
        AGENTUS_COCKPIT_TOKEN: ident.token,
        AGENTUS_COCKPIT_SESSION: ident.session,
        AGENTUS_COCKPIT_BIN: process.execPath,
      },
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};

{
  const mainSend = asAgent(mainPid, ["session", "send", target.id, "sweep：主 agent 派活", "--reply-on-done"]);
  check("闸关着，主 agent 仍能把活派出去", mainSend.code === 0, mainSend.out.trim().split("\n").slice(-1)[0]?.slice(0, 120));

  const plainSend = asAgent(caller.pid, ["session", "send", target.id, "sweep：普通会话派活"]);
  check("闸关着，普通会话照样被拒", plainSend.code !== 0, `exit ${plainSend.code}`);
  check("被拒的原因是 sends_disabled（不是别的意外）", /sends_disabled/.test(plainSend.out), plainSend.out.trim().slice(0, 120));

  const mainSession = identityOf(mainPid).session;
  check("主 agent 手里的身份就是它自己那一条", mainSession === mainId, mainSession);
}

// 派出去的东西必须真的落到目标会话里，而不是「CLI 说成功了」。
{
  let found = false;
  for (let i = 0; i < 40 && !found; i++) {
    const { body } = await api(`/api/sessions/${target.id}/messages`);
    const text = JSON.stringify(body ?? "");
    found = text.includes("主 agent 派活");
    if (!found) await sleep(200);
  }
  check("派活的内容真的进了目标会话的转录", found);

  const { body } = await api(`/api/sessions/${target.id}/messages`);
  check("普通会话那条没进去（只拒了回执，没有半成功）", !JSON.stringify(body ?? "").includes("普通会话派活"));
}

// ---- ④b. role 必须活过「进程重启」和「冷下来」两端 ---------------------------------------
// 「主 agent」是行上的一个事实（`role='main'`，只在 insert 时写一次），而 rail 读的是
// `list()`/`cold()` 造出来的 info。这两条路径**都能在重启里把 role 丢掉**：
//   · resume/restart 重建内存里的 info（原来只从 row 抄了 system）；
//   · 冷行走 #infoFromRow（同样只抄了 system）。
// 丢掉的后果不是「有点怪」，而是整条身份塌掉：顶部换回「创建 Main Bot」，真正的主 agent
// 掉进工作空间分组，而 `ensureMainBot()` 再按一次还回同一个会话 —— 操作者看到的正是
// 「又让我建、建了又跳到旧的、旧的还在下面列表里」（2026-11-01 live 实测）。
{
  const before = await waitPid(mainId);
  const { status } = await api(`/api/sessions/${mainId}/restart`, { method: "POST" });
  const after = await waitPid(mainId);
  check("restart 换掉了进程（同一个会话、新 pid）", status === 200 && Boolean(after) && after !== before, `${before} -> ${after}`);
  const { body } = await api("/api/sessions");
  const row = (body?.live ?? []).find((s) => s.id === mainId);
  check("★ 进程重启之后 role 还是 main（重建的 info 从行里带回来）", row?.role === "main", String(row?.role));
}
{
  // 冷行：把进程真正收掉（cockpit close 走 closeSession，槽位离开内存 map），此后 rail 读的是
  // store 里那一行 —— 也就是 `#infoFromRow`。只杀进程是不够的：崩溃的槽位仍留在 map 里，
  // 走的还是内存 info，那一半什么也证不出来。
  // 收进程这条命令走驾驶舱通道，闸门关着时会被拒 —— 这里临时开一下，用完立刻恢复。
  const { body: prefs } = await api("/api/settings");
  const gateOn = prefs?.agent?.cockpitSend === true;
  if (!gateOn) await api("/api/settings", { method: "PUT", body: JSON.stringify({ agent: { cockpitSend: true } }) });
  const closed = asAgent(caller.pid, ["session", "stop", mainId, "--close"]);
  if (!gateOn) await api("/api/settings", { method: "PUT", body: JSON.stringify({ agent: { cockpitSend: false } }) });
  check("收进程的请求被接受（session stop --close）", closed.code === 0,
    closed.out.trim().split("\n").slice(-1)[0]?.slice(0, 100));
  let coldRow = null;
  for (let i = 0; i < 100; i++) {
    const { body } = await api("/api/sessions");
    const live = (body?.live ?? []).find((s) => s.id === mainId);
    coldRow = (body?.cold ?? []).find((s) => s.id === mainId) ?? null;
    if (!live && coldRow) break;
    await sleep(150);
  }
  check("★ 进程没了之后冷行里 role 还是 main（否则它会掉进工作空间分组）", coldRow?.role === "main", String(coldRow?.role));
  const { status } = await api(`/api/sessions/${mainId}/resume`, { method: "POST" });
  const back = await waitPid(mainId);
  const { body } = await api("/api/sessions");
  const liveRow = (body?.live ?? []).find((s) => s.id === mainId);
  check("冷行 resume 回来还是 role=main（id 没变、身份没变）",
    (status === 200 || status === 204) && Boolean(back) && liveRow?.id === mainId && liveRow?.role === "main",
    `HTTP ${status} pid=${back} role=${liveRow?.role}`);
}

// ---- ⑤ 真页面：它在最顶上的一行，而且只有一行 -------------------------------------------
// REST 说清了「有这一条、它是 main」；只有真页面能回答「它出现在哪里、长什么样、菜单里有没有
// 一个按了会 400 的选项」。这一段用操作员自己的 Edge（CDP），连不上就跳过，不伪装成通过。
const CDP = process.env.CDP ?? "http://127.0.0.1:9223";
{
  let ws = null;
  try {
    const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
    ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let mid = 0;
    const waiting = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      const w = waiting.get(m.id);
      if (w) { waiting.delete(m.id); m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result); }
    };
    const send = (method, params = {}) => new Promise((res, rej) => {
      const id = ++mid;
      const t = setTimeout(() => { waiting.delete(id); rej(new Error(`TIMEOUT ${method}`)); }, 25000);
      waiting.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const ev = async (expr) => {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
      return r.result.value;
    };
    // SPA + WS 首帧：给它一点时间把 rail 画完
    await sleep(3000);

    check("页面里主 agent 有一行", await ev(`document.querySelectorAll('.rail-main-bot .session-item').length === 1`));
    check("★ 星标在行上（身份标识，不是收藏）", await ev(`!!document.querySelector('.rail-main-bot .main-star')`));
    check("这一行没有目录头（不是一个工作空间）", await ev(`!document.querySelector('.rail-main-bot .rail-group-head')`));
    check("行上写的就 是 Main Bot（不是会话名）", await ev(`document.querySelector('.rail-main-bot .session-item .title')?.textContent?.trim() === 'Main Bot'`),
      await ev(`document.querySelector('.rail-main-bot .session-item .title')?.textContent?.trim()`));
    // 操作者：「缩进也不对啊，不需要缩进啊，顶着左边就好」，随后给了判据：「对齐 Search sessions
    // 那个搜索框吗，平齐」。所以量的是几何：行的盒左缘 vs 搜索框盒左缘，差 ≤ 1px。
    // 只查 session-item 自己的 padding 是不够的 —— 真正的缩进来自父级 `.rail-group-body`
    // 的 28px（它给所有目录里的行让出目录图标的宽度），主 agent 不属于任何目录。
    const geo = await ev(`(() => {
      const row = document.querySelector('.rail-main-bot .session-item');
      const box = document.querySelector('.rail-search-wrap');
      if (!row || !box) return null;
      const grp = document.querySelector('.rail-main-bot');
      const body = grp && grp.querySelector('.rail-group-body');
      return { row: row.getBoundingClientRect().left, box: box.getBoundingClientRect().left,
               pad: parseFloat(getComputedStyle(row).paddingLeft),
               grp: grp ? grp.getBoundingClientRect().left : null,
               grpML: grp ? parseFloat(getComputedStyle(grp).marginLeft) : null,
               body: body ? body.getBoundingClientRect().left : null,
               bodyPL: body ? parseFloat(getComputedStyle(body).paddingLeft) : null,
               listPL: grp && grp.parentElement ? parseFloat(getComputedStyle(grp.parentElement).paddingLeft) : null };
    })()`);
    check("左缘与「Search sessions」平齐（≤1px）", Boolean(geo) && Math.abs(geo.row - geo.box) <= 1,
      geo ? "row=" + geo.row.toFixed(1) + " search=" + geo.box.toFixed(1) + " delta=" + (geo.row - geo.box).toFixed(1)
        + " (" + JSON.stringify(geo) + ")" : "not found");
    check("这一行不画后端头像（只有 ★ 和名字）", await ev(`!document.querySelector('.rail-main-bot .be-avatar')`));
    check("★ 就在名字前", await ev(`(() => {
      const t = document.querySelector('.rail-main-bot .session-item .title');
      return !!t && t.firstElementChild?.classList.contains('main-star') === true;
    })()`));
    check("它排在「团队」之前（真·最上面一行）", await ev(`(() => {
      const row = document.querySelector('.rail-main-bot');
      const team = document.querySelector('[data-section="team"]');
      return !!row && !!team && Boolean(row.compareDocumentPosition(team) & Node.DOCUMENT_POSITION_FOLLOWING);
    })()`));
    check("它没有同时出现在工作空间分组里（同一个东西只出现一次）", await ev(
      `document.querySelectorAll('.rail-group:not(.rail-main-bot) .session-item[data-session="${mainId}"]').length === 0`));

    // 会话头部（聊天区顶部）：主 agent 这里也不显示会话名 —— 名字是产品名，且 agent 每轮都会
    // 通过 session_info_update 把标题改回它自己生成的那个。带 ★，与 rail 那一行是同一件事。
    check("点头部标题前：先打开主 agent 这一行", await ev(`(() => {
      const row = document.querySelector('.rail-main-bot .session-item');
      if (!row) return false;
      row.click();
      return true;
    })()`));
    await sleep(1500);
    const headText = await ev(`document.querySelector('.chat-head .title')?.textContent?.trim() ?? ''`);
    check("★ 会话头部写的是 Main Bot（不是会话名）", headText === "Main Bot", headText.slice(0, 40));
    check("★ 头部那行带星标", await ev(`!!document.querySelector('.chat-head .title .main-star')`));
    check("头部没有退化成 DB 里的旧标题", await ev(
      `(document.querySelector('.chat-head .title')?.textContent ?? '').indexOf(${JSON.stringify("Friendly greeting")}) === -1`));

    // ⋯ 菜单：不能有「归档会话」（服务端会 400，菜单不该提供一个按了就错的按钮）
    await ev(`(() => {
      const btn = document.querySelector('.rail-main-bot .session-item .row-menu');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    await sleep(300);
    const menuText = await ev(`document.querySelector('.sess-menu')?.innerText ?? ''`);
    check("菜单打开了", menuText.length > 0, menuText.replace(/\n/g, " / ").slice(0, 80));
    check("菜单里没有「归档会话」", !/归档会话/.test(menuText), menuText.replace(/\n/g, " / ").slice(0, 80));
    check("菜单里还有能用的动作（不是整块被砍掉）", /重启 agent 进程/.test(menuText) && /导出会话/.test(menuText));
    check("菜单里也没有「重命名」（名字是产品名）", !/重命名/.test(menuText) && !/重新生成会话名/.test(menuText));
    await ev(`document.body.click()`);
  } catch (e) {
    console.log(`SKIP  真页面段（连不上 Edge CDP ${CDP}：${String(e.message ?? e).slice(0, 60)}）`);
  } finally {
    try { ws?.close(); } catch { /* already gone */ }
  }
}

// ---- ⑥ 删掉 = 彻底消失；按钮能从零再建一个 ---------------------------------------------
// 「不可归档」的另一半是「要就重建」：删除是唯一的下场，删完 rail 顶部换成那个创建按钮，
// 按一下就该有一个新的（不是复活旧的）。这一条也只有真页面能证。
{
  const del1 = await api(`/api/sessions/${mainId}`, { method: "DELETE" });
  const del2 = await api(`/api/sessions/${mainId}`, { method: "DELETE" });
  check("删除分两步走完（先收进程，再清记录）", del1.status === 200 && del2.status === 200, `${del1.status}/${del2.status}`);
  const { body: gone } = await api("/api/sessions");
  const stillThere = [...(gone?.live ?? []), ...(gone?.cold ?? []), ...(gone?.archived ?? [])].some((s) => s.id === mainId);
  check("删掉之后整份列表里都没有它了", !stillThere);

  const rebuilt = await api("/api/main-bot", { method: "POST" });
  check("删掉之后还能再建一个（新的 id，不是复活旧的）",
    rebuilt.status === 201 && rebuilt.body?.created === true && rebuilt.body?.session?.id !== mainId,
    `${rebuilt.body?.session?.id} vs ${mainId}`);
  check("重建的仍然是 role=main 且住在同一个内置目录",
    rebuilt.body?.session?.role === "main" && rebuilt.body?.session?.cwd === mainDir);
}

// ---- 收尾 ------------------------------------------------------------------------------
const { body: final } = await api("/api/sessions");
check("主 agent 全程没有被归档、也没有重复", (final?.live ?? []).filter((s) => s.role === "main").length === 1);

console.log(`\n${pass} passed, ${fail} failed`);
cleanup();
process.exit(fail ? 1 : 0);
