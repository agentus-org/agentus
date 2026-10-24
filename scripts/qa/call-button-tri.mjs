// 按键打断页那个左键的三个状态（issue #53 + 操作员口述 2026-10-23）。
//
// 口述原文的形状：「它输出的时候显示打断，空闲的时候显示开始说话，点完打断之后变成结束 ——
// 什么时候结束这句话由我来定，不要自动识别」。所以这条路径上和持续听写（voice 模式）根本不同：
//
//   · 不自动发 — 停顿多久都不发，silenceMs / minChars / VAD 全部不参与。判据是"说了 3 秒以上
//     房间里没有声音，线路上仍然一个字都没多出来"（旧实现 auto-send 早就在 1.5s 时发出去了）。
//   · 一次点击 = 开麦，再一次点击 = 结束并发送。两次都在同一个按钮上，文案跟着状态走。
//   · 右键「按住说话」原样保留：按住说，松开发。
//   · "点了没反应"：按键模式平时不开麦（#51 的取舍），旧代码点完之后只把相位改回 listening，
//     麦克风根本没开，看起来就是死的。这里的判据是语音帧真的开始流动 + 文案变成「结束」。
//
//   node scripts/qa/call-button-tri.mjs
import { spawn } from "node:child_process";
import { createServer as createTcp } from "node:net";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SHOTS = process.env.SHOTS ?? path.resolve(ROOT, "../../tasks/20261001-agentus/screens");
const CDP = process.env.CDP ?? "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

/** Killing the `tsx` WRAPPER is not killing the server (tsx runs the app as its own child). */
const killGroup = (target) => {
  const pid = typeof target === "number" ? target : target?.pid;
  if (!pid) return;
  try { process.kill(-pid, "SIGKILL"); } catch { try { killGroup(pid); } catch { /* gone */ } }
};

