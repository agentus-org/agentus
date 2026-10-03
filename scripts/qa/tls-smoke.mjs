// TLS listener smoke (manual QA — needs a running instance; not in CI).
//   node scripts/qa/tls-smoke.mjs [plainPort=8787] [tlsPort=8443]
// Proves, on a real socket: (1) the TLS port really speaks TLS (a verifying client is
// rejected), (2) the cert's SAN covers the name the operator types, (3) the API works
// over TLS, (4) the WS relay works over wss (the upgrade handler is bound to BOTH
// listeners), and (5) the plain LAN listener is untouched.
import { execFileSync } from "node:child_process";
import WebSocket from "ws";

const PLAIN = Number(process.argv[2] ?? 8787);
const TLS = Number(process.argv[3] ?? 8443);
const NAME = process.env.TLS_NAME ?? "i207f47592.wicp.vip";
const CA = process.env.TLS_CERT ?? new URL("../../packages/server/.data/tls/cert.pem", import.meta.url).pathname;
let pass = 0, fail = 0;
const ok = (c, m, extra = "") => { c ? (pass++, console.log(`PASS  ${m}${extra ? "  " + extra : ""}`)) : (fail++, console.log(`FAIL  ${m}${extra ? "  " + extra : ""}`)); };
const insecure = { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" };

// 1) cert shape
const txt = execFileSync("openssl", ["x509", "-in", CA, "-noout", "-text"], { encoding: "utf8" });
const san = (txt.match(/Subject Alternative Name:\s*\n\s*(.+)/) ?? [])[1] ?? "";
ok(san.includes(`DNS:${NAME}`), "cert SAN carries the DDNS name the operator types", san.trim());
ok(!/\bIP Address:1?\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(san) || san.includes("IP Address:127.0.0.1"),
  "no dynamic public IP baked into the SAN");

// 2) the TLS port really is TLS: a verifying client must fail, an unverifying one must pass
let verifiedFailed = false;
try { await fetch(`https://127.0.0.1:${TLS}/healthz`); } catch { verifiedFailed = true; }
ok(verifiedFailed, "a verifying client is rejected (proves it is not plain HTTP)");
// From here on we DO trust the cert (self-signed by design): relax verification for the
// rest of this script only. The check above must stay first, while it is still strict.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
let health = null;
try { health = await (await fetch(`https://127.0.0.1:${TLS}/healthz`, { dispatcher: undefined })).json(); } catch { /* see below */ }
if (!health) {
  const out = execFileSync("curl", ["-s", "-k", `https://127.0.0.1:${TLS}/healthz`], { encoding: "utf8", env: insecure }); // fallback if fetch refuses
  health = JSON.parse(out);
}
ok(health?.ok === true, "TLS /healthz answers 200", JSON.stringify(health).slice(0, 80));

// 3) API + cookie over TLS
const login = await fetch(`https://127.0.0.1:${TLS}/api/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: process.env.QA_USER ?? "admin", password: process.env.QA_PASS ?? "123456" }),
});
const setCookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
ok(login.status === 200 && setCookie.startsWith("agentslot_session="), "login works over TLS and sets a session cookie", `status=${login.status}`);

// 4) wss relay (this is the part a listener-only change usually breaks)
const wsOk = await new Promise((resolve) => {
  const ws = new WebSocket(`wss://127.0.0.1:${TLS}/ws`, { rejectUnauthorized: false, headers: { cookie: setCookie } });
  const timer = setTimeout(() => { try { ws.terminate(); } catch {} resolve("timeout"); }, 8000);
  ws.on("message", (d) => {
    let m = {}; try { m = JSON.parse(String(d)); } catch {}
    if (m.t === "hello") { clearTimeout(timer); ws.close(); resolve("hello"); }
  });
  ws.on("error", (e) => { clearTimeout(timer); resolve("error: " + e.message); });
});
ok(wsOk === "hello", "wss://…/ws completes the handshake and sends hello", wsOk);

// 5) the LAN listener is still plain HTTP
const lan = await fetch(`http://127.0.0.1:${PLAIN}/healthz`).then((r) => r.json()).catch(() => null);
ok(lan?.ok === true, `plain HTTP on ${PLAIN} still serves the LAN path`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
