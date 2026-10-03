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
import { createServer as createTcp } from "node:net";
import { WebSocket } from "ws";

const ROOT = path.resolve(import.meta.dirname, "..");
const NAME = "agentslot-smoke.test";
const [PLAIN, TLS, PLAIN_OFF, TLS_OFF] = await freePorts(4);
const USER = "smoke-op", PASS = "smoke-pass-1";
let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "FAIL  "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ask the OS for a port that is actually free. A guessed/fixed range collides with a server
 *  leaked by an earlier crashed run: the stale listener answers /healthz instantly, so the
 *  suite silently talks to the WRONG process and dies with something cryptic ("no machine
 *  token"). We also kill every child on exit, so we never become the leaker ourselves. */
async function freePort() {
  return new Promise((res, rej) => {
    const s = createTcp();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}
async function freePorts(n) { const out = new Set(); while (out.size < n) out.add(await freePort()); return [...out]; }
function portInUse(port) {
  return new Promise((res) => {
    const s = createTcp();
    s.once("error", () => res(true));
    s.once("listening", () => s.close(() => res(false)));
    s.listen(port, "127.0.0.1");
  });
}
const CHILDREN = new Set();
process.on("exit", () => { for (const c of CHILDREN) { try { c.kill("SIGKILL"); } catch { /* already gone */ } } });


async function boot(dataDir, extraEnv = {}) {
  if (await portInUse(PLAIN)) {
    throw new Error(`port ${PLAIN} is already in use — a leaked server from an earlier run? `
      + `(lsof -nP -iTCP:${PLAIN} -sTCP:LISTEN)`);
  }
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
  CHILDREN.add(proc);
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
  // root + leaf: the root is what a device installs, the leaf is what the listener serves.
  return { ca: path.join(dir, "ca.pem"), leaf: path.join(dir, "cert.pem") };
}

const tlsFetch = (url, init) => fetch(url, { ...init, dispatcher: undefined });

// ---------------------------------------------------------------- with a cert
const dir1 = mkdtempSync(path.join(tmpdir(), "agentslot-tls-"));
const { ca: caPath, leaf: certPath } = makeCert(path.join(dir1, "tls"));
const { proc: srv, log } = await boot(dir1);
try {
  await sleep(500); // let the TLS listener finish binding

  // 1) cert shape
  const txt = execFileSync("openssl", ["x509", "-in", certPath, "-noout", "-text"], { encoding: "utf8" });
  const san = (txt.match(/Subject Alternative Name:\s*\n\s*(.+)/) ?? [])[1]?.trim() ?? "";
  check("cert SAN carries the typed name", san.includes(`DNS:${NAME}`), san);
  check("no dynamic public IP in the SAN", !/IP Address:(?!127\.0\.0\.1)\d/.test(san), san);

  // 1b) the leaf is signed by the root a device installs, and stays inside Apple's cap for
  //     server certificates (398 days) — a 10-year leaf is the shape iOS refuses AFTER the
  //     user has been through the whole install dance.
  execFileSync("openssl", ["verify", "-CAfile", caPath, certPath], { stdio: "pipe" });
  check("the leaf verifies against the root that /cert.crt hands out", true);
  const dates = execFileSync("openssl", ["x509", "-in", certPath, "-noout", "-dates"], { encoding: "utf8" });
  const day = (tag) => Date.parse(dates.match(new RegExp(`${tag}=(.*)`))[1].replace(" GMT", " UTC"));
  const days = Math.round((day("notAfter") - day("notBefore")) / 86_400_000);
  check("the leaf's validity is under Apple's 398-day cap", days <= 398, `${days} days`);
  const issuer = execFileSync("openssl", ["x509", "-in", certPath, "-noout", "-issuer"], { encoding: "utf8" });
  check("the leaf is issued by the root, not self-signed", /AgentSlot self-signed root/.test(issuer), issuer.trim());

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

  // 4b) the cert is downloadable — that is how a phone installs the self-signed issuer
  const dl = await fetch(`https://127.0.0.1:${TLS}/cert.crt`);
  const dlBytes = Buffer.from(await dl.arrayBuffer());
  check("GET /cert.crt serves the ROOT (what a device installs), with Apple's install type",
    dl.status === 200
      && dl.headers.get("content-type") === "application/x-x509-ca-cert"
      && dlBytes.equals(fs.readFileSync(caPath)),
    `status=${dl.status} type=${dl.headers.get("content-type")} bytes=${dlBytes.length}`);
  const viaPlain = await fetch(`http://127.0.0.1:${PLAIN}/cert.crt`);
  check("the LAN port serves the same cert (install from inside too)", viaPlain.status === 200);

  // 5) the two listeners stay distinct: the LAN port is plain and NOT TLS
  const lan = await fetch(`http://127.0.0.1:${PLAIN}/healthz`).then((r) => r.json()).catch(() => null);
  check("the LAN port still serves plain HTTP", lan?.ok === true);
  let plainIsTls = false;
  try { await tlsFetch(`https://127.0.0.1:${PLAIN}/healthz`); plainIsTls = true; } catch { /* expected */ }
  check("the LAN port does not speak TLS (listeners are separate)", !plainIsTls);

  // 6) turning it off is honoured
  const dir2 = mkdtempSync(path.join(tmpdir(), "agentslot-tls-off-"));
  if (await portInUse(PLAIN_OFF)) throw new Error(`port ${PLAIN_OFF} in use — leaked server?`);
  const off = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: "development", AGENTSLOT_PORT: String(PLAIN_OFF), AGENTSLOT_TLS_PORT: String(TLS_OFF),
      AGENTSLOT_DATA: dir2, HOME: path.join(dir2, "home") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let offLog = "";
  CHILDREN.add(off);
  off.stdout.on("data", (d) => { offLog += d; }); off.stderr.on("data", (d) => { offLog += d; });
  for (let i = 0; i < 60; i++) { await sleep(150); try { if ((await fetch(`http://127.0.0.1:${PLAIN_OFF}/healthz`)).ok) break; } catch {} }
  await sleep(400);
  let offListening = true;
  try { await fetch(`https://127.0.0.1:${TLS_OFF}/healthz`); } catch (e) { offListening = !/ECONNREFUSED/.test(String(e?.cause?.code ?? e)); }
  check("no cert ⇒ no TLS listener, and the boot log says so",
    offLog.includes("tls off") && !offListening, offLog.includes("tls off") ? "" : offLog.slice(-200));
  const offCert = await fetch(`http://127.0.0.1:${PLAIN_OFF}/cert.crt`);
  check("no cert ⇒ /cert.crt is a plain 404, not an empty file", offCert.status === 404, `status=${offCert.status}`);
  off.kill("SIGKILL");
} finally {
  srv.kill("SIGKILL");
}
console.log(`\n${failed ? `${failed} FAILED` : "TLS SMOKE PASS"}`);
process.exit(failed ? 1 : 0);
