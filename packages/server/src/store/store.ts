// SQLite persistence via node:sqlite (Node >=22.5, zero deps).
// Design: sessions row carries `pid` (orphan-reclaim anchor, AC5);
// messages carry monotonic per-session `seq` (reconnect replay anchor, AC6).
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { BackendId, SessionStatus, StoredMessage } from "@agentslot/shared";

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
   *  never stomp the operator's own (see the interface comment in @agentslot/shared) */
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
}

interface RawSessionRow {
  id: string; backend: BackendId; acp_session_id: string | null; cwd: string;
  title: string; auto_title?: string | null; status: SessionStatus; pid: number | null;
  created_at: number; closed_at: number | null;
  modes?: string | null; config_options?: string | null;
  usage?: string | null; commands?: string | null;
  workspace?: string | null;
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
    models: parseJson(r.models),
    contextLimit: r.context_limit ?? null,
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
        pid integer, created_at integer not null, closed_at integer
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
    for (const col of ["modes", "config_options", "usage", "commands", "workspace", "models", "auto_title"]) {
      if (!cols.has(col)) this.#db.exec(`alter table sessions add column ${col} text`);
    }
    // `title` is the DISPLAY title (the operator's name once they rename it);
    // `auto_title` keeps the generated one so a rename can be cleared back to it.
    this.#db.exec("update sessions set auto_title = title where auto_title is null or auto_title = ''");
    // integer column, so it gets its own migration (the loop above assumes text)
    if (!cols.has("context_limit")) this.#db.exec("alter table sessions add column context_limit integer");
    // messages: the identity of one streamed block, so the chunks of one message accumulate into one
    // row instead of one row per token (see appendTextChunk).
    const mcols = new Set(
      (this.#db.prepare("pragma table_info(messages)").all() as { name: string }[]).map((c) => c.name),
    );
    if (!mcols.has("block_key")) this.#db.exec("alter table messages add column block_key text");
    this.#db.exec("create index if not exists idx_messages_block on messages (session_id, block_key)");
    this.#foldStreamedChunks();
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
    try {
      const bak = `${this.#path}.pre-fold.bak`;
      if (!fs.existsSync(bak)) {
        this.#db.exec(`vacuum into '${bak.replace(/'/g, "''")}'`);
        console.log(`[store] 折叠前已备份：${bak}`);
      }
    } catch (e) {
      console.log(`[store] 备份失败，跳过折叠以免损坏历史：${String(e)}`);
      return;
    }
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

  upsertSession(s: SessionRow): void {
    const exist = this.#db.prepare("select id from sessions where id = ?").get(s.id);
    if (exist) {
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
          `insert into sessions (id, backend, acp_session_id, cwd, title, status, pid, created_at, closed_at, modes, config_options, usage, commands, models, auto_title)
           values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(s.id, s.backend, s.acpSessionId, s.cwd, s.title, s.status, s.pid, s.createdAt, s.closedAt,
          JSON.stringify(s.modes ?? null), JSON.stringify(s.configOptions ?? []),
          JSON.stringify(s.usage ?? null), JSON.stringify(s.commands ?? []),
          JSON.stringify(s.models ?? null), s.title);
    }
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

  /** Highest persisted seq for a session (0 when empty) — the resume anchor. */
  /** When each session last received a message, as a wall clock so sessions CAN be ordered
   *  against each other — `seq` is a per-session counter (primary key is session_id+seq), so
   *  comparing it across sessions was meaningless. Sessions with no messages are absent;
   *  callers fall back to creation time. */
  lastMessageAt(): Map<string, number> {
    const rows = this.#db
      .prepare("select session_id as id, max(created_at) as at from messages group by session_id")
      .all() as unknown as { id: string; at: number }[];
    return new Map(rows.map((r) => [r.id, r.at]));
  }

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

}
