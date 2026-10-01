// Cockpit state store — hand-rolled pub/sub + useSyncExternalStore.
// No third-party state lib: this UI holds zero intelligence (red line D),
// it just mirrors server events and aggregates ACP chunks into bubbles.
import type {
  ClientCommand,
  PermissionRequestView,
  ServerEvent,
  SessionInfo,
  StoredMessage,
} from "@agentslot/shared";

export type MsgView =
  | { key: string; kind: "user"; text: string }
  | { key: string; kind: "agent"; text: string; open: boolean }
  | { key: string; kind: "thought"; text: string; open: boolean }
  | { key: string; kind: "tool"; toolCallId: string; title: string; status: string; kind2: string }
  | { key: string; kind: "plan"; items: { content: string; status: string; priority?: string }[] }
  | { key: string; kind: "meta"; text: string };

export interface SessionView {
  info: SessionInfo;
  msgs: MsgView[];
  perms: PermissionRequestView[];
  busy: boolean;
  loaded: boolean; // history fetched
  lastAt: number; // last activity timestamp (idle hint anchor)
  seen: Set<number>; // ingested seqs — dedup between REST replay & WS live (QA#3)
}

/** Snapshot shape handed to useSyncExternalStore. */
export interface StoreSnapshot {
  sessions: SessionInfo[];
  archived: SessionInfo[];
  activeId: string | null;
  active: SessionView | undefined;
  conn: ConnState;
  net: NetState;
  netError: string;
  version: number;
}

export type ConnState = "connecting" | "online" | "offline";
export type NetState = "ok" | "degraded";

class Cockpit {
  sessions: SessionInfo[] = [];
  archived: SessionInfo[] = [];
  byId = new Map<string, SessionView>();
  activeId: string | null = null;
  conn: ConnState = "connecting";
  net: NetState = "ok";
  netError = "";
  lastSeq: Record<string, number> = {};
  ws: WebSocket | null = null;
  #retry = 0;
  #outbox: ClientCommand[] = [];
  #listeners = new Set<() => void>();
  #snapshot: StoreSnapshot;

