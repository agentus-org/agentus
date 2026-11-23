// Agentus -> Hermes Studio one-time data migration smoke test.
//
// Proves the "startup check + migrate" contract without booting a full server:
//   1. a legacy ~/.agentus with data is renamed to ~/.hermes-studio (sessions preserved);
//   2. an existing ~/.hermes-studio is left alone (idempotent, never clobbers newer data);
//   3. an explicit HERMES_STUDIO_DATA pin wins and is NOT migrated;
//   4. a legacy AGENTUS_DATA pin is mirrored by the env shim to HERMES_STUDIO_DATA.
// Uses the real bin (`--where`) so it exercises exactly the resolution + migration code the
// packaged product runs.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = path.join(ROOT, "bin/hermes-studio.mjs");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-migration-"));

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const where = (env) => {
  const r = spawnSync(process.execPath, [BIN, "--where"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, TERM: "xterm", TMPDIR: os.tmpdir(), ...env },
  });
  return (r.stdout || "") + (r.stderr || "");
};

// 1. legacy dir holds data, new dir absent -> renamed, contents preserved
const home1 = path.join(scratch, "home1");
fs.mkdirSync(path.join(home1, ".agentus", "sessions"), { recursive: true });
fs.writeFileSync(path.join(home1, ".agentus", "sessions", "old-session.json"), "KEEPME");
let out = where({ HOME: home1 });
check("legacy ~/.agentus copied to ~/.hermes-studio (original kept for rollback)", fs.existsSync(path.join(home1, ".hermes-studio")) && fs.existsSync(path.join(home1, ".agentus")));
check("existing data survived the rename", fs.readFileSync(path.join(home1, ".hermes-studio", "sessions", "old-session.json"), "utf8") === "KEEPME");
check("boot resolution reports the migration", out.includes("migrated from ~/.agentus"), out.split("\n").find((l) => l.includes("data dir"))?.trim());

// 2. new dir already has data -> never overwritten/clobbered
const home2 = path.join(scratch, "home2");
fs.mkdirSync(path.join(home2, ".agentus"), { recursive: true });
fs.mkdirSync(path.join(home2, ".hermes-studio"), { recursive: true });
fs.writeFileSync(path.join(home2, ".agentus", "old.txt"), "LEGACY");
fs.writeFileSync(path.join(home2, ".hermes-studio", "new.txt"), "CURRENT");
where({ HOME: home2 });
check("new dir left intact when both exist", fs.readFileSync(path.join(home2, ".hermes-studio", "new.txt"), "utf8") === "CURRENT");
check("legacy dir not deleted when new dir exists", fs.existsSync(path.join(home2, ".agentus")));

// 3. explicit pin wins and is not migrated
const home3 = path.join(scratch, "home3");
fs.mkdirSync(path.join(home3, ".agentus"), { recursive: true });
fs.writeFileSync(path.join(home3, ".agentus", "sentinel"), "x");
const pinned = path.join(scratch, "my-data");
out = where({ HOME: home3, HERMES_STUDIO_DATA: pinned });
check("explicit HERMES_STUDIO_DATA is honored", out.includes(pinned), out.split("\n").find((l) => l.includes("data dir"))?.trim());
check("explicit pin skips legacy migration", fs.existsSync(path.join(home3, ".agentus")));

// 4. legacy AGENTUS_DATA env mirrored by the shim
const home4 = path.join(scratch, "home4");
fs.mkdirSync(home4, { recursive: true });
const legacyPin = path.join(scratch, "legacy-pin");
out = where({ HOME: home4, AGENTUS_DATA: legacyPin });
check("legacy AGENTUS_DATA mirrored to HERMES_STUDIO_DATA", out.includes(legacyPin) && !out.includes("migrated from"), out.split("\n").find((l) => l.includes("data dir"))?.trim());

// 5. REAL BOOT: a legacy sqlite file is renamed and its rows survive. Use node:sqlite to seed a
// valid DB (the store opens it as a real database), boot the actual server, then read it back.
import net from "node:net";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
const freePort = () => new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const home5 = path.join(scratch, "home5");
const legacyDb = path.join(home5, ".agentus", "agentus.sqlite");
fs.mkdirSync(path.dirname(legacyDb), { recursive: true });
{
  const db = new DatabaseSync(legacyDb);
  db.exec("CREATE TABLE migration_probe(value INTEGER)");
  db.exec("INSERT INTO migration_probe VALUES (42)");
  db.close();
}
const port5 = await freePort();
const child = spawn(process.execPath, [BIN, "--port", String(port5)], {
  env: { PATH: process.env.PATH, TERM: "xterm", TMPDIR: os.tmpdir(), HOME: home5 },
  cwd: scratch, stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", (d) => (logs += String(d)));
child.stderr.on("data", (d) => (logs += String(d)));
let up5 = false;
for (let i = 0; i < 60 && !up5; i++) {
  try { up5 = (await fetch(`http://127.0.0.1:${port5}/healthz`)).ok; } catch { await sleep(500); }
}
check("server boots on migrated legacy data", up5, up5 ? "" : logs.slice(-300));
try {
  const newDb = path.join(home5, ".hermes-studio", "hermes-studio.sqlite");
  check("legacy sqlite copied on boot (original kept for rollback)", fs.existsSync(newDb) && fs.existsSync(legacyDb));
  if (fs.existsSync(newDb)) {
    const db = new DatabaseSync(newDb, { readOnly: true });
    const row = db.prepare("SELECT value FROM migration_probe").get();
    db.close();
    check("rows survive the sqlite rename", row?.value === 42, `value=${row?.value}`);
  }
} catch (e) {
  check("rows survive the sqlite rename", false, String(e));
}
child.kill("SIGTERM");
await sleep(300);
if (!child.killed) child.kill("SIGKILL");

console.log(failures === 0 ? "\nMigration smoke: ALL PASS" : `\nMigration smoke: ${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
