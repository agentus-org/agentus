// AgentSlot server entry: HTTP (REST + static web build) + WebSocket relay.
// The browser never talks to CLI subprocesses directly (design.md §1).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import { Store } from "./store/store.js";
import { SessionManager } from "./acp/session-manager.js";
import { BACKENDS, buildSpawnEnv } from "./acp/backends.js";
import { FsError, listDirs } from "./fs.js";
import * as auth from "./auth.js";
import type { BackendId, ClientCommand, PermissionDecision, ServerEvent } from "@agentslot/shared";

const PORT = Number(process.env.AGENTSLOT_PORT ?? 8787);
// Data + web build resolve against THIS FILE, not the shell's cwd: `scripts/start.sh`
// launches from the repo root while the dev server runs from packages/server, and a
// cwd-relative path would silently open a second database (the operator's slots would
// "disappear"). Both entry points must land on the same store.
const HERE = path.dirname(fileURLToPath(import.meta.url)); // …/packages/server/src
const DATA_DIR = process.env.AGENTSLOT_DATA ?? path.resolve(HERE, "../.data");
const WEB_DIST = process.env.AGENTSLOT_WEB_DIST ?? path.resolve(HERE, "../../web/dist");

fs.mkdirSync(DATA_DIR, { recursive: true });
const store = new Store(path.join(DATA_DIR, "agentslot.sqlite"));

// Auth key material next to the store: a restart must NOT log the operator out,
// and the machine token has to stay stable for scripts/CI.
const authStatus = auth.initAuth(DATA_DIR);

function clientIp(req: IncomingMessage): string {
  const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return fwd || req.socket.remoteAddress || "unknown";
}

// ---- event fan-out to all WS clients + per-client replay tracking ----
const clients = new Map<string, { ws: WebSocket; lastSeen: Map<string, number> }>();

function emit(evt: ServerEvent): void {
  const wire = JSON.stringify(evt);
  for (const { ws } of clients.values()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(wire);
  }
}

const mgr = new SessionManager(store, emit);

/**
 * Single prompt entry point (REST + WS both use it).
 * A failed turn must never be silent: the UI used to show a bare
 * "-32603 Internal error" with nothing in the server log, and it also never
 * emitted turn-end, so the bubble stayed "running" forever (QA#11).
 */
function runPrompt(sessionId: string, text: string): void {
  void mgr.prompt(sessionId, text).catch((e: unknown) => {
    const msg = String((e as Error)?.message ?? e);
    const tail = mgr.stderrTail(sessionId);
    console.error(`[agentslot] prompt failed for ${sessionId}: ${msg}${tail ? `\n  agent stderr tail:\n  ${tail}` : ""}`);
    emit({ t: "message", message: {
      seq: -1, sessionId, kind: "meta", payload: { text: `turn failed: ${msg}` }, createdAt: Date.now(),
    } });
    emit({ t: "turn-end", sessionId, error: msg });
  });
}

