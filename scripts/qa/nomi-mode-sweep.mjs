// 糯米模式（nomi）—— 它是「另一种电话页面」，还是只是换了张图？
//
// What can be observed, and therefore what this asserts:
//   · 入口：短按 = 原来的电话，长按 480 ms = 糯米模式（两条路都真的打开了一个全屏 dialog）；
//   · 分区：竖屏脸在上/记录在下、横屏脸在左/记录在右 —— 用几何断言，不看截图；
//   · 脸是活的：canvas 像素在两帧之间变了（不是一张静态图），且真的画了东西；
//   · 记录是「原件的缩小版」：同一套行，字号变小（量的是同一行的盒子高度，不是猜 CSS）；
//   · 不侵入：三态打断开关在这个页面里不可见，且进出不写 localStorage / 服务端设置。
//
// Self-contained (its own instance + its own mock session + the QA Edge on :9223). No TTS stub:
// 这张脸不需要声音，相位机自己会走到 listening/thinking。
//   node scripts/qa/nomi-mode-sweep.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createTcp } from "node:net";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CDP = process.env.CDP ?? "http://127.0.0.1:9223";
const SHOTS = process.env.SHOTS ?? path.resolve(ROOT, "../../tasks/20261023-agentus-call-open-nomi/screens");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

/** tsx 是包装进程：杀它不会杀它的子进程（监听端口的是子进程），所以整组一起杀。 */
const killGroup = (target) => {
  const pid = typeof target === "number" ? target : target?.pid;
  if (!pid) return;
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
};

const freePort = () => new Promise((res, rej) => {
  const s = createTcp();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});

const PORT = await freePort();
const dataDir = mkdtempSync(path.join(tmpdir(), "agentus-nomi-"));
const emptyHome = mkdtempSync(path.join(tmpdir(), "agentus-home-"));
const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
  detached: true,
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: "development", HOME: emptyHome, AGENTUS_PORT: String(PORT), AGENTUS_DATA: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
proc.stdout.on("data", (d) => { log += String(d); });
proc.stderr.on("data", (d) => { log += String(d); });
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 80 && !log.includes(`0.0.0.0:${PORT}`); i++) await sleep(150);
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }

// ------------------------------------------------------------------ browser
const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(2600);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const waiting = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { const x = waiting.get(m.id); waiting.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); }
};
const send = (method, params = {}, to = 30000) => new Promise((res, rej) => {
  const mid = ++id; const timer = setTimeout(() => { waiting.delete(mid); rej(new Error("TIMEOUT " + method)); }, to);
  waiting.set(mid, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expr, to = 30000) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, to);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};
