// AgentSlot server entry: HTTP (REST + static web build) + WebSocket relay.
// The browser never talks to CLI subprocesses directly (design.md §1).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import { Store } from "./store/store.js";
import { SessionManager } from "./acp/session-manager.js";
import { BACKENDS, buildSpawnEnv } from "./acp/backends.js";
import type { BackendId, ClientCommand, ServerEvent } from "@agentslot/shared";

const PORT = Number(process.env.AGENTSLOT_PORT ?? 8787);
const DATA_DIR = process.env.AGENTSLOT_DATA ?? path.join(process.cwd(), ".data");
const WEB_DIST = process.env.AGENTSLOT_WEB_DIST ?? path.join(process.cwd(), "../web/dist");

fs.mkdirSync(DATA_DIR, { recursive: true });
const store = new Store(path.join(DATA_DIR, "agentslot.sqlite"));

// ---- event fan-out to all WS clients + per-client replay tracking ----
const clients = new Map<string, { ws: WebSocket; lastSeen: Map<string, number> }>();

function emit(evt: ServerEvent): void {
  const wire = JSON.stringify(evt);
  for (const { ws } of clients.values()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(wire);
  }
}

const mgr = new SessionManager(store, emit);

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
      return send(res, 200, {
        live: mgr.list(),
        archived: store.listSessions(false).filter((r) => !mgr.hasSession(r.id)).length,
      });
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
        mgr.closeSession(id);
        return send(res, 200, { closed: id });
      }
      if (req.method === "GET" && sub === "/messages") {
        const after = Number(url.searchParams.get("after") ?? -1);
        const msgs = store.messagesAfter(id, after);
        return send(res, 200, { messages: msgs, hasMore: msgs.length >= 500 });
      }
      if (req.method === "POST" && sub === "/prompt") {
        const body = await readJson(req);
        const text = String(body.text ?? "").trim();
        if (!text) return send(res, 400, { error: "empty prompt" });
        // fire & forget: stream arrives via WS; client watches turn-start/end
        mgr.prompt(id, text).catch((e) =>
          emit({ t: "turn-end", sessionId: id, error: String(e?.message ?? e) }),
        );
        return send(res, 202, { ok: true });
      }
      if (req.method === "POST" && sub === "/mode") {
        const body = await readJson(req);
        await mgr.setMode(id, String(body.modeId));
        return send(res, 200, { ok: true });
      }
    }
    if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "not_found" });
    return serveStatic(req, res);
  } catch (err) {
    return send(res, 500, { error: String((err as Error)?.message ?? err) });
  }
});

// ---- WebSocket ----
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
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
          // AC6: replay missed messages per session after client's lastSeq
          for (const [sid, seq] of Object.entries(cmd.lastSeq)) {
            const msgs = store.messagesAfter(sid, seq);
            if (msgs.length) sendEvt({ t: "messages", sessionId: sid, messages: msgs, hasMore: false });
          }
          sendEvt({ t: "sessions", sessions: mgr.list() });
          break;
        }
        case "prompt":
          await mgr.prompt(cmd.sessionId, cmd.text);
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
  console.log(`[agentslot-server] http://0.0.0.0:${PORT} (web dist: ${WEB_DIST})`);
});
