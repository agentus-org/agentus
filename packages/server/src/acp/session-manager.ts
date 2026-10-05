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
import { BACKENDS, buildSpawnEnv, type BackendSpec } from "./backends.js";
import { classifyError, checkedHealth, effectiveArgs, handshakeFrom, rowToSpec } from "./registry.js";
import type { BackendHandshake, CheckErrorCode } from "./registry.js";
import {
  cleanAgentTitle, deriveTitle, titleFromLatestPrompt, TITLE_INSTRUCTION,
} from "../title.js";
import type { Store, SessionRow } from "../store/store.js";
import type {
  AttachmentSummary,
  BackendId,
  ConfigOptionView,
  PermissionDecision,
  PermissionRequestView,
  PromptAttachment,
  ServerEvent,
  SessionInfo,
  SessionModeState,
  TurnTrace,
} from "@agentslot/shared";

// Permission prompts must not hang a session forever (design.md §8-4).
// Env-tunable so QA can exercise the timeout path in seconds instead of minutes.
const PERMISSION_TIMEOUT_MS = Number(process.env.AGENTSLOT_PERM_TIMEOUT_MS || 5 * 60_000);

// A title fork is a real model turn over a copy of the conversation: give it room, but never
// let a stuck one hang the operator's click — the caller falls back to the derived name on
// timeout. Env-tunable so a sweep can exercise the timeout path in seconds.
const TITLE_FORK_TIMEOUT_MS = Number(process.env.AGENTSLOT_TITLE_TIMEOUT_MS || 90_000);

// How long a cancelled turn may take to actually stop before an interrupting prompt gives up
// (an agent that ignores session/cancel must not hang the operator's next sentence forever).
const TURN_SETTLE_TIMEOUT_MS = Number(process.env.AGENTSLOT_SETTLE_TIMEOUT_MS || 15_000);

