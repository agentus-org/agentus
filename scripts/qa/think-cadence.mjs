// QA: does the agent's THINKING arrive on screen progressively, or in one lump at the end?
//
// The operator's report (2026-10-08, on live, watching a long turn): 「思考展示好像卡在那里不动，我看到
// 突然，然后卡着不动，突然把所有的刷新出来了」 — a frozen thinking window, then everything at once.
//
// The wire is NOT the suspect any more (measured on the live socket: ~1200 thought frames over ~10s, 1–11
// chars each, arriving in the turn as they were produced). So this measures the RENDER: an in-page rAF
// sampler records the live thinking bubble's text length every frame while the turn streams, and the
// verdict is about how many distinct growth steps the reader actually got.
//
//   node scripts/qa/think-cadence.mjs      (SEED=<rows of transcript before the turn> CHUNKS=<think words>)
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
// The global (undici) WebSocket accepts the upgrade but never delivers an event on this Node build;
// the `ws` module does. Same as the live probe.
import WebSocket from "ws";

const CDP = process.env.CDP ?? "http://127.0.0.1:9222";
const BASE = process.env.BASE ?? "http://127.0.0.1:8901";
const QADB = process.env.AGENTUS_DATA ? `${process.env.AGENTUS_DATA}/agentus.sqlite` : "/tmp/agentus-qa-account/agentus.sqlite";
const SEED = Number(process.env.SEED ?? 1200);  // transcript size before the measured turn
const CHUNKS = Number(process.env.CHUNKS ?? 120); // how many thinking chunks the mock streams
const U = process.env.QA_USER ?? "scratch", P = process.env.QA_PASS ?? "scratch-pass-1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

{ // sweep our own leftover tabs (see render-lag-sweep: a leaked tab looks like a product crawl)
  const tabs = await (await fetch(`${CDP}/json/list`)).json().catch(() => []);
  for (const x of tabs.filter((x) => x.type === "page" && String(x.url).startsWith(BASE))) await fetch(`${CDP}/json/close/${x.id}`).catch(() => { });
}

