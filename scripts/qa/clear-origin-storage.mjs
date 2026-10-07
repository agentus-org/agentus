#!/usr/bin/env node
// Clear the QA origin's localStorage — the rail-sweep asserts the auto-read switch starts
// OFF, and the operator's Edge profile keeps that pref for http://127.0.0.1:8901 between runs.
// Usage: node scripts/qa/clear-origin-storage.mjs http://127.0.0.1:8901
const CDP = process.env.CDP || "http://127.0.0.1:9222";
const ORIGIN = process.argv[2] || "http://127.0.0.1:8901";

const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(ORIGIN + "/")}`, { method: "PUT" })).json();
if (!tab.webSocketDebuggerUrl) { console.error("no ws url", JSON.stringify(tab).slice(0, 200)); process.exit(1); }

const ws = new WebSocket(tab.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id;
  pending.set(mid, { res, rej });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
});
await new Promise((r) => ws.addEventListener("open", r));
await send("Runtime.enable");
await new Promise((r) => setTimeout(r, 1200));           // let the page settle on the origin
const before = await send("Runtime.evaluate", { expression: `Object.keys(localStorage).length`, returnByValue: true });
await send("Runtime.evaluate", { expression: `localStorage.clear(); sessionStorage.clear(); 'cleared'`, returnByValue: true });
const after = await send("Runtime.evaluate", { expression: `Object.keys(localStorage).length`, returnByValue: true });
console.log(`origin ${ORIGIN}: localStorage keys ${before.result.value} -> ${after.result.value}`);
ws.close();
await fetch(`${CDP}/json/close/${tab.id}`).catch(() => {});
process.exit(0);
