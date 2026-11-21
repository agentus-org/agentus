// QA: stale thinking-level snapshot after a model switch (hy4-flash "medium rejected, actual none").
//
// Reproduces the exact operator report without a real model switch: the mock advertises a reasoning
// knob whose only offered levels are none/low but whose currentValue starts at an ILLEGAL "medium"
// (MOCK_THINK_STALE=medium) — the shape of config_options left behind by an earlier model.
//
//  1. enter a call -> the cockpit lowers the dial to the cheapest offered level (low)
//  2. hang up     -> the ILLEGAL snapshot must NOT be restored, and must NOT pop a config-rejected
//                   frame at the operator (an internal restore is not their pick)
//  3. no stale    -> the snapshot is cleared, so a second call cannot replay the same failure
//
// Run: node scripts/qa/voice-thought-stale-sweep.mjs
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";

const REPO = path.resolve(import.meta.dirname, "../..");
const ROOT = `/tmp/agentus-qa-thoughtstale-${process.pid}`;
const DATA = path.join(ROOT, "data");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function check(ok, name, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function api(port, token, p, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, path: p, method: opts.method ?? "GET",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(opts.body ? { "content-type": "application/json" } : {}),
      },
    }, (res) => {
      let buf = "";
      res.on("data", (d) => { buf += d; });
      res.on("end", () => resolve({ status: res.statusCode, text: buf, json: () => (buf ? JSON.parse(buf) : null) }));
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const token = () => fs.readFileSync(path.join(DATA, "auth.token"), "utf8").trim();
let server = null;

async function start() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  const port = await freePort();
  const log = [];
  server = spawn(process.execPath, ["--import", "tsx", "packages/server/src/index.ts"], {
    cwd: REPO,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "development",
      AGENTUS_PORT: String(port), AGENTUS_DATA: DATA,
      AGENTUS_USERNAME: "scratch", AGENTUS_PASSWORD: "scratch-pass-1",
      AGENTUS_IDLE_SWEEP_MS: "0",
      MOCK_THINK_STALE: "medium",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (b) => log.push(b.toString()));
  server.stderr.on("data", (b) => log.push(b.toString()));
  for (let i = 0; i < 120; i++) {
    try { if ((await api(port, "", "/healthz")).status === 200) return port; } catch { /* booting */ }
    await sleep(200);
  }
  throw new Error(`server never came up:\n${log.join("").slice(-2000)}`);
}

function db() {
  return new DatabaseSync(path.join(DATA, "agentus.sqlite"), { readOnly: true });
}

function voiceRow(sessionId) {
  const d = db();
  try {
    return d.prepare("select in_call, thought_before, thought_touched from voice_mode where session_id = ?").get(sessionId) ?? null;
  } finally { d.close(); }
}

async function thinkingValue(port, sessionId) {
  const all = (await api(port, token(), "/api/sessions")).json();
  const row = (all.live ?? []).find((s) => s.id === sessionId);
  const opt = (row?.configOptions ?? []).find((o) => o.id === "reasoning_effort");
  return opt?.currentValue ?? null;
}

async function createSession(port, title) {
  const r = await api(port, token(), "/api/sessions", {
    method: "POST", body: JSON.stringify({ backend: "mock", cwd: REPO, title }),
  });
  if (r.status !== 200 && r.status !== 201) throw new Error(`create: ${r.status} ${r.text.slice(0, 200)}`);
  const id = r.json().id;
  for (let i = 0; i < 120; i++) {
    const all = (await api(port, token(), "/api/sessions")).json();
    if ((all.live ?? []).find((s) => s.id === id)?.status === "ready") return id;
    await sleep(200);
  }
  throw new Error("session never ready");
}

const presence = (port, sessionId, call) =>
  api(port, token(), "/api/notify/presence", {
    method: "POST", body: JSON.stringify({ sessionId, visible: true, call }),
  });

/** Persistent WS listener: collect every frame so we can assert no config-rejected leaked. */
function openListener(port) {
  const frames = [];
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token())}`);
  sock.on("message", (b) => {
    try { frames.push(JSON.parse(b.toString())); } catch { /* binary */ }
  });
  return { frames, close: () => { try { sock.close(); } catch { /* gone */ } } };
}

async function main() {
  const port = await start();
  console.log(`[thought-stale] instance :${port} data ${DATA}`);
  const listener = openListener(port);
  // give the listener socket a beat to open before any frames fly
  await sleep(400);

  const id = await createSession(port, "thought-stale-sweep");

  // baseline: the (stale) knob reads medium, which the agent does NOT actually offer
  const baseline = await thinkingValue(port, id);
  check(baseline === "medium", "baseline: stale currentValue is medium", String(baseline));

  // ---- enter the call --------------------------------------------------------------------------
  await presence(port, id, true);
  await sleep(700);
  let v = voiceRow(id);
  check(v?.in_call === 1, "enter: in_call = 1", JSON.stringify(v));
  const lowered = await thinkingValue(port, id);
  check(lowered === "none", "enter: dial lowered to the cheapest OFFERED level (none)", String(lowered));

  // ---- hang up ---------------------------------------------------------------------------------
  await presence(port, id, false);
  await sleep(900);
  v = voiceRow(id);
  check(v?.in_call === 0, "exit: in_call = 0", JSON.stringify(v));

  // THE BUG: the stale snapshot "medium" was restored -> rejected -> config-rejected frame popped,
  // and thought_before stayed stranded on "medium" so the next call replays it. The fix must:
  //  (a) never restore a level the agent does not offer
  //  (b) clear the snapshot so it cannot replay
  //  (c) not surface an internal restore rejection as a user-facing config-rejected frame
  const after = await thinkingValue(port, id);
  check(after === "none", "exit: dial stays on the legal level, NOT restored to illegal medium", String(after));
  check((v?.thought_before ?? null) === null, "exit: stale snapshot cleared (won't replay next call)", String(v?.thought_before));
  const rejects = listener.frames.filter((f) => f && f.t === "config-rejected" && f.sessionId === id);
  check(rejects.length === 0, "exit: no config-rejected frame popped for the internal restore", JSON.stringify(rejects));

  // ---- second call must be clean ---------------------------------------------------------------
  await presence(port, id, true);
  await sleep(700);
  const second = await thinkingValue(port, id);
  check(second === "none", "second call: still lowers cleanly to none", String(second));
  const v2 = voiceRow(id);
  check(v2?.thought_before !== "medium", "second call: snapshot is not the stale medium again", String(v2?.thought_before));
  await presence(port, id, false);
  await sleep(700);
  const rejects2 = listener.frames.filter((f) => f && f.t === "config-rejected" && f.sessionId === id);
  check(rejects2.length === 0, "second call: still no config-rejected frame", JSON.stringify(rejects2));

  listener.close();
}

process.on("exit", () => { try { server?.kill("SIGKILL"); } catch { /* gone */ } });

try {
  await main();
} catch (e) {
  failures.push(`FATAL: ${e?.stack || e}`);
} finally {
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.log(`FAIL  ${f}`); }
  try { server?.kill("SIGKILL"); } catch { /* gone */ }
  process.exit(failures.length ? 1 : 0);
}
