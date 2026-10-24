// #58 (P0): during a call, the work in progress is audible — and it shuts up when the answer starts.
//
// The blind spot this pins: dial a session, speak, and the agent disappears for a minute (thinking, a
// tool run, a plan). On a screen there is an orb and a tool card; on a CALL there was nothing, so a
// long tool run and a dead line felt the same. The fix is event-driven and throttled (see
// call-brief.ts): one leading ack, then quiet, and everything still held is DROPPED the moment the
// answer begins — a cue that arrives after the work is done is worse than silence.
//
// What is asserted here, in a real browser against a real instance:
//   1. a silent turn gets ONE short cue, on screen and (through the same speaker path) out loud;
//   2. the cue disappears when the turn ends — no stale line left claiming the agent is still working;
//   3. switching the preference off (a per-device choice, like captions and the interrupt mode) makes
//      the call silent again, and the toggle lives in the call's own settings panel;
//   4. a fast turn (answer starts before the leading delay) says nothing extra.
//
// Run: node scripts/qa/call-brief-sweep.mjs        (needs the user's Edge on CDP :9223)
import { spawn } from "node:child_process";
import { createServer as createTcp } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CDP = process.env.CDP ?? "http://127.0.0.1:9223";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const freePort = () => new Promise((res, rej) => {
  const s = createTcp();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});
const PORT = await freePort();
const dataDir = mkdtempSync(path.join(tmpdir(), "agentus-brief-"));
const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
  detached: true,
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: "development", AGENTUS_PORT: String(PORT), AGENTUS_DATA: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
proc.stdout.on("data", (d) => { log += String(d); });
proc.stderr.on("data", (d) => { log += String(d); });
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 100 && !log.includes(`0.0.0.0:${PORT}`); i += 1) await sleep(150);
for (let i = 0; i < 80; i += 1) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }
const token = () => readFileSync(path.join(dataDir, "auth.token"), "utf8").trim();
const api = async (p, opts = {}) => {
  const r = await fetch(`${BASE}${p}`, { ...opts, headers: { authorization: `Bearer ${token()}`, ...(opts.body ? { "content-type": "application/json" } : {}), ...(opts.headers ?? {}) } });
  const text = await r.text();
  return { status: r.status, text, json: () => (text ? JSON.parse(text) : null) };
};

const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(2500);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const waiting = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { const x = waiting.get(m.id); waiting.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); }
};
const send = (method, params = {}, to = 30000) => new Promise((res, rej) => {
  const mid = ++id; const timer = setTimeout(() => { waiting.delete(mid); rej(new Error(`TIMEOUT ${method}`)); }, to);
  waiting.set(mid, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expr, to = 30000) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, to);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};
