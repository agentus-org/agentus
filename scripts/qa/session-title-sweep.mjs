// Session names — generated, and regenerable from the CURRENT conversation.
//
// The claims that need evidence (none of them is "an element exists"):
//   · a new slot stops being "<backend> @ <dir>" the moment something is asked;
//   · the agent's own title (ACP `session_info_update`) is adopted when a backend sends one
//     — that is where the intelligence lives, not in this layer;
//   · "重新生成会话名" asks the AGENT, on a throwaway FORK, so the name reflects the LATEST
//     context — and the session's own transcript is left completely untouched;
//   · a backend without `session/fork` (and any failure) degrades to the latest prompt;
//   · a hand-written name is never overwritten by an automatic one, and clearing it restores
//     the generated one; asking for a regeneration on purpose DOES replace it.
//
// Self-contained: its own AgentSlot instance + the user's Edge over CDP, mock agent only.
//   node scripts/qa/session-title-sweep.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createTcp } from "node:net";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CDP = "http://127.0.0.1:9222";
const SHOTS = process.env.SHOTS ?? path.resolve(ROOT, "../../tasks/20261001-agentslot/screens");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

// ------------------------------------------------------------------ own instance
const freePort = () => new Promise((res, rej) => {
  const s = createTcp();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});
const PORT = await freePort();
const dataDir = mkdtempSync(path.join(tmpdir(), "agentslot-title-"));
const emptyHome = mkdtempSync(path.join(tmpdir(), "agentslot-title-home-"));
const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: "development", HOME: emptyHome, AGENTSLOT_PORT: String(PORT), AGENTSLOT_DATA: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
proc.stdout.on("data", (d) => { log += String(d); });
proc.stderr.on("data", (d) => { log += String(d); });
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 100 && !log.includes(`0.0.0.0:${PORT}`); i++) await sleep(150);
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }
const TOKEN = (await import("node:fs")).readFileSync(path.join(dataDir, "auth.token"), "utf8").trim();
const CHILDREN = [];
const H = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
const api = async (method, url, body) => {
  const res = await fetch(BASE + url, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
};
const rows = async () => {
  const { body } = await api("GET", "/api/sessions");
  return [...(body?.live ?? []), ...(body?.archived ?? [])];
};
const rowOf = async (id) => (await rows()).find((r) => r.id === id) ?? null;
const msgs = async (id) => (await api("GET", `/api/sessions/${id}/messages?limit=500`)).body?.messages ?? [];

const newSession = async (cwd = "/tmp") => (await api("POST", "/api/sessions", { backend: "mock", cwd })).body;
const say = async (id, text) => { await api("POST", `/api/sessions/${id}/prompt`, { text }); };
const settle = async (id, ms = 12000) => {
  for (let i = 0; i < ms / 200; i++) {
    const r = await rowOf(id);
    if (r && r.status !== "running" && r.status !== "starting") return r;
    await sleep(200);
  }
  return rowOf(id);
};

console.log("instance:", BASE, "data:", dataDir);

// ---------------------------------------------------------------- the derived first name
const PLACEHOLDER = "Mock Agent @ tmp";
const a = await newSession();
check("a fresh session is called \"<backend> @ <dir>\" — a placeholder, not a name",
  a.title === PLACEHOLDER && a.autoTitle === PLACEHOLDER, JSON.stringify({ title: a.title }));

await say(a.id, "# 帮我重构登录模块\n后面的内容不该出现在名字里");
await settle(a.id);
let r = await rowOf(a.id);
check("the first prompt names the session (markdown furniture stripped, one line)",
  r.title === "帮我重构登录模块" && r.autoTitle === "帮我重构登录模块",
  JSON.stringify({ title: r.title, autoTitle: r.autoTitle }));

await say(a.id, "再补充一点：token 刷新用轮转的方式");
await settle(a.id);

// ---------------------------------------------------------------- regenerate: the AGENT path
const before = await msgs(a.id);
const countBefore = before.length;
const sessionsBefore = (await rows()).length;
const t0 = Date.now();
const regen = await api("POST", `/api/sessions/${a.id}/title/regenerate`);
const took = Date.now() - t0;
r = await rowOf(a.id);
check("regenerating asks the agent (via=agent) and the name reflects the conversation",
  regen.status === 200 && regen.body?.via === "agent" && /继承 2 轮上下文/.test(r.autoTitle ?? ""),
  JSON.stringify({ via: regen.body?.via, autoTitle: r.autoTitle, took: `${(took / 1000).toFixed(1)}s` }));
check("...and it is a genuinely new name, not the derived one echoed back",
  r.autoTitle !== "再补充一点：token 刷新用轮转的方式", JSON.stringify({ title: r.title }));
check("the session's own transcript is untouched by the regeneration",
  (await msgs(a.id)).length === countBefore, `messages ${countBefore} -> ${(await msgs(a.id)).length}`);
check("the throwaway fork never becomes a session in the rail",
  (await rows()).length === sessionsBefore, `sessions ${sessionsBefore} -> ${(await rows()).length}`);
check("both the display title and the generated name moved together",
  r.title === r.autoTitle, JSON.stringify({ title: r.title, autoTitle: r.autoTitle }));

// ---------------------------------------------------------------- authority: the operator's name
await api("POST", `/api/sessions/${a.id}/rename`, { title: "登录重构（我起的名字）" });
await say(a.id, "顺手把日志也统一一下");
await settle(a.id);
r = await rowOf(a.id);
check("a hand-written name is never overwritten by an automatic title",
  r.title === "登录重构（我起的名字）", JSON.stringify({ title: r.title, autoTitle: r.autoTitle }));
check("...and a later prompt does NOT re-derive over that fallback (a derived name is a start, not a running commentary)",
  r.autoTitle === "继承 2 轮上下文的标题", JSON.stringify({ autoTitle: r.autoTitle }));

await api("POST", `/api/sessions/${a.id}/rename`, { title: "" });
r = await rowOf(a.id);
check("clearing the rename falls back to the generated name", r.title === r.autoTitle,
  JSON.stringify({ title: r.title, autoTitle: r.autoTitle }));

await api("POST", `/api/sessions/${a.id}/rename`, { title: "临时名字" });
const forced = await api("POST", `/api/sessions/${a.id}/title/regenerate`);
r = await rowOf(a.id);
check("an explicit regeneration DOES replace a hand-written name (it was asked for)",
  forced.status === 200 && r.title !== "临时名字" && r.title === r.autoTitle,
  JSON.stringify({ via: forced.body?.via, title: r.title }));

// ---------------------------------------------------------------- degradation
const cold = await newSession("/tmp");
await say(cold.id, "看看这个构建脚本为什么慢");
await settle(cold.id);
await api("DELETE", `/api/sessions/${cold.id}`);
await sleep(400);
const coldRegen = await api("POST", `/api/sessions/${cold.id}/title/regenerate`);
const coldRow = await rowOf(cold.id);
check("a cold slot (no live agent) still gets a name — from its latest prompt",
  coldRegen.status === 200 && coldRegen.body?.via === "derived" && coldRow.autoTitle === "看看这个构建脚本为什么慢",
  JSON.stringify({ via: coldRegen.body?.via, title: coldRow.autoTitle }));

const empty = await newSession("/tmp");
const emptyRegen = await api("POST", `/api/sessions/${empty.id}/title/regenerate`);
check("an empty session refuses instead of inventing a name",
  emptyRegen.status === 409 && /没有可以用来生成标题/.test(emptyRegen.body?.error ?? ""),
  JSON.stringify(emptyRegen));

// ---------------------------------------------------------------- the UI
await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" }).then((x) => x.json());
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
  const res = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, to);
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? "eval failed");
  return res.result.value;
};
await send("Page.enable"); await send("Runtime.enable");
await ev(`(async () => { await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: '123456' }) }); return true; })()`);
await send("Page.reload", { ignoreCache: true });
await sleep(3400);

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