const clickSel = async (selector) => {
  const box = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null; const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, hits: !!hit && (hit === el || el.contains(hit) || hit.contains(el)),
      at: hit ? (hit.className || hit.tagName) : null }; })()`);
  if (!box) throw new Error(`no element for ${selector}`);
  if (!box.hits) throw new Error(`point for ${selector} is covered by ${box.at}`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
};
/** 长按 / 短按：按住 `holdMs` 再松开 —— 这是这个入口唯一的区别。 */
const pressSel = async (selector, holdMs) => {
  const box = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null; const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!box) throw new Error(`no element for ${selector}`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await sleep(holdMs);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
};

const viewport = (w, h) => send("Emulation.setDeviceMetricsOverride", {
  width: w, height: h, deviceScaleFactor: 2, mobile: true,
  screenOrientation: { type: w > h ? "landscapePrimary" : "portraitPrimary", angle: w > h ? 90 : 0 },
});

/** 这一页此刻长什么样：分区、脸、字号、开关可见性 —— 全部量出来。 */
const SHAPE = `(() => {
  const call = document.querySelector('.call-mode');
  if (!call) return { open: false };
  const r = (s) => { const el = document.querySelector(s); if (!el) return null; const b = el.getBoundingClientRect();
    return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height),
      right: Math.round(b.right), bottom: Math.round(b.bottom) }; };
  const face = r('.call-nomi-face'), chat = r('.call-cc'), canvas = r('.nomi-face-canvas');
  const bubble = document.querySelector('.call-cc-inner .bubble');
  const modes = document.querySelector('.call-mode .call-modes');
  const modesVisible = !!modes && getComputedStyle(modes).display !== 'none'
    && modes.getBoundingClientRect().width > 0;
  return { open: true, nomi: call.dataset.nomi === 'true', phase: call.dataset.phase,
    err: document.querySelector('.call-err')?.textContent ?? null,
    vw: innerWidth, vh: innerHeight, face, chat, canvas,
    bubbleH: bubble ? Math.round(bubble.getBoundingClientRect().height * 10) / 10 : null,
    modesVisible, zoom: chat ? (getComputedStyle(document.querySelector('.call-cc-inner')).zoom ?? null) : null,
    orbVisible: (() => { const o = document.querySelector('.call-orb'); if (!o) return false;
      const b = o.getBoundingClientRect(); return getComputedStyle(o).display !== 'none' && b.width > 0; })(),
    overflowX: document.documentElement.scrollWidth - innerWidth };
})()`;

/** 记录属性**每一次**变化，而不是每 200 ms 采样一次 —— 工具在跑只有 ~25 ms（mock 的
 *  in-progress 窗口），轮询会漏，MutationObserver 不会。canvas 的 data-clip 由帧循环设置，
 *  clip 本身持续 1.4–6 s，所以它是"这条动作真的播了"的最直接证据。 */
const WATCH = `(() => {
  window.__nomiSeen = { sub: [], clip: [], face: [], mood: [] };
  const push = (k, v) => { const a = window.__nomiSeen[k]; if (v && a[a.length - 1] !== v) a.push(v); };
  const read = () => {
    const c = document.querySelector('.call-mode');
    if (c) { push('sub', c.dataset.substate); push('face', c.dataset.face); push('mood', c.dataset.mood); }
    const cv = document.querySelector('.nomi-face-canvas');
    if (cv) push('clip', cv.dataset.clip);
  };
  read();
  new MutationObserver((rows) => {
    for (const r of rows) {
      const t = r.target;
      if (r.attributeName === 'data-clip') push('clip', t.dataset.clip);
      else if (r.attributeName === 'data-substate') { push('sub', t.dataset.substate); push('face', t.dataset.face); }
      else if (r.attributeName === 'data-face') push('face', t.dataset.face);
      else if (r.attributeName === 'data-mood') push('mood', t.dataset.mood);
    }
  }).observe(document.body, { attributes: true, subtree: true,
    attributeFilter: ['data-substate', 'data-clip', 'data-face', 'data-mood'] });
  return true;
})()`;
const SEEN = `JSON.parse(JSON.stringify(window.__nomiSeen ?? { sub: [], clip: [], face: [], mood: [] }))`;
const RESET_SEEN = `(window.__nomiSeen = { sub: [], clip: [], face: [], mood: [] }, true)`;

/** canvas 的运动签名 + 亮像素比例（照 call-sweep 的做法：像素差，不是「元素存在」）。 */
const SIG = `(sel) => { const cv = document.querySelector(sel); if (!cv) return null;
  const c = cv.getContext('2d'); const { width: w, height: h } = cv; if (!w || !h) return null;
  const d = c.getImageData(0, 0, w, h).data; let s = 0, lit = 0, n = 0;
  for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) {
    const a = d[(y * w + x) * 4 + 3]; s = (s + a * ((x * 7 + y * 13) % 251)) % 2147483647; n++; if (a > 24) lit++;
  }
  return { sig: s, lit: Math.round((lit / Math.max(1, n)) * 1000) / 10, w, h }; }`;

const settingsCall = async () => {
  const token = fs.readFileSync(path.join(dataDir, "auth.token"), "utf8").trim();
  const res = await fetch(`${BASE}/api/settings`, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.json();
  return JSON.stringify(body?.call ?? null);
};

/** 这一轮跑完没有 —— 用服务端的 status，不靠猜"气泡是不是还在长"。 */
const turnStatus = async () => ev(`(async () => { const sid = localStorage.getItem('agentus.active');
  const d = await fetch('/api/sessions').then((r) => r.json()).catch(() => null);
  return (d?.live ?? []).find((s) => s.id === sid)?.status ?? null; })()`);
const waitIdle = async (maxMs = 25000) => {
  let st = null;
  for (let t = 0; t < maxMs; t += 300) {
    st = await turnStatus();
    if (st === "ready" || st === "error" || st === "closed") return st;
    await sleep(300);
  }
  return st;
};
/** 代理这一轮结束后，通话页可能还在念上一句 —— 等它把话筒交回来再发下一句。
 *  （真人是打断后再说；这里用接口发提示词，没有打断，所以要显式等相位回到 listening。） */
const waitListening = async (maxMs = 40000) => {
  let ph = null, streak = 0;
  for (let t = 0; t < maxMs; t += 250) {
    ph = await ev(`document.querySelector('.call-mode')?.dataset.phase ?? null`);
    if (ph === "listening") { streak++; if (streak >= 4) return true; }
    else streak = 0;
    await sleep(250);
  }
  return false;
};
/** 发一句话给 mock。上一轮还在跑时服务端会拒，重试到它收下为止。 */
const promptCall = async (text) => {
  for (let i = 0; i < 30; i++) {
    const st = await ev(`(async () => { const sid = localStorage.getItem('agentus.active');
      const r = await fetch('/api/sessions/' + sid + '/prompt', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: ${JSON.stringify(text)} }) });
      return r.status; })()`);
    // /prompt answers 202 (fire & forget); treating 202 as failure re-sends the same prompt
    // every retry and the server then queues turn after turn.
    if (st >= 200 && st < 300) return true;
    await sleep(700);
  }
  return false;
};

let exitCode = 0;
try {
  fs.mkdirSync(SHOTS, { recursive: true });
  await viewport(390, 844);
  await ev(`(async () => { await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }) }); return true; })()`);
  const setup = await ev(`(async () => {
    const s = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backend: 'mock', cwd: '/tmp' }) }).then((r) => r.json());
    localStorage.setItem('agentus.active', s.id);
    localStorage.removeItem('agentus.call');
    return { sid: s.id };
  })()`);
  await send("Browser.grantPermissions", { origin: BASE, permissions: ["audioCapture"] }).catch(() => {});
  // 自动化没有麦克风，Web Speech 还会因为"network"直接失败 —— 失败时相位是 error，
  // 脸就不是 listening，这一页最常被问到的两个状态都测不到。`__asFeed` 是 voice.ts 留的
  // 同一个测试缝（call-sweep 也用它）：start() 无需设备即成功，电平/转写完全可控。
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__asFeed = { level: 0, text: '', interim: '' };`,
  });
  await send("Page.reload", { ignoreCache: true });
  for (let i = 0; i < 40; i++) { await sleep(400); if (await ev(`!!document.querySelector('.chat-head')`)) break; }
  // 先造一轮真实对话：记录区必须**有行**才量得到字号（这也是 captions 视图的同一个前提）。
  for (let i = 0; i < 20; i++) {
    const ok = await ev(`(async () => { const sid = localStorage.getItem('agentus.active');
      const r = await fetch('/api/sessions/' + sid + '/prompt', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '第一句：这是一段足够长的回答，用来量聊天区的行高和滚动。第二句：糯米模式要把这一页缩小放进下半屏。第三句：横屏时它应该在右边。' }) });
      return r.status; })()`);
    if (ok >= 200 && ok < 300) break;
    await sleep(800);
  }
  for (let i = 0; i < 30; i++) { await sleep(400); if (await ev(`!!document.querySelector('.chat-col .bubble')`)) break; }
  // Mock 的回复是流式的：如果 turn 还在跑就接进通话，它会把这句答复当成"正在说的话"念，
  // 相位就是 speaking，脸当然不是 listening。先把这一轮等干净，后面的断言才有确定的起点。
  await waitIdle();

  // ---- 1. 短按：还是原来那个电话 --------------------------------------------------------
  const callBtn = ".icon-btn.call-entry";
  await pressSel(callBtn, 120);
  await sleep(1400);
  let s1 = await ev(SHAPE);
  check("短按打开的是原来的通话（data-nomi=false）", s1.open === true && s1.nomi === false, JSON.stringify({ open: s1.open, nomi: s1.nomi }));
  check("…并且那张脸不在场、orb 在场", s1.face === null && s1.orbVisible === true);
  // 打开记录量一下「同一行原来多高」
  await clickSel(".call-cc-btn");
  await sleep(700);
  const plain = await ev(SHAPE);
  await clickSel(".call-btn.hangup");
  await sleep(600);
  check("挂断真的关掉了这一页", (await ev(`!document.querySelector('.call-mode')`)) === true);

  // ---- 2. 长按 480ms：糯米模式 ----------------------------------------------------------
  const beforeLocal = await ev(`localStorage.getItem('agentus.call')`);
  const beforeServer = await settingsCall();
  await pressSel(callBtn, 620);
  await sleep(1500);
  const nomi = await ev(SHAPE);
  check("长按 480ms 打开糯米模式（data-nomi=true）", nomi.open === true && nomi.nomi === true, JSON.stringify({ phase: nomi.phase, err: nomi.err }));
  check("糯米模式里没有 orb（脸取代了它）", nomi.orbVisible === false);
  check("三态打断开关在这个页面里不可见（固定关键词）", nomi.modesVisible === false);
  // 从这一刻起记录 data-substate / data-clip / data-face 的每一次变化（见 WATCH）。
  await ev(WATCH);
  const initialSub = await ev(`document.querySelector('.call-mode')?.dataset.substate ?? null`);
  check("糯米模式一打开就带 data-substate（观测口，不靠猜）", initialSub === "idle", String(initialSub));

  // ---- 3. 竖屏分区：上脸下记录 -----------------------------------------------------------
  check("竖屏 390×844：脸在上、记录在下",
    nomi.face && nomi.chat && nomi.face.bottom <= nomi.chat.y + 2 && nomi.face.y < nomi.chat.y,
    JSON.stringify({ face: nomi.face, chat: nomi.chat }));
  const share = nomi.face ? nomi.face.h / nomi.vh : 0;
  check("脸拿到 38%–50% 的高度（再高记录就没地方，再低看不清表情）",
    share >= 0.38 && share <= 0.5, `${(share * 100).toFixed(1)}%`);
  check("记录区是满宽的（不再是 560px 的栏）", nomi.chat ? nomi.chat.w >= nomi.vw - 40 : false, `${nomi.chat?.w}/${nomi.vw}`);
  check("没有横向溢出", (nomi.overflowX ?? 99) <= 0);

  // ---- 4. 脸在动，而且真的画了东西 -------------------------------------------------------
  // 取四次而不是两次：静止姿态也会有呼吸/眨眼，但任意 700 ms 窗口都可能恰好没动；
  // 四次里只要有一对帧不同，就证明帧循环还活着（这也是"冻结"最怕的误判）。
  const sigs = [];
  for (let i = 0; i < 4; i++) {
    sigs.push(await ev(`(${SIG})('.nomi-face-canvas')`));
    if (i < 3) await sleep(450);
  }
  const lit = sigs.find(Boolean);
  const distinct = new Set(sigs.filter(Boolean).map((s) => s.sig)).size;
  check("脸是 canvas 且画了东西（亮像素 > 0.5%）", lit && lit.lit > 0.5, JSON.stringify(lit && { lit: lit.lit, w: lit.w, h: lit.h }));
  check("脸在两帧之间变了（不是一张静态图）", distinct > 1, `${distinct} 种签名 / ${sigs.length} 次采样`);

  // ---- 4.5 「听」和「想」不是同一张脸；听话时脸上有节奏 --------------------------------
  // 操作者 2026-10-23:「怎么还是呆呆的」—— 当时 listening 与 thinking 都落到同一张眯眼的脸，
  // 而这两种状态占了通话的绝大部分时间。下面两条就是那次修的可观测判据。
  const faceNow = await ev(`document.querySelector('.call-mode')?.dataset.face ?? null`);
  check("听话时是「看着你」的那张脸（curious），不是思考的眯眼脸", faceNow === "curious", String(faceNow));
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    seen.add(await ev(`document.querySelector('.call-mode')?.dataset.face ?? ''`));
    await sleep(200);
  }
  seen.delete("");
  check("8 秒内脸上还换过别的表情（眨眼/扫一眼的节奏在走）", seen.size >= 2, [...seen].join(","));

  // ---- 5. 记录是「原件缩小」，不是另写一份 -----------------------------------------------
  check("记录里是会话页自己的行（.msg/.bubble 存在）", nomi.bubbleH !== null, String(nomi.bubbleH));
  check("字号真的变小了（同一行盒子比普通通话里矮）",
    !!(plain.bubbleH && nomi.bubbleH) && nomi.bubbleH < plain.bubbleH * 0.95,
    `plain ${plain.bubbleH} → nomi ${nomi.bubbleH}`);
  fs.writeFileSync(`${SHOTS}/nomi-portrait.png`, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));

  // ---- 6. 横屏分区：左脸右记录 -----------------------------------------------------------
  await viewport(844, 390);
  await sleep(900);
  const land = await ev(SHAPE);
  check("横屏 844×390：脸在左、记录在右",
    land.face && land.chat && land.face.right <= land.chat.x + 2 && land.face.x < land.chat.x,
    JSON.stringify({ face: land.face, chat: land.chat }));
  check("横屏下脸不再占上半屏（高度铺满、宽度约 44%）",
    land.face && Math.abs(land.face.w / land.vw - 0.44) < 0.08, `${((land.face?.w ?? 0) / land.vw * 100).toFixed(1)}%`);
  check("横屏也没有横向溢出", (land.overflowX ?? 99) <= 0);
  const b1 = await ev(`(${SIG})('.nomi-face-canvas')`);
  check("横屏下脸仍然在画", b1 && b1.lit > 0.5, JSON.stringify(b1 && { lit: b1.lit }));
  fs.writeFileSync(`${SHOTS}/nomi-landscape.png`, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));

  // ---- 6.5 表情通道端到端：提示词 → agent 写标签 → 页面剥掉 → 脸变 happy ------------------
  // mock 只在这一句真的到达时才吐标签（MOCK_EMO=1），所以这一段同时证明了三件事：
  // 服务端的 call 提示词带上了 [emo:x]，客户端把它从文字里剥干净，脸跟着标签换。
  const moodOf = async () => ev(`document.querySelector('.call-mode')?.dataset.mood ?? null`);
  const happy0 = await moodOf();
  for (let i = 0; i < 10; i++) {
    const st = await ev(`(async () => { const sid = localStorage.getItem('agentus.active');
      const r = await fetch('/api/sessions/' + sid + '/prompt', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '[emo-probe] 你好，说说你现在的心情' }) });
      return r.status; })()`);
    if (st >= 200 && st < 300) break;
    await sleep(700);
  }
  let happy = null, leaked = null;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    happy = await moodOf();
    leaked = await ev(`(() => { const rows = [...document.querySelectorAll('.msg.agent .bubble')];
      const t = rows.length ? rows[rows.length - 1].innerText : '';
      // 不用正则：这段代码住在 JS 模板串里，反斜杠转义会被模板吃掉，写出来的正则能假匹配。
      return { hasTag: t.includes('emo:') || t.includes('emo：'), sample: t.slice(0, 60) }; })()`);
    if (happy === "happy" && leaked && leaked.hasTag === false) break;
  }
  check("agent 照提示词写了标签，脸变成 happy（data-mood）", happy === "happy", String(happy));
  check("标签没有漏进气泡（[emo: 在渲染文本里不存在）", leaked && leaked.hasTag === false, JSON.stringify(leaked && leaked.sample));

  // ---- 6.6 工具子状态端到端：data-substate 跟着行变，clip 跟着状态播 ---------------------
  // 这里只用**已有的可观测行**（tool 行的 title/kind/status + pending），mock 不配合改行为：
  //   · [tools:3]  → in_progress 25 ms 窗口 → reading/running，随后 completed → done
  //   · [tool]     → 写文件的授权请求挂着 → awaiting；点允许 → completed；点拒绝 → failed
  // WATCH 是 MutationObserver，25 ms 的窗口也不会被采样漏掉。
  await viewport(390, 844);
  await sleep(600);
  await waitIdle();
  await waitListening();
  await ev(RESET_SEEN);

  await promptCall("[tools:3]");
  let tSeen = null;
  for (let i = 0; i < 120; i++) {
    await sleep(200);
    tSeen = await ev(SEEN);
    if (tSeen.clip.includes("tool-start") && tSeen.clip.includes("tool-done")) break;
  }
  check("工具回合：data-substate 出现过工具态（reading/running）",
    tSeen.sub.some((s) => s === "reading" || s === "running"), tSeen.sub.join(" → "));
  check("工具回合：data-clip 从 tool-start 走到 tool-done",
    tSeen.clip.includes("tool-start") && tSeen.clip.includes("tool-done"), tSeen.clip.join(" → "));
  // 回合结束时回到 idle —— "完成"不是常驻状态，下一句文本到了就该离开工具循环。
  await waitIdle();
  let idleSub = null;
  for (let i = 0; i < 40; i++) {
    idleSub = await ev(`document.querySelector('.call-mode')?.dataset.substate ?? null`);
    if (idleSub === "idle") break;
    await sleep(250);
  }
  check("回合结束后 data-substate 回到 idle", idleSub === "idle", String(idleSub));

  // (b) 等授权：这是整通电话里最长的沉默之一，脸必须说"我在等你"，不是说"我在干活"。
  await waitListening();
  await ev(RESET_SEEN);
  await promptCall("[tool]");
  let pSeen = null, pNow = null;
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    pSeen = await ev(SEEN);
    pNow = await ev(`(() => { const c = document.querySelector('.call-mode');
      return c ? { sub: c.dataset.substate ?? null, face: c.dataset.face ?? null } : null; })()`);
    if (pNow?.sub === "awaiting" && pNow?.face === "asking") break;
  }
  check("授权请求挂着时 data-substate=awaiting（不是 idle/working）", pNow?.sub === "awaiting", JSON.stringify(pNow));
  check("…同一时刻脸是 asking（在等你，不是低头干活）", pNow?.face === "asking", JSON.stringify(pNow));
  check("…并且播了 ask-hold 这条 clip", pSeen.clip.includes("ask-hold"), pSeen.clip.join(" → "));

  // 允许：点的是通话记录里真实的审批卡（.call-cc 范围内），不是直接调接口。
  const clickedAllow = await ev(`(() => { const b = document.querySelector('.call-cc .perm-card button.allow');
    if (!b) return false; b.scrollIntoView({ block: 'center' }); return true; })()`);
  check("审批卡出现在通话记录里（记录是原件的缩小版，卡片和按钮都在）", clickedAllow === true);
  await sleep(300);
  await clickSel(".call-cc .perm-card button.allow");
  let aSeen = null;
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    aSeen = await ev(SEEN);
    if (aSeen.sub.includes("done") || aSeen.clip.includes("tool-done")) break;
  }
  check("点允许后：完成态/完成 clip 出现（done 或 tool-done）",
    aSeen.sub.includes("done") || aSeen.clip.includes("tool-done"),
    JSON.stringify({ sub: aSeen.sub, clip: aSeen.clip }));

  // (c) 拒绝：失败不是"没反应"—— tool-fail 这条 clip 必须真的播。
  await waitIdle();
  await waitListening();
  await ev(RESET_SEEN);
  await promptCall("[tool]");
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    pNow = await ev(`document.querySelector('.call-mode')?.dataset.substate ?? null`);
    if (pNow === "awaiting") break;
  }
  const clickedReject = await ev(`(() => { const b = document.querySelector('.call-cc .perm-card button.reject');
    if (!b) return false; b.scrollIntoView({ block: 'center' }); return true; })()`);
  if (clickedReject) { await sleep(300); await clickSel(".call-cc .perm-card button.reject"); }
  let fSeen = null;
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    fSeen = await ev(SEEN);
    if (fSeen.clip.includes("tool-fail")) break;
  }
  check("拒绝一次写文件：会播 tool-fail（失败有单独的动作，不是静音收场）",
    clickedReject === true && fSeen.clip.includes("tool-fail"),
    JSON.stringify({ clicked: clickedReject, clip: fSeen.clip }));

  // ---- 7. 不侵入：进出不写设置 -----------------------------------------------------------
  await waitIdle();
  await clickSel(".call-btn.hangup");
  await sleep(700);
  const afterLocal = await ev(`localStorage.getItem('agentus.call')`);
  const afterServer = await settingsCall();
  check("进出糯米模式没有写 localStorage 的 call 设置", beforeLocal === afterLocal, `${beforeLocal} → ${afterLocal}`);
  check("…也没有写服务端的 call 设置", beforeServer === afterServer, `${beforeServer} → ${afterServer}`);
  check("挂断后回到会话页", (await ev(`!document.querySelector('.call-mode')`)) === true);

  // ---- 8. 关掉页面不留残余 ---------------------------------------------------------------
  check("糯米模式的 DOM 已卸载（没有 .call-nomi-face / 没有 canvas 在跑）",
    (await ev(`!document.querySelector('.call-nomi-face')`)) === true);
} catch (e) {
  fail++;
  exitCode = 1;
  console.log(`FAIL  sweep threw: ${e?.message ?? e}`);
  console.log(log.slice(-1500));
} finally {
  try { ws.close(); } catch { /* already closed */ }
  await fetch(`${CDP}/json/close/${tab.id}`).catch(() => null);
  killGroup(proc);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : exitCode);
