// SessionManager — one ACP client connection per session, per design.md §1.
// Owns: subprocess lifecycle (spawn/kill/orphan-reclaim), the ACP ClientSideConnection
// loop, event fan-out with monotonic seq, permission pending-map with timeout,
// mode/config plumbing. UI holds zero intelligence (red line D): we only relay.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import type {
  McpServer,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { BACKENDS, buildSpawnEnv, nativePlanSourceOf, type BackendSpec } from "./backends.js";
import { classifyError, checkedHealth, effectiveArgs, handshakeFrom, rowToSpec } from "./registry.js";
import type { BackendHandshake, CheckErrorCode } from "./registry.js";
import {
  cleanAgentTitle, deriveTitle, titleFromLatestPrompt, TITLE_INSTRUCTION,
} from "../title.js";
import type { Store, SessionRow } from "../store/store.js";
import { textOf, withText } from "../store/store.js";
import type {
  AttachmentSummary,
  BackendId,
  ConfigOptionView,
  PermissionDecision,
  PermissionDiff,
  PermissionRequestView,
  PlanSnapshot,
  PromptAttachment,
  ServerEvent,
  SessionInfo,
  SessionModeState,
  TurnTrace,
} from "../../../shared/src/index.js";
import { acceptsToolWrite, acceptsWriteFrom, clampExplanation, demoteInProgress, foldPlanUpdate, hasUnfinished, normalizeItems, v2PlanEnabled } from "../plan/plan.js";

// Permission prompts must not hang a session forever (design.md §8-4).
// Env-tunable so QA can exercise the timeout path in seconds instead of minutes.
const PERMISSION_TIMEOUT_MS = Number(process.env.AGENTUS_PERM_TIMEOUT_MS || 5 * 60_000);

// ── What the request is ABOUT ─────────────────────────────────────────────────────────────────
// An edit approval arrives as a `ToolCallUpdate` whose `content` carries a diff (path + the
// whole text before and after), and the agent puts the tool's own arguments in `rawInput`. The
// operator is being asked to let a file change, so the surface that asks must be able to say
// WHICH file and WHAT changes — a bare title is the difference between a decision and a coin
// flip. Sent BOUNDED: a patch proposal carries the entire file twice, and this view also
// travels to a phone over a tunnel.
const PREVIEW_LIMIT = 4000;
// …but bounded AROUND the change, never from the front: see boundedDiff.
const CONTEXT_KEEP = 400;

interface PermissionToolCall {
  title?: string;
  kind?: string;
  content?: { type?: string; path?: string; oldText?: string | null; newText?: string | null }[];
  rawInput?: { path?: string; arguments?: { path?: string } };
}

function permissionArtifacts(tc: PermissionToolCall): { path: string | null; diff: PermissionDiff | null } {
  const node = (tc.content ?? []).find((c) => c && typeof c.path === "string" && c.path);
  const rawPath = tc.rawInput?.arguments?.path ?? tc.rawInput?.path ?? null;
  const path = node?.path ?? (typeof rawPath === "string" && rawPath ? rawPath : null);
  if (!path) return { path: null, diff: null };
  if (!node || (node.oldText == null && node.newText == null)) return { path, diff: null };
  return { path, diff: boundedDiff(path, node.oldText ?? "", node.newText ?? "") };
}

/** The before/after, bounded so the change survives — not sliced from the front.
 *
 *  A real edit approval carries the WHOLE file on each side (hermes: old_text/new_text are the
 *  complete contents). Cutting both sides at the same offset keeps their shared head and tail,
 *  drops the middle — which is exactly where the change is — and hands the client two texts that
 *  differ at the cut, so it reports the truncation as a rewrite: an 83-line file with ONE edited
 *  line showed up as ~60 changed lines (measured 2026-10-06, mock `[tool-hermes]`). Trim the
 *  shared head and tail first, keep a little of each as context, and only then bound. */
function boundedDiff(path: string, oldText: string, newText: string): PermissionDiff {
  let head = 0;
  const shared = Math.min(oldText.length, newText.length);
  while (head < shared && oldText[head] === newText[head]) head++;
  let tail = 0;
  while (tail < shared - head && oldText[oldText.length - 1 - tail] === newText[newText.length - 1 - tail]) tail++;
  const from = Math.max(0, head - CONTEXT_KEEP);
  const upto = (s: string): number => Math.max(from, s.length - Math.max(0, tail - CONTEXT_KEEP));
  const window = (s: string): string => s.slice(from, upto(s));
  const oldSide = window(oldText);
  const newSide = window(newText);
  const clipped = oldSide.length > PREVIEW_LIMIT || newSide.length > PREVIEW_LIMIT;
  return {
    path,
    oldText: oldSide.slice(0, PREVIEW_LIMIT),
    newText: newSide.slice(0, PREVIEW_LIMIT),
    // "truncated" means the operator is NOT looking at the whole proposal. Dropping a shared
    // head/tail we kept in full inside CONTEXT_KEEP is not that — a two-line sample file would
    // otherwise carry a "only part of it is shown" note and teach the operator to ignore it.
    truncated: clipped || from > 0 || tail > CONTEXT_KEEP,
  };
}

// A title fork is a real model turn over a copy of the conversation: give it room, but never
// let a stuck one hang the operator's click — the caller falls back to the derived name on
// timeout. Env-tunable so a sweep can exercise the timeout path in seconds.
const TITLE_FORK_TIMEOUT_MS = Number(process.env.AGENTUS_TITLE_TIMEOUT_MS || 90_000);

// How long a cancelled turn may take to actually stop before an interrupting prompt gives up
// (an agent that ignores session/cancel must not hang the operator's next sentence forever).
const TURN_SETTLE_TIMEOUT_MS = Number(process.env.AGENTUS_SETTLE_TIMEOUT_MS || 15_000);

/** A cold slot the agent cannot adopt, and why — the only two answers there are.
 *
 *  Resuming has to *ask* the agent: `session/load` is "do you still have this session?", and the
 *  agent answers for the home it was handed NOW. Nothing in ACP says "no" loudly — Hermes returns
 *  a null result (just a log line) and its `prompt` answers `stop_reason:"refusal"` — so before
 *  this the cockpit reported the slot `ready` and then swallowed every message: the operator wrote
 *  into a slot that looked alive and heard nothing back (measured 2026-10-06, 5 minutes, no error).
 *
 *  Both cases are refusals the operator must SEE — with the two homes named — and the only useful
 *  action for a slot that can never come back is to delete it. */
export class SessionUnavailable extends Error {
  readonly code: "home_mismatch" | "context_missing";
  /** the home the session was created under (null for a row written before this was recorded) */
  readonly sessionHome: string | null;
  /** the home the backend row hands out today */
  readonly rowHome: string | null;

  constructor(
    code: SessionUnavailable["code"],
    message: string,
    homes: { sessionHome?: string | null; rowHome?: string | null } = {},
  ) {
    super(message);
    this.name = "SessionUnavailable";
    this.code = code;
    this.sessionHome = homes.sessionHome ?? null;
    this.rowHome = homes.rowHome ?? null;
  }
}

