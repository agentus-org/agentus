// Web IDE (code-server) bridge — issue #77.
//
// WHY A PROXY AND NOT A SECOND ORIGIN
// The cockpit already runs the other half of "look at this workspace": a file tree, a preview/editor
// and a real PTY terminal (ToolPanel.tsx). What it does not have is an IDE. The obvious integration
// is an <iframe> pointed at the operator's own code-server — and the obvious way to do that, a link
// to `http://host:8123/`, is wrong twice over: the page is served over https in any real deployment,
// so an http iframe is blocked as mixed content, and a cross-origin iframe carries no cookie, so the
// operator meets a second login page (measured on a live deployment: `GET /` → 302 to the login
// screen). An embedded code-server (`--auth none`) fixes the login page and breaks reachability
// instead: it binds loopback by design, because "no auth" is only safe there.
//
// So the request has to arrive through agentus itself, same-origin, on a path the existing gate
// already covers. That is the whole design:
//
//  * MOUNT UNDER `/api/`  (`/api/ide/…`). `auth.ts::requiresAuth` closes everything under `/api/`
//    that is not explicitly public, so the proxy inherits the operator's cookie session with ZERO
//    changes to the auth module. This is not a style choice: a proxy mounted at `/ide/` would be
//    treated as a static asset, i.e. served to anyone who can reach the port — a full IDE with a
//    terminal, reachable without a login.
//  * NEVER SPAWN IT. Every `spawn` in this server starts an ACP agent. code-server is a heavyweight
//    third-party service (multiple processes, a port, a persistent volume, a readiness wait); its
//    lifecycle belongs to the deployment. This module only forwards, plus answers "is it up" so the
//    tab can hide itself instead of showing a dead frame.
//  * NOTHING CHANGES WHEN IT IS NOT CONFIGURED. `AGENTUS_IDE_UPSTREAM` unset ⇒ no routes beyond
//    `/api/ide/status` (which reports `configured:false`), no tab, no upgrade path.
//
// The upstream is expected to run `--auth none` bound to loopback: the cookie gate above is then the
// ONLY door, which is why the prefix rule in the first bullet is a security requirement rather than
// a naming convention.
import http from "node:http";
import net from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

/** The mount point. Changing it breaks the "inherits the `/api/` gate" property above. */
export const IDE_PREFIX = "/api/ide";

/** The command the UI prints when the operator has not configured an upstream yet. Port and paths
 *  here are the documented defaults in `docs/web-ide-integration.md`; the mechanism does not care. */
export const IDE_START_COMMAND =
  "code-server --auth none --bind-addr 127.0.0.1:8133 " +
  '--user-data-dir "$HOME/.local/share/code-server" ' +
  '--config "$HOME/.config/code-server/config.yaml"';

export interface IdeUpstream {
  host: string;
  port: number;
  /** the value as configured, for reporting back to the UI */
  base: string;
}

/** Read `AGENTUS_IDE_UPSTREAM` on every call: a status probe during boot would otherwise cache a
 *  typo across a whole process lifetime, and parsing a short string is free. */
export function upstream(): IdeUpstream | null {
  const raw = String(process.env.AGENTUS_IDE_UPSTREAM ?? "").trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  if (!u.hostname || !Number.isFinite(port)) return null;
  return { host: u.hostname, port, base: `${u.protocol}//${u.hostname}:${port}${u.pathname.replace(/\/$/, "")}` };
}

export function configured(): boolean {
  return upstream() !== null;
}

/** One short GET against the upstream's root. `reachable` is what the tab visibility depends on,
 *  so it must not be optimistic: a refused socket and a 5xx both mean "do not show the tab". */
export async function reachable(timeoutMs = 1500): Promise<boolean> {
  const up = upstream();
  if (!up) return false;
  return await new Promise<boolean>((resolve) => {
    const req = http.request(
      { host: up.host, port: up.port, path: `${pathPrefixOf(up)}/`, method: "GET", timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(Boolean(res.statusCode && res.statusCode < 500));
      },
    );
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.end();
  });
}

export async function status(): Promise<{ configured: boolean; reachable: boolean; base: string | null; prefix: string; start: string }> {
  const up = upstream();
  return {
    configured: Boolean(up),
    reachable: up ? await reachable() : false,
    base: up?.base ?? null,
    prefix: IDE_PREFIX,
    start: IDE_START_COMMAND,
  };
}

/** A configured base may carry a path (`http://127.0.0.1:8133/ide`); keep it, minus the trailing
 *  slash, so `strip()` below can splice cleanly. */
function pathPrefixOf(up: IdeUpstream): string {
  try {
    return new URL(up.base).pathname.replace(/\/$/, "");
  } catch { return ""; }
}

/** `/api/ide/a/b?x` → `/a/b?x` (against the upstream's own base path, if it has one). */
function strip(url: URL, up: IdeUpstream): string {
  const rest = url.pathname.replace(/^\/api\/ide/, "") || "/";
  return `${pathPrefixOf(up)}${rest}${url.search}`;
}