const click = async (sel) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`);

// 按键打断 mode: the mic is closed, so a cue played on the speaker cannot be picked up by our own
// capture and distort what this sweep measures.
await api("/api/settings", { method: "PUT", body: JSON.stringify({ call: { interruptMode: "button" } }) });
const setup = await ev(`(async () => {
  await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }) });
  const s = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ backend: 'mock', cwd: '/tmp' }) }).then((r) => r.json());
  localStorage.setItem('agentus.active', s.id);
  localStorage.removeItem('agentus.call.brief');
  return { sid: s.id };
})()`);
const SID = setup.sid;
check("fixture: a session to call", Boolean(SID), String(SID));
await send("Browser.grantPermissions", { origin: BASE, permissions: ["audioCapture"] }).catch(() => {});
await send("Page.navigate", { url: BASE });
for (let i = 0; i < 40; i += 1) { if (await ev("!!document.querySelector('.composer, .chat-head')")) break; await sleep(500); }
await sleep(600);

const inCall = () => ev("!!document.querySelector('.call-screen, .call-wrap, .call-orb')");
await click('button[aria-label="开始语音通话"]');
for (let i = 0; i < 30 && !(await inCall()); i += 1) await sleep(300);
check("the call is open", (await inCall()) === true);
await ev(`window.__asFeed = { level: 0, text: '', interim: '' }; true`);   // no microphone in automation

const cueText = () => ev(`(() => { const el = document.querySelector('.call-cue');
  return el ? el.textContent.trim() : null; })()`);

// ---- 1. a turn that goes quiet is not allowed to go silent -------------------------------
// `[hold:12000]` is a turn that is IN FLIGHT and silent for 12 s: the exact window the operator
// cannot tell from a dropped call.
await api(`/api/sessions/${SID}/prompt`, { method: "POST", body: JSON.stringify({ text: "[hold:12000] 我在想" }) });
let firstCue = null;
let cueAt = 0;
for (let i = 0; i < 40; i += 1) {
  await sleep(250);
  const t = await cueText();
  if (t) { firstCue = t; cueAt = i * 250; break; }
}
if (firstCue == null) {
  console.log("      debug:", JSON.stringify(await ev(`({ turn: window.__briefTurn ?? null, ticks: window.__briefTicks ?? 0, cues: window.__briefCues ?? [], phase: document.querySelector('.call-screen')?.dataset?.phase ?? null })`)));
}
check("a silent turn gets a cue instead of dead air (#58)", firstCue != null, String(firstCue));
check("…and it is the short leading ack, not a paragraph", firstCue === "我查一下", String(firstCue));
check("…arriving a couple of seconds in, not instantly", cueAt >= 1500 && cueAt <= 9000, `${cueAt}ms`);
check("the cue is a REAL sentence the operator can hear (speaker was handed the same text)",
  (await ev(`(document.querySelector('.call-cue')?.dataset.cue ?? '')`)) === firstCue);

// ---- 2. it must not outlive the turn ------------------------------------------------------
// let the 12 s turn run out on its own: the cue must go when the TURN goes, not when we ask it to
for (let i = 0; i < 90; i += 1) {
  const rows = (await api("/api/sessions")).json();
  const row = [...(rows?.live ?? []), ...(rows?.cold ?? []), ...(rows?.archived ?? [])].find((r) => r.id === SID);
  if (!row || row.status !== "running") break;
  await sleep(500);
}
for (let i = 0; i < 40 && (await cueText()) !== null; i += 1) await sleep(250);
check("the cue disappears when the turn ends (no stale 「still working」 line)", (await cueText()) === null);

// ---- 3. the switch is real, and it is in the call's own settings ---------------------------
await click(".call-gear");
await sleep(400);
const toggle = await ev(`(() => { const labels = [...document.querySelectorAll('.call-sheet .call-check')].map((l) => l.textContent.replace(/\\s+/g, ' ').trim());
  return { labels, checked: [...document.querySelectorAll('.call-sheet .call-check input[type=checkbox]')].map((i) => i.checked) }; })()`);
check("the call settings carry a 报进度 switch, on by default",
  toggle.labels.some((t) => /报进度/.test(t)), JSON.stringify(toggle.labels));
await click(".call-sheet-x");
await sleep(300);

await ev(`localStorage.setItem('agentus.call.brief', '0'); true`);
await send("Page.reload", { ignoreCache: true });
for (let i = 0; i < 40; i += 1) { if (await ev("!!document.querySelector('.composer, .chat-head')")) break; await sleep(500); }
await sleep(500);
await click('button[aria-label="开始语音通话"]');
for (let i = 0; i < 30 && !(await inCall()); i += 1) await sleep(300);
await api(`/api/sessions/${SID}/prompt`, { method: "POST", body: JSON.stringify({ text: "[hold:9000] 关了开关还想" }) });
let quiet = true;
for (let i = 0; i < 24; i += 1) {
  await sleep(250);
  if (await cueText()) { quiet = false; break; }
}
check("with the switch OFF the call stays silent (the operator's own choice)", quiet === true);

// ---- 4. a fast turn says nothing extra ----------------------------------------------------
await ev(`localStorage.removeItem('agentus.call.brief'); true`);
await send("Page.reload", { ignoreCache: true });
for (let i = 0; i < 40; i += 1) { if (await ev("!!document.querySelector('.composer, .chat-head')")) break; await sleep(500); }
await click('button[aria-label="开始语音通话"]');
for (let i = 0; i < 30 && !(await inCall()); i += 1) await sleep(300);
await api(`/api/sessions/${SID}/prompt`, { method: "POST", body: JSON.stringify({ text: "一句话就答完" }) });
await sleep(4000);
check("a quick answer needs no cue at all (silence is only a problem when it lasts)",
  (await cueText()) === null, String(await cueText()));

// ---- 5. a card nobody answers is not allowed to wait in silence --------------------------
// `tool2` is the mock's two-approvals-in-one-turn fixture: it holds the turn until someone answers,
// which on a call is the最贵的 failure — the agent is not slow, it is waiting for a human.
await ev(`(() => { const AC = window.AudioContext; window.__chimes = 0;
  if (AC) { const o = AC.prototype.createOscillator;
    AC.prototype.createOscillator = function () { window.__chimes += 1; return o.call(this); }; }
  window.__approveRemindMs = [1500];
  return true; })()`);
await api(`/api/sessions/${SID}/prompt`, { method: "POST", body: JSON.stringify({ text: "tool2 帮我写两个文件" }) });
let approve = null;
for (let i = 0; i < 40; i += 1) {
  await sleep(250);
  const l = await ev(`document.querySelector('.call-approve')?.textContent?.trim() ?? null`);
  if (l) { approve = l; break; }
}
check("a pending approval is announced on the call, in words (#58)", approve != null && /批准/.test(approve), String(approve));
check("…and it carries the count (two cards really are two)", /2/.test(String(approve)), String(approve));
const chimes = await ev("window.__chimes ?? 0");
check("…with a sound, so a call in the dark is not silent (WebAudio chime, no TTS spent)", chimes >= 2, `oscillators=${chimes}`);
let remind = null;
for (let i = 0; i < 24; i += 1) {
  await sleep(250);
  const l = await ev(`document.querySelector('.call-approve')?.textContent?.trim() ?? null`);
  if (l && /还挂着/.test(l)) { remind = l; break; }
}
check("…and it REMINDS the operator while the card is still unanswered", remind != null, String(remind));
// answer them so the turn ends and the fixture is not left holding a subprocess
const perms = (await api("/api/sessions")).json()?.pending ?? [];
for (const p of perms) await api(`/api/permissions/${p.id}`, { method: "POST", body: JSON.stringify({ optionId: "allow" }) }).catch(() => {});
await sleep(500);

try { ws.close(); await fetch(`${CDP}/json/close/${tab.id}`); } catch { /* gone */ }
try { process.kill(-proc.pid, "SIGTERM"); } catch { /* gone */ }
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
