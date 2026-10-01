// SessionManager — one ACP client connection per session, per design.md §1.
// Owns: subprocess lifecycle (spawn/kill/orphan-reclaim), the ACP ClientSideConnection
// loop, event fan-out with monotonic seq, permission pending-map with timeout,
// mode/config plumbing. UI holds zero intelligence (red line D): we only relay.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { BACKENDS, buildSpawnEnv } from "./backends.js";
import type { Store } from "../store/store.js";
import type {
  BackendId,
  ConfigOptionView,
  PermissionDecision,
  PermissionRequestView,
  ServerEvent,
  SessionInfo,
  SessionModeState,
} from "@agentslot/shared";

// Permission prompts must not hang a session forever (design.md §8-4).
// Env-tunable so QA can exercise the timeout path in seconds instead of minutes.
const PERMISSION_TIMEOUT_MS = Number(process.env.AGENTSLOT_PERM_TIMEOUT_MS || 5 * 60_000);

interface LiveSession {
  info: SessionInfo;
  child?: ReturnType<typeof spawn>;
  conn?: ClientSideConnection;
  busy: boolean;
  pendingPermissions: Map<string, { resolve: (r: RequestPermissionResponse) => void; timer: NodeJS.Timeout }>;
  alwaysAllow: Set<string>; // "allow_always" remembered per live session only (AionUi F-PERM-05)
  stderrBuf: string[];
}

type Emitter = (evt: ServerEvent) => void;

export class SessionManager {
  #sessions = new Map<string, LiveSession>();
  #store: Store;
  #emit: Emitter;

  constructor(store: Store, emit: Emitter) {
    this.#store = store;
    this.#emit = emit;
  }

