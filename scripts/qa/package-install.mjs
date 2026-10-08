// Does the PACKAGED cockpit actually run? — `npm run package-smoke`
//
// Why this exists: the tarball is the artifact users get, and every failure mode here is
// invisible from inside the repo. It packed a web bundle that was never built, shipped a
// server that needs tsx at runtime while tsx was a devDependency, resolved `@agentus/shared`
// through a workspace link that a tarball does not have, or wrote its state into
// node_modules where the next upgrade deletes it. A green repo (typecheck + the in-repo
// smokes) proves none of that.
//
// What it does, in one process, serially (a build running next to a serve of the same
// dist/ is how you get a half-stale bundle — a documented failure in this project):
//   pack → install into a throwaway prefix with a throwaway HOME → boot from that install
//   with a scrubbed environment → drive the real API and the real mock agent → assert the
//   state went to ~/.agentus and nowhere near node_modules → stop and check for leftovers.
//
// Usage: node scripts/qa/package-install.mjs [--keep]   (--keep leaves the temp tree)
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const KEEP = process.argv.includes("--keep");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-package-"));
const fakeHome = path.join(scratch, "home");
const prefix = path.join(scratch, "prefix");
fs.mkdirSync(fakeHome, { recursive: true });
fs.mkdirSync(prefix, { recursive: true });

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
});

// ── 1. pack (prepack builds the web bundle) ────────────────────────────────────────────
console.log(`[package-smoke] packing in ${ROOT}`);
const packed = run("npm", ["pack", "--silent"], { cwd: ROOT });
if (packed.status !== 0) { console.error(packed.stderr || packed.stdout); process.exit(1); }
const tarballName = String(packed.stdout).trim().split("\n").pop().trim();
const tarball = path.join(ROOT, tarballName);
check("npm pack produced a tarball", fs.existsSync(tarball), tarballName);

const listed = run("tar", ["-tzf", tarball]).stdout.split("\n");
const has = (re) => listed.some((l) => re.test(l));
check("the tarball ships the built web bundle", has(/package\/packages\/web\/dist\/index\.html$/));
check("the tarball ships a hashed bundle asset", has(/package\/packages\/web\/dist\/assets\/index-.*\.js$/));
check("the tarball ships the server sources", has(/package\/packages\/server\/src\/index\.ts$/));
check("the tarball ships packages/server/package.json (type: module)", has(/package\/packages\/server\/package\.json$/));
check("the tarball ships the mock agent and the plan MCP server",
  has(/package\/packages\/server\/mock\/agent\.mjs$/) && has(/package\/packages\/server\/mcp\/plan-server\.mjs$/));
check("the tarball ships the CLI entry", has(/package\/bin\/agentus\.mjs$/));
check("the tarball carries no node_modules", !has(/node_modules\//));

// ── 2. install into an isolated prefix ─────────────────────────────────────────────────
const installed = run("npm", ["install", "-g", "--prefix", prefix, tarball], {
  env: { ...process.env, HOME: fakeHome, npm_config_cache: path.join(scratch, "npmcache") },
});
check("the tarball installs globally", installed.status === 0, String(installed.stderr).split("\n").slice(-2).join(" "));
const pkgDir = path.join(prefix, "lib/node_modules/agentus");
const bin = path.join(prefix, "bin/agentus");
check("the install exposes an `agentus` command", fs.existsSync(bin));

// ── 3. boot it with a scrubbed environment ─────────────────────────────────────────────
// `env -i` equivalent: the agent/CI shell may carry a live instance's AGENTUS_* variables,
// and inheriting them would test the other instance's store instead of this one.
const port = await freePort();
const env = { HOME: fakeHome, PATH: process.env.PATH, TERM: "xterm", TMPDIR: os.tmpdir() };
const log = [];
const child = spawn(bin, ["--port", String(port)], { env, cwd: scratch, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (d) => log.push(String(d)));
child.stderr.on("data", (d) => log.push(String(d)));

const base = `http://127.0.0.1:${port}`;
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await fetch(`${base}/healthz`)).ok; } catch { await sleep(500); }
}
check("the installed package boots and answers /healthz", up, `:${port}`);
const bootLog = log.join("");
const dataDir = path.join(fakeHome, ".agentus");
check("the boot log names the data directory it opened", bootLog.includes("data dir:"), bootLog.split("\n").find((l) => l.includes("data dir:"))?.trim());
check("it opened ~/.agentus, not a directory inside node_modules", bootLog.includes(dataDir) && !bootLog.includes(path.join(pkgDir, "packages/server/.data")));

