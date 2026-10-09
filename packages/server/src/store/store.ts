// SQLite persistence via node:sqlite (Node >=22.5, zero deps).
// Design: sessions row carries `pid` (orphan-reclaim anchor, AC5);
// messages carry monotonic per-session `seq` (reconnect replay anchor, AC6).
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { BackendId, PlanSnapshot, SessionStatus, StoredMessage } from "../../../shared/src/index.js";
import type { BackendHandshake, BackendHealth, BackendKind, BackendRow } from "../acp/registry.js";
import { normalizeItems } from "../plan/plan.js";
import { DEFAULT_NATIVE_PLAN_SOURCE } from "../acp/backends.js";

/** Text that is genuinely NEW in `incoming`, given what we already accumulated.
 *
 *  Borrowed from hermes-studio (`agent-runner/coding-agent-run-manager.appendedTextDelta`), which
 *  hit the same upstream behaviour: the agent re-sends text it has already sent — a full snapshot of
 *  the message so far, or a re-emission of an earlier message as one block — so a naive append both
 *  duplicates content and splits one message into several rows.
 *
 *   · `next` starts with `existing`      → a snapshot: the new part is the tail
 *   · `next` overlaps `existing`'s end   → drop the overlap (≥16 chars, so a coincidence is not one)
 *   · otherwise                          → a genuine delta
 */
function appendedTextDelta(existing: string, next: string): string {
  if (!existing || !next) return next;
  if (next.startsWith(existing)) return next.slice(existing.length);
  const max = Math.min(existing.length, next.length);
  for (let length = max; length >= 16; length--) {
    if (existing.endsWith(next.slice(0, length))) return next.slice(length);
  }
  return next;
}

/** All whitespace removed: the agent's re-emissions differ from our accumulation by formatting only
 *  (a leading blank line, a trailing space), so containment has to be tested on the content. */
function normalizeText(s: string): string {
  return s.replace(/\s+/g, "");
}

/** Below this, an id-less frame is a fragment, not a re-sent message — see `reemissionTarget`. */
const ANON_MIN = 24;
/** …and it has to cover this much of the block it matches, or it is a coincidence, not a re-send. */
const ANON_COVER = 0.6;
/** How far back an anonymous re-emission is looked for. */
const ANON_SCAN_ROWS = 80;

/**
 * Is `incoming` the same block as `blockText` rather than new content?
 *
 * Both directions matter: the agent re-sends an earlier message untouched (the incoming is contained
 * in what we hold) and sometimes re-sends it with a little more text (it contains what we hold). A
 * SHORT id-less frame is never folded — "好的" arriving twice is two messages, and it would otherwise
 * match every long block that happens to contain it.
 */
function reemissionTarget(blockText: string, incoming: string): "same" | "grew" | null {
  const a = normalizeText(blockText);
  const b = normalizeText(incoming);
  if (b.length < ANON_MIN) return null;
  if (a === b) return "same";
  if (a.includes(b) && b.length >= ANON_COVER * a.length) return "same";
  if (b.includes(a) && a.length >= ANON_COVER * b.length) return "grew";
  return null;
}
/** A page also stops on bytes, so one 30 KB message cannot overflow a phone-sized fetch. */
const PAGE_BYTES = 256 * 1024;

export interface SessionRow {
  id: string;
  backend: BackendId;
  acpSessionId: string | null;
  cwd: string;
  title: string;
  /** the generated name, kept aside so a rename is reversible and an automatic title can
   *  never stomp the operator's own (see the interface comment in @agentus/shared) */
  autoTitle?: string | null;
  status: SessionStatus;
  pid: number | null;
  createdAt: number;
  closedAt: number | null;
  /** JSON round-trip of the ACP mode state + config options, so a resumed
   *  session (M4-lite) comes back with the operator's mode/effort intact. */
  modes?: unknown;
  configOptions?: unknown;
  /** context-usage gauge + advertised slash commands, persisted so a reload or a
   *  cold-slot resume shows the same picture (AionUi F-DISPLAY-07/10). */
  usage?: unknown;
  commands?: unknown;
  /** Models the agent advertised (JSON) + the operator's context-window override. */
  models?: unknown;
  contextLimit?: number | null;
  /** The directory the cockpit works in for this slot: the file/terminal panel's
   *  root, and the cwd a cold slot is resumed with. Deliberately separate from
   *  `cwd` — a live ACP child cannot be re-cd'd (its cwd was fixed at newSession),
   *  so re-pointing a *running* slot changes the panels and the next resume, not
   *  the process. hermes-studio draws the same line (session.workspace).
   *  Empty/undefined = "same as cwd". */
  workspace?: string | null;
  /** The agent HOME (HERMES_HOME) this session's agent-side state lives in — resolved at spawn
   *  and written ONCE, at creation. It is what makes "can this cold slot come back?" answerable:
   *  the agent looks its session up in whatever home it is given NOW, so a row whose home has
   *  changed (or a session made under a home that is gone) can never be restored. Measured
   *  2026-10-06: `session/load` answered nothing, `session/prompt` answered `refusal`, and the
   *  slot sat there saying "ready" while every message vanished without a trace. */
  home?: string | null;
}

interface RawSessionRow {
  id: string; backend: BackendId; acp_session_id: string | null; cwd: string;
  title: string; auto_title?: string | null; status: SessionStatus; pid: number | null;
  created_at: number; closed_at: number | null;
  modes?: string | null; config_options?: string | null;
  usage?: string | null; commands?: string | null;
  workspace?: string | null;
  home?: string | null;
  models?: string | null; context_limit?: number | null;
}