// A single bad request must never take the cockpit down: one unhandled
// rejection used to exit the process and silently drop every live session
// (QA#19). Installed only AFTER we own the port — a startup failure
// (EADDRINUSE etc.) must still crash loudly instead of lingering as a
// zombie with no listener (QA#22).
function installSafetyNet(): void {
  process.on("unhandledRejection", (reason) => {
    console.error("[agentslot] unhandled rejection (kept alive):", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[agentslot] uncaught exception (kept alive):", err);
  });
}

// AC5: reclaim orphans from previous run before serving anything.
const killed = mgr.reclaimOrphans();
if (killed) console.log(`[agentslot] reclaimed ${killed} orphan agent process(es)`);

// ---- REST ----
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  // SPA fallback for web build; only GET
  if (!fs.existsSync(WEB_DIST)) {
    res.writeHead(404);
    res.end("web build not found (run `npm run build -w @agentslot/web`)");
    return;
  }
  const url = new URL(req.url ?? "/", "http://x");
  let file = path.join(WEB_DIST, url.pathname === "/" ? "index.html" : url.pathname);
  if (!file.startsWith(WEB_DIST)) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB_DIST, "index.html");
  const ext = path.extname(file);
  const types: Record<string, string> = {
    ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
    ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json",
    ".json": "application/json", ".ico": "image/x-icon",
  };
  res.writeHead(200, { "content-type": types[ext] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    // ---- outer lock: optional HTTP Basic, in front of EVERYTHING (static, /healthz,
    // /api, login page). This is the layer that a public tunnel needs, because a
    // tunnel's own "auth_pass" does not necessarily gate HTTP (see auth.ts).
    if (!auth.verifyBasic(req.headers.authorization)) {
      res.writeHead(401, auth.basicChallenge());
      return res.end("AgentSlot: authentication required\n");
    }

    // ---- auth gate. Everything under /api except the login/me endpoints is
    // closed; the SPA shell, its assets and /healthz stay public so the login
    // page itself can load (the browser has no cookie yet at that point).
    if (auth.requiresAuth(url.pathname)) {
      const who = auth.authenticate(req.headers, url);
      if (!who) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "unauthorized", authRequired: true }));
      }
      (req as IncomingMessage & { principal?: auth.AuthPrincipal }).principal = who;
    }

    if (url.pathname === "/api/auth/me" && req.method === "GET") {
      const who = auth.authenticate(req.headers, url);
      return send(res, 200, {
        authEnabled: authStatus.enabled,
        authenticated: Boolean(who),
        kind: who?.kind ?? null,
        username: who?.username ?? null,
        expiresAt: who?.expiresAt ?? null,
        usingDefaultPassword: authStatus.usingDefaultPassword,
      });
    }
    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      const secure = auth.isSecureRequest(req.headers);
      const body = await readJson(req);
      const username = String(body.username ?? "");
      const password = String(body.password ?? "");
      const ip = clientIp(req);
      const gate = auth.loginAllowed(ip);
      if (!gate.allowed) {
        // 429 so the UI can say "slow down" rather than "wrong password"
        res.writeHead(429, { "content-type": "application/json", "retry-after": String(Math.ceil(gate.retryAfterMs / 1000)) });
        return res.end(JSON.stringify({ error: "too_many_attempts", retryAfterMs: gate.retryAfterMs }));
      }
      if (!auth.verifyCredentials(username, password)) {
        auth.recordLoginFailure(ip);
        const left = auth.loginLimits().maxFails;
        const after = auth.loginAllowed(ip);
        console.warn(`[agentslot] failed login for "${username}" from ${ip}${after.allowed ? "" : " (locked out)"}`);
        return send(res, 401, { error: "bad_credentials", hint: `username/password rejected (limit ${left} tries per IP)` });
      }
      auth.recordLoginSuccess(ip);
      const { value, expiresAt } = auth.issueSession(authStatus.username);
      console.log(`[agentslot] login ok: ${authStatus.username} from ${ip}`);
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": auth.sessionCookie(value, Math.floor(authStatus.sessionTtlMs / 1000), secure),
      });
      return res.end(JSON.stringify({ username: authStatus.username, expiresAt, usingDefaultPassword: authStatus.usingDefaultPassword }));
    }
    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      // Revoke, don't just clear: see auth.revokeSession
      const cookie = auth.parseCookies(String(req.headers.cookie ?? ""))[auth.AUTH_COOKIE_NAME];
      const revoked = auth.revokeSession(cookie);
      console.log(`[agentslot] logout from ${clientIp(req)}${revoked ? "" : " (no live session)"}`);
      res.writeHead(200, { "content-type": "application/json", "set-cookie": auth.clearedCookie(auth.isSecureRequest(req.headers)) });
      return res.end(JSON.stringify({ ok: true, revoked }));
    }
    if (url.pathname === "/healthz") {
      return send(res, 200, { ok: true, ts: Date.now(), backends: Object.keys(BACKENDS) });
    }
    if (url.pathname === "/api/backends" && req.method === "GET") {
      return send(
        res,
        200,
        Object.entries(BACKENDS).map(([id, b]) => {
          let home: string | null = null;
          let warnings: string[] = [];
          let blocked: string | null = null;
          try {
            const plan = buildSpawnEnv(b);
            home = plan.home;
            warnings = plan.warnings;
          } catch (e) {
            blocked = e instanceof Error ? e.message : String(e);
          }
          return { id, label: b.label, home, warnings, blocked };
        }),
      );
    }
    if (url.pathname === "/api/sessions" && req.method === "GET") {
      return send(res, 200, { live: mgr.list(), archived: mgr.archived() });
    }
    // Directory browser for the new-slot workspace picker (dirs only, one level).
    if (url.pathname === "/api/fs/dirs" && req.method === "GET") {
      try {
        const listing = listDirs(url.searchParams.get("path"));
        return send(res, 200, { ...listing, recent: store.recentCwds(8) });
      } catch (e) {
        if (e instanceof FsError) {
          return send(res, e.code === "not_found" ? 404 : 400, { error: e.message, code: e.code });
        }
        throw e;
      }
    }
    if (url.pathname === "/api/sessions" && req.method === "POST") {
      const body = await readJson(req);
      const backendRaw = String(body.backend ?? "");
      let cwd = String(body.cwd ?? "").trim();
      if (!cwd || cwd === "~") cwd = homedir();
      else if (cwd.startsWith("~/")) cwd = path.join(homedir(), cwd.slice(2));
      const backend = Object.prototype.hasOwnProperty.call(BACKENDS, backendRaw) ? (backendRaw as BackendId) : null;
      if (!backend) return send(res, 400, { error: `unknown backend: ${backendRaw}` });
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        return send(res, 400, { error: `cwd not a directory: ${cwd}` });
      }
      const info = await mgr.create(backend, cwd, body.title ? String(body.title) : undefined);
      emit({ t: "sessions", sessions: mgr.list() });
      return send(res, 201, info);
    }
    const sessMatch = url.pathname.match(/^\/api\/sessions\/([\w-]+)(\/.*)?$/);
    if (sessMatch) {
      const id = sessMatch[1];
      const sub = sessMatch[2] ?? "";
      if (req.method === "DELETE" && sub === "") {
        // awaited on purpose: closeSession is async and a floating rejection
        // here used to kill the whole server (QA#19, unhandled rejection)
        if (mgr.hasSession(id)) {
          await mgr.closeSession(id);
          return send(res, 200, { closed: id });
        }
        // not live: either a cold slot the operator wants gone, or an unknown id.
        // Purging is what makes the rail's "on disk · N" list manageable (M4).
        if (store.deleteSession(id)) {
          emit({ t: "sessions", sessions: mgr.list() });
          return send(res, 200, { purged: id });
        }
        return send(res, 404, { error: `no such session: ${id}` });
      }
      if (req.method === "POST" && sub === "/resume") {
        // AC5's other half: bring a cold slot back to life (respawn + loadSession)
        const info = await mgr.resume(id);
        emit({ t: "sessions", sessions: mgr.list() });
        return send(res, 200, info);
      }
      if (req.method === "GET" && sub === "/messages") {
        // Paging contract (M4):
        //   no params / tail=1   -> NEWEST page, oldest-first, hasOlder says more exist above
        //   before=<seq>         -> the previous page above that seq
        //   after=<seq>          -> forward replay rows from a reconnect anchor (WS path)
        // Page size is env-tunable so the paging path is testable without 500+ messages.
        const pageSize = Number(process.env.AGENTSLOT_HISTORY_PAGE || 500);
        const before = url.searchParams.get("before");
        const after = url.searchParams.get("after");
        if (before != null) {
          const page = store.messagesBefore(id, Number(before), Math.min(pageSize, 200));
          return send(res, 200, { messages: page.messages, hasOlder: page.hasMore });
        }
        if (after != null && !url.searchParams.has("tail")) {
          const msgs = store.messagesAfter(id, Number(after), pageSize);
          return send(res, 200, { messages: msgs, hasOlder: false });
        }
        const page = store.messagesTail(id, pageSize);
        return send(res, 200, { messages: page.messages, hasOlder: page.hasOlder });
      }
      if (req.method === "POST" && sub === "/prompt") {
        const body = await readJson(req);
        const text = String(body.text ?? "").trim();
        if (!text) return send(res, 400, { error: "empty prompt" });
        // fire & forget: stream arrives via WS; client watches turn-start/end
        void runPrompt(id, text);
        return send(res, 202, { ok: true });
      }
      if (req.method === "POST" && sub === "/mode") {
        const body = await readJson(req);
        await mgr.setMode(id, String(body.modeId));
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && sub === "/cancel") {
        // REST twin of the WS "cancel" command (API symmetry: QA#21 found the
        // endpoint missing, so scripted checks could not stop a turn)
        if (!mgr.hasSession(id)) return send(res, 404, { error: `no such session: ${id}` });
        await mgr.cancel(id);
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && sub === "/permission") {
        const body = await readJson(req);
        const requestId = String(body.requestId ?? "");
        if (!requestId) return send(res, 400, { error: "requestId required" });
        const ok = mgr.respondPermission(id, requestId, (body.decision as PermissionDecision) ?? { outcome: "cancelled" }, {
          optionKind: typeof body.optionKind === "string" ? body.optionKind : undefined,
          signature: typeof body.signature === "string" ? body.signature : undefined,
        });
        if (!ok) return send(res, 404, { error: `no pending permission: ${requestId}` });
        return send(res, 200, { ok: true });
      }
    }
    if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "not_found" });
    return serveStatic(req, res);
  } catch (err) {
    // "no such X" is a client error, not a server fault (QA#24)
    const msg = String((err as Error)?.message ?? err);
    const code = /no such session|no pending permission/.test(msg) ? 404 : 500;
    return send(res, code, { error: msg });
  }
});

