// TLS listener smoke — self-contained like auth-smoke / workspace-smoke: its own server on
// scratch ports with a throwaway data dir, so CI needs no service and no real cert.
//
//   node scripts/tls-smoke.mjs
//
// What it protects: the public entry speaks TLS while the LAN entry stays plain HTTP, and
// the WS relay works on BOTH (the upgrade handler is bound to each listener — the easy
// thing to forget when one listener becomes two).
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const ROOT = path.resolve(import.meta.dirname, "..");
const NAME = "agentslot-smoke.test";
const PLAIN = 9100 + Math.floor(Math.random() * 40);
const TLS = PLAIN + 40;
const USER = "smoke-op", PASS = "smoke-pass-1";
let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "FAIL  "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(dataDir, extraEnv = {}) {
  const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env, NODE_ENV: "development",
      AGENTSLOT_PORT: String(PLAIN), AGENTSLOT_TLS_PORT: String(TLS),
      AGENTSLOT_DATA: dataDir, AGENTSLOT_USERNAME: USER, AGENTSLOT_PASSWORD: PASS,
      HOME: path.join(dataDir, "home"), // no operator .env leaks into the guards
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (d) => { log += d; });
  proc.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 100; i++) {
    await sleep(150);
    try {
      const r = await fetch(`http://127.0.0.1:${PLAIN}/healthz`);
      if (r.ok) return { proc, log: () => log };
    } catch { /* not up yet */ }
  }
  throw new Error(`server did not come up:\n${log}`);
}

function makeCert(dir) {
  execFileSync(path.join(ROOT, "scripts/make-cert.sh"), [NAME], {
    cwd: ROOT, env: { ...process.env, AGENTSLOT_TLS_DIR: dir }, stdio: "pipe",
  });
  return path.join(dir, "cert.pem");
}

const tlsFetch = (url, init) => fetch(url, { ...init, dispatcher: undefined });

// ---------------------------------------------------------------- with a cert
const dir1 = mkdtempSync(path.join(tmpdir(), "agentslot-tls-"));
const certPath = makeCert(path.join(dir1, "tls"));
const { proc: srv, log } = await boot(dir1);
try {
  await sleep(500); // let the TLS listener finish binding

  // 1) cert shape
  const txt = execFileSync("openssl", ["x509", "-in", certPath, "-noout", "-text"], { encoding: "utf8" });
  const san = (txt.match(/Subject Alternative Name:\s*\n\s*(.+)/) ?? [])[1]?.trim() ?? "";
  check("cert SAN carries the typed name", san.includes(`DNS:${NAME}`), san);
  check("no dynamic public IP in the SAN", !/IP Address:(?!127\.0\.0\.1)\d/.test(san), san);

  // 2) the TLS port really is TLS: a verifying client must be refused
  let strictFailed = false;
  try { await fetch(`https://127.0.0.1:${TLS}/healthz`); } catch { strictFailed = true; }
  check("a verifying client is rejected (proves TLS, not a plain port)", strictFailed);

  // 3) with verification relaxed, the API + cookie work over TLS
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const health = await (await fetch(`https://127.0.0.1:${TLS}/healthz`)).json().catch(() => null);
  check("TLS /healthz answers with the app's payload", health?.ok === true, JSON.stringify(health ?? {}).slice(0, 60));
  const login = await fetch(`https://127.0.0.1:${TLS}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  check("login over TLS issues the session cookie", login.status === 200 && cookie.startsWith("agentslot_session="), `status=${login.status}`);

  // 4) the WS relay must work on wss too
  const wsResult = await new Promise((resolve) => {
    const ws = new WebSocket(`wss://127.0.0.1:${TLS}/ws`, { rejectUnauthorized: false, headers: { cookie } });
    const timer = setTimeout(() => { try { ws.terminate(); } catch {} resolve("timeout"); }, 8000);
    ws.on("message", (d) => {
      let m = {}; try { m = JSON.parse(String(d)); } catch {}
      if (m.t === "hello") { clearTimeout(timer); ws.close(); resolve("hello"); }
    });
    ws.on("error", (e) => { clearTimeout(timer); resolve("error: " + e.message); });
  });
  check("wss://…/ws completes the handshake and sends hello", wsResult === "hello", wsResult);

  // 5) the two listeners stay distinct: the LAN port is plain and NOT TLS
  const lan = await fetch(`http://127.0.0.1:${PLAIN}/healthz`).then((r) => r.json()).catch(() => null);
  check("the LAN port still serves plain HTTP", lan?.ok === true);
  let plainIsTls = false;
  try { await tlsFetch(`https://127.0.0.1:${PLAIN}/healthz`); plainIsTls = true; } catch { /* expected */ }
  check("the LAN port does not speak TLS (listeners are separate)", !plainIsTls);

  // 6) turning it off is honoured
  const dir2 = mkdtempSync(path.join(tmpdir(), "agentslot-tls-off-"));
  const off = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: "development", AGENTSLOT_PORT: String(PLAIN + 1), AGENTSLOT_TLS_PORT: String(TLS + 1),
      AGENTSLOT_DATA: dir2, HOME: path.join(dir2, "home") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let offLog = "";
  off.stdout.on("data", (d) => { offLog += d; }); off.stderr.on("data", (d) => { offLog += d; });
  for (let i = 0; i < 60; i++) { await sleep(150); try { if ((await fetch(`http://127.0.0.1:${PLAIN + 1}/healthz`)).ok) break; } catch {} }
  await sleep(400);
  let offListening = true;
  try { await fetch(`https://127.0.0.1:${TLS + 1}/healthz`); } catch (e) { offListening = !/ECONNREFUSED/.test(String(e?.cause?.code ?? e)); }
  check("no cert ⇒ no TLS listener, and the boot log says so",
    offLog.includes("tls off") && !offListening, offLog.includes("tls off") ? "" : offLog.slice(-200));
  off.kill("SIGKILL");
} finally {
  srv.kill("SIGKILL");
}
console.log(`\n${failed ? `${failed} FAILED` : "TLS SMOKE PASS"}`);
process.exit(failed ? 1 : 0);
