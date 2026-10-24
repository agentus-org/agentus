// #57: a session whose agent never reports usage still reaches its context window.
//
// Qoder sends no `usage_update` at all (measured on the operator's store: hermes 60/60 sessions
// carry usage, qoder 0/2), and the whole usage strip — gauge AND the declaration field — used to be
// gated on that report (`if (!usage || (!usage.used && !usage.size)) return null`). So the one knob a
// qoder session has was unreachable: not greyed out, absent. This sweep drives a real browser against
// a scratch instance and pins the three things that must hold afterwards:
//
//   1. the strip exists and says why it has no numbers;
//   2. the declaration is reachable and the number it writes survives a reload (server-side);
//   3. nothing is faked: the gauge stays empty rather than drawing a percentage out of a guess.
//
// Run: node scripts/qa/usage-row-sweep.mjs      (needs the user's Edge on CDP :9223)
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

// ------------------------------------------------------------------ instance
const freePort = () => new Promise((res, rej) => {
  const s = createTcp();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});
const PORT = await freePort();
const dataDir = mkdtempSync(path.join(tmpdir(), "agentus-usage-"));
const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
  detached: true,
  cwd: ROOT,
  // HOME is NOT overridden here on purpose: qodercli keeps its login under ~/.qoder, and a session
  // that cannot spawn produces no row to look at. Only the data dir is scratch.
  env: { ...process.env, NODE_ENV: "development", AGENTUS_QODER_CMD: `${process.env.HOME}/.local/bin/qodercli`,
    AGENTUS_PORT: String(PORT), AGENTUS_DATA: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
proc.stdout.on("data", (d) => { log += String(d); });
proc.stderr.on("data", (d) => { log += String(d); });
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 80 && !log.includes(`0.0.0.0:${PORT}`); i += 1) await sleep(150);
for (let i = 0; i < 80; i += 1) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }
const token = () => readFileSync(path.join(dataDir, "auth.token"), "utf8").trim();
const api = async (p, opts = {}) => {
  const r = await fetch(`${BASE}${p}`, { ...opts, headers: { authorization: `Bearer ${token()}`, ...(opts.body ? { "content-type": "application/json" } : {}), ...(opts.headers ?? {}) } });
  const text = await r.text();
  return { status: r.status, text, json: () => (text ? JSON.parse(text) : null) };
};

// Qoder is the case: no usage report ever, and no ACP context option either — so this session shows
// the strip only because of the fix, and its ONLY way to set a window is the declaration field.
const cold = (await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "qoder", cwd: "/tmp" }) })).json();
// …and a backend that DOES advertise a knob (mock): that branch must keep working untouched.
const knobbed = (await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "mock", cwd: "/tmp" }) })).json();
check("fixture: a qoder session exists whose agent has reported no usage", cold?.id != null, JSON.stringify(cold).slice(0, 160));
check("…and the server really has no usage for it",
  (cold?.usage ?? null) === null, JSON.stringify(cold?.usage));

// ------------------------------------------------------------------ browser
const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(2600);
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

await ev(`(async () => { await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: '123456' }) });
  localStorage.setItem('agentus.active', ${JSON.stringify(cold.id)}); return true; })()`);
await send("Page.navigate", { url: BASE });
for (let i = 0; i < 40; i += 1) { if (await ev("!!document.querySelector('.usage-row')")) break; await sleep(250); }

const strip = await ev(`(() => {
  const row = document.querySelector('.usage-row');
  if (!row) return { present: false };
  const bar = row.querySelector('.usage-bar i');
  return { present: true, text: (row.querySelector('.usage-text')?.textContent ?? '').trim(),
    barWidth: bar ? bar.style.width : null, cls: row.className };
})()`);
check("the context strip renders even though the agent never reported usage (#57)", strip.present === true, JSON.stringify(strip));
check("…and it says why there are no numbers instead of showing zeros",
  /未上报/.test(String(strip.text)), JSON.stringify(strip.text));
check("…without inventing a fill level", strip.barWidth === null || strip.barWidth === "0%", String(strip.barWidth));

// the declaration has to be reachable from here — that is the whole point of the issue
await ev(`(() => { document.querySelector('.usage-text')?.click(); return true; })()`);
await sleep(250);
const opened = await ev(`(() => { const d = document.querySelector('.usage-detail');
  return d ? { text: d.textContent.slice(0, 200), hasDeclare: /声明窗口长度/.test(d.textContent) } : null; })()`);
check("clicking the strip opens the window panel", opened != null, JSON.stringify(opened));
check("…with the declaration action available (it used to be unreachable)", opened?.hasDeclare === true, JSON.stringify(opened?.text));

await ev(`(() => { const b = [...document.querySelectorAll('.usage-edit-btn')].find((x) => /声明窗口长度/.test(x.textContent));
  if (!b) return false; b.click(); return true; })()`);
await sleep(250);
const typed = await ev(`(async () => {
  const input = document.querySelector('.usage-edit input');
  if (!input) return { ok: false };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, '200000');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 100));
  const btn = [...document.querySelectorAll('.usage-edit-btn')].find((x) => x.textContent.trim() === 'set');
  btn?.click();
  return { ok: true };
})()`);
check("the declaration field accepts a window", typed?.ok === true, JSON.stringify(typed));
await sleep(1200);
const saved = (await api(`/api/sessions`)).json();
const rowAfter = [...(saved?.live ?? []), ...(saved?.cold ?? []), ...(saved?.pending ?? [])].find((r) => r.id === cold.id);
check("…and the server stores it (POST …/context-limit is backend-agnostic)",
  rowAfter?.contextLimit === 200000, String(rowAfter?.contextLimit));

const afterText = await ev(`(() => (document.querySelector('.usage-row .usage-text')?.textContent ?? '').trim())()`);
check("the strip now shows the declared window", /200K|200,000|声明/.test(String(afterText)), JSON.stringify(afterText));

// A reload is the operator's real test: the declaration lives on the server, not in the page.
await send("Page.reload", { ignoreCache: true });
for (let i = 0; i < 40; i += 1) { if (await ev("!!document.querySelector('.usage-row')")) break; await sleep(250); }
const reloaded = await ev(`(() => (document.querySelector('.usage-row .usage-text')?.textContent ?? '').trim())()`);
check("…and it survives a reload", /200K|200,000|声明/.test(String(reloaded)), JSON.stringify(reloaded));

// ------------------------------------------------------------------ teardown
try { ws.close(); await fetch(`${CDP}/json/close/${tab.id}`); } catch { /* tab already gone */ }
try { process.kill(-proc.pid, "SIGTERM"); } catch { /* already gone */ }
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
