// 播报 L0 规则层 + L1 全文总结版，在真浏览器里走一遍（issue #83）。
//
// 单测（speakable-units.mts）证明了「哪些字被换成哪句话」。这里只证明四件只有真页面才能回答的事：
//   · 点喇叭之后，**真正被送去念的**是规则版 rewrite 之后的那份稿子（不是原文）；
//   · 「念稿」那一行在消息下面出现，meta 说清了跳过什么、大概念多久；
//   · 长按菜单里「读整条」带时长预告；
//   · 菜单里多了「全文总结版播报」，点下去真的会去打 /speech-summary（没配 key 时报错，而不是假装成功）。
//
// 自给自足：自己的 Agentus（mock 后端，AGENTUS_AUTH=off）、临时数据目录、操作员的 Edge（CDP）。
//   CDP=http://127.0.0.1:9223 node scripts/qa/speakable-sweep.mjs
import { execFileSync, spawn } from "node:child_process";
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
const dataDir = mkdtempSync(path.join(tmpdir(), "agentus-speak-"));
const emptyHome = mkdtempSync(path.join(tmpdir(), "agentus-speak-home-"));
const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
  detached: true,
  cwd: ROOT,
  // AUTH off: this sweep is about the speaker, not about logging in. The instance is on loopback
  // with a throwaway data dir and dies with the sweep.
  env: { ...process.env, NODE_ENV: "development", HOME: emptyHome, AGENTUS_PORT: String(PORT), AGENTUS_DATA: dataDir, AGENTUS_AUTH: "off" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
proc.stdout.on("data", (d) => { log += String(d); });
proc.stderr.on("data", (d) => { log += String(d); });
const BASE = `http://127.0.0.1:${PORT}`;
const cleanup = () => { try { process.kill(-proc.pid, "SIGKILL"); } catch { /* gone */ } };
process.on("exit", cleanup);
for (let i = 0; i < 120 && !log.includes(`0.0.0.0:${PORT}`); i++) await sleep(150);
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }

