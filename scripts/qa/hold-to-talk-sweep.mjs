// 按住说话（issue #82）在真浏览器里走一遍。
//
// 单测（hold-to-talk-units.mts）钉的是状态机；这里只证明**事件真的接到了**，而且 P0 那条核心判据成立：
// 按住期间布局自己变化（输入框变高、状态条出现）不能断录 —— 也就是指针离开按钮边界时录音必须还在。
//
// 自给自足：自己的 Agentus（mock 后端、AGENTUS_AUTH=off）、临时数据目录、操作员的 Edge。
//   CDP=http://127.0.0.1:9223 node scripts/qa/hold-to-talk-sweep.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
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

const freePort = () => new Promise((res, rej) => {
  const s = createTcp();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});

const PORT = await freePort();
const dataDir = mkdtempSync(path.join(tmpdir(), "agentus-hold-"));
const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
  detached: true,
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: "development", HOME: mkdtempSync(path.join(tmpdir(), "hold-home-")), AGENTUS_PORT: String(PORT), AGENTUS_DATA: dataDir, AGENTUS_AUTH: "off" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
proc.stdout.on("data", (d) => { log += String(d); });
proc.stderr.on("data", (d) => { log += String(d); });
const cleanup = () => { try { process.kill(-proc.pid, "SIGKILL"); } catch { /* gone */ } };
process.on("exit", cleanup);
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 120 && !log.includes(`0.0.0.0:${PORT}`); i++) await sleep(150);
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }

const api = async (p, init = {}) => {
  const res = await fetch(`${BASE}${p}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  return res.status === 204 ? null : res.json().catch(() => null);
};
const wsDir = mkdtempSync(path.join(tmpdir(), "hold-ws-"));
const created = await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "mock", cwd: wsDir, title: "按住说话" }) });
const sid = created?.id;
for (let i = 0; i < 60; i++) {
  const rows = await api("/api/sessions");
  const row = [...(rows?.live ?? []), ...(rows?.cold ?? [])].find((s) => s.id === sid);
  if (row && row.status === "ready") break;
  await sleep(250);
}

// ------------------------------------------------------------------ browser
const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(2400);
const wsCdp = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { wsCdp.onopen = res; wsCdp.onerror = rej; });
let mid = 0;
const waiting = new Map();
wsCdp.onmessage = (e) => {
  const m = JSON.parse(e.data);
  const w = waiting.get(m.id);
  if (w) { waiting.delete(m.id); m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result); }
};
const send = (method, params = {}, to = 25000) => new Promise((res, rej) => {
  const id = ++mid;
  const timer = setTimeout(() => { waiting.delete(id); rej(new Error(`TIMEOUT ${method}`)); }, to);
  waiting.set(id, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
  wsCdp.send(JSON.stringify({ id, method, params }));
});
const ev = async (expr, to = 25000) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, to);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};

const STUB = `(() => {
  try { localStorage.setItem("agentus.voice", JSON.stringify({ serverTts: false, rate: 1, lang: "zh-CN", autoRead: false, stt: "browser" })); } catch {}
  // 一个永远不会自己结束的"识别器"：这一轮关心的是**手势有没有接到收音入口**，不是识别质量。
  // 用浏览器那条通道（stt: "browser"）是为了不必依赖这台实例上有 ASR 端点。
  window.__recStarts = 0;
  window.__recStops = 0;
  class FakeRec {
    constructor() { this.lang = ""; this.continuous = false; this.interimResults = false; this.maxAlternatives = 1; }
    start() { window.__recStarts++; window.__rec = this; setTimeout(() => this.onstart && this.onstart(), 0); }
    stop() { window.__recStops++; setTimeout(() => this.onend && this.onend(), 0); }
    abort() { setTimeout(() => this.onend && this.onend(), 0); }
  }
  window.SpeechRecognition = FakeRec;
  window.webkitSpeechRecognition = FakeRec;
  return true;
})()`;

// 麦克风：给一个真的（静音）MediaStream，否则 dictation 一开口就报权限错，
// 就分不清「手势没接到」和「麦克风被拒」了。
await ev(`(() => { try { localStorage.removeItem("agentus.hint.hold-to-talk"); } catch {} return true; })()`);
await send("Page.addScriptToEvaluateOnNewDocument", { source: STUB });
await send("Page.reload", {});
await sleep(3200);
await ev(STUB);

// 打开会话
await ev(`(() => { const hit = [...document.querySelectorAll(".session-item")].find((r) => /按住说话/.test(r.textContent || "")); hit && hit.click(); return true; })()`);
await sleep(2200);

const box = async (sel) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
const press = (x, y, type = "mousePressed") => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, pointerType: "mouse" });
const move = (x, y) => send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1, pointerType: "mouse" });
const chip = async () => ev(`(() => { const c = document.querySelector(".dict-chip"); return c ? c.textContent.replace(/\\s+/g, " ").trim() : ""; })()`);
const hint = async () => ev(`(() => { const c = document.querySelector('[data-hold-hint]'); return c ? c.textContent.replace(/\\s+/g, " ").trim() : ""; })()`);

const MIC = '.composer .icon-btn[aria-label="dictate"]';
const micPos = await box(MIC);
check("the session composer's microphone button is on screen", Boolean(micPos), JSON.stringify(micPos));

// ---- 1. 按住麦克风：够久就开始收音
await press(micPos.x, micPos.y);
await sleep(700);
const during = await chip();
check("holding the microphone starts dictation (no click needed)", Boolean(during) && !/error|not allowed/i.test(during), during);

// ---- 2. P0 核心判据：按住期间"离开按钮"不能断录
// 真实形状是输入框变高、状态条出现，把按钮自己顶下去；这里直接把指针移到别处 = 最坏情况。
await move(micPos.x + 40, micPos.y - 120);
await sleep(300);
const afterLeave = await chip();
check("moving the pointer off the button does NOT cut the recording", Boolean(afterLeave) && afterLeave.length > 0, afterLeave);
const starts = await ev("window.__recStarts");
check("…and the recorder was started exactly once", starts === 1, String(starts));

// ---- 3. 松手即停 + 一次性提示
await press(micPos.x + 40, micPos.y - 120, "mouseReleased");
await sleep(900);
const stops = await ev("window.__recStops");
check("releasing stops the recording", stops >= 1, `starts=${await ev("window.__recStarts")} stops=${stops}`);
const hintText = await hint();
check("the first hold shows the one-time hint", /按住麦克风/.test(hintText), hintText);
check("…and it promises the textarea gesture on a fine pointer", /输入框里长按鼠标左键/.test(hintText) === (await ev(`matchMedia("(pointer: fine)").matches`)), hintText);

// ---- 4. 短按仍然等于"点一下开始"（老用法没被拿走）
await ev(`document.querySelector('[data-hold-hint] .dict-stop')?.click()`);
await press(micPos.x, micPos.y);
await sleep(120);
await press(micPos.x, micPos.y, "mouseReleased");
await sleep(700);
const afterTap = await chip();
check("a short tap still starts dictation (the old behaviour)", Boolean(afterTap) && afterTap.length > 0, afterTap);
await ev(`document.querySelector(".dict-chip .dict-stop")?.click()`);
await sleep(600);

// ---- 5. 提示只出现一次（刷新之后不再烦人）
await send("Page.reload", {});
await sleep(3000);
await ev(STUB);
await ev(`(() => { const hit = [...document.querySelectorAll(".session-item")].find((r) => /按住说话/.test(r.textContent || "")); hit && hit.click(); return true; })()`);
await sleep(2200);
const mic2 = await box(MIC);
await press(mic2.x, mic2.y);
await sleep(700);
await press(mic2.x, mic2.y, "mouseReleased");
await sleep(900);
check("the hint does not come back on the second hold", (await hint()) === "", await hint());
await ev(`document.querySelector(".dict-chip .dict-stop")?.click()`);
await sleep(500);

// ---- 6. 输入框里长按左键（P1）：不移动 → 说话；移动 → 交给原生拖选
const taPos = await box(".composer textarea");
check("the composer textarea is on screen", Boolean(taPos), JSON.stringify(taPos));
await ev(`document.querySelector(".composer textarea").focus()`);
await sleep(200);
const opensBefore = await ev("window.__recStarts");
await press(taPos.x, taPos.y);
await sleep(700);
const areaDict = await chip();
check("holding the left button inside the textarea starts dictation", Boolean(areaDict) && (await ev("window.__recStarts")) > opensBefore, areaDict);
await press(taPos.x, taPos.y, "mouseReleased");
await sleep(800);
await ev(`document.querySelector(".dict-chip .dict-stop")?.click()`);
await sleep(600);

const opensBefore2 = await ev("window.__recStarts");
await press(taPos.x, taPos.y);
await sleep(60);
await move(taPos.x + 80, taPos.y);       // 拖选：越过 12px
await sleep(700);
check("dragging inside the textarea does NOT start recording", (await ev("window.__recStarts")) === opensBefore2, String(await ev("window.__recStarts")));
const selText = await ev(`(() => { const ta = document.querySelector(".composer textarea"); ta.value = "选择这段文字"; ta.focus(); ta.setSelectionRange(0, 2); const s = window.getSelection(); return document.activeElement === ta; })()`);
await press(taPos.x, taPos.y, "mouseReleased");
check("selection inside the textarea survives (native drag-select untouched)", selText === true);
await sleep(400);

cleanup();
console.log(`\nhold-to-talk-sweep: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