const clickByText = async (text) => {
  const box = await ev(`(() => { const el = [...document.querySelectorAll('.sess-menu .sess-menu-item')]
      .find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}));
    if (!el) return null; const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, hits: !!hit && (hit === el || el.contains(hit) || hit.contains(el)), at: hit ? (hit.className || hit.tagName) : null }; })()`);
  if (!box) throw new Error(`no menu item starting with ${text}`);
  if (!box.hits) throw new Error(`menu item ${text} is covered by ${box.at}`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
};
const openMenu = async (sid) => {
  await ev(`document.querySelector('.sess-menu') && document.body.click()`);
  await sleep(200);
  await click(`[data-session="${sid}"] .row-menu`);
  await sleep(400);
};
const menuItems = () => ev(`[...document.querySelectorAll('.sess-menu .sess-menu-item')].map((b) => b.textContent.trim())`);
const railTitle = (sid) => ev(`document.querySelector('[data-session="${sid}"] .title')?.textContent ?? null`);

// --- the menu offers it, right next to the rename it belongs with
await openMenu(a.id);
const items = await menuItems();
check("the session menu offers 重新生成会话名, directly under 重命名",
  items[0] === "重命名" && items[1] === "重新生成会话名", JSON.stringify(items.slice(0, 3)));
check("the item carries the refresh icon (not another pencil)",
  await ev(`(() => { const it = [...document.querySelectorAll('.sess-menu .sess-menu-item')][1];
    const svg = it?.querySelector('svg'); return !!svg && svg.innerHTML.includes('M'); })()`) === true);

// --- clicking it asks, shows that it is working, then the row changes.
// Give the rail a name that cannot be confused with the answer (the mock's answer is a
// function of the conversation, so regenerating twice with no new context returns the same
// string — asserting on "the name differs" would be testing the mock, not the UI).
await api("POST", `/api/sessions/${a.id}/rename`, { title: "UI 里点一下试试" });
await sleep(300);
const titleBeforeClick = await railTitle(a.id);
await clickByText("重新生成会话名");
await sleep(250);
const busyLabel = await ev(`([...document.querySelectorAll('.sess-menu .sess-menu-item')].map((b) => b.textContent.trim())
  .find((t) => t.includes("重新生成")) ?? null)`);
const spinning = await ev(`!!document.querySelector('.sess-menu .sess-menu-item .spin')`);
check("clicking it puts the item into a visible working state (spinner + 正在重新生成…)",
  busyLabel === "正在重新生成…" && spinning === true, JSON.stringify({ busyLabel, spinning }));
let updated = null;
for (let i = 0; i < 60; i++) {
  await sleep(250);
  const t = await railTitle(a.id);
  if (t && t !== titleBeforeClick) { updated = t; break; }
}
check("the rail row shows the regenerated name once the agent answers",
  titleBeforeClick === "UI 里点一下试试" && Boolean(updated) && /继承 3 轮上下文/.test(updated),
  JSON.stringify({ before: titleBeforeClick, after: updated }));
check("the menu closes itself when the work is done",
  await ev(`!document.querySelector('.sess-menu')`) === true);

// --- a failure is visible, not silent
await openMenu(empty.id);
await clickByText("重新生成会话名");
let errText = null;
for (let i = 0; i < 40; i++) {
  await sleep(250);
  errText = await ev(`document.querySelector('.rail-error')?.textContent ?? null`);
  if (errText) break;
}
check("a refused regeneration surfaces the reason in the UI",
  Boolean(errText) && /生成会话名失败/.test(errText), JSON.stringify(errText));

const shot = await send("Page.captureScreenshot", { format: "png" }, 30000);
writeFileSync(`${SHOTS}/session-title-menu.png`, Buffer.from(shot.data, "base64"));

// ------------------------------------------------------------------ teardown
console.log(`\n${pass} passed, ${fail} failed`);
for (const c of CHILDREN) { try { process.kill(c, "SIGKILL"); } catch { /* gone */ } }
proc.kill("SIGKILL");
try { await fetch(`${CDP}/json/close/${tab.id}`); } catch { /* tab already gone */ }
console.log("shot: session-title-menu.png");
process.exit(fail ? 1 : 0);
