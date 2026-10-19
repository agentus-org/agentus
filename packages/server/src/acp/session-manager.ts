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
import { SKILLS_ROOT, installSkills, resolveSkillsDir } from "../skills/install.js";
import { classifyError, checkedHealth, effectiveArgs, handshakeFrom, rowToSpec } from "./registry.js";
import type { BackendHandshake, CheckErrorCode } from "./registry.js";
import {
  cleanAgentTitle, deriveTitle, titleFromLatestPrompt, TITLE_INSTRUCTION,
} from "../title.js";
import type { Store, SessionRow, TitleSrc } from "../store/store.js";
import { textOf, withText } from "../store/store.js";
import type {
  AttachmentSummary,
  BackgroundTask,
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
import { acceptsToolWrite, acceptsWriteFrom, clampExplanation, clampTitle, demoteInProgress, foldPlanUpdate, hasUnfinished, normalizeItems, v2PlanEnabled } from "../plan/plan.js";
import { PLAN_GUIDANCE_ACTIVE, PLAN_GUIDANCE_INTRO, PLAN_GUIDANCE_NATIVE } from "../../../shared/src/index.js";
import { PREFS_DEFAULT, type PlanHintSettings } from "../settings.js";

// The cockpit CLI an agent is handed (issue #15). Resolved from THIS module's location, so it points
// at the same tree the server runs from — a checkout and an installed package alike (`bin/` is in the
// package's `files`).
// The path we hand agents as `AGENTUS_COCKPIT_BIN` is the `agentus` launcher itself — there is no
// second command to install, and `agentus cockpit <command>` is the only spelling anywhere. (The
// implementation is `bin/cockpit.mjs`, but that file is the subcommand, not a product name: agents
// never see it, so it must not become a second thing users have to learn.)
const COCKPIT_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../bin/agentus.mjs");

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

// The built-in wording for the plan hint's GUIDANCE half lives in `shared` (PLAN_GUIDANCE_*), not
// here: the settings page has to SHOW an operator exactly what "leave the box empty" sends, and a
// second prose copy on the web side is a copy that drifts. Read the doc comment there for which
// variant covers which case.

// A title fork is a real model turn over a copy of the conversation: give it room, but never
// let a stuck one hang the operator's click — the caller falls back to the derived name on
// timeout. Env-tunable so a sweep can exercise the timeout path in seconds.
const TITLE_FORK_TIMEOUT_MS = Number(process.env.AGENTUS_TITLE_TIMEOUT_MS || 90_000);

// How long a cancelled turn may take to actually stop before an interrupting prompt gives up
// (an agent that ignores session/cancel must not hang the operator's next sentence forever).
const TURN_SETTLE_TIMEOUT_MS = Number(process.env.AGENTUS_SETTLE_TIMEOUT_MS || 15_000);

/** How long a close/archive waits for a slot's in-flight handshake before killing it anyway.
 *
 *  `#stop` waits because the agent-side session id only exists once the handshake lands, and a row
 *  closed without it can never be resumed (see `#stop`). The wait is bounded so a spawn that never
 *  answers cannot hold the operator's click open forever: past this, the slot closes with whatever it
 *  has — a broken agent is not made worse by a row we cannot wake. */
const CLOSE_STARTUP_WAIT_MS = Number(process.env.AGENTUS_CLOSE_WAIT_MS || 30_000);

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
  /** What the agent says it can do (initialize.agentCapabilities). `fork` gates title
   *  regeneration, `load` gates resume; `image` is the one a TURN can be refused on — see
   *  `IMAGE_UNSUPPORTED` in `prompt()`. */
  caps: { fork: boolean; load: boolean; image: boolean };
  /** Incremented when a turn STARTS. An interrupt waits for the specific turn it cancelled,
   *  so a second interrupting utterance that already started its own turn is not mistaken for
   *  "the one I cancelled is still running". */
  turnSeq: number;
  /** The spawn-time handshake, while it is still running.
   *
   *  `create()` no longer waits for it (that wait is what made 「新建会话」 feel broken), so the slot
   *  exists — and can be closed, archived or reaped — before the agent has answered. This handle is
   *  how the teardown waits for the one thing only the handshake can tell us: the agent-side session
   *  id. Killing the child before it arrives leaves a row with `acpSessionId: null` that `resume()`
   *  refuses forever (「was never handed to an agent」) — see `#stop`. */
  startup?: Promise<void>;
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
  /** Minted per agent process and handed to the CHILD's ENVIRONMENT (issue #15): the cockpit CLI
   *  (`$AGENTUS_COCKPIT_BIN`) reads it, so an agent can look at the rest of the cockpit without ever
   *  touching a port or a token itself. Scoped to this one session, like `planToken` — and dies with
   *  the process that received it, so a copied `ps` line is worth nothing later. */
  cockpitToken: string;
  /** ACP v2 lets a session carry several plans (`planId`); the card renders one. Whichever planId
   *  shows up first is adopted and the rest are left alone — see the `plan_update` case. */
  planId?: string;
  /** One log line per agent process the first time a frame is ignored, so a reader of the log can
   *  tell "the cockpit is dropping these on purpose" from "the agent stopped emitting them". */
  planFramesDropped?: boolean;
  /** Latest background-process snapshot from the agent (issue #22): what is still running once the
   *  turn is over. Transient STATE, never a transcript row — 「2 个后台任务在跑」 is true now and false in
   *  five minutes, and a stored row would hang a dead process under a conversation from last month. */
  background: BackgroundTask[];
  /** Completion sentences that arrived while the turn was BUSY (#22), in order. Held rather than
   *  dropped: the agent is the intended reader, and a completion lost to bad timing means work the
   *  operator has to notice and redo by hand. Drained one at a time at turn-end — each opens its own
   *  turn, and two at once is a race the agent cannot mediate. */
  pendingCompletions: string[];
}

type Emitter = (evt: ServerEvent) => void;

export class SessionManager {
  #sessions = new Map<string, LiveSession>();
  #store: Store;
  #emit: Emitter;
  /** How the operator wants the plan-tool hint injected into a prompt — read on EVERY prompt, like
   *  the idle thresholds, because the requirement is that a change in 设置 applies to the very next
   *  turn with no restart and no session to hibernate. */
  #planHint: () => PlanHintSettings = () => ({ ...PREFS_DEFAULT.planHint });
  /** Whether a finished background process may open a turn by itself (issue #22). A getter, not a
   *  value: the operator's switch must apply to the next completion, with no restart and no session
   *  to hibernate. Default ON — this is the CLI/gateway behaviour, and the whole point is that the
   *  agent takes its own result instead of the operator noticing a stale screen. */
  #completionWake: () => boolean = () => true;