interface LiveSession {
  info: SessionInfo;
  child?: ReturnType<typeof spawn>;
  conn?: ClientSideConnection;
  busy: boolean;
  pendingPermissions: Map<string, { resolve: (r: RequestPermissionResponse) => void; timer: NodeJS.Timeout }>;
  alwaysAllow: Set<string>; // "allow_always" remembered per live session only (AionUi F-PERM-05)
  stderrBuf: string[];
  /** What the agent says it can do (initialize.agentCapabilities), kept because the title
   *  regeneration is only possible when it advertises `session/fork`. */
  caps: { fork: boolean; load: boolean };
  /** Incremented when a turn STARTS. An interrupt waits for the specific turn it cancelled,
   *  so a second interrupting utterance that already started its own turn is not mistaken for
   *  "the one I cancelled is still running". */
  turnSeq: number;
  /** Text sinks for sessions that live on this connection but are NOT the one in the rail —
   *  today only the throwaway fork used to summarise the conversation for a title. Anything
   *  whose sessionId is not `info.acpSessionId` is routed here and never persisted. */
  collectors: Map<string, (u: Record<string, unknown>) => void>;
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
    // Most recently CHATTED first — the cockpit's left rail is a launch pad, not a log file, and
    // creation order is the wrong key for that: the session you talked to a minute ago is the
    // one you come back to, even when it is the oldest row in the list.
    const lastAt = this.#store.lastMessageAt();
    return [...this.#sessions.values()]
      .map((s) => ({
        ...s.info,
        lastSeq: this.#store.maxSeq(s.info.id),
        lastAt: lastAt.get(s.info.id) ?? s.info.createdAt,
      }))
      .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0) || b.createdAt - a.createdAt);
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

  /**
   * A session's backend spec + argv. The registry row (what the operator edits) wins; an id
   * that only exists among the builtin seeds still resolves, so a session created before the
   * row was touched never breaks. argv comes from registry.effectiveArgs — that is where the
   * hermes profile flag (`-p <profile>`) is composed.
   */
  #spawnShape(id: string): { spec: BackendSpec; args: string[] } | null {
    const row = this.#store.getBackend(id);
    if (row) return { spec: rowToSpec(row), args: effectiveArgs(row) };
    const builtin = BACKENDS[id];
    return builtin ? { spec: builtin, args: builtin.args } : null;
  }

  /**
   * Fold a REAL session outcome back onto the backend row (kind=session). This is the only
   * check that proves a row works (`acp --check` returns before the adapter's server module is
   * even imported), so it is worth remembering: the settings list can then say "online, session,
   * 2m ago" for a row that has actually run a slot, and a row that dies in the handshake keeps
   * the reason instead of losing it with the failed session. The handshake is stored for the same
   * reason — it is a property of (command, env, home, profile), not of one conversation.
   *
   * Bookkeeping must never fail a session: a throw in here is swallowed.
   */
  #noteBackendCheck(
    backendId: string,
    outcome: { ok: boolean; error?: string | null; errorCode?: CheckErrorCode; latencyMs?: number | null },
    handshake?: BackendHandshake | null,
  ): void {
    try {
      const row = this.#store.getBackend(backendId);
      if (!row) return; // a builtin-only id that was never seeded: nothing to write to
      const health = outcome.ok
        ? checkedHealth(row.health, { status: "online", kind: "session", latencyMs: outcome.latencyMs ?? null })
        : checkedHealth(row.health, {
            status: "offline",
            kind: "session",
            errorCode: outcome.errorCode ?? classifyError(outcome.error ?? "unknown"),
            message: outcome.error ?? null,
            latencyMs: outcome.latencyMs ?? null,
          });
      this.#store.recordBackendCheck(backendId, health, handshake ?? null);
    } catch { /* the row is evidence, not control flow */ }
  }

  async create(backend: BackendId, cwd: string, title?: string): Promise<SessionInfo> {
    const shape = this.#spawnShape(backend);
    if (!shape) throw new Error(`unknown backend: ${backend}`);
    const { spec, args } = shape;
    const id = randomUUID().slice(0, 8);
    const now = Date.now();

    // isolation: never let a child inherit its way back into the live runtime home
    const plan = buildSpawnEnv(spec);
    // measured once per spawn: how long the row took to reach `ready` (or to die trying)
    const spawnStarted = Date.now();

    // detached:true => killing our node process does NOT kill the child,
    // so we MUST track pid for startup reclaim (reclaimOrphans). See design.md §8-1.
    const child = spawn(spec.cmd, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: plan.env,
    });
    child.unref();

    const live: LiveSession = {
      info: {
        id, backend, acpSessionId: null, cwd,
        workspace: null, contextLimit: null,
        status: "starting",
        pid: child.pid ?? null,
        title: title || `${spec.label} @ ${shortCwd(cwd)}`,
        autoTitle: title || `${spec.label} @ ${shortCwd(cwd)}`,
        createdAt: now, modes: null, configOptions: [], commands: [],
      },
      child, busy: false, pendingPermissions: new Map(), alwaysAllow: new Set(), stderrBuf: [],
      caps: { fork: false, load: false }, turnSeq: 0, collectors: new Map(),
    };
    this.#sessions.set(id, live);
    live.info.lastAt = this.#store.lastMessageAt().get(id) ?? live.info.createdAt;
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

      const init = await conn.initialize({
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });
      const caps = (init?.agentCapabilities ?? {}) as {
        loadSession?: boolean;
        sessionCapabilities?: { fork?: unknown };
      };
      live.caps = {
        fork: Boolean(caps.sessionCapabilities?.fork),
        load: Boolean(caps.loadSession),
      };
      const res = await conn.newSession({ cwd, mcpServers: [] });
      live.info.acpSessionId = res.sessionId;
      live.info.status = "ready";
      live.info.modes = (res.modes ?? null) as SessionModeState | null;
      live.info.configOptions = (res.configOptions ?? []) as ConfigOptionView[];
      // `models` is on the wire but not in the SDK's published types (see shared/index.ts),
      // so read it defensively instead of trusting a typed field that does not exist.
      live.info.models = readModels(res);
      // the row just proved itself: remember that, plus what the agent said it can do
      this.#noteBackendCheck(String(backend), { ok: true, latencyMs: Date.now() - spawnStarted }, handshakeFrom(init, res));
      this.#updateSession(live);
      return live.info;
    } catch (err) {
      child.kill("SIGKILL");
      live.info.status = "error";
      live.info.lastError = errMessage(err) + stderrTail(live);
      this.#sessions.delete(id); // failed handshake => don't keep zombie session rows
      this.#store.upsertSession({ ...sessionRow(live.info), closedAt: Date.now() });
      this.#noteBackendCheck(String(backend), {
        ok: false, error: live.info.lastError, errorCode: classifyError(err),
        latencyMs: Date.now() - spawnStarted,
      });
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
    const shape = this.#spawnShape(row.backend);
    if (!shape) throw new Error(`unknown backend: ${row.backend}`);
    const { spec, args } = shape;

    // Resume in the operator's workspace when they picked one: that is the whole
    // point of the workspace being a separate field (see shared/index.ts).
    const resumeCwd = row.workspace || row.cwd;
    const plan = buildSpawnEnv(spec);
    const resumeStarted = Date.now();
    const child = spawn(spec.cmd, args, {
      cwd: resumeCwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: plan.env,
    });
    child.unref();

    const live: LiveSession = {
      info: {
        id, backend: row.backend, acpSessionId: row.acpSessionId, cwd: row.cwd,
        workspace: row.workspace ?? null,
        contextLimit: row.contextLimit ?? null,
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
      caps: { fork: false, load: false }, turnSeq: 0, collectors: new Map(),
    };
    this.#sessions.set(id, live);
    live.info.lastAt = this.#store.lastMessageAt().get(id) ?? live.info.createdAt;
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
      const reloadInit = await conn.initialize({
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });
      const loaded = (await conn.loadSession({
        sessionId: row.acpSessionId, cwd: row.cwd, mcpServers: [],
      })) as { modes?: SessionModeState | null; configOptions?: ConfigOptionView[] } | undefined;
      const loadedModels = readModels(loaded);
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
      // the agent's model list is authoritative; the stored one is only a fallback for
      // backends that answer loadSession without it
      if (loadedModels) live.info.models = loadedModels;
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
      // a resumed slot is the same evidence as a fresh one: the row does work
      this.#noteBackendCheck(
        String(row.backend),
        { ok: true, latencyMs: Date.now() - resumeStarted },
        handshakeFrom(reloadInit, loaded),
      );
      this.#emit({ t: "sessions", sessions: this.list() });
      return live.info;
    } catch (err) {
      child.kill("SIGKILL");
      live.info.status = "error";
      live.info.lastError = errMessage(err) + stderrTail(live);
      this.#sessions.delete(id);
      this.#store.upsertSession({ ...sessionRow(live.info), closedAt: Date.now() });
      this.#noteBackendCheck(String(row.backend), {
        ok: false, error: live.info.lastError, errorCode: classifyError(err),
        latencyMs: Date.now() - resumeStarted,
      });
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
      .map((r) => ({
        id: r.id, backend: r.backend, acpSessionId: r.acpSessionId, cwd: r.cwd,
        workspace: r.workspace ?? null,
        models: (r.models ?? null) as SessionInfo["models"],
        contextLimit: r.contextLimit ?? null,
        title: r.title, autoTitle: r.autoTitle ?? null, status: r.status, pid: null, createdAt: r.createdAt,
        modes: (r.modes ?? null) as SessionModeState | null,
        configOptions: (r.configOptions ?? []) as ConfigOptionView[],
        usage: (r.usage ?? null) as SessionInfo["usage"],
        commands: normCommands(r.commands),
        lastSeq: this.#store.maxSeq(r.id),
        lastAt: this.#store.lastMessageAt().get(r.id) ?? r.createdAt,
      }))
      // cold rows by the same rule as live ones (recent chat first), THEN take the page
      .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0) || b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  async prompt(
    sessionId: string,
    text: string,
    attachments: PromptAttachment[] = [],
    opts: { interrupt?: boolean } = {},
  ): Promise<void> {
    const s = this.#need(sessionId);
    if (!s.conn || !s.info.acpSessionId) throw new Error("session not ready");
    if (s.busy) {
      // Someone is talking over the agent. Plain prompts are refused (the operator's send
      // button is a stop button), but a call utterance carries `interrupt: true`: give the
      // floor back by cancelling, then WAIT for the running turn to really end before
      // starting the new one. Without the wait, the cancel (async) races the new prompt and
      // the operator got "turn already running" for doing exactly what a call invites.
      if (!opts.interrupt) throw new Error("turn already running");
      // Take the floor: cancel whatever is running and wait for THE TURN WE CANCELLED to
      // really stop. Another interrupting utterance may have started a turn meanwhile — this
      // call is an interrupt too, so it takes that one as well rather than failing with
      // "still running". (A plain sleep would guess; the per-turn counter knows.)
      const deadline = Date.now() + TURN_SETTLE_TIMEOUT_MS;
      do {
        await this.cancel(sessionId);
        const mine = s.turnSeq;
        while (s.busy && s.turnSeq === mine && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 40));
        }
      } while (s.busy && Date.now() < deadline);
      if (s.busy) throw new Error("上一个回合没能停下来（agent 未响应取消），请稍后再试");
    }
    const blocks = buildPromptBlocks(text, attachments);
    if (!blocks.length) throw new Error("empty prompt");
    s.turnSeq += 1;
    s.busy = true;
    s.info.status = "running";
    this.#updateSession(s);
    this.#emit({ t: "turn-start", sessionId, trace: this.#turnTrace(s) });
    const msg = this.#store.appendMessage({
      sessionId, kind: "user", payload: { text, attachments: summarize(attachments) }, createdAt: Date.now(),
    });
    this.#touch(s, msg.createdAt);
    this.#emit({ t: "message", message: msg });
    // A brand-new slot is called "<backend> @ <dir>" until something better exists, and the
    // moment the operator asks something that placeholder is plainly wrong. Name it now,
    // from the prompt itself: instant, offline, no model call in our layer (AionUi derives
    // its auto title the same way). The AGENT may have its own opinion — Hermes generates a
    // title in the turn prologue and announces it via `session_info_update` a little later,
    // and that one wins, because it can be right about a conversation we never parse.
    this.#autoTitleFrom(s, text);
    try {
      const res = await s.conn.prompt({
        sessionId: s.info.acpSessionId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ContentBlock union, built by hand
        prompt: blocks as any,
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
    if (!s.conn || !s.info.acpSessionId) return;
    // An idle session must NOT be cancelled. On the agent side this is not a no-op: Hermes' ACP
    // `session/cancel` sets the hard-interrupt flag unconditionally (`request_hard_interrupt`) and
    // clears it only at a turn boundary, so the NEXT turn aborts before it starts — at its
    // cross-process turn-lease admission — with "Stopped waiting for another Hermes process on this
    // session. Your message was not processed." The operator's words are dropped and that notice is
    // rendered (and in a call, READ OUT) like an answer. The call hit this whenever the operator
    // talked over a reply still being read aloud: the agent's turn was already over, so the
    // barge-in's cancel landed on an idle session.
    if (!s.busy) {
      console.log(`[agentslot] cancel ignored for ${sessionId}: no turn is running`);
      return;
    }
    console.log(`[agentslot] cancel sent for ${sessionId}`);
    await s.conn.cancel({ sessionId: s.info.acpSessionId }).catch(() => {});
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
    if (live.info.acpSessionId !== params.sessionId) {
      // Another session on OUR connection: only the title fork does that. Its output is a
      // scratch copy of this conversation, so it goes to the collector and stops there —
      // never persisted, never broadcast (the rail must not grow a phantom session).
      live.collectors.get(params.sessionId)?.(params.update);
      return;
    }
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
      case "session_info_update": {
        // The protocol's own title channel: "Agents send this notification to update session
        // information like title… This allows clients to display dynamic session names."
        // Hermes uses it for the auto title it generates in the turn prologue (and for
        // provenance updates where the title is unchanged — a no-op here). This is why the
        // cockpit shows generated names at all: the intelligence stays in the CLI.
        const t = cleanAgentTitle((u as { title?: string | null }).title ?? null);
        if (t) this.#applyAutoTitle(live.info.id, t, false);
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
      this.#touch(live, stored.createdAt);
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
    // The remembered window follows the model, so it has to be refreshed whenever the
    // model (or anything else) changes — this is the one place every mutation passes.
    s.info.modelContextLimit = this.#store.getModelLimit(s.info.models?.currentModelId ?? null);
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

  /** Re-point a slot's workspace. Live slot: panels + the *next* resume move; the
   *  running child keeps the cwd it was spawned with (ACP fixes cwd at newSession).
   *  Cold slot: the resume will come up in the new directory. */
  setWorkspace(id: string, workspace: string | null): SessionInfo {
    const live = this.#sessions.get(id);
    if (live) {
      live.info.workspace = workspace;
      this.#updateSession(live);
      return live.info;
    }
    const row = this.#store.getSession(id);
    if (!row) throw new Error(`no such session: ${id}`);
    if (!this.#store.setWorkspace(id, workspace)) throw new Error(`no such session: ${id}`);
    return {
      id: row.id, backend: row.backend, acpSessionId: row.acpSessionId, cwd: row.cwd,
      workspace, title: row.title, status: row.status, pid: null, createdAt: row.createdAt,
      modes: (row.modes ?? null) as SessionModeState | null,
      configOptions: (row.configOptions ?? []) as ConfigOptionView[],
      usage: (row.usage ?? null) as SessionInfo["usage"],
      commands: normCommands(row.commands),
      lastSeq: this.#store.maxSeq(id),
    };
  }

  /** Rename a slot. A title is DISPLAY state, not agent state: a cold slot must be
   *  renamable without waking it up (the agent never hears about this). `null`/blank
   *  clears back to the generated title; control characters fold to spaces and the
   *  result is capped, because this string is rendered in a single-line row. */
  rename(id: string, title: string | null): SessionInfo {
    const clean = title == null ? null : title.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, 120).trim();
    if (!this.#store.renameSession(id, clean && clean.length ? clean : null)) {
      throw new Error(`no such session: ${id}`);
    }
    const live = this.#sessions.get(id);
    if (live) {
      live.info.title = this.#store.getSession(id)?.title ?? live.info.title;
      this.#updateSession(live);
      this.#emit({ t: "session", session: live.info });
      return live.info;
    }
    const row = this.#store.getSession(id);
    if (!row) throw new Error(`no such session: ${id}`);
    return {
      id: row.id, backend: row.backend, acpSessionId: row.acpSessionId, cwd: row.cwd,
      workspace: row.workspace ?? null,
      models: (row.models ?? null) as SessionInfo["models"],
      contextLimit: row.contextLimit ?? null,
      title: row.title, status: row.status, pid: null, createdAt: row.createdAt,
      modes: (row.modes ?? null) as SessionModeState | null,
      configOptions: (row.configOptions ?? []) as ConfigOptionView[],
      usage: (row.usage ?? null) as SessionInfo["usage"],
      commands: normCommands(row.commands),
      lastSeq: this.#store.maxSeq(id),
    };
  }

  // ---- generated titles -----------------------------------------------------
  //
  // Two producers, one authority rule (see Store.setAutoTitle): a generated name always lands
  // in `auto_title`, and it moves the DISPLAY title only while the operator has not named the
  // session themselves. So an automatic title can fire at any time without ever overwriting a
  // hand-written one, and a cleared rename still falls back to something real.

  /** The name a slot wears before anything is known about it ("Hermes @ tmp"). */
  #placeholder(row: SessionRow): string {
    const label = this.#store.getBackend(row.backend)?.label ?? BACKENDS[row.backend]?.label ?? row.backend;
    return `${label} @ ${shortCwd(row.cwd)}`;
  }

  /** Derive a title from the prompt the operator just sent (no model, instant).
   *
   *  Only while the row still wears its placeholder. A derived name is a STARTING point, not a
   *  running commentary on the conversation: once a better name exists — the agent announced
   *  one, or the operator regenerated it — quoting the newest prompt over it would be a
   *  downgrade. (AionUi draws the same line: it only re-derives while the name is still the
   *  default one.) */
  #autoTitleFrom(s: LiveSession, text: string): void {
    const row = this.#store.getSession(s.info.id);
    if (!row) return;
    const placeholder = this.#placeholder(row);
    if (row.autoTitle && row.autoTitle !== placeholder) return;
    const t = deriveTitle(text);
    if (!t || t === row.autoTitle) return;
    this.#applyAutoTitle(s.info.id, t, false);
  }

  /** Write a generated title and tell everyone who renders a row about it. */
  #applyAutoTitle(id: string, title: string, force: boolean): SessionRow | null {
    const row = this.#store.setAutoTitle(id, title, { force });
    if (!row) return null;
    const live = this.#sessions.get(id);
    if (live) {
      live.info.title = row.title;
      live.info.autoTitle = row.autoTitle ?? null;
      this.#updateSession(live);
    }
    // the rail lists cold slots too, so refresh the whole list rather than just this session
    this.#emit({ t: "sessions", sessions: this.list() });
    return row;
  }

  /** How the last regeneration got its name — "agent" (a real summary) or "derived" (the
   *  fallback that just names the session after the latest prompt). */
  lastTitleVia: "agent" | "derived" = "derived";

  /**
   * Regenerate a slot's name from the CURRENT conversation (the operator asking for one).
   *
   * The agent does the summarising, on a THROWAWAY FORK of the session: ACP's `session/fork`
   * exists for exactly this — "Creates a new session based on the context of an existing one,
   * allowing operations like generating summaries without affecting the original session's
   * history" (Hermes deep-copies the history into the fork). So we get a name that reflects
   * everything said so far while the session's own transcript, context window and turn count
   * stay untouched. Needs a live agent advertising `session/fork`; otherwise — and on any
   * failure — we fall back to naming it after the LATEST prompt: still the newest context,
   * just without a model.
   */
  async regenerateTitle(id: string): Promise<SessionInfo> {
    const live = this.#sessions.get(id);
    const msgs = this.#store.messagesTail(id, Number.MAX_SAFE_INTEGER).messages;
    // Nothing has been said yet: there is no context to name, and asking the agent would
    // either burn a turn on an empty conversation or produce a title about nothing. Refuse.
    if (!msgs.some((m) => m.kind === "user")) {
      throw new Error("这个会话还没有可以用来生成标题的对话内容");
    }
    let title: string | null = null;
    let via: "agent" | "derived" = "derived";
    if (live?.conn && live.info.acpSessionId && live.caps.fork && !live.busy) {
      title = await this.#titleFromFork(live).catch(() => null);
      if (title) via = "agent";
    }
    if (!title) title = titleFromLatestPrompt(msgs);
    if (!title) throw new Error("这个会话还没有可以用来生成标题的对话内容");
    if (!this.#applyAutoTitle(id, title, true)) throw new Error(`no such session: ${id}`);
    this.lastTitleVia = via;
    const info = this.#sessions.get(id)?.info ?? this.#coldInfo(id);
    this.#emit({ t: "session", session: info });
    return info;
  }

  /**
   * Fork the session, ask the FORK for a title, throw the fork away.
   *
   * WHY THIS IS CHEAP (measured against real `hermes acp`, 2026-10-04): the title turn billed
   * **147 fresh input tokens + 51 output**, with **12,544 tokens served from the provider's
   * prefix cache** — i.e. ~12.5k of the ~12.9k prompt was a cache read, not fresh tokens.
   *
   * The reason is the SHAPE of what we send: the fork deep-copies the parent's history and we
   * append exactly ONE small user message at the END. The front — system prompt, tool
   * definitions, the whole conversation — is byte-identical to the parent's last request, so
   * the prefix cache matches.
   *
   * Therefore: NEVER put anything in front of the copied history. A "you are a titling
   * assistant" system message, a rewritten or reordered history, a different cwd/model, or
   * forking from a fresh process would invalidate the entire prefix and turn this cheap click
   * into a full-context re-read (~12.9k today, growing with the session). The instruction text
   * is deliberately at the tail for that reason.
   */
  async #titleFromFork(s: LiveSession): Promise<string | null> {
    const conn = s.conn!;
    const fork = await conn.unstable_forkSession({
      sessionId: s.info.acpSessionId!,
      cwd: s.info.workspace || s.info.cwd,
      mcpServers: [],
    });
    const forkId = (fork as { sessionId?: string } | null)?.sessionId;
    if (!forkId) return null;
    let text = "";
    s.collectors.set(forkId, (u) => {
      if (String(u.sessionUpdate ?? "") !== "agent_message_chunk") return;
      const c = u.content as { text?: string } | undefined;
      if (typeof c?.text === "string") text += c.text;
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const turn = conn
        .prompt({
          sessionId: forkId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ContentBlock union
          prompt: [{ type: "text", text: TITLE_INSTRUCTION }] as any,
        })
        .then(() => "done" as const)
        .catch(() => "failed" as const);
      const timeout = new Promise<"timeout">((r) => {
        timer = setTimeout(() => r("timeout"), TITLE_FORK_TIMEOUT_MS);
        timer.unref?.();
      });
      const winner = await Promise.race([turn, timeout]);
      if (winner === "timeout") await conn.cancel({ sessionId: forkId }).catch(() => {});
      return winner === "timeout" ? null : cleanAgentTitle(text);
    } finally {
      clearTimeout(timer);
      s.collectors.delete(forkId);
      // best effort: the agent may not implement session/close (Hermes advertises fork but
      // not close today, and an unclosed fork is just a copy the agent will drop)
      await conn.closeSession({ sessionId: forkId }).catch(() => {});
    }
  }

  /** Switch the model for a live session. ACP method `session/set_model` — not in the
   *  SDK's typed surface, so it goes through the generic request() overload (verified
   *  against hermes acp, which implements set_session_model). A cold slot has no agent
   *  to switch: resume it first, then pick (same rule as modes). */
  async setModel(id: string, modelId: string): Promise<SessionInfo> {
    const s = this.#need(id);
    if (!s.conn || !s.info.acpSessionId) throw new Error("session not ready — resume it first");
    const known = s.info.models?.availableModels ?? [];
    if (known.length && !known.some((m) => m.modelId === modelId)) {
      throw new Error(`unknown model: ${modelId}`);
    }
    await s.conn.request("session/set_model", { sessionId: s.info.acpSessionId, modelId });
    if (s.info.models) s.info.models = { ...s.info.models, currentModelId: modelId };
    this.#updateSession(s);
    this.#emit({ t: "sessions", sessions: this.list() });
    return s.info;
  }

  /** Declare (or clear) the context window the gauge measures against. ACP has no
   *  method for this — a window is a property of the model/provider, reported to us via
   *  usage_update — so this is the operator's own number, kept per slot. */
  setContextLimit(
    id: string,
    limit: number | null,
    opts: { remember?: boolean; forgetModel?: boolean } = {},
  ): SessionInfo {
    const clean = limit && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null;
    const live = this.#sessions.get(id);
    if (!live && !this.#store.getSession(id)) throw new Error(`no such session: ${id}`);
    const info = live?.info ?? this.#coldInfo(id);
    const modelId = info.models?.currentModelId ?? null;
    // Studio's shape: the number belongs to the MODEL, and a session may deviate. "reset"
    // therefore clears only this session's deviation — forgetting the model is a separate,
    // deliberate act.
    if (opts.forgetModel) this.#store.setModelLimit(modelId ?? "", null);
    if (modelId && clean != null && opts.remember === true) this.#store.setModelLimit(modelId, clean);
    if (live) {
      live.info.contextLimit = clean;
      this.#updateSession(live);
    } else {
      if (!this.#store.setContextLimit(id, clean)) throw new Error(`no such session: ${id}`);
    }
    this.#emit({ t: "sessions", sessions: this.list() });
    const row = live?.info ?? this.#coldInfo(id);
    return row;
  }

  /** Keep `lastAt` on the session ITSELF, not only on the list projection. A single-session
   *  payload (status change, title update, a rename response) built from `info` used to arrive
   *  without the field, so the client's copy dropped it and that session fell back to creation
   *  order — the rail stopped moving a session up the moment you talked to it. */
  #touch(live: LiveSession, at = Date.now()): void {
    live.info.lastAt = at;
  }

  /** One cold row, in the same shape list()/archived() produce. */
  #coldInfo(id: string): SessionInfo {
    const r = this.#store.getSession(id);
    if (!r) throw new Error(`no such session: ${id}`);
    return {
      id: r.id, backend: r.backend, acpSessionId: r.acpSessionId, cwd: r.cwd,
      workspace: r.workspace ?? null, contextLimit: r.contextLimit ?? null,
      modelContextLimit: this.#store.getModelLimit(((r.models ?? null) as SessionInfo["models"])?.currentModelId ?? null),
      models: (r.models ?? null) as SessionInfo["models"],
      title: r.title, autoTitle: r.autoTitle ?? null, status: r.status, pid: null, createdAt: r.createdAt,
      modes: (r.modes ?? null) as SessionModeState | null,
      configOptions: (r.configOptions ?? []) as ConfigOptionView[],
      usage: (r.usage ?? null) as SessionInfo["usage"],
      commands: normCommands(r.commands),
      lastSeq: this.#store.maxSeq(id),
      lastAt: this.#store.lastMessageAt().get(id) ?? r.createdAt,
    };
  }

  /** Fork a session (ACP `session/fork`): the agent deep-copies the parent's history into
   *  a NEW session id, which we then bring up as its own slot — same architecture as every
   *  other session (one child, one ACP session), so a fork behaves like a resume whose id
   *  came from the parent instead of from the store.
   *
   *  A cold parent is resumed first: the fork call has to reach a live agent, and asking
   *  the operator to wake a session before forking it would be a pointless step.
   *
   *  Note the capability is `unstable` in ACP and only some agents offer it (hermes does;
   *  it advertises session.fork). When the agent does not, this throws and the UI shows
   *  the reason instead of inventing a client-side "fork". */
  async fork(id: string): Promise<SessionInfo> {
    if (!this.#sessions.has(id)) await this.resume(id); // cold parent: wake it first
    const source = this.#need(id);
    if (!source.conn || !source.info.acpSessionId) throw new Error("session not ready — resume it first");
    if (source.busy) throw new Error("the session is mid-turn — wait for it to finish before forking");
    const cwd = source.info.workspace || source.info.cwd;
    const res = (await source.conn.request("session/fork", {
      sessionId: source.info.acpSessionId,
      cwd,
      mcpServers: [],
    })) as { sessionId?: unknown; modes?: SessionModeState | null; configOptions?: ConfigOptionView[] } | null;
    const acpSessionId = res?.sessionId ? String(res.sessionId) : "";
    if (!acpSessionId) throw new Error("the agent did not return a session id for the fork");

    const newId = randomUUID();
    const now = Date.now();
    this.#store.upsertSession({
      id: newId,
      backend: source.info.backend,
      acpSessionId,
      cwd,
      title: `${source.info.title} · fork`,
      // "closed" so the rail treats it as a slot to open (resume spawns its child)
      status: "closed",
      pid: null,
      createdAt: now,
      closedAt: null,
      // the agent just told us the fork's modes/options — keep them so the new slot shows
      // the right permission mode and thinking depth before it is even resumed
      modes: res?.modes ?? source.info.modes ?? null,
      configOptions: res?.configOptions ?? source.info.configOptions ?? [],
      usage: null,
      commands: source.info.commands ?? [],
      workspace: source.info.workspace ?? null,
    });
    this.#emit({ t: "sessions", sessions: this.list() });
    // bring it up exactly like a cold slot (spawn + loadSession of the forked id)
    return await this.resume(newId);
  }

  hasSession(id: string): boolean {
    return this.#sessions.has(id);
  }
}