const t = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(2000);
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res) => { ws.onopen = res; });
let id = 0; const w = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && w.has(m.id)) { const x = w.get(m.id); w.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); } };
const send = (m, p = {}, to = 20000) => new Promise((res, rej) => { const mid = ++id; const timer = setTimeout(() => { w.delete(mid); rej(new Error("TIMEOUT " + m)); }, to); w.set(mid, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } }); ws.send(JSON.stringify({ id: mid, method: m, params: p })); });
await send("Page.enable"); await send("Runtime.enable");
// Install the frame tap BEFORE the app's own script runs (the wrapper survives the navigation).
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    const Orig = window.WebSocket;
    window.__ev = [];
    window.WebSocket = function (...a) {
      const s = new Orig(...a);
      s.addEventListener("message", (e) => {
        try {
          const j = JSON.parse(e.data);
          if (j.t === "message") window.__ev.push({
            at: Math.round(performance.now()), kind: j.message && j.message.kind,
            seq: j.message && j.message.seq, n: j.n === undefined ? null : j.n,
            d: typeof j.delta === "string" ? j.delta.length : null,
          });
        } catch { }
      });
      return s;
    };
    window.WebSocket.prototype = Orig.prototype;
  })()`,
});
await send("Page.navigate", { url: BASE });
await sleep(2500);
const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value; };

const { authHeaders } = await import("../lib/auth.mjs");
const auth = { ...authHeaders() };
const sid = await fetch(`${BASE}/api/sessions`, {
  method: "POST", headers: { "content-type": "application/json", ...auth },
  body: JSON.stringify({ backend: "mock", cwd: "/tmp" }),
}).then((r) => r.json()).then((s) => s.id);

// ---- a transcript as big as a working slot's -----------------------------------------------------
{
  const db = new DatabaseSync(QADB);
  const ins = db.prepare("insert into messages (seq, session_id, kind, payload, tool_call_id, block_key, created_at) values (?,?,?,?,?,?,?)");
  const now = Date.now();
  const body = (i) => `第 ${i} 段回答：这一整段文字故意写长一点，让每个气泡都有真实的高度，这样页面渲染一屏就有真正的工作量。`;
  let seq = 0;
  const n = Math.ceil(SEED / 4);
  for (let i = 1; i <= n; i++) {
    ins.run(++seq, sid, "user", JSON.stringify({ text: `问题 ${i}` }), null, null, now - (SEED - seq) * 1000);
    ins.run(++seq, sid, "thought", JSON.stringify({ sessionUpdate: "agent_thought_chunk", messageId: `seed-th-${i}`, content: { type: "text", text: body(i) } }), null, `thought:seed-th-${i}`, now - (SEED - seq) * 1000);
    ins.run(++seq, sid, "tool", JSON.stringify({ sessionUpdate: "tool_call", toolCallId: `seed-tc-${i}`, title: `terminal: node scripts/probe-${i}.mjs`, status: "completed", rawOutput: "ok" }), `seed-tc-${i}`, null, now - (SEED - seq) * 1000);
    ins.run(++seq, sid, "agent", JSON.stringify({ sessionUpdate: "agent_message_chunk", messageId: `seed-m-${i}`, content: { type: "text", text: body(i) } }), null, `agent:seed-m-${i}`, now - (SEED - seq) * 1000);
  }
  db.close();
}
console.log(`fixture session ${sid} (transcript ${SEED} rows, turn streams ${CHUNKS} thinking chunks)`);
await ev(`fetch(${JSON.stringify(BASE + "/api/auth/login")},{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then((r)=>r.status)`);
await ev(`location.href = ${JSON.stringify(BASE + "/?session=")} + ${JSON.stringify(sid)}`);
let mounted = 0;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  mounted = await ev("document.querySelectorAll('.stream-inner > *').length").catch(() => 0);
  if (mounted > 50) break;
}
if (mounted <= 50) { console.error(`the fixture never opened (rows=${mounted})`); process.exit(1); }
console.log(`fixture on screen: ${mounted} rows`);

// ---- the sampler: IN-PAGE, per frame (never poll CDP while the page is busy — §77 lesson) --------
await ev(`window.__sid2 = ${JSON.stringify(sid)}`);
await ev(`(() => {
  window.__cad = [];
  const read = () => {
    // the live thinking bubble: the newest thought block while the turn streams
    const el = document.querySelector('.msg.thought .bubble.live') || document.querySelector('.msg.thought .bubble');
    const txt = el ? el.textContent : null;
    // The header prints the row's own character count, so it says whether the DATA grew or only the
    // DOM failed to follow the data — the difference between "the frames were dropped" and "the
    // render never ran".
    const head = document.querySelector('.msg.thought .thought-meta');
    const m = head ? /(\\d+)\\s*字/.exec(head.textContent || '') : null;
    const all = [...document.querySelectorAll('.msg.thought .bubble')].map((b) => b.textContent.length);
    // Which visible row is actually growing? Record each child's length + class, so the answer is
    // "the node with class X grew", not a guess.
    const stream = document.querySelector('.stream-inner');
    // THE ground truth: the app's own data for this session (main.tsx exposes the store). Data length
    // vs the bubble length is the whole question — "the frames were dropped" (data stuck) or "the
    // render never ran" (data grew, DOM did not).
    let data = -1, dataRows = -1;
    try {
      const v = window.__cockpit && window.__cockpit.byId && window.__cockpit.byId.get(window.__sid2);
      if (v) {
        const ts = v.msgs.filter((m) => m.kind === 'thought');
        dataRows = ts.length;
        data = ts.length ? ts[ts.length - 1].text.length : -1;
      }
    } catch { }
    return {
      len: txt === null ? -1 : txt.length,
      head: m ? Number(m[1]) : -1,
      rows: document.querySelectorAll('.msg.thought').length,
      all, data, dataRows,
      total: stream ? stream.innerText.length : -1,
      kids: document.querySelectorAll('.stream-inner > *').length,
    };
  };
  let last = null;
  const tick = () => {
    const r = read();
    const t = performance.now();
    if (last === null || r.len !== last.len || r.head !== last.head || r.rows !== last.rows
        || r.total !== last.total || r.kids !== last.kids || JSON.stringify(r.all) !== JSON.stringify(last.all)) {
      window.__cad.push({ t: Math.round(t), len: r.len, data: r.data, dataRows: r.dataRows, total: r.total });
    }
    last = r;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})()`);

const t0 = Date.now();
// ---- tap the wire INSIDE the page: what the app's own socket receives --------------------------
// A frozen window can be the SERVER not sending (store folded the chunks away, no delta emitted) or
// the CLIENT not applying what it got. A Node-side socket proved unreliable here (it accepts the
// upgrade and then receives nothing), so the tap is installed into the page BEFORE the app's own code
// runs — same socket the app uses, exact same frames.
await fetch(`${BASE}/api/sessions/${sid}/prompt`, {
  method: "POST", headers: { "content-type": "application/json", ...auth },
  body: JSON.stringify({ text: `[think:${CHUNKS}]` }),
});
// wait for the turn to be over (session status back to ready/idle), then a beat for the last paint
let status = "";
for (let i = 0; i < 120; i++) {
  await sleep(500);
  status = await ev(`(() => { const el = document.querySelector('.rail-item.active .st'); return el ? el.textContent : 'x'; })()`).catch(() => "x");
  const s = await fetch(`${BASE}/api/sessions`, { headers: auth }).then((r) => r.json()).catch(() => null);
  const mine = s?.live?.find((x) => x.id === sid);
  if (mine && mine.status !== "running" && i > 4) { status = mine.status; break; }
}
await sleep(1200);
const wall = Date.now() - t0;

const cad = await ev("window.__cad");
console.log(`sampler ticks ${await ev("window.__ticks")}, DOM mutations observed ${await ev("window.__muts")}`);
const grew = cad.filter((x) => x.len >= 0);
const steps = grew.length;
const first = grew[0], last = grew[grew.length - 1];
const span = last && first ? last.t - first.t : 0;
const held = grew.slice(1).map((x, i) => x.t - grew[i].t);
const worst = held.length ? Math.max(...held) : 0;
console.log(`\nturn wall time ${wall}ms; thinking on screen: ${steps} distinct states over ${Math.round(span)}ms`);
console.log(`states (t: bubble len / header count / thought rows):`);
console.log(grew.map((x) => `  t=${String(x.t).padStart(6)}ms  DATA=${String(x.data).padStart(4)} (rows ${x.dataRows})  DOM-bubble=${String(x.len).padStart(4)}  stream-total=${x.total}`).join("\n"));
console.log(`  header count ${grew[0]?.head} → ${grew[grew.length - 1]?.head}`);
console.log(`largest stretch with no visible growth: ${worst}ms`);
console.log(`final length ${last?.len} (mock streamed ~${CHUNKS * 5} chars)`);

console.log(`\n--- what the APP's own socket received, same window ---`);
const frames = (await ev("window.__ev") ?? []).filter((x) => x.kind === "thought" || x.kind === "agent");
const th2 = frames.filter((x) => x.kind === "thought");
console.log(`frames total ${frames.length}, thought ${th2.length}`);
console.log(`  first 6: ${th2.slice(0, 6).map((x) => `t=${x.at} n=${x.n} d=${x.d}`).join(" | ")}`);
console.log(`  last 3:  ${th2.slice(-3).map((x) => `t=${x.at} n=${x.n} d=${x.d}`).join(" | ")}`);
const ns2 = th2.map((x) => x.n).filter((x) => x !== null);
console.log(`  n: ${ns2[0]} → ${ns2[ns2.length - 1]} (${new Set(ns2).size} distinct of ${th2.length} frames)`);
const stepsNum = steps;
console.log(th2.length === 0 ? "VERDICT: the page's socket received NOTHING → server/broadcast side"
  : new Set(ns2).size > 5 && stepsNum <= 2 ? "VERDICT: the socket GOT the growth, the DOM did NOT show it → client render side"
    : new Set(ns2).size <= 5 ? "VERDICT: the socket barely got anything → server side"
      : "VERDICT: both sides moved");

check("the thinking bubble appeared at all", steps > 0 && last.len > 0, `steps=${steps} len=${last?.len}`);
check("the thinking grew in MANY small steps, not one lump",
  steps >= Math.min(20, CHUNKS / 3), `steps=${steps} (want >= ${Math.min(20, Math.ceil(CHUNKS / 3))})`);
check("…and no single stretch stayed frozen for long", worst < 3000, `worst=${worst}ms`);
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
