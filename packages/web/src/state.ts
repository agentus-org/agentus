// Cockpit state store — hand-rolled pub/sub + useSyncExternalStore.
// No third-party state lib: this UI holds zero intelligence (red line D),
// it just mirrors server events and aggregates ACP chunks into bubbles.
import type {
  ClientCommand,
  PermissionRequestView,
  ServerEvent,
  SessionInfo,
  StoredMessage,
  TurnTrace,
} from "@agentslot/shared";
import { blockKeyOf, foldTextRow, reindexBlocks } from "./transcript";

export type MsgView =
  | { key: string; kind: "user"; text: string; files: { kind: string; name: string }[] }
  | { key: string; kind: "agent"; text: string; open: boolean }
  | { key: string; kind: "thought"; text: string; open: boolean }
  | {
      key: string; kind: "tool"; toolCallId: string; title: string; status: string; kind2: string;
      /** best-effort detail: tool output/content text (AionUi F-DISPLAY-03 wants it viewable) */
      detail: string;
      /** tool input as the agent reported it (rawArgs/title-adjacent metadata) */
      input: string;
    }
  | { key: string; kind: "plan"; items: { content: string; status: string; priority?: string }[] }
  | { key: string; kind: "meta"; text: string };

export interface SessionView {
  info: SessionInfo;
  msgs: MsgView[];
  perms: PermissionRequestView[];
  busy: boolean;
  loaded: boolean; // history fetched
  /** an older page exists on disk (M4: long slots are paged, not truncated) */
  hasOlder: boolean;
  loadingOlder: boolean;
  /** lowest seq currently held — the backwards-paging anchor */
  minSeq: number | null;
  lastAt: number; // last activity timestamp (idle hint anchor)
  /** bumps on every ingested row. Messages are aggregated in place (chunks merge into
   *  the bubble above them), so the array identity never changes — anything that needs
   *  to react to "new output arrived" (the auto-follow effect, the unseen badge) must
   *  key off this instead. Without it a streamed chunk could land with nobody noticing. */
  rev: number;
  seen: Set<number>; // ingested seqs — dedup between REST replay & WS live (QA#3)
  /** `kind:messageId` → index in `msgs`: how a chunk finds ITS OWN block even when other messages
   *  (thinking, tool cards) arrived in between, or when it came from a history page (see
   *  transcript.ts). Rebuilt whenever the list is rebuilt or prepended to. */
  blocks: Map<string, number>;
  /** latest turn's provenance (model/effort/mode) — shown once per turn */
  trace?: TurnTrace | null;
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
  auth: AuthState;
  authInfo: AuthInfo | null;
  authError: string;
  authBusy: boolean;
  version: number;
}

export type ConnState = "connecting" | "online" | "offline";
export type NetState = "ok" | "degraded";
/** `unknown` = we have not asked yet (show a splash, not the login form) */
export type AuthState = "unknown" | "in" | "out";

export interface AuthInfo {
  authEnabled: boolean;
  authenticated: boolean;
  kind: "session" | "token" | null;
  username: string | null;
  expiresAt: number | null;
  usingDefaultPassword: boolean;
}

/** Thrown instead of a generic error when the server says 401: the caller must
 *  show the login view, not a "network degraded" banner (a retry cannot help). */
class AuthRequired extends Error {
  constructor() {
    super("unauthorized");
    this.name = "AuthRequired";
  }
}

class Cockpit {
  sessions: SessionInfo[] = [];
  archived: SessionInfo[] = [];
  byId = new Map<string, SessionView>();
  activeId: string | null = null;
  conn: ConnState = "connecting";
  net: NetState = "ok";
  netError = "";
  auth: AuthState = "unknown";
  authInfo: AuthInfo | null = null;
  authError = "";
  authBusy = false;
  lastSeq: Record<string, number> = {};
  ws: WebSocket | null = null;
  #retry = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
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