  constructor(store: Store, emit: Emitter) {
    this.#store = store;
    this.#emit = emit;
  }

  /** Wire the operator's 「后台任务完成唤醒」 switch in (index.ts → settings.agent.completionWake). */
  setCompletionWakeSource(fn: () => boolean): void {
    this.#completionWake = typeof fn === "function" ? fn : () => true;
  }

  /** Wire the cockpit's plan-hint setting in. Optional on purpose: with no source wired the
   *  manager behaves exactly as it did before the setting existed (on, 仅首条). */
  setPlanHintSource(read: () => PlanHintSettings): void {
    this.#planHint = read;
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
      // A SYSTEM session (the 工作播报 observer, issue #16) is the cockpit's own machinery: it has a
      // transcript and a process like any other slot, but it is not WORK IN FLIGHT. Filtering here —
      // the one gate the rail, the cockpit CLI and the warm-slot ranking all read through — is what
      // keeps an observer from showing up as a ghost row beside the session it watches.
      .filter((s) => !s.info.system)
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

  /** Wait until a slot can accept a prompt (its handshake finished), or explain why it never will.
   *  `create()` deliberately returns BEFORE the handshake, so a caller that spawns and prompts in the
   *  same breath (the 工作播报 observer, issue #16) has to wait for the one thing only the agent can
   *  tell us. Throws on a slot that died while we waited — silence would leave the observer looking
   *  alive forever. */
  async awaitReady(id: string, timeoutMs = 30_000): Promise<SessionInfo> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const s = this.#sessions.get(id);
      if (!s) throw new Error(`no such session: ${id}`);
      if (s.conn && s.info.acpSessionId) return s.info;
      if (s.info.status === "error" || s.info.status === "closed") {
        throw new Error(`session ${id} is ${s.info.status}${s.info.lastError ? `: ${s.info.lastError}` : ""}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`session ${id} did not become ready within ${Math.round(timeoutMs / 1000)}s`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** The ACP mode state of a live slot, for callers that must not go through the rail's lists
   *  (issue #16's observer picks a read-only mode as soon as the handshake announces one). */
  modesOf(id: string): SessionModeState | null {
    return this.#sessions.get(id)?.info.modes ?? null;
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

  /**
   * Drop every pending approval of one slot, and TELL THE WIRE each one is gone.
   *
   * The client has exactly two ways to take an approval off the screen: the `permission-resolved`
   * event, or a fresh `sessions` snapshot that no longer lists it. A bare `clear()` therefore
   * leaves the popup, the transcript card, the ⚿ badge — and the phone's 待你确认 activity — for a
   * request that does not exist any more; the operator clicks it, the server logs 「answer dropped」
   * and answers `permission-expired`, and he reads his own cockpit as broken (measured 2026-10-11:
   * `kill -9` the child with an approval up and the dialog is still there 4s later). So: every path
   * that resolves these promises from the SERVER side goes through here.
   *
   * The decision is `cancelled` — what the agent would have received had nobody ever answered.
   */
  #dropPending(live: LiveSession, decision: PermissionDecision = { outcome: "cancelled" }): void {
    if (!live.pendingPermissions.size) return;
    for (const [requestId, { resolve, timer }] of live.pendingPermissions) {
      clearTimeout(timer);
      resolve({ outcome: decision });
      this.#emit({ t: "permission-resolved", requestId, decision });
    }
    live.pendingPermissions.clear();
  }

  /** Graceful shutdown: SIGTERM every live child before server exit. */
  async shutdown(): Promise<void> {
    const kills = [...this.#sessions.values()].map(async (s) => {
      this.#dropPending(s);
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

  /** `opts.system` marks a session the COCKPIT is spawning for itself (issue #16's observer). It
   *  is a real ACP session and behaves like one everywhere below (close, idle-reap, resume), but it
   *  is born out of the rail's scope and stays out of it. */
  async create(backend: BackendId, cwd: string, title?: string, opts: { system?: boolean } = {}): Promise<SessionInfo> {
    const shape = this.#spawnShape(backend);
    if (!shape) throw new Error(`unknown backend: ${backend}`);
    const { spec, args } = shape;
    const id = randomUUID().slice(0, 8);
    const now = Date.now();

    // isolation: never let a child inherit its way back into the live runtime home
    const plan = buildSpawnEnv(spec);
    // before the handshake, because the agent resolves its skill roots when the session starts —
    // not later
    plan.env = this.#skillsEnv(spec, plan.env);
    // the cockpit CLI's identity for THIS process (issue #15) — minted before the spawn because it
    // travels in the child's own environment
    const cockpitToken = randomUUID();
    plan.env = this.#cockpitEnv(plan.env, id, cockpitToken);
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
        ...(opts.system ? { system: true } : {}),
        createdAt: now, modes: null, configOptions: [], commands: [],
      },
      child, busy: false, pendingPermissions: new Map(), alwaysAllow: new Set(), stderrBuf: [],
      background: [], pendingCompletions: [],
      caps: { fork: false, load: false, image: false }, turnSeq: 0, collectors: new Map(), planReminderPending: true,
      planToken: randomUUID(),
      cockpitToken,
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

    // The row is complete and already persisted with `status: "starting"` — hand it back to the
    // caller NOW and let the handshake finish OFF the request. See `#startup`.
    // Kept on the slot (not dropped with `void`) so a close during the window can wait for the
    // agent-side id instead of orphaning the session — see `#stop`.
    live.startup = this.#startup(live, backend, spec, cwd, spawnStarted);
    void live.startup.catch(() => {}); // `#startup` reports failure on the slot; nobody is awaiting
    return live.info;
  }

  /** The spawn-time handshake — `initialize` + `newSession` + the row's default permission mode.
   *
   *  Deliberately NOT awaited by `create()`. Holding the HTTP response open for the whole handshake
   *  is what made 「新建会话」 feel broken: hermes boots a python process and answers in 10–40 s, the
   *  page sat on a busy dialog with no progress to show and a 120 s timeout behind it (measured; the
   *  old `state.ts` comment said so in as many words). The row is born `starting` — the rail can
   *  draw it, the page can open it and file the first message — and when this resolves,
   *  `#updateSession` broadcasts `ready`, which is also the signal the client drains that queued
   *  first message on (`state.ts`, `case "session"`).
   *
   *  Failure is reported INSIDE the session, never to a caller that has long since answered: the
   *  status goes `error` with `lastError` (the reason + the agent's stderr tail, delivered while the
   *  slot is still in the live map so the frame carries it), then the slot is dropped and the row is
   *  closed. That is what makes 「启动失败 → 因为什么 → 再试一次」 possible at all. */
  async #startup(live: LiveSession, backend: BackendId, spec: BackendSpec, cwd: string, spawnStarted: number): Promise<void> {
    const id = live.info.id;
    const child = live.child;
    if (!child) return; // the slot was torn down between `create()` returning and this line
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
      live.caps = readCaps(init?.agentCapabilities);
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
    } catch (err) {
      child.kill("SIGKILL");
      live.info.status = "error";
      live.info.lastError = errMessage(err) + stderrTail(live);
      // Announce the failure WHILE the slot is still live: `{t:"session"}` is the only frame that
      // carries `lastError`, and the page needs it to say why nothing came up.
      this.#updateSession(live);
      this.#sessions.delete(id); // failed handshake => don't keep a zombie slot
      this.#store.upsertSession({ ...sessionRow(live.info), closedAt: Date.now() });
      this.#noteBackendCheck(String(backend), {
        ok: false, error: live.info.lastError, errorCode: classifyError(err),
        latencyMs: Date.now() - spawnStarted,
      });
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
    // A resumed slot is a fresh agent process and re-resolves its skill roots, so a release that
    // changed the skill lands here too — not only on first create.
    plan.env = this.#skillsEnv(spec, plan.env);
    // a resumed slot is a NEW process: its cockpit identity is minted here, like create()'s. The old
    // child's token died with the old child.
    const cockpitToken = randomUUID();
    plan.env = this.#cockpitEnv(plan.env, id, cockpitToken);
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
        // a resumed system session is still a system session (issue #16): the observer is reaped and
        // resumed like any slot, and must come back out of the rail's scope, not into it
        ...(row.system ? { system: true } : {}),
        createdAt: row.createdAt,
        modes: (row.modes ?? null) as SessionModeState | null,
        configOptions: (row.configOptions ?? []) as ConfigOptionView[],
        // restored from disk so the gauge + slash palette are there before the agent
        // re-announces them (and stay if the re-announce never comes)
        usage: (row.usage ?? null) as SessionInfo["usage"],
        commands: normCommands(row.commands),
      },
      child, busy: false, pendingPermissions: new Map(), alwaysAllow: new Set(), stderrBuf: [],
      background: [], pendingCompletions: [],
      caps: { fork: false, load: false, image: false }, turnSeq: 0, collectors: new Map(), planReminderPending: true,
      planToken: randomUUID(),
      cockpitToken,
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
      live.caps = readCaps(reloadInit?.agentCapabilities);
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
    this.#dropPending(live);
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
      .filter((r) => r.archivedAt != null && !r.system)
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
      // system rows are the cockpit's own (see list()): never offered as a slot to wake
      .filter((r) => r.archivedAt == null && !r.system && !this.#sessions.has(r.id))
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
      title: r.title, autoTitle: r.autoTitle ?? null, titleBy: r.titleBy ?? null, status: r.status, pid: null,
      createdAt: r.createdAt,
      modes: (r.modes ?? null) as SessionModeState | null,
      configOptions: (r.configOptions ?? []) as ConfigOptionView[],
      usage: (r.usage ?? null) as SessionInfo["usage"],
      commands: normCommands(r.commands),
      lastSeq: this.#store.maxSeq(r.id),
      lastAt: this.#store.lastActivityAt().get(r.id) ?? r.createdAt,
      archivedAt: r.archivedAt ?? null,
      ...(r.system ? { system: true } : {}),
      // no process by construction: this path only ever runs for a row that is not in the map
      cold: true,
    };
  }

  async prompt(
    sessionId: string,
    text: string,
    attachments: PromptAttachment[] = [],
    opts: {
      interrupt?: boolean;
      /**
       * Who SAID this, when it was not the operator at the keyboard — today only the cockpit's
       * cross-session `send`. It rides the stored payload so the page can label the bubble instead of
       * presenting another agent's words as the operator's own (which is what it did before: a user
       * message, no attribution, indistinguishable from something they typed).
       */
      origin?: { sessionId: string; title?: string | null };
      /**
       * Client-generated id of the prompt that is being sent (issue #26). Echoed on the `turn-start`
       * this call causes, so a page can prove its frame landed instead of assuming `ws.send()` did
       * something. Opaque to the server: it comes back unchanged, it is never stored.
       */
      pid?: string;
    } = {},
  ): Promise<void> {
    const s = this.#need(sessionId);
    if (!s.conn || !s.info.acpSessionId) throw new Error("session not ready");
    // An image the agent cannot take is refused HERE, above the floor-taking logic (issue #17):
    // · below it, a busy agent answers "turn already running" and the operator never learns that the
    //   picture is the problem — they retry, the turn ends, and it fails the same way for a new reason;
    // · through it, one of two silent failures: the agent errors on a content block, or drops it and
    //   answers as if nothing was attached.
    // Neither is something the cockpit could explain afterwards, so it is said now, and the running
    // turn is left alone (a refused prompt must never cancel one).
    if (attachments.some((a) => a.kind === "image") && !s.caps.image) throw new Error(IMAGE_UNSUPPORTED);
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
    //
    // It carries a second thing the agent cannot learn on its own: that this session HAS a plan
    // tool. Its own description says "prefer this over any todo tool", but a runtime that keeps MCP
    // tools in a lazy-loaded catalog (Hermes) never shows that text to the model unless the model
    // goes looking — so the plan card stayed empty while the agent kept a todo list only its own
    // process could see. The nudge therefore has to come from the wire; Studio does the same
    // (its `task-plan-runs.ts` appends a template to the latest input every turn).
    //
    // Read per prompt, and only CONSUME the hand-over when it is actually injected: an operator who
    // turns the hint off and later back on gets the plan hand-over then, rather than losing it.
    const hint = this.#planHint();
    if (hint.on) {
      const owed = Boolean(s.planReminderPending);
      s.planReminderPending = false;
      if (owed || hint.everyTurn) {
        const reminder = this.#planReminder(s);
        if (reminder) blocks.push(reminder);
      }
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
    this.#emit({ t: "turn-start", sessionId, trace: this.#turnTrace(s), ...(opts.pid ? { pid: opts.pid } : {}) });
    const msg = this.#store.appendMessage({
      sessionId,
      kind: "user",
      payload: {
        text,
        attachments: summarize(attachments),
        ...(opts.origin ? { origin: { sessionId: opts.origin.sessionId, title: opts.origin.title ?? null } } : {}),
      },
      createdAt: Date.now(),
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
      // A completion that arrived mid-turn was held, not dropped (#22). Hand the first one back now —
      // scheduled rather than awaited so this prompt's own teardown finishes first, and only one at a
      // time because each opens its own turn.
      this.#drainHeldCompletion(s);
    }
  }

  /** Wake the agent for one finished background process, or hold it until the turn ends.
   *
   *  The gateway does exactly this (``_inject_watch_notification``): the completion is *for the agent* —
   *  its own tool text says "you will be notified on exit — do more work instead of waiting" — so the
   *  cockpit's job is to deliver it as a turn, not to decorate a screen. Two refusals are deliberate:
   *  with the operator's switch off we say so in the log and drop it (that is the switch's meaning), and
   *  while a turn is running we hold it, because a prompt would otherwise interrupt work the operator
   *  started. */
  #queueOrWakeCompletion(s: LiveSession, text: string): void {
    if (!text) return;
    if (!this.#completionWake()) {
      console.log(`[agentus] background completion dropped for ${s.info.id}: 唤醒关闭`);
      return;
    }
    if (s.busy) {
      s.pendingCompletions.push(text);
      return;
    }
    void this.#wakeWithCompletion(s, text);
  }

  async #wakeWithCompletion(s: LiveSession, text: string): Promise<void> {
    try {
      // `origin` so the page labels the bubble as a background notice instead of presenting it as
      // something the operator typed — the same mechanism the cockpit's cross-session `send` uses.
      await this.prompt(s.info.id, text, [], { origin: { sessionId: "background", title: "后台任务完成" } });
    } catch (err) {
      // Lost a race for the floor (an operator prompt landed first): keep it for the next turn end
      // instead of throwing away the agent's own result.
      s.pendingCompletions.unshift(text);
      console.log(`[agentus] completion held for ${s.info.id}: ${errMessage(err)}`);
    }
  }

  #drainHeldCompletion(s: LiveSession): void {
    if (!s.pendingCompletions.length || s.busy) return;
    const next = s.pendingCompletions.shift();
    if (!next) return;
    setTimeout(() => void this.#wakeWithCompletion(s, next), 0).unref?.();
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
  /** The cockpit CLI's identity, in the CHILD's environment (issue #15).
   *
   *  Handed over the same way the plan token is — per process, per session, nowhere else — so the
   *  agent never handles a port or a secret: it runs `$AGENTUS_COCKPIT_BIN context` and the CLI reads
   *  these three. Rendering it into a prompt, an `echo`, or a `ps` line is the one thing the CLI's own
   *  `capabilities` forbids, and the token is worth nothing once this process is gone. */
  #cockpitEnv(env: NodeJS.ProcessEnv, sessionId: string, token: string): NodeJS.ProcessEnv {
    return {
      ...env,
      AGENTUS_COCKPIT_ENDPOINT: `http://127.0.0.1:${process.env.AGENTUS_PORT ?? 8788}`,
      AGENTUS_COCKPIT_TOKEN: token,
      AGENTUS_COCKPIT_SESSION: sessionId,
      AGENTUS_COCKPIT_BIN: COCKPIT_BIN,
    };
  }

  /** Hand this package's skills to the agent for THIS process only, when its backend has a channel.
   *
   *  `skillsEnv` (Hermes: `HERMES_EXTERNAL_SKILLS_DIRS`, the per-process half of `skills.external_dirs`)
   *  is a root the agent reads and we never write: `skill_view` resolves our corpus, and not one byte
   *  lands in the operator's home — the same `~/.hermes` that Studio, cron and every terminal `hermes`
   *  share, where a copied skill would surface in sessions that have nothing to do with the cockpit.
   *  A backend without such a variable falls through to `#installSkills`, the only channel it has.
   */
  #skillsEnv(spec: BackendSpec, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    if (!spec.skillsEnv) return env;
    return { ...env, [spec.skillsEnv]: SKILLS_ROOT };
  }

  /**
   * FALLBACK (vendors with no extra-roots channel): copy this package's skills into the agent's own
   * skills directory. Every backend we ship today takes `skillsEnv` instead, so this only runs for a
   * row whose spec names `skillsDir` without one.
   *
   * Failures are WARNINGS, never session failures: a slot whose skill could not be written still runs
   * — it just learns about the CLI from the one-line reminder and `agentus cockpit skill` instead of
   * native discovery. Turning a read-only-to-us directory (a home owned by root, a read-only mount)
   * into a dead slot would be a much worse trade than a missing manual.
   */
  #installSkills(spec: BackendSpec, home: string | null): void {
    if (!spec.skillsDir || !home) return;
    try {
      const r = installSkills(resolveSkillsDir(spec.skillsDir, home));
      if (r.installed.length || r.updated.length) {
        console.log(
          `[agentus] skills → ${r.dir}: ` +
            [...r.installed.map((n) => `${n} (new)`), ...r.updated.map((n) => `${n} (updated)`)].join(", "),
        );
      }
    } catch (err) {
      console.warn(`[agentus] could not install skills into ${spec.skillsDir} (${home}): ${errMessage(err)}`);
    }
  }

  /** Resolve a cockpit-channel token to the session it was minted for (issue #15). One token, one
   *  session: a copied env var reads that session's scope and nothing wider. */
  cockpitCaller(token: string): string | null {
    if (!token) return null;
    for (const s of this.#sessions.values()) if (s.cockpitToken === token) return s.info.id;
    return null;
  }

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
  writePlanFromMcp(sessionId: string, token: string, input: { items: unknown; title?: unknown; explanation?: unknown }):
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
      // `undefined` = keep whatever title is on the card (same rule as the remark): most writes are
      // a status flip and carry no title, and those must not erase the phrase the completion card
      // reads. `null`/empty clears it (clampTitle answers null).
      ...(input.title !== undefined ? { title: clampTitle(input.title) } : {}),
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
   *  (design-plan-service.md §7).
   *
   *  It is also the only thing that tells an agent the tool exists AT ALL — `update_plan`'s own
   *  description says "prefer this over any todo tool", but a runtime that keeps MCP tools in a
   *  lazy-loaded catalog (Hermes) never shows the model that text unless it goes looking first.
   *  Everything here goes out on the wire, every turn when 每回合 is on, exactly like Studio's
   *  `task-plan-runs.ts` (which appends its block to the latest input unconditionally).
   *
   *  The ONE case that says nothing: a plan that exists with every step closed. There is no
   *  introduction worth repeating and no work to hand over — "you are done" costs context and buys
   *  nothing. Note that "no plan yet" is NOT that case: it is the moment the nudge matters most,
   *  because an agent that has not been told the tool exists will reach for its own todo list. */
  #planReminder(s: LiveSession): unknown | null {
    // The operator's own wording, when they wrote one (设置 → 计划提示注入). Read per call, like the
    // switches beside it, so an edit lands on the next turn with no restart. Emptiness is decided
    // HERE rather than only at save time: a value written by an older build (or hand-edited into
    // the DB) must not be able to inject a line of whitespace as if it were guidance.
    const custom = this.#planHint().instruction.trim() || null;
    const plan = this.#store.getPlan(s.info.id);
    const open = plan
      ? plan.items.filter((i) => i.status !== "completed" && i.status !== "cancelled")
      : [];
    if (plan && !open.length) return null;

    // How the agent keeps it current depends on which channel it actually has: an agent whose row
    // opted into native frames must use its own todo tool (those frames are what feed the card),
    // while an MCP-driven agent — which is every backend by default, Hermes included — was handed
    // `update_plan` in this very handshake, and its own todo tool does NOT reach the card.
    const mcpDriven = nativePlanSourceOf(this.#specFor(s.info.backend)) === "none";
    const body: string[] = [];

    if (open.length) {
      body.push(
        "This session has an unfinished plan. It is kept by the cockpit and survives your",
        "restarts; your own in-memory task list does not.",
        "",
        ...open.map((i) => `- [${i.status}] ${i.content}`),
        "",
      );
    }

    if (mcpDriven && open.length) {
      body.push(custom ?? PLAN_GUIDANCE_ACTIVE);
    } else if (mcpDriven) {
      // No plan yet. This is the case the cockpit used to say NOTHING about — which is exactly why
      // an agent reached for its own todo list and the card stayed empty: `update_plan`'s own
      // description ("prefer this over any todo tool") lives on a tool a lazy-loaded MCP catalog
      // never puts in front of the model. Keep it short; it rides on every first prompt.
      body.push(custom ?? PLAN_GUIDANCE_INTRO);
    } else if (open.length) {
      body.push(custom ?? PLAN_GUIDANCE_NATIVE);
    } else {
      // A native-frames backend with nothing to hand over: nothing worth saying.
      return null;
    }

    // The cockpit channel (issue #15) rides the same block: ONE line, because its whole job is to say
    // that a readable panel exists. The contract itself lives on the other end (`capabilities` is
    // self-describing), so nothing here needs to be kept in sync with the CLI.
    body.push(
      "",
      "本驾驶舱可用 `$AGENTUS_COCKPIT_BIN session list`（其它会话状态/消息/计划；先 capabilities，全文 skill）。",
    );

    return {
      type: "resource",
      resource: {
        uri: `agentus://plan/${s.info.id}`,
        mimeType: "text/plain",
        text: body.join("\n"),
      },
      // ACP reserves `_meta` for the client: tagging our own blocks is what lets us tell them from
      // the operator's words later (and strip them from anything we echo back).
      _meta: { "agentus/plan-reminder": true },
    };
  }

  async closeSession(sessionId: string): Promise<void> {
    const s = this.#need(sessionId);
    // Awaited, not fired and forgotten: the row has to be settled (and carry the agent-side id) by the
    // time the DELETE that asked for this answers, or the page loads a slot the store still calls
    // `starting`.
    await this.#stop(s, "closed");
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
    if (on && live) await this.#stop(live, "archived");
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
  async #stop(live: LiveSession, why: "closed" | "archived" | "reaped"): Promise<void> {
    this.#dropPending(live);
    // A slot can be closed while its handshake is still in flight — `create()` no longer waits for it
    // (see there). Killing the child on the spot was WRONG in a way the operator would eventually hit:
    // the agent had already created a session, but the row was written with `acpSessionId: null`, and
    // `resume()` refuses such a row outright (「was never handed to an agent」) — the slot became a
    // transcript nobody could ever wake again. So let the startup land first: it is the only thing that
    // knows the agent-side id, and the child it spawned is the one really there to kill.
    //
    // The slot stays in the live map for the duration, on purpose: the child IS alive and about to be
    // `ready`, and calling it cold while it boots is the mirror-image lie (a cold row that wakes up by
    // itself). The wait is bounded — see `CLOSE_STARTUP_WAIT_MS`.
    if (live.startup && live.info.status === "starting") {
      await Promise.race([
        live.startup.catch(() => {}),
        new Promise<void>((r) => { setTimeout(r, CLOSE_STARTUP_WAIT_MS).unref?.(); }),
      ]);
    }
    // Applied LAST, and only over a non-terminal status: `#startup` writes `ready` when the handshake
    // lands and `error` (with `lastError`) when it fails — and a handshake that failed on its own has a
    // better answer than 「closed」, so it keeps it.
    if (live.info.status !== "error") live.info.status = why === "reaped" ? "reaped" : "closed";
    live.info.pid = null;
    live.child?.kill("SIGTERM");
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

  /** The `n` most recently USED sessions that are not archived — 「热备」, the slots whose process is
   *  kept no matter how quiet they go. Explicitly a FLOOR, not a cap: it names which slots may not be
   *  reclaimed for being idle; it never bounds how many may run.
   *
   *  Ranked over live AND COLD rows by the same clock the sweep uses (`max(touchedAt, lastActivity,
   *  createdAt)`). Ranking only the live ones would leak the meaning: after a reap the seat would fall
   *  to whatever still happens to hold a process, so a session nobody has opened in days could inherit
   *  it and be shielded by the very rule that just fired on his own recent session.
   *
   *  Archived rows never take a seat — 归档 is 「收起来」, its process is meant to go — so the seat
   *  passes to the next most recent one instead of being held by a row he put away. */
  #warmSet(n: number): Set<string> {
    const lastAt = this.#store.lastActivityAt();
    return new Set(
      this.#store
        .listSessions(true)
        .filter((r) => r.archivedAt == null)
        .map((r) => ({
          id: r.id,
          at: Math.max(this.#sessions.get(r.id)?.touchedAt ?? 0, lastAt.get(r.id) ?? 0, r.createdAt),
        }))
        .sort((a, b) => b.at - a.at)
        .slice(0, n)
        .map((r) => r.id),
    );
  }

  /** Reclaim slots: stop the agent process of a session nobody has touched for the operator's
   *  threshold. Deliberately NOT an archive — the row stays in 工作空间 wearing `reaped` and a click
   *  brings it back. AionUi ships exactly this switch (设置 → 系统 → 「Agent 空闲超时（分钟）」,
   *  default 5, 1–60) and the guards below are what its changelog had to add after the first version
   *  killed agents that were still working: never touch a slot mid-turn, one waiting on a human, or
   *  one the operator is WATCHING right now (a reply that lands while he reads it must not be killed
   *  under him).
   *
   *  TWO deadlines, and the difference is the whole point (2026-10-10): `idleMs` is the operator's
   *  answer to 「空闲多久收掉」 for the sessions he is NOT working in, while the 热备 set (`warmSlots`,
   *  the most recently used ones) is exempt from it — 「即使空闲也保留在那里」 — and only obeys its own
   *  much longer `warmTtlMs`. A single time rule was what made 「我只是离开浏览器」 cost him the agent
   *  of the session he had been in a minute earlier.
   *
   *  Every callback is read on EVERY tick, so a settings change applies with no restart (a restart
   *  would kill exactly the slots this feature exists to keep alive cheaply); 0 = off for `idleMs`,
   *  0 = 不过期 for `warmTtlMs`. */
  startIdleReaper(opts: {
    idleMs: () => number;
    /** How many of the most recent sessions are 热备 — exempt from `idleMs`. Read per tick, like the
     *  threshold itself: changing it in 设置 must apply without a restart (a restart would kill
     *  exactly the slots this feature exists to keep alive cheaply). */
    warmSlots: () => number;
    /** How long a warm slot may stay untouched before even its exemption expires; 0 = 不过期.
     *  Read per tick too, and it is a SEPARATE deadline from `idleMs` (hours, not minutes). */
    warmTtlMs: () => number;
    watched?: (id: string) => boolean;
    intervalMs?: number;
  }): () => void {
    const interval = opts.intervalMs ?? 30_000;
    /** Two decimals where it matters: a QA run drives these thresholds in SECONDS, and 「0 min」 on
     *  both sides of the message is a log line that cannot be read. */
    const fmt = (ms: number): string =>
      ms < 3_600_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 3_600_000).toFixed(1)} h`;
    const tick = (): void => {
      const idleMs = opts.idleMs();
      const warmTtlMs = opts.warmTtlMs();
      // Either rule alone is a reason to sweep (idle off + a warm TTL still expires warm slots).
      if (!(idleMs > 0) && !(warmTtlMs > 0)) return;
      const warmN = opts.warmSlots();
      const warm = warmN > 0 ? this.#warmSet(warmN) : null;
      const now = Date.now();
      let reaped = 0;
      for (const s of [...this.#sessions.values()]) {
        if (s.busy || s.pendingPermissions.size) continue;
        if (s.info.status === "starting" || s.info.status === "running") continue;
        if (opts.watched?.(s.info.id)) continue;
        // A session whose agent still OWNS A RUNNING BACKGROUND PROCESS is not idle, whatever the clock
        // says. Reaping it would SIGTERM the only process that can report that result (`#stop` kills the
        // agent, not the process group), so the child would be left orphaned and unread — the exact
        // silent failure #22 exists to remove: 「会话看起来结束了，活儿其实还在跑」. Reported by the
        // operator as a question (2026-10-18: 「有后台进程的话，它还会被空闲回收吗？」) — it could.
        // It is still bounded: only the long warm deadline (`warmTtlMs`) may reclaim it, so a runaway
        // process cannot pin a slot forever.
        const hasBackground = s.background.some((t) => t.status === "running");
        // The clock is the LATER of two things: the last MESSAGE this session has (store time, which
        // survives restarts) and the last time the operator actually USED the slot (`touchedAt` — the
        // click that respawned it, or the page reporting it as the one on screen). Reading only the
        // message clock is how a slot he had just opened got reaped a minute later (2026-10-10:
        // 「刚点进去、没发消息、换个会话过一分钟 acp 就被回收」) — the fresh process inherited a
        // days-old stamp, so the very next tick found it over the threshold.
        const lastAt = Math.max(s.touchedAt, s.info.lastAt ?? 0, s.info.createdAt);
        const age = now - lastAt;
        if (warm?.has(s.info.id)) {
          // 热备 = 「即使空闲也保留在这里」. The idle rule does not apply; only its own, much longer
          // deadline does — otherwise five quiet slots are a permanent ~700 MB floor.
          if (!(warmTtlMs > 0) || age < warmTtlMs) continue;
          console.log(
            `[agentus] warm slot expired: ${s.info.id} (${fmt(age)} untouched, warm ttl ${fmt(warmTtlMs)})`,
          );
        } else if (hasBackground) {
          // Idle time is not the whole question: the agent still OWNS a running child, so the short
          // clock does not apply — only the long deadline can reclaim it.
          if (!(warmTtlMs > 0) || age < warmTtlMs) continue;
          console.log(
            `[agentus] idle reap: ${s.info.id} (background task still running after ${fmt(age)}, hard limit ${fmt(warmTtlMs)})`,
          );
        } else {
          if (!(idleMs > 0) || age < idleMs) continue;
          console.log(
            `[agentus] idle reap: ${s.info.id} (${Math.round(age / 60_000)} min idle, limit ${Math.round(idleMs / 60_000)} min)`,
          );
        }
        // Fire and forget: the reaper skips `starting` slots, so there is no in-flight handshake to
        // wait for here and nothing downstream needs the row settled in this tick.
        void this.#stop(s, "reaped");
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
  /** Every live session's current background snapshot (issue #22), for a page that connects AFTER the
   *  frame that carried it.
   *
   *  EMPTY ONES ARE INCLUDED (`tasks: []`), and that is not noise: the page clears a row when a session
   *  is absent from this list AND treats a present-but-empty one as 「nothing running」. Omitting empties
   *  made the two cases indistinguishable — every `sessions` frame (which is emitted for unrelated
   *  reasons, e.g. a title change) then wiped a row the page had just drawn from a `background` frame.
   *  An explicit `[]` is the same discipline the three rail buckets use. */
  backgroundSnapshots(): { sessionId: string; tasks: BackgroundTask[] }[] {
    return [...this.#sessions.values()].map((s) => ({ sessionId: s.info.id, tasks: s.background }));
  }

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
      background: this.backgroundSnapshots(),
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
    // A status line from the agent (issue #18). Hermes sends these on ACP as an EMPTY thought chunk
    // whose `_meta.hermes` carries the sentence — the protocol has no status object, and `_meta` is the
    // extension door it does leave open. Honoured here rather than in the web, because the decision that
    // matters is 「do not persist」: a recall count belongs to the turn that is running, and writing it
    // into the transcript would put 「recalled 8 memories」 above a conversation from last month.
    // Background work (issue #22): the same `_meta.hermes` door as the status line carries two more
    // kinds. `background` is the agent's running snapshot — STATE, replaced wholesale, shown only while
    // the turn is over and work continues; `completion` is a finished process asking to be read, which
    // the agent must get as a TURN (ACP has no server->agent wake, so the prompt is the wake). Anything
    // else is still ignored silently, which is what lets the fork and this server ship independently.
    const bgTasks = backgroundTasksOf(u);
    if (bgTasks) {
      live.background = bgTasks;
      this.#emit({ t: "background", sessionId: live.info.id, tasks: bgTasks });
      return;
    }
    const finishedText = completionTextOf(u);
    if (finishedText) {
      this.#queueOrWakeCompletion(live, finishedText);
      return;
    }
    // Project skills the agent is NOT loading (fork: `_meta.hermes = {kind:"project_skills"}`).
    // The same door, one more kind. It rides the live status channel on purpose: the sentence is
    // about THIS open, and persisting it would put 「这个仓库有 N 个 skill 未启用」 above a
    // conversation from last month — the very thing the status path already refuses to store.
    const projectSkills = projectSkillsNoticeOf(u);
    if (projectSkills) {
      this.#emit({
        t: "status",
        sessionId: live.info.id,
        text: projectSkills.text,
        statusKind: "project-skills",
      });
      return;
    }
    const statusText = statusLineOf(u);
    if (statusText) {
      const statusKind = statusKindOf(u);
      const category = noteCategoryOf(statusText, statusKind);
      if (category) {
        // 落库（操作者 2026-10-18 选的 A 档）：刷新页面、重连、换设备之后，这行还在。
        // 折叠在 store 里做（见 Store.appendNote），因为「压缩开始 → 心跳 → 完成」和每回合的
        // 一次回忆都必须收敛成一行 —— 客户端折只治屏幕噪音，库里照样长心跳。
        const row = this.#store.appendNote(live.info.id, { category, text: statusText });
        this.#emit({ t: "message", message: row });
      } else {
        // 剩下的（provider 等待的倒计时、租约闲聊）本来就是一秒就作废的呼吸声：只走 live 通道。
        this.#emit({ t: "status", sessionId: live.info.id, text: statusText, statusKind });
      }
      return;
    }
    let msg: Parameters<Store["appendMessage"]>[0] | null = null;
    switch (st) {
      case "agent_message_chunk":
        msg = { sessionId: live.info.id, kind: "agent", payload: u, createdAt: Date.now() };
        break;
      case "agent_thought_chunk":
        // An EMPTY thought is not a thought. A status carrier we cannot read (its `_meta` lost on the
        // way out, an agent using a carrier we do not know) lands here as "" — persisting it drew a
        // 「思考 0 字」 bubble that never filled, and a row in the store that says the agent thought
        // nothing. The honest degradation for an unknown extension is to render NOTHING (that is what
        // hermes' own carrier docstring promises a client), so the frame is dropped rather than stored.
        if (!textOf(u).trim()) return;
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
        // ONE name per session. Hermes re-generates a title on every turn (auxiliary `title_generation`
        // in `agent/turn_context.py`), and this frame is how it arrives — subscribing to all of them was
        // the churn: the rail kept renaming a conversation the operator was reading.
        if (t) this.#applyAutoTitle(live.info.id, t, false, "agent");
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
    this.#dropPending(live);
    live.busy = false;
    // The child that owned those background processes is gone with it; leaving the rows would draw
    // 「1 个后台任务在跑」 under a session whose agent is dead (#22).
    if (live.background.length) {
      live.background = [];
      this.#emit({ t: "background", sessionId: live.info.id, tasks: [] });
    }
    live.pendingCompletions = [];
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
    // A system session never appears in a `session` frame: the rail would add it to a bucket that
    // list()/cold() deliberately do not contain, and #13 is precisely the bug where the two
    // disagree. The page learns about observers through `speak` lines, not through the rail.
    if (!s.info.system) this.#emit({ t: "session", session: s.info });
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

  /** The cockpit CLI's read view (issue #15): the sessions the OPERATOR can see, in one list —
   *  live and cold, never 已归档 (that is the operator's shelf, not work in flight).
   *
   *  Cold rows are capped by `cold()`'s own page size on purpose: an agent asking "what is going on"
   *  gets the recent cockpit, not a scrollback of every session this install ever made. */
  cockpitRows(): SessionInfo[] {
    return [...this.list(), ...this.cold(50)];
  }

  /** Approvals a session is WAITING on right now — the one fact worth waking another agent for. */
  pendingFor(sessionId: string): PermissionRequestView[] {
    // The map holds `{view, resolve, timer}`; only the VIEW is safe to hand out (the other two are
    // the waiter itself).
    return [...(this.#sessions.get(sessionId)?.pendingPermissions.values() ?? [])].map((p) => p.view);
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
  rename(id: string, title: string | null, by: string | null = null): SessionInfo {
    const clean = title == null ? null : title.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, 120).trim();
    // A cleared name has no author: after `--auto` the session carries the GENERATED title again, so
    // keeping "an agent named this" would describe a name that no longer exists.
    const attributed = clean && clean.length && by ? by : null;
    if (!this.#store.renameSession(id, clean && clean.length ? clean : null, attributed)) {
      throw new Error(`no such session: ${id}`);
    }
    const live = this.#sessions.get(id);
    if (live) {
      live.info.title = this.#store.getSession(id)?.title ?? live.info.title;
      live.info.titleBy = attributed;
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
      title: row.title, titleBy: row.titleBy ?? null, status: row.status, pid: null, createdAt: row.createdAt,
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
    this.#applyAutoTitle(s.info.id, t, false, "derived");
  }

  /** Write a generated title and tell everyone who renders a row about it.
   *
   *  `src` is the provenance the store ranks on (derived < agent < operator): a name only moves the
   *  row when it comes from a better source, which is what keeps Hermes' per-turn regeneration from
   *  renaming a running conversation. */
  #applyAutoTitle(id: string, title: string, force: boolean, src: TitleSrc = "agent"): SessionRow | null {
    const row = this.#store.setAutoTitle(id, title, { force, src });
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
    if (!this.#applyAutoTitle(id, title, true, via)) throw new Error(`no such session: ${id}`);
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
/** What a turn must say when the agent cannot take a picture (issue #17).
 *
 *  Kept as a module constant because TWO places have to agree on it: `prompt()` throws it, and the
 *  server turns it into "your sentence comes back" just like `turn already running`. A second
 *  literal would drift the moment one side is reworded. */
export const IMAGE_UNSUPPORTED =
  "这个后端不支持图片输入（agent 没在 initialize 里声明 promptCapabilities.image）—— 去掉图片再发，或换一个能看图的模型";

/** Read the three capabilities this cockpit acts on. Defensive on purpose: `promptCapabilities`
 *  is absent on agents that predate it, and an absent field means "no", not "try anyway" — a
 *  silently dropped image is the failure this whole read exists to prevent. */
function readCaps(capabilities: unknown): { fork: boolean; load: boolean; image: boolean } {
  const c = (capabilities ?? {}) as {
    loadSession?: boolean;
    sessionCapabilities?: { fork?: unknown };
    promptCapabilities?: { image?: unknown };
  };
  return {
    fork: Boolean(c.sessionCapabilities?.fork),
    load: Boolean(c.loadSession),
    image: c.promptCapabilities?.image === true,
  };
}

/** The sentence inside a status carrier, or null when the frame is an ordinary thought chunk.
 *
 *  Shape (hermes `acp_adapter/events.py:make_status_cb`): `agent_thought_chunk` with an empty content
 *  block and `_meta.hermes = { kind: "status", statusKind, text }`. Read defensively — `_meta` is the
 *  one part of an ACP frame a client may see from agents we have never run.
 */
function statusLineOf(u: Record<string, unknown>): string | null {
  const meta = u?._meta as { hermes?: { kind?: unknown; text?: unknown } } | undefined;
  const h = meta?.hermes;
  if (!h || h.kind !== "status") return null;
  const text = typeof h.text === "string" ? h.text.trim() : "";
  return text || null;
}

/** The hermes extension kind on this frame, or null for an ordinary ACP update.
 *
 *  One reader for every kind, so adding one (completion/background, #22) does not mean another
 *  defensive `_meta` walk — and so an unknown kind is still ignored SILENTLY, which is what lets the
 *  fork and the server ship independently.
 */
function hermesKindOf(u: Record<string, unknown>): string | null {
  const meta = u?._meta as { hermes?: { kind?: unknown } } | undefined;
  const kind = meta?.hermes?.kind;
  return typeof kind === "string" && kind ? kind : null;
}

function hermesPayload(u: Record<string, unknown>): Record<string, unknown> {
  const meta = u?._meta as { hermes?: Record<string, unknown> } | undefined;
  return meta?.hermes ?? {};
}

/** Untrusted project skills the agent reported at session open, or null.
 *
 *  Shape (fork `acp_adapter/server.py::_notify_project_skills`): empty thought chunk with
 *  `_meta.hermes = {kind:"project_skills", state:"untrusted", root, skillCount, text}`. The agent
 *  sends it only when the repo actually carries skills AND nobody has decided yet — so a plain
 *  checkout never produces one, and an unknown kind is still ignored silently (that is what lets
 *  the two repositories ship independently).
 */
function projectSkillsNoticeOf(
  u: Record<string, unknown>,
): { text: string; root: string; count: number } | null {
  if (hermesKindOf(u) !== "project_skills") return null;
  const payload = hermesPayload(u);
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) return null;
  return {
    text,
    root: typeof payload.root === "string" ? payload.root : "",
    count: typeof payload.skillCount === "number" ? payload.skillCount : 0,
  };
}

/** The completion sentence a finished background process produced (#22), or null. */
function completionTextOf(u: Record<string, unknown>): string | null {
  if (hermesKindOf(u) !== "completion") return null;
  const text = hermesPayload(u).text;
  return typeof text === "string" ? text.trim() : null;
}

/** The agent's running-process snapshot (#22). Dropped (not defaulted) when `tasks` is not an array:
 *  a malformed frame must never blank a row the operator is reading. */
function backgroundTasksOf(u: Record<string, unknown>): BackgroundTask[] | null {
  if (hermesKindOf(u) !== "background") return null;
  const raw = hermesPayload(u).tasks;
  if (!Array.isArray(raw)) return null;
  const out: BackgroundTask[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const r = t as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : "";
    if (!id) continue;
    const status = r.status === "exited" ? "exited" : "running";
    out.push({
      id,
      command: typeof r.command === "string" ? r.command : "",
      pid: typeof r.pid === "number" ? r.pid : null,
      status,
      uptimeSeconds: typeof r.uptimeSeconds === "number" ? r.uptimeSeconds : undefined,
      exitCode: typeof r.exitCode === "number" ? r.exitCode : null,
    });
  }
  return out;
}

function statusKindOf(u: Record<string, unknown>): string | undefined {
  const meta = u?._meta as { hermes?: { statusKind?: unknown } } | undefined;
  const kind = meta?.hermes?.statusKind;
  return typeof kind === "string" && kind ? kind : undefined;
}

/** 哪些状态行值得留档（操作者 2026-10-18 选的是 A 档）。
 *
 *  Hermes 发来的「状态行」是一根混在一起的管子：`status_output.py:102` 把所有东西都标成
 *  `lifecycle`，只有警告是 `warn`。所以分类只能看**文本**，而这些字符串是从 fork 里抄来的
 *  真实文案（`conversation_compression.py` 的 `🗜️ Compacting context` / `✓ Context compaction
 *  complete` / `📦 Pre-API compression:`，`memory_manager.describe_recall` 的 `recalled N memories`）：
 *
 *   · memory     —— 「这一轮记忆召回了什么」，每回合都会发生，事后有意义；
 *   · compaction —— 「上下文压过」，一行就够（记住它压缩过，不需要记住它压了 12 次心跳）；
 *   · warn       —— 稀有，且几乎总是"要人看一眼"的东西。
 *
 *  provider 等待（`⏳ waiting on … 15s waiting for the first stream chunk`，十来秒一条倒计时）和
 *  「Session is free; loading the latest transcript...」这类租约闲聊返回 null：它们描述的是"此刻
 *  网络的呼吸"，一秒后就作废，落库只会把会话记录变成心跳日志。 */
export function noteCategoryOf(text: string, statusKind?: string): "memory" | "compaction" | "warn" | null {
  if (statusKind === "warn") return "warn";
  if (/Compacting context|Context compaction complete|compression:|compacting ~/i.test(text)) return "compaction";
  if (/recalled (?:relevant memory|1 memory|\d+ memories)/i.test(text)) return "memory";
  return null;
}

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
    system: Boolean(i.system),
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
