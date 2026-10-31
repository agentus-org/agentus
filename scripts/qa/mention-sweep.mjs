// @ 跨工作空间转交，在真浏览器里走一遍（不是只看单测）。
//
// 单测证明了"哪一行排第一、过滤后剩谁、退格带走多少"；这里证明的是另外三件只有真页面才能回答的事：
//   · 打 `@` 真的弹出工作空间，**当前空间在第一行**并被标出来；
//   · 选完空间，同一个弹层立刻换成「新会话 + 该空间的会话」，回车选中后输入框里出现一枚胶囊；
//   · 回车发送后，目标工作空间里真的多了一个会话，它的第一条消息是信封 + 操作员那句话。
//
// 自给自足：自己的 Agentus（mock 后端）、自己建的临时数据目录、操作员的 Edge（CDP :9222）。
//   node scripts/qa/mention-sweep.mjs
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createTcp } from "node:net";
import { WebSocket } from "ws";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CDP = process.env.CDP ?? "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const killGroup = (target) => {
  const pid = typeof target === "number" ? target : target?.pid;
  if (!pid) return;
  try { process.kill(-pid, "SIGKILL"); } catch { try { killGroup(pid); } catch { /* gone */ } }
};
const CHILDREN = new Set();
process.on("exit", () => { for (const c of CHILDREN) { try { killGroup(c); } catch { /* gone */ } } });

const freePort = () => new Promise((res, rej) => {
  const s = createTcp();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});

const PORT = await freePort();
const dataDir = mkdtempSync(path.join(tmpdir(), "agentus-mention-"));
const emptyHome = mkdtempSync(path.join(tmpdir(), "agentus-mention-home-"));
const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
  detached: true,
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: "development", HOME: emptyHome, AGENTUS_PORT: String(PORT), AGENTUS_DATA: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
});
CHILDREN.add(proc);
let log = "";
proc.stdout.on("data", (d) => { log += String(d); });
proc.stderr.on("data", (d) => { log += String(d); });
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 120 && !log.includes(`0.0.0.0:${PORT}`); i++) await sleep(150);
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }

const token = readFileSync(path.join(dataDir, "auth.token"), "utf8").trim();
/** /api/sessions 的形状是 {live, cold, archived} —— 名字撞过的坑，记在这儿。 */
const allSessions = (r) => [...(r?.live ?? []), ...(r?.cold ?? []), ...(r?.archived ?? [])];
const api = async (p, init = {}) => {
  const res = await fetch(`${BASE}${p}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  return res.status === 204 ? null : res.json().catch(() => null);
};

// Two workspaces, one session each — the shape the operator described (排查在一个空间，修复在另一个).
const wsA = mkdtempSync(path.join(tmpdir(), "mention-dev-"));
const wsB = mkdtempSync(path.join(tmpdir(), "mention-fix-"));
const idA = await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "mock", cwd: wsA, title: "排查问题" }) });
const idB = await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "mock", cwd: wsB, title: "修复问题" }) });
const srcA = idA?.id, srcB = idB?.id; // POST 回的是整个会话对象，别把对象当 id 用（第一版就这么错的）
for (const id of [srcA, srcB]) {
  for (let i = 0; i < 60; i++) {
    const rows = await api("/api/sessions");
    const row = allSessions(rows).find((s) => s.id === id);
    if (row && !row.cold && row.status === "ready") break;
    await sleep(250);
  }
}
const nameOf = (p) => p.split("/").filter(Boolean).pop();
let rowsCache = null;

// ------------------------------------------------------------------ browser
const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(2600);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let mid = 0;
const waiting = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  const w = waiting.get(m.id);
  if (w) { waiting.delete(m.id); m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result); }
};
const send = (method, params = {}, to = 25000) => new Promise((res, rej) => {
  const id = ++mid;
  const timer = setTimeout(() => { waiting.delete(id); rej(new Error(`TIMEOUT ${method}`)); }, to);
  waiting.set(id, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expr, to = 25000) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, to);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};
const key = async (k, code = k, vk = 13) => {
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  }
  await sleep(120);
};
const type = async (text) => { await send("Input.insertText", { text }); await sleep(180); };

/** 坐标无关的点击：找到**内容最短**的那个包含目标文字的可行元素（最内层那一行）。 */
const clickText = (needle, scope = ".rail-group") => ev(`(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(scope)} + ' button, ' + ${JSON.stringify(scope)} + ' [role="button"], ' + ${JSON.stringify(scope)} + ' div')];
  const hit = els.filter((e) => (e.textContent || "").includes(${JSON.stringify(needle)}))
    .sort((a, b) => (a.textContent || "").length - (b.textContent || "").length)[0];
  if (!hit) return false;
  hit.click();
  return true;
})()`);

try {
  // 登录：这个 sweep 自己起的实例，口令是服务器的内置默认值（用户名框预填 admin，别叠加）。
  await sleep(2500);
  if (await ev(`!!document.querySelector('input[type=password]')`)) {
    const userField = `document.querySelector('input[autocomplete=username]')`;
    await ev(`${userField}.focus()`);
    await ev(`${userField}.select()`);
    await send("Input.insertText", { text: process.env.SWEEP_USER ?? "admin" });
    await ev(`document.querySelector('input[type=password]').focus()`);
    await send("Input.insertText", { text: process.env.SWEEP_PASS ?? "123456" });
    await ev(`document.querySelector('.auth-btn')?.click()`);
    await sleep(3000);
  }
  check("logged in (the composer is there)", await ev(`!!document.querySelector('.composer-box textarea')`) === true);

  // 回到会话 A（页面默认打开最近那个，不一定是 A）。
  const opened = await ev(`(() => {
    const hit = [...document.querySelectorAll('.session-item')]
      .find((r) => r.querySelector('.title')?.textContent?.trim() === "排查问题");
    if (!hit) return false;
    hit.click();
    return true;
  })()`);
  check("session A opens from the rail", opened === true);
  await sleep(1800);

  // Type @ → the workspace palette.
  await ev(`document.querySelector('.composer-box textarea')?.focus()`);
  await type("@");
  const stage1 = await ev(`(() => {
    const box = document.querySelector('.mention-palette');
    if (!box) return null;
    const rows = [...box.querySelectorAll('.mention-item')].map((r) => ({
      ws: r.querySelector('.mention-ws')?.textContent ?? '',
      name: r.querySelector('.mention-name')?.textContent ?? '',
      current: !!r.querySelector('.src'),
    }));
    return { head: box.querySelector('.mention-head')?.textContent ?? '', rows };
  })()`);
  check("typing @ opens the workspace palette", stage1 !== null, JSON.stringify(stage1?.rows?.map((r) => r.name)));
  check("the workspace you are standing in is the FIRST row and marked 当前",
    stage1?.rows?.[0]?.name === nameOf(wsA) && stage1?.rows?.[0]?.current === true,
    JSON.stringify(stage1?.rows?.[0]));

  // Pick that same workspace (it must be offered: 用户要求支持当前空间), so the second stage lists wsA.
  await key("Enter", "Enter", 13);
  const stage2 = await ev(`(() => {
    const box = document.querySelector('.mention-palette');
    if (!box) return null;
    const rows = [...box.querySelectorAll('.mention-item')].map((r) => ({
      ws: r.querySelector('.mention-ws')?.textContent ?? '',
      name: r.querySelector('.mention-name')?.textContent ?? '',
      isNew: r.classList.contains('is-new'),
    }));
    return { head: box.querySelector('.mention-head')?.textContent ?? '', rows };
  })()`);
  check("picking a workspace switches the SAME palette to its targets", stage2 !== null && /会话/.test(stage2.head), stage2?.head);
  check("the first target row is 新会话", stage2?.rows?.[0]?.isNew === true && stage2?.rows?.[0]?.name === "新会话", JSON.stringify(stage2?.rows?.[0]));

  // Pick 新会话, then write the sentence.
  await key("Enter", "Enter", 13);
  const afterPick = await ev(`(() => {
    const ta = document.querySelector('.composer-box textarea');
    return { value: ta?.value ?? '', chip: document.querySelector('.mention-chip')?.textContent ?? null,
             chipBg: (() => { const c = document.querySelector('.mention-chip'); if (!c) return null;
               const s = getComputedStyle(c); return { bg: s.backgroundColor, radius: s.borderTopLeftRadius }; })() };
  })()`);
  check("the pick lands as a token in the composer", (afterPick.value ?? "").startsWith(`@${nameOf(wsA)} › 新会话`), afterPick.value);
  check("the token is DRAWN as a block (mirror chip exists, non-transparent background)",
    afterPick.chip !== null && afterPick.chipBg && afterPick.chipBg.bg !== "rgba(0, 0, 0, 0)", JSON.stringify(afterPick.chipBg));
  const paint = await ev(`(() => {
    const ta = document.querySelector('.composer-box textarea');
    return { color: getComputedStyle(ta).color, caret: getComputedStyle(ta).caretColor,
             tokenized: ta.classList.contains('tokenized'), mirror: !!document.querySelector('.composer-mirror') };
  })()`);
  check("the textarea's own glyphs are hidden (transparent colour, caret kept) so only the chip reads",
    paint.tokenized === true && paint.color === "rgba(0, 0, 0, 0)" && paint.mirror === true, JSON.stringify(paint));

  // 两层（透明 textarea + 画胶囊的镜像）必须用同一套字体度量。字一旦不同，换行位置就不同，
  // 胶囊会叠到别的字上面 —— 这是这套方案唯一的软肋，所以两种宽度都比一遍（手机那条 CSS 曾经漏改过）。
  const metrics = async () => ev(`(() => {
    const ta = document.querySelector('.composer-box textarea');
    const mi = document.querySelector('.composer-mirror');
    if (!ta || !mi) return null;
    const a = getComputedStyle(ta), b = getComputedStyle(mi);
    return { ta: { pad: a.padding, size: a.fontSize, fam: a.fontFamily, lh: a.lineHeight, ls: a.letterSpacing },
             mi: { pad: b.padding, size: b.fontSize, fam: b.fontFamily, lh: b.lineHeight, ls: b.letterSpacing },
             chipInside: (() => {
               const c = document.querySelector('.mention-chip');
               if (!c) return false;
               const cr = c.getBoundingClientRect(), br = ta.getBoundingClientRect();
               return cr.left >= br.left - 1 && cr.right <= br.right + 1 && cr.top >= br.top - 1 && cr.bottom <= br.bottom + 1;
             })() };
  })()`);
  const desk = await metrics();
  check("the mirror uses the same font metrics as the textarea (desktop)",
    desk && JSON.stringify(desk.ta) === JSON.stringify(desk.mi), JSON.stringify({ ta: desk?.ta, mi: desk?.mi }));
  check("the chip is drawn inside the box, not floating outside it", desk?.chipInside === true);

  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(600);
  const phone = await metrics();
  check("…and still does it at phone width (the 16px rule)", phone && phone.ta.size === phone.mi.size,
    JSON.stringify({ ta: phone?.ta.size, mi: phone?.mi.size }));
  await send("Emulation.clearDeviceMetricsOverride");
  await sleep(500);

  await type("修复一下这个 bug");
  const wsAcount = () => allSessions(rowsCache).filter((r) => (r.workspace || r.cwd) === wsA).length;
  rowsCache = await api("/api/sessions");
  const beforeCount = wsAcount();

  // 按下发送键的**那一刻**就得有反应：不能等 ACP 握手（新建会话要几秒）。
  // 更狠的一条也在这一段验：在途期间再按（真机上他先点了发送、又按了两次回车）不能再建一个会话。
  await ev(`(() => {
    const ta = document.querySelector('.composer-box textarea');
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })()`);
  await sleep(120);
  const instant = await ev(`({
    toast: document.querySelector('.bridge-toast')?.textContent ?? '',
    busy: document.querySelector('.bridge-toast')?.classList.contains('busy') ?? false,
    value: document.querySelector('.composer-box textarea')?.value ?? null,
    sendDisabled: document.querySelector('.send-btn')?.disabled ?? null,
  })`);
  check("the receipt appears the moment you press send, not after the target is up",
    /正在转交/.test(instant.toast) && instant.busy === true, JSON.stringify(instant.toast));
  check("and the composer is already empty", instant.value === "", JSON.stringify(instant.value));
  check("the send button is disabled while it is in flight", instant.sendDisabled === true);
  if (process.env.SHOT) {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    await import("node:fs").then((fs) => fs.writeFileSync("/tmp/mention-busy.png", Buffer.from(shot.data, "base64")));
    console.log("   shot: /tmp/mention-busy.png");
  }

  // 真机上的重复动作：再点一次发送 + 连按两次回车
  await ev(`document.querySelector('.send-btn')?.click()`);
  await key("Enter", "Enter", 13);
  await key("Enter", "Enter", 13);

  for (let i = 0; i < 60; i++) {
    if (/已转交/.test(await ev(`document.querySelector('.bridge-toast')?.textContent ?? ''`))) break;
    await sleep(250);
  }
  rowsCache = await api("/api/sessions");
  check("pressing it three times still opens exactly ONE session",
    wsAcount() === beforeCount + 1, `${beforeCount} -> ${wsAcount()}`);
  const cleared = await ev(`({ value: document.querySelector('.composer-box textarea')?.value ?? '', chip: !!document.querySelector('.mention-chip'), note: document.querySelector('.bridge-toast')?.textContent ?? '' })`);
  check("the composer clears after the transfer", cleared.value === "", JSON.stringify(cleared.value));
  check("the token goes with it", cleared.chip === false);
  check("a receipt pops up and says where it went", /已转交/.test(cleared.note), cleared.note);
  check("the receipt offers to jump to the target session", /跳到目标会话/.test(cleared.note), cleared.note);
  // SHOT=1 时把回执那一刻的页面拍下来：这块浮层是这次新加的，位置对不对机器判不了，得人眼过一眼。
  if (process.env.SHOT) {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    await import("node:fs").then((fs) => fs.writeFileSync("/tmp/mention-toast.png", Buffer.from(shot.data, "base64")));
    console.log("   shot: /tmp/mention-toast.png");
  }
  // 那个「跳到目标会话」要真的跳 —— 回执的最大价值是"我能跟过去看它干了什么"。
  await ev(`[...document.querySelectorAll('.bridge-toast-go')][0]?.click()`);
  await sleep(1800);
  const jumped = await ev(`(document.querySelector('.session-item.active .title')?.textContent ?? '').trim()`);
  check("clicking it actually opens the session it was handed to", jumped === "← 排查问题", jumped);
  const gone = await ev(`!!document.querySelector('.bridge-toast')`);
  check("the receipt closes once you took the jump", gone === false);
  // 跳过去之后要回到会话 A 再跑下一腿 —— 否则「来源」变成了刚才那个转交目标，断言会对着错的对象。
  check("…and we can walk back to A", await ev(`(() => {
    const hit = [...document.querySelectorAll('.session-item')]
      .find((r) => (r.querySelector('.title')?.textContent ?? "").trim() === "排查问题");
    if (!hit) return false; hit.click(); return true;
  })()`) === true);
  await sleep(1500);

  // The real proof: a session in wsA now exists and its first message is the envelope + the sentence.
  const rows = await api("/api/sessions");
  if (process.env.SWEEP_DEBUG) {
    const all = allSessions(rows);
    console.log("   rows:", JSON.stringify(all.map((s) => ({ id: s.id, cwd: s.cwd, ws: s.workspace, t: s.title, at: s.createdAt ?? s.lastAt }))));
    console.log("   wsA:", wsA);
  }
  const created = allSessions(rows)
    .filter((s) => (s.workspace || s.cwd) === wsA && s.id !== srcA)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
  check("a new session really appeared in the target workspace", Boolean(created), created?.id ?? "none");
  check("its name says where it came from, instead of quoting the envelope",
    (created?.title ?? "").startsWith("← 排查问题"), JSON.stringify(created?.title));
  let env = "";
  for (let i = 0; i < 40 && created; i++) {
    const msgs = await api(`/api/cockpit/messages?id=${created.id}&tail=20&role=user`);
    const first = (msgs?.messages ?? [])[0]?.text ?? "";
    if (first.includes("[跨工作空间转交]")) { env = first; break; }
    await sleep(250);
  }
  check("the target's first message is the bridge envelope", env.includes("[跨工作空间转交]"), env.slice(0, 80));
  check("the envelope names the source session and how to read it",
    env.includes(srcA) && env.includes(`session messages ${srcA}`), env.split("\n").slice(1, 4).join(" | "));
  check("its reading example is ONE message (the agent's last reply), not a window of history",
    env.includes("--role agent --tail 1") && !/--tail\s+(?!1\b)\d+/.test(env),
    (env.match(/--tail[^）\n]*/g) ?? []).join(" / "));
  check("the envelope carries the operator's own words, not the chat log",
    env.trim().endsWith("修复一下这个 bug"), JSON.stringify(env.trim().slice(-60)));

  // ---------------------------------------------------------------- 第二腿：真正跨工作空间
  // 第一腿是"在同一空间新开一个来说"，那是最难自证的一半（当前空间必须可选）。这一腿才是当初
  // 提的需求：排查在 A，动手在 B。全程用**真键盘**（第一腿那次是页面里派发的合成事件）。
  await ev(`document.querySelector('.composer-box textarea').focus()`);
  await type("@");
  const wsNames = await ev(`[...document.querySelectorAll('.mention-palette .mention-item .mention-name')].map((e) => e.textContent)`);
  check("the other workspace is in the same palette, after the current one",
    wsNames?.[1] === nameOf(wsB) && wsNames?.[0] === nameOf(wsA), JSON.stringify(wsNames));
  await key("ArrowDown", "ArrowDown", 40);
  await key("Enter", "Enter", 13);        // 选中 wsB
  await key("Enter", "Enter", 13);        // 选中首行「新会话」
  await type("把根因写进 CHANGELOG，然后修掉");
  await key("Enter", "Enter", 13);        // 真回车发送
  await sleep(3000);

  const rowsB = await api("/api/sessions");
  const madeB = allSessions(rowsB)
    .filter((r) => (r.workspace || r.cwd) === wsB && r.id !== srcB)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
  check("a new session opens in the OTHER workspace", Boolean(madeB), madeB?.id ?? "none");
  let envB = "";
  for (let i = 0; i < 40 && madeB; i++) {
    const msgs = await api(`/api/cockpit/messages?id=${madeB.id}&tail=20&role=user`);
    const first = (msgs?.messages ?? [])[0]?.text ?? "";
    if (first.includes("[跨工作空间转交]")) { envB = first; break; }
    await sleep(250);
  }
  check("and it gets the envelope pointing back at session A",
    envB.includes(`session messages ${srcA}`), envB.split("\n")[3] ?? envB.slice(0, 60));
  check("with the operator's words in it", envB.trim().endsWith("把根因写进 CHANGELOG，然后修掉"));
  const composerB = await ev(`document.querySelector('.composer-box textarea')?.value ?? ""`);
  check("the composer is clean after the second transfer", composerB === "", JSON.stringify(composerB));

  // 收尾：回到第二个被叫起来的新会话，看它自己那条气泡是不是标着「来自 …」——
  // 目标那边的人要能一眼看出这不是自己打的（这条走的是 payload.origin，刷新也在）。
  const reopened = await ev(`(() => {
    const hit = [...document.querySelectorAll('.session-item')]
      .find((r) => (r.querySelector('.title')?.textContent ?? "").trim() === "← 排查问题");
    if (!hit) return false;
    hit.click();
    return true;
  })()`);
  check("the transfer target is reachable from the rail by its name", reopened === true);
  await sleep(2200);
  // 标签在气泡上面那一行 .role（「YOU」也在那儿），所以读整条 .msg.user，不只读 .bubble。
  const bubble = await ev(`(() => {
    const row = document.querySelector(".msg.user.from-agent");
    if (!row) return null;
    const role = row.querySelector(".role");
    const body = row.querySelector(".bubble");
    return String(role ? role.textContent : "") + " || " + String(body ? body.textContent : "").slice(0, 40);
  })()`);
  check("its bubble is labelled 来自「排查问题」, not passed off as the operator's own words",
    /来自「排查问题」/.test(bubble), bubble.slice(0, 80));

  // ------------------------------------------------------- 两条来自真手机使用的问题
  // (1) 手机上只有删除键，没有 Esc：把那个 `@` 删掉，列表必须跟着消失。
  await ev(`document.querySelector('.composer-box textarea').focus()`);
  await type("@");
  check("palette open again for the cancel-by-deleting case",
    await ev(`!!document.querySelector('.mention-palette')`) === true);
  await key("Backspace", "Backspace", 8);
  check("deleting the @ closes the list (no Esc on a phone)",
    await ev(`!!document.querySelector('.mention-palette')`) === false
      && await ev(`document.querySelector('.composer-box textarea').value`) === "");

  // (2) 选了目标却没写正文就回车：不能一声不响，否则人以为已经发过去了。
  const before = allSessions(await api("/api/sessions")).length;
  await ev(`document.querySelector('.composer-box textarea').focus()`);
  await type("@");
  await key("Enter", "Enter", 13);   // 选工作空间
  await key("Enter", "Enter", 13);   // 选「新会话」
  await key("Enter", "Enter", 13);   // 空正文直接回车
  await sleep(1200);
  const emptyToast = await ev(`document.querySelector('.bridge-toast')?.textContent ?? ''`);
  check("pressing Enter with only a target says what is missing",
    /写一句话再回车/.test(emptyToast), emptyToast);
  const after = allSessions(await api("/api/sessions")).length;
  check("…and it does not quietly create a session", after === before, `${before} -> ${after}`);

  // ------------------------------------------------- 服务端的两条契约（review 抓出来的）
  // (a) 转交给自己：不是「没意义」而已 —— 它会 cancel 掉你正在跑的回合，还给自己的话贴一张
  //     「来自别处」的标签。列表里已经不给选了，接口也必须拒。
  const selfPost = await fetch(`${BASE}/api/bridge`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ from: srcA, to: { kind: "session", id: srcA }, text: "自己转给自己" }),
  });
  const selfBody = await selfPost.json().catch(() => ({}));
  check("transferring to yourself is refused by the server, not just hidden in the UI",
    selfPost.status === 400 && selfBody.code === "self_target", `${selfPost.status} ${JSON.stringify(selfBody).slice(0, 80)}`);

  // (b) 投递失败必须报失败。上一版是 `void prompt().catch(console.error)`：目标进程刚好死掉时
  //     信封没送出去，接口却回 200，页面显示「已转交」。这里把目标 agent 杀掉再造这一下。
  // pid 不在 /api/sessions 的行里，所以靠进程表找这个会话新起的 mock agent（argv 里带 mock/agent.mjs）。
  const mockPids = () => new Set(execSync("ps -Ao pid=,command=", { encoding: "utf8" })
    .split("\n").filter((l) => /mock\/agent\.mjs/.test(l))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter(Boolean));
  const beforePids = mockPids();
  const victim = await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "mock", cwd: wsB, title: "将被杀掉的会话" }) });
  for (let i = 0; i < 40; i++) {
    const row = allSessions(await api("/api/sessions")).find((r) => r.id === victim.id);
    if (row?.status === "ready") break;
    await sleep(250);
  }
  const victimPid = [...mockPids()].find((p) => !beforePids.has(p));
  if (victimPid) {
    process.kill(victimPid, "SIGKILL");
    await sleep(1200);
  }
  const deadPost = await fetch(`${BASE}/api/bridge`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ from: srcA, to: { kind: "session", id: victim.id }, text: "这句话必须被报成失败" }),
  });
  const deadBody = await deadPost.json().catch(() => ({}));
  // 杀进程这一下有时会被 manager 自动拉起（那就该 200），有时拉不起来（那就该 4xx）。
  // 所以这里断言的是一条不变量，而不是某一次的结果：
  //   **接口回 200 ⟺ 信封真的进了目标的转录**。上一版正是这条不成立 —— 回 200 但什么都没到。
  const victimMsgs = await api(`/api/sessions/${victim.id}/messages`);
  const landed = JSON.stringify(victimMsgs ?? {}).includes("这句话必须被报成失败");
  const saidOk = deadPost.status === 200;
  check("「已转交」只说在话真的到了的时候：200 与转录里有信封必须一致",
    saidOk === landed,
    `pid=${victimPid ?? "?"} status=${deadPost.status} landed=${landed} ${JSON.stringify(deadBody).slice(0, 80)}`);
  check("失败时给的是能看懂的原因，不是 error code",
    saidOk || /deliver_failed|wake_failed|target_not_ready/.test(JSON.stringify(deadBody)) || typeof deadBody.error === "string");
} catch (e) {
  fail++;
  console.log("FAIL  sweep threw —", String(e?.message ?? e));
} finally {
  await fetch(`${CDP}/json/close/${tab.id}`).catch(() => {});
  try { killGroup(proc); } catch { /* gone */ }
  console.log(`\nmention-sweep: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
