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
import { createServer as createTcp } from "node:net";
import { WebSocket } from "ws";

const ROOT = path.resolve(import.meta.dirname, "..");

/** Killing the `tsx` WRAPPER is not killing the server: tsx runs the app as its own child, and
 *  a bare SIGKILL to the wrapper leaves that child listening on a random port for good. That is
 *  exactly how a couple of hundred dead servers piled up on the dev machine. `detached: true`
 *  makes the child a process-group leader, so one negative-pid signal takes the whole tree. */
const killGroup = (target) => {
  const pid = typeof target === "number" ? target : target?.pid;
  if (!pid) return;
  try { process.kill(-pid, "SIGKILL"); } catch { try { killGroup(pid); } catch { /* already gone */ } }
};

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
process.on("exit", () => { for (const c of CHILDREN) { try { killGroup(c); } catch { /* already gone */ } } });


/** Boot a server on PORT with DATA; resolves once /healthz answers (or rejects). */
async function boot(port, dataDir, extraEnv = {}) {
  if (await portInUse(port)) {
    throw new Error(`port ${port} is already in use — a leaked server from an earlier run? `
      + `(lsof -nP -iTCP:${port} -sTCP:LISTEN)`);
  }
  const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
    detached: true,
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
  CHILDREN.add(proc);
  let log = "";
  proc.stdout.on("data", (d) => { log += String(d); });
  proc.stderr.on("data", (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      // any HTTP answer means the listener is up — a 401 counts, and the Basic-locked
      // server D answers 401 to this very probe
      const r = await fetch(`${base}/healthz`);
      if (r.status > 0) return { proc, base, log: () => log };
    } catch { /* not up yet */ }
    await sleep(250);
  }
  killGroup(proc);
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

// ---- server D: the HTTP Basic outer lock ---------------------------------------
// This is the layer a public tunnel relies on, so it gets the same treatment:
// anonymous refusal, challenge header, and the WS handshake behind it.
const dataD = mkdtempSync(path.join(tmpdir(), "agentslot-authD-"));
const BASIC_USER = "outer";
const BASIC_PASS = "outer-pass";
const d = await boot(8896, dataD, { AGENTSLOT_BASIC_AUTH: `${BASIC_USER}:${BASIC_PASS}`, AGENTSLOT_AUTH: "off" });
const basicHeader = { authorization: `Basic ${Buffer.from(`${BASIC_USER}:${BASIC_PASS}`).toString("base64")}` };

check("basic: anon /healthz -> 401", status(await fetch(`${d.base}/healthz`)) === 401);
const challenge = await fetch(`${d.base}/healthz`);
check("basic: 401 carries WWW-Authenticate", /^Basic realm=/i.test(challenge.headers.get("www-authenticate") ?? ""),
  challenge.headers.get("www-authenticate") ?? "(missing)");
check("basic: anon app shell -> 401 (static is behind the lock too)", status(await fetch(`${d.base}/`)) === 401);
check("basic: anon /api/sessions -> 401", status(await fetch(`${d.base}/api/sessions`)) === 401);
check("basic: wrong password -> 401", status(await fetch(`${d.base}/healthz`, {
  headers: { authorization: `Basic ${Buffer.from(`${BASIC_USER}:nope`).toString("base64")}` },
})) === 401);
check("basic: right password -> 200", status(await fetch(`${d.base}/healthz`, { headers: basicHeader })) === 200);
check("basic: /api/sessions behind it -> 200", status(await fetch(`${d.base}/api/sessions`, { headers: basicHeader })) === 200);
check("basic: WS without Basic -> refused", await (async () => {
  const ws = new WebSocket("ws://127.0.0.1:8896/ws");
  return await new Promise((resolve) => {
    const done = (v) => resolve(v);
    ws.on("open", () => { ws.close(); done(false); });
    ws.on("unexpected-response", (_q, res) => { const c = res.statusCode; res.destroy(); done(c === 401); });
    ws.on("error", () => done(false));
    setTimeout(() => done(false), 4000);
  });
})());
check("basic: WS with Basic -> hello event", await (async () => {
  const ws = new WebSocket("ws://127.0.0.1:8896/ws", { headers: basicHeader });
  return await new Promise((resolve) => {
    const t = setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, 4000);
    ws.on("message", (raw) => {
      if (JSON.parse(String(raw)).t === "hello") { clearTimeout(t); ws.close(); resolve(true); }
    });
    ws.on("error", () => { clearTimeout(t); resolve(false); });
  });
})());
d.proc.kill("SIGTERM");
await sleep(300);

