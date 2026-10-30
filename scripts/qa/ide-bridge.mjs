// Web IDE bridge (issue #77), end to end — through the REAL server, not a stub of it.
//
// What is being proved, and why each item is here rather than in a unit test:
//
//  1. AUTH IS INHERITED, NOT RE-IMPLEMENTED. The proxy path must answer 401 without the operator's
//     cookie, because the only thing between the network and a full IDE (terminal + file writes) is
//     `auth.ts::requiresAuth`. A proxy mounted outside `/api/` would be "static" and wide open; this
//     script hits the real gate on the real server.
//  2. THE PREFIX IS STRIPPED AND PUT BACK. `x-forwarded-prefix` is what keeps code-server's absolute
//     URLs (and its redirects) inside the mount; a Location that escapes lands on the SPA shell and
//     the iframe goes black with no error anywhere.
//  3. THE SOCKET IS FORWARDED. An IDE whose HTTP works and whose upgrade does not looks alive and
//     cannot load — the most confusing half-failure in the whole integration.
//  4. UNCONFIGURED MEANS ABSENT. With `AGENTUS_IDE_UPSTREAM` unset, every pre-existing route must
//     answer exactly as before — the default-regression clause in the issue.
//
//   node scripts/qa/ide-bridge.mjs
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});

/* ---- the fake IDE: answers HTTP, speaks WebSocket, and records what it was asked ---- */
const seen = [];
const upstream = http.createServer((req, res) => {
  seen.push({ path: req.url, headers: { ...req.headers } });
  if (req.url.startsWith("/redirect")) {
    res.writeHead(302, { location: "/login?to=editor" });
    return res.end();
  }
  if (req.url.startsWith("/boom")) { res.writeHead(503, { "content-type": "text/plain" }); return res.end("upstream down"); }
  res.writeHead(200, { "content-type": "text/html", "cache-control": "public, max-age=600" });
  res.end(`<html><body>fake ide ${req.url}</body></html>`);
});
const upstreamSockets = new WebSocketServer({ server: upstream });
upstreamSockets.on("connection", (ws) => { ws.on("message", (m) => ws.send(`echo:${m.toString()}`)); });
const upstreamPort = await freePort();
await new Promise((r) => upstream.listen(upstreamPort, "127.0.0.1", r));

const startServer = async (extraEnv) => {
  const port = await freePort();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-ide-"));
  const child = spawn(process.execPath, ["--import", "tsx", "packages/server/src/index.ts"], {
    cwd: REPO,
    env: { ...process.env, AGENTUS_PORT: String(port), AGENTUS_DATA: data, AGENTUS_PASSWORD: "qa-ide-pw", DEV_TREE: "", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d.toString(); });
  child.stderr.on("data", (d) => { log += d.toString(); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(`${base}/healthz`); if (r.ok) return { child, base, port, data, log: () => log }; } catch { /* not up yet */ }
    if (child.exitCode != null) break;
    await sleep(250);
  }
  throw new Error(`server on ${port} never became healthy:\n${log.slice(-2000)}`);
};

const login = async (base) => {
  const r = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "qa-ide-pw" }),
  });
  if (!r.ok) throw new Error(`login failed: ${r.status} ${await r.text()}`);
  const raw = r.headers.getSetCookie?.() ?? [r.headers.get("set-cookie") ?? ""];
  return raw.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
};

const stop = async (srv) => {
  try { srv.child.kill("SIGTERM"); } catch { /* already gone */ }
  await sleep(300);
};