interface LiveSession {
  info: SessionInfo;
  child?: ReturnType<typeof spawn>;
  conn?: ClientSideConnection;
  busy: boolean;
  pendingPermissions: Map<string, {
    /** The view the operator is looking at. Kept (not just the resolver) so a page that
     *  connects or REFRESHES later can be told what is already waiting for it. */
    view: PermissionRequestView;
    resolve: (r: RequestPermissionResponse) => void;
    timer: NodeJS.Timeout;
  }>;
  alwaysAllow: Set<string>; // "allow_always" remembered per live session only (AionUi F-PERM-05)
  stderrBuf: string[];
  /** What the agent says it can do (initialize.agentCapabilities), kept because the title
   *  regeneration is only possible when it advertises `session/fork`. */
  caps: { fork: boolean; load: boolean };
  /** Incremented when a turn STARTS. An interrupt waits for the specific turn it cancelled,
   *  so a second interrupting utterance that already started its own turn is not mistaken for
   *  "the one I cancelled is still running". */
  turnSeq: number;
  /** When the operator last USED this slot — he opened it, or his page reported it as the one on
   *  screen. In memory on purpose: this is the half of the idle rule that says "he was just here",
   *  and the store's message clock (which survives restarts) is the other half. Reading only the
   *  message clock reaped a slot he had clicked into a minute earlier (see `touch()` and the clock
   *  in `startIdleReaper`). */
  touchedAt: number;
  /** Text sinks for sessions that live on this connection but are NOT the one in the rail —
   *  today only the throwaway fork used to summarise the conversation for a title. Anything
   *  whose sessionId is not `info.acpSessionId` is routed here and never persisted. */
  collectors: Map<string, (u: Record<string, unknown>) => void>;
  /** Set while restart() is swapping this slot's process. The child that is exiting belongs to the
   *  slot being REPLACED, so its exit must not be read as "the agent died" — that would stamp
   *  `error` on the row its replacement is adopting and fire a turn-end on a slot mid-swap. */
  replacing?: boolean;
  /** Set from spawn/resume until this slot's first prompt: the agent is re-sending its own history
   *  (ACP `session/load` replays the transcript), so its frames are a RECORD of work already stored,
   *  not new work. Persisting them wrote 1240 rows on one restart and moved every session's clock to
   *  「刚刚」; the clock is the operator's "when was this last talked to", and a restart is not a
   *  conversation. Cleared the moment the operator actually says something — from then on the agent
   *  really is answering. */
  replaying?: boolean;
  /** The plan hand-over is owed on the NEXT prompt: a freshly (re)started agent has no memory of
   *  the plan it was working on, while the cockpit still has it (design-plan-service.md §7).
   *  Cleared after the first prompt, because after that the agent maintains the plan itself —
   *  re-sending it every turn would cost context and invite re-deriving finished work. */
  planReminderPending?: boolean;
  /** Minted per agent process and handed to the plan MCP server through the HANDSHAKE (§4): it is
   *  what keeps the tool's writes scoped to this one session even if the spawn command is copied
   *  out of `ps`. Lives and dies with the process that received it. */
  planToken: string;
  /** ACP v2 lets a session carry several plans (`planId`); the card renders one. Whichever planId
   *  shows up first is adopted and the rest are left alone — see the `plan_update` case. */
  planId?: string;
  /** One log line per agent process the first time a frame is ignored, so a reader of the log can
   *  tell "the cockpit is dropping these on purpose" from "the agent stopped emitting them". */
  planFramesDropped?: boolean;
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
    const lastAt = this.#store.lastActivityAt();
    return [...this.#sessions.values()]
      // An ARCHIVED session is not 工作空间 material, whatever its process is doing (resume leaves the
      // flag alone, so a restored-then-archived slot can be live). It is listed by `archived()`
      // instead — one row in one bucket, or the rail shows the same slot twice.
      .filter((s) => this.#store.getSession(s.info.id)?.archivedAt == null)
      .map((s) => ({
        ...s.info,
        lastSeq: this.#store.maxSeq(s.info.id),
        lastAt: lastAt.get(s.info.id) ?? s.info.createdAt,
        archivedAt: null,
        // a row in the manager's map has a process, by definition
        cold: false,
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
        // Only a turn that was ACTUALLY in flight can be reported as interrupted. A `ready` session
        // had finished its turn, and restamping its plan would replace an honest "回合结束" with
        // "已打断" — a lie the restart invents on its own (measured: a plan the mock had already
        // closed out came back stamped interrupted after a restart).
        const wasRunning = row.status === "running";
        this.#store.upsertSession({ ...row, status: "error", closedAt: Date.now(), pid: null });
        // A crash between turns left the plan card mid-work with nothing to finish it; the
        // startup reclaim is the one that owns the run now, so it closes the card honestly.
        if (wasRunning) this.#finalizePlan(row.id, "interrupted");
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
    // `spawn` reports an unrunnable command (ENOENT/EACCES) through an 'error' event instead of
    // throwing, and leaves `child.pid` undefined. Left alone that becomes an uncaught exception
    // plus a caller awaiting a handshake that can never arrive — so it is turned into a normal
    // failure here, carrying the code the settings page shows for it.
    let spawnError: Error | null = null;
    child.on("error", (err: Error) => { spawnError = err; });
    if (child.pid === undefined) {
      const why = `failed to spawn ${spec.cmd}${spawnError ? `: ${(spawnError as Error).message}` : " (no pid)"}`;
      this.#noteBackendCheck(String(backend), {
        ok: false, errorCode: "spawn_failed", error: why, latencyMs: Date.now() - spawnStarted,
      });
      throw new Error(why);
    }

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
      caps: { fork: false, load: false }, turnSeq: 0, collectors: new Map(), planReminderPending: true,
      planToken: randomUUID(),
      // A brand-new process is, by definition, freshly used: the click that spawned it is the
      // activity. Without this the slot inherits the store's message clock — yesterday's — and the
      // reaper's first tick after the spawn kills the process the operator just asked for.
      touchedAt: Date.now(),
      // Until this slot's first PROMPT, anything the agent says is its own history being replayed,
      // not an answer (see #onSessionUpdate). A resumed agent re-sends its whole transcript on
      // `session/load` — full-length blocks, no messageId — and persisting those wrote 1240 rows
      // into the live DB on one restart and pushed every session's clock to「刚刚」.
      replaying: true,
    };
    this.#sessions.set(id, live);
    live.info.lastAt = this.#store.lastActivityAt().get(id) ?? live.info.createdAt;
    // the home is recorded with the row: it is the thing a later resume has to be checked against
    this.#store.upsertSession(sessionRow(live.info, plan.home));

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
      const res = await conn.newSession({ cwd, mcpServers: this.#planMcpServers(spec, live) });
      live.info.acpSessionId = res.sessionId;
      live.info.status = "ready";
      live.info.modes = (res.modes ?? null) as SessionModeState | null;
      live.info.configOptions = normConfigOptions(res.configOptions);
      // `models` is on the wire but not in the SDK's published types (see shared/index.ts),
      // so read it defensively instead of trusting a typed field that does not exist.
      live.info.models = readModels(res);
      // the row just proved itself: remember that, plus what the agent said it can do
      this.#noteBackendCheck(String(backend), { ok: true, latencyMs: Date.now() - spawnStarted }, handshakeFrom(init, res));
      // The row's DEFAULT permission mode, applied HERE: on a brand-new session, before the first
      // prompt. Hermes reads its mode through a live getter (acp_adapter/server.py `policy_getter`),
      // so the very first turn is already governed by it. A later `resume()` never passes through
      // this method — that is exactly what keeps a per-session pick from being silently undone.
      await this.#applyDefaultMode(live);
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
  async resume(id: string, opts: { replace?: boolean } = {}): Promise<SessionInfo> {
    // `replace` is restart()'s path: the slot is still in the map on purpose (dropping it made the
    // rail flash the slot as cold for the length of a spawn), so the "already live, nothing to do"
    // shortcut has to be skipped and the fresh child takes its place.
    const existing = this.#sessions.get(id);
    if (existing && !opts.replace) return existing.info;

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
    // ── Can this slot come back AT ALL? ──────────────────────────────────────────────────────
    // A session's agent-side state lives in the home it was CREATED under; a resume hands the
    // agent whatever home the row names TODAY. If those differ, the agent is being asked about a
    // session in a database it does not have — it will answer politely and do nothing (measured:
    // `{}` from session/load, `refusal` from session/prompt, and the slot still said "ready").
    // Refuse BEFORE spawning, so the operator gets a reason instead of a dead slot.
    if (row.home && plan.home && row.home !== plan.home) {
      throw new SessionUnavailable(
        "home_mismatch",
        `this session's agent-side state is in ${row.home}, but the backend row now uses ${plan.home}`,
        { sessionHome: row.home, rowHome: plan.home },
      );
    }
    const resumeStarted = Date.now();
    const child = spawn(spec.cmd, args, {
      cwd: resumeCwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: plan.env,
    });
    child.unref();
    // same guard as create(): an unrunnable command must fail normally, with a code attached
    let resumeSpawnError: Error | null = null;
    child.on("error", (err: Error) => { resumeSpawnError = err; });
    if (child.pid === undefined) {
      const why = `failed to spawn ${spec.cmd}${resumeSpawnError ? `: ${(resumeSpawnError as Error).message}` : " (no pid)"}`;
      this.#noteBackendCheck(String(row.backend), {
        ok: false, errorCode: "spawn_failed", error: why, latencyMs: Date.now() - resumeStarted,
      });
      throw new Error(why);
    }

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
      caps: { fork: false, load: false }, turnSeq: 0, collectors: new Map(), planReminderPending: true,
      planToken: randomUUID(),
      // A brand-new process is, by definition, freshly used: the click that spawned it is the
      // activity. Without this the slot inherits the store's message clock — yesterday's — and the
      // reaper's first tick after the spawn kills the process the operator just asked for.
      touchedAt: Date.now(),
      // Until this slot's first PROMPT, anything the agent says is its own history being replayed,
      // not an answer (see #onSessionUpdate). A resumed agent re-sends its whole transcript on
      // `session/load` — full-length blocks, no messageId — and persisting those wrote 1240 rows
      // into the live DB on one restart and pushed every session's clock to「刚刚」.
      replaying: true,
    };
    this.#sessions.set(id, live);
    live.info.lastAt = this.#store.lastActivityAt().get(id) ?? live.info.createdAt;
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
      let loaded = (await conn.loadSession({
        sessionId: row.acpSessionId, cwd: row.cwd, mcpServers: this.#planMcpServers(spec, live),
      })) as { modes?: SessionModeState | null; configOptions?: ConfigOptionView[]; sessionId?: string } | undefined;
      // ── Did the agent actually adopt it? ────────────────────────────────────────────────────
      // Measured against the real CLI (scripts/probe-load-missing.mjs): for a session it does not
      // have, hermes answers `session/load` with an EMPTY result and `session/prompt` with
      // `stopReason:"refusal"` — no error either way, which is precisely how a dead slot came to
      // look alive (it said "ready" and ate every message). An empty answer is the only "no" we
      // get, so it is the one we act on.
      const adopted = Boolean(loaded && typeof loaded === "object" && Object.keys(loaded).length > 0);
      if (!adopted) {
        // Two different things look the same here, and they are not equally bad:
        //  · the slot never had a turn — the agent persists a session when it starts WORKING, so a
        //    slot closed before its first message has nothing anywhere. There is no context to
        //    lose and nothing to tell the operator: opening a fresh agent session in the same slot
        //    is exactly what reopening it means;
        //  · there IS a transcript — the operator's conversation is the thing that is gone, and
        //    that must be said out loud rather than papered over with a session that starts blank.
        if (this.#store.maxSeq(id) === 0) {
          loaded = (await conn.newSession({ cwd: resumeCwd, mcpServers: this.#planMcpServers(spec, live) })) as typeof loaded;
          const freshId = loaded?.sessionId;
          if (!freshId) throw new Error(`the agent would not open a fresh session in ${resumeCwd}`);
          live.info.acpSessionId = freshId;
        } else {
          throw new SessionUnavailable(
            "context_missing",
            `the agent has no session ${row.acpSessionId} in ${plan.home ?? "its default home"}`,
            { sessionHome: row.home ?? null, rowHome: plan.home },
          );
        }
      }
      // The agent has this session (or just opened one in the same slot), so THIS home is where the
      // state lives: a row that predates the home column stops being ambiguous.
      if (!row.home && plan.home) {
        this.#store.setSessionHome(id, plan.home);
        row.home = plan.home;
      }
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
        live.info.configOptions = normConfigOptions(loaded.configOptions).map((o) => (
          storedPicks.has(o.id) ? { ...o, currentValue: storedPicks.get(o.id) } : o
        ));
      }
      // same for the mode: the archived mode wins over a backend default
      if (row.modes && live.info.modes && (row.modes as SessionModeState).currentModeId) {
        live.info.modes = { ...live.info.modes, currentModeId: (row.modes as SessionModeState).currentModeId };
      }
      this.#updateSession(live);
      // …against the session the agent is actually serving NOW (a re-minted one, if the slot had no
      // state to restore): asking about the old id would be the same silent no-op all over again.
      const acpId = live.info.acpSessionId as string;
      const modeId = (live.info.modes as SessionModeState | null)?.currentModeId;
      if (modeId) await conn.setSessionMode({ sessionId: acpId, modeId }).catch(() => {});
      for (const cfg of (live.info.configOptions ?? []) as ConfigOptionView[]) {
        // "" is a legitimate "unset / follow default" — replaying it can be rejected as an
        // invalid option value, so only re-apply real picks.
        if (cfg?.id && cfg.currentValue) {
          await conn
            .setSessionConfigOption({ sessionId: acpId, configId: cfg.id, value: String(cfg.currentValue) })
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
      this.#emitSessions();
      return live.info;
    } catch (err) {
      child.kill("SIGKILL");
      live.info.status = "error";
      live.info.lastError = errMessage(err) + stderrTail(live);
      this.#sessions.delete(id);
      if (err instanceof SessionUnavailable) {
        // The ROW is not at fault — a brand-new slot on it works — so this is not a row failure and
        // must not be recorded as one. Put the stored row back exactly as we read it: the early
        // `upsertSession` above had already stamped it "starting" with a pid that is now dead.
        this.#store.upsertSession(row);
        throw err;
      }
      this.#store.upsertSession({ ...sessionRow(live.info), closedAt: Date.now() });
      this.#noteBackendCheck(String(row.backend), {
        ok: false, error: live.info.lastError, errorCode: classifyError(err),
        latencyMs: Date.now() - resumeStarted,
      });
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /** Swap the agent process under a LIVE slot, keeping everything the operator can see: same slot
   *  id, same ACP session (the transcript lives agent-side), same stored picks (model, mode,
   *  thinking depth). Only the pid changes.
   *
   *  Why it exists: a spawned CLI holds the modules it loaded at startup, so a fix sitting on disk
   *  is invisible to a slot that is already up. Before this the only way to pick new code up was
   *  archive → un-archive (measured 2026-10-07: exactly that dance was needed for a thinking-depth
   *  fix). This reuses the resume path instead of duplicating it — resume already rebuilds a child,
   *  calls loadSession, and re-applies the stored picks, including the rule that the OPERATOR's
   *  thinking depth wins over whatever the backend re-announces on load.
   *
   *  A restart kills the process mid-turn; the client confirms that with the operator first. */
  async restart(id: string): Promise<SessionInfo> {
    const live = this.#sessions.get(id);
    if (!live) throw new Error(`session ${id} has no running agent to restart`);
    // The slot stays IN the map for the whole swap: it keeps its place in the rail, and it must
    // never read as cold while the old child dies (an earlier revision deleted it here and the
    // operator watched their slot flicker into the archive for a second — measured on :8901).
    // Mark the swap BEFORE the signal, so the exit we are causing is not read as a dead agent.
    live.replacing = true;
    for (const { resolve, timer } of live.pendingPermissions.values()) {
      clearTimeout(timer);
      resolve({ outcome: { outcome: "cancelled" } });
    }
    live.pendingPermissions.clear();
    live.busy = false;
    // show the swap honestly: "starting" with no pid, not a pid that is already gone
    live.info.status = "starting";
    live.info.pid = null;
    this.#updateSession(live);
    await this.#stopChild(live, 5000);
    return this.resume(id, { replace: true });
  }

  /** SIGTERM, then SIGKILL if it will not go. Resolves once the child is really gone, so the caller
   *  can spawn its replacement without two processes racing over the same session state. */
  #stopChild(live: LiveSession, graceMs: number): Promise<void> {
    const child = live.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        // SIGKILL cannot be caught, so its exit event is the honest signal — but never hang the
        // request on a zombie that never reports one.
        setTimeout(done, 250);
      }, graceMs);
      child.once("exit", done);
      child.kill("SIGTERM");
    });
  }

  /** Rows the OPERATOR put away — 已归档. Chosen by the archive FLAG, not by liveness: a session
   *  the operator archived belongs there whatever its process is doing, and a session that merely
   *  lost its process (crashed, was closed, or was reaped for being idle) does NOT — that was the
   *  old rule, and it turned 已归档 into a drawer where the operator's own intent was
   *  indistinguishable from debris.
   *
   *  No cap: this list is curated by hand, so hiding its tail would hide the operator's own work.
   *  Real removal is the ✕ purge button (DELETE on a cold row). */
  archived(): SessionInfo[] {
    const lastAtAll = this.#store.lastActivityAt();
    return this.#store
      .listSessions(true)
      .filter((r) => r.archivedAt != null)
      .map((r) => {
        const live = this.#sessions.get(r.id);
        // An archived row can still have a process — resume does not touch the flag — and then it is
        // NOT cold: the rail must draw a live row (and clicking it hands over the floor rather than
        // waking anything), or the operator is told a slot is asleep while it is running.
        return live
          ? {
              ...live.info,
              lastSeq: this.#store.maxSeq(r.id),
              lastAt: lastAtAll.get(r.id) ?? r.createdAt,
              archivedAt: r.archivedAt ?? null,
              cold: false,
            }
          : this.#infoFromRow(r);
      })
      .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0) || (b.lastAt ?? 0) - (a.lastAt ?? 0));
  }

  /** Cold rows that are NOT archived: on disk, no process, still part of 工作空间. A crashed slot,
   *  one the operator closed, or one THIS cockpit reaped for being idle — all of them must stay
   *  reachable in the rail (the old rule showed them under 已归档; the older one dropped them out of
   *  the list entirely, which is how a transcript became unreachable while still on disk).
   *
   *  Capped, unlike `archived()`: crash debris accumulates without anyone choosing it, and the rail
   *  has its own recent-N rule anyway. */
  cold(limit = 20): SessionInfo[] {
    return this.#store
      .listSessions(true)
      .filter((r) => r.archivedAt == null && !this.#sessions.has(r.id))
      .map((r) => this.#infoFromRow(r))
      // cold rows by the same rule as live ones (recent chat first), THEN take the page
      .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0) || b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  /** One row in the shape list()/cold()/archived() produce, from a stored row. */
  #infoFromRow(r: SessionRow): SessionInfo {
    return {
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
      lastAt: this.#store.lastActivityAt().get(r.id) ?? r.createdAt,
      archivedAt: r.archivedAt ?? null,
      // no process by construction: this path only ever runs for a row that is not in the map
      cold: true,
    };
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
    // The plan hand-over, owed once per agent process (§7): a restarted agent never knew about the
    // plan, and nothing else on this wire would tell it (ACP has no server->agent state channel).
    if (s.planReminderPending) {
      s.planReminderPending = false;
      const reminder = this.#planReminder(s);
      if (reminder) blocks.push(reminder);
    }
    s.turnSeq += 1;
    s.busy = true;
    // The operator has spoken: from here anything the agent says is an ANSWER, not its own history
    // being replayed (see the replay window in #onSessionUpdate).
    s.replaying = false;
    s.info.status = "running";
    this.#updateSession(s);
    // Timed from the announcement, not from the prompt call: the operator's wait INCLUDES the
    // moment the card lit up. Only the queue-wait above is excluded (that is other turns' time).
    const turnStartedAt = Date.now();
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
      const terminalState = res?.stopReason === "cancelled" ? "interrupted" : "ended";
      this.#finalizePlan(sessionId, terminalState);
      this.#emit({ t: "turn-end", sessionId, stopReason: res?.stopReason, durationMs: Date.now() - turnStartedAt });
    } catch (err) {
      this.#finalizePlan(sessionId, "failed");
      this.#emit({ t: "turn-end", sessionId, error: errMessage(err), durationMs: Date.now() - turnStartedAt });
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
      console.log(`[agentus] cancel ignored for ${sessionId}: no turn is running`);
      return;
    }
    console.log(`[agentus] cancel sent for ${sessionId}`);
    await s.conn.cancel({ sessionId: s.info.acpSessionId }).catch(() => {});
  }

  /**
   * Put a NEW session into its backend row's default permission mode (BackendRow.defaultMode).
   * Called from `create()` only — see the call site for why a resume must never do this.
   *
   * Three refusals are deliberate:
   *  · a row with no default sends NOTHING (the agent keeps its own default) — so a registry the
   *    operator never touched behaves exactly as it did before this existed;
   *  · a mode the agent did not advertise is not sent either: it would come back as a refusal nobody
   *    sees, and the settings row already wears a warning saying the pick does not match this
   *    agent's handshake (registry.rowWarnings);
   *  · a failure NEVER fails the slot. The session is usable, just in the agent's own mode — and the
   *    log line is the only evidence of which of those two happened, so it is not optional.
   */
  async #applyDefaultMode(live: LiveSession): Promise<void> {
    const wanted = (this.#store.getBackend(String(live.info.backend))?.defaultMode ?? "").trim();
    if (!wanted) return;
    const modes = live.info.modes;
    const acpSessionId = live.info.acpSessionId;
    if (!modes || !live.conn || !acpSessionId) return;
    const ids = (modes.availableModes ?? []).map((m) => m.id);
    if (!ids.includes(wanted)) {
      console.log(
        `[agentus] session ${live.info.id}: default permission mode "${wanted}" is not advertised by ` +
          `${String(live.info.backend)} (${ids.join(", ") || "no modes"}) — sending nothing`,
      );
      return;
    }
    if (modes.currentModeId === wanted) return;
    try {
      await live.conn.setSessionMode({ sessionId: acpSessionId, modeId: wanted });
      live.info.modes = { ...modes, currentModeId: wanted };
      console.log(`[agentus] session ${live.info.id}: default permission mode -> ${wanted}`);
    } catch (e) {
      // qodercli advertises modes but answered -32601 in the design probe, so "advertised but not
      // implemented" is a real case — same tolerance as setMode(), and never a failed spawn.
      console.log(
        `[agentus] session ${live.info.id}: default permission mode "${wanted}" not applied: ${errMessage(e)}`,
      );
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
    const requested = String(value);
    let actual = requested;
    let rejected = false;
    try {
      const res = (await s.conn.setSessionConfigOption({
        sessionId: s.info.acpSessionId,
        configId,
        value: value as never,
      })) as unknown as { configOptions?: ConfigOptionView[] } | undefined;
      // The agent's OWN answer is the truth: ACP's response carries the rebuilt option list, and a
      // level the route folds away comes back with the old currentValue. Reading our own request
      // back would show a pick that never landed (operator report: "设置了也好像没什么变化").
      const opts = res && Array.isArray(res.configOptions) ? res.configOptions : null;
      if (opts) {
        s.info.configOptions = normConfigOptions(opts);
        const picked = opts.find((o) => o.id === configId);
        if (picked && picked.currentValue !== undefined && picked.currentValue !== null) {
          actual = String(picked.currentValue);
          rejected = actual !== requested;
        }
      } else {
        s.info.configOptions = s.info.configOptions.map((o) =>
          o.id === configId ? { ...o, currentValue: value } : o,
        );
      }
    } catch (e) {
      if (!/not found|Unsupported|method/i.test(errMessage(e))) throw e;
      // The backend advertises the option but has no setter for it: nothing reaches the agent, so a
      // local-only "success" would be a lie. Keep the session's real value and flag the pick.
      rejected = true;
      actual = String(s.info.configOptions.find((o) => o.id === configId)?.currentValue ?? "");
    }
    if (rejected) {
      this.#emit({
        t: "config-rejected",
        sessionId,
        configId,
        value: requested,
        actual,
        name: s.info.configOptions.find((o) => o.id === configId)?.name,
      });
    }
    this.#updateSession(s);
  }

  /** The spawn spec for a backend id, as the registry defines it right now. For the places that
   *  hold a session but not the spec it was spawned with (fork, the hand-over wording) — resolved
   *  fresh, so a row edited in the settings page takes effect on the next use. */
  #specFor(backendId: string): BackendSpec {
    const row = this.#store.getBackend(backendId);
    return row ? rowToSpec(row) : (BACKENDS[backendId] ?? BACKENDS.hermes);
  }

  /** The plan MCP server to hand this agent at HANDSHAKE time — or nothing, for a row that has
   *  opted back into native frames (`nativePlanSource: "acp"`).
   *
   *  Injected rather than registered anywhere, on purpose: `mcpServers` is a per-session parameter
   *  of `session/new` / `session/load` / `session/resume`, so the tool exists exactly while Agentus
   *  is driving the session and vanishes for an agent started from the CLI, cron or Studio — which
   *  is the whole difference from a `config.yaml` entry like the `ekko_studio_*` ones (§4).
   *  The token in `env` is minted for THIS session, so a copied-out command writes only its own. */
  #planMcpServers(spec: BackendSpec, live: LiveSession): McpServer[] {
    if (nativePlanSourceOf(spec) !== "none") return [];
    return [
      {
        name: "agentus-plan",
        command: process.execPath,
        args: [path.join(path.dirname(fileURLToPath(import.meta.url)), "../../mcp/plan-server.mjs")],
        env: [
          { name: "AGENTUS_PLAN_ENDPOINT", value: `http://127.0.0.1:${process.env.AGENTUS_PORT ?? 8788}` },
          { name: "AGENTUS_PLAN_TOKEN", value: live.planToken },
          { name: "AGENTUS_PLAN_SESSION", value: live.info.id },
        ],
      },
    ];
  }

  /** Does this session's plan come from the agent's own ACP frames?
   *
   *  Only when the row opted into `nativePlanSource: "acp"`. Every other backend — Hermes included —
   *  is MCP-driven, and its frames are DROPPED rather than rendered: a frame describes the agent's
   *  PROCESS-LOCAL todo list, and the cockpit shows the plan OBJECT precisely because that list does
   *  not survive a restart (design-plan-service.md §1). Dropping the frame at the door also keeps
   *  the transcript free of plan rows that nothing ever updated. */
  #framesAccepted(live: LiveSession): boolean {
    if (nativePlanSourceOf(this.#specFor(live.info.backend)) === "acp") return true;
    // Said once per agent process: an agent may emit a frame every turn, and the operator reading
    // the log should be able to see that the cockpit is ignoring them on purpose.
    if (!live.planFramesDropped) {
      live.planFramesDropped = true;
      console.log(
        `[agentus] plan frame ignored for ${live.info.id}: backend '${live.info.backend}' is MCP-driven ` +
        `(the card is fed by the agentus-plan tool)`,
      );
    }
    return false;
  }

  /** Fold an agent's ACP plan frame into the session's plan OBJECT.
   *
   *  The object (Store's `plans` row) is what the card renders, because it survives what the frame
   *  does not: the agent's own todo state dies with its process, and with it every reason to keep
   *  believing the frames still sitting in the log (design-plan-service.md §1).
   *
   *  One writer per session (plan.ts): a plan hand-delivered through the plan MCP tool is not
   *  overwritten by frames, and vice versa — two writers means two plans racing on one card. */
  #ingestPlan(sessionId: string, update: Record<string, unknown>): void {
    const prev = this.#store.getPlan(sessionId);
    if (!acceptsWriteFrom(prev?.source, "acp")) return;
    const items = normalizeItems(update.entries);
    // An EMPTY frame is "no update", never "clear" (design-plan-service §3): Hermes empties its
    // todo list when a task ends, and a client that took that literally would wipe a finished plan
    // off the card at the exact moment the operator wants to look at it — the bug this work started
    // from. Nothing on this wire expresses "forget the plan".
    if (!items.length) return;
    const meta = (update._meta ?? {}) as Record<string, unknown>;
    const plan = this.#store.upsertPlan(sessionId, {
      items,
      // ACP v1 has no remark field; `_meta` is the protocol's own extension slot, so a writer that
      // has one has somewhere to put it. Absent means "say nothing", NOT "clear" — a frame that
      // carries no remark must not wipe the one a previous frame left on the card.
      ...(meta["agentus/explanation"] !== undefined
        ? { explanation: clampExplanation(meta["agentus/explanation"]) }
        : {}),
      source: "acp",
      // A fresh snapshot means the run is moving again: the last turn's terminal stamp no longer
      // describes this one.
      terminal: null,
    });
    this.#emit({ t: "plan", sessionId, plan });
  }

  /** Turn lifecycle closes the plan card (the Studio rule: the agent may never set the
   *  execution state — only the run does). A leftover `in_progress` step is demoted back to
   *  `pending` (nothing runs it anymore) and the card gets an honest terminal line; without
   *  this, a crash or an interrupted turn leaves the card pretending to work forever.
   *  Writes only when the plan still has unfinished steps — a plan the agent closed out itself
   *  (all completed) needs no banner. Idempotent per state. */
  #finalizePlan(sessionId: string, state: "ended" | "interrupted" | "failed"): void {
    const plan = this.#store.getPlan(sessionId);
    if (!plan) return;
    if (plan.terminal === state) return;
    if (!hasUnfinished(plan.items)) return;
    const items = demoteInProgress(plan.items);
    const stored = this.#store.upsertPlan(sessionId, { items, source: plan.source, terminal: state });
    // The OBJECT is the live card's truth; the transcript row is what an ARCHIVE card replays later
    // (it keeps the cockpit-only `_slotPlanTerminal` field the archived card reads).
    const msg = this.#store.appendMessage({
      sessionId, kind: "plan",
      payload: { sessionUpdate: "plan", entries: items, _slotPlanTerminal: state },
      createdAt: Date.now(),
    });
    this.#emit({ t: "plan", sessionId, plan: stored });
    this.#emit({ t: "message", message: msg });
  }

  /** The plan MCP tool's READ side. Only a RUNNING session can be read, and only with the token its
   *  own handshake carried: the token dies with the process that was given it, which is what keeps
   *  the tool scoped to one session rather than "any plan in this cockpit". */
  planForMcp(sessionId: string, token: string):
    | { ok: true; plan: PlanSnapshot | null }
    | { ok: false; error: string } {
    const live = this.#sessions.get(sessionId);
    if (!live) return { ok: false, error: "no such running session" };
    if (!token || token !== live.planToken) return { ok: false, error: "bad plan token" };
    return { ok: true, plan: this.#store.getPlan(sessionId) };
  }

  /** The plan MCP tool's WRITE side — the generic channel for agents that cannot emit plan frames
   *  (design-plan-service §6-B).
   *
   *  Two rules meet here. The token scopes the write to one session. And plan.ts's one-writer rule
   *  decides who owns the card: on a row that renders frames they keep it and this write is refused —
   *  `accepted: false` is a normal ANSWER, not an error, because the caller has to tell the model the
   *  truth (it does not own this list) or the model will keep believing it does. On an MCP-driven row
   *  the tool is the session's ONLY writer, so it takes the card over even when an older build had
   *  written it from frames (`acceptsToolWrite`). */
  writePlanFromMcp(sessionId: string, token: string, input: { items: unknown; explanation?: unknown }):
    | { ok: true; accepted: boolean; reason?: string; plan: PlanSnapshot | null }
    | { ok: false; error: string } {
    const live = this.#sessions.get(sessionId);
    if (!live) return { ok: false, error: "no such running session" };
    if (!token || token !== live.planToken) return { ok: false, error: "bad plan token" };
    const prev = this.#store.getPlan(sessionId);
    const rowRendersFrames = nativePlanSourceOf(this.#specFor(live.info.backend)) !== "none";
    if (!acceptsToolWrite(prev?.source, rowRendersFrames)) {
      return {
        ok: true, accepted: false, plan: prev ?? null,
        reason: `this backend renders the agent's own ACP frames, and this session's plan (source: ${prev?.source}) is theirs, so the tool is ignored`,
      };
    }
    const items = normalizeItems(input.items);
    // Same rule as the frame path: an empty list is not a clear, it is a mistake worth naming.
    if (!items.length) {
      return {
        ok: true, accepted: false, plan: prev ?? null,
        reason: "an empty list is not a plan — send the steps as they stand, or leave the plan alone",
      };
    }
    const plan = this.#store.upsertPlan(sessionId, {
      items,
      ...(input.explanation !== undefined ? { explanation: clampExplanation(input.explanation) } : {}),
      source: "mcp",
      // A write means work is happening again: the previous turn's terminal stamp no longer
      // describes what this plan is doing.
      terminal: null,
    });
    this.#emit({ t: "plan", sessionId, plan });
    return { ok: true, accepted: true, plan };
  }

  /** The plan, handed to an agent that just (re)started, as an ACP `resource` content block: a
   *  stable URI plus the steps still owed. The card is fed by the plan OBJECT, but the AGENT's own
   *  copy died with its process — this block is the only thing that tells it the plan exists
   *  (design-plan-service.md §7). Returns null when there is nothing to hand over: no plan at all,
   *  or one whose steps are all closed (spending context to say "you are done" is worse than
   *  saying nothing). */
  #planReminder(s: LiveSession): unknown | null {
    const plan = this.#store.getPlan(s.info.id);
    if (!plan) return null;
    const open = plan.items.filter((i) => i.status !== "completed" && i.status !== "cancelled");
    if (!open.length) return null;
    const lines = open.map((i) => `- [${i.status}] ${i.content}`).join("\n");
    // How the agent keeps it current depends on which channel it actually has: an agent whose row
    // opted into native frames must use its own todo tool (those frames are what feed the card),
    // while an MCP-driven agent — which is every backend by default, Hermes included — was handed
    // `update_plan` in this very handshake, and its own todo tool does NOT reach the card.
    const mcpDriven = nativePlanSourceOf(this.#specFor(s.info.backend)) === "none";
    const closing = mcpDriven
      ? [
          "Carry on with it, and keep it updated with the `update_plan` tool as you go — that list is",
          "the ONLY one the cockpit shows the operator, so a built-in todo/checklist tool of yours will",
          "not be seen there. Mark a step completed once its work is actually verified, and drop or",
          "cancel what you are no longer doing. If you disagree with an item, change it rather than",
          "quietly skipping it.",
        ]
      : [
          "Carry on with it, and keep it updated with your own plan/todo tool as you go: mark a step",
          "completed only once its work is actually verified, and drop or cancel what you are no",
          "longer doing. If you disagree with an item, change it rather than quietly skipping it.",
        ];
    return {
      type: "resource",
      resource: {
        uri: `agentus://plan/${s.info.id}`,
        mimeType: "text/plain",
        text: [
          "This session has an unfinished plan. It is kept by the cockpit and survives your",
          "restarts; your own in-memory task list does not.",
          "",
          lines,
          "",
          ...closing,
        ].join("\n"),
      },
      // ACP reserves `_meta` for the client: tagging our own blocks is what lets us tell them from
      // the operator's words later (and strip them from anything we echo back).
      _meta: { "agentus/plan-reminder": true },
    };
  }

  async closeSession(sessionId: string): Promise<void> {
    const s = this.#need(sessionId);
    this.#stop(s, "closed");
    this.#emitSessions();
  }

  /** 归档 / 取消归档 — the operator's own STORAGE decision, taken independently of the process.
   *
   *  Archiving a LIVE session stops its process too: 「我把它收起来了」 and 「它还在后台吃内存」
   *  contradict each other, and demanding a close first would make the archive a two-step ritual that
   *  says nothing about intent. Un-archiving only moves the flag — the row lands back in 工作空间 as
   *  a cold slot, and the rail's 「取消归档并恢复」 wakes it with a separate resume (so a restore that
   *  fails to load leaves a visible cold slot rather than an error nobody asked for). */
  async setArchived(id: string, on: boolean): Promise<SessionInfo> {
    const live = this.#sessions.get(id);
    const row = this.#store.getSession(id);
    if (!row) throw new Error(`no such session: ${id}`);
    if (on && live) this.#stop(live, "archived");
    this.#store.setArchived(id, on ? Date.now() : null);
    this.#emitSessions();
    return this.#sessions.get(id)?.info ?? this.#coldInfo(id);
  }

  /** Stop a slot's agent process and record WHY it went away. The row always survives with its
   *  transcript: the transcript is the operator's, the process is ours to reclaim.
   *
   *  `reaped` is its own status on purpose — 「它怎么变冷了」 has three different answers (I closed
   *  it / it crashed / the cockpit reclaimed it for being idle) and a rail that shows one word for
   *  all three teaches the operator to distrust the column. */
  #stop(live: LiveSession, why: "closed" | "archived" | "reaped"): void {
    for (const { resolve, timer } of live.pendingPermissions.values()) {
      clearTimeout(timer);
      resolve({ outcome: { outcome: "cancelled" } });
    }
    live.pendingPermissions.clear();
    live.child?.kill("SIGTERM");
    live.info.status = why === "reaped" ? "reaped" : "closed";
    live.info.pid = null;
    const row = this.#store.getSession(live.info.id);
    if (row) {
      this.#store.upsertSession({
        ...row, status: live.info.status, closedAt: Date.now(), pid: null,
      });
    }
    this.#sessions.delete(live.info.id);
  }

  /** The operator just USED this slot: he opened it, or his page reported it as the one on screen.
   *
   *  Idempotent and cheap — the cockpit reports presence every few seconds, so while a slot is on
   *  screen this is called continuously and the idle clock never runs out under a conversation he
   *  is reading; the moment he switches away it stops, and the slot gets the full threshold from
   *  the last report instead of from its last MESSAGE.
   *
   *  Only the in-memory clock moves. `info.lastAt` stays the store's message time on purpose: it is
   *  what the rail's relative stamps and the "last activity" hint mean, and making it say 刚刚 for a
   *  session nobody has written to would be the UI lying. */
  touch(id: string): void {
    const live = this.#sessions.get(id);
    if (!live || live.info.status === "closed" || live.info.status === "reaped") return;
    live.touchedAt = Date.now();
  }

  /** Reclaim idle slots: stop the agent process of a session nobody has touched for the operator's
   *  threshold. Deliberately NOT an archive — the row stays in 工作空间 wearing `reaped` and a click
   *  brings it back. AionUi ships exactly this switch (设置 → 系统 → 「Agent 空闲超时（分钟）」,
   *  default 5, 1–60) and the guards below are what its changelog had to add after the first version
   *  killed agents that were still working: never touch a slot mid-turn, one waiting on a human, or
   *  one the operator is WATCHING right now (a reply that lands while he reads it must not be killed
   *  under him).
   *
   *  `idleMs()` is read on every tick, so a settings change applies with no restart; 0 = off. */
  startIdleReaper(opts: { idleMs: () => number; watched?: (id: string) => boolean; intervalMs?: number }): () => void {
    const interval = opts.intervalMs ?? 30_000;
    const tick = (): void => {
      const idleMs = opts.idleMs();
      if (!(idleMs > 0)) return;
      const now = Date.now();
      let reaped = 0;
      for (const s of [...this.#sessions.values()]) {
        if (s.busy || s.pendingPermissions.size) continue;
        if (s.info.status === "starting" || s.info.status === "running") continue;
        if (opts.watched?.(s.info.id)) continue;
        // The clock is the LATER of two things: the last MESSAGE this session has (store time, which
        // survives restarts) and the last time the operator actually USED the slot (`touchedAt` — the
        // click that respawned it, or the page reporting it as the one on screen). Reading only the
        // message clock is how a slot he had just opened got reaped a minute later (2026-10-10:
        // 「刚点进去、没发消息、换个会话过一分钟 acp 就被回收」) — the fresh process inherited a
        // days-old stamp, so the very next tick found it over the threshold.
        const lastAt = Math.max(s.touchedAt, s.info.lastAt ?? 0, s.info.createdAt);
        if (now - lastAt < idleMs) continue;
        console.log(
          `[agentus] idle reap: ${s.info.id} (${Math.round((now - lastAt) / 60_000)} min idle, limit ${Math.round(idleMs / 60_000)} min)`,
        );
        this.#stop(s, "reaped");
        reaped += 1;
      }
      // Only speak when something changed: a frame every tick would be noise on the socket (and on
      // the phone's notification path, which observes this same stream).
      if (reaped) this.#emitSessions();
    };
    const timer = setInterval(tick, interval);
    // A server that will not exit because of the reclaim timer is a worse bug than the memory it saves.
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** The list every client needs to be current: the rows PLUS what is already waiting for an
   *  answer. Sent on connect too, which is what makes a refreshed page show a live approval. */
  #emitSessions(): void {
    // ALL THREE buckets, every time. This is the SAME event the HTTP path builds (`sessionsEvent()`
    // in index.ts), and the client replaces its lists wholesale from whatever arrives — so emitting
    // only `sessions` here meant every call site below (a resume, a close, an archive, and the idle
    // reaper) WIPED the operator's cold and archived rows off the rail until the next full event or
    // a reload: 「刷新之后只看得见活着的会话」. `cold()`/`archived()` are this class's own lists —
    // sending them costs nothing and is the only shape the client can safely consume.
    this.#emit({
      t: "sessions",
      sessions: this.list(),
      cold: this.cold(),
      archived: this.archived(),
      pending: this.pendingPermissions(),
    });
  }

  /** Every request currently waiting for an answer, across live sessions. Exists so a page
   *  that connects or REFRESHES can be told what is already waiting: the operator asked to see
   *  the approval card "even after refreshing another page", and an event-only design cannot
   *  deliver that (the events happened before the page existed). */
  pendingPermissions(): PermissionRequestView[] {
    const out: PermissionRequestView[] = [];
    for (const s of this.#sessions.values()) for (const p of s.pendingPermissions.values()) out.push(p.view);
    return out;
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
    if (!pending) {
      // Someone answered a request we no longer hold (our timeout fired, or the agent gave up
      // first). Silently returning false made a click look like a broken button.
      console.log(`[agentus] permission answer dropped for ${sessionId}: request ${requestId} is not pending`);
      return false; // already timed out / resolved / never existed
    }
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
    // ── The replay window ──────────────────────────────────────────────────────────────────────
    // From spawn/resume until this slot's first prompt, the agent is re-sending its own history
    // (`session/load` replays the transcript). Those frames are a RECORD of work that is already in
    // the store — persisting them is not "receiving work", and it is what wrote 1240 rows into the
    // live DB on one restart and pushed every session's clock to 「刚刚」.
    //
    // Dropped only when we DO hold a transcript: a slot whose rows are gone has nothing else to
    // rebuild from, so that replay is the only copy and it is kept.
    const isTextFrame = st === "agent_message_chunk" || st === "agent_thought_chunk";
    const isToolFrame = st === "tool_call" || st === "tool_call_update";
    if (live.replaying && (isTextFrame || isToolFrame) && this.#store.maxSeq(live.info.id) > 0) {
      return;
    }
    let msg: Parameters<Store["appendMessage"]>[0] | null = null;
    switch (st) {
      case "agent_message_chunk":
        msg = { sessionId: live.info.id, kind: "agent", payload: u, createdAt: Date.now() };
        break;
      case "agent_thought_chunk":
        msg = { sessionId: live.info.id, kind: "thought", payload: u, createdAt: Date.now() };
        break;
      case "tool_call": {
        // ONE call = ONE row, wherever the frame came from. The agent re-sends every call it holds
        // whenever it re-attaches (`session/load` on a resume / a restart), and appending those was
        // what put a single call in a transcript 17 times (measured 2026-10-08: 7507 extra rows in
        // the operator's store) and dragged every resumed session's activity clock to 「刚刚」.
        const up = this.#store.appendToolCall({
          sessionId: live.info.id, kind: "tool", payload: u,
          toolCallId: String(u.toolCallId ?? ""), createdAt: Date.now(),
        });
        if (up.isNew) {
          this.#touch(live, up.message.createdAt);
          this.#emit({ t: "message", message: up.message });
        }
        return;
      }
      case "tool_call_update": {
        // upsert into original row (design.md §8-5), never a new bubble
        const up = this.#store.upsertToolMessage(
          live.info.id, String(u.toolCallId ?? ""), u,
        );
        if (up) this.#emit({ t: "message", message: up });
        return;
      }
      case "plan":
        // The AGENT's channel — honoured only for a row that opted into it (see #framesAccepted).
        // For every MCP-driven backend this frame is dropped here: it describes the agent's own
        // process-local todo list, and the card is fed by the plan OBJECT instead, so rendering it
        // would put a list on screen that dies with the next restart.
        if (!this.#framesAccepted(live)) return;
        // Still lands in the transcript (that is what the per-turn archive card replays), while the
        // cockpit's LIVE card is fed by the plan OBJECT below — the one that outlives the process.
        msg = { sessionId: live.info.id, kind: "plan", payload: u, createdAt: Date.now() };
        this.#ingestPlan(live.info.id, u as Record<string, unknown>);
        break;
      case "plan_update": {
        // ACP v2's `plan_update` (still a draft — hence the switch, plan.ts:v2PlanEnabled). A v2
        // agent may carry several plans; the card renders ONE, so the first planId seen is adopted
        // and the rest are deliberately left alone rather than guessed at. The frame is folded back
        // into the v1 shape so the transcript row an ARCHIVED card replays stays a single shape.
        if (!v2PlanEnabled()) return;
        if (!this.#framesAccepted(live)) return; // same rule as the v1 frame above
        const folded = foldPlanUpdate(u);
        if (!folded) return; // a markdown/file plan is not a step list
        if (!live.planId) live.planId = folded.planId;
        else if (folded.planId && folded.planId !== live.planId) return;
        const frame = { sessionUpdate: "plan", entries: folded.entries, _meta: folded.meta };
        msg = { sessionId: live.info.id, kind: "plan", payload: frame, createdAt: Date.now() };
        this.#ingestPlan(live.info.id, frame as Record<string, unknown>);
        break;
      }
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
      // The streaming kinds accumulate into one row per message (see Store.appendTextChunk): a reply
      // is ONE row, not 1259. The client gets the row plus the part that is genuinely new, so a live
      // turn stays a small delta on the wire while the store stays the source of truth.
      if (msg.kind === "agent" || msg.kind === "thought") {
        const r = this.#store.appendTextChunk({ ...msg, kind: msg.kind });
        if (r.delta || r.isNew) {
          // A row that did NOT move is not activity. A re-attach replays blocks we already hold, and
          // touching the clock for those is what made every resumed session read 「刚刚」 at once.
          this.#touch(live, r.message.createdAt);
          // One message = one row, so a row that GREW keeps its seq. A client that deduplicated frames
          // by seq therefore dropped every chunk after the first one (measured: a phone bubble showing
          // "不是" with the rest of the reply nowhere, and the next frame landing in an empty bubble).
          // The frame carries `n` — the block's total length — as its version, and a growth ships ONLY
          // the new part, so a long reply is never re-sent whole on every token.
          const n = textOf(r.message.payload).length;
          this.#emit({
            t: "message",
            message: r.isNew ? r.message : { ...r.message, payload: withText(r.message.payload, r.delta) },
            delta: r.isNew ? undefined : r.delta,
            n,
          });
        }
        return;
      }
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
    const tc = (params.toolCall ?? {}) as PermissionToolCall;
    const view: PermissionRequestView = {
      requestId,
      sessionId: live.info.id,
      toolCallTitle: tc.title ?? "tool call",
      kind: tc.kind ?? "other",
      options: (params.options ?? []) as PermissionRequestView["options"],
      createdAt: Date.now(),
      ...permissionArtifacts(tc),
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
      live.pendingPermissions.set(requestId, { view, resolve, timer });
    });
  }

  #onChildExit(live: LiveSession, code: number | null, sig: string | null): void {
    // If we initiated close, session was already removed — ignore.
    if (!this.#sessions.has(live.info.id)) return;
    // …and if we are REPLACING this slot's process (restart), the exit is the one we asked for: the
    // slot has not failed, it is coming back on a new child.
    if (live.replacing) return;
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
    this.#finalizePlan(live.info.id, "failed"); // the turn died with the process — close the card honestly
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
    this.#emitSessions();
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
      // Deliberately NO plan tool: this fork exists to be asked for a title and then thrown away.
      // Injecting one would spawn a second `agentus-plan` child per title for nothing.
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
    this.#emitSessions();
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
    this.#emitSessions();
    const row = live?.info ?? this.#coldInfo(id);
    return row;
  }

  /** Keep `lastAt` on the session ITSELF, not only on the list projection. A single-session
   *  payload (status change, title update, a rename response) built from `info` used to arrive
   *  without the field, so the client's copy dropped it and that session fell back to creation
   *  order — the rail stopped moving a session up the moment you talked to it. */
  #touch(live: LiveSession, at = Date.now()): void {
    live.info.lastAt = at;
    // …and persist it: `lastAt` on the live object is only the projection the sockets see. The rail
    // is rebuilt from the STORE on every list()/restart, so a clock that only ever lived in memory
    // reset every session to its creation order the moment the process came back.
    this.#store.touchActivity(live.info.id, at);
  }

  /** One cold row, in the same shape list()/cold()/archived() produce. */
  #coldInfo(id: string): SessionInfo {
    const r = this.#store.getSession(id);
    if (!r) throw new Error(`no such session: ${id}`);
    return {
      ...this.#infoFromRow(r),
      // the one difference from the list path: the model's own window, which the resume card prints
      modelContextLimit: this.#store.getModelLimit(((r.models ?? null) as SessionInfo["models"])?.currentModelId ?? null),
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
      // A fork is a real session and keeps the parent's backend, so it gets the same plan channel.
      mcpServers: this.#planMcpServers(this.#specFor(source.info.backend), source),
    })) as { sessionId?: unknown; modes?: SessionModeState | null; configOptions?: ConfigOptionView[] } | null;
    const acpSessionId = res?.sessionId ? String(res.sessionId) : "";
    if (!acpSessionId) throw new Error("the agent did not return a session id for the fork");

    const newId = randomUUID();
    const now = Date.now();
    const forkedOptions = normConfigOptions(res?.configOptions);
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
      // a fork is a NEW conversation: it is nobody's archive (the parent's flag is not inherited)
      archivedAt: null,
      // the agent just told us the fork's modes/options — keep them so the new slot shows
      // the right permission mode and thinking depth before it is even resumed
      modes: res?.modes ?? source.info.modes ?? null,
      configOptions: forkedOptions.length ? forkedOptions : (source.info.configOptions ?? []),
      usage: null,
      commands: source.info.commands ?? [],
      workspace: source.info.workspace ?? null,
    });
    this.#emitSessions();
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

