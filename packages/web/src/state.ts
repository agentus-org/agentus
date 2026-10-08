// Cockpit state store — hand-rolled pub/sub + useSyncExternalStore.
// No third-party state lib: this UI holds zero intelligence (red line D),
// it just mirrors server events and aggregates ACP chunks into bubbles.
import type {
  ClientCommand,
  PermissionRequestView,
  PlanSnapshot,
  ServerEvent,
  SessionInfo,
  StoredMessage,
  TurnTrace,
} from "@agentus/shared";
import { blockKeyOf, foldTextRow, reindexBlocks } from "./transcript";

/** Plan step: ACP's own shape (content/status), plus the cockpit's terminal stamp. */
export interface PlanStep { content: string; status: string; priority?: string }

/** The plan the session is LIVING IN right now — rendered pinned above the composer, not in the
 *  transcript. Whole-list snapshots replace it in place (ACP plan semantics), and the `turn` it
 *  was born in decides when it gets archived into the transcript. */
export interface LivePlan {
  key: string;
  items: PlanStep[];
  /** set by the server's turn lifecycle when the run ended with unfinished steps */
  terminal?: string;
  /** the plan's own remark, Studio-style: why this update / what the scope is now (≤1000 chars) */
  explanation?: string;
  at?: number;
  /** user-turn ordinal: a plan frame from a later turn retires this one into the transcript */
  turn: number;
}

export type MsgView =
  | { key: string; kind: "user"; text: string; files: { kind: string; name: string }[]; at?: number }
  | { key: string; kind: "agent"; text: string; open: boolean; at?: number }
  | { key: string; kind: "thought"; text: string; open: boolean; at?: number }
  | {
      key: string; kind: "tool"; toolCallId: string; title: string; status: string; kind2: string;
      /** best-effort detail: tool output/content text (AionUi F-DISPLAY-03 wants it viewable) */
      detail: string;
      /** tool input as the agent reported it (rawArgs/title-adjacent metadata) */
      input: string;
      at?: number;
    }
  | {
      key: string; kind: "plan"; items: { content: string; status: string; priority?: string }[];
      /** set by the server's turn lifecycle when the run ended with unfinished steps */
      terminal?: string;
      /** the plan's own remark (why this update / what changed) */
      explanation?: string;
      at?: number;
    }
  | { key: string; kind: "meta"; text: string };

/** One backend registry row as the cockpit sees it (M6). "which hermes" is three independent
 *  choices — which COMMAND (and env, e.g. PYTHONPATH at a source tree), which HERMES_HOME, and
 *  which hermes profile — so a row is the unit the operator edits and the dialog picks. */
export interface BackendView {
  id: string;
  label: string;
  kind: "hermes" | "qoder" | "mock" | string;
  cmd: string;
  args: string[];
  /** env VAR NAMES this row injects (values are not echoed back by the server) */
  env?: string[];
  home?: string | null;
  profile?: string | null;
  cwd?: string | null;
  notes?: string;
  builtin?: boolean;
  warnings?: string[];
  /** last known health (system-written; see BackendHealth on the server) */
  health?: BackendHealthView;
  /** what the agent advertised the last time a slot really started from this row */
  handshake?: BackendHandshakeView | null;
}

/** Last known health of a row. `kind` matters: a `startup` check only resolves the command,
 *  `manual` runs --version (+ acp --check), and only `session` proves a slot really starts. */
export interface BackendHealthView {
  status: "online" | "offline" | "missing" | "unchecked";
  kind: "startup" | "manual" | "session" | null;
  errorCode: string | null;
  message: string | null;
  /** what to do about it, in the operator's language */
  guidance: string | null;
  latencyMs: number | null;
  at: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
}

/** Cached ACP handshake — the controls this backend advertised at its last real start. */
export interface BackendHandshakeView {
  at: number;
  protocolVersion: number | null;
  loadSession: boolean | null;
  fork: boolean | null;
  modes: { currentModeId: string | null; available: string[] } | null;
  configOptions: { id: string; name: string | null; currentValue: string | null }[];
  models: { currentModelId: string | null; available: string[] } | null;
  commands: string[];
}