function parseJson(v: string | null | undefined): unknown {
  if (v == null || v === "") return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

/** One row of `messages`, as it comes back from SQLite. */
interface RawMessageRow {
  seq: number; session_id: string; kind: StoredMessage["kind"];
  payload: string; tool_call_id: string | null; block_key?: string | null; created_at: number;
}

function rowToMessage(r: RawMessageRow): StoredMessage {
  return {
    seq: r.seq,
    sessionId: r.session_id,
    kind: r.kind,
    payload: parseJson(r.payload),
    toolCallId: r.tool_call_id ?? undefined,
    createdAt: r.created_at,
  };
}

/** The streamed text inside an `agent`/`thought` payload (ACP: `content.text`). */
export function textOf(payload: unknown): string {
  const c = (payload as { content?: unknown } | null)?.content;
  if (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string") {
    return (c as { text: string }).text;
  }
  // some frames put the text at the top level
  const t = (payload as { text?: unknown } | null)?.text;
  return typeof t === "string" ? t : "";
}

/** Same payload with the streamed text replaced (everything else preserved). */
export function withText(payload: unknown, text: string): unknown {
  const p = (payload ?? {}) as Record<string, unknown>;
  const c = p.content;
  if (c && typeof c === "object") return { ...p, content: { ...(c as object), text } };
  return { ...p, content: { type: "text", text } };
}

/** The identity of one logical message: `kind:messageId`. Absent when the agent sent no id (its
 *  history recaps arrive that way) — those are folded by content instead (see `#rowContaining`). */
function blockKeyOf(kind: string, payload: unknown): string | null {
  const mid = (payload as { messageId?: unknown } | null)?.messageId;
  return typeof mid === "string" && mid ? `${kind}:${mid}` : null;
}

function rowToSession(r: RawSessionRow): SessionRow {
  return {
    id: r.id, backend: r.backend, acpSessionId: r.acp_session_id, cwd: r.cwd,
    title: r.title, autoTitle: r.auto_title ?? null, status: r.status, pid: r.pid,
    createdAt: r.created_at, closedAt: r.closed_at,
    modes: parseJson(r.modes), configOptions: parseJson(r.config_options) ?? [],
    usage: parseJson(r.usage), commands: parseJson(r.commands) ?? [],
    workspace: r.workspace ?? null,
    home: r.home ?? null,
    models: parseJson(r.models),
    contextLimit: r.context_limit ?? null,
  };
}

interface RawBackendRow {
  id: string; label: string; kind: string; cmd: string; args: string; env: string;
  home: string | null; profile: string | null; cwd: string | null; notes: string;
  default_mode: string | null;
  native_plan_source: string | null;
  builtin: number; created_at: number; updated_at: number;
  // health snapshot (M6.1) — system-written, see registry.BackendHealth
  last_check_status: string | null; last_check_kind: string | null;
  last_check_error_code: string | null; last_check_error_message: string | null;
  last_check_guidance: string | null; last_check_latency_ms: number | null;
  last_check_at: number | null; last_success_at: number | null; last_failure_at: number | null;
  // cached ACP handshake (M6.1) — what the agent advertised the last time a slot started
  handshake: string | null; handshake_at: number | null;
}

function rowToBackend(r: RawBackendRow): BackendRow {
  return {
    id: r.id,
    label: r.label,
    kind: r.kind as BackendKind,
    // A row predating this column (or one written by an older build) says nothing, so it follows the
    // same default as every other backend: MCP-driven. Deriving it from the kind here would smuggle
    // the old "Hermes is special" rule back in behind the registry — a NULL row would report `acp`
    // while the intent (and every freshly seeded row) says `none`, i.e. the flip would silently not
    // apply to exactly the rows an upgrade leaves behind.
    nativePlanSource: r.native_plan_source === "none" || r.native_plan_source === "acp"
      ? r.native_plan_source
      : DEFAULT_NATIVE_PLAN_SOURCE,
    cmd: r.cmd,
    args: (parseJson(r.args) as string[] | null) ?? [],
    env: (parseJson(r.env) as Record<string, string> | null) ?? {},
    home: r.home ?? null,
    profile: r.profile ?? null,
    cwd: r.cwd ?? null,
    // A row predating the column (or a seeded one) says nothing: send no mode at all, so the agent
    // keeps its own default. No mode name is invented here — "缺省" must mean "不上手".
    defaultMode: (r.default_mode ?? "").trim() || null,
    notes: r.notes ?? "",
    builtin: r.builtin === 1,
    health: {
      status: (r.last_check_status as BackendHealth["status"] | null) ?? "unchecked",
      kind: (r.last_check_kind as BackendHealth["kind"]) ?? null,
      errorCode: (r.last_check_error_code as BackendHealth["errorCode"]) ?? null,
      message: r.last_check_error_message ?? null,
      guidance: r.last_check_guidance ?? null,
      latencyMs: r.last_check_latency_ms ?? null,
      at: r.last_check_at ?? null,
      lastSuccessAt: r.last_success_at ?? null,
      lastFailureAt: r.last_failure_at ?? null,
    },
    handshake: (parseJson(r.handshake) as BackendRow["handshake"]) ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface RawPlanRow {
  session_id: string;
  revision: number;
  items: string;
  explanation: string | null;
  source: string;
  terminal: string | null;
  updated_at: number;
}

/** What a plan write carries. `explanation: undefined` means "keep the remark that is there"
 *  (only an agent writes one, and most plan updates carry none) — see `upsertPlan`. */
export interface PlanPatch {
  items: unknown;
  explanation?: string | null;
  source: PlanSnapshot["source"];
  terminal?: string | null;
}

function rowToPlan(r: RawPlanRow): PlanSnapshot {
  return {
    sessionId: r.session_id,
    revision: r.revision,
    items: normalizeItems(parseJson(r.items)),
    explanation: r.explanation,
    source: r.source === "acp" || r.source === "mcp" ? r.source : "server",
    terminal: r.terminal,
    updatedAt: r.updated_at,
  };
}

export class Store {
  #db: DatabaseSync;
  /** Kept for the one-time fold's backup file (see #foldStreamedChunks). */
  #path: string;

  constructor(path: string) {
    this.#path = path;
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      pragma journal_mode = wal;
      create table if not exists sessions (
        id text primary key, backend text not null, acp_session_id text,
        cwd text not null, title text not null, status text not null,
        pid integer, created_at integer not null, closed_at integer, home text
      );
      create table if not exists messages (
        seq integer not null, session_id text not null, kind text not null,
        payload text not null, tool_call_id text, created_at integer not null,
        primary key (session_id, seq)
      );
      create index if not exists idx_messages_ts on messages (session_id, seq);
      -- the operator's declared window per MODEL (studio keeps one per provider+model; the
      -- model id already carries the provider here). ACP has no setter, so this is a
      -- remembered declaration, not a request to the agent.
      create table if not exists model_context (
        model_id text primary key, context_limit integer not null, updated_at integer not null
      );
      -- Operator settings (voice / theme / call / prefs), one row per section, as JSON. They
      -- used to be a 0600 file beside the DB; anything the operator changes belongs in the
      -- store, not in a browser's localStorage (that copy is a first-frame mirror only).
      create table if not exists settings (
        key text primary key, value text not null, updated_at integer not null
      );
      -- Operator-managed backends (M6): which COMMAND to spawn, which HERMES_HOME it gets and
      -- which hermes profile it runs as (hermes -p PROFILE acp). Before this, "which hermes"
      -- was two env vars fixed at server start (AGENTUS_HERMES_CMD / AGENTUS_HERMES_HOME),
      -- so isolating a slot meant restarting the cockpit. Seeded once from the builtin rows, so
      -- an existing cockpit keeps behaving exactly as before until a row is edited.
      create table if not exists backends (
        id text primary key, label text not null, kind text not null,
        cmd text not null, args text not null default '[]', env text not null default '{}',
        home text, profile text, cwd text, notes text not null default '',
        -- the ACP mode a NEW session from this row starts in (null = the agent's own default)
        default_mode text,
        builtin integer not null default 0,
        created_at integer not null, updated_at integer not null
      );
      -- The session's plan, ONE row per session. Deliberately not derived from the message log:
      -- a plan frame in the transcript records what an agent once SAID, while this row is what the
      -- session HAS — the difference is the restart case, where the agent's own todo state died with
      -- its process and the frames on screen are stale (design-plan-service.md §1).
      create table if not exists plans (
        session_id text primary key, revision integer not null default 0,
        items text not null, explanation text, source text not null,
        terminal text, updated_at integer not null
      );
    `);
    // The DB now holds the speech endpoint's key, so it is the operator's secret material:
    // 0600 like the file it replaced (a default 0644 sqlite file would be a downgrade).
    try {
      fs.chmodSync(path, 0o600);
    } catch { /* someone else's filesystem: nothing to tighten */ }
    // additive migration: mode/config persistence for resume (M4-lite)
    const cols = new Set(
      (this.#db.prepare("pragma table_info(sessions)").all() as { name: string }[]).map((c) => c.name),
    );
    for (const col of ["modes", "config_options", "usage", "commands", "workspace", "models", "auto_title", "home"]) {
      if (!cols.has(col)) this.#db.exec(`alter table sessions add column ${col} text`);
    }
    // `title` is the DISPLAY title (the operator's name once they rename it);
    // `auto_title` keeps the generated one so a rename can be cleared back to it.
    this.#db.exec("update sessions set auto_title = title where auto_title is null or auto_title = ''");
    // integer column, so it gets its own migration (the loop above assumes text)
    if (!cols.has("context_limit")) this.#db.exec("alter table sessions add column context_limit integer");
    // The session's own ACTIVITY clock — when the operator or the agent last really said something
    // in it. A COLUMN, not a derived `max(messages.created_at)` (AionUi's model: `modified_at` on
    // the conversation row, indexed, which is what its sidebar sorts by): every ingestion path
    // writes rows, so a derived max() counts a history REPLAY as activity. Measured 2026-10-08 in
    // the operator's own store — after one restart the rail said 「刚刚」 for eleven sessions at once,
    // ordered by the order their agents happened to be resumed (10:44:52, :54, :58, 10:45:01, …).
    const hadActivityClock = cols.has("last_activity_at");
    if (!hadActivityClock) this.#db.exec("alter table sessions add column last_activity_at integer");
    // messages: the identity of one streamed block, so the chunks of one message accumulate into one
    // row instead of one row per token (see appendTextChunk).
    const mcols = new Set(
      (this.#db.prepare("pragma table_info(messages)").all() as { name: string }[]).map((c) => c.name),
    );
    if (!mcols.has("block_key")) this.#db.exec("alter table messages add column block_key text");
    this.#db.exec("create index if not exists idx_messages_block on messages (session_id, block_key)");
    // additive migration (M6.1): the health snapshot + cached handshake on a backend row. Kept
    // as its own column block so a row insert/update never has to carry them (they are written
    // by recordBackendCheck alone, and by nothing else).
    const beCols = new Set(
      (this.#db.prepare("pragma table_info(backends)").all() as { name: string }[]).map((c) => c.name),
    );
    for (const col of [
      "last_check_status", "last_check_kind", "last_check_error_code", "last_check_error_message",
      "last_check_guidance", "last_check_at", "last_success_at", "last_failure_at",
      "handshake", "handshake_at",
      // P1 (plan service): which channel carries this backend's plan, `acp` | `none`. Nullable on
      // purpose — a row that predates it follows the same default as a seeded one (see rowToBackend).
      "native_plan_source",
      // The permission mode a new session starts in. Nullable like the rest: a row that predates the
      // column means "send nothing" (the agent's own default), not "some mode we invented".
      "default_mode",
    ]) {
      if (!beCols.has(col)) this.#db.exec(`alter table backends add column ${col} text`);
    }
    if (!beCols.has("last_check_latency_ms")) {
      this.#db.exec("alter table backends add column last_check_latency_ms integer");
    }
    this.#foldStreamedChunks();
    // …then the one-time removal of what the REPLAYS already wrote (see #dedupeReplayedRows), and the
    // clock for a store that predates the column — computed after the cleanup, so a session's time is
    // when it was last talked to and not when its agent was last resumed.
    this.#dedupeReplayedRows();
    if (!hadActivityClock) this.#backfillActivity();
  }

  /**
   * One-time repair of transcripts written by the chunk-per-row era.
   *
   * Until `appendTextChunk` existed, every `agent_message_chunk` (1–3 characters) was its own row: a
   * single reply was 1259 rows, which made "show earlier messages" cut a markdown table in half at an
   * arbitrary byte offset, and made the agent's re-emissions of its own text show up as extra
   * messages. This folds those rows in place — the surviving row keeps its `seq`, so paging anchors
   * stay valid and nothing is renumbered — after copying the DB aside once.
   *
   * Deliberately conservative: a row is only folded away when it is provably the same block (same
   * `messageId`) or a whitespace-insensitive re-emission of a block we already hold. Anything else is
   * left exactly as it is.
   */
  #foldStreamedChunks(): void {
    // v2: the anonymous-re-emission rule got sharper (a short block is no longer a fold candidate,
    // but a ≥24-char one that covers most of a block is) — an already-folded DB is worth re-walking.
    const FOLD_VERSION = 2;
    const v = this.#db.prepare("pragma user_version").get() as { user_version?: number } | undefined;
    if (Number(v?.user_version ?? 0) >= FOLD_VERSION) return;
    if (!this.#backup("fold")) return;
    const sessions = this.#db.prepare("select distinct session_id as id from messages").all() as unknown as { id: string }[];
    let before = 0;
    let after = 0;
    const upd = this.#db.prepare("update messages set payload = ?, block_key = ? where session_id = ? and seq = ?");
    const del = this.#db.prepare("delete from messages where session_id = ? and seq = ?");
    for (const { id } of sessions) {
      const rows = this.#db
        .prepare("select * from messages where session_id = ? order by seq asc")
        .all(id) as unknown as RawMessageRow[];
      before += rows.length;
      const kept: { row: RawMessageRow; text: string | null }[] = [];
      const doomed: number[] = [];
      for (const r of rows) {
        if (r.kind !== "agent" && r.kind !== "thought") {
          kept.push({ row: r, text: null });
          continue;
        }
        const payload = parseJson(r.payload);
        const text = textOf(payload);
        const key = blockKeyOf(r.kind, payload);
        // Walk back to the block this row belongs to: the same messageId, or a block whose text
        // already contains this one (the agent replays its own text without an id).
        let hitIdx = -1;
        for (let i = kept.length - 1; i >= 0; i--) {
          const cand = kept[i];
          if (cand.text === null || cand.row.kind !== r.kind) continue;
          const candText: string = cand.text;
          if (key && blockKeyOf(cand.row.kind, parseJson(cand.row.payload)) === key) { hitIdx = i; break; }
          if (!key && reemissionTarget(candText, text)) { hitIdx = i; break; }
          if (kept.length - i > ANON_SCAN_ROWS) break;
        }
        if (hitIdx >= 0) {
          const target = kept[hitIdx];
          const delta = key ? appendedTextDelta(target.text ?? "", text) : "";
          if (delta) target.text = (target.text ?? "") + delta;
          doomed.push(r.seq);
          continue;
        }
        kept.push({ row: r, text });
      }
      for (const seq of doomed) del.run(id, seq);
      for (const k of kept) {
        if (k.text === null) continue;
        const payload = withText(parseJson(k.row.payload), k.text);
        const key = blockKeyOf(k.row.kind, payload);
        upd.run(JSON.stringify(payload), key, id, k.row.seq);
      }
      after += kept.length;
    }
    this.#db.prepare(`pragma user_version = ${FOLD_VERSION}`).run();
    console.log(`[store] 历史分片已折叠：${before} 行 → ${after} 行`);
  }

  /**
   * Copy the DB aside ONCE, before a destructive repair pass. False means no backup could be made
   * (a read-only filesystem, a locked file) — the caller must then leave the data alone.
   */
  #backup(tag: string): boolean {
    const bak = `${this.#path}.pre-${tag}.bak`;
    try {
      if (!fs.existsSync(bak)) {
        this.#db.exec(`vacuum into '${bak.replace(/'/g, "''")}'`);
        console.log(`[store] 修复前已备份：${bak}`);
      }
      return true;
    } catch (e) {
      console.log(`[store] 备份失败（${tag}），跳过这次修复以免损坏历史：${String(e)}`);
      return false;
    }
  }

  /**
   * One-time removal of the rows a HISTORY REPLAY wrote as if they were fresh output.
   *
   * Whenever a slot re-attaches, the agent re-sends the tail of the conversation it holds as ordinary
   * `session/update` notifications. The streaming kinds are folded by id/content, but a `tool_call`
   * used to be APPENDED like new output, so one call became one row per re-attach. Measured
   * 2026-10-08 in the operator's own store: 1224 calls replayed, **7507 extra rows**, the worst
   * sitting in the transcript 17 times — every copy byte-identical, at timestamps that trace each
   * restart (10-06 13:59 → 10-08 10:44). Text blocks the agent re-sent without a `messageId` did the
   * same: 6487 rows repeated an earlier block of the same kind, character for character.
   *
   * Both are provable, so both are removed — with the discipline of the legacy fold: a backup first,
   * a row only deleted when an EARLIER row of the same session holds the same bytes, and a repeat
   * that does NOT match exactly left alone and reported (it may carry an update the live row never
   * got).
   *
   * A legitimate repeat (the agent really says the same thing twice) is separated from a replay by
   * one observable fact: a replay writes its copies in a BURST — several repeats inside the same
   * second — while a live turn writes its new rows spread over the turn. So a text row is only
   * removed when its second looks like that burst.
   */
  #dedupeReplayedRows(): void {
    // v4: the live store ran v3 DURING the release restart — the migration walked the rows, set its
    // version, and only THEN did the resize/resume replays write the 1240 duplicates. A store that
    // already carries v3 therefore still holds them, so the walk is worth repeating; v4 also puts
    // back the activity clock the same replay bumped (see the tail of this method).
    const DEDUPE_VERSION = 4;
    const v = this.#db.prepare("pragma user_version").get() as { user_version?: number } | undefined;
    if (Number(v?.user_version ?? 0) >= DEDUPE_VERSION) return;
    if (!this.#backup("dedupe")) return;
    // The store's own floor for "this is a block, not an utterance" (`reemissionTarget`): below it a
    // repeat is legitimately two messages ("好的" twice) and never a replay of one block.
    const MIN_DUP_CHARS = 24;
    const BURST_REPEATS_PER_SECOND = 3;
    const del = this.#db.prepare("delete from messages where session_id = ? and seq = ?");
    let before = 0;
    let after = 0;
    let toolsDropped = 0;
    let textDropped = 0;
    let kept = 0;
    const sessions = this.#db
      .prepare("select distinct session_id as id from messages")
      .all() as unknown as { id: string }[];
    for (const { id } of sessions) {
      const rows = this.#db
        .prepare("select * from messages where session_id = ? order by seq asc")
        .all(id) as unknown as RawMessageRow[];
      before += rows.length;
      const doomed = new Set<number>();
      // 1. one tool call is ONE row: a later row with the same `tool_call_id` and the same bytes is
      //    that call replayed — never a second call.
      const byCall = new Map<string, RawMessageRow>();
      for (const r of rows) {
        if (r.kind !== "tool" || !r.tool_call_id) continue;
        const first = byCall.get(r.tool_call_id);
        if (!first) {
          byCall.set(r.tool_call_id, r);
          continue;
        }
        if (normalizeText(first.payload) === normalizeText(r.payload)) {
          doomed.add(r.seq);
          toolsDropped += 1;
        } else {
          kept += 1;
        }
      }
      // 2. an id-less text block the agent re-sent (its own recap): the copy is not a new message.
      const repeats: RawMessageRow[] = [];
      const seenText = new Set<string>();
      for (const r of rows) {
        if (r.kind !== "agent" && r.kind !== "thought") continue;
        const text = normalizeText(textOf(parseJson(r.payload)));
        if (!text) continue;
        const key = `${r.kind}\u0000${text}`;
        if (seenText.has(key)) repeats.push(r);
        else seenText.add(key);
      }
      const perSecond = new Map<number, number>();
      for (const r of repeats) {
        const second = Math.floor(r.created_at / 1000);
        perSecond.set(second, (perSecond.get(second) ?? 0) + 1);
      }
      for (const r of repeats) {
        const text = normalizeText(textOf(parseJson(r.payload)));
        if (text.length < MIN_DUP_CHARS) {
          kept += 1;
          continue;
        }
        if ((perSecond.get(Math.floor(r.created_at / 1000)) ?? 0) <= BURST_REPEATS_PER_SECOND) {
          kept += 1;
          continue;
        }
        doomed.add(r.seq);
        textDropped += 1;
      }
      for (const seq of doomed) del.run(id, seq);
      after += rows.length - doomed.size;
    }
    // The same replay also bumped the session's ACTIVITY clock — `#touch` fires on any write, so a
    // resumed slot's rail time jumped to the moment its agent was re-attached (measured on live:
    // eleven sessions at once, 10:44:52 → 10:45:20). With the copies now gone, a clock that sits
    // AHEAD of the session's newest surviving row is provably that bump and nothing else, so put it
    // back to the row that is actually there. A session with no messages left keeps what it has.
    const clock = this.#db
      .prepare(
        `update sessions set last_activity_at =
           (select max(m.created_at) from messages m where m.session_id = sessions.id)
         where last_activity_at is not null
           and last_activity_at > (select max(m.created_at) from messages m where m.session_id = sessions.id)`,
      )
      .run();
    this.#db.prepare(`pragma user_version = ${DEDUPE_VERSION}`).run();
    if (before !== after) {
      console.log(
        `[store] 重放行清理：${before} 行 → ${after} 行（工具行 ${toolsDropped}、文本行 ${textDropped}；`
        + `另有 ${kept} 行内容并不完全相同，原样保留）`,
      );
    }
    if (clock.changes > 0) {
      console.log(`[store] 活动时钟复位：${clock.changes} 个会话的时间被重放推到了重启那一刻，已按真实最后一行改回`);
    }
    this.#repairReplayClocks();
  }

  /**
   * The residue of the same replay, for sessions the conservative dedupe had to leave alone.
   *
   * A replayed block that is not byte-identical to what the store already held is KEPT (it may carry
   * an update the stored copy never got) — and with the row kept, `#touch`'s clock stays at the
   * restart too. Measured 2026-10-08 on the live store: eight sessions' rail times all sat inside one
   * 30-second window (the moment their agents were re-attached), which is the signature this reads.
   *
   * The rule is the observable one — real conversations do not end eight at a time: a 90-second
   * window holding four or more sessions' clocks is a mass resume, and a session whose clock falls in
   * such a window goes back to its newest row written BEFORE the window opened. A session in the
   * window with no earlier row is reported, never guessed at. Running it on a store with no such
   * window is a no-op, so it is safe to leave standing.
   */
  #repairReplayClocks(): void {
    const WINDOW_MS = 90_000;
    const MIN_SESSIONS = 4;
    const rows = this.#db
      .prepare("select id, last_activity_at as clock from sessions where last_activity_at is not null order by last_activity_at asc")
      .all() as unknown as { id: string; clock: number }[];
    // The densest windows first: an anchor at each clock, merged into maximal groups.
    const groups: { lo: number; hi: number; ids: Set<string> }[] = [];
    for (const anchor of rows) {
      const inWindow = rows.filter((r) => r.clock >= anchor.clock && r.clock <= anchor.clock + WINDOW_MS);
      if (inWindow.length < MIN_SESSIONS) continue;
      const lo = anchor.clock;
      const hi = anchor.clock + WINDOW_MS;
      const hit = groups.find((g) => lo <= g.hi && hi >= g.lo);
      if (hit) {
        hit.lo = Math.min(hit.lo, lo);
        hit.hi = Math.max(hit.hi, hi);
        inWindow.forEach((r) => hit.ids.add(r.id));
      } else {
        groups.push({ lo, hi, ids: new Set(inWindow.map((r) => r.id)) });
      }
    }
    if (!groups.length) return;
    const earlier = this.#db.prepare(
      "select max(created_at) as m from messages where session_id = ? and created_at < ?",
    );
    const upd = this.#db.prepare("update sessions set last_activity_at = ? where id = ?");
    let moved = 0;
    let stuck = 0;
    for (const g of groups) {
      for (const id of g.ids) {
        const to = (earlier.get(id, g.lo) as { m: number | null }).m;
        if (to === null) {
          stuck += 1;
          continue;
        }
        upd.run(to, id);
        moved += 1;
      }
    }
    if (moved || stuck) {
      console.log(
        `[store] 重放时钟再修：${moved} 个会话的时间被按「重启前最后一行」改回（${groups.length} 段集中重连窗口）`
        + (stuck ? `；${stuck} 个会话在这之前没有行，保持原样` : ""),
      );
    }
  }

  /** Give every session that predates the activity column its real last-activity time — computed
   *  AFTER the replay cleanup, so it is when the conversation was last talked to and not when its
   *  agent was last resumed. A session with no messages keeps NULL and falls back to creation. */
  #backfillActivity(): void {
    this.#db.exec(
      `update sessions set last_activity_at =
         (select max(m.created_at) from messages m where m.session_id = sessions.id)
       where last_activity_at is null`,
    );
  }

  upsertSession(s: SessionRow): void {
    const exist = this.#db.prepare("select id from sessions where id = ?").get(s.id);
    if (exist) {
      // `home` is deliberately NOT in this SET: which data directory a session's agent-side
      // state lives in is decided once, at creation, and every later write happens while the
      // session still lives there. Letting this update rewrite it would silently "re-home" a
      // session whose agent has never seen it — the exact confusion the resume check exists to
      // catch. (Same shape as `created_at`: written on insert only.)
      this.#db
        .prepare(
          `update sessions set backend=?, acp_session_id=?, cwd=?, title=?, status=?, pid=?, closed_at=?, modes=?, config_options=?, usage=?, commands=?, models=?, auto_title=coalesce(auto_title, ?) where id=?`,
        )
        .run(s.backend, s.acpSessionId, s.cwd, s.title, s.status, s.pid, s.closedAt,
          JSON.stringify(s.modes ?? null), JSON.stringify(s.configOptions ?? []),
          JSON.stringify(s.usage ?? null), JSON.stringify(s.commands ?? []),
          JSON.stringify(s.models ?? null), s.title, s.id);
    } else {
      this.#db
        .prepare(
          `insert into sessions (id, backend, acp_session_id, cwd, title, status, pid, created_at, closed_at, modes, config_options, usage, commands, models, auto_title, home)
           values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(s.id, s.backend, s.acpSessionId, s.cwd, s.title, s.status, s.pid, s.createdAt, s.closedAt,
          JSON.stringify(s.modes ?? null), JSON.stringify(s.configOptions ?? []),
          JSON.stringify(s.usage ?? null), JSON.stringify(s.commands ?? []),
          JSON.stringify(s.models ?? null), s.title, s.home ?? null);
    }
  }

  /** Record (or adopt) the home a session was created under. Used when a legacy row — created
   *  before the column existed — is resumed successfully: the successful load is itself the
   *  proof of which home holds its state, so the row stops being ambiguous. */
  setSessionHome(sessionId: string, home: string | null): void {
    this.#db.prepare("update sessions set home = ? where id = ?").run(home, sessionId);
  }

  listSessions(includeClosed = true): SessionRow[] {
    const where = includeClosed ? "" : "where status != 'closed'";
    const rows = this.#db
      .prepare(`select * from sessions ${where} order by created_at desc`)
      .all() as unknown as RawSessionRow[];
    return rows.map(rowToSession);
  }

  /** Distinct working directories the operator has used, most recent first. Feeds the
   *  "recent" list in the new-slot picker — no new table: every slot row already
   *  remembers where it ran. */
  recentCwds(limit = 8): string[] {
    const rows = this.#db
      .prepare(
        `select cwd, max(coalesce(closed_at, created_at)) as at from sessions
         where cwd is not null and cwd <> '' group by cwd order by at desc limit ?`,
      )
      .all(limit) as unknown as { cwd: string }[];
    return rows.map((r) => r.cwd);
  }

  getSession(id: string): SessionRow | undefined {
    const r = this.#db.prepare("select * from sessions where id = ?").get(id) as
      | RawSessionRow
      | undefined;
    return r ? rowToSession(r) : undefined;
  }

  /** Purge a cold slot: drop the row and its transcript. Used by the rail's ✕ on
   *  cold slots — without it the "on disk · N" list only ever grows. */
  deleteSession(sessionId: string): boolean {
    const row = this.#db.prepare("select id from sessions where id = ?").get(sessionId);
    if (!row) return false;
    this.#db.prepare("delete from messages where session_id = ?").run(sessionId);
    this.#db.prepare("delete from sessions where id = ?").run(sessionId);
    return true;
  }

  /** When each session last saw REAL activity, as a wall clock so sessions CAN be ordered
   *  against each other — `seq` is a per-session counter (primary key is session_id+seq), so
   *  comparing it across sessions was meaningless. The stored column wins (see the migration);
   *  the rows are only a fallback for a session whose clock was never written. */
  lastActivityAt(): Map<string, number> {
    const rows = this.#db
      .prepare(
        `select s.id as id,
                coalesce(s.last_activity_at,
                         (select max(m.created_at) from messages m where m.session_id = s.id),
                         s.created_at) as at
           from sessions s`,
      )
      .all() as unknown as { id: string; at: number }[];
    return new Map(rows.map((r) => [r.id, r.at]));
  }

  /** Advance a session's activity clock. Called for REAL activity only — a prompt the operator sent,
   *  output a running agent produced. Deliberately never for a history replay: that is the whole
   *  reason the clock lives in its own column instead of being derived from `messages`. */
  touchActivity(sessionId: string, at: number): void {
    this.#db
      .prepare(
        "update sessions set last_activity_at = ? where id = ? and (last_activity_at is null or last_activity_at < ?)",
      )
      .run(at, sessionId, at);
  }

  /** Highest persisted seq for a session (0 when empty) — the resume anchor. */
  maxSeq(sessionId: string): number {
    const row = this.#db
      .prepare("select max(seq) as m from messages where session_id = ?")
      .get(sessionId) as { m: number | null };
    return row.m ?? 0;
  }

  nextSeq(sessionId: string): number {
    const row = this.#db
      .prepare("select max(seq) as m from messages where session_id = ?")
      .get(sessionId) as { m: number | null };
    return (row.m ?? 0) + 1;
  }

  /** The session's plan object, or null when it never made one.
   *
   *  This — not the transcript — is what the cockpit's card renders, because the two are not the
   *  same thing: a plan frame that survives in the message log is a record of what an agent once
   *  said; this row is what the session actually has. The restart case is exactly where they part
   *  (design-plan-service §1): the frames died with the agent's process, this did not. */
  getPlan(sessionId: string): PlanSnapshot | null {
    const row = this.#db
      .prepare(
        `select session_id, revision, items, explanation, source, terminal, updated_at
         from plans where session_id = ?`,
      )
      .get(sessionId) as RawPlanRow | undefined;
    return row ? rowToPlan(row) : null;
  }

  /** Write the plan object; returns the stored snapshot.
   *
   *  `revision` moves on EVERY write (a terminal-only stamp included) so a client can treat it as a
   *  cursor. `explanation: undefined` keeps the remark already there; `null` clears it. */
  upsertPlan(sessionId: string, patch: PlanPatch): PlanSnapshot {
    const prev = this.getPlan(sessionId);
    const explanation =
      patch.explanation === undefined ? (prev?.explanation ?? null) : patch.explanation;
    this.#db
      .prepare(
        `insert into plans (session_id, revision, items, explanation, source, terminal, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict(session_id) do update set
           revision = excluded.revision, items = excluded.items, explanation = excluded.explanation,
           source = excluded.source, terminal = excluded.terminal, updated_at = excluded.updated_at`,
      )
      .run(
        sessionId,
        (prev?.revision ?? 0) + 1,
        JSON.stringify(normalizeItems(patch.items)),
        explanation,
        patch.source,
        patch.terminal ?? null,
        Date.now(),
      );
    return this.getPlan(sessionId) as PlanSnapshot;
  }

  appendMessage(m: Omit<StoredMessage, "seq">): StoredMessage {
    const seq = this.nextSeq(m.sessionId);
    this.#db
      .prepare(
        `insert into messages (seq, session_id, kind, payload, tool_call_id, block_key, created_at)
         values (?,?,?,?,?,?,?)`,
      )
      .run(seq, m.sessionId, m.kind, JSON.stringify(m.payload), m.toolCallId ?? null, null, m.createdAt);
    return { ...m, seq };
  }

  /**
   * The streaming half of the transcript: one logical message, one row.
   *
   * The agent emits `agent_message_chunk` / `agent_thought_chunk` per token, so appending a row per
   * frame is what made a single reply 1259 rows and made "show earlier messages" cut a markdown table
   * in half (the page boundary was a byte offset inside a 3.8-character row). Chunks of the SAME
   * `messageId` therefore accumulate into the row that already holds that message, and a frame that
   * re-sends text we already have adds nothing.
   *
   * Returns the row to hand to the client plus the text that is genuinely new. `delta === ""` means
   * the frame was a pure re-emission (nothing to emit); an existing row with a non-empty delta means
   * "this row grew" — the client appends instead of inserting a second bubble.
   */
  appendTextChunk(m: Omit<StoredMessage, "seq"> & { kind: "agent" | "thought" }): {
    message: StoredMessage;
    delta: string;
    isNew: boolean;
  } {
    const text = textOf(m.payload);
    const key = blockKeyOf(m.kind, m.payload);
    if (!text) {
      const stored = this.appendMessage(m);
      return { message: stored, delta: "", isNew: true };
    }
    // 1. the same logical message: fold into its row, wherever that row is
    if (key) {
      const row = this.#rowByKey(m.sessionId, key);
      if (row) return this.#foldInto(row, text);
    }
    // 2. an anonymous block that re-sends something we already hold. Hermes replays its own text as
    //    complete blocks with no messageId (a recap on every re-attach); persisted naively that is
    //    the same answer stored — and rendered — six times.
    if (!key) {
      const row = this.#rowContaining(m.sessionId, m.kind, text);
      if (row) return this.#foldInto(row, text);   // "grew" appends the tail, "same" is a no-op
    }
    const stored = this.appendMessage(m);
    if (key) this.#db.prepare("update messages set block_key = ? where session_id = ? and seq = ?")
      .run(key, m.sessionId, stored.seq);
    return { message: stored, delta: text, isNew: true };
  }

  /** Append to the row that already accumulates this message (or report it as a re-emission). */
  #foldInto(row: StoredMessage, incoming: string): { message: StoredMessage; delta: string; isNew: boolean } {
    const existing = textOf(row.payload);
    // the same block with different whitespace (a re-send with an extra blank line) is NOT growth:
    // appendedTextDelta is whitespace-sensitive and would otherwise re-append the whole text
    if (normalizeText(existing) === normalizeText(incoming)) return { message: row, delta: "", isNew: false };
    const delta = appendedTextDelta(existing, incoming);
    if (!delta) return { message: row, delta: "", isNew: false };
    const payload = withText(row.payload, existing + delta);
    this.#db
      .prepare("update messages set payload = ? where session_id = ? and seq = ?")
      .run(JSON.stringify(payload), row.sessionId, row.seq);
    return { message: { ...row, payload }, delta, isNew: false };
  }

  #rowByKey(sessionId: string, key: string): StoredMessage | undefined {
    const r = this.#db
      .prepare("select * from messages where session_id = ? and block_key = ? order by seq desc limit 1")
      .get(sessionId, key) as unknown as RawMessageRow | undefined;
    return r ? rowToMessage(r) : undefined;
  }

  /** A recent row of the same kind that this id-less block re-sends. */
  #rowContaining(sessionId: string, kind: string, text: string): StoredMessage | undefined {
    const rows = this.#db
      .prepare("select * from messages where session_id = ? and kind = ? order by seq desc limit ?")
      .all(sessionId, kind, ANON_SCAN_ROWS) as unknown as RawMessageRow[];
    for (const r of rows) {
      if (reemissionTarget(textOf(parseJson(r.payload)), text)) return rowToMessage(r);
    }
    return undefined;
  }

  /**
   * A tool call is ONE row, wherever the frame came from.
   *
   * The agent re-sends every call it still holds whenever it re-attaches (`session/load` on a
   * resume), and those frames used to be appended like fresh output: measured 2026-10-08 in the
   * operator's own store, 1224 calls had 7507 extra rows — the worst sitting in the transcript 17
   * times, once per restart, each copy byte-identical. A call is identified by `toolCallId`, so a
   * call we already hold is not a new call: the later frame is DROPPED (`isNew: false`).
   *
   * Deliberately NOT merged into the existing row, even though `tool_call_update` does exactly
   * that: a replay carries the call as the agent remembers it, and letting an `in_progress`
   * snapshot overwrite a live `completed` would walk the card backwards. Real updates arrive as
   * `tool_call_update` (see upsertToolMessage); a replay that differs is reported by the one-time
   * cleanup (#dedupeReplayedRows) rather than silently folded in here.
   */
  appendToolCall(m: Omit<StoredMessage, "seq"> & { kind: "tool"; toolCallId: string }): {
    message: StoredMessage;
    isNew: boolean;
  } {
    if (m.toolCallId) {
      const exist = this.#db
        .prepare(
          `select * from messages where session_id = ? and tool_call_id = ? and kind = 'tool'
            order by seq asc limit 1`,
        )
        .get(m.sessionId, m.toolCallId) as unknown as RawMessageRow | undefined;
      if (exist) return { message: rowToMessage(exist), isNew: false };
    }
    return { message: this.appendMessage(m), isNew: true };
  }

  upsertToolMessage(sessionId: string, toolCallId: string, payload: unknown): StoredMessage | null {
    // tool_call_update must merge into the original tool row (ACP semantics),
    // never append a duplicate bubble.
    const exist = this.#db
      .prepare(
        `select seq, session_id, kind, payload, tool_call_id, created_at from messages
         where session_id = ? and tool_call_id = ? and kind = 'tool' order by seq desc limit 1`,
      )
      .get(sessionId, toolCallId) as
      | { seq: number; session_id: string; kind: string; payload: string; tool_call_id: string; created_at: number }
      | undefined;
    if (!exist) return null;
    let merged: Record<string, unknown> = {};
    try {
      merged = { ...(JSON.parse(exist.payload) as object), ...(payload as object) };
    } catch {
      merged = payload as Record<string, unknown>;
    }
    this.#db
      .prepare("update messages set payload = ? where session_id = ? and seq = ?")
      .run(JSON.stringify(merged), sessionId, exist.seq);
    return {
      seq: exist.seq,
      sessionId: exist.session_id,
      kind: "tool" as StoredMessage["kind"],
      payload: merged,
      toolCallId: exist.tool_call_id,
      createdAt: exist.created_at,
    };
  }

  /** The NEWEST page, oldest-first: what a fresh view of a long slot should open on.
   *  `hasOlder` says whether the transcript continues above it (the "load earlier"
   *  affordance). Distinct from messagesAfter, which walks FORWARD from a replay anchor. */
  messagesTail(sessionId: string, limit = 500): { messages: StoredMessage[]; hasOlder: boolean } {
    const page = this.messagesBefore(sessionId, Number.MAX_SAFE_INTEGER, limit);
    return { messages: page.messages, hasOlder: page.hasMore };
  }

  /** Page BACKWARDS: the newest rows strictly before `beforeSeq`, returned oldest-first so the
   *  client can prepend without re-sorting, capped by BOTH a row count and a byte budget (one
   *  accumulated message can be tens of KB, so "500 rows" means nothing on its own).
   *  `hasMore` tells the UI whether an older page still exists. */
  messagesBefore(sessionId: string, beforeSeq: number, limit = 200): { messages: StoredMessage[]; hasMore: boolean } {
    const rows = this.#db
      .prepare(
        `select * from messages where session_id = ? and seq < ? order by seq desc limit ?`,
      )
      .all(sessionId, beforeSeq, limit + 1) as unknown as RawMessageRow[];
    const hasMore = rows.length > limit;
    const capped = hasMore ? rows.slice(0, limit) : rows;
    // then the byte budget: always keep at least one row, so a single huge message is still readable
    const page: RawMessageRow[] = [];
    let bytes = 0;
    for (const r of capped) {
      bytes += r.payload.length;
      page.push(r);
      if (bytes > PAGE_BYTES) break;
    }
    return { hasMore: hasMore || page.length < capped.length, messages: page.reverse().map(rowToMessage) };
  }

  messagesAfter(sessionId: string, afterSeq: number, limit = 500): StoredMessage[] {
    const rows = this.#db
      .prepare(
        `select * from messages where session_id = ? and seq > ? order by seq asc limit ?`,
      )
      .all(sessionId, afterSeq, limit) as unknown as RawMessageRow[];
    return rows.map(rowToMessage);
  }

  close(): void {
    this.#db.close();
  }
  /** Re-point a slot's workspace. Not part of upsertSession: a live-status write
   *  must never clobber a choice the operator made in the panel. */
  setWorkspace(id: string, workspace: string | null): boolean {
    const info = this.#db
      .prepare("update sessions set workspace = ? where id = ?")
      .run(workspace && workspace.length ? workspace : null, id);
    return Number(info.changes ?? 0) > 0;
  }

  /** Rename a slot: `title` = the operator's name, `null` = back to the generated one.
   *  Only `title` changes — `auto_title` is what the generated name survives in, so a
   *  rename is always reversible (studio keeps the two apart the same way: a null title
   *  falls back to the first-message preview). Returns false when the id is unknown. */
  renameSession(id: string, title: string | null): boolean {
    const row = this.#db.prepare("select title, auto_title from sessions where id = ?").get(id) as
      | { title: string; auto_title: string | null }
      | undefined;
    if (!row) return false;
    const next = title == null || !title.length ? (row.auto_title ?? row.title) : title;
    const info = this.#db.prepare("update sessions set title = ? where id = ?").run(next, id);
    return Number(info.changes ?? 0) > 0;
  }

  /** Record a GENERATED name.
   *
   *  Two writes, one rule: `auto_title` always takes it (so the generated name is the one a
   *  cleared rename falls back to), while the DISPLAY title only moves when the operator has
   *  not named this session themselves — i.e. while `title` still equals `auto_title`. That
   *  is what makes an automatic title safe to fire at any time: after a rename it updates
   *  the fallback and leaves the visible row alone. `force` is for the operator asking for a
   *  new name on purpose (the rail's 重新生成), where the new title is the point.
   *  Returns the row it ended up with, so callers can broadcast exactly what changed. */
  setAutoTitle(id: string, title: string, { force = false }: { force?: boolean } = {}): SessionRow | null {
    const row = this.#db.prepare("select title, auto_title from sessions where id = ?").get(id) as
      | { title: string; auto_title: string | null }
      | undefined;
    if (!row) return null;
    const clean = title.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120).trim();
    if (!clean) return null;
    const wasAuto = row.auto_title == null || row.auto_title === "" || row.title === row.auto_title;
    const nextTitle = force || wasAuto ? clean : row.title;
    this.#db
      .prepare("update sessions set auto_title = ?, title = ? where id = ?")
      .run(clean, nextTitle, id);
    return this.getSession(id) ?? null;
  }

  /** Window declared for a model (null = nothing remembered). */
  getModelLimit(modelId: string | null | undefined): number | null {
    if (!modelId) return null;
    const row = this.#db
      .prepare("select context_limit from model_context where model_id = ?")
      .get(modelId) as { context_limit?: number } | undefined;
    return row?.context_limit ?? null;
  }

  setModelLimit(modelId: string, limit: number | null): void {
    if (!modelId) return;
    if (limit && limit > 0) {
      this.#db
        .prepare(
          `insert into model_context (model_id, context_limit, updated_at) values (?, ?, ?)
           on conflict(model_id) do update set context_limit = excluded.context_limit, updated_at = excluded.updated_at`,
        )
        .run(modelId, Math.floor(limit), Date.now());
    } else {
      this.#db.prepare("delete from model_context where model_id = ?").run(modelId);
    }
  }

  /** One settings section (voice / theme / call / prefs). A missing key means "nothing
   *  stored yet", which settings.ts turns into the defaults. */
  getSetting(key: string): unknown {
    const row = this.#db.prepare("select value from settings where key = ?").get(key) as { value?: string } | undefined;
    if (!row?.value) return null;
    try {
      return JSON.parse(row.value) as unknown;
    } catch {
      return null;
    }
  }

  setSetting(key: string, value: unknown): void {
    this.#db
      .prepare(
        `insert into settings (key, value, updated_at) values (?, ?, ?)
         on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value ?? null), Date.now());
  }

  /** Every stored section at once (the settings payload is read as one object). */
  listSettings(): Record<string, unknown> {
    const rows = this.#db.prepare("select key, value from settings").all() as { key: string; value: string }[];
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        out[r.key] = JSON.parse(r.value) as unknown;
      } catch { /* unreadable row: treated as absent */ }
    }
    return out;
  }

  listModelLimits(): { modelId: string; limit: number }[] {
    return this.#db
      .prepare("select model_id as modelId, context_limit as \"limit\" from model_context order by updated_at desc")
      .all() as { modelId: string; limit: number }[];
  }

  /** The operator's declared context window for a slot (null clears it). */
  setContextLimit(id: string, limit: number | null): boolean {
    const info = this.#db
      .prepare("update sessions set context_limit = ? where id = ?")
      .run(limit && limit > 0 ? Math.floor(limit) : null, id);
    return Number(info.changes ?? 0) > 0;
  }

  // ---- backends (M6): the operator-managed "which command / which home / which profile" -----

  listBackends(): BackendRow[] {
    const rows = this.#db
      .prepare("select * from backends order by builtin desc, id")
      .all() as unknown as RawBackendRow[];
    return rows.map(rowToBackend);
  }

  getBackend(id: string): BackendRow | null {
    const row = this.#db.prepare("select * from backends where id = ?").get(id) as unknown as
      | RawBackendRow
      | undefined;
    return row ? rowToBackend(row) : null;
  }

  upsertBackend(row: BackendRow): void {
    this.#db
      .prepare(
        `insert into backends (id, label, kind, cmd, args, env, home, profile, cwd, notes,
                               default_mode,
                               native_plan_source,
                               builtin, created_at, updated_at,
                               last_check_status, last_check_kind, last_check_error_code,
                               last_check_error_message, last_check_guidance, last_check_latency_ms,
                               last_check_at, last_success_at, last_failure_at, handshake, handshake_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(id) do update set
           label = excluded.label, kind = excluded.kind, cmd = excluded.cmd, args = excluded.args,
           env = excluded.env, home = excluded.home, profile = excluded.profile, cwd = excluded.cwd,
           notes = excluded.notes,
           default_mode = excluded.default_mode,
           native_plan_source = excluded.native_plan_source,
           updated_at = excluded.updated_at,
           -- the evidence travels with the row: a spawn-relevant edit replaces it with a cleared
           -- snapshot (coerceRow decides that), and a row that was never checked writes nulls.
           last_check_status = excluded.last_check_status, last_check_kind = excluded.last_check_kind,
           last_check_error_code = excluded.last_check_error_code,
           last_check_error_message = excluded.last_check_error_message,
           last_check_guidance = excluded.last_check_guidance,
           last_check_latency_ms = excluded.last_check_latency_ms,
           last_check_at = excluded.last_check_at, last_success_at = excluded.last_success_at,
           last_failure_at = excluded.last_failure_at,
           handshake = excluded.handshake, handshake_at = excluded.handshake_at`,
      )
      .run(
        row.id, row.label, row.kind, row.cmd, JSON.stringify(row.args), JSON.stringify(row.env ?? {}),
        row.home, row.profile, row.cwd, row.notes ?? "",
        row.defaultMode ?? null,
        row.nativePlanSource ?? null,
        row.builtin ? 1 : 0, row.createdAt, row.updatedAt,
        row.health?.status ?? null, row.health?.kind ?? null, row.health?.errorCode ?? null,
        row.health?.message ?? null, row.health?.guidance ?? null, row.health?.latencyMs ?? null,
        row.health?.at ?? null, row.health?.lastSuccessAt ?? null, row.health?.lastFailureAt ?? null,
        row.handshake ? JSON.stringify(row.handshake) : null, row.handshake?.at ?? null,
      );
  }

  deleteBackend(id: string): boolean {
    const info = this.#db.prepare("delete from backends where id = ?").run(id);
    return Number(info.changes ?? 0) > 0;
  }

  /**
   * Write back a health snapshot (and optionally a handshake) for one row. Deliberately a
   * column-scoped UPDATE rather than upsertBackend: a check must never resurrect a stale copy of
   * the row (the operator may be editing cmd/home in the UI while the probe runs), and it must
   * not touch updated_at — "the row changed" and "the row was measured" are different facts.
   */
  recordBackendCheck(id: string, health: BackendHealth, handshake?: BackendHandshake | null): void {
    this.#db
      .prepare(
        `update backends set
           last_check_status = ?, last_check_kind = ?, last_check_error_code = ?,
           last_check_error_message = ?, last_check_guidance = ?, last_check_latency_ms = ?,
           last_check_at = ?, last_success_at = ?, last_failure_at = ?,
           handshake = coalesce(?, handshake), handshake_at = coalesce(?, handshake_at)
         where id = ?`,
      )
      .run(
        health.status, health.kind, health.errorCode, health.message, health.guidance,
        health.latencyMs, health.at, health.lastSuccessAt, health.lastFailureAt,
        handshake ? JSON.stringify(handshake) : null,
        handshake ? handshake.at : null,
        id,
      );
  }

  /** Sessions still OPEN on this backend — a closed (archived) session keeps its backend id
   *  for display, so only open ones make a row undeletable. */
  countOpenSessionsForBackend(id: string): number {
    const row = this.#db
      .prepare("select count(*) as n from sessions where backend = ? and status != 'closed'")
      .get(id) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /** First boot on an empty registry: copy the builtin rows in (0 rows = already seeded). */
  seedBackendsIfEmpty(rows: BackendRow[]): number {
    const row = this.#db.prepare("select count(*) as n from backends").get() as { n: number } | undefined;
    if (Number(row?.n ?? 0) > 0) return 0;
    for (const r of rows) this.upsertBackend(r);
    return rows.length;
  }

}