const wsEcho = (port, cookie, path0) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path0}`, { headers: cookie ? { cookie } : {} });
  const done = (v) => { try { ws.close(); } catch { /* closed */ } resolve(v); };
  const t = setTimeout(() => done({ ok: false, why: "no answer in 4s" }), 4000);
  ws.on("open", () => ws.send("ping"));
  ws.on("message", (m) => { clearTimeout(t); done({ ok: m.toString() === "echo:ping", why: m.toString() }); });
  ws.on("unexpected-response", (_req, res) => { clearTimeout(t); done({ ok: false, why: `handshake ${res.statusCode}` }); });
  ws.on("error", (e) => { clearTimeout(t); done({ ok: false, why: String(e?.message ?? e) }); });
});

/* ============================ configured ============================ */
const ide = await startServer({ AGENTUS_IDE_UPSTREAM: `http://127.0.0.1:${upstreamPort}` });
try {
  // 1. the gate, before anything else
  const noCookie = await fetch(`${ide.base}/api/ide/status`);
  check("no cookie ⇒ 401 on the IDE path (the gate is inherited, not re-implemented)", noCookie.status === 401, `status ${noCookie.status}`);

  const cookie = await login(ide.base);
  const st = await (await fetch(`${ide.base}/api/ide/status`, { headers: { cookie } })).json();
  check("status: configured + reachable", st.configured === true && st.reachable === true, JSON.stringify({ c: st.configured, r: st.reachable }));
  check("status: base echoes the configured upstream", st.base === `http://127.0.0.1:${upstreamPort}`, st.base ?? "null");
  check("status: prefix is the mount", st.prefix === "/api/ide", st.prefix ?? "null");
  check("status: ships the start command for the empty state", /code-server --auth none --bind-addr 127\.0\.0\.1/.test(st.start ?? ""), (st.start ?? "").slice(0, 40));

  // 2. forwarding: prefix stripped, prefix advertised, cookie withheld
  seen.length = 0;
  const page = await fetch(`${ide.base}/api/ide/?folder=${encodeURIComponent("/tmp/x")}`, { headers: { cookie } });
  const body = await page.text();
  check("GET /api/ide/ ⇒ 200 from the upstream", page.status === 200 && body.includes("fake ide"), `${page.status} ${body.slice(0, 40)}`);
  const got = seen.at(-1) ?? { path: "", headers: {} };
  check("upstream saw the prefix stripped, query intact", got.path === "/?folder=%2Ftmp%2Fx", got.path);
  check("x-forwarded-prefix tells the upstream where it is mounted", got.headers["x-forwarded-prefix"] === "/api/ide", String(got.headers["x-forwarded-prefix"]));
  check("the operator's cookie is NOT forwarded to the IDE", got.headers.cookie === undefined, String(got.headers.cookie));
  check("HTML is not cached (it names a build)", /no-store/.test(String(page.headers.get("cache-control"))), String(page.headers.get("cache-control")));

  // 3. redirects stay inside the mount
  const redir = await fetch(`${ide.base}/api/ide/redirect`, { headers: { cookie }, redirect: "manual" });
  check("upstream Location is re-prefixed", redir.headers.get("location") === "/api/ide/login?to=editor", String(redir.headers.get("location")));

  // 4. an upstream error is passed through, not turned into a blank frame
  const boom = await fetch(`${ide.base}/api/ide/boom`, { headers: { cookie } });
  check("a 5xx from upstream is forwarded as-is", boom.status === 503, `status ${boom.status}`);

  // 5. the socket — the half-failure this feature is most likely to ship with
  const wsOk = await wsEcho(ide.port, cookie, "/api/ide/socket");
  check("WebSocket upgrade is forwarded through the mount", wsOk.ok, wsOk.why);
  const wsNo = await wsEcho(ide.port, "", "/api/ide/socket");
  check("WebSocket without a cookie is refused", !wsNo.ok && /40[13]/.test(wsNo.why), wsNo.why);

  // 6. a legitimately unrelated path is untouched
  const version = await fetch(`${ide.base}/api/version`);
  check("/api/version still answers (no route side effects)", version.ok && "commit" in (await version.json()), `status ${version.status}`);
} finally {
  await stop(ide);
}

/* ============================ unconfigured ============================ */
const plain = await startServer({ AGENTUS_IDE_UPSTREAM: "" });
try {
  const st = await (await fetch(`${plain.base}/api/ide/status`, { headers: { cookie: await login(plain.base) } })).json();
  check("unconfigured: status says configured:false / reachable:false", st.configured === false && st.reachable === false, JSON.stringify({ c: st.configured, r: st.reachable }));
  const proxy = await fetch(`${plain.base}/api/ide/`, { headers: { cookie: await login(plain.base) } });
  const body = await proxy.text();
  check("unconfigured: the proxy path answers 503 with the reason, not a fake page", proxy.status === 503 && body.includes("ide_not_configured"), `${proxy.status} ${body.slice(0, 60)}`);

  // the documented reason rule 1 exists: anything outside /api/ is served as a static asset
  const shell = await fetch(`${plain.base}/ide/`);
  const shellBody = await shell.text();
  check("an unknown non-/api/ path is the SPA shell, unauthenticated (why the mount must be under /api/)",
    shell.status === 200 && /<html/i.test(shellBody), `${shell.status} ${String(shell.headers.get("content-type"))}`);

  const health = await fetch(`${plain.base}/healthz`);
  check("/healthz unaffected", health.ok, `status ${health.status}`);
} finally {
  await stop(plain);
  upstreamSockets.close();
  upstream.close();
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