if (up) {
  // 4. the lock, the shell and its bundle
  check("anonymous /api/sessions is refused", (await fetch(`${base}/api/sessions`)).status === 401);
  const html = await (await fetch(`${base}/`)).text();
  const asset = html.match(/assets\/index-[\w-]+\.js/);
  check("the app shell is served", /<div id="root">/.test(html));
  const js = asset ? await fetch(`${base}/${asset[0]}`) : null;
  check("the hashed bundle is served from the tarball", js ? js.status === 200 && (await js.text()).length > 100_000 : false, asset?.[0] ?? "no asset referenced");
  const forged = await (await fetch(`${base}/api/auth/me`, { headers: { cookie: "agentus_session=forged" } })).json();
  check("a forged cookie is not authenticated", forged.authenticated === false);

  // 5. operator login
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "123456" }),
  });
  const setCookies = login.headers.getSetCookie?.() ?? [];
  check("the default credentials log in", login.ok, `status ${login.status}`);
  check("login sets an HttpOnly cookie", setCookies.some((c) => /httponly/i.test(c)));

  // 6. a real turn on the shipped mock agent: spawn → ACP → stream → persist
  const token = fs.readFileSync(path.join(dataDir, "auth.token"), "utf8").trim();
  const work = path.join(fakeHome, "work");
  fs.mkdirSync(work, { recursive: true });
  const created = await fetch(`${base}/api/sessions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ backend: "mock", cwd: work }),
  });
  const session = await created.json().catch(() => ({}));
  check("the machine token creates a mock session", created.status === 201, `status ${created.status}`);

  if (session.id) {
    const turn = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
      let chunks = 0;
      const done = (v) => { try { ws.close(); } catch {} resolve(v); };
      const timer = setTimeout(() => done({ timeout: true }), 25_000);
      ws.onopen = () => ws.send(JSON.stringify({ t: "prompt", sessionId: session.id, text: "package smoke" }));
      ws.onmessage = (ev) => {
        const e = JSON.parse(String(ev.data));
        if (e.t === "message" && e.message?.kind === "agent") chunks++;
        if (e.t === "turn-end") { clearTimeout(timer); done({ stop: e.stopReason ?? e.error ?? "", chunks }); }
      };
      ws.onerror = () => { clearTimeout(timer); done({ error: "ws error" }); };
    });
    check("a mock turn streams to the end", !turn.timeout && !turn.error && turn.chunks > 0, `chunks=${turn.chunks} stop=${turn.stop ?? turn.error ?? "timeout"}`);
    const stored = await (await fetch(`${base}/api/sessions/${session.id}/messages`, { headers: { authorization: `Bearer ${token}` } })).json();
    check("the transcript is persisted", (stored.messages?.length ?? 0) > 0, `${stored.messages?.length ?? 0} rows`);
  }

  // 7. state landed in ~/.agentus and NOT inside the installed package
  const entries = fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : [];
  check("state is in ~/.agentus", entries.includes("agentus.sqlite") && entries.includes("auth.token"), entries.join(", "));
  check("~/.agentus is 0700", (fs.statSync(dataDir).mode & 0o777) === 0o700);
  check("auth.token is 0600", (fs.statSync(path.join(dataDir, "auth.token")).mode & 0o777) === 0o600);
  check("nothing was written inside the installed package", !fs.existsSync(path.join(pkgDir, "packages/server/.data")));
}

// 8. --where answers without starting anything, and reports the same directory
{
  const where = run(bin, ["--where"], { env: { ...env, AGENTUS_PORT: String(port) }, cwd: scratch });
  check("--where reports the same data directory", where.stdout.includes(dataDir), where.stdout.split("\n").find((l) => l.includes("data dir"))?.trim() ?? where.stdout.slice(0, 120));
  check("--where exits without listening", where.status === 0);
}

// 9. shutdown leaves nothing behind
child.kill("SIGTERM");
for (let i = 0; i < 20; i++) {
  try { await fetch(`${base}/healthz`); await sleep(500); } catch { break; }
}
let stillListening = false;
try { stillListening = (await fetch(`${base}/healthz`)).ok; } catch { /* expected */ }
check("the listener is gone after SIGTERM", !stillListening);
const leftovers = run("pgrep", ["-fl", path.join(pkgDir, "packages/server")]).stdout.trim();
check("no agent children left running", leftovers === "", leftovers.slice(0, 120));

run("rm", ["-f", tarball]);
if (KEEP) console.log(`[package-smoke] scratch kept at ${scratch}`);
else fs.rmSync(scratch, { recursive: true, force: true });

console.log(failures === 0 ? "\nPACKAGE SMOKE PASS" : `\nPACKAGE SMOKE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
