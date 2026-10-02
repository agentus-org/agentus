// Auth matrix — asserts the LOCK, not the UI. Every entry point that can drive an
// agent must refuse an anonymous caller, and both legitimate credentials must work.
//
//   node scripts/auth-smoke.mjs
//
// Self-contained: spawns its own server on a free port with a throwaway data dir,
// so it is safe to run in CI and against a live dev server alike.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const ROOT = path.resolve(import.meta.dirname, "..");
const PASSWORD = "s3cret-pass";
const USER = "admin";
const results = [];
let failed = 0;

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Boot a server on PORT with DATA; resolves once /healthz answers (or rejects). */
async function boot(port, dataDir, extraEnv = {}) {
  const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "development",
      AGENTSLOT_PORT: String(port),
      AGENTSLOT_DATA: dataDir,
      AGENTSLOT_USERNAME: USER,
      AGENTSLOT_PASSWORD: PASSWORD,
      AGENTSLOT_LOGIN_MAX_FAILS: "3",
      AGENTSLOT_LOGIN_LOCK_MS: "1200",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (d) => { log += String(d); });
  proc.stderr.on("data", (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return { proc, base, log: () => log };
    } catch { /* not up yet */ }
    await sleep(250);
  }
  proc.kill("SIGKILL");
  throw new Error(`server never came up on ${port}:\n${log}`);
}

function status(res) {
  return res.status;
}

// ---- server A: the main matrix -------------------------------------------------
const dataA = mkdtempSync(path.join(tmpdir(), "agentslot-authA-"));
const a = await boot(8899, dataA);

// key material landed with tight permissions
const tokenFile = path.join(dataA, "auth.token");
const secretFile = path.join(dataA, "auth.secret");
check("machine token file exists", fs.existsSync(tokenFile));
check("machine token is 0600", fs.existsSync(tokenFile) && (fs.statSync(tokenFile).mode & 0o777) === 0o600,
  fs.existsSync(tokenFile) ? `mode ${(fs.statSync(tokenFile).mode & 0o777).toString(8)}` : "missing");
check("session secret file exists", fs.existsSync(secretFile));
const machineToken = fs.readFileSync(tokenFile, "utf8").trim();

// 1. anonymous REST is closed
check("GET /api/sessions anon -> 401", status(await fetch(`${a.base}/api/sessions`)) === 401);
check("POST /api/sessions anon -> 401",
  status(await fetch(`${a.base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })) === 401);
check("GET /api/backends anon -> 401", status(await fetch(`${a.base}/api/backends`)) === 401);
check("DELETE /api/sessions/x anon -> 401", status(await fetch(`${a.base}/api/sessions/x`, { method: "DELETE" })) === 401);

// 2. the login page itself must load without a cookie, else you can never log in
check("GET / anon -> 200 (login shell)", status(await fetch(`${a.base}/`)) === 200);
check("GET /healthz anon -> 200 (liveness)", status(await fetch(`${a.base}/healthz`)) === 200);
check("GET /api/auth/me anon -> 200 authenticated:false", await (async () => {
  const r = await fetch(`${a.base}/api/auth/me`);
  const b = await r.json();
  return r.status === 200 && b.authenticated === false && b.authEnabled === true;
})());

// 3. anonymous WS upgrade is refused before it becomes a socket
check("WS anon is refused", await (async () => {
  const ws = new WebSocket(`ws://127.0.0.1:8899/ws`);
  return await new Promise((resolve) => {
    const done = (v) => resolve(v);
    ws.on("open", () => { ws.close(); done(false); });
    ws.on("error", (e) => done(String(e.message).includes("401")));
    ws.on("unexpected-response", (_q, res) => { const code = res.statusCode; res.destroy(); done(code === 401); });
    setTimeout(() => done(false), 4000);
  });
})());

// 4. wrong password, then lockout
check("login wrong password -> 401", status(await fetch(`${a.base}/api/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: USER, password: "nope" }),
})) === 401);
for (let i = 0; i < 2; i++) {
  await fetch(`${a.base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USER, password: "nope" }),
  });
}
const locked = await fetch(`${a.base}/api/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: USER, password: PASSWORD }),
});
check("brute force -> 429 even with the right password", locked.status === 429, `got ${locked.status}`);

// lock expires (LOCK_MS=1200)
await sleep(1400);

// 5. correct password mints a session cookie
const login = await fetch(`${a.base}/api/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: USER, password: PASSWORD }),
});
const cookieRaw = login.headers.get("set-cookie") ?? "";
const cookie = cookieRaw.split(";")[0];
check("login ok -> 200", login.status === 200, `status ${login.status}`);
check("cookie is HttpOnly + SameSite", /HttpOnly/i.test(cookieRaw) && /SameSite=Lax/i.test(cookieRaw), cookieRaw.slice(0, 90));
check("cookie is NOT Secure on plain http", !/;\s*Secure/i.test(cookieRaw));