/** What a row will actually run, answered by probing the real command. */
export interface BackendInspect {
  ok: boolean;
  id: string;
  cmd: string;
  resolved: string | null;
  args: string[];
  home: string | null;
  homeExists: boolean;
  homeEntries: number | null;
  stateDb: { path: string; bytes: number; mtime: number } | null;
  profile: string | null;
  envKeys: string[];
  /** first line of `<cmd> --version` */
  version: string | null;
  /** the `Install directory:` line — WHICH code tree the process will import from */
  installDir: string | null;
  /** NOT a gate: it returns OK before the adapter's server module is imported */
  acpCheck: { ok: boolean; output: string } | null;
  warnings: string[];
  error: string | null;
  /** structured verdict (persisted onto the row by the server) */
  status: "online" | "offline" | "missing" | "unchecked";
  errorCode: string | null;
  guidance: string | null;
  latencyMs: number;
}

/** What the settings page sends when creating/updating a row. */
export interface BackendInput {
  id?: string;
  label?: string;
  kind?: string;
  cmd?: string;
  args?: string[] | string;
  env?: Record<string, string> | string;
  home?: string | null;
  profile?: string | null;
  cwd?: string | null;
  notes?: string;
}

export interface SessionView {
  info: SessionInfo;
  msgs: MsgView[];
  perms: PermissionRequestView[];
  busy: boolean;
  loaded: boolean; // history fetched
  /** The LIVE plan: it is not in `msgs` at all — the composer pins it above the input. The
   *  transcript only ever shows ARCHIVED plans (previous turns), placed at the end of the turn
   *  they belonged to. `turn` is the user-turn it was born in: a plan frame arriving in a LATER
   *  turn archives this one and takes its place. */
  plan?: LivePlan | null;
  /** current user-turn ordinal (incremented when a `user` row is ingested) */
  turn: number;
  /** index in `msgs` where the current turn's user row sits — where an archived plan lands */
  turnStart: number;
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

/** A cold slot the agent can no longer adopt: it was created under a different agent home than
 *  the backend row uses now (or its home no longer holds the session at all). Nothing can bring it
 *  back — the UI says why, names both homes, and offers to delete the slot. */
export interface BlockedSlot {
  id: string;
  title: string;
  code: "home_mismatch" | "context_missing";
  sessionHome: string | null;
  rowHome: string | null;
}

/** The body of a 409 from POST /api/sessions/:id/resume. */
interface ResumeRefusal {
  code?: BlockedSlot["code"];
  sessionHome?: string | null;
  rowHome?: string | null;
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
  /** a resume the agent refused — rendered as a dialog, not a banner */
  blocked: BlockedSlot | null;
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
  blocked: BlockedSlot | null = null;
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
      if (id) localStorage.setItem("agentus.active", id);
      else localStorage.removeItem("agentus.active");
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
      return localStorage.getItem("agentus.active");
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
          // Tag it: an HTTP status means the server ANSWERED. It is not an outage, so it must not
          // be retried and must not raise the "服务不可达" banner (a 409 on a duplicate backend id
          // used to be reported as a network failure — the operator would chase the network).
          const httpErr = new Error(msg) as Error & { httpStatus?: number; httpBody?: unknown };
          httpErr.httpStatus = res.status;
          // Keep the body too: a refusal carries the `code` and the detail a dialog needs (which
          // agent homes a slot failed its resume between), and losing it would leave the caller
          // showing a generic message for a case that has a specific one.
          httpErr.httpBody = body;
          throw httpErr;
        }
        this.#setNet(true, "");
        return body as T;
      } catch (e) {
        clearTimeout(timer);
        if (e instanceof AuthRequired) throw e; // already handled above
        if ((e as { httpStatus?: number }).httpStatus !== undefined) throw e; // server said no
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
      blocked: this.blocked,
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
      // A rebuild is a new world: the live plan and the turn cursor start over, so the last
      // plan frame in the replay becomes the live one and older ones archive to their turn.
      v.plan = null;
      v.turn = 0;
      v.turnStart = 0;
      for (const m of messages) this.#ingest(v, m);
      v.loaded = true;
      v.hasOlder = Boolean(hasOlder);
      this.#keepLastOpen(v); // mid-turn: resume appending into the open bubble
      this.bump();
      // …then ask the server for the plan OBJECT, which is what the card actually renders: the
      // transcript is what the agent SAID, the object is what the session HAS. Applied after the
      // replay so it wins — and it is the only thing that can fill the card when the agent's process
      // (and with it its own todo state, and any reason to keep trusting those frames) is gone
      // (design-plan-service.md §1).
      void this.#loadPlan(v);
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

  /** Backend registry rows (M6) for the new-slot dialog and the settings page; surfaces
   *  failures instead of silently degrading to a single fallback button (QA#6). */
  async loadBackends(): Promise<BackendView[]> {
    return await this.#req<BackendView[]>("/api/backends");
  }

  /** Create a registry row (the id is part of the payload). */
  async createBackend(input: BackendInput): Promise<void> {
    await this.#req("/api/backends", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  async updateBackend(id: string, patch: BackendInput): Promise<void> {
    await this.#req(`/api/backends/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
  }

  async deleteBackend(id: string): Promise<void> {
    await this.#req(`/api/backends/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /** "What will this row actually run?" — resolved command, code tree, home, profile.
   *  Boots a python process (`--version` + `acp --check`), so: long timeout, never retry. */
  async inspectBackend(id: string): Promise<BackendInspect> {
    return await this.#req<BackendInspect>(
      `/api/backends/${encodeURIComponent(id)}/inspect`,
      { method: "POST" },
      { timeoutMs: 60_000, retry: false },
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
      const status = (e as { httpStatus?: number }).httpStatus;
      const body = (e as { httpBody?: ResumeRefusal }).httpBody;
      // A refused resume is the server ANSWERING, not an outage, and no retry changes it: the
      // slot's agent-side state is somewhere this backend row cannot reach. Say why, name both
      // homes, and offer the only action that helps — delete it (the transcript is the operator's;
      // the dead handoff is not).
      if (status === 409 && (body?.code === "home_mismatch" || body?.code === "context_missing")) {
        const info = this.sessions.find((s) => s.id === id) ?? this.archived.find((s) => s.id === id);
        this.blocked = {
          id,
          title: info?.title ?? id,
          code: body.code,
          sessionHome: body.sessionHome ?? null,
          rowHome: body.rowHome ?? null,
        };
        this.bump();
        return;
      }
      this.#setNet(false, `恢复失败：${String((e as Error).message ?? e)}`);
    }
  }

  /** Swap the agent process under a live slot: same session, same picks, new pid. What makes a code
   *  change on disk (or a changed backend config) real for a slot that is already up — a spawned CLI
   *  keeps the modules it loaded at startup, so only a fresh process can see them. */
  async restart(id: string): Promise<void> {
    try {
      const info = await this.#req<SessionInfo>(`/api/sessions/${id}/restart`, { method: "POST" }, { timeoutMs: 120_000, retry: false });
      const view = this.#view(id);
      view.info = { ...view.info, ...info };
      for (const list of [this.sessions, this.archived]) {
        const i = list.findIndex((s) => s.id === id);
        if (i >= 0) list[i] = { ...list[i], ...info };
      }
      this.bump();
    } catch (e) {
      const status = (e as { httpStatus?: number }).httpStatus;
      const body = (e as { httpBody?: ResumeRefusal }).httpBody;
      // A refused restart is the same dead handoff a refused resume is: the agent cannot adopt this
      // session in this home. Same dialog, same only-useful-action (delete it).
      if (status === 409 && (body?.code === "home_mismatch" || body?.code === "context_missing")) {
        const info = this.sessions.find((s) => s.id === id);
        this.blocked = {
          id,
          title: info?.title ?? id,
          code: body.code,
          sessionHome: body.sessionHome ?? null,
          rowHome: body.rowHome ?? null,
        };
        this.bump();
        return;
      }
      this.#setNet(false, `重启 agent 进程失败：${String((e as Error).message ?? e)}`);
    }
  }

  /** Close the refusal dialog without deleting anything (the slot stays cold in the rail). */
  dismissBlocked(): void {
    this.blocked = null;
    this.bump();
  }

  /** Accept the only useful action for a slot that can never come back: purge it. */
  deleteBlocked(): void {
    const b = this.blocked;
    this.blocked = null;
    if (b) this.purgeCold(b.id);
    this.bump();
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

  /** Fold a plan snapshot into the view — ONE rule, used by BOTH writers: an ACP frame from the
   *  agent, and the server's plan object (the copy that outlives the agent's process,
   *  design-plan-service.md §3). TWO destinations:
   *   · the snapshot born in the CURRENT turn becomes the LIVE plan — pinned above the composer,
   *     never in the transcript (the operator asked for exactly this: a plan you can always see
   *     while you type, instead of hunting for it in the scroll);
   *   · a snapshot arriving in a LATER turn retires the previous live plan into the transcript, at
   *     the END of the turn it belonged to (`turnStart` = this turn's user row) — the same rule
   *     Studio's positionTaskPlansAtTurnEnd implements. */
  #applyPlan(
    v: SessionView,
    items: PlanStep[],
    terminal: string | undefined,
    at: number | undefined,
    explanation?: string,
  ): void {
    const live = v.plan;
    if (!live) {
      v.plan = { key: `plan-${v.turn}`, items, terminal, explanation, at, turn: v.turn };
      return;
    }
    if (live.turn === v.turn) {
      // same turn: the snapshot replaces the list in place (the agent rewriting its own plan)
      live.items = items;
      live.terminal = terminal;
      live.explanation = explanation;
      return;
    }
    // a new turn produced a plan: retire the old one to the END of ITS turn
    const at2 = v.turnStart > 0 && v.turnStart <= v.msgs.length ? v.turnStart : v.msgs.length;
    v.msgs.splice(at2, 0, {
      key: live.key, kind: "plan", items: live.items, terminal: live.terminal,
      explanation: live.explanation, at: live.at,
    });
    v.blocks = reindexBlocks(v.msgs);
    v.turnStart = Math.min(v.turnStart + 1, v.msgs.length);
    v.plan = { key: `plan-${v.turn}`, items, terminal, explanation, at, turn: v.turn };
  }

  /** The server's plan object, as an event. Same folding as a frame — but this one also arrives in
   *  the case where no frame ever will, which is precisely the case the card used to get wrong. */
  #applyServerPlan(v: SessionView, plan: PlanSnapshot): void {
    this.#applyPlan(
      v,
      plan.items.map((i) => ({ content: i.content, status: i.status, priority: i.priority })),
      plan.terminal ?? undefined,
      plan.updatedAt,
      plan.explanation ?? undefined,
    );
  }

  /** Ask for the plan object when a session opens. A failure here is not a hole: the replayed frames
   *  are still whatever they are. */
  async #loadPlan(v: SessionView): Promise<void> {
    try {
      const { plan } = await this.#req<{ plan: PlanSnapshot | null }>(`/api/sessions/${v.info.id}/plan`);
      if (!plan) return;
      this.#applyServerPlan(v, plan);
      this.bump();
    } catch {
      /* offline etc. */
    }
  }

  #view(id: string): SessionView {
    let v = this.byId.get(id);
    if (!v) {
      v = {
        info: this.sessions.find((s) => s.id === id) ?? ({ id } as never),
        msgs: [], perms: [], busy: false, loaded: false, hasOlder: false, loadingOlder: false,
        minSeq: null, lastAt: Date.now(), rev: 0, seen: new Set(), blocks: new Map(),
        plan: null, turn: 0, turnStart: 0,
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
        // Requests still waiting for an answer are STATE, not only events: a page that loads or
        // refreshes after they were raised never saw the event, and would show an empty screen
        // while an agent sits there waiting for a human (the operator's exact complaint).
        if (e.pending) {
          const bySession = new Map<string, PermissionRequestView[]>();
          for (const p of e.pending) {
            const list = bySession.get(p.sessionId);
            if (list) list.push(p);
            else bySession.set(p.sessionId, [p]);
          }
          for (const [sid, list] of bySession) this.#view(sid).perms = list;
          for (const v of this.byId.values()) if (!bySession.has(v.info.id)) v.perms = [];
        }
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
        v.plan = null;
        v.turn = 0;
        v.turnStart = 0;
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
      case "plan": {
        // The plan OBJECT — the card's truth (design-plan-service.md §3). It arrives on every change
        // AND on connect, so a page that loads after the agent process died still shows the plan
        // instead of nothing.
        const v = this.#view(e.sessionId);
        this.#applyServerPlan(v, e.plan);
        v.lastAt = Date.now();
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
      case "permission-expired":
        // The answer landed nowhere (the server's request was already gone — our own timeout, or
        // the agent gave up first). Say so: a click that silently does nothing is the failure
        // shape the operator cannot tell from a broken button.
        for (const v of this.byId.values()) v.perms = v.perms.filter((p) => p.requestId !== e.requestId);
        this.#view(e.sessionId).msgs.push({
          key: `perm-exp-${e.requestId}`,
          kind: "meta",
          text: "这条审批已经过期：agent 等不到答复、先自己放过了（或它已经放弃这一轮）。你的点击没有生效。",
        });
        break;
      case "config-rejected": {
        // The picker took the click but the agent did not: the level/budget we sent is one the
        // route folds away (or the backend has no setter at all). Say it, and keep showing what the
        // session really runs with — a silent "success" here is exactly the "设置了没用" report.
        const v = this.#view(e.sessionId);
        const label = e.name || e.configId;
        v.msgs.push({
          key: `cfg-rej-${e.configId}-${Date.now()}`,
          kind: "meta",
          text: `${label} 这一档没生效：agent 没有接受「${e.value}」${e.actual ? `，实际仍是「${e.actual}」` : ""}。`
            + `（模型只认它公布的那几档；换档位或换模型再试。）`,
        });
        break;
      }
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
    // When this row happened (the store's own `created_at`). A row that GROWS (a streamed
    // reply, a tool call whose output arrives later) keeps the time it STARTED — that is the
    // question the operator asks ("什么时候发的"), and the upsert paths below never rewrite it.
    const at = typeof m.createdAt === "number" ? m.createdAt : Date.now();
    const text = extractText(p);
    const last = list[list.length - 1];
    switch (m.kind) {
      case "user":
        list.push({
          key: `m${m.seq}`, kind: "user", text: String(p.text ?? ""), at,
          // names only — the bytes were never persisted (AttachmentSummary)
          files: Array.isArray(p.attachments)
            ? (p.attachments as { kind?: unknown; name?: unknown }[])
                .map((a) => ({ kind: String(a.kind ?? ""), name: String(a.name ?? "file") }))
            : [],
        });
        // A user row IS a turn boundary. Only the live fold counts them: a paged older batch
        // is history, and letting it bump the counter would retire the live plan behind our back.
        if (!opts?.list) {
          v.turn += 1;
          v.turnStart = list.length - 1;
        }
        break;
      // Streamed text: one message is one bubble, found by its `messageId` — a history page can no
      // longer split a reply (or a markdown table) in half, and a re-sent block does not become a
      // second bubble. See transcript.ts for why both of those needed their own rule.
      case "agent":
      case "thought": {
        const kind = m.kind;
        const key = blockKeyOf(kind, p);
        const { at: idx } = foldTextRow(
          list,
          index,
          { key, kind, text, delta, n: opts?.n },
          (k, row) => ({ key: k, kind: row.kind, text: row.text, open: true, at }),
        );
        // A live frame keeps ITS bubble marked as the growing one, even when a tool card or a
        // thinking block arrived after it: that flag is what draws the streaming state.
        const block = list[idx];
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
            key: `tc-${tcId}`, kind: "tool", toolCallId: tcId, at,
            title: String(p.title ?? "tool call"), status: String(p.status ?? "pending"),
            kind2: String(p.kind ?? ""), detail, input,
          });
        }
        break;
      }
      case "plan": {
        // ACP plan frames are whole-list snapshots (replace semantics). TWO destinations:
        //  · the frame born in the CURRENT turn becomes the LIVE plan — pinned above the composer,
        //    never in the transcript (the operator asked for exactly this: a plan you can always
        //    see while you type, instead of hunting for it in the scroll);
        //  · a frame arriving in a LATER turn retires the previous live plan into the transcript,
        //    placed at the END of the turn it belonged to (`turnStart` = this turn's user row), the
        //    same rule Studio's positionTaskPlansAtTurnEnd implements.
        // `_slotPlanTerminal` is the cockpit's own field — the server's turn lifecycle stamps it
        // when a run ends with unfinished steps; the agent can never write it.
        const meta = (p._meta ?? {}) as Record<string, unknown>;
        const items = ((p.entries ?? []) as PlanStep[]).map((e) => ({
          content: String(e?.content ?? ""), status: String(e?.status ?? "pending"), priority: e?.priority,
        }));
        const terminal = typeof p._slotPlanTerminal === "string" ? p._slotPlanTerminal : undefined;
        // ACP v1 has no remark field, so a writer that has one puts it in `_meta` (the protocol's own
        // extension slot). Absent means "nothing to say", never "clear what is there".
        const explanation = typeof meta["agentus/explanation"] === "string"
          ? String(meta["agentus/explanation"]) : undefined;
        if (opts?.list) {
          // A paged older batch is history: fold it into that page's own card (one per page —
          // these rows are far behind the live edge, so per-turn placement buys nothing).
          const old = list.find((x) => x.kind === "plan");
          if (old && old.kind === "plan") { old.items = items; old.terminal = terminal; old.explanation = explanation; }
          else list.push({ key: `m${m.seq}`, kind: "plan", items, terminal, explanation, at });
          break;
        }
        // Both writers fold through ONE rule: this frame, and the server's plan object (see
        // #applyPlan — the object is the copy that survives the agent's process).
        this.#applyPlan(v, items, terminal, at, explanation);
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