// ---- server E: password-only Basic (":pass" / "pass") ---------------------------
// The whole point: a single-operator service should not force a username, and a
// malformed-looking config must FAIL CLOSED (gate everyone) rather than silently
// turn the lock off. That is the regression this section guards.
const dataE = mkdtempSync(path.join(tmpdir(), "agentslot-authE-"));
const ONLY_PW = "REDACTED-PASS";
const e = await boot(8895, dataE, { AGENTSLOT_BASIC_AUTH: `:${ONLY_PW}`, AGENTSLOT_AUTH: "off" });
const pw = (user) => ({ authorization: `Basic ${Buffer.from(`${user}:${ONLY_PW}`).toString("base64")}` });

check("pw-only: anon still 401 (config did NOT silently disable the lock)", status(await fetch(`${e.base}/healthz`)) === 401);
check("pw-only: blank username + password -> 200", status(await fetch(`${e.base}/healthz`, { headers: pw("") })) === 200);
check("pw-only: any username + password -> 200", status(await fetch(`${e.base}/healthz`, { headers: pw("whatever") })) === 200);
check("pw-only: operator-style username -> 200", status(await fetch(`${e.base}/api/sessions`, { headers: pw("admin") })) === 200);
check("pw-only: wrong password -> 401", status(await fetch(`${e.base}/healthz`, {
  headers: { authorization: `Basic ${Buffer.from("admin:wrong").toString("base64")}` },
})) === 401);
check("pw-only: WS with password-only creds -> hello", await (async () => {
  const ws = new WebSocket("ws://127.0.0.1:8895/ws", { headers: pw("admin") });
  return await new Promise((resolve) => {
    const t = setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, 4000);
    ws.on("message", (raw) => {
      if (JSON.parse(String(raw)).t === "hello") { clearTimeout(t); ws.close(); resolve(true); }
    });
    ws.on("error", () => { clearTimeout(t); resolve(false); });
  });
})());
e.proc.kill("SIGTERM");
await sleep(300);

// ---- server F: the bare "pass" form (no colon at all) ---------------------------
const dataF = mkdtempSync(path.join(tmpdir(), "agentslot-authF-"));
const f = await boot(8894, dataF, { AGENTSLOT_BASIC_AUTH: ONLY_PW, AGENTSLOT_AUTH: "off" });
check("bare form: anon 401", status(await fetch(`${f.base}/healthz`)) === 401);
check("bare form: any user + password -> 200", status(await fetch(`${f.base}/healthz`, { headers: pw("admin") })) === 200);
f.proc.kill("SIGTERM");
await sleep(300);