  /** `?session=<id>` — the slot a notification tap (or a shared link) asked for.
   *
   *  Read ONCE and then dropped from the URL: the parameter decides where we land, but the operator
   *  switching slots afterwards must not be overridden by a stale query string on a later reconnect.
   *  This is the other half of the tap-to-open contract — the app navigates here, the page picks it up. */
  #openTarget(): string | null {
    try {
      const here = new URL(location.href);
      const want = here.searchParams.get("session");
      if (!want) return null;
      here.searchParams.delete("session");
      history.replaceState(null, "", here.toString());
      return want;
    } catch {
      return null;
    }
  }

  #restoreActive(): string | null {
    const target = this.#openTarget();
    if (target) {
      this.#rememberActive(target);
      return target;
    }
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
        if (res.status === 401) {
          // Cookie expired / revoked: retrying cannot help, and a "network
          // degraded" banner would misdiagnose it. Flip to the login view.
          this.#setLoggedOut("会话已过期，请重新登录");
          throw new AuthRequired();
        }
        const body = res.status === 204 ? null : await res.json().catch(() => null);
        if (!res.ok) {
          const msg = (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
          throw new Error(msg);
        }
        this.#setNet(true, "");
        return body as T;
      } catch (e) {
        clearTimeout(timer);
        if (e instanceof AuthRequired) throw e; // already handled above
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

  // ---- auth ----------------------------------------------------------------

  #setLoggedOut(reason: string): void {
    const wasIn = this.auth === "in";
    this.auth = "out";
    this.authError = wasIn ? reason : this.authError;
    if (this.ws) {
      // Drop the socket *before* nulling it so its onclose handler cannot start a
      // reconnect loop we just decided to stop.
      const ws = this.ws;
      this.ws = null;
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    this.conn = "offline";
    if (wasIn || this.sessions.length) {
      this.sessions = [];
      this.archived = [];
      this.byId.clear();
      this.activeId = null;
      this.#rememberActive(null);
    }
    this.bump();
  }

  /** Ask the server who we are. Called once at boot: the answer decides whether
   *  we render the cockpit or the login view (and whether opening a WS is even
   *  worth it — an unauthenticated upgrade is refused with 401). */
  async checkAuth(): Promise<void> {
    try {
      const info = await this.#req<AuthInfo>("/api/auth/me", undefined, { retry: false, timeoutMs: 8000 });
      this.authInfo = info;
      if (info.authEnabled && !info.authenticated) {
        this.#setLoggedOut("");
        this.authError = "";
        return;
      }
      this.#retry = 0;
      this.auth = "in";
      this.authError = "";
      this.bump();
      this.connect();
      void this.refreshArchived();
    } catch (e) {
      if (e instanceof AuthRequired) return; // #req already flipped us out
      const msg = `无法连接服务端：${String((e as Error).message ?? e)}`;
      if (this.auth === "in") {
        // Transient outage (server restarting): keep the cockpit and let the net
        // banner explain. Flipping to the login view here would lose the
        // operator's place for a problem that fixes itself.
        this.#setNet(false, msg);
        this.#scheduleRecheck(Math.min(10_000, 800 * 2 ** this.#retry++));
        return;
      }
      this.auth = "out";
      this.authError = msg;
      this.bump();
    }
  }

  /** One pending re-check at a time: onclose and a failed check must not stack
   *  into overlapping retry loops (that is how a phone in a lift hammers a server). */
  #scheduleRecheck(ms: number): void {
    if (this.#retryTimer) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      void this.checkAuth();
    }, ms);
  }

  /** Operator login. Errors are surfaced in the form, never as a net banner. */
  async login(username: string, password: string): Promise<boolean> {
    if (this.authBusy) return false;
    this.authBusy = true;
    this.authError = "";
    this.bump();
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.status === 401) {
        this.authError = "用户名或密码不正确";
        return false;
      }
      if (res.status === 429) {
        const body = (await res.json().catch(() => ({}))) as { retryAfterMs?: number };
        const secs = Math.ceil((body.retryAfterMs ?? 30_000) / 1000);
        this.authError = `尝试次数过多，请 ${secs} 秒后再试`;
        return false;
      }
      if (!res.ok) {
        this.authError = `登录失败：HTTP ${res.status}`;
        return false;
      }
      const body = (await res.json()) as { username: string; expiresAt: number };
      this.authInfo = {
        authEnabled: true, authenticated: true, kind: "session",
        username: body.username, expiresAt: body.expiresAt ?? null,
        usingDefaultPassword: Boolean((body as { usingDefaultPassword?: boolean }).usingDefaultPassword),
      };
      this.auth = "in";
      this.authError = "";
      this.bump();
      this.connect();
      return true;
    } catch (e) {
      this.authError = `登录请求失败：${String((e as Error).message ?? e)}`;
      return false;
    } finally {
      this.authBusy = false;
      this.bump();
    }
  }

  async logout(): Promise<void> {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* the cookie may already be gone; the local flip below is what matters */
    }
    this.#setLoggedOut("");
    this.authError = "";
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
      auth: this.auth,
      authInfo: this.authInfo,
      authError: this.authError,
      authBusy: this.authBusy,
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
    if (this.auth === "out") return; // the upgrade would be refused with 401
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
      if (this.auth === "out") return;
      const delay = Math.min(10_000, 800 * 2 ** this.#retry++);
      // A refused upgrade is indistinguishable from a network drop in the browser
      // (both surface as close code 1006), so re-ask /api/auth/me before dialling
      // again. That is how an expired cookie becomes a login screen instead of a
      // socket retrying forever behind a "reconnecting" spinner.
      this.#scheduleRecheck(delay);
    };
    ws.onerror = () => ws.close();
  }

  send(cmd: ClientCommand): void {
    if (this.auth === "out") {
      // Queueing here would promise a delivery that can never happen.
      this.#setNet(false, "未登录 — 请先登录再发送指令");
      return;
    }
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
      // tail: open on the NEWEST page (a long slot must not open on its oldest rows)
      const { messages, hasOlder } = await this.#req<{ messages: StoredMessage[]; hasOlder?: boolean }>(
        `/api/sessions/${id}/messages?tail=1`,
      );
      const v = this.#view(id);
      v.seen.clear();
      v.msgs = [];
      v.blocks.clear();
      v.minSeq = null;
      for (const m of messages) this.#ingest(v, m);
      v.loaded = true;
      v.hasOlder = Boolean(hasOlder);
      this.#keepLastOpen(v); // mid-turn: resume appending into the open bubble
      this.bump();
    } catch {
      /* offline etc */
    }
  }

  /** Page backwards through a long transcript (M4). Older rows are prepended in order
   *  and deduped through the same `seen` set, so a WS replay racing the fetch cannot
   *  double-render a message. */
  async loadEarlier(id: string): Promise<void> {
    const v = this.#view(id);
    if (v.loadingOlder || !v.hasOlder || v.minSeq == null) return;
    v.loadingOlder = true;
    this.bump();
    try {
      const { messages, hasOlder } = await this.#req<{ messages: StoredMessage[]; hasOlder?: boolean }>(
        `/api/sessions/${id}/messages?before=${v.minSeq}`,
      );
      // Fold the page into a scratch list, then merge it in BY BLOCK KEY: a message that straddles
      // the page boundary (or that we already hold live) must stay ONE bubble — the older page only
      // adds what the view does not have yet.
      const page: MsgView[] = [];
      const pageIndex = new Map<string, number>();
      for (const m of messages) this.#ingest(v, m, { list: page, index: pageIndex });
      const fresh: MsgView[] = [];
      for (const b of page) {
        const at = v.blocks.get(b.key);
        const have = at === undefined ? undefined : v.msgs[at];
        if (have && have.kind === b.kind && (b.kind === "agent" || b.kind === "thought") && have.kind === b.kind) {
          // the store's row is the truth, but a live block can be ahead of a stale page
          const live = have as Extract<MsgView, { kind: "agent" | "thought" }>;
          const older = b as Extract<MsgView, { kind: "agent" | "thought" }>;
          if (older.text.length > live.text.length) live.text = older.text;
          continue;
        }
        fresh.push(b);
      }
      if (fresh.length) v.msgs = [...fresh, ...v.msgs];
      v.blocks = reindexBlocks(v.msgs);
      v.hasOlder = Boolean(hasOlder);
    } catch {
      /* keep hasOlder so the affordance stays for a retry */
    } finally {
      v.loadingOlder = false;
      this.bump();
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

  /** One directory level for the workspace panel (files included). */
  async listEntries(path: string): Promise<{
    path: string; parent: string | null; home: string; root?: string | null;
    entries: { name: string; path: string; kind: "dir" | "file"; size?: number }[];
    truncated: boolean;
  }> {
    return await this.#req(`/api/fs/dirs?files=1&path=${encodeURIComponent(path)}`);
  }

  /** Read-only file preview for the panel. */
  async readFile(path: string): Promise<{
    path: string; name: string; size: number; content: string; truncated: boolean; binary: boolean;
  }> {
    return await this.#req(`/api/fs/file?path=${encodeURIComponent(path)}`);
  }

  /** Fork a session: the agent copies its context into a new session (ACP
   *  `session/fork`), and we bring that up as its own session. Resolves to the new one. */
  async fork(id: string): Promise<string> {
    const info = await this.#req<SessionInfo>(`/api/sessions/${id}/fork`, { method: "POST" },
      // the source may need resuming first, and the fork itself is a spawn + load
      { timeoutMs: 120_000, retry: false });
    if (!this.sessions.some((s) => s.id === info.id)) this.sessions = [info, ...this.sessions];
    this.archived = this.archived.filter((s) => s.id !== info.id);
    this.setActive(info.id);
    return info.id;
  }

  /** Switch the model of a live slot (ACP `session/set_model`). */
  async setModel(id: string, modelId: string): Promise<void> {
    // The agent may re-init its provider client when the model changes (Hermes rebuilds
    // the session), which takes a while — a short timeout here shows a bogus "network
    // degraded" banner for a switch that is actually in flight. No retry: a retry would
    // re-send the switch.
    const info = await this.#req<SessionInfo>(`/api/sessions/${id}/model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelId }),
    }, { timeoutMs: 90_000, retry: false });
    const view = this.byId.get(id);
    if (view) view.info = { ...view.info, ...info };
    const i = this.sessions.findIndex((s) => s.id === id);
    if (i >= 0) this.sessions[i] = { ...this.sessions[i], ...info };
    this.bump();
  }

  /** The operator's context-window override (null = whatever the agent reports). */
  async setContextLimit(
    id: string,
    limit: number | null,
    opts: { remember?: boolean; forgetModel?: boolean } = {},
  ): Promise<void> {
    const info = await this.#req<SessionInfo>(`/api/sessions/${id}/context-limit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit, ...opts }),
    });
    const view = this.byId.get(id);
    if (view) view.info = { ...view.info, ...info };
    const i = this.sessions.findIndex((s) => s.id === id);
    if (i >= 0) this.sessions[i] = { ...this.sessions[i], ...info };
    const j = this.archived.findIndex((s) => s.id === id);
    if (j >= 0) this.archived[j] = { ...this.archived[j], ...info };
    this.bump();
  }

  /** Point a slot at another directory. Live slot: the panels move now and the next
   *  resume starts there; the running agent keeps the cwd it was spawned with. */
  async setWorkspace(id: string, path: string): Promise<void> {
    const info = await this.#req<SessionInfo>(`/api/sessions/${id}/workspace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const view = this.byId.get(id);
    if (view) view.info = { ...view.info, ...info };
    const i = this.sessions.findIndex((s) => s.id === id);
    if (i >= 0) this.sessions[i] = { ...this.sessions[i], ...info };
    this.bump();
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
  /** Rename a slot. Display state only — the agent is never told, and a COLD slot can be
   *  renamed without waking it up (why the server keeps the generated title aside).
   *  `null` clears back to that generated name. */
  async rename(id: string, title: string | null): Promise<SessionInfo> {
    const info = await this.#req<SessionInfo>(`/api/sessions/${id}/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    const view = this.byId.get(id);
    if (view) view.info = { ...view.info, ...info };
    for (const list of [this.sessions, this.archived]) {
      const i = list.findIndex((s) => s.id === id);
      if (i >= 0) list[i] = { ...list[i], ...info };
    }
    this.bump();
    return info;
  }

  /** Ask for a fresh name derived from the CURRENT conversation. The server summarises via a
   *  throwaway fork of the session when the agent supports it (`via: "agent"`), and otherwise
   *  names it after the latest prompt (`via: "derived"`) — either way the row updates here.
   *  Unlike rename() this WINS over a hand-written name: the operator asked for a new one. */
  async regenerateTitle(id: string): Promise<{ info: SessionInfo; via: "agent" | "derived" }> {
    const res = await this.#req<{ info: SessionInfo; via: "agent" | "derived" }>(
      `/api/sessions/${id}/title/regenerate`,
      { method: "POST" },
    );
    const info = res.info;
    const view = this.byId.get(id);
    if (view) view.info = { ...view.info, ...info };
    for (const list of [this.sessions, this.archived]) {
      const i = list.findIndex((s) => s.id === id);
      if (i >= 0) list[i] = { ...list[i], ...info };
    }
    this.bump();
    return res;
  }

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

  /** Delete a cold slot for good (row + transcript). The rail only ever grows
   *  otherwise — "on disk · N" with no way back down. */
  purgeCold(id: string): void {
    this.archived = this.archived.filter((s) => s.id !== id);
    this.byId.delete(id);
    this.bump();
    void this.#req(`/api/sessions/${id}`, { method: "DELETE" })
      .catch(() => this.refreshArchived())
      .then(() => this.refreshArchived());
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
        msgs: [], perms: [], busy: false, loaded: false, hasOlder: false, loadingOlder: false,
        minSeq: null, lastAt: Date.now(), rev: 0, seen: new Set(), blocks: new Map(),
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
        v.blocks.clear();
        this.#endOpenBubbles(v);
        for (const m of e.messages) this.#ingest(v, m);
        v.loaded = true;
        break;
      }
      case "message": {
        const v = this.#view(e.message.sessionId);
        // `delta` is present when this frame GREW a block we already hold (the store accumulates one
        // row per message now); without it the row is the whole truth and replaces the block's text.
        // `n` is that block's total length — the frame's version, since a grown row keeps its seq.
        this.#ingest(v, e.message, { delta: e.delta, n: e.n });
        v.lastAt = Date.now();
        this.lastSeq[e.message.sessionId] = Math.max(this.lastSeq[e.message.sessionId] ?? 0, e.message.seq);
        break;
      }
      case "turn-start": {
        const v = this.#view(e.sessionId);
        v.busy = true;
        v.lastAt = Date.now();
        v.trace = e.trace ?? null;
        this.#endOpenBubbles(v); // new turn => fresh bubbles
        break;
      }
      case "usage": {
        const v = this.#view(e.sessionId);
        v.info = { ...v.info, usage: e.usage };
        v.lastAt = Date.now();
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

  #ingest(
    v: SessionView,
    m: StoredMessage,
    opts?: { delta?: string; n?: number; list?: MsgView[]; index?: Map<string, number> },
  ): void {
    // A page of older rows is folded into a scratch list first (so it can be merged by block key
    // with what is already on screen), the live stream folds into the view itself.
    const list = opts?.list ?? v.msgs;
    const index = opts?.index ?? v.blocks;
    const delta = opts?.delta;
    // Dedup REST-replay vs WS-live (QA#3) — but ONLY for append-only rows.
    // Tool rows are upserted server-side keeping their original seq, so a
    // seq-based guard would swallow every tool_call_update (QA#12: the card
    // stayed "pending" live while a reload showed "completed").
    // A streamed text block that GREW is the same story: the store folds one message into ONE row and
    // that row KEEPS ITS SEQ, so a seq guard dropped every chunk after the first (measured on a phone:
    // a bubble reading "不是" and the rest of the reply nowhere). Growing frames carry `n` — the
    // block's total length — and are guarded by that instead (transcript.planTextFrame).
    const grew = delta !== undefined;
    const upsertRow = m.kind === "tool" || m.kind === "meta" || m.seq <= 0 || grew;
    if (!upsertRow) {
      if (v.seen.has(m.seq)) return;
      v.seen.add(m.seq);
    }
    // paging anchor: the lowest seq we hold, whatever the row kind (tool rows are
    // upserted but still carry the seq the store assigned them)
    if (m.seq > 0 && (v.minSeq == null || m.seq < v.minSeq)) v.minSeq = m.seq;
    const p = m.payload as Record<string, unknown>;
    const text = extractText(p);
    const last = list[list.length - 1];
    switch (m.kind) {
      case "user":
        list.push({
          key: `m${m.seq}`, kind: "user", text: String(p.text ?? ""),
          // names only — the bytes were never persisted (AttachmentSummary)
          files: Array.isArray(p.attachments)
            ? (p.attachments as { kind?: unknown; name?: unknown }[])
                .map((a) => ({ kind: String(a.kind ?? ""), name: String(a.name ?? "file") }))
            : [],
        });
        break;
      // Streamed text: one message is one bubble, found by its `messageId` — a history page can no
      // longer split a reply (or a markdown table) in half, and a re-sent block does not become a
      // second bubble. See transcript.ts for why both of those needed their own rule.
      case "agent":
      case "thought": {
        const kind = m.kind;
        const key = blockKeyOf(kind, p);
        const { at } = foldTextRow(
          list,
          index,
          { key, kind, text, delta, n: opts?.n },
          (k, row) => ({ key: k, kind: row.kind, text: row.text, open: true }),
        );
        // A live frame keeps ITS bubble marked as the growing one, even when a tool card or a
        // thinking block arrived after it: that flag is what draws the streaming state.
        const block = list[at];
        if (delta !== undefined && block && (block.kind === "agent" || block.kind === "thought")) {
          block.open = true;
        }
        break;
      }
      case "tool": {
        const tcId = String(p.toolCallId ?? m.toolCallId ?? m.seq);
        const existing = list.find(
          (x) => x.kind === "tool" && x.toolCallId === tcId,
        ) as Extract<MsgView, { kind: "tool" }> | undefined;
        const detail = extractToolDetail(p);
        const input = extractToolInput(p);
        // upsert semantics (design.md §8-5): update, never append a second bubble
        if (existing) {
          if (p.title) existing.title = String(p.title);
          if (p.status) existing.status = String(p.status);
          // output grows across tool_call_update frames — replace, never append twice
          if (detail) existing.detail = detail;
          if (input) existing.input = input;
        } else {
          list.push({
            key: `tc-${tcId}`, kind: "tool", toolCallId: tcId,
            title: String(p.title ?? "tool call"), status: String(p.status ?? "pending"),
            kind2: String(p.kind ?? ""), detail, input,
          });
        }
        break;
      }
      case "plan": {
        const items = ((p.entries ?? []) as { content: string; status: string; priority?: string }[]);
        const existing = list.find((x) => x.kind === "plan");
        if (existing && existing.kind === "plan") existing.items = items;
        else list.push({ key: `m${m.seq}`, kind: "plan", items });
        break;
      }
      case "meta":
        list.push({ key: `m${m.seq}`, kind: "meta", text: text || JSON.stringify(p) });
        break;
    }
    this.lastSeq[v.info.id] = Math.max(this.lastSeq[v.info.id] ?? 0, m.seq);
    v.rev += 1;
    v.lastAt = Date.now();
  }
}

