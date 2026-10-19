// Issue #26, the two facts a browser cannot fake:
//
//   1. A prompt carries a `pid` and the `turn-start` it causes echoes it. That is the ONLY proof a
//      page can have that a frame it handed to a socket actually arrived — `ws.send()` succeeds on a
//      connection that died without a FIN, and the operator's message then vanishes with no error.
//   2. `/ws` pings, and a peer that never answers a ping is terminated. Without this the half-open
//      socket stays "connected" on both sides forever, so the page never reconnects and never even
//      gets a chance to retry.
//
// Both are asserted against a REAL server started by this script (own port, own data dir, fast
// heartbeat), because the heartbeat interval is the thing under test: waiting 40s of wall clock for
// the production value would make this guard too slow to run.
//
//   node scripts/qa/ws-send-ack.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const PORT = Number(process.env.QA_PORT ?? 8919);
const DATA = process.env.QA_DATA ?? "/tmp/agentus-qa-ws-liveness";
const BEAT = 800; // ms — server-side, via AGENTUS_WS_HEARTBEAT_MS
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

const srv = spawn(process.execPath, [path.join(REPO, "node_modules/.bin/tsx"), "packages/server/src/index.ts"], {
  cwd: REPO,
  env: { ...process.env, AGENTUS_PORT: String(PORT), AGENTUS_DATA: DATA, AGENTUS_WS_HEARTBEAT_MS: String(BEAT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
srv.stdout.on("data", (b) => { log += String(b); });
srv.stderr.on("data", (b) => { log += String(b); });
const stop = () => { try { srv.kill("SIGTERM"); } catch { /* already gone */ } };
process.on("exit", stop);

const waitPort = async (ms = 20_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return true; } catch { /* not up yet */ }
    await sleep(200);
  }
  return false;
};

const open = async (token) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { authorization: `Bearer ${token}` } });
  const frames = [];
  ws.on("message", (d) => { try { frames.push(JSON.parse(String(d))); } catch { /* hello is JSON too */ } });
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  return { ws, frames };
};

try {
  if (!(await waitPort())) throw new Error(`server never came up:\n${log.slice(-1500)}`);
  const token = fs.readFileSync(path.join(DATA, "auth.token"), "utf8").trim();

  // ---- 1. a prompt's pid comes back on the turn-start it caused ---------------------------------
  const created = await (await fetch(`${BASE}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ backend: "mock", cwd: "/tmp", title: "ack probe（自动删除）" }),
  })).json();
  const sid = created?.id;
  check("the probe session was created", Boolean(sid), String(sid ?? "no id"));

  const { ws, frames } = await open(token);
  await sleep(300);
  const pid = "p-qa-ack-1";
  ws.send(JSON.stringify({ t: "prompt", sessionId: sid, text: "[slow] ack probe", pid }));

  const until = Date.now() + 8000;
  let started = null;
  while (Date.now() < until && !started) {
    started = frames.find((f) => f.t === "turn-start" && f.sessionId === sid);
    if (!started) await sleep(100);
  }
  check("the server announced the turn", Boolean(started));
  check("that turn-start echoed the prompt's pid", started?.pid === pid, `pid=${String(started?.pid)}`);

  // A prompt without a pid must not invent one (the page turns it into a confirmed send by session).
  ws.send(JSON.stringify({ t: "prompt", sessionId: sid, text: "second", interrupt: true }));
  const until2 = Date.now() + 8000;
  let second = null;
  while (Date.now() < until2 && !second) {
    second = frames.filter((f) => f.t === "turn-start" && f.sessionId === sid)[1];
    if (!second) await sleep(100);
  }
  check("a pid-less prompt answers with a pid-less turn-start", Boolean(second) && second.pid === undefined);

  // ---- 2. a peer that never answers a ping is reaped --------------------------------------------
  // `pong` is what the ws client calls when the server pings; making it a no-op is exactly the
  // silent peer a sleeping laptop looks like on the wire.
  const mute = await open(token);
  mute.ws.pong = () => {};
  let closed = false;
  mute.ws.on("close", () => { closed = true; });
  const deadline = Date.now() + BEAT * 6;
  while (Date.now() < deadline && !closed) await sleep(100);
  check("a peer that never answers a ping is terminated", closed, closed ? "" : `still open after ${BEAT * 6}ms`);

  // …while a normal client keeps its socket (no false positives from the heartbeat itself).
  const alive = await open(token);
  let wronglyClosed = false;
  alive.ws.on("close", () => { wronglyClosed = true; });
  await sleep(BEAT * 4);
  check("a client that answers pings keeps its socket", !wronglyClosed);
  alive.ws.close();

  ws.close();
  await fetch(`${BASE}/api/sessions/${sid}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }).catch(() => {});
} catch (e) {
  fail++;
  console.log(`FAIL  harness error: ${e?.message ?? e}`);
} finally {
  stop();
  await sleep(300);
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
