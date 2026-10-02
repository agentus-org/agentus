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
  TurnTrace,
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
    // newest slot first — the cockpit's left rail is a launch pad, not a log file
    return [...this.#sessions.values()]
      .map((s) => ({
        ...s.info,
        lastSeq: this.#store.maxSeq(s.info.id),
      }))
      .sort((a, b) => b.createdAt - a.createdAt || (b.lastSeq ?? 0) - (a.lastSeq ?? 0));
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

  /** Re-attach to a session that outlived its process (server restart, crash, or
   *  a deliberate close): spawn a fresh child and ask the agent to load the old
   *  ACP session, then re-apply the stored mode/effort. AC5's "restart and keep
   *  going" half — no intelligence here, the agent owns the transcript. */
  async resume(id: string): Promise<SessionInfo> {
    const existing = this.#sessions.get(id);
    if (existing) return existing.info;

    const row = this.#store.getSession(id);
    if (!row) throw new Error(`unknown session: ${id}`);
    if (!row.acpSessionId) throw new Error(`session ${id} was never handed to an agent`);
    const spec = BACKENDS[row.backend];
    if (!spec) throw new Error(`unknown backend: ${row.backend}`);

    const plan = buildSpawnEnv(spec);
    const child = spawn(spec.cmd, spec.args, {
      cwd: row.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: plan.env,
    });
    child.unref();

    const live: LiveSession = {
      info: {
        id, backend: row.backend, acpSessionId: row.acpSessionId, cwd: row.cwd,
        status: "starting", pid: child.pid ?? null, title: row.title,
        createdAt: row.createdAt,
        modes: (row.modes ?? null) as SessionModeState | null,
        configOptions: (row.configOptions ?? []) as ConfigOptionView[],
        // restored from disk so the gauge + slash palette are there before the agent
        // re-announces them (and stay if the re-announce never comes)
        usage: (row.usage ?? null) as SessionInfo["usage"],
        commands: normCommands(row.commands),
      },
      child, busy: false, pendingPermissions: new Map(), alwaysAllow: new Set(), stderrBuf: [],
    };
    this.#sessions.set(id, live);
    this.#store.upsertSession(sessionRow(live.info));

    child.stderr?.on("data", (d: Buffer) => {
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
      const loaded = (await conn.loadSession({
        sessionId: row.acpSessionId, cwd: row.cwd, mcpServers: [],
      })) as { modes?: SessionModeState | null; configOptions?: ConfigOptionView[] } | undefined;
      // The agent re-announces its modes/options on load — prefer that SET (capabilities can
      // differ after an upgrade), but keep the OPERATOR's pick for any option that still
      // exists: a backend that does not restore its own session state would otherwise silently
      // reset thinking depth on every resume while the rail still showed the old choice.
      const storedPicks = new Map(
        ((row.configOptions ?? []) as ConfigOptionView[])
          .filter((o) => o?.id && o.currentValue)
          .map((o) => [o.id, o.currentValue]),
      );
      if (loaded?.modes) live.info.modes = loaded.modes;
      if (loaded?.configOptions?.length) {
        live.info.configOptions = loaded.configOptions.map((o) => (
          storedPicks.has(o.id) ? { ...o, currentValue: storedPicks.get(o.id) } : o
        ));
      }
      // same for the mode: the archived mode wins over a backend default
      if (row.modes && live.info.modes && (row.modes as SessionModeState).currentModeId) {
        live.info.modes = { ...live.info.modes, currentModeId: (row.modes as SessionModeState).currentModeId };
      }
      this.#updateSession(live);
      const modeId = (live.info.modes as SessionModeState | null)?.currentModeId;
      if (modeId) await conn.setSessionMode({ sessionId: row.acpSessionId, modeId }).catch(() => {});
      for (const cfg of (live.info.configOptions ?? []) as ConfigOptionView[]) {
        // "" is a legitimate "unset / follow default" — replaying it can be rejected as an
        // invalid option value, so only re-apply real picks.
        if (cfg?.id && cfg.currentValue) {
          await conn
            .setSessionConfigOption({ sessionId: row.acpSessionId, configId: cfg.id, value: String(cfg.currentValue) })
            .catch(() => {});
        }
      }
      live.info.status = "ready";
      this.#updateSession(live);
      this.#emit({ t: "sessions", sessions: this.list() });
      return live.info;
    } catch (err) {
      child.kill("SIGKILL");
      live.info.status = "error";
      live.info.lastError = errMessage(err) + stderrTail(live);
      this.#sessions.delete(id);
      this.#store.upsertSession({ ...sessionRow(live.info), closedAt: Date.now() });
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /** Sessions we know about on disk but have no process for (rail's cold slots). */
  archived(limit = 20): SessionInfo[] {
    return this.#store
      // include closed rows: "close" means "kill the process, keep the transcript as a cold
      // slot" (that is what the UI's close prompt promises) — filtering status!='closed' made
      // the slot vanish from the rail entirely, leaving the transcript unreachable even though
      // it was still on disk. Real deletion is the separate ✕ purge button.
      .listSessions(true)
      .filter((r) => !this.#sessions.has(r.id))
      .slice(0, limit)
      .map((r) => ({
        id: r.id, backend: r.backend, acpSessionId: r.acpSessionId, cwd: r.cwd,
        title: r.title, status: r.status, pid: null, createdAt: r.createdAt,
        modes: (r.modes ?? null) as SessionModeState | null,
        configOptions: (r.configOptions ?? []) as ConfigOptionView[],
        usage: (r.usage ?? null) as SessionInfo["usage"],
        commands: normCommands(r.commands),
        lastSeq: this.#store.maxSeq(r.id),
      }));
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    const s = this.#need(sessionId);
    if (!s.conn || !s.info.acpSessionId) throw new Error("session not ready");
    if (s.busy) throw new Error("turn already running");
    s.busy = true;
    s.info.status = "running";
    this.#updateSession(s);
    this.#emit({ t: "turn-start", sessionId, trace: this.#turnTrace(s) });
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

  /** What this turn will actually run with. Cheap provenance for the operator's
   *  "why did it behave differently?" question (AionUi F-DISPLAY-11): only what the
   *  session truly knows (effort pick + mode) — never an invented model name. */
  #turnTrace(s: LiveSession): TurnTrace {
    const effortCfg = s.info.configOptions.find((o) => /reason|effort|think/i.test(o.id));
    return {
      effort: effortCfg ? String(effortCfg.currentValue ?? "") || null : null,
      mode: s.info.modes?.currentModeId ?? null,
    };
  }

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
        const c = u as { availableCommands?: { name: string; description?: string }[] };
        live.info.commands = (c.availableCommands ?? []).map((x) => ({
          name: x.name, description: x.description,
        }));
        this.#updateSession(live);
        return;
      }
      case "usage_update": {
        // Context-window gauge (AionUi F-DISPLAY-07). The agent reports used/size in
        // tokens; a backend that never reports size still gets a used-only reading.
        const uu = u as { used?: number; size?: number; cost?: { amount?: number } | null };
        const used = Number(uu.used ?? 0);
        const size = Number(uu.size ?? 0);
        live.info.usage = {
          used: Number.isFinite(used) ? used : 0,
          size: Number.isFinite(size) ? size : 0,
          cost: uu.cost && typeof uu.cost.amount === "number" ? uu.cost.amount : null,
          at: Date.now(),
        };
        this.#updateSession(live);
        this.#emit({ t: "usage", sessionId: live.info.id, usage: live.info.usage });
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
      // Persist the LIVE metadata too, not just status/pid: without modes/configOptions/
      // usage/commands here, a restart (or a cold-slot rail) shows a slot that has lost the
      // operator's thinking depth, the context gauge and the slash palette — the stored
      // snapshot stayed frozen at creation time. `??` keeps whatever the row already had
      // when the live value is genuinely absent (e.g. before the agent announces it).
      this.#store.upsertSession({
        ...row,
        acpSessionId: s.info.acpSessionId ?? row.acpSessionId,
        status: s.info.status,
        pid: s.info.pid,
        title: s.info.title,
        modes: s.info.modes ?? row.modes ?? null,
        configOptions: s.info.configOptions ?? row.configOptions ?? [],
        usage: s.info.usage ?? row.usage ?? null,
        commands: s.info.commands?.length ? s.info.commands : (row.commands ?? []),
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
    modes: i.modes ?? null, configOptions: i.configOptions ?? [],
    usage: i.usage ?? null, commands: i.commands ?? [],
  };
}

/** Rows written before commands carried descriptions hold plain strings — normalize,
 *  never trust the stored shape (a `c.name` on a string would render "undefined"). */
function normCommands(raw: unknown): SessionInfo["commands"] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) => (typeof c === "string" ? { name: c } : (c as { name?: unknown })))
    .filter((c): c is { name: string; description?: string } => Boolean(c && typeof c.name === "string"));
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
