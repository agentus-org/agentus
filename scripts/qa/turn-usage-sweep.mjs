// #70 on a real server: every turn gets a token bill, and the SECOND turn shows only its own growth.
//
// The unit guard (scripts/qa/turn-usage.mts) pins the arithmetic; this one pins the WIRE and the
// STORE against a real ACP round-trip:
//   1. the prompt response's cumulative `usage` becomes a `turn-usage` row at the tail of the reply;
//   2. that row is persisted, so a reload shows the same numbers (the agent never re-sends them);
//   3. the second turn's bill is a DIFFERENCE — reporting the cumulative total again would look
//      plausible and be wrong on every turn but the first, which is exactly what this catches;
//   4. `turn-end` carries the same bill the row does (one turn, one number);
//   5. the session's usage gauge keeps the cumulative baseline, so the tooltip can show cache reads.
//
// Uses the built-in MOCK backend (its prompt response now carries cumulative usage, shaped like the
// hermes adapter's), so it costs no tokens and boots its own scratch instance.
//
// Run: node scripts/qa/turn-usage-sweep.mjs
import { spawn } from "node:child_process";
import { createServer as createTcp } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";

const ROOT = path.resolve(import.meta.dirname, "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// ------------------------------------------------------------------ scratch instance
const freePort = () => new Promise((res, rej) => {
  const s = createTcp();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});
const PORT = await freePort();
const dataDir = mkdtempSync(path.join(tmpdir(), "agentus-turn-usage-"));
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
const shutdown = () => { try { process.kill(-proc.pid, "SIGTERM"); } catch { /* gone */ } };
process.on("exit", shutdown);
for (let i = 0; i < 80 && !log.includes(`0.0.0.0:${PORT}`); i += 1) await sleep(150);
for (let i = 0; i < 80; i += 1) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }
const TOKEN = readFileSync(path.join(dataDir, "auth.token"), "utf8").trim();
const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