check("GET /api/sessions with cookie -> 200", status(await fetch(`${a.base}/api/sessions`, { headers: { cookie } })) === 200);

// 6. tampering is detected (signature, not just shape)
const tampered = cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
check("tampered cookie -> 401", status(await fetch(`${a.base}/api/sessions`, { headers: { cookie: tampered } })) === 401);
const forged = `v1.${Buffer.from(JSON.stringify({ u: USER, iat: 1, exp: 4102444800, jti: "deadbeef" })).toString("base64url")}.AAAA`;
check("hand-forged cookie -> 401", status(await fetch(`${a.base}/api/sessions`, { headers: { cookie: `agentslot_session=${forged}` } })) === 401);

// 7. the cookie also authorises the socket
check("WS with cookie -> hello event", await (async () => {
  const ws = new WebSocket(`ws://127.0.0.1:8899/ws`, { headers: { cookie } });
  return await new Promise((resolve) => {
    const t = setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, 4000);
    ws.on("message", (raw) => {
      const e = JSON.parse(String(raw));
      if (e.t === "hello") { clearTimeout(t); ws.close(); resolve(true); }
    });
    ws.on("error", () => { clearTimeout(t); resolve(false); });
  });
})());

// 8. machine token works for scripts (both carriers)
const auth = { authorization: `Bearer ${machineToken}` };
check("machine token as Bearer -> 200", status(await fetch(`${a.base}/api/sessions`, { headers: auth })) === 200);
check("machine token as ?token= -> 200", status(await fetch(`${a.base}/api/sessions?token=${machineToken}`)) === 200);
check("bogus machine token -> 401", status(await fetch(`${a.base}/api/sessions`, { headers: { authorization: "Bearer nope" } })) === 401);
check("WS with ?token= -> hello event", await (async () => {
  const ws = new WebSocket(`ws://127.0.0.1:8899/ws?token=${machineToken}`);
  return await new Promise((resolve) => {
    const t = setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, 4000);
    ws.on("message", (raw) => {
      if (JSON.parse(String(raw)).t === "hello") { clearTimeout(t); ws.close(); resolve(true); }
    });
    ws.on("error", () => { clearTimeout(t); resolve(false); });
  });
})());

// 9. logout revokes the session (not just "clears a cookie in the browser")
const logout = await fetch(`${a.base}/api/auth/logout`, { method: "POST", headers: { cookie } });
const logoutBody = await logout.json().catch(() => ({}));
check("logout reports the revocation", logout.status === 200 && logoutBody.revoked === true, JSON.stringify(logoutBody));
check("reusing the logged-out cookie -> 401", status(await fetch(`${a.base}/api/sessions`, { headers: { cookie } })) === 401);
a.proc.kill("SIGTERM");
await sleep(300);

// ---- server B: expiry is enforced, not merely signed ---------------------------
const dataB = mkdtempSync(path.join(tmpdir(), "agentslot-authB-"));
// exp is stamped in SECONDS (JWT-style), so a sub-second TTL can expire inside the
// same second it was minted — keep this comfortably above the granularity.
const b = await boot(8898, dataB, { AGENTSLOT_SESSION_TTL_MS: "2000" });
const loginB = await fetch(`${b.base}/api/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: USER, password: PASSWORD }),
});
const cookieB = (loginB.headers.get("set-cookie") ?? "").split(";")[0];
check("short-TTL session works immediately",
  status(await fetch(`${b.base}/api/sessions`, { headers: { cookie: cookieB } })) === 200);
await sleep(2600);
check("expired session -> 401", status(await fetch(`${b.base}/api/sessions`, { headers: { cookie: cookieB } })) === 401);
b.proc.kill("SIGTERM");
await sleep(300);

// ---- server C: AGENTSLOT_AUTH=off is honoured (local dev escape hatch) ---------
const dataC = mkdtempSync(path.join(tmpdir(), "agentslot-authC-"));
const c = await boot(8897, dataC, { AGENTSLOT_AUTH: "off" });
check("auth off -> anonymous API works", status(await fetch(`${c.base}/api/sessions`)) === 200);
check("auth off -> /api/auth/me says authenticated", await (async () => {
  const b2 = await (await fetch(`${c.base}/api/auth/me`)).json();
  return b2.authEnabled === false && b2.authenticated === true;
})());
c.proc.kill("SIGTERM");

console.log(`\n${failed === 0 ? "AUTH SMOKE PASS" : `AUTH SMOKE FAIL (${failed} of ${results.length})`}`);
process.exit(failed === 0 ? 0 : 1);