/** ACP ContentBlock[] for a prompt: text first (the instruction), then media.
 *  Text attachments are inlined with a filename header because that is what every
 *  agent actually reads well; images go as protocol image blocks. */
function buildPromptBlocks(text: string, attachments: PromptAttachment[]): unknown[] {
  const blocks: unknown[] = [];
  const body = text.trim();
  if (body) blocks.push({ type: "text", text: body });
  for (const a of attachments) {
    if (a.kind === "image") {
      blocks.push({ type: "image", mimeType: a.mimeType, data: a.data });
    } else if (a.kind === "text") {
      blocks.push({ type: "text", text: `--- attached file: ${a.name} ---\n${a.text}` });
    } else if (a.kind === "link") {
      blocks.push({ type: "resource_link", uri: a.uri, name: a.name });
    }
  }
  return blocks;
}

/** Attachment metadata for the transcript row (names only — see AttachmentSummary). */
function summarize(attachments: PromptAttachment[]): AttachmentSummary[] {
  return attachments.map((a) => ({
    kind: a.kind,
    name: a.name,
    mimeType: a.kind === "image" ? a.mimeType : undefined,
  }));
}

function sessionRow(i: SessionInfo) {
  return {
    id: i.id, backend: i.backend, acpSessionId: i.acpSessionId, cwd: i.cwd,
    title: i.title, status: i.status, pid: i.pid, createdAt: i.createdAt, closedAt: null,
    modes: i.modes ?? null, configOptions: i.configOptions ?? [],
    usage: i.usage ?? null, commands: i.commands ?? [],
    models: i.models ?? null,
  };
}

/** ACP carries the session's model list as ``models`` on newSession/loadSession. The SDK
 *  in use does not publish the type (and may drop it in a future version), so this reads
 *  it from the loose response and normalizes it rather than trusting a shape. */
function readModels(res: unknown): SessionInfo["models"] {
  const m = (res as { models?: unknown } | null | undefined)?.models as
    | { currentModelId?: unknown; availableModels?: unknown }
    | null
    | undefined;
  if (!m || !Array.isArray(m.availableModels)) return null;
  const availableModels = m.availableModels
    .map((raw) => {
      const o = raw as { modelId?: unknown; name?: unknown; description?: unknown };
      return {
        modelId: String(o.modelId ?? ""),
        name: String(o.name ?? o.modelId ?? ""),
        description: o.description == null ? null : String(o.description),
      };
    })
    .filter((o) => o.modelId);
  if (!availableModels.length) return null;
  return { currentModelId: m.currentModelId == null ? null : String(m.currentModelId), availableModels };
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