/** Headers we must not forward, and why:
 *  - `host`: the upstream is not the authority the browser addressed, and code-server uses Host in
 *    redirect/websocket-origin checks.
 *  - `cookie`: the upstream runs `--auth none`; forwarding the operator's agentus cookie would hand
 *    a password-equivalent to a third-party process for no benefit.
 *  - `connection`/`upgrade`-class hop-by-hop headers: they describe OUR socket, not the new one. */
const HOP_BY_HOP = new Set([
  "host", "cookie", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "authorization", "x-agentus-cockpit-token",
]);

function forwardHeaders(req: IncomingMessage, prefix: string): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null || HOP_BY_HOP.has(k.toLowerCase())) continue;
    // Our own x-forwarded-* are replaced below, not doubled up.
    if (k.toLowerCase().startsWith("x-forwarded-")) continue;
    out[k] = v;
  }
  const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() || "http";
  out["x-forwarded-proto"] = proto;
  out["x-forwarded-host"] = String(req.headers.host ?? "");
  // code-server (like every VS Code server) builds absolute URLs from this. Without it, redirects
  // and asset links escape the mount point and land on agentus's SPA fallback.
  out["x-forwarded-prefix"] = prefix;
  return out;
}

/** Absolute paths the upstream hands back must come back inside the mount, or the browser asks
 *  agentus for them (and gets the SPA shell — a black iframe with no error anywhere). */
function rewriteLocation(value: string, prefix: string): string {
  if (value.startsWith(prefix)) return value;
  if (value.startsWith("/")) return `${prefix}${value}`;
  return value;
}

/**
 * Forward one HTTP request to the upstream. Returns false when this module does not own the path,
 * so the caller can keep walking its route table.
 */
export async function handleHttp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!ownsPath(url.pathname)) return false;

  if (url.pathname === `${IDE_PREFIX}/status` && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(await status()));
    return true;
  }

  const up = upstream();
  if (!up) {
    res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "ide_not_configured", hint: "set AGENTUS_IDE_UPSTREAM", start: IDE_START_COMMAND }));
    return true;
  }

  const path = strip(url, up);
  const headers = forwardHeaders(req, IDE_PREFIX);
  const upReq = http.request({ host: up.host, port: up.port, path, method: req.method, headers }, (upRes) => {
    const out: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (v == null) continue;
      if (k === "location" && typeof v === "string") { out[k] = rewriteLocation(v, IDE_PREFIX); continue; }
      if (k === "content-security-policy") continue; // the upstream's CSP names its own origin
      out[k] = v;
    }
    // The frame must not be cached: it names a build, and a stale one 404s its own assets.
    if (typeof out["content-type"] === "string" && out["content-type"].includes("text/html")) {
      out["cache-control"] = "no-store";
    }
    res.writeHead(upRes.statusCode ?? 502, out);
    upRes.pipe(res);
  });
  upReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "ide_upstream_unreachable", detail: String(err?.message ?? err) }));
    } else res.destroy();
  });
  req.pipe(upReq);
  return true;
}

/** Does this module own the path? Kept separate from `handleUpgrade` because the upgrade
 *  dispatcher's PATH WHITELIST runs before the cookie check: a prefix missing from that list is
 *  destroyed there, which is the "IDE opens, its socket never connects" failure (issue #77 rule 2). */
export function ownsPath(pathname: string): boolean {
  return pathname === IDE_PREFIX || pathname.startsWith(`${IDE_PREFIX}/`);
}

/**
 * Forward one WebSocket upgrade. This is the half that makes the difference between "the IDE opens"
 * and "the IDE opens and cannot reach its own backend" — code-server's editor, terminal and file
 * watching all ride one socket, so a proxy that forwards HTTP only produces a frame that looks
 * alive and does nothing.
 *
 * Raw byte forwarding rather than a WebSocket server on our side: we have no business parsing
 * frames we are not going to read, and `pipe` gives us binary transparency (the upstream may use
 * permessage-deflate, subprotocols, or extensions we never agreed to).
 */
export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): boolean {
  if (!ownsPath(url.pathname)) return false;
  const up = upstream();
  if (!up) { socket.destroy(); return true; }

  const path = strip(url, up);
  const upstreamSocket = net.connect(up.port, up.host, () => {
    const lines = [`GET ${path} HTTP/1.1`];
    const headers = forwardHeaders(req, IDE_PREFIX);
    for (const [k, v] of Object.entries(headers)) {
      if (v == null) continue;
      for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
    }
    // The handshake headers live on the original request; hop-by-hop filtering above dropped
    // `connection`/`upgrade`, so they are put back here verbatim — this is the one place they mean
    // something to the new socket.
    lines.push(`connection: upgrade`);
    lines.push(`upgrade: websocket`);
    upstreamSocket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) upstreamSocket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  upstreamSocket.on("error", () => { socket.destroy(); });
  socket.on("error", () => { upstreamSocket.destroy(); });
  return true;
}
