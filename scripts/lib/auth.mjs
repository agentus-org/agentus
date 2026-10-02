// Scripts are machines, so they use the machine token — never the operator password.
// The token lives beside the store (<DATA_DIR>/auth.token, 0600) and can be
// overridden with AGENTSLOT_AUTH_TOKEN (the server honours the same var).
import fs from "node:fs";
import path from "node:path";

export function dataDir() {
  return process.env.AGENTSLOT_DATA || path.resolve(import.meta.dirname, "../../packages/server/.data");
}

export function machineToken() {
  for (const key of ["AGENTSLOT_AUTH_TOKEN", "AGENTSLOT_TOKEN"]) {
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