function sessionRow(i: SessionInfo, home: string | null = null) {
  return {
    id: i.id, backend: i.backend, acpSessionId: i.acpSessionId, cwd: i.cwd,
    title: i.title, status: i.status, pid: i.pid, createdAt: i.createdAt, closedAt: null,
    // never written by this upsert (the archive flag has its own statement — see setArchived):
    // carried here only so the row type stays honest.
    archivedAt: i.archivedAt ?? null,
    modes: i.modes ?? null, configOptions: i.configOptions ?? [],
    usage: i.usage ?? null, commands: i.commands ?? [],
    models: i.models ?? null,
    // only ever written by the insert (creation); see Store.upsertSession
    home,
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

/** ACP options arrive with `_meta`; the view exposes it as `meta` and keeps `category`.
 *  Custom option kinds live entirely in there (Hermes marks its context budget
 *  `freeform: true` with a unit/floor/presets), so dropping it would silently strip a
 *  backend's richer control down to a plain dropdown. */
function normConfigOptions(raw: unknown): ConfigOptionView[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === "object")
    .map((o) => {
      const { _meta, ...rest } = o as { _meta?: Record<string, unknown> | null };
      const meta = _meta ?? (o as { meta?: Record<string, unknown> | null }).meta ?? null;
      return { ...rest, meta } as unknown as ConfigOptionView;
    });
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