  list(): SessionInfo[] {
    return [...this.#sessions.values()].map((s) => ({
      ...s.info,
      lastSeq: this.#store.messagesAfter(s.info.id, Number.MAX_SAFE_INTEGER - 1, 1)[0]?.seq ?? 0,
    }));
  }

  isBusy(id: string): boolean {
    return this.#sessions.get(id)?.busy ?? false;
  }

  /** Reclaim orphans from a previous server run (AC5): kill recorded pids. */
  reclaimOrphans(): number {
    let killed = 0;
    for (const row of this.#store.listSessions(true)) {
      if (row.pid == null) continue;
      try {
        process.kill(row.pid, 0); // alive?
        process.kill(row.pid, "SIGKILL");
        killed++;
      } catch {
        /* already gone */
      }
      if (row.status !== "closed") {
        this.#store.upsertSession({ ...row, status: "error", closedAt: Date.now(), pid: null });
      }
    }
    return killed;
  }

  /** Last stderr lines from a session's agent (for diagnosing failed turns). */
  stderrTail(id: string, lines = 12): string {
    const s = this.#sessions.get(id);
    if (!s) return "";
    return s.stderrBuf.slice(-lines).join("\n  ");
  }

  /** Graceful shutdown: SIGTERM every live child before server exit. */
  async shutdown(): Promise<void> {
    const kills = [...this.#sessions.values()].map(async (s) => {
      for (const { resolve, timer } of s.pendingPermissions.values()) {
        clearTimeout(timer);
        resolve({ outcome: { outcome: "cancelled" } });
      }
      s.pendingPermissions.clear();
      s.child?.kill("SIGTERM");
    });
    await Promise.allSettled(kills);
  }

  async create(backend: BackendId, cwd: string, title?: string): Promise<SessionInfo> {
    const spec = BACKENDS[backend];
    if (!spec) throw new Error(`unknown backend: ${backend}`);
    const id = randomUUID().slice(0, 8);
    const now = Date.now();

    // isolation: never let a child inherit its way back into the live runtime home
    const plan = buildSpawnEnv(spec);

    // detached:true => killing our node process does NOT kill the child,
    // so we MUST track pid for startup reclaim (reclaimOrphans). See design.md §8-1.
    const child = spawn(spec.cmd, spec.args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: plan.env,
    });
    child.unref();

    const live: LiveSession = {
      info: {
        id, backend, acpSessionId: null, cwd, status: "starting",
        pid: child.pid ?? null, title: title || `${spec.label} @ ${shortCwd(cwd)}`,
        createdAt: now, modes: null, configOptions: [], commands: [],
      },
      child, busy: false, pendingPermissions: new Map(), alwaysAllow: new Set(), stderrBuf: [],
    };
    this.#sessions.set(id, live);
    this.#store.upsertSession(sessionRow(live.info));

    child.stderr?.on("data", (d: Buffer) => {
      // stderr never touches the ndjson stream (design.md §8-2); keep tail for errors.
      const line = d.toString().trim();
      if (line) {
        live.stderrBuf.push(line);
        if (live.stderrBuf.length > 50) live.stderrBuf.shift();
      }
    });
    child.on("exit", (code, sig) => this.#onChildExit(live, code, sig));

    try {
      const conn = new ClientSideConnection(
        () => ({
          sessionUpdate: (params) => this.#onSessionUpdate(live, params),
          requestPermission: (params) => this.#onRequestPermission(live, params),
        }),
        ndJsonStream(
          Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
        ),
      );
      live.conn = conn;

      await conn.initialize({
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });
      const res = await conn.newSession({ cwd, mcpServers: [] });
      live.info.acpSessionId = res.sessionId;
      live.info.status = "ready";
      live.info.modes = (res.modes ?? null) as SessionModeState | null;
      live.info.configOptions = (res.configOptions ?? []) as ConfigOptionView[];
      this.#updateSession(live);
      return live.info;
    } catch (err) {
      child.kill("SIGKILL");
      live.info.status = "error";
      live.info.lastError = errMessage(err) + stderrTail(live);
      this.#sessions.delete(id); // failed handshake => don't keep zombie session rows
      this.#store.upsertSession({ ...sessionRow(live.info), closedAt: Date.now() });
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    const s = this.#need(sessionId);
    if (!s.conn || !s.info.acpSessionId) throw new Error("session not ready");
    if (s.busy) throw new Error("turn already running");
    s.busy = true;
    s.info.status = "running";
    this.#updateSession(s);
    this.#emit({ t: "turn-start", sessionId });
    const msg = this.#store.appendMessage({
      sessionId, kind: "user", payload: { text }, createdAt: Date.now(),
    });
    this.#emit({ t: "message", message: msg });
    try {
      const res = await s.conn.prompt({
        sessionId: s.info.acpSessionId,
        prompt: [{ type: "text", text }],
      });
      this.#emit({ t: "turn-end", sessionId, stopReason: res?.stopReason });
    } catch (err) {
      this.#emit({ t: "turn-end", sessionId, error: errMessage(err) });
    } finally {
      s.busy = false;
      if (s.info.status === "running") {
        s.info.status = "ready";
        this.#updateSession(s);
      }
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const s = this.#need(sessionId);
    if (s.conn && s.info.acpSessionId) {
      await s.conn.cancel({ sessionId: s.info.acpSessionId }).catch(() => {});
    }
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    const s = this.#need(sessionId);
    if (!s.conn || !s.info.acpSessionId) throw new Error("session not ready");
    try {
      await s.conn.setSessionMode({ sessionId: s.info.acpSessionId, modeId });
    } catch (err) {
      // qodercli advertises modes but setSessionMode returned -32601 "not found" in
      // design.md probe => mode may be advertised-but-unimplemented; degrade gracefully.
      if (!/not found|Unsupported/i.test(errMessage(err))) throw err;
    }
    if (s.info.modes) s.info.modes = { ...s.info.modes, currentModeId: modeId };
    this.#updateSession(s);
  }

  async setConfig(sessionId: string, configId: string, value: string | number | boolean): Promise<void> {
    const s = this.#need(sessionId);
    if (!s.conn || !s.info.acpSessionId) throw new Error("session not ready");
    await s.conn
      .setSessionConfigOption({
        sessionId: s.info.acpSessionId,
        configId,
        value: value as never,
      })
      .catch((e) => {
        // backend may advertise configOptions but not implement the setter
        if (!/not found|Unsupported|method/i.test(errMessage(e))) throw e;
      });
    s.info.configOptions = s.info.configOptions.map((o) =>
      o.id === configId ? { ...o, currentValue: value } : o,
    );
    this.#updateSession(s);
  }

  async closeSession(sessionId: string): Promise<void> {
    const s = this.#need(sessionId);
    for (const { resolve, timer } of s.pendingPermissions.values()) {
      clearTimeout(timer);
      resolve({ outcome: { outcome: "cancelled" } });
    }
    s.pendingPermissions.clear();
    s.child?.kill("SIGTERM");
    s.info.status = "closed";
    const row = this.#store.getSession(sessionId);
    if (row) this.#store.upsertSession({ ...row, status: "closed", closedAt: Date.now(), pid: null });
    this.#sessions.delete(sessionId);
    this.#emit({ t: "sessions", sessions: this.list() });
  }

  respondPermission(
    sessionId: string,
    requestId: string,
    decision: PermissionDecision,
    meta?: { optionKind?: string; signature?: string },
  ): boolean {
    const s = this.#need(sessionId);
    if (decision.outcome === "selected" && meta?.optionKind === "allow_always" && meta.signature) {
      s.alwaysAllow.add(meta.signature);
    }
    const pending = s.pendingPermissions.get(requestId);
    if (!pending) return false; // already timed out / resolved / never existed
    clearTimeout(pending.timer);
    s.pendingPermissions.delete(requestId);
    pending.resolve({ outcome: decision });
    this.#emit({ t: "permission-resolved", requestId, decision });
    return true;
  }

  // ---- ACP callbacks ----

  #onSessionUpdate(live: LiveSession, params: { sessionId: string; update: Record<string, unknown> }): void {
    const kind = live.info.acpSessionId === params.sessionId ? live : null;
    void kind;
    const u = params.update;
    const st = String(u.sessionUpdate ?? "");
    let msg: Parameters<Store["appendMessage"]>[0] | null = null;
    switch (st) {
      case "agent_message_chunk":
        msg = { sessionId: live.info.id, kind: "agent", payload: u, createdAt: Date.now() };
        break;
      case "agent_thought_chunk":
        msg = { sessionId: live.info.id, kind: "thought", payload: u, createdAt: Date.now() };
        break;
      case "tool_call":
        msg = { sessionId: live.info.id, kind: "tool", payload: u, toolCallId: String(u.toolCallId ?? ""), createdAt: Date.now() };
        break;
      case "tool_call_update": {
        // upsert into original row (design.md §8-5), never a new bubble
        const up = this.#store.upsertToolMessage(
          live.info.id, String(u.toolCallId ?? ""), u,
        );
        if (up) this.#emit({ t: "message", message: up });
        return;
      }
      case "plan":
        msg = { sessionId: live.info.id, kind: "plan", payload: u, createdAt: Date.now() };
        break;
      case "current_mode_update": {
        const m = u as { currentModeId?: string };
        if (live.info.modes && m.currentModeId) {
          live.info.modes = { ...live.info.modes, currentModeId: m.currentModeId };
          this.#updateSession(live);
        }
        return;
      }
      case "available_commands_update": {
        const c = u as { availableCommands?: { name: string }[] };
        live.info.commands = (c.availableCommands ?? []).map((x) => x.name);
        this.#updateSession(live);
        return;
      }
      default:
        return; // unknown update kinds are ignored (protocol may grow)
    }
    if (msg) {
      const stored = this.#store.appendMessage(msg);
      this.#emit({ t: "message", message: stored });
    }
  }

  #onRequestPermission(
    live: LiveSession,
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const requestId = randomUUID().slice(0, 8);
    const view: PermissionRequestView = {
      requestId,
      sessionId: live.info.id,
      toolCallTitle: (params.toolCall as { title?: string })?.title ?? "tool call",
      kind: (params.toolCall as { kind?: string })?.kind ?? "other",
      options: (params.options ?? []) as PermissionRequestView["options"],
      createdAt: Date.now(),
    };
    const sig = `${view.kind}:${view.toolCallTitle}`;
    const remembered = view.options.find((o) => o.kind === "allow_always" || o.kind === "allow_once");
    if (live.alwaysAllow.has(sig) && remembered) {
      // previously "always allowed" in this session => pass silently
      return Promise.resolve({
        outcome: { outcome: "selected", optionId: remembered.optionId } as never,
      });
    }
    this.#emit({ t: "permission", request: view });
    return new Promise<RequestPermissionResponse>((resolve) => {
      const timer = setTimeout(() => {
        live.pendingPermissions.delete(requestId);
        const d: PermissionDecision = { outcome: "cancelled" };
        resolve({ outcome: d });
        this.#emit({ t: "permission-resolved", requestId, decision: d });
      }, PERMISSION_TIMEOUT_MS);
      live.pendingPermissions.set(requestId, { resolve, timer });
    });
  }

  #onChildExit(live: LiveSession, code: number | null, sig: string | null): void {
    // If we initiated close, session was already removed — ignore.
    if (!this.#sessions.has(live.info.id)) return;
    for (const { resolve, timer } of live.pendingPermissions.values()) {
      clearTimeout(timer);
      resolve({ outcome: { outcome: "cancelled" } });
    }
    live.pendingPermissions.clear();
    live.busy = false;
    live.info.status = "error";
    live.info.lastError = `agent process exited (code=${code} sig=${sig})` + stderrTail(live);
    const row = this.#store.getSession(live.info.id);
    if (row) this.#store.upsertSession({ ...row, status: "error", pid: null });
    this.#emit({ t: "session", session: live.info });
    this.#emit({ t: "turn-end", sessionId: live.info.id, error: live.info.lastError });
  }

  // ---- helpers ----

  #need(id: string): LiveSession {
    const s = this.#sessions.get(id);
    if (!s) throw new Error(`no such session: ${id}`);
    return s;
  }

  #updateSession(s: LiveSession): void {
    this.#emit({ t: "session", session: s.info });
    const row = this.#store.getSession(s.info.id);
    if (row) {
      this.#store.upsertSession({
        ...row,
        acpSessionId: s.info.acpSessionId ?? row.acpSessionId,
        status: s.info.status,
        pid: s.info.pid,
        title: s.info.title,
      });
    }
  }

  /** Replay messages since lastSeq per session (AC6 reconnect). */
  replay(sessionId: string, afterSeq: number) {
    return this.#store.messagesAfter(sessionId, afterSeq);
  }

  messages(sessionId: string, afterSeq = -1, limit = 500) {
    return this.#store.messagesAfter(sessionId, afterSeq, limit);
  }

  hasSession(id: string): boolean {
    return this.#sessions.has(id);
  }
}

function sessionRow(i: SessionInfo) {
  return {
    id: i.id, backend: i.backend, acpSessionId: i.acpSessionId, cwd: i.cwd,
    title: i.title, status: i.status, pid: i.pid, createdAt: i.createdAt, closedAt: null,
  };
}

function errMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

function stderrTail(s: LiveSession): string {
  return s.stderrBuf.length ? ` | stderr: ${s.stderrBuf.slice(-2).join(" / ")}` : "";
}

function shortCwd(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : cwd;
}