// ---- server G: changing the username / password from the app --------------------
// Credentials used to be env-only (edit + restart). They are now editable in the settings
// page and take effect immediately. This guards the whole contract: the current password is
// required, short passwords and broken usernames are refused, the file is 0600 and holds a
// scrypt hash (never the password), every older cookie dies, the caller keeps working, and
// the change survives a restart.
const dataG = mkdtempSync(path.join(tmpdir(), "agentslot-authG-"));
const g = await boot(8893, dataG);
const jsonLogin = (base, username, password) => fetch(`${base}/api/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }),
});
const cookieOf = (res) => (res.headers.get("set-cookie") ?? "").split(";")[0];
const change = (base, cookie, body) => fetch(`${base}/api/auth/credentials`, {
  method: "POST",
  headers: cookie ? { "content-type": "application/json", cookie } : { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const gLogin = await jsonLogin(g.base, USER, PASSWORD);
const callerCookie = cookieOf(gLogin);
const otherLogin = await jsonLogin(g.base, USER, PASSWORD);
const otherCookie = cookieOf(otherLogin);
check("creds: two sessions to start with", callerCookie.startsWith("agentslot_session=") && otherCookie.startsWith("agentslot_session=") && otherCookie !== callerCookie);

check("creds: anonymous -> 401", (await change(g.base, "", { currentPassword: PASSWORD, newPassword: "brand-new-pass" })).status === 401);
check("creds: wrong current password -> 401", (await change(g.base, callerCookie, { currentPassword: "not-it", newPassword: "brand-new-pass" })).status === 401);
check("creds: short password -> 400", (await change(g.base, callerCookie, { currentPassword: PASSWORD, newPassword: "abc" })).status === 400);
check("creds: username with a space -> 400", (await change(g.base, callerCookie, { currentPassword: PASSWORD, username: "a b" })).status === 400);
check("creds: nothing to change -> 400", (await change(g.base, callerCookie, { currentPassword: PASSWORD })).status === 400);
check("creds: still nothing applied (old password logs in)", (await jsonLogin(g.base, USER, PASSWORD)).status === 200);

const okChange = await change(g.base, callerCookie, { currentPassword: PASSWORD, username: "operator", newPassword: "long-enough-pass" });
check("creds: change accepted -> 200", okChange.status === 200, `got ${okChange.status}`);
const freshCookie = cookieOf(okChange);
check("creds: caller is handed a fresh cookie", freshCookie.startsWith("agentslot_session=") && freshCookie !== callerCookie);

const credFile = path.join(dataG, "credentials.json");
check("creds: credentials.json written", fs.existsSync(credFile));
check("creds: credentials.json is 0600", fs.existsSync(credFile) && (fs.statSync(credFile).mode & 0o777) === 0o600,
  fs.existsSync(credFile) ? `mode ${(fs.statSync(credFile).mode & 0o777).toString(8)}` : "missing");
const credRaw = fs.existsSync(credFile) ? fs.readFileSync(credFile, "utf8") : "";
check("creds: stores a scrypt hash, never the password", credRaw.includes("scrypt:") && !credRaw.includes("long-enough-pass"));

check("creds: old password -> 401", (await jsonLogin(g.base, USER, PASSWORD)).status === 401);
check("creds: old username + new password -> 401", (await jsonLogin(g.base, USER, "long-enough-pass")).status === 401);
check("creds: new username + new password -> 200", (await jsonLogin(g.base, "operator", "long-enough-pass")).status === 200);

check("creds: the other session's cookie is dead -> 401",
  (await fetch(`${g.base}/api/sessions`, { headers: { cookie: otherCookie } })).status === 401);
check("creds: the caller's re-issued cookie still works",
  (await fetch(`${g.base}/api/sessions`, { headers: { cookie: freshCookie } })).status === 200);

const meBody = await (await fetch(`${g.base}/api/auth/me`, { headers: { cookie: freshCookie } })).json();
check("creds: /api/auth/me names the source + drops the default-password flag",
  meBody.credentialSource === "saved" && meBody.usingDefaultPassword === false && meBody.configuredUsername === "operator",
  JSON.stringify({ source: meBody.credentialSource, def: meBody.usingDefaultPassword, user: meBody.configuredUsername }));

const pwOnly = await change(g.base, freshCookie, { currentPassword: "long-enough-pass", newPassword: "another-pass" });
check("creds: password-only change -> 200", pwOnly.status === 200);
const pwOnlyCookie = cookieOf(pwOnly);
check("creds: username survived a password-only change",
  (await (await fetch(`${g.base}/api/auth/me`, { headers: { cookie: pwOnlyCookie } })).json()).configuredUsername === "operator");

const gt = fs.readFileSync(path.join(dataG, "auth.token"), "utf8").trim();
check("creds: the machine token still works after a change",
  (await fetch(`${g.base}/api/sessions`, { headers: { authorization: `Bearer ${gt}` } })).status === 200);

// survives a restart: the file, not the process, is the source of truth
g.proc.kill("SIGTERM");
await sleep(600);
const g2 = await boot(8893, dataG);
check("creds: after a restart the saved password logs in", (await jsonLogin(g2.base, "operator", "another-pass")).status === 200);
check("creds: after a restart the env password is gone", (await jsonLogin(g2.base, USER, PASSWORD)).status === 401);
g2.proc.kill("SIGTERM");
await sleep(300);


// ---- server H: the session registry + login locks -------------------------------
// Sessions are stateless cookies, so without a registry "who is signed in" is unanswerable
// and a stolen cookie cannot be revoked. This guards the registry (list / revoke one / log
// out everywhere / survive a restart) and the visible login limiter (locked IP can be seen
// and lifted) — the two account-management pieces hermes-studio's AccountSettings has.
const dataH = mkdtempSync(path.join(tmpdir(), "agentslot-authH-"));
const h = await boot(8892, dataH);
const hLogin = async () => cookieOf(await jsonLogin(h.base, USER, PASSWORD));
const ckA = await hLogin();
const ckB = await hLogin();
check("sessions: two logins -> two sessions, exactly one marked current", await (async () => {
  const r = await fetch(`${h.base}/api/auth/sessions`, { headers: { cookie: ckA } });
  const b = await r.json();
  return r.status === 200 && b.sessions.length === 2 && b.sessions.filter((x) => x.current).length === 1
    && b.sessions.every((x) => x.username === USER && x.ua.length > 0);
})());
check("sessions: anonymous -> 401", status(await fetch(`${h.base}/api/auth/sessions`)) === 401);
const rowsH = (await (await fetch(`${h.base}/api/auth/sessions`, { headers: { cookie: ckA } })).json()).sessions;
const mineH = rowsH.find((x) => x.current).jti;
const otherH = rowsH.find((x) => !x.current).jti;
check("sessions: revoking yourself is refused (that is log out)", status(await fetch(`${h.base}/api/auth/sessions/revoke`, {
  method: "POST", headers: { "content-type": "application/json", cookie: ckA }, body: JSON.stringify({ jti: mineH }),
})) === 400);
check("sessions: unknown id -> 404", status(await fetch(`${h.base}/api/auth/sessions/revoke`, {
  method: "POST", headers: { "content-type": "application/json", cookie: ckA }, body: JSON.stringify({ jti: "nope" }),
})) === 404);
check("sessions: revoke the other device -> 200", status(await fetch(`${h.base}/api/auth/sessions/revoke`, {
  method: "POST", headers: { "content-type": "application/json", cookie: ckA }, body: JSON.stringify({ jti: otherH }),
})) === 200);
check("sessions: the revoked cookie is dead on a gated route", status(await fetch(`${h.base}/api/sessions`, { headers: { cookie: ckB } })) === 401);
check("sessions: the revoked cookie is dead (me reports anonymous)",
  (await (await fetch(`${h.base}/api/auth/me`, { headers: { cookie: ckB } })).json()).authenticated === false);
check("sessions: the caller is untouched", status(await fetch(`${h.base}/api/sessions`, { headers: { cookie: ckA } })) === 200);
const registry = path.join(dataH, "sessions.json");
check("sessions: registry file is 0600", fs.existsSync(registry) && (fs.statSync(registry).mode & 0o777) === 0o600);
check("sessions: registry holds no token material", fs.existsSync(registry) && !fs.readFileSync(registry, "utf8").includes("agentslot_session"));

// log out everywhere
await hLogin();
await hLogin();
const hAll = await fetch(`${h.base}/api/auth/sessions/revoke-others`, { method: "POST", headers: { cookie: ckA } });
const hAllBody = await hAll.json();
check("sessions: log out everywhere drops the others", hAll.status === 200 && hAllBody.count === 2, JSON.stringify(hAllBody));
check("sessions: only the caller is left", (await (await fetch(`${h.base}/api/auth/sessions`, { headers: { cookie: ckA } })).json()).sessions.length === 1);

// restart: the registry is the source of truth
h.proc.kill("SIGTERM");
await sleep(600);
const h2 = await boot(8892, dataH);
check("sessions: still listed after a restart", (await (await fetch(`${h2.base}/api/auth/sessions`, { headers: { cookie: ckA } })).json()).sessions.length === 1);
check("sessions: a revoked cookie stays dead after a restart", status(await fetch(`${h2.base}/api/sessions`, { headers: { cookie: ckB } })) === 401);

// login locks: visible and liftable
check("locks: anonymous -> 401", status(await fetch(`${h2.base}/api/auth/locked-ips`)) === 401);
for (let i = 0; i < 3; i++) await jsonLogin(h2.base, USER, "wrong-one");
const lockList = await (await fetch(`${h2.base}/api/auth/locked-ips`, { headers: { cookie: ckA } })).json();
check("locks: the locked IP is listed", lockList.locks.some((l) => l.locked && l.ip === "127.0.0.1"), JSON.stringify(lockList.locks));
check("locks: a locked IP gets 429", status(await jsonLogin(h2.base, USER, PASSWORD)) === 429);
check("locks: unlock one -> 200", status(await fetch(`${h2.base}/api/auth/locked-ips?ip=127.0.0.1`, { method: "DELETE", headers: { cookie: ckA } })) === 200);
check("locks: login works again after the unlock", status(await jsonLogin(h2.base, USER, PASSWORD)) === 200);
check("locks: unlocking an unknown IP -> 404", status(await fetch(`${h2.base}/api/auth/locked-ips?ip=10.9.9.9`, { method: "DELETE", headers: { cookie: ckA } })) === 404);
check("locks: clear all -> count", (await (await fetch(`${h2.base}/api/auth/locked-ips`, { method: "DELETE", headers: { cookie: ckA } })).json()).count === 0);
h2.proc.kill("SIGTERM");
await sleep(300);

console.log(`\n${failed === 0 ? "AUTH SMOKE PASS" : `AUTH SMOKE FAIL (${failed} of ${results.length})`}`);
process.exit(failed === 0 ? 0 : 1);
