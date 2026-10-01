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

export type ConnState = "connecting" | "online" | "offline";

class Cockpit {
  sessions: SessionInfo[] = [];
  byId = new Map<string, SessionView>();
  activeId: string | null = null;
  conn: ConnState = "connecting";
  lastSeq: Record<string, number> = {};
  ws: WebSocket | null = null;
  #retry = 0;
  #listeners = new Set<() => void>();
  #snapshot: StoreSnapshot;
  #version = 0;

  constructor() {
    this.#snapshot = this.#build();
  }

  subscribe = (fn: () => void) => {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  };
  getSnapshot = () => this.#snapshot;

  #build(): StoreSnapshot {
    return {
      sessions: this.sessions,
      activeId: this.activeId,
      active: this.activeId ? this.byId.get(this.activeId) : undefined,
      conn: this.conn,
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
      this.#retry = 0;
      ws.send(JSON.stringify({ t: "resume", lastSeq: this.lastSeq } satisfies ClientCommand));
      this.bump();
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
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(cmd));
  }

  setActive(id: string): void {
    this.activeId = id;
    this.#snapshot = this.#build();
    this.bump();
    const v = this.byId.get(id);
    if (v && !v.loaded) void this.loadHistory(id);
  }

  async loadHistory(id: string): Promise<void> {
    try {
      const res = await fetch(`/api/sessions/${id}/messages?after=-1`);
      if (!res.ok) return;
      const { messages } = (await res.json()) as { messages: StoredMessage[] };
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

  async createSession(backend: string, cwd: string, title: string): Promise<string> {
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ backend, cwd, title: title || undefined }),
    });
    const body = (await res.json()) as SessionInfo & { error?: string };
    if (!res.ok) throw new Error(body.error ?? "create failed");
    this.bump();
    return body.id;
  }

  closeSession(id: string): void {
    void fetch(`/api/sessions/${id}`, { method: "DELETE" });
    this.byId.delete(id);
    if (this.activeId === id) {
      const next = this.sessions.find((s) => s.id !== id);
      this.activeId = next?.id ?? null;
    }
    this.bump();
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
        if (this.activeId && !live.has(this.activeId)) this.activeId = null;
        if (!this.activeId && e.sessions.length) {
          this.activeId = e.sessions[0].id;
          void this.loadHistory(this.activeId);
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
    if (v.seen.has(m.seq)) return; // dedup REST-replay vs WS-live (QA#3)
    v.seen.add(m.seq);
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
export type StoreSnapshot = {
  sessions: SessionInfo[];
  activeId: string | null;
  active: SessionView | undefined;
  conn: ConnState;
  version: number;
};