// ------------------------------------------------------------------ websocket frames
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(TOKEN)}`);
const frames = [];
ws.on("message", (raw) => { try { frames.push(JSON.parse(String(raw))); } catch { /* not json */ } });
await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
const until = async (fn, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(120); }
  return null;
};

const created = await (await fetch(`${BASE}/api/sessions`, {
  method: "POST", headers: auth, body: JSON.stringify({ backend: "mock", cwd: tmpdir(), title: "turn usage sweep" }),
})).json();
const sid = created.id;
await until(() => frames.some((f) => f.t === "session" && f.session?.id === sid && f.session?.status !== "starting"), 20_000);

// ------------------------------------------------------------------ two turns
const rowOf = (n) => frames.filter((f) => f.t === "message" && f.message?.sessionId === sid
  && f.message.kind === "turn-usage")[n];
const endOf = (n) => frames.filter((f) => f.t === "turn-end" && f.sessionId === sid)[n];

const firstText = "第一个问题";
ws.send(JSON.stringify({ t: "prompt", sessionId: sid, text: firstText }));
const firstRow = await until(() => rowOf(0));
const firstEnd = await until(() => endOf(0));
check("第一轮写出了一条 turn-usage 行", Boolean(firstRow), firstRow ? `seq=${firstRow.message.seq}` : "没有");
check("这一行带齐 input/output/思考/缓存读/缓存写", firstRow
  && ["input", "output", "thought", "cacheRead", "cacheWrite", "total"].every((k) => typeof firstRow.message.payload[k] === "number"),
  JSON.stringify(firstRow?.message.payload));
check("turn-end 带着同一份账（一轮一个数）",
  JSON.stringify(firstEnd?.usage) === JSON.stringify(firstRow?.message.payload),
  `${JSON.stringify(firstEnd?.usage)} vs ${JSON.stringify(firstRow?.message.payload)}`);
// The mock counts `text.length + 200` where `text` is its blocks joined by " " (the operator's
// text plus the server's own blocks), so the exact length is not the point — the point is that it
// is ONE turn's worth, not a running total.
check("第一轮的 input 就是它自己的量（mock: 文本长度 + 200 + 缓存 4224，与 hermes prompt_tokens 同口径）",
  Math.abs((firstRow?.message.payload.input ?? 0) - (firstText.length + 200 + 4096 + 128)) <= 3,
  `${firstRow?.message.payload.input} vs ~${firstText.length + 200 + 4096 + 128}`);
// Issue #71: inputTokens IS the prompt total, so the denominators' cache buckets must NOT be
// added back. The defect this pins: read/(in+read+write) reads ~50% on any cache-heavy turn.
check("缓存命中率 = 缓存读 / input（不再把缓存桶加进分母，issue #71）", (() => {
  const p = firstRow?.message.payload;
  if (!p) return false;
  return p.cacheHitPercent === Math.min(100, Math.round((4096 / p.input) * 100));
})(), String(firstRow?.message.payload.cacheHitPercent));
check("命中率不再被钳在 50% 附近（缓存重的回合必须读成 ~92%）", (() => {
  const p = firstRow?.message.payload;
  return p && p.cacheHitPercent !== null && p.cacheHitPercent > 80;
})(), String(firstRow?.message.payload.cacheHitPercent));
check("速度是整回合平均（output / 用时），不是瞬时值",
  typeof firstRow?.message.payload.tps === "number" && firstRow.message.payload.tps >= 0,
  String(firstRow?.message.payload.tps));

const secondText = "第二个问题，比第一个长一些，用来证明第二轮只报增量而不是又报一遍累计值";
ws.send(JSON.stringify({ t: "prompt", sessionId: sid, text: secondText }));
const secondRow = await until(() => rowOf(1));
check("第二轮也写出了一条 turn-usage 行", Boolean(secondRow));
check("第二轮报的是增量：input 只有本轮的量（不是两轮累计）",
  Math.abs((secondRow?.message.payload.input ?? 0) - (secondText.length + 200 + 4096 + 128)) <= 3,
  `${secondRow?.message.payload.input} vs ~${secondText.length + 200 + 4096 + 128}`);
check("两行的 seq 递增，所以它们各自贴在对应回复之后",
  (secondRow?.message.seq ?? 0) > (firstRow?.message.seq ?? 0),
  `${firstRow?.message.seq} → ${secondRow?.message.seq}`);

// ------------------------------------------------------------------ persisted
const msgs = (await (await fetch(`${BASE}/api/sessions/${sid}/messages?tail=1`, { headers: auth })).json()).messages ?? [];
const stored = msgs.filter((m) => m.kind === "turn-usage");
check("刷新读回来的历史里也有这两行", stored.length === 2, `${stored.length} rows`);
check("历史里的数与推送的一致",
  stored[1]?.payload?.input === secondRow?.message.payload.input,
  `${stored[1]?.payload?.input} vs ${secondRow?.message.payload.input}`);
// There is no GET /api/sessions/:id; the `session` frame IS the live row (and what the rail reads).
const info = [...frames].reverse().find((f) => f.t === "session" && f.session?.id === sid)?.session ?? null;
const totals = info?.usage?.totals;
check("会话上留着累计基线（下一轮差分要用，刷新后也在）", Boolean(totals), JSON.stringify(info?.usage));
check("累计基线 = 两轮的累计（mock 每轮 + 4096 缓存读）", totals?.cacheRead === 8192, JSON.stringify(totals));

// ------------------------------------------------------------------ the row on a real page
// The server half is proven above; this is the half a unit test cannot see — that the line is
// DRAWN, sits at the tail of the reply, and reads as numbers rather than as a debug dump.
const CDP = process.env.CDP ?? "http://127.0.0.1:9223";
let browser = null;
try {
  const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
  await sleep(2200);
  const cws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { cws.onopen = res; cws.onerror = rej; });
  let cid = 0;
  const waiting = new Map();
  cws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) {
      const x = waiting.get(m.id); waiting.delete(m.id);
      m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result);
    }
  };
  const snd = (method, params = {}, to = 30_000) => new Promise((res, rej) => {
    const mid = ++cid;
    const timer = setTimeout(() => { waiting.delete(mid); rej(new Error(`TIMEOUT ${method}`)); }, to);
    waiting.set(mid, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
    cws.send(JSON.stringify({ id: mid, method, params }));
  });
  const ev = async (expr, to = 30_000) => {
    const r = await snd("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, to);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
    return r.result.value;
  };
  await ev(`(async () => { await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }) });
    localStorage.setItem('agentus.active', ${JSON.stringify(sid)}); return true; })()`);
  await snd("Page.navigate", { url: BASE });
  for (let i = 0; i < 60; i += 1) {
    if (await ev("document.querySelectorAll('.turn-usage').length >= 2")) break;
    await sleep(250);
  }
  const seen = await ev(`(() => {
    const rows = [...document.querySelectorAll('.turn-usage')];
    const lastAgent = [...document.querySelectorAll('.msg.agent')].pop();
    const lastRow = rows[rows.length - 1];
    const after = !!(lastAgent && lastRow && (lastAgent.compareDocumentPosition(lastRow) & Node.DOCUMENT_POSITION_FOLLOWING));
    return { count: rows.length, text: (lastRow?.textContent ?? '').trim(),
      kind: lastRow?.getAttribute('data-kind') ?? null, afterAgent: after,
      mono: lastRow ? getComputedStyle(lastRow.querySelector('.status-note-text') ?? lastRow).fontFamily : '' };
  })()`);
  check("真页面上画出了两行 token 账（刷新后也在）", seen?.count === 2, JSON.stringify(seen));
  check("它贴在那一轮回复的后面，而不是飘在上面", seen?.afterAgent === true, JSON.stringify(seen));
  check("读数是一行真数字：in / out / 命中 / 平均速度",
    /\bin\b/.test(String(seen?.text)) && /\bout\b/.test(String(seen?.text))
    && /命中 \d+%/.test(String(seen?.text)) && /t\/s 平均/.test(String(seen?.text)),
    JSON.stringify(seen?.text));
  check("它用等宽数字（一列数字要对得齐）", /mono/i.test(String(seen?.mono)), String(seen?.mono));
  browser = { cws, tab };
} catch (e) {
  check("browser check ran (Edge on :9223; skip with CDP=off)", false, String(e?.message ?? e));
}

// ------------------------------------------------------------------ no extra timers (acceptance #6)
// Nothing in this feature runs a ticker: the bill is computed once per turn, at turn-end. Asserted
// structurally so a future "live t/s" addition has to come with its own switch-off rule.
{
  const sm = readFileSync(path.join(ROOT, "packages/server/src/acp/session-manager.ts"), "utf8");
  check("turn-usage adds no interval/ticker to the server (nothing spins when idle)",
    !/setInterval\(/.test(sm.slice(sm.indexOf("export function turnUsageOf"), sm.indexOf("function errMessage"))));
}

console.log(`\n${pass} passed, ${fail} failed`);
try { browser?.cws?.close(); } catch { /* tab gone */ }
ws.close();
shutdown();
process.exit(fail ? 1 : 0);