  /** Remember which slot the operator was in, so a reload (or a phone waking up)
   *  lands back where they were instead of the oldest session (QA#7). */
  #rememberActive(id: string | null): void {
    try {
      if (id) localStorage.setItem("agentslot.active", id);
      else localStorage.removeItem("agentslot.active");
    } catch {
      /* private mode / storage disabled — not worth failing over */
    }
  }

  #restoreActive(): string | null {
    try {
      return localStorage.getItem("agentslot.active");
    } catch {
      return null;
    }
  }
  #version = 0;

  constructor() {
    this.#snapshot = this.#build();
  }

  /** REST with a hard timeout + one retry (QA#6: a wedged page used to hang
   *  every request forever with no feedback after a server restart).
   *  `retry: false` for non-idempotent calls — retrying POST /api/sessions
   *  would spawn a *second* agent process for one click (QA#15). */
  async #req<T>(path: string, init?: RequestInit, opts?: { timeoutMs?: number; retry?: boolean }): Promise<T> {
    const TIMEOUT_MS = opts?.timeoutMs ?? 15_000;
    const attempts = opts?.retry === false ? 1 : 2;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(path, { ...init, signal: ac.signal });
        clearTimeout(timer);
        const body = res.status === 204 ? null : await res.json().catch(() => null);
        if (!res.ok) {
          const msg = (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
          throw new Error(msg);
        }
        this.#setNet(true, "");
        return body as T;
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
        const why = (e as Error)?.name === "AbortError" ? `请求超时 ${TIMEOUT_MS / 1000}s` : String((e as Error)?.message ?? e);
        if (attempt === attempts - 1) {
          this.#setNet(false, `${why} (${path})`);
          throw new Error(why);
        }
        await new Promise((r) => setTimeout(r, 600));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  #setNet(ok: boolean, msg: string): void {
    const next: NetState = ok ? "ok" : "degraded";
    if (this.net === next && this.netError === msg) return;
    this.net = next;
    this.netError = msg;
    this.bump();
  }

  subscribe = (fn: () => void) => {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  };
  getSnapshot = () => this.#snapshot;

  #build(): StoreSnapshot {
    return {
      sessions: this.sessions,
      archived: this.archived,
      activeId: this.activeId,
      active: this.activeId ? this.byId.get(this.activeId) : undefined,
      conn: this.conn,
      net: this.net,
      netError: this.netError,
      version: this.#version,
    };
  }

  bump(): void {
    this.#version++;
    // refresh busy mirrors from info
    for (const s of this.byId.values()) s.busy = s.info.status === "running";
    this.#snapshot = this.#build();
    for (const fn of this.#listeners) fn();
  }

  connect(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.conn = "online";
      this.net = "ok";
      this.netError = "";
      this.#retry = 0;
      ws.send(JSON.stringify({ t: "resume", lastSeq: this.lastSeq } satisfies ClientCommand));
      // flush anything the operator tapped while we were offline
      while (this.#outbox.length) {
        const cmd = this.#outbox.shift()!;
        try {
          ws.send(JSON.stringify(cmd));
        } catch {
          this.#outbox.unshift(cmd);
          break;
        }
      }
      this.bump();
      void this.refreshArchived();
    };
    ws.onmessage = (ev) => this.apply(JSON.parse(ev.data) as ServerEvent);
    ws.onclose = () => {
      this.conn = "offline";
      this.bump();
      const delay = Math.min(10_000, 800 * 2 ** this.#retry++);
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  send(cmd: ClientCommand): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd));
      return;
    }
    // Phone reality: iOS/Android suspend sockets when the app backgrounds, so a
    // tap can land while we're offline. Dropping it silently would look like the
    // cockpit ate the instruction — hold it and flush on reconnect (QA#14).
    if (cmd.t === "prompt" || cmd.t === "respond-permission") {
      this.#outbox.push(cmd);
      if (this.#outbox.length > 20) this.#outbox.shift();
      this.#setNet(false, "连接已断开 — 指令已排队，重连后自动发送");
      return;
    }
    this.#setNet(false, "连接已断开 — 该操作未能送达");
  }

  setActive(id: string): void {
    this.activeId = id;
    this.#rememberActive(id);
    this.#snapshot = this.#build();
    this.bump();
    const v = this.byId.get(id);
    if (v && !v.loaded) void this.loadHistory(id);
  }

  async loadHistory(id: string): Promise<void> {
    try {
      const { messages } = await this.#req<{ messages: StoredMessage[] }>(
        `/api/sessions/${id}/messages?after=-1`,
      );
      const v = this.#view(id);
      v.seen.clear();
      v.msgs = [];
      for (const m of messages) this.#ingest(v, m);
      v.loaded = true;
      this.#keepLastOpen(v); // mid-turn: resume appending into the open bubble
      this.bump();
    } catch {
      /* offline etc */
    }
  }

  /** Backend list for the new-slot dialog; surfaces failures instead of
   *  silently degrading to a single fallback button (QA#6). */
  async loadBackends(): Promise<
    { id: string; label: string; home?: string | null; blocked?: string | null }[]
  > {
    return await this.#req<{ id: string; label: string; home?: string | null; blocked?: string | null }[]>(
      "/api/backends",
    );
  }

  async createSession(backend: string, cwd: string, title: string): Promise<string> {
    // spawning a real agent boots a python process (hermes: 10-40s) — long
    // timeout, and NO retry: a retry would spawn a second child for one click
    const body = await this.#req<SessionInfo>(
      "/api/sessions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ backend, cwd, title: title || undefined }),
      },
      { timeoutMs: 120_000, retry: false },
    );
    this.bump();
    return body.id;
  }

  /** Pull the cold-slot list (sessions on disk with no live process, QA#8/AC5).
   *  Kept as REST (not a WS event) so the rail still fills when the socket is down. */
  async refreshArchived(): Promise<void> {
    try {
      const { archived } = await this.#req<{ archived: SessionInfo[] }>("/api/sessions");
      this.archived = archived ?? [];
      this.bump();
    } catch {
      /* rail stays as-is; the net banner already reports the trouble */
    }
  }

  /** Wake a cold slot: respawn its agent + loadSession, then focus it. */
  async resume(id: string): Promise<void> {
    try {
      const info = await this.#req<SessionInfo>(`/api/sessions/${id}/resume`, { method: "POST" }, { timeoutMs: 120_000, retry: false });
      this.#view(id).info = info;
      if (!this.sessions.some((s) => s.id === id)) this.sessions = [info, ...this.sessions];
      this.archived = this.archived.filter((s) => s.id !== id);
      this.setActive(id);
      await this.loadHistory(id);
    } catch (e) {
      this.#setNet(false, `恢复失败：${String((e as Error).message ?? e)}`);
    }
  }

  closeSession(id: string): void {
    void this.#req(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
    this.byId.delete(id);
    if (this.activeId === id) {
      const next = this.sessions.find((s) => s.id !== id);
      this.activeId = next?.id ?? null;
      this.#rememberActive(this.activeId);
    }
    this.sessions = this.sessions.filter((s) => s.id !== id);
    this.bump();
    // the closed transcript is still on disk → show it as a cold slot right away
    void this.refreshArchived();
  }

  #view(id: string): SessionView {
    let v = this.byId.get(id);
    if (!v) {
      v = {
        info: this.sessions.find((s) => s.id === id) ?? ({ id } as never),
        msgs: [], perms: [], busy: false, loaded: false, lastAt: Date.now(), seen: new Set(),
      };
      this.byId.set(id, v);
    }
    return v;
  }

  apply(e: ServerEvent): void {
    switch (e.t) {
      case "hello":
        break;
      case "sessions": {
        const live = new Set(e.sessions.map((s) => s.id));
        this.sessions = e.sessions;
        for (const s of e.sessions) this.#view(s.id).info = s;
        // prune views whose session vanished server-side (restart / close elsewhere)
        for (const id of [...this.byId.keys()]) if (!live.has(id)) this.byId.delete(id);
        if (this.activeId && !live.has(this.activeId)) {
          this.activeId = null;
          this.#rememberActive(null);
        }
        if (!this.activeId && e.sessions.length) {
          // restore the slot the operator left, else the newest one (server list
          // is already newest-first — QA#7)
          const remembered = this.#restoreActive();
          const pick = remembered && live.has(remembered) ? remembered : e.sessions[0].id;
          this.activeId = pick;
          void this.loadHistory(pick);
        }
        break;
      }
      case "session": {
        this.sessions = this.sessions.map((s) => (s.id === e.session.id ? e.session : s));
        if (!this.sessions.some((s) => s.id === e.session.id)) this.sessions.push(e.session);
        this.#view(e.session.id).info = e.session;
        break;
      }
      case "messages": {
        const v = this.#view(e.sessionId);
        if (e.partial) {
          // reconnect tail (resume): merge into what we already rendered.
          // seq-dedup in #ingest drops the overlap; a rebuild here would lose
          // everything before the drop (QA#17).
          for (const m of e.messages) this.#ingest(v, m);
          v.lastAt = Date.now();
          break;
        }
        // authoritative full replay: rebuild from scratch (server wrote every row
        // to SQLite before emitting, so snapshot ⊇ anything we saw live)
        v.seen.clear();
        v.msgs = [];
        this.#endOpenBubbles(v);
        for (const m of e.messages) this.#ingest(v, m);
        v.loaded = true;
        break;
      }
      case "message": {
        const v = this.#view(e.message.sessionId);
        this.#ingest(v, e.message);
        v.lastAt = Date.now();
        this.lastSeq[e.message.sessionId] = Math.max(this.lastSeq[e.message.sessionId] ?? 0, e.message.seq);
        break;
      }
      case "turn-start": {
        const v = this.#view(e.sessionId);
        v.busy = true;
        v.lastAt = Date.now();
        this.#endOpenBubbles(v); // new turn => fresh bubbles
        break;
      }
      case "turn-end": {
        const v = this.#view(e.sessionId);
        v.busy = false;
        this.#endOpenBubbles(v);
        if (e.error) v.msgs.push({ key: `err-${Date.now()}`, kind: "meta", text: e.error });
        break;
      }
      case "permission":
        this.#view(e.request.sessionId).perms.push(e.request);
        break;
      case "permission-resolved":
        for (const v of this.byId.values()) v.perms = v.perms.filter((p) => p.requestId !== e.requestId);
        break;
      case "error": {
        if (this.activeId) {
          const v = this.#view(this.activeId);
          v.msgs.push({ key: `e-${Date.now()}`, kind: "meta", text: e.error });
        }
        break;
      }
      default:
        break;
    }
    this.bump();
  }

  #endOpenBubbles(v: SessionView): void {
    for (const m of v.msgs) if (m.kind === "agent" || m.kind === "thought") m.open = false;
  }

  #keepLastOpen(v: SessionView): void {
    const l = v.msgs[v.msgs.length - 1];
    if (l && (l.kind === "agent" || l.kind === "thought") && v.busy) l.open = true;
  }

  #ingest(v: SessionView, m: StoredMessage): void {
    // Dedup REST-replay vs WS-live (QA#3) — but ONLY for append-only rows.
    // Tool rows are upserted server-side keeping their original seq, so a
    // seq-based guard would swallow every tool_call_update (QA#12: the card
    // stayed "pending" live while a reload showed "completed").
    const upsertRow = m.kind === "tool" || m.kind === "meta" || m.seq <= 0;
    if (!upsertRow) {
      if (v.seen.has(m.seq)) return;
      v.seen.add(m.seq);
    }
    const p = m.payload as Record<string, unknown>;
    const text = extractText(p);
    const last = v.msgs[v.msgs.length - 1];
    switch (m.kind) {
      case "user":
        v.msgs.push({ key: `m${m.seq}`, kind: "user", text: String(p.text ?? "") });
        break;
      case "agent":
        if (last && last.kind === "agent" && last.open) last.text += text;
        else v.msgs.push({ key: `m${m.seq}`, kind: "agent", text, open: true });
        break;
      case "thought":
        if (last && last.kind === "thought" && last.open) last.text += text;
        else v.msgs.push({ key: `m${m.seq}`, kind: "thought", text, open: true });
        break;
      case "tool": {
        const tcId = String(p.toolCallId ?? m.toolCallId ?? m.seq);
        const existing = v.msgs.find(
          (x) => x.kind === "tool" && x.toolCallId === tcId,
        ) as Extract<MsgView, { kind: "tool" }> | undefined;
        // upsert semantics (design.md §8-5): update, never append a second bubble
        if (existing) {
          if (p.title) existing.title = String(p.title);
          if (p.status) existing.status = String(p.status);
        } else {
          v.msgs.push({
            key: `tc-${tcId}`, kind: "tool", toolCallId: tcId,
            title: String(p.title ?? "tool call"), status: String(p.status ?? "pending"),
            kind2: String(p.kind ?? ""),
          });
        }
        break;
      }
      case "plan": {
        const items = ((p.entries ?? []) as { content: string; status: string; priority?: string }[]);
        const existing = v.msgs.find((x) => x.kind === "plan");
        if (existing && existing.kind === "plan") existing.items = items;
        else v.msgs.push({ key: `m${m.seq}`, kind: "plan", items });
        break;
      }
      case "meta":
        v.msgs.push({ key: `m${m.seq}`, kind: "meta", text: text || JSON.stringify(p) });
        break;
    }
    this.lastSeq[v.info.id] = Math.max(this.lastSeq[v.info.id] ?? 0, m.seq);
  }
}

function extractText(payload: Record<string, unknown>): string {
  const c = payload.content as { type?: string; text?: string } | undefined;
  if (c?.type === "text" && typeof c.text === "string") return c.text;
  return "";
}

export const cockpit = new Cockpit();
