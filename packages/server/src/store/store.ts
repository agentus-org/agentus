// SQLite persistence via node:sqlite (Node >=22.5, zero deps).
// Design: sessions row carries `pid` (orphan-reclaim anchor, AC5);
// messages carry monotonic per-session `seq` (reconnect replay anchor, AC6).
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { BackendId, SessionStatus, StoredMessage } from "@agentslot/shared";

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

  constructor(path: string) {
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
        `insert into messages (seq, session_id, kind, payload, tool_call_id, created_at)
         values (?,?,?,?,?,?)`,
      )
      .run(seq, m.sessionId, m.kind, JSON.stringify(m.payload), m.toolCallId ?? null, m.createdAt);
    return { ...m, seq };
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

  /** Page BACKWARDS: the `limit` newest rows strictly before `beforeSeq`, returned
   *  oldest-first so the client can prepend without re-sorting. `hasMore` tells the
   *  UI whether an older page still exists. */
  messagesBefore(sessionId: string, beforeSeq: number, limit = 200): { messages: StoredMessage[]; hasMore: boolean } {
    const rows = this.#db
      .prepare(
        `select * from messages where session_id = ? and seq < ? order by seq desc limit ?`,
      )
      .all(sessionId, beforeSeq, limit + 1) as unknown as {
      seq: number;
      session_id: string;
      kind: StoredMessage["kind"];
      payload: string;
      tool_call_id: string | null;
      created_at: number;
    }[];
    const hasMore = rows.length > limit;
    const page = (hasMore ? rows.slice(0, limit) : rows).reverse();
    return {
      hasMore,
      messages: page.map((r) => ({
        seq: r.seq,
        sessionId: r.session_id,
        kind: r.kind,
        payload: JSON.parse(r.payload),
        toolCallId: r.tool_call_id ?? undefined,
        createdAt: r.created_at,
      })),
    };
  }

  messagesAfter(sessionId: string, afterSeq: number, limit = 500): StoredMessage[] {
    const rows = this.#db
      .prepare(
        `select * from messages where session_id = ? and seq > ? order by seq asc limit ?`,
      )
      .all(sessionId, afterSeq, limit) as unknown as {
      seq: number;
      session_id: string;
      kind: StoredMessage["kind"];
      payload: string;
      tool_call_id: string | null;
      created_at: number;
    }[];
    return rows.map((r) => ({
      seq: r.seq,
      sessionId: r.session_id,
      kind: r.kind,
      payload: JSON.parse(r.payload),
      toolCallId: r.tool_call_id ?? undefined,
      createdAt: r.created_at,
    }));
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
