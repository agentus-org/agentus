#!/usr/bin/env node
/**
 * `agentus` — the command an npm install gives you.
 *
 *   npx agentus                 # start the cockpit on :8787
 *   npx agentus --port 9000     # …somewhere else
 *   npx agentus --data ~/work   # …with its state in a directory you chose
 *   npx agentus --where         # print the resolved paths and exit (nothing starts)
 *
 * This file holds no product logic on purpose. It checks the one hard prerequisite
 * (Node >= 22.5 — the store is `node:sqlite`), maps flags onto the server's own
 * environment variables, and starts `packages/server/src/index.ts` through tsx. There is
 * no build step: the server runs TypeScript in place, in a checkout and in an installed
 * package alike, so `npm i -g agentus` never needs a compiler on the user's machine.
 *
 * WHY `--where` RUNS THE SERVER instead of computing paths here: where the data lives is
 * decided in exactly one place (`packages/server/src/index.ts`, mirrored by
 * scripts/make-cert.sh). A second implementation here would be a second answer to "where
 * did my sessions go" — the one question in this project that must never have two
 * answers. With AGENTUS_PRINT_PATHS=1 the server prints its own resolution (data dir,
 * web bundle, companion APK, node version) and exits before it opens anything.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(PKG_ROOT, "packages/server/src/index.ts");
const require = createRequire(import.meta.url);

const USAGE = `agentus — multi-session web cockpit for ACP-speaking coding agents

Usage
  agentus [options]

Options
  -p, --port <n>     port to listen on                 (AGENTUS_PORT, default 8787)
  -d, --data <dir>   where state lives — sqlite, login, TLS material, settings
                                                       (AGENTUS_DATA, default ~/.agentus)
  -o, --open         open the cockpit in your browser once it is up
      --where        print the resolved paths and exit (starts nothing)
  -h, --help         this text
  -v, --version      print the version

The server reads more environment variables than these (agent backends, auth, TLS,
speech). They are listed in the README, and the boot log prints the ones in play.

Requirements
  Node >= 22.5 (the store is node:sqlite) and at least one ACP agent CLI on PATH —
  "hermes acp" or "qodercli --acp". Without one the cockpit still runs; it just has no
  backend to open a session on. Check the agent side with: hermes acp --check
`;

function fail(message) {
  console.error(`agentus: ${message}`);
  process.exit(1);
}

// node:sqlite landed in 22.5 — check before anything else, same bound as scripts/start.sh.
{
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) {
    fail(`needs Node >= 22.5 (node:sqlite); this is ${process.versions.node}.\n`
      + `  nvm: nvm install 22 && nvm use 22   ·   homebrew: brew install node`);
  }
}

const opts = { port: undefined, data: undefined, open: false, where: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const takeValue = (name) => {
    const inline = a.includes("=") ? a.slice(a.indexOf("=") + 1) : null;
    if (inline !== null) return inline;
    const next = argv[++i];
    if (next === undefined) fail(`${name} needs a value`);
    return next;
  };
  if (a === "-h" || a === "--help") { process.stdout.write(USAGE); process.exit(0); }
  else if (a === "-v" || a === "--version") {
    console.log(require(path.join(PKG_ROOT, "package.json")).version);
    process.exit(0);
  }
  else if (a === "-o" || a === "--open") opts.open = true;
  else if (a === "--where") opts.where = true;
  else if (a === "-p" || a === "--port" || a.startsWith("--port=")) {
    const v = takeValue("--port");
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 65535) fail(`--port wants 1-65535, got "${v}"`);
    opts.port = n;
  }
  else if (a === "-d" || a === "--data" || a.startsWith("--data=")) {
    opts.data = path.resolve(takeValue("--data"));
  }
  else fail(`unknown option "${a}" (try --help)`);
}

if (!fs.existsSync(SERVER)) {
  fail(`this package is incomplete — ${SERVER} is missing. Reinstall: npm i -g agentus@latest`);
}

// tsx ships a loader entry at its package root (`exports["."] → dist/loader.mjs`); resolve
// it to an absolute file URL so `--import` works no matter which directory the user is in.
let loader = null;
try {
  loader = pathToFileURL(require.resolve("tsx")).href;
} catch { /* fall through to the bare specifier below */ }
if (loader && !fs.existsSync(fileURLToPath(loader))) loader = null;
if (!loader) loader = "tsx"; // resolvable from PKG_ROOT/node_modules in the normal install

const env = { ...process.env };
if (opts.port !== undefined) env.AGENTUS_PORT = String(opts.port);
if (opts.data !== undefined) env.AGENTUS_DATA = opts.data;
if (opts.where) env.AGENTUS_PRINT_PATHS = "1";

const port = env.AGENTUS_PORT ?? "8787";
if (!opts.where) {
  console.log(`[agentus] starting — open http://localhost:${port} when it is up (Ctrl-C stops it)`);
}

const child = spawn(process.execPath, ["--import", loader, SERVER], {
  cwd: PKG_ROOT, // so a bare `tsx` specifier and the package's own node_modules both resolve
  env,
  stdio: "inherit",
});
child.on("error", (err) => fail(`could not start the server: ${err.message}`));

if (opts.open && !opts.where) {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const timer = setTimeout(() => {
    const open = spawn(opener, [`http://localhost:${port}`], { detached: true, stdio: "ignore" });
    open.on("error", () => {}); // no opener on this box is not worth a line of noise
    open.unref();
  }, 1500);
  timer.unref();
}

// Ctrl-C reaches the child through the shared process group; these handlers exist so a
// signal sent to this process alone still takes the server (and its agent children) down.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { try { child.kill(sig); } catch { /* already gone */ } });
}
child.on("exit", (code, signal) => {
  process.exit(signal ? 130 : code ?? 0);
});
