// SQLite persistence via node:sqlite (Node >=22.5, zero deps).
// Design: sessions row carries `pid` (orphan-reclaim anchor, AC5);
// messages carry monotonic per-session `seq` (reconnect replay anchor, AC6).
import { DatabaseSync } from "node:sqlite";
import type { BackendId, SessionStatus, StoredMessage } from "@agentslot/shared";

export interface SessionRow {
  id: string;
  backend: BackendId;
  acpSessionId: string | null;
  cwd: string;
  title: string;
  status: SessionStatus;
  pid: number | null;
  createdAt: number;
  closedAt: number | null;
  /** JSON round-trip of the ACP mode state + config options, so a resumed
   *  session (M4-lite) comes back with the operator's mode/effort intact. */
  modes?: unknown;
  configOptions?: unknown;
}

interface RawSessionRow {
  id: string; backend: BackendId; acp_session_id: string | null; cwd: string;
  title: string; status: SessionStatus; pid: number | null;
  created_at: number; closed_at: number | null;
  modes?: string | null; config_options?: string | null;
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
    title: r.title, status: r.status, pid: r.pid,
    createdAt: r.created_at, closedAt: r.closed_at,
    modes: parseJson(r.modes), configOptions: parseJson(r.config_options) ?? [],
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
    `);
    // additive migration: mode/config persistence for resume (M4-lite)
    const cols = new Set(
      (this.#db.prepare("pragma table_info(sessions)").all() as { name: string }[]).map((c) => c.name),
    );
    for (const col of ["modes", "config_options"]) {
      if (!cols.has(col)) this.#db.exec(`alter table sessions add column ${col} text`);
    }
  }

  upsertSession(s: SessionRow): void {
    const exist = this.#db.prepare("select id from sessions where id = ?").get(s.id);
    if (exist) {
      this.#db
        .prepare(
          `update sessions set backend=?, acp_session_id=?, cwd=?, title=?, status=?, pid=?, closed_at=?, modes=?, config_options=? where id=?`,
        )
        .run(s.backend, s.acpSessionId, s.cwd, s.title, s.status, s.pid, s.closedAt,
          JSON.stringify(s.modes ?? null), JSON.stringify(s.configOptions ?? []), s.id);
    } else {
      this.#db
        .prepare(
          `insert into sessions (id, backend, acp_session_id, cwd, title, status, pid, created_at, closed_at, modes, config_options)
           values (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(s.id, s.backend, s.acpSessionId, s.cwd, s.title, s.status, s.pid, s.createdAt, s.closedAt,
          JSON.stringify(s.modes ?? null), JSON.stringify(s.configOptions ?? []));
    }
  }

  listSessions(includeClosed = true): SessionRow[] {
    const where = includeClosed ? "" : "where status != 'closed'";
    const rows = this.#db
      .prepare(`select * from sessions ${where} order by created_at desc`)
      .all() as unknown as RawSessionRow[];
    return rows.map(rowToSession);
  }

  getSession(id: string): SessionRow | undefined {
    const r = this.#db.prepare("select * from sessions where id = ?").get(id) as
      | RawSessionRow
      | undefined;
    return r ? rowToSession(r) : undefined;
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
}