const api = async (p, init = {}) => {
  const res = await fetch(`${BASE}${p}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  return res.status === 204 ? null : res.json().catch(() => null);
};

// ---- 一条 agent 消息：mock 后端每轮都会带表格 + 代码块 + 链接（MOCK_MARKDOWN）
const ws = mkdtempSync(path.join(tmpdir(), "speak-ws-"));
const created = await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "mock", cwd: ws, title: "播报规则版" }) });
const sid = created?.id;
for (let i = 0; i < 60; i++) {
  const rows = await api("/api/sessions");
  const row = [...(rows?.live ?? []), ...(rows?.cold ?? [])].find((s) => s.id === sid);
  if (row && row.status === "ready") break;
  await sleep(250);
}
await api(`/api/sessions/${sid}/prompt`, { method: "POST", body: JSON.stringify({ text: "演示一下" }) });
let agentMsg = null;
for (let i = 0; i < 80; i++) {
  const page = await api(`/api/sessions/${sid}/messages?tail=20`);
  const rows = page?.messages ?? page?.rows ?? page ?? [];
  agentMsg = [...rows].reverse().find((m) => m.kind === "agent" && /mock markdown sample|代码|table/i.test(JSON.stringify(m)));
  if (agentMsg && /mock markdown sample/.test(JSON.stringify(agentMsg))) break;
  await sleep(300);
}
check("there is a reply with a table, a fence and a link to read", Boolean(agentMsg), agentMsg ? String(agentMsg.key ?? "").slice(0, 12) : "no reply");

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
/** 点（或右键）**最后一个**匹配的元素：`.msg.agent` 里的最后一条回复就是我们要念的那条。 */
const hitLast = (kind) => (sel) => ev(`(() => {
  const all = [...document.querySelectorAll(${JSON.stringify(sel)})];
  const el = all[all.length - 1];
  if (!el) return false;
  ${kind === "click" ? "el.click();" : 'el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));'}
  return true;
})()`);
const click = hitLast("click");
const rightClick = hitLast("contextmenu");

await sleep(1200);
// 浏览器语音 + 录下真正被送去念的句子：这一层断言的正是「送出去的是什么」，不是「UI 上显示了什么」。
await ev(`(() => {
  try { localStorage.setItem("agentus.voice", JSON.stringify({ serverTts: false, rate: 1, lang: "zh-CN", autoRead: false, stt: "auto" })); } catch {}
  window.__spoken = [];
  const ss = window.speechSynthesis;
  if (ss) {
    ss.getVoices = () => [{ name: "qa", lang: "zh-CN", voiceURI: "qa", localService: true, default: true }];
    ss.cancel = () => {};
    ss.speak = (u) => { window.__spoken.push(String(u.text || "")); try { u.onend && setTimeout(() => u.onend({}), 0); } catch {} };
  }
  return true;
})()`);
await send("Page.reload", { ignoreCache: false });
await sleep(3000);
await ev(`(() => {
  window.__spoken = [];
  const ss = window.speechSynthesis;
  if (ss) {
    ss.getVoices = () => [{ name: "qa", lang: "zh-CN", voiceURI: "qa", localService: true, default: true }];
    ss.cancel = () => {};
    ss.speak = (u) => { window.__spoken.push(String(u.text || "")); try { u.onend && setTimeout(() => u.onend({}), 0); } catch {} };
  }
  return true;
})()`);

// 打开这条会话
const opened = await ev(`(() => {
  const rows = [...document.querySelectorAll(".session-item, .rail-row, .session-row")];
  const hit = rows.find((r) => /播报规则版/.test(r.textContent || ""));
  if (hit) { hit.click(); return "clicked"; }
  return "not-found";
})()`);
await sleep(2200);

// ---- 1. 点喇叭：送去念的是规则版稿子
const spokeClick = await click(".msg.agent .bubble-actions .speak");
check("the reply's speaker button is on screen", spokeClick === true, `rail=${opened}`);
for (let i = 0; i < 60 && ((await ev("window.__spoken.length")) ?? 0) === 0; i++) await sleep(200);
const spoken = await ev("window.__spoken.join(' | ')");
check("the speaker really produced utterances", Boolean(spoken && spoken.length), String(spoken).slice(0, 160));
check("code fences are announced, not read", /代码块，\d+ 行/.test(spoken), String(spoken).slice(0, 200));
check("no English \"code block\" is read out any more", !/code block/i.test(spoken), String(spoken).slice(0, 200));
// 注意别用 join(" | ") 去判管道符：那个分隔符是自己加的（第一版就这么误判过一次）。
const pipes = await ev("window.__spoken.some((u) => u.includes('|'))");
check("the table's rows are read, not its pipes", /第一行/.test(spoken) && pipes === false, String(spoken).slice(0, 240));
check("a link loses its protocol", !/https?:\/\//.test(spoken), String(spoken).slice(0, 240));
check("the heading/list text still gets said", /mock markdown sample|first/.test(spoken), String(spoken).slice(0, 240));

// ---- 2. 念稿那一行：看得见「它念了什么、漏了什么」
await sleep(600);
const note = await ev(`(() => {
  const el = document.querySelector('[data-speak-script="rules"]');
  if (!el) return null;
  return reg();
  function reg() {
    const tag = el.querySelector(".script-note-tag")?.textContent ?? "";
    const meta = el.querySelector(".script-note-meta")?.textContent ?? "";
    const body = el.querySelector(".script-note-text")?.textContent ?? "";
    return { tag, meta, body };
  }
})()`);
check("a 「念稿」 line appears under the message", note?.tag === "念稿", JSON.stringify(note)?.slice(0, 120));
check("its meta says what was skipped", /规则版/.test(note?.meta ?? "") && /跳过 \d+ 个代码块/.test(note?.meta ?? ""), note?.meta);
check("its meta warns how long it will take", /约 \d+ (秒|分钟)/.test(note?.meta ?? ""), note?.meta);
check("the line carries the spoken script itself", /代码块/.test(note?.body ?? ""), String(note?.body).slice(0, 120));

// ---- 3. 长按菜单：读整条带时长预告 + 全文总结版
const menu = await rightClick(".msg.agent .bubble-actions .speak");
await sleep(400);
const items = await ev(`[...document.querySelectorAll(".speak-menu .speak-menu-item")].map((b) => ({
  mode: b.getAttribute("data-speak-summary"),
  name: (b.querySelector(".speak-name")?.textContent ?? "").trim(),
}))`);
check("long press opens the menu", menu === true && Array.isArray(items) && items.length >= 5, JSON.stringify(items)?.slice(0, 200));
const readAll = (items ?? []).find((i) => i.mode === "verbatim");
check("「读整条」 carries a duration estimate", /读整条 · 约 \d+ (秒|分钟)/.test(readAll?.name ?? ""), readAll?.name);
const full = (items ?? []).find((i) => i.mode === "full");
check("the menu gained 「全文总结版播报」", full?.name === "全文总结版播报", full?.name);
check("the 字数档 items are still there", (items ?? []).filter((i) => /^\d+$/.test(i.mode ?? "")).length === 3, JSON.stringify((items ?? []).map((i) => i.mode)));

// ---- 4. 全文总结版真的去打端点
// ---- 4. 全文总结版真的去打端点：这台实例没配 key，所以必须是**诚实的失败**，不能假装成功
await ev("window.__spoken = []");
const fullClick = await click('[data-speak-summary="full"]');
for (let i = 0; i < 40; i++) {
  const err = await ev(`(() => { const e = document.querySelector(".bubble-note.err"); return e ? e.textContent : ""; })()`);
  if (err) break;
  await sleep(250);
}
const errText = await ev(`(() => { const e = document.querySelector(".bubble-note.err"); return e ? e.textContent : ""; })()`);
check("「全文总结版播报」 is clickable", fullClick === true);
check("a refusing endpoint is reported, never faked", Boolean(errText) && errText.length > 0, String(errText).slice(0, 120));
check("…and it did NOT start reading the original instead", (await ev("window.__spoken.length")) === 0, String(await ev("window.__spoken.join(' ')"))?.slice(0, 80));

// ---- 5. L1 的服务端半截：全文版必须发自己那份提示词、按输入比例给输出预算
//
// 真模型调用要花钱、也不该在 QA 里跑，所以这里用一个本地假上游（OpenAI 兼容）把**请求体**截下来。
// 判的不是「答得好不好」，是「发出去的到底是什么」：有没有换成 full 提示词、预算够不够长。
const stubPort = await freePort();
let captured = null;
const http = await import("node:http");
const stub = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => raw += d);
  req.on("end", () => {
    captured = raw;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "第一件事。第二件事。" }, finish_reason: "stop" }] }));
  });
});
await new Promise((r) => stub.listen(stubPort, "127.0.0.1", r));
const saved = await api("/api/settings", { method: "PUT", body: JSON.stringify({ voice: { baseUrl: `http://127.0.0.1:${stubPort}/v1`, apiKey: "sk-qa-key-123456" } }) });
// PUT /api/settings 回的是 publicSettings()，语音那一节就摊在顶层（不是 {voice:{…}}）。
check("the QA instance accepts a local voice endpoint", Boolean(saved?.baseUrl) && saved?.apiKeySet === true, JSON.stringify(saved).slice(0, 120));

// `key` 是库里那条消息的 block_key（浏览器用的是同一个值）；名单 API 不带它，所以直接问库。
const key = execFileSync("sqlite3", [
  path.join(dataDir, "agentus.sqlite"),
  `select block_key from messages where session_id='${sid}' and kind='agent' order by seq desc limit 1;`,
], { encoding: "utf8" }).trim();
check("we found the message key the browser will ask with", /^agent:/.test(key), key);
const fullRes = await api(`/api/sessions/${sid}/speech-summary`, { method: "POST", body: JSON.stringify({ key, mode: "full" }) });
const body = captured ? JSON.parse(captured) : null;
const sys = String(body?.messages?.[0]?.content ?? "");
check("full mode answers 200 and says which mode it used", fullRes?.ok === true && fullRes?.mode === "full", JSON.stringify(fullRes)?.slice(0, 120));
check("it sends the 全文 prompt, not the 字数档 one", /覆盖每一个部分/.test(sys) && !/不超过 \{?maxChars\}? 字/.test(sys), sys.slice(0, 80));
check("the output budget follows the INPUT, not a 字数档", Number(body?.max_completion_tokens) >= 1200, String(body?.max_completion_tokens));
check("the whole message was sent, not a truncated head", String(body?.messages?.[1]?.content ?? "").includes("mock markdown sample"));

// 同一个 key、默认 mode 的那一路仍然是旧的摘要提示词（两条路不互相污染）
captured = null;
const sumRes = await api(`/api/sessions/${sid}/speech-summary`, { method: "POST", body: JSON.stringify({ key, maxChars: 150 }) });
const sys2 = String((captured ? JSON.parse(captured) : null)?.messages?.[0]?.content ?? "");
check("the 字数档 path still uses the summary prompt", sumRes?.ok === true && /不超过 150 字/.test(sys2), sys2.slice(0, 80));
stub.close();

cleanup();
console.log(`\nspeakable-sweep: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