function extractText(payload: Record<string, unknown>): string {
  const c = payload.content as { type?: string; text?: string } | undefined;
  if (c?.type === "text" && typeof c.text === "string") return c.text;
  return "";
}

/** Tool output as text. ACP carries it as rawOutput, or as `content` items
 *  ({type:"content",content:{type:"text"}} / {type:"diff",path,...}); terminal-style
 *  tools put the captured stdout there too. Capped: a cockpit bubble is not a log viewer. */
function extractToolDetail(p: Record<string, unknown>): string {
  const MAX = 4000;
  const clip = (s: string): string => (s.length > MAX ? `${s.slice(0, MAX)}\n… (${s.length - MAX} more chars)` : s);
  const raw = p.rawOutput;
  if (typeof raw === "string" && raw.trim()) return clip(raw);
  if (raw && typeof raw === "object") {
    try {
      return clip(JSON.stringify(raw, null, 1));
    } catch {
      /* circular / non-serialisable — fall through to content */
    }
  }
  const items = p.content;
  if (Array.isArray(items)) {
    const parts: string[] = [];
    for (const it of items as Record<string, unknown>[]) {
      const t = String(it?.type ?? "");
      if (t === "content") {
        const c = it.content as { type?: string; text?: string } | undefined;
        if (c?.type === "text" && c.text) parts.push(String(c.text));
      } else if (t === "diff") {
        // show which file changed + the new side, no full diff rendering (that's an editor's job)
        const path = String(it.path ?? "file");
        const next = typeof it.newText === "string" ? it.newText : "";
        parts.push(`--- ${path}\n${next.slice(0, 1500)}`);
      } else if (t === "terminal") {
        const out = (it as { output?: string }).output;
        if (out) parts.push(String(out));
      }
    }
    if (parts.length) return clip(parts.join("\n"));
  }
  return "";
}

/** Tool input the agent reported (rawInput / locations). Display-only. */
function extractToolInput(p: Record<string, unknown>): string {
  const raw = p.rawInput;
  if (typeof raw === "string" && raw.trim()) return raw.slice(0, 1200);
  if (raw && typeof raw === "object") {
    try {
      return JSON.stringify(raw, null, 1).slice(0, 1200);
    } catch {
      return "";
    }
  }
  return "";
}

export const cockpit = new Cockpit();