// ---- WebSocket ----
// noServer + a manual upgrade hook: the handshake must be authenticated *before*
// it becomes a socket. A browser cannot set headers on a WS handshake, so auth
// rides on the cookie (sent automatically, same-origin) — or ?token= for scripts.
const wss = new WebSocketServer({ noServer: true });
httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  if (!auth.verifyBasic(req.headers.authorization)) {
    // Same outer lock as HTTP: browsers resend cached Basic credentials on the
    // handshake, so a logged-in browser passes; anything else gets nothing.
    socket.write("HTTP/1.1 401 Unauthorized\r\nwww-authenticate: Basic realm=\"AgentSlot\"\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!auth.authenticate(req.headers, url)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
wss.on("connection", (ws) => {
  const clientId = randomUUID().slice(0, 8);
  clients.set(clientId, { ws, lastSeen: new Map() });
  const sendEvt = (e: ServerEvent) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(e));
  };
  sendEvt({ t: "hello", clientId, resumed: false });
  sendEvt({ t: "sessions", sessions: mgr.list() });

  ws.on("message", async (data) => {
    let cmd: ClientCommand;
    try {
      cmd = JSON.parse(String(data)) as ClientCommand;
    } catch {
      return;
    }
    try {
      switch (cmd.t) {
        case "resume": {
          // AC6: replay missed messages per session after client's lastSeq.
          // `partial: true` tells the client to MERGE into what it already
          // rendered — a rebuild from this tail would drop the pre-drop prefix
          // (QA#17: 26 chars vanished after a mid-turn reconnect).
          for (const [sid, seq] of Object.entries(cmd.lastSeq)) {
            const msgs = store.messagesAfter(sid, seq);
            if (msgs.length) sendEvt({ t: "messages", sessionId: sid, messages: msgs, hasMore: false, partial: true });
          }
          sendEvt({ t: "sessions", sessions: mgr.list() });
          break;
        }
        case "prompt":
          void runPrompt(cmd.sessionId, cmd.text);
          break;
        case "cancel":
          await mgr.cancel(cmd.sessionId);
          break;
        case "set-mode":
          await mgr.setMode(cmd.sessionId, cmd.modeId);
          break;
        case "set-config":
          await mgr.setConfig(cmd.sessionId, cmd.configId, cmd.value);
          break;
        case "respond-permission":
          mgr.respondPermission(cmd.sessionId, cmd.requestId, cmd.decision, {
            optionKind: cmd.optionKind,
            signature: cmd.signature,
          });
          break;
        default:
          break;
      }
    } catch (e) {
      sendEvt({ t: "error", error: String((e as Error)?.message ?? e) });
    }
  });
  ws.on("close", () => clients.delete(clientId));
});