// ------------------------------------------------------------------ stub TTS (a real WAV, so the call really speaks)
function wav(seconds, freq = 320) {
  const rate = 8000, n = rate * seconds, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 2200), i * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write("data", 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
const clip = wav(2);
const stub = http.createServer((req, res) => {
  if (req.method === "POST" && String(req.url).startsWith("/audio/speech")) {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "audio/wav", "content-length": String(clip.length) });
      res.end(clip);
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubPort = stub.address().port;

// ------------------------------------------------------------------ instance
const freePort = () => new Promise((res, rej) => {
  const s = createTcp();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});
const PORT = await freePort();
const dataDir = mkdtempSync(path.join(tmpdir(), "agentus-tri-"));
const emptyHome = mkdtempSync(path.join(tmpdir(), "agentus-tri-home-"));
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
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }
const token = () => readFileSync(path.join(dataDir, "auth.token"), "utf8").trim();
const api = async (p, opts = {}) => {
  const r = await fetch(`${BASE}${p}`, { ...opts, headers: { authorization: `Bearer ${token()}`, ...(opts.body ? { "content-type": "application/json" } : {}), ...(opts.headers ?? {}) } });
  const text = await r.text();
  return { status: r.status, text, json: () => (text ? JSON.parse(text) : null) };
};
const transcript = async (sid) => (await api(`/api/sessions/${sid}/messages?tail=40`)).text;

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
async function click(selector) {
  const box = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null; el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, hits: !!hit && (hit === el || el.contains(hit) || hit.contains(el)),
      at: hit ? (hit.className || hit.tagName) : null }; })()`);
  if (!box) throw new Error(`no element for ${selector}`);
  if (!box.hits) throw new Error(`point for ${selector} is covered by ${box.at}`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
}

const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.data, "base64"));
};

/** The floor row's two buttons, as the operator sees them, plus what the phase is. */
const FLOOR = `(() => {
  const el = document.querySelector('.call-mode');
  if (!el) return { open: false };
  const row = el.querySelector('.call-floor-row');
  const btns = row ? [...row.querySelectorAll('.call-floor')].map((b) => ({
    text: (b.querySelector('span')?.textContent ?? '').trim(),
    aria: b.getAttribute('aria-label'),
    pressed: b.getAttribute('aria-pressed'),
    cls: b.className,
    w: Math.round(b.getBoundingClientRect().width),
    h: Math.round(b.getBoundingClientRect().height),
  })) : [];
  return { open: true, phase: el.dataset.phase, btns,
    hint: el.querySelector('.call-hint')?.textContent?.trim() ?? null };
})()`;

try {
  await ev(`(async () => { await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: [1,2,3,4,5,6].join('') }) }); return true; })()`);
  const stubVoice = { provider: "openai", baseUrl: `http://127.0.0.1:${stubPort}`, ttsModel: "stub-tts", ttsVoice: "stub", ["api" + "Key"]: ["sk-", "stub", "-key"].join("") };
  const setup = await ev(`(async () => {
    localStorage.setItem('agentus.voice', JSON.stringify({ autoRead: false, voiceURI: '', rate: 1, lang: 'zh-CN', serverTts: true, stt: 'auto' }));
    localStorage.setItem('agentus.call.caption', '1');      // 左键只活在转录视图里：它就是操作员看的那一层
    await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: ${JSON.stringify(JSON.stringify({ voice: stubVoice, prefs: { autoRead: false, serverTts: true, stt: "auto", rate: 1, voiceURI: "", lang: "zh-CN" }, call: { interruptMode: "button" } }))} });
    const s = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backend: 'mock', cwd: '/tmp' }) }).then((r) => r.json());
    localStorage.setItem('agentus.active', s.id);
    const cfg = await fetch('/api/settings').then((r) => r.json());
    return { sid: s.id, mode: cfg?.call?.interruptMode ?? null };
  })()`);
  check("the instance is in button mode (按键打断) with captions on", setup.mode === "button", JSON.stringify(setup));
  const SID = setup.sid;
  await send("Browser.grantPermissions", { origin: BASE, permissions: ["audioCapture"] }).catch(() => {});
  await send("Page.reload", { ignoreCache: true });
  for (let i = 0; i < 40; i++) { await sleep(500); if (await ev(`!!document.querySelector('.composer, .chat-head')`)) break; }
  await sleep(900);

  await click('button[aria-label="开始语音通话"]');
  await sleep(1200);
  await ev(`window.__asFeed = { level: 0.45, text: '', interim: '' }; true`);   // no device in automation

  // ---- 1. 空闲：左键说「开始说话」，右键还是那个「按住说话」 ---------------------------------
  let f = await ev(FLOOR);
  check("the call opened with the floor row visible", f.open === true && f.btns.length === 2, JSON.stringify(f.btns));
  check("idle: the left button says 开始说话", f.btns[0]?.text === "开始说话", JSON.stringify(f.btns[0]));
  check("idle: the right button is still 按住说话 (unchanged)", f.btns[1]?.text === "按住说话", JSON.stringify(f.btns[1]));
  check("idle: the hint says how the mic opens", /开始说话|按住圆球/.test(f.hint ?? ""), String(f.hint));
  check("both buttons keep their thumb size", f.btns.every((b) => b.w >= 44 && b.h >= 44), JSON.stringify(f.btns.map((b) => [b.w, b.h])));
  await shot("call-button-tri-1-idle");

  // ---- 1b. 语音打断默认收起，设置里勾一下才回到这一排（#53 的另一半） -------------------------
  const modesRow = () => ev(`(() => { const b = document.querySelector('.call-modes');
    return b ? [...b.querySelectorAll('.call-mode-btn')].map((x) => x.textContent.trim()) : null; })()`);
  check("默认收起语音打断：这一排只剩「关键词打断 / 按键打断」",
    JSON.stringify(await modesRow()) === JSON.stringify(["关键词打断", "按键打断"]), JSON.stringify(await modesRow()));
  await click(".call-gear");
  await sleep(500);
  // by LABEL, not by position: the settings sheet holds more than one switch (#58 报进度 sits above it)
  const VOICE_CHK = '.call-sheet input[aria-label="在通话页显示语音打断"]';
  check("通话设置里有那个勾选框", (await ev(`!!document.querySelector(${JSON.stringify(VOICE_CHK)})`)) === true);
  await click(VOICE_CHK);
  await sleep(300);
  await click(".call-sheet-x");
  await sleep(400);
  check("勾上之后「语音打断」回到这一排",
    JSON.stringify(await modesRow()) === JSON.stringify(["语音打断", "关键词打断", "按键打断"]), JSON.stringify(await modesRow()));
  check("…并且这个选择存在本机（换一次通话还在）",
    (await ev(`localStorage.getItem('agentus.call.voiceMode')`)) === "1",
    String(await ev(`localStorage.getItem('agentus.call.voiceMode')`)));

  // ---- 2. 点「开始说话」：真开麦 + 文案变「结束」 -------------------------------------------
  await ev(`window.__asFeed = { level: 0.45, text: '这是我说的一句话', interim: '' }; true`);
  await click(".call-floor-row .call-floor.is-take");
  await sleep(900);
  f = await ev(FLOOR);
  check("after one click the left button says 结束", f.btns[0]?.text === "结束", JSON.stringify(f.btns[0]));
  check("…and the button is marked pressed (this is the operator's own listening turn)",
    f.btns[0]?.pressed === "true", String(f.btns[0]?.pressed));
  check("…and the call is listening, not dead (the 点完没反应 bug)",
    f.phase === "listening", String(f.phase));
  await shot("call-button-tri-2-listening");
  check("…and the hint, when it is on screen, is the one for this state",
    f.hint === null || /结束/.test(f.hint), String(f.hint));

  // ---- 2b. 点按收音进行中误触空格（review 第 2 条：半句话消失的竞态） ------------------------
  // 旧代码：keydown 走 pttStart（清掉 manual、抢话筒），keyup 的 <150ms 分支再 cancel + 回到 listening，
  // 这一轮就没了。现在按键模式在 manual 进行中完全不看空格。
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " });
  await sleep(60);
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
  await sleep(400);
  f = await ev(FLOOR);
  check("点按收音时误触空格：这一轮还在（仍是「结束」，还在听）",
    f.btns[0]?.text === "结束" && f.phase === "listening", JSON.stringify({ t: f.btns[0]?.text, p: f.phase }));
  check("…也没有把半句话发出去", !/这是我说的一句话/.test(await transcript(SID)));

  // ---- 3. 停顿不自动发：等够 silenceMs 的 2 倍，线路上仍然没有这条消息 -------------------------
  const before = await transcript(SID);
  await sleep(3600);                                     // silenceMs 默认 1500
  check("silence does NOT send: nothing reached the wire after 3.6s of quiet",
    !/这是我说的一句话/.test(await transcript(SID)), "still unsent");
  check("…and nothing reached it before we even started waiting", !/这是我说的一句话/.test(before));

  // ---- 4. 再点一次：结束并发出去 -------------------------------------------------------------
  await click(".call-floor-row .call-floor.is-take");
  let sentAt = -1;
  for (let i = 0; i < 40; i++) {
    if (/这是我说的一句话/.test(await transcript(SID))) { sentAt = i * 200; break; }
    await sleep(200);
  }
  check("the SECOND click is the send: the sentence is on the wire", sentAt >= 0, `${sentAt}ms`);
  f = await ev(FLOOR);
  check("…and the left button is back to 开始说话", f.btns[0]?.text === "开始说话" || f.btns[0]?.text === "打断",
    JSON.stringify(f.btns[0]));

  // ---- 5. 它输出的时候：左键变「打断」，点它就开麦 -------------------------------------------
  let sawTake = false;
  for (let i = 0; i < 80; i++) {
    const cur = await ev(FLOOR);
    if (cur.btns?.[0]?.text === "打断") { sawTake = true; break; }
    await sleep(150);
  }
  check("while the agent is working the left button says 打断", sawTake, JSON.stringify((await ev(FLOOR)).btns?.[0]));
  if (sawTake) {
    await ev(`window.__asFeed = { level: 0.45, text: '', interim: '' }; true`);
    await click(".call-floor-row .call-floor.is-take");
    await sleep(900);
    f = await ev(FLOOR);
    check("打断 then puts you in «结束» — the floor is yours, mic open",
      f.btns[0]?.text === "结束" && f.phase === "listening", JSON.stringify({ t: f.btns[0]?.text, p: f.phase }));
    // 空文本结束 = 取消，不该发一条空消息出去
    const count = (t) => (t.match(/"role":"user"/g) ?? []).length;
    const c0 = count(await transcript(SID));
    await click(".call-floor-row .call-floor.is-take");
    await sleep(1200);
    const c1 = count(await transcript(SID));
    f = await ev(FLOOR);
    check("ending with nothing heard cancels instead of sending an empty prompt", c1 === c0, `${c0} -> ${c1}`);
    check("…and the listening turn is over (the button is not stuck in 结束)",
      f.btns[0]?.text !== "结束" && f.btns[0]?.pressed !== "true", JSON.stringify(f.btns[0]));
  }

  await shot("call-button-tri-3-interrupt");
} finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  try { killGroup(proc); } catch { /* gone */ }
  try { stub.close(); } catch { /* gone */ }
  // `process.exit`, not exitCode: the CDP websocket stays open after the last assertion, and node
  // will happily sit on it forever (three zombie node processes were left behind by this in one
  // afternoon) — a finished sweep has to actually go away.
  process.exit(fail ? 1 : 0);
}
