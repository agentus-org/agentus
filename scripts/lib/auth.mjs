import "../../packages/shared/src/env-alias.mjs"; // env-alias: mirror legacy AGENTUS_* -> HERMES_STUDIO_*
// Scripts are machines, so they use the machine token — never the operator password.
// The token lives beside the store (<DATA_DIR>/auth.token, 0600) and can be
// overridden with HERMES_STUDIO_AUTH_TOKEN (the server honours the same var).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The store the server actually opened. Mirrors the resolution in
 *  packages/server/src/index.ts (the source of truth; keep the two in step):
 *  HERMES_STUDIO_DATA → ~/.agentus once it holds something → the in-repo packages/server/.data.
 *  A script that reads the token from a different directory than the server writes it to
 *  fails with a 401 that looks exactly like a broken feature — hence the mirroring rather
 *  than a hard-coded path. */
export function dataDir() {
  const env = process.env.HERMES_STUDIO_DATA?.trim();
  if (env) return env;
  const def = path.join(os.homedir(), ".hermes-studio");
  const legacy = path.join(os.homedir(), ".agentus");
  const repo = path.resolve(import.meta.dirname, "../../packages/server/.data");
  const has = (d) => { try { return fs.statSync(d).isDirectory() && fs.readdirSync(d).length > 0; } catch { return false; } };
  // Mirror the server's one-time migration (packages/server/src/index.ts). By the time a script
  // runs, the server has usually already renamed the dir; this covers scripts that run first.
  if (!fs.existsSync(def) && has(legacy)) {
    try { fs.renameSync(legacy, def); } catch { /* server logs the reason */ }
  }
  return has(def) || !has(repo) ? def : repo;
}

export function machineToken() {
  for (const key of ["HERMES_STUDIO_AUTH_TOKEN", "HERMES_STUDIO_TOKEN"]) {
    const v = process.env[key];
    if (v && v.trim()) return v.trim();
  }
  try {
    return fs.readFileSync(path.join(dataDir(), "auth.token"), "utf8").trim();
  } catch {
    return "";
  }
}

export function authHeaders() {
  const t = machineToken();
  return t ? { authorization: `Bearer ${t}` } : {};
}

/** WebSocket URL carrying the token: a handshake cannot set headers from a browser,
 *  and `ws` clients are no different unless you pass an options object. */
export function wsUrl(base) {
  const t = machineToken();
  return `${base.replace(/^http/, "ws")}/ws${t ? `?token=${encodeURIComponent(t)}` : ""}`;
}