// ---- graceful exit: SIGTERM children before we die (design.md §8-1) ----
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.log(`[agentslot] ${sig}: shutting down sessions`);
    await mgr.shutdown();
    store.close();
    process.exit(0);
  });
}

httpServer.listen(PORT, "0.0.0.0", () => {
  installSafetyNet(); // we own the port: from here on, survive per-request errors
  console.log(`[agentslot-server] http://0.0.0.0:${PORT} (web dist: ${WEB_DIST})`);
  // Auth state belongs in the boot log: "is this thing locked, and with which
  // password?" is the first question anyone asks when it is on a LAN.
  if (!authStatus.enabled) {
    console.warn("[agentslot-server] ⚠ AGENTSLOT_AUTH=off — every visitor can drive your agents. Local dev only.");
  } else if (authStatus.usingDefaultPassword) {
    console.warn(
      `[agentslot-server] ⚠ auth ON with the DEFAULT password (${auth.AUTH_DEFAULT_USERNAME}/${auth.AUTH_DEFAULT_PASSWORD}). `
      + "Anyone on this network can spawn agents in any directory.\n"
      + "[agentslot-server]   set AGENTSLOT_PASSWORD (or AGENTSLOT_PASSWORD_HASH) before exposing the port.",
    );
  } else {
    console.log(`[agentslot-server] auth on: user "${authStatus.username}", ${Math.round(authStatus.sessionTtlMs / 86400000)}d sessions`);
  }
  if (authStatus.tokenFile) console.log(`[agentslot-server] machine token: ${authStatus.tokenFile} (curl -H "Authorization: Bearer $(cat …)")`);
  const basic = auth.basicAuthConfig();
  console.log(basic
    ? `[agentslot-server] HTTP Basic ON (user "${basic.user}") — every path, including /healthz and the WS upgrade`
    : "[agentslot-server] HTTP Basic off (set AGENTSLOT_BASIC_AUTH=user:pass before exposing a tunnel)");
  // A wrong/absent dist used to fail silently: the browser's service worker served a stale
  // shell, every request looked fine, and the operator just saw a blank page (QA R36).
  // Say it out loud at boot instead.
  if (!fs.existsSync(path.join(WEB_DIST, "index.html"))) {
    console.error(
      `[agentslot-server] ⚠ web build missing at ${WEB_DIST} — the UI will 404 (API still works).\n`
      + `[agentslot-server]   build it with:  NODE_ENV=development npm run build -w @agentslot/web`,
    );
  }
});
httpServer.on("error", (err) => {
  console.error(`[agentslot] cannot listen on ${PORT}: ${(err as Error).message}`);
  process.exit(1); // fail fast: never linger as a listener-less zombie
});
