// Cockpit state store — hand-rolled pub/sub + useSyncExternalStore.
// No third-party state lib: this UI holds zero intelligence (red line D),
// it just mirrors server events and aggregates ACP chunks into bubbles.
import type {
  BackgroundTask,
  ClientCommand,
  PermissionDecision,
  PermissionRequestView,
  PlanSnapshot,
  PromptAttachment,
  ServerEvent,
  SessionInfo,
  StatusNoteItem,
  StoredMessage,
  TurnTrace,
} from "../../shared/src/index";
import { blockKeyOf, foldTextRow, reindexBlocks } from "./transcript";
import { changesOfTool, type ToolChange } from "./changes";
import { webNotify } from "./webNotify";

/** Plan step: ACP's own shape (content/status), plus the cockpit's terminal stamp. */
export interface PlanStep { content: string; status: string; priority?: string }

/** The plan the session is LIVING IN right now — rendered pinned above the composer, not in the
 *  transcript. Whole-list snapshots replace it in place (ACP plan semantics), and the `turn` it
 *  was born in decides when it gets archived into the transcript. */
export interface LivePlan {
  key: string;
  items: PlanStep[];
  /** The plan's own NAME (`update_plan`'s `title`, ≤40 chars, issue #11). It was already stored and
   *  consumed by the completion notification; the card now shows it too, because 「任务计划」 says
   *  nothing about WHICH plan you are looking at when several sessions are open. Absent on plans the
   *  agent never named (older agents, or a plan that only ever sent items). */
  title?: string;
  /** set by the server's turn lifecycle when the run ended with unfinished steps */
  terminal?: string;
  /** the plan's own remark, Studio-style: why this update / what the scope is now (≤1000 chars) */
  explanation?: string;
  at?: number;
  /** user-turn ordinal: a plan frame from a later turn retires this one into the transcript */
  turn: number;
}

export type MsgView =
  | {
      key: string;
      kind: "user";
      text: string;
      files: { kind: string; name: string }[];
      at?: number;
      /** the message was NOT typed by the operator: another session's agent sent it through the
       *  cockpit channel. Present only for those, so the page can say who is talking. */
      from?: { id: string; title: string };
    }
  | { key: string; kind: "agent"; text: string; open: boolean; at?: number }
  | { key: string; kind: "thought"; text: string; open: boolean; at?: number }
  | {
      key: string; kind: "tool"; toolCallId: string; title: string; status: string; kind2: string;
      /** best-effort detail: tool output/content text (AionUi F-DISPLAY-03 wants it viewable) */
      detail: string;
      /** tool input as the agent reported it (rawArgs/title-adjacent metadata) */
      input: string;
      /** 这一调用改到的文件（#38）：回合末尾那块「N 个文件变更」就是从这些行聚合的。
       *  在 ingest 处抽一次，而不是渲染时再翻 payload —— 视图层拿不到 payload（只留了
       *  title/detail/input 这几个字符串），而聚合是纯函数，见 changes.ts。 */
      changes?: ToolChange[];
      at?: number;
    }
  | {
      key: string; kind: "plan"; items: { content: string; status: string; priority?: string }[];
      /** the plan's name, when the agent gave one (issue #11) */
      title?: string;
      /** set by the server's turn lifecycle when the run ended with unfinished steps */
      terminal?: string;
      /** the plan's own remark (why this update / what changed) */
      explanation?: string;
      at?: number;
    }
  | { key: string; kind: "meta"; text: string }
  /** 一条状态行（`messages.kind = "note"`）：不是谁说过的话，是过程 —— 「这一轮回忆了几条记忆」
   *  「上下文压缩过」「有个警告」。它现在是**落库的行**（操作者 2026-10-18），所以刷新、重连、
   *  换设备之后都还在；`category` 是家族，`hits` 是折叠掉的次数（压缩会心跳十几条）。 */
  | {
      key: string; kind: "note"; category: string; text: string; hits?: number; at?: number;
      /** memory 行的条目（issue #37）：`recalled N memories` 说的是哪几条。server 只对 memory
       *  行带它，压缩/警告行没有。`truncated` 说明 agent 那边已经把后面的截掉了。 */
      items?: StatusNoteItem[]; truncated?: boolean;
    }
  /** 审批请求落库的那一行（`messages.kind = "approval"`）。请求到达时写入，决定随后补进同一行 ——
   *  于是「问过什么、我答了什么、还是超时作废了」在聊天记录里留得住，而不是只活在那张弹窗里。
   *  `decision === null` 表示还没答；是否仍在等由 `v.perms` 说了算（服务端重启后可能已经不在了）。 */
  | {
      key: string; kind: "approval"; requestId: string; title: string; kind2: string;
      path: string | null; diff: PermissionRequestView["diff"];
      options: PermissionRequestView["options"]; decision: PermissionDecision | null; at?: number;
    }
  /** 「这个仓库有 N 个项目 skill 没启用」的一张卡（`messages.kind = "project-skills"`）。
   *  `state` 是那次决定：ask（还没答）/ trusted / ignore。 */
  | { key: string; kind: "project-skills"; root: string; count: number; text: string; state: string; at?: number }
  /** 一轮的 token 账（`messages.kind = "turn-usage"`，issue #70）。服务端在 turn-end 时写进
   *  转录，所以它永远贴在那一轮回复的尾巴上，刷新之后也在。`available: false` 表示这个 agent
   *  没上报用量（Qoder）—— 画成「未上报」，绝不画成 0。 */
  | {
      key: string; kind: "turn-usage"; available: boolean;
      input: number; output: number; thought: number; cacheRead: number; cacheWrite: number;
      total: number; durationMs?: number; cacheHitPercent?: number | null; tps?: number | null; at?: number;
    };

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
  /** Which channel carries this backend's plan: `none` = the cockpit injects the agentus-plan MCP
   *  tool at handshake time (every backend's default — the card renders the cockpit's object, which
   *  survives a restart), `acp` = an escape hatch that renders the agent's own plan frames instead. */
  nativePlanSource?: "acp" | "none";
  /** The permission mode a NEW session from this row starts in (an ACP mode id), or null/absent for
   *  "send nothing, the agent keeps its own default". Never applied to a resumed session. */
  defaultMode?: string | null;
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

/** A control the operator set on the START PAGE — i.e. before the session it belongs to existed.
 *
 *  The start page is a reduced copy of the chat page, so its model / thinking-depth / permission
 *  controls read the same fields the composer does; the one difference is that there is no session
 *  yet to read them FROM, so the values come off the backend row's cached handshake and ride with the
 *  session until it comes up (`queueSetup` → `#applySetup`). */
export type SetupPick =
  | { kind: "model"; value: string }
  | { kind: "mode"; value: string }
  | { kind: "config"; id: string; value: string };

/** Cached ACP handshake — the controls this backend advertised at its last real start. */
export interface BackendHandshakeView {
  at: number;
  protocolVersion: number | null;
  loadSession: boolean | null;
  fork: boolean | null;
  modes: { currentModeId: string | null; available: string[]; names?: Record<string, string> } | null;
  /** The agent's own `select`s. Kept whole (type/category/options, not just id+currentValue)
   *  because the NEW-SESSION start page has no session to read them from — it draws its composer
   *  controls from this cache, so a reduced copy would render buttons that cannot be turned. */
  configOptions: {
    id: string;
    name: string | null;
    currentValue: string | null;
    type?: string | null;
    category?: string | null;
    options?: { value: string; name: string | null; description?: string | null }[] | null;
  }[];
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
  defaultMode?: string | null;
  notes?: string;
  nativePlanSource?: string;
}

/** A prompt written while the agent was still working. It waits in the composer — visibly, with its
 *  own three buttons — and goes out by itself the moment the turn ends (Studio's message queue).
 *  `inflight` means it has been handed to the server and we are waiting for the `turn-start` that
 *  proves it landed: until then it is NOT forgotten, so a refused send puts it back in line instead
 *  of losing the operator's words silently. */
export interface QueuedPrompt {
  id: string;
  text: string;
  attachments: PromptAttachment[];
  at: number;
  inflight?: boolean;
  /** The page put this on the wire but the server never confirmed it (issue #26). Such a row is NOT
   *  drained automatically: a resend the operator did not ask for could duplicate a message that did
   *  land late. It waits for an explicit ↑. */
  unsure?: boolean;
  /** The wire id of that unconfirmed send, so a late `turn-start` can retire the row instead of
   *  leaving him with a copy of a message that is already in the transcript. */
  pid?: string;
}

/** One line the agent (or its runtime) announced about the work in flight — a memory recall, a
 *  compaction, a provider wait. A transcript ROW that is deliberately not a message: `text` is the
 *  sentence, `kind` its family (`lifecycle` / `compacting` / `compacted` / `warn`), `afterKey` the
 *  message row it arrived after (null = before any message in this view). */
export interface StatusNote {
  key: string;
  kind?: string;
  text: string;
  at: number;
  afterKey: string | null;
}

export interface SessionView {
  info: SessionInfo;
  msgs: MsgView[];
  perms: PermissionRequestView[];
  busy: boolean;
  /** When the CURRENT turn began, in the operator's terms: the moment his message went out
   *  (`turn-start`), not the first token that came back. The tail line counts from here, so the
   *  number answers "how long have I been waiting", which is the question he asked it to answer.
   *  null while no turn is running — and also for a page that loaded MID-turn, where the frame was
   *  before our time: the tail line then anchors on its own first paint (an undercount, never a
   *  number invented from `lastAt`, which every incoming frame resets). The server knows the real
   *  start (`durationMs` on turn-end) but does not put it on the wire, and a server change is a
   *  restart, so this stamp is client-side by design. */
  busySince: number | null;
  /** The agent's STATUS lines (issue #18), as ROWS in the transcript rather than a suffix on the tail
   *  line — the operator's call (2026-10-18): 「压缩什么的也会显示，所以应该放在会话记录框里面」.
   *  In memory only, on purpose: they describe process state, not something anybody said, so they must
   *  never be persisted, replayed, exported or counted as history — a refresh drops them and that is
   *  the honest degradation. Each row keeps the key of the message it followed (`afterKey`), which is
   *  how the transcript interleaves them in the order they actually happened. */
  notes: StatusNote[];
  /** Background processes the agent still has for this session (issue #22) — the ACP twin of the
   *  desktop status stack. A SNAPSHOT: the server replaces it wholesale and clears it when the agent
   *  process dies. Empty array = nothing running (the row disappears, never 「0 个」). */
  background?: BackgroundTask[];
  loaded: boolean; // history fetched
  /** The operator opened a cold slot and the agent process is still coming up (spawn + session/load
   *  takes seconds). The transcript is ALREADY on screen — it is our own rows — so this flag only
   *  tells the composer not to offer a send that has nothing to send into yet, and tells the rail
   *  that the row is being woken rather than dead. */
  resuming?: boolean;
  /** 工作播报 lines the cockpit has produced for this session (issue #16), newest last, bounded.
   *  They are NOT transcript rows: a brief is a thing SAID about the work, not part of it, and
   *  putting it in `msgs` would have it replayed as history and re-read on every load. */
  speaks?: { id: string; text: string; kind: string; priority: number; at: number }[];
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
  /** prompts written WHILE the agent was working, oldest first: the composer shows them with their
   *  own buttons (send now / edit / drop) and the queue drains itself on `turn-end`. */
  queue: QueuedPrompt[];
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
  /** Cold rows that are NOT archived — they belong in 工作空间 beside the live ones, so the rail
   *  keeps showing a crashed or idle-reaped slot instead of filing it away. */
  cold: SessionInfo[];
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
  /** Session ids whose row wears the 「还没看」 dot: a turn that ENDED while the operator was in
   *  another session (transient), plus the ones they marked by hand (persisted). The union, because
   *  the rail draws one dot and the operator only has one question — 「这条我看过了吗」. */
  unread: ReadonlySet<string>;
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

/** The operator's hand-set unread marks, kept across sessions of the page (AionUi keeps its manual
 *  set in localStorage for the same reason). One key, a list of ids — a Set is not JSON. */
const UNREAD_KEY = "agentus.unread";
/** How long a submitted approval answer may wait for the server's word before the surface stops
 *  claiming it was delivered and offers the click again (see `permAnswer`). */
export const PERM_ACK_MS = 8000;

/** How long a READY-session prompt waits for the `turn-start` that proves it landed (issue #26).
 *  Same magnitude as `PERM_ACK_MS` on purpose: both answer 「did my click reach the server」, and a
 *  second number would only be a second thing to get wrong. The server answers a prompt in
 *  milliseconds when it is there at all — this is not a latency budget, it is a liveness verdict. */
export const SEND_ACK_MS = 8000;

function readStoredUnread(): string[] {
  try {
    const raw = localStorage.getItem(UNREAD_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return []; // private mode / corrupt value — the dot is a nicety, not worth failing over
  }
}

function persistUnread(ids: Iterable<string>): void {
  try {
    const list = [...ids];
    if (list.length) localStorage.setItem(UNREAD_KEY, JSON.stringify(list));
    else localStorage.removeItem(UNREAD_KEY);
  } catch { /* see readStoredUnread */ }
}

class Cockpit {
  sessions: SessionInfo[] = [];
  /** On disk, no process, NOT archived: 工作空间 material, wearing `cold`. */
  cold: SessionInfo[] = [];
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
  /** sessionId → prompts waiting for the current turn to end. Mirrored onto the session view
   *  (`v.queue`) so the UI can render them, and persisted so a reload mid-queue does not eat them. */
  #queues = new Map<string, QueuedPrompt[]>();
  /** sessionId → what the start page picked for a session that did not exist yet. Applied once, at
   *  `ready`, ahead of the queued first message; dropped there so a later reload cannot re-apply a
   *  stale pick over a change the operator has since made from the chat page. */
  #setup = new Map<string, SetupPick[]>();
  /** Sessions where the operator pressed ↑: that prompt is on its way to taking the floor, so the
   *  drain must wait for ITS `turn-start` before handing over the next one. The `turn-end` that
   *  arrives in the meantime belongs to the turn he just interrupted — draining on that one would
   *  send the next queued prompt on top of the message he explicitly pushed to the front. */
  #takingFloor = new Set<string>();
  /** pid → the prompt the page put on the wire and has NOT seen acknowledged (issue #26).
   *
   *  `send()` returning true only means the frame was handed to a socket the browser still believes
   *  is OPEN — and a TCP connection that died without a FIN stays OPEN forever. So a ready-session
   *  send is registered here and only leaves when the server answers with the `turn-start` that
   *  carries its `pid`. No answer within `SEND_ACK_MS` = the frame went nowhere: the words are put
   *  back in the operator's queue as `unsure` (visible, editable, explicitly resendable) instead of
   *  disappearing with a cleared input box — which is exactly how #26 was reported. */
  #pendingSends = new Map<string, { sessionId: string; pid: string; text: string; attachments: PromptAttachment[]; rowId?: string; timer: ReturnType<typeof setTimeout> }>();
  /** 「跑完了，还没看」 — set by `turn-end` for a session the operator was NOT in (AionUi's completion
   *  dot, and its rule: only a turn that finished somewhere else is news). TRANSIENT on purpose: the
   *  acknowledgement is opening the session, and a page that reloads has no business re-dotting rows
   *  the operator never returned to. `#manualUnread` below is the part worth keeping. */
  #unread = new Set<string>();
  /** 「点进去看了，但还没决策」 — the operator said so themselves (the row menu's toggle). PERSISTED:
   *  the whole point is that the reminder outlives looking at the session, and usually a reload too. */
  #manualUnread = new Set<string>(readStoredUnread());
  /** Sessions whose agent process is being woken right now. A click on a cold row starts a spawn
   *  that takes seconds; without this a second click (or Enter, or the send button) would start a
   *  SECOND spawn for the same slot — two agent processes, one rail row. */
  #resuming = new Set<string>();
  /** requestId → the option the operator just picked, between his click and the server's
   *  `permission-resolved`. It exists because the click has to be VISIBLE on its own: the answer
   *  travels to the server and comes back as an event, and on a slow link (a phone on the tunnel)
   *  a popup that does not move reads as 「点了没反应」 — the operator clicks again, and on a request
   *  that is already answered that second click is the one the server logs as dropped. Cleared the
   *  moment the request leaves `perms`, whatever the server decided. */
  #permAnswers = new Map<string, { label: string; at: number; armed: boolean }>();
  #listeners = new Set<() => void>();
  /** The pending coalesced publish (see bump) — one per frame at most. */
  #frame: number | null = null;
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

  /** `?session=<id>` — which slot this page is showing (issue #20).
   *
   *  The URL is a LOCATOR now, not a one-shot instruction: it is read on load (a notification tap, a
   *  shared link) and then kept in step with what is on screen, so 「把这条链接发给自己」 opens the same
   *  conversation and a reload cannot land somewhere else. It used to be deleted on read, which fixed
   *  the stale-query hijack by throwing away the address — the reconciliation below keeps that fix
   *  without the amnesia: a URL that disagrees with the ACTIVE session is the only thing followed. */
  #urlSession(): string | null {
    try {
      return new URL(location.href).searchParams.get("session");
    } catch {
      return null;
    }
  }

  /** Write the active slot into the address bar with `replaceState`.
   *
   *  `replaceState`, not `pushState`: switching slots inside the cockpit is one document changing
   *  view, not navigation. A history entry per click would turn the browser's Back button into
   *  「undo my last click」 and bury real navigations. The URL still becomes shareable and reloadable,
   *  which is the whole point. */
  #writeUrl(id: string | null): void {
    try {
      const here = new URL(location.href);
      const want = id ?? null;
      if ((here.searchParams.get("session") ?? null) === want) return; // already truthful: no churn
      if (want) here.searchParams.set("session", want);
      else here.searchParams.delete("session");
      history.replaceState(history.state, "", here.toString());
    } catch {
      /* about:blank / sandboxed iframe — the cockpit still works, it just cannot be linked */
    }
  }

  /** Follow the URL if (and only if) it disagrees with the active session.
   *
   *  This is the 「陈旧 query 劫持」 rule stated as code: on load the parameter decides (it outranks
   *  localStorage, which stays as the fallback for a bare `/`), and afterwards the operator's clicks
   *  win because they rewrite the URL themselves. Called on load, on `popstate`, and by the in-page
   *  navigation hook the phone's notification tap uses. */
  followUrl(): void {
    const want = this.#urlSession();
    if (!want || want === this.activeId) return;
    if (this.byId.has(want)) this.setActive(want);
  }

  #restoreActive(): string | null {
    const target = this.#urlSession();
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
      this.cold = [];
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
      void this.refreshRows();
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

  /** The operator answered `requestId` (label = the option he pressed, at = when). Recorded so the
   *  surface can show his click landing while the answer travels; the server's
   *  `permission-resolved` is what actually takes the request away. */
  markPermAnswered(requestId: string, label: string, armed = true): void {
    this.#permAnswers.set(requestId, { label, at: Date.now(), armed });
    this.bump();
  }

  /** The operator's pick for a request still awaiting the server's word, or undefined.
   *
   *  `lapsed` = it has been waiting longer than `PERM_ACK_MS`, and that flag exists because the
   *  confirmation does NOT always come: a socket that dies without a FIN stays `OPEN` in JS, so
   *  `send()` neither queues the command nor retries it — the frame is written and vanishes
   *  (measured on live 2026-10-11 with the network cut: the answer never arrived, nothing queued it).
   *  A surface that keeps saying 「已提交」 for a request nobody will ever answer is worse than no
   *  feedback at all: it hides the one action that can still save the turn. So past this window the
   *  answer is treated as unconfirmed and the click is offered again. */
  permAnswer(requestId: string): { label: string; at: number; lapsed: boolean } | undefined {
    const hit = this.#permAnswers.get(requestId);
    if (!hit) return undefined;
    // `armed` = the answer really went out, so an acknowledgement is due. A queued answer is not
    // armed: the surface already told the operator it is queued and will go on reconnect.
    return { label: hit.label, at: hit.at, lapsed: hit.armed && Date.now() - hit.at > PERM_ACK_MS };
  }

  /** Forget answers for requests that are no longer pending — a request can leave `perms` through
   *  `permission-resolved`, `permission-expired`, or a session snapshot (the server restarting, the
   *  slot dying), and every one of those ends the answered state's usefulness. */
  #syncPermAnswers(): void {
    if (!this.#permAnswers.size) return;
    const live = new Set<string>();
    for (const v of this.byId.values()) for (const p of v.perms) live.add(p.requestId);
    for (const id of [...this.#permAnswers.keys()]) if (!live.has(id)) this.#permAnswers.delete(id);
  }

  #build(): StoreSnapshot {
    return {
      sessions: this.sessions,
      cold: this.cold,
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
      // The rail draws ONE dot, so it asks one question: the union of 「a turn finished elsewhere」 and
      // 「I said I still have to decide」. Both sets are tiny, so the union is built per snapshot.
      unread: new Set([...this.#unread, ...this.#manualUnread]),
      version: this.#version,
    };
  }

  /**
   * Publish a new snapshot to the UI — at most ONCE PER FRAME.
   *
   * This used to notify every subscriber synchronously, and one of them is a `useSyncExternalStore`
   * in the app shell, so each websocket frame re-rendered the WHOLE cockpit (the transcript, the rail,
   * the plan card). A stream sends frames far faster than a frame can be painted, so the backlog grew
   * without bound: measured 2026-10-08 on a slot holding 383 rendered rows, the server finished a turn
   * at +59.9s and the page only showed the finished shape at **+99.9s** — forty seconds of it still
   * drawing tool cards and 「▸ turn in progress…」 for a turn that was over, with a reload the only way
   * out (the operator's exact report).
   *
   * Coalescing is safe because a snapshot is a FULL description of the state, not a delta: the reader
   * gets the newest one, so nothing can be missed. Every mutation still lands in the snapshot before
   * the broadcast — the scheduled pass recomputes it from the current state, so a burst of frames is
   * one render of the sum of them.
   */
  bump(): void {
    this.#version++;
    if (this.#frame == null) {
      // ⚠️ `requestAnimationFrame` does not exist under Node, and the state module is unit-tested
      // there (scripts/qa/resume-tail.mts, store-fold.mts). Fall back to a macrotask so the tests
      // still see one publish per burst, and to a synchronous publish as the last resort — a
      // published snapshot is never wrong, only early.
      if (typeof requestAnimationFrame === "function") {
        this.#frame = requestAnimationFrame(() => {
          this.#frame = null;
          this.#publish();
        });
      } else if (typeof setTimeout === "function") {
        this.#frame = setTimeout(() => {
          this.#frame = null;
          this.#publish();
        }, 0) as unknown as number;
      } else {
        this.#publish();
      }
    }
    this.#flushIfHidden();
  }

  /** Build the snapshot and tell the subscribers. Only `bump` calls this. */
  #publish(): void {
    if (this.#frame != null) {
      // Same environment caveat as `bump`: rAF exists only in a browser; under Node the pending
      // handle is a timer.
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.#frame);
      else if (typeof clearTimeout === "function") clearTimeout(this.#frame as unknown as ReturnType<typeof setTimeout>);
      this.#frame = null;
    }
    // refresh busy mirrors from info
    for (const s of this.byId.values()) s.busy = s.info.status === "running";
    this.#snapshot = this.#build();
    for (const fn of this.#listeners) fn();
  }

  /**
   * A requestAnimationFrame callback does NOT run while the tab is hidden (backgrounded phone, a
   * minimised window), so a page that went to the background mid-stream would come back with a stale
   * screen and no pending pass. Publish immediately in that case: nothing is being painted, so the
   * cost that the coalescing exists to avoid is not being paid anyway.
   */
  #flushIfHidden(): void {
    if (typeof document === "undefined" || !document.hidden) return;
    if (this.#frame == null) return;
    this.#publish();
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
      void this.refreshRows();
      // A page that reloaded with prompts still queued finishes the job it was holding: give the
      // socket a beat to replay session state, then let those queues go.
      window.setTimeout(() => this.drainPersistedQueues(), 700);
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

  /** Enter on a READY slot: put it on the wire and prove it landed (issue #26).
   *
   *  This is the only send path that had no acknowledgement: the cold path files a queue row and waits
   *  for `turn-start`, the busy path does the same, but a ready send went straight out and the box was
   *  cleared on `send()` returning true — which a half-open socket also does. So the frame is tagged
   *  with a `pid` and registered in `#pendingSends`; the server echoes the pid on the `turn-start` it
   *  causes. Silence within `SEND_ACK_MS` means nobody received it, and the words go back into the
   *  queue as an `unsure` row rather than vanishing. */
  sendPrompt(sessionId: string, text: string, attachments: PromptAttachment[] = []): void {
    if (!text.trim() && !attachments.length) return;
    this.#sendAcked(sessionId, { text, attachments });
  }

  /** One place builds the wire frame that expects a `turn-start` back (issue #26): a ready-session
   *  Enter, a queue row's ↑, and the drain all ride this. `rowId` is the queue row that must go back
   *  to `unsure` when nobody answers — without it a retry that also lands in a dead socket silently
   *  marks its own row as sent and the operator has nothing left to click. */
  #sendAcked(sessionId: string, opts: {
    text: string;
    attachments: PromptAttachment[];
    interrupt?: boolean;
    rowId?: string;
  }): void {
    const pid = `p-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const cmd: ClientCommand = { t: "prompt", sessionId, text: opts.text, attachments: opts.attachments, pid,
      ...(opts.interrupt ? { interrupt: true } : {}) };
    const delivered = this.send(cmd);
    // Not OPEN: `send()` filed the prompt in the queue itself and told the operator so — that row IS
    // the acknowledgement, and registering a second one would duplicate his words on reconnect.
    if (!delivered) {
      if (opts.rowId) {
        const rows = this.#queues.get(sessionId) ?? [];
        this.#setQueue(sessionId, rows.map((r) => (r.id === opts.rowId ? { ...r, inflight: false } : r)));
      }
      return;
    }
    const timer = setTimeout(() => this.#requeueUnconfirmed(pid), SEND_ACK_MS);
    this.#pendingSends.set(pid, { sessionId, pid, text: opts.text, attachments: opts.attachments, rowId: opts.rowId, timer });
  }

  /** The server started a turn for this prompt: it is a real message now. */
  #confirmSent(sessionId: string, pid?: string): void {
    const hit = pid
      ? this.#pendingSends.get(pid)
      // An older server does not echo `pid`. A turn that started on a session with exactly one
      // unconfirmed send is that send — treating it as confirmed is the honest reading, and the
      // alternative (requeueing a message that is already in the transcript) is the worse error.
      : [...this.#pendingSends.values()].find((p) => p.sessionId === sessionId);
    if (!hit) return;
    // A turn started on this session, so nothing else is still on its way to it: only one prompt can
    // begin a turn at a time. Retiring the rest here is what stops a stale timer from filing a copy of
    // a sentence that already landed under another pid (measured: a retry's own 8s budget expired after
    // the operator's next attempt had gone through, and the transcript ended up with two).
    for (const other of [...this.#pendingSends.values()]) {
      if (other.sessionId !== sessionId) continue;
      clearTimeout(other.timer);
      this.#pendingSends.delete(other.pid);
    }
    clearTimeout(hit.timer);
    this.#pendingSends.delete(hit.pid);
    // A late arrival retires the row the timeout created: the operator must not be left holding a
    // copy of something that did land.
    const rows = this.#queues.get(sessionId) ?? [];
    if (rows.some((r) => r.pid === hit.pid)) this.#setQueue(sessionId, rows.filter((r) => r.pid !== hit.pid));
  }

  /** A refusal names the prompt it refused, so the ack budget does not expire into a second copy of
   *  the same sentence while the refusal path is already filing it (`rejectedPrompt`). */
  #forgetSent(pid: string): void {
    const hit = this.#pendingSends.get(pid);
    if (!hit) return;
    clearTimeout(hit.timer);
    this.#pendingSends.delete(pid);
  }

  /** `SEND_ACK_MS` of silence: the frame went into a socket that is dead but still `OPEN`. Put the
   *  words back where the operator can see them, marked as NOT delivered. */
  #requeueUnconfirmed(pid: string): void {
    const hit = this.#pendingSends.get(pid);
    if (!hit) return;
    this.#pendingSends.delete(pid);
    // Nobody took the floor after all: release the guard, or the queue behind this row stays wedged.
    this.#takingFloor.delete(hit.sessionId);
    const rows = this.#queues.get(hit.sessionId) ?? [];
    if (hit.rowId && rows.some((r) => r.id === hit.rowId)) {
      // A retry (↑ / drain) that ALSO went into the dead socket: the row is already there, so put it
      // back to `unsure` instead of appending a second copy of the same sentence.
      this.#setQueue(hit.sessionId, rows.map((r) => (r.id === hit.rowId ? { ...r, inflight: false, unsure: true } : r)));
    } else if (!rows.some((r) => r.pid === hit.pid)) {
      this.#setQueue(hit.sessionId, [...rows, {
        id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        text: hit.text, attachments: hit.attachments, at: Date.now(), unsure: true, pid: hit.pid,
      }]);
    }
    this.#setNet(false, "消息未确认送达 — 已放回队列，点 ↑ 重发");
  }

  /** Send a command. Returns false when it could not go out and was queued for the next
   *  connection — a caller that promises the operator "delivered" must not do so for a queued
   *  command, and one that watches for an acknowledgement must not expect one. */
  send(cmd: ClientCommand): boolean {
    if (this.auth === "out") {
      // Queueing here would promise a delivery that can never happen.
      this.#setNet(false, "未登录 — 请先登录再发送指令");
      return false;
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd));
      return true;
    }
    // Phone reality: iOS/Android suspend sockets when the app backgrounds, so a
    // tap can land while we're offline. Dropping it silently would look like the
    // cockpit ate the instruction — hold it and flush on reconnect (QA#14).
    if (cmd.t === "prompt") {
      // A prompt is not a wire-level command we may replay later: the replay knows nothing about what
      // the agent did in the meantime, so a message pressed during a blip can land on a busy turn and
      // be refused. File it in the queue instead — the queue is the operator's, it survives a reload,
      // and it hands over at the next turn-end with `interrupt: true`, which is safe either way.
      this.enqueuePrompt(cmd.sessionId, cmd.text, cmd.attachments ?? []);
      this.#setNet(false, "连接已断开 — 消息已排队，重连后自动发送");
      return false;
    }
    if (cmd.t === "respond-permission") {
      this.#outbox.push(cmd);
      if (this.#outbox.length > 20) this.#outbox.shift();
      this.#setNet(false, "连接已断开 — 指令已排队，重连后自动发送");
      return false;
    }
    this.#setNet(false, "连接已断开 — 该操作未能送达");
    return false;
  }

  // ---- the message queue ------------------------------------------------------------------------
  // While a turn is running the composer is not a dead end any more: Enter still files the prompt,
  // it just waits its turn. The queue is the operator's, so it is rendered with its own buttons and
  // persisted — a reload (a deploy, a phone waking up) must not eat a message he already wrote.

  #queueKey(id: string): string { return `agentus.queue.${id}`; }

  /** The raw stored rows — no registration, so a read never has a side effect on the map. `inflight`
   *  is dropped on the way in: a page that just loaded has nothing in flight, and a row stuck in
   *  "sending…" would block the whole line behind it. */
  #readStoredQueue(id: string): QueuedPrompt[] {
    try {
      const raw = localStorage.getItem(this.#queueKey(id));
      const rows = raw ? (JSON.parse(raw) as QueuedPrompt[]) : [];
      if (!Array.isArray(rows)) return [];
      return rows
        .filter((r) => r && typeof r.text === "string" && r.text.trim())
        .map((r) => ({
          id: String(r.id ?? `q-${r.at ?? Date.now()}`), text: r.text, attachments: r.attachments ?? [], at: r.at ?? Date.now(),
          // `unsure` survives a reload (issue #26): a message that was never confirmed is still
          // unconfirmed after a refresh, and must not turn into an ordinary queued row that the
          // drain would then send on its own.
          ...(r.unsure ? { unsure: true, pid: typeof r.pid === "string" ? r.pid : undefined } : {}),
        }));
    } catch { return []; }
  }

  /** A view built for a session that already has a persisted queue adopts it (a reload mid-queue). */
  #loadQueue(id: string): QueuedPrompt[] {
    const rows = this.#queues.get(id) ?? this.#readStoredQueue(id);
    if (rows.length) this.#queues.set(id, rows);
    return rows;
  }

  /** After a (re)connect: every session holding queued prompts gets a chance to drain, but only if
   *  its turn is not running — those wait for the turn-end that is still coming. */
  drainPersistedQueues(): void {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith("agentus.queue.")) continue;
        const sid = key.slice("agentus.queue.".length);
        this.#loadQueue(sid);
        this.drainQueue(sid);
      }
    } catch { /* storage off: nothing persisted to drain */ }
  }

  /** One place writes `#queues` + localStorage + the session view, so the UI can never disagree
   *  with what will actually be sent. */
  #setQueue(id: string, rows: QueuedPrompt[]): void {
    if (rows.length) this.#queues.set(id, rows); else this.#queues.delete(id);
    try {
      if (rows.length) localStorage.setItem(this.#queueKey(id), JSON.stringify(rows));
      else localStorage.removeItem(this.#queueKey(id));
    } catch { /* private mode — the queue still works for this page load */ }
    const v = this.byId.get(id);
    if (v) v.queue = rows;
    this.bump();
  }

  /** File the start page's picks against a session that does not exist yet. They are replayed at
   *  `ready` as the very frames the chat composer sends for the same controls — see `#applySetup`.
   *  Empty picks are not stored: "the agent's default" is the ABSENCE of a frame, not a frame that
   *  says so, and a frame with the value already in force would be a harmless but noisy round-trip. */
  queueSetup(sessionId: string, picks: SetupPick[]): void {
    if (picks.length) this.#setup.set(sessionId, picks);
  }

  /** Replay those picks onto a session that has just come up, ahead of its queued first message.
   *  One burst is enough: the socket's commands are processed in order, so a prompt sent right after
   *  them cannot overtake them. */
  #applySetup(sessionId: string): void {
    const picks = this.#setup.get(sessionId);
    if (!picks?.length) return;
    this.#setup.delete(sessionId);
    for (const p of picks) {
      if (p.kind === "model") this.send({ t: "set-model", sessionId, modelId: p.value });
      else if (p.kind === "mode") this.send({ t: "set-mode", sessionId, modeId: p.value });
      else this.send({ t: "set-config", sessionId, configId: p.id, value: p.value });
    }
  }

  /** File a prompt for later. It goes out on its own when the running turn ends. */
  enqueuePrompt(sessionId: string, text: string, attachments: PromptAttachment[] = []): void {
    const rows = this.#queues.get(sessionId) ?? [];
    this.#setQueue(sessionId, [...rows, {
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text, attachments, at: Date.now(),
    }]);
  }

  /** Enter on a COLD slot: the message ends up in line exactly ONCE and the wake starts now.
   *
   *  Why a dedicated verb rather than enqueue + resume at the call site: pressing Enter again while
   *  the spawn is still coming up is the operator RETRYING A CLICK, not writing a second message
   *  (2026-10-10: 「第一次去回车的时候，它还没反应，要过一会还要再去点一次回车，它才会把消息发送出去」)
   *  — appending would send his words twice. The dedupe is deliberately narrow: same text, filed
   *  within a few seconds, and the slot is not up yet. A genuinely repeated 「继续」 into a session
   *  that IS running still files normally, because there the repeat is a real second message.
   *
   *  `resume()` runs on every call, so `#resuming` still guarantees one spawn per slot. */
  sendToCold(sessionId: string, text: string, attachments: PromptAttachment[] = []): void {
    const rows = this.#queues.get(sessionId) ?? this.#loadQueue(sessionId);
    const last = rows[rows.length - 1];
    const up = this.sessions.some((s) => s.id === sessionId && s.status === "ready");
    const retry = Boolean(last && last.text === text && !up && Date.now() - last.at < 5_000);
    const empty = !text.trim() && !attachments.length;
    if (!retry && !empty) this.enqueuePrompt(sessionId, text, attachments);
    void this.resume(sessionId);
  }

  /** Is a turn running on this session?
   *
   *  `v.busy` is set by the `turn-start` FRAME, so it is only true for turns this page watched begin.
   *  A page that connected (or reconnected) after the turn had already started — the operator typing
   *  through a server restart is the everyday case — has `busy: false` while the agent is mid-turn and
   *  the server's own state says `status: "running"`. Believing `busy` alone is how the composer came
   *  to offer a send button for a busy agent: the bare prompt then met "turn already running", and the
   *  operator's sentence died in a red bubble (2026-10-17). `status` is the server's word and rides
   *  every `sessions` snapshot, so it survives reconnects; `busy` still wins for the first instant
   *  after our own send, before the status frame lands. */
  /** The ✕: drop it. (Nothing was sent, so there is nothing to undo server-side.) */
  dropQueued(sessionId: string, id: string): void {
    const rows = this.#queues.get(sessionId) ?? [];
    this.#setQueue(sessionId, rows.filter((r) => r.id !== id));
  }

  /** The ✎: rewrite it in place, keeping its place in line. */
  editQueued(sessionId: string, id: string, text: string): void {
    const rows = this.#queues.get(sessionId) ?? [];
    const next = text.trim();
    this.#setQueue(sessionId, next
      ? rows.map((r) => (r.id === id ? { ...r, text: next } : r))
      : rows.filter((r) => r.id !== id)); // emptied = dropped, not an empty prompt in line
  }

  /** The ↑: take the floor NOW. `interrupt: true` is the server's own "cancel the running turn and
   *  wait for it to really stop" hand-over — the same path a spoken call utterance uses. */
  sendQueuedNow(sessionId: string, id: string): void {
    const rows = this.#queues.get(sessionId) ?? [];
    const item = rows.find((r) => r.id === id);
    if (!item) return;
    this.#takingFloor.add(sessionId);
    // An explicit ↑ is the operator overriding the "not delivered" verdict: the row stops being
    // `unsure` and takes the ordinary in-flight path (its `turn-start` settles it, #26).
    this.#setQueue(sessionId, rows.map((r) => (r.id === id ? { ...r, inflight: true, unsure: false } : r)));
    // Acknowledged like any other send (#26): a retry can hit the same dead socket, and then the row
    // has to come back rather than sit in "sending…" forever.
    this.#sendAcked(sessionId, { text: item.text, attachments: item.attachments, interrupt: true, rowId: id });
  }

  /** ⌘/Ctrl+Enter — 插话: put what is in the box on the floor NOW, interrupting the running turn.
   *
   *  Deliberately composed of the two verbs above rather than a third send path: file it
   *  (`enqueuePrompt`), then force it through (`sendQueuedNow`). That way the operator's words get
   *  exactly what a queued message gets — a ✕/✎ row in history, the `#takingFloor` guard against
   *  two turns racing, and the same `interrupt: true` hand-over the queue's ↑ button and a spoken
   *  call utterance both use. A separate "send with interrupt" call site would be a second place for
   *  the queue and the wire to disagree.
   *
   *  Idle/ready is not a special case: `interrupt` on a session with no turn running is a plain
   *  prompt (the server only cancels when there is something to cancel). A COLD slot has no turn to
   *  interrupt either, so App routes it through `sendToCold` (one wake, deduped, interrupt on drain). */
  sendNow(sessionId: string, text: string, attachments: PromptAttachment[] = []): void {
    if (!text.trim() && !attachments.length) return;
    this.#loadQueue(sessionId);
    this.enqueuePrompt(sessionId, text, attachments);
    const rows = this.#queues.get(sessionId) ?? [];
    const filed = rows[rows.length - 1];
    if (filed) this.sendQueuedNow(sessionId, filed.id);
  }

  /** Hand the head of the line to the server. Called when a turn ends and when a session turns idle. */
  drainQueue(sessionId: string): void {
    const rows = this.#queues.get(sessionId) ?? this.#loadQueue(sessionId);
    const head = rows[0];
    if (!head || head.inflight) return;
    // Never auto-resend a prompt the server never confirmed (#26): it may have landed after all, and
    // the operator decides with ↑. Draining it here is how one message becomes two.
    if (head.unsure) return;
    // Someone is taking the floor by hand: the next item waits for that turn to start (see #takingFloor).
    if (this.#takingFloor.has(sessionId)) return;
    // `busy` is FALSE (not unknown) on a page that missed the turn-start, so `?? status` never fired
    // and a reload could hand a prompt to a running turn with `interrupt: true` — i.e. quietly cancel
    // the operator's own long turn. Ask the same question the send button asks.
    const busy = busyNow(this.byId.get(sessionId))
      || this.sessions.find((s) => s.id === sessionId)?.status === "running";
    if (busy) return;
    // Interrupt is what makes this safe: the server clears its own `busy` flag in the `finally`
    // right after emitting turn-end, so a plain prompt can still meet "turn already running" — and
    // with interrupt it simply waits for a turn that is already over. (It only cancels if one is
    // genuinely still running, which is the case this whole feature exists for.)
    this.#setQueue(sessionId, rows.map((r) => (r.id === head.id ? { ...r, inflight: true } : r)));
    // …and it is acknowledged like an Enter (#26): a drain into a dead socket would otherwise drop
    // the operator's next message with no trace at all.
    this.#sendAcked(sessionId, { text: head.text, attachments: head.attachments, interrupt: true, rowId: head.id });
  }

  /** `turn-start` proves an inflight prompt landed: it has left the queue (it is a real message now). */
  #settleQueue(sessionId: string): void {
    this.#takingFloor.delete(sessionId);
    const rows = this.#queues.get(sessionId) ?? [];
    if (!rows.some((r) => r.inflight)) return;
    this.#setQueue(sessionId, rows.filter((r) => !r.inflight));
  }

  /** A turn ended in FAILURE with a prompt still inflight: it never landed, so put it back in line
   *  instead of dropping the operator's words on the floor. */
  #requeueInflight(sessionId: string): void {
    this.#takingFloor.delete(sessionId);
    const rows = this.#queues.get(sessionId) ?? [];
    if (!rows.some((r) => r.inflight)) return;
    this.#setQueue(sessionId, rows.map((r) => (r.inflight ? { ...r, inflight: false } : r)));
  }

  setActive(id: string): void {
    this.activeId = id;
    this.#rememberActive(id);
    // …and the address bar says so (issue #20): a cockpit whose URL is always `/` cannot be shared,
    // bookmarked or re-opened on the conversation you meant.
    this.#writeUrl(id);
    // Looking at a session IS the acknowledgement of its completion dot (AionUi clears the same set on
    // open). Only the transient half: a mark the operator made BY HAND is their own statement and goes
    // away through the menu that made it, not because they glanced at the row.
    this.clearUnread(id);
    this.#snapshot = this.#build();
    this.bump();
    const v = this.byId.get(id);
    if (v && !v.loaded) void this.loadHistory(id);
  }

  /** 「跑完了，还没看」: a turn ended in a session the operator was not in. The whole point of the dot
   *  — with several slots going at once, the rail is the only place that can say WHICH one needs them. */
  markUnread(id: string): void {
    if (this.#unread.has(id)) return;
    this.#unread = new Set(this.#unread).add(id);
    this.bump();
  }

  /** The acknowledgement (opening the row). Hand-set marks are untouched — see `setActive`. */
  clearUnread(id: string): void {
    if (!this.#unread.has(id)) return;
    const next = new Set(this.#unread);
    next.delete(id);
    this.#unread = next;
    this.bump();
  }

  /** Does this row wear the dot? What the rail renders, and what the menu's label answers to. */
  isUnread(id: string): boolean {
    return this.#unread.has(id) || this.#manualUnread.has(id);
  }

  /** The row menu: 「设为未读」 / 「设为已读」. Marking is PERSISTED — 「点进去看了，但还没决策」 has to
   *  outlive the glance that made it necessary (and usually a reload too). Clearing drops BOTH halves,
   *  because the operator asking for 已读 is answering the question the dot asks, whichever raised it. */
  toggleUnread(id: string): void {
    if (this.isUnread(id)) {
      const t = new Set(this.#unread);
      t.delete(id);
      this.#unread = t;
      const m = new Set(this.#manualUnread);
      m.delete(id);
      this.#manualUnread = m;
    } else {
      this.#manualUnread = new Set(this.#manualUnread).add(id);
    }
    persistUnread(this.#manualUnread);
    this.bump();
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
      // A READ is history, and history is not still arriving: whatever `open` the frames above carried
      // (they are stored rows, not a running stream), the rebuild decides. Otherwise a transcript read
      // while an unrelated event marked a row would render a live 「思考中…」 window on a finished turn —
      // and since nothing about that row changes afterwards, nothing would ever clear it.
      this.#endOpenBubbles(v);
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
  /** Returns how many NEW bubbles the page added. Zero is a real answer — every row in the page was
   *  a fragment of a block already on screen — and the transcript says so instead of doing nothing
   *  visible (issue #56: 1,427 silent clicks to reach the start of one qoder session). */
  async loadEarlier(id: string): Promise<number> {
    const v = this.#view(id);
    if (v.loadingOlder || !v.hasOlder || v.minSeq == null) return 0;
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
          // Replace (see foldTextRow): the row must change IDENTITY for its memo to see the text.
          if (older.text.length > live.text.length) {
            const li = v.msgs.indexOf(live);
            if (li >= 0) v.msgs[li] = { ...live, text: older.text } as typeof live;
          }
          continue;
        }
        fresh.push(b);
      }
      if (fresh.length) v.msgs = [...fresh, ...v.msgs];
      v.blocks = reindexBlocks(v.msgs);
      v.hasOlder = Boolean(hasOlder);
      return fresh.length;
    } catch {
      /* keep hasOlder so the affordance stays for a retry */
      return -1;
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

  /** Read a file for the panel: text plus what the panel needs to render and edit it
   *  (`kind`, `hash`, `editable` — see the server's fs.ts, one table decides both sides). */
  async readFile(path: string): Promise<{
    path: string; name: string; size: number; content: string; truncated: boolean; binary: boolean;
    kind: string; contentType: string; mtimeMs: number; hash: string; editable: boolean;
  }> {
    return await this.#req(`/api/fs/file?path=${encodeURIComponent(path)}`);
  }

  /** Stat only — no bytes. The panel asks this first so an image or a PDF is not pulled
   *  through the text endpoint, and so a cheap poll can notice the agent rewriting the file
   *  the editor is showing. */
  async statFile(path: string): Promise<{
    path: string; name: string; kind: string; contentType: string; size: number;
    mtimeMs: number; hash: string; editable: boolean;
  }> {
    return await this.#req(`/api/fs/stat?path=${encodeURIComponent(path)}`);
  }

  /** Save an edit from the panel. `ifHash` is the hash the editor loaded: the server refuses
   *  (409, with the current bytes) rather than overwrite a rewrite the agent made meanwhile. */
  async writeFile(path: string, content: string, ifHash?: string): Promise<{
    ok: true; path: string; size: number; mtimeMs: number; hash: string;
  }> {
    return await this.#req(`/api/fs/file`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, content, ...(ifHash ? { ifHash } : {}) }),
    }, { retry: false });
  }

  /** Fork a session: the agent copies its context into a new session (ACP
   *  `session/fork`), and we bring that up as its own session. Resolves to the new one. */
  async fork(id: string): Promise<string> {
    const info = await this.#req<SessionInfo>(`/api/sessions/${id}/fork`, { method: "POST" },
      // the source may need resuming first, and the fork itself is a spawn + load
      { timeoutMs: 120_000, retry: false });
    if (!this.sessions.some((s) => s.id === info.id)) this.sessions = [info, ...this.sessions];
    this.cold = this.cold.filter((s) => s.id !== info.id);
    this.archived = this.archived.filter((s) => s.id !== info.id);
    this.setActive(info.id);
    return info.id;
  }

  /** Switch the model of a live slot (ACP `session/set_model`).
   *
   *  Returns the server's session info: on a COLD slot the server only parks the choice as
   *  `pendingModelId` (no agent to talk to), so the caller has to tell "it took effect" from
   *  "it is queued" — `models.currentModelId === modelId` is that difference. */
  async setModel(id: string, modelId: string): Promise<SessionInfo> {
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
    return info;
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

  /** Create a session; returns as soon as the ROW exists (`status: "starting"`).
   *
   *  It used to hold the request open for the agent's whole handshake — hermes boots a python
   *  process and answers `initialize` + `session/new` in 10–40 s, which is why this carried a 120 s
   *  timeout and why the operator watched a busy dialog with nothing to read. The server now
   *  answers while the slot is still coming up (`SessionManager.#startup` runs off the request), so
   *  this is an ordinary call: the page opens the session, files the first message into its queue,
   *  and the queue drains when `{t:"session"}` reports `ready` (see `case "session"` below).
   *
   *  Still no retry, for the original reason: a retry would spawn a second child for one click. */
  async createSession(backend: string, cwd: string, title: string): Promise<string> {
    const info = await this.#req<SessionInfo>(
      "/api/sessions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ backend, cwd, title: title || undefined }),
      },
      { retry: false },
    );
    // Seed the view from the response so the page can draw the `starting` session before any WS
    // frame about it arrives (the frame that carries `ready` does come — `#updateSession`).
    const v = this.#view(info.id);
    v.info = { ...v.info, ...info };
    if (!this.sessions.some((s) => s.id === info.id)) this.sessions = [info, ...this.sessions];
    this.bump();
    return info.id;
  }

  /** Pull the two ON-DISK lists: cold rows (no process, not archived) and the operator's archive.
   *  Kept as REST (not only a WS event) so the rail still fills when the socket is down. */
  async refreshRows(): Promise<void> {
    try {
      const { cold, archived } = await this.#req<{ cold?: SessionInfo[]; archived?: SessionInfo[] }>("/api/sessions");
      this.cold = cold ?? [];
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
    for (const list of [this.sessions, this.cold, this.archived]) {
      const i = list.findIndex((s) => s.id === id);
      if (i >= 0) list[i] = { ...list[i], ...info };
    }
    this.bump();
    return res;
  }

  /** Wake a cold slot's agent process — WITHOUT making the conversation wait for it.
   *
   *  The order is the point (2026-10-10: 「点击会话时要等好一会，是在阻塞等待 acp 启动吗，可以做成异步的吧，
   *  先渲染出来」). Reading a transcript needs OUR rows, not a live agent, so the view switches and
   *  pages its history in the moment the operator clicks; the spawn (seconds: fork + `session/load`)
   *  runs behind it and only updates the status when it lands. `setActive` used to sit AFTER the
   *  await, which is why a cold row kept him staring at the previous session until the handshake
   *  finished. */
  async resume(id: string): Promise<void> {
    // ① The view first. `#view()` creates the row's view if the rail has not built one yet, so
    //    `setActive` finds it and fires the history fetch below in the same tick.
    this.#view(id);
    this.setActive(id);
    // ② One spawn per slot, however many ways he asks (the row, Enter, the send button and the
    //    slash palette all funnel here, and all of them can be hit again while it is coming up).
    if (this.#resuming.has(id)) return;
    this.#resuming.add(id);
    this.#view(id).resuming = true;
    this.bump();
    try {
      const info = await this.#req<SessionInfo>(`/api/sessions/${id}/resume`, { method: "POST" }, { timeoutMs: 120_000, retry: false });
      this.#view(id).info = info;
      if (!this.sessions.some((s) => s.id === id)) this.sessions = [info, ...this.sessions];
      this.cold = this.cold.filter((s) => s.id !== id);
      // NOT removed from `archived` unconditionally: a resume does not clear the flag, so a row the
      // operator archived and then restored stays in 已归档 (as a live row) until they un-archive it.
      // The agent replays its own transcript into the store during `session/load`, so re-read ours:
      // the rows that arrived while we were spawning are what the operator is about to look at.
      await this.loadHistory(id);
    } catch (e) {
      const status = (e as { httpStatus?: number }).httpStatus;
      const body = (e as { httpBody?: ResumeRefusal }).httpBody;
      // A refused resume is the server ANSWERING, not an outage, and no retry changes it: the
      // slot's agent-side state is somewhere this backend row cannot reach. Say why, name both
      // homes, and offer the only action that helps — delete it (the transcript is the operator's;
      // the dead handoff is not).
      if (status === 409 && (body?.code === "home_mismatch" || body?.code === "context_missing")) {
        const info = this.sessions.find((s) => s.id === id) ?? this.cold.find((s) => s.id === id)
          ?? this.archived.find((s) => s.id === id);
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
    } finally {
      this.#resuming.delete(id);
      this.#view(id).resuming = false;
      this.bump();
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
      for (const list of [this.sessions, this.cold, this.archived]) {
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
    this.sessions = this.sessions.filter((s) => s.id !== id);
    this.cold = this.cold.filter((s) => s.id !== id);
    this.archived = this.archived.filter((s) => s.id !== id);
    this.byId.delete(id);
    this.bump();
    void this.#req(`/api/sessions/${id}`, { method: "DELETE" })
      .catch(() => this.refreshRows())
      .then(() => this.refreshRows());
  }

  /** 归档 / 取消归档 — the operator's own STORAGE decision, taken independently of the process (the
   *  server stops a live slot's child as part of archiving it, which is why the row can leave 工作空间
   *  in the same breath). The server is the truth here: its sessions frame carries all three buckets,
   *  and this only makes the rail move without waiting for the round trip.
   *
   *  Restoring is deliberately TWO statements (out of 已归档, then wake it) — see
   *  unarchiveAndResume — so a slot that cannot be adopted leaves a visible cold row instead of an
   *  error nobody asked for. */
  async setArchived(id: string, on: boolean): Promise<SessionInfo | null> {
    try {
      const info = await this.#req<SessionInfo>(
        `/api/sessions/${id}/${on ? "archive" : "unarchive"}`,
        { method: "POST" },
      );
      const view = this.byId.get(id);
      if (view) view.info = { ...view.info, ...info };
      if (on) {
        this.sessions = this.sessions.filter((s) => s.id !== id);
        this.cold = this.cold.filter((s) => s.id !== id);
        if (!this.archived.some((s) => s.id === id)) this.archived = [info, ...this.archived];
        if (this.activeId === id) this.#pickNextActive();
      } else {
        this.archived = this.archived.filter((s) => s.id !== id);
        if (!this.sessions.some((s) => s.id === id) && !this.cold.some((s) => s.id === id)) {
          this.cold = [info, ...this.cold];
        }
      }
      this.bump();
      return info;
    } catch (e) {
      this.#setNet(false, `${on ? "归档" : "取消归档"}失败：${String((e as Error).message ?? e)}`);
      return null;
    }
  }

  /** The rail's 「取消归档并恢复」: take it out of 已归档, then wake it. */
  async unarchiveAndResume(id: string): Promise<void> {
    await this.setArchived(id, false);
    await this.resume(id);
  }

  /** The session to fall back to when the active one stops being 工作空间 material (it was archived
   *  or purged). Kept identical to the old close-time behaviour: the newest remaining row wins —
   *  a live one first, then cold, then anything archived. */
  #pickNextActive(): void {
    const next = this.sessions[0] ?? this.cold[0] ?? this.archived[0] ?? null;
    this.activeId = next?.id ?? null;
    this.#rememberActive(this.activeId);
    if (next && !this.sessions.some((s) => s.id === next.id)) void this.loadHistory(next.id);
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
    /** `undefined` = this frame carries no name (an ACP plan frame never does) ⇒ keep what is on the
     *  card; `null` = the server's plan OBJECT says there is no name ⇒ CLEAR it. The object is the
     *  whole truth about the title, a frame is silent about it — collapsing the two would make a
     *  cleared name immortal on the card. */
    title?: string | null,
  ): void {
    const live = v.plan;
    if (!live) {
      v.plan = { key: `plan-${v.turn}`, items, terminal, explanation, at, turn: v.turn, title: title ?? undefined };
      return;
    }
    if (live.turn === v.turn) {
      // same turn: the snapshot replaces the list in place (the agent rewriting its own plan).
      // `title: undefined` means "this frame has none", NOT "clear it": an ACP plan frame carries no
      // title at all (it is cockpit-side, #11), so the object's name must survive every frame.
      live.items = items;
      live.terminal = terminal;
      live.explanation = explanation;
      if (title !== undefined) live.title = title ?? undefined;
      return;
    }
    // a new turn produced a plan: retire the old one to the END of ITS turn
    const at2 = v.turnStart > 0 && v.turnStart <= v.msgs.length ? v.turnStart : v.msgs.length;
    v.msgs.splice(at2, 0, {
      key: live.key, kind: "plan", items: live.items, terminal: live.terminal,
      explanation: live.explanation, at: live.at, title: live.title,
    });
    v.blocks = reindexBlocks(v.msgs);
    v.turnStart = Math.min(v.turnStart + 1, v.msgs.length);
    v.plan = { key: `plan-${v.turn}`, items, terminal, explanation, at, turn: v.turn, title: title ?? undefined };
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
      plan.title?.trim() || null,
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
        msgs: [], notes: [], perms: [], busy: false, busySince: null, loaded: false, hasOlder: false, loadingOlder: false,
        minSeq: null, lastAt: Date.now(), rev: 0, seen: new Set(), blocks: new Map(),
        plan: null, turn: 0, turnStart: 0,
        queue: this.#loadQueue(id),
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
        // Three buckets from the server (live / cold-but-not-archived / archived), and "does it still
        // exist" is their UNION: an archived row keeps its view (the operator can leave it open and
        // read it after putting it away), and pruning by the live list alone would throw away a
        // transcript that is still perfectly readable.
        this.sessions = e.sessions;
        // A missing bucket means "no news", never "empty": `?? []` deleted the operator's rows when
        // a producer omitted them, and the rail then showed only what is live (the 「刷新后只剩活跃
        // 会话」 report — the manager's own emit omitted cold/archived). The server sends all three
        // always; `[]` is a real, explicit "none", which still lands below.
        if (e.cold) this.cold = e.cold;
        if (e.archived) this.archived = e.archived;
        const live = new Set([
          ...e.sessions.map((s) => s.id),
          ...this.cold.map((s) => s.id),
          ...this.archived.map((s) => s.id),
        ]);
        for (const s of [...e.sessions, ...this.cold, ...this.archived]) {
          const v = this.#view(s.id);
          // `cold` is the server's word for "no process" — keep it on the view's own info, or a
          // button that depends on liveness (resume vs switch) reads the wrong state.
          v.info = { ...v.info, ...s };
        }
        // Background snapshots (issue #22) are STATE and ride this frame, so a page that connects after
        // the agent last spoke is still honest. A missing field means "no news" — never "none" — for the
        // same reason the three buckets above do: a producer that omits it must not blank a row.
        if (e.background) {
          const seen = new Set(e.background.map((b) => b.sessionId));
          for (const b of e.background) this.#view(b.sessionId).background = b.tasks;
          for (const [id, v] of this.byId) if (!seen.has(id) && v.background?.length) v.background = [];
        }
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
          this.#syncPermAnswers();
        }
        // prune views whose session vanished server-side (restart / close elsewhere)
        for (const id of [...this.byId.keys()]) if (!live.has(id)) this.byId.delete(id);
        if (this.activeId && !live.has(this.activeId)) {
          this.activeId = null;
          this.#rememberActive(null);
        }
        if (!this.activeId && live.size) {
          // restore the slot the operator left, else the newest one (server list
          // is already newest-first — QA#7). Cold/archived rows count too: an instance whose only
          // session is a resting slot should still open it instead of showing an empty cockpit.
          const remembered = this.#restoreActive();
          const pick = remembered && live.has(remembered)
            ? remembered
            : (e.sessions[0]?.id ?? this.cold[0]?.id ?? this.archived[0]?.id);
          if (pick) {
            this.activeId = pick;
            void this.loadHistory(pick);
          }
        }
        // A slot that just CAME UP may be holding a prompt filed while it was cold: the operator's
        // Enter files it and the wake follows, but `drainQueue` was only ever reached from a
        // turn-END — and a slot that was just woken runs no turn, so nothing ever drained it. That
        // missing trigger IS the 「要按两次回车」 behaviour (2026-10-10). Same guards as every other
        // drain: not busy, head not inflight, nobody taking the floor by hand.
        for (const s of this.sessions) {
          if (s.status !== "ready") continue;
          if (this.#queues.get(s.id)?.length) this.drainQueue(s.id);
        }
        break;
      }
      case "session": {
        // ONE ROW LIVES IN ONE BUCKET (issue #13). This is the single-row update path, and an ACP spawn
        // is a storm of these frames (starting→ready, then modes/configOptions/usage each emit one), so
        // the row's previous copy was still in `cold` when the live copy landed — the rail drew the same
        // session 2~3 rows deep, every copy lit up because they share an id. The full `sessions` snapshot
        // used to be the only thing that repaired it, which is why the duplicates were transient.
        // A live frame therefore DROPS the cold copy; a `cold:true` frame (a rename / auto-title of a
        // resting slot) moves the row OUT of `sessions` instead of leaving a second copy behind.
        if (e.session.cold === true) {
          this.sessions = this.sessions.filter((s) => s.id !== e.session.id);
          this.cold = this.cold.map((s) => (s.id === e.session.id ? e.session : s));
          if (!this.cold.some((s) => s.id === e.session.id)) this.cold.push(e.session);
        } else {
          this.sessions = this.sessions.map((s) => (s.id === e.session.id ? e.session : s));
          if (!this.sessions.some((s) => s.id === e.session.id)) this.sessions.push(e.session);
          this.cold = this.cold.filter((s) => s.id !== e.session.id);
        }
        this.#view(e.session.id).info = e.session;
        // A slot that just CAME UP may be holding a prompt filed before it could take one: the first
        // message of a session being created (filed into the queue the moment the row existed, when
        // the agent was still booting), or one filed while it was cold. Nothing else drains it — a
        // freshly-started slot runs no turn to end. Same guards as the `sessions` case.
        // A slot that just came up also carries whatever the START PAGE picked for it, and those
        // frames go FIRST: the agent must not be handed a prompt under a configuration the operator
        // replaced before it could read one.
        if (e.session.status === "ready") this.#applySetup(e.session.id);
        if (e.session.status === "ready" && this.#queues.get(e.session.id)?.length) {
          this.drainQueue(e.session.id);
        }
        break;
      }
      case "messages": {
        const v = this.#view(e.sessionId);
        if (e.partial) {
          // reconnect tail (resume): merge into what we already rendered.
          // seq-dedup in #ingest drops the overlap; a rebuild here would lose
          // everything before the drop (QA#17).
          // `resync` — not a plain merge: the rows the client last saw may have GROWN while the socket
          // was down, so the tail re-states them and #ingest re-applies what it can fold by identity.
          for (const m of e.messages) this.#ingest(v, m, { resync: true });
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
        // A prompt refused with "turn already running" never became a message, and the red bubble is
        // not a place to keep the operator's sentence: file it again so the queue hands it over at
        // turn-end. A race costs a delay; it must not cost the words.
        const rejected = (e.message as { payload?: { rejectedPrompt?: unknown; pid?: unknown } }).payload?.rejectedPrompt;
        // A refusal names the prompt it refused: drop the ack budget for it, because the branch below
        // is already putting that sentence back in line (#26). Without this the timeout fires later
        // and files a SECOND copy of the same message.
        const refusedPid = (e.message as { payload?: { pid?: unknown } }).payload?.pid;
        if (typeof refusedPid === "string") this.#forgetSent(refusedPid);
        if (e.message.kind === "meta" && typeof rejected === "string" && rejected.trim()) {
          this.enqueuePrompt(e.message.sessionId, rejected);
        }
        // `delta` is present when this frame GREW a block we already hold (the store accumulates one
        // row per message now); without it the row is the whole truth and replaces the block's text.
        // `n` is that block's total length — the frame's version, since a grown row keeps its seq.
        this.#ingest(v, e.message, { delta: e.delta, n: e.n });
        v.lastAt = Date.now();
        this.lastSeq[e.message.sessionId] = Math.max(this.lastSeq[e.message.sessionId] ?? 0, e.message.seq);
        break;
      }
      // The agent's own status lines (issue #18), appended as transcript rows — see `notes` on
      // SessionView for why they live in memory only.
      //
      // COALESCE BY KIND, and only against the NEWEST row: a compaction emits 「summarizing…」 then a
      // heartbeat every few seconds then 「complete」. Appending every frame would turn one compaction
      // into a dozen rows of noise; comparing only with the newest means a heartbeat UPDATES the row
      // it belongs to, while a genuinely new kind (or a line arriving after other rows) starts its
      // own. The row keeps its original `at`, so 「started 13:24:07」 survives the heartbeat rewrite.
      case "status": {
        const v = this.#view(e.sessionId);
        const at = Date.now();
        const last = v.notes[v.notes.length - 1];
        const afterKey = v.msgs.length ? v.msgs[v.msgs.length - 1].key : null;
        if (last && e.statusKind && last.kind === e.statusKind) {
          last.text = e.text;
          last.afterKey = afterKey;
        } else {
          v.notes.push({ key: `st-${at}-${v.notes.length}`, kind: e.statusKind, text: e.text, at, afterKey });
          // Bounded: a session left open for days must not accumulate every recall it ever did.
          if (v.notes.length > 200) v.notes.splice(0, v.notes.length - 200);
        }
        v.lastAt = at;
        break;
      }
      case "background": {
        // Snapshot, not news: replace wholesale (#22). `lastAt` is deliberately NOT touched — a process
        // finishing is not the operator being spoken to, and moving the clock would rewrite the rail's
        // 「刚刚」 for a conversation nobody opened.
        this.#view(e.sessionId).background = e.tasks;
        break;
      }
      case "turn-start": {
        const v = this.#view(e.sessionId);
        v.busy = true;
        v.busySince = Date.now(); // the tail line's zero: the operator's send, not the first token
        v.lastAt = Date.now();
        v.trace = e.trace ?? null;
        // A queued prompt that reached `turn-start` HAS landed: it is a real message in the transcript
        // now, so it leaves the queue. This is the proof the queue waits for.
        this.#settleQueue(e.sessionId);
        // …and a READY-session send that carried a `pid` is proven the same way (#26).
        this.#confirmSent(e.sessionId, e.pid);
        // NOTE: the previous turn's bubbles are closed by the turn-end that preceded this (and by the
        // `.live` fallback in App's foldWork). Do NOT re-run #endOpenBubbles here: a turn that starts
        // while the previous one is still on screen would close a bubble that is about to grow again.
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
      case "speak": {
        // The cockpit's own line about this session (工作播报, issue #16). Kept as a bounded ring on
        // the view: the speaker reads the newest entry, and a page that reconnects must not replay
        // the last ten briefs aloud (the ring is empty on a fresh view).
        const v = this.#view(e.sessionId);
        const line = { id: e.id, text: e.text, kind: e.kind, priority: e.priority, at: Date.now() };
        v.speaks = [...(v.speaks ?? []), line].slice(-10);
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
        // A turn that ended in ANOTHER session is news the operator has not seen: dot its row. The
        // session they are looking at needs no dot (they are watching it finish), and a page that
        // reloads starts with an empty completion set — the dot is about 「刚刚发生了什么」, and the
        // rail's timestamp still says what happened while they were away.
        if (e.sessionId !== this.activeId) this.markUnread(e.sessionId);
        v.busySince = null; // a finished turn has no elapsed time; a later frame must not inherit it
        // `notes` deliberately SURVIVE turn-end: 「压缩花了多久」 is most useful one second after the
        // turn stops, and they are dropped by a refresh anyway (in memory only).
        // Close the block that was still arriving — a data change, so the transcript re-renders THAT
        // row and drops its `.live` marking. Relying on "the last row of the fold, while busy" used to
        // leave the window marked live FOREVER: the block carrying the marking is early in the turn
        // (the agent keeps thinking after a tool call), nothing about it changes at turn-end, and a row
        // that does not change does not re-render (measured 2026-10-08: the page kept showing a live
        // 「思考中…」 window and 「▸ turn in progress…」 for 150s+ after the server said ready — the
        // operator's 「早就结束了还一直在渲染中间过程，强制刷新才到完结态」). */
        this.#endOpenBubbles(v);
        if (e.error) v.msgs.push({ key: `err-${Date.now()}`, kind: "meta", text: e.error });
        // The queue's turn (Studio's message queue): a prompt written while the agent was working goes
        // out by itself now. A turn that FAILED is the one case we do not auto-retry — the item goes
        // back in line (nothing lost) and stays visible with its ↑ button, because re-sending into a
        // broken turn would loop.
        if (e.error) this.#requeueInflight(e.sessionId);
        else this.#settleQueue(e.sessionId);
        if (!e.error) {
          const sid = e.sessionId;
          window.setTimeout(() => this.drainQueue(sid), 250);
        }
        break;
      }
      case "permission":
        this.#view(e.request.sessionId).perms.push(e.request);
        break;
      case "permission-resolved":
        for (const v of this.byId.values()) v.perms = v.perms.filter((p) => p.requestId !== e.requestId);
        this.#syncPermAnswers();
        break;
      case "permission-expired":
        // The answer landed nowhere (the server's request was already gone — our own timeout, or
        // the agent gave up first). Say so: a click that silently does nothing is the failure
        // shape the operator cannot tell from a broken button.
        for (const v of this.byId.values()) v.perms = v.perms.filter((p) => p.requestId !== e.requestId);
        this.#syncPermAnswers();
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
      case "notify": {
        // A browser notification for THIS machine. Nothing to add here: the frame is already
        // render-ready (the server owns the wording, the same strings the phone's cards carry), so the
        // store hands it straight to the renderer. Whether this device shows it — and whether it makes
        // a sound — is the page's own per-device business (webNotify.ts).
        webNotify.handle(e.notice);
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
    // Replace, never write through: see transcript.foldTextRow for why an in-place edit is
    // invisible to the memoized rows (and why the turn-end flip used to dump the whole block).
    for (let i = 0; i < v.msgs.length; i++) {
      const m = v.msgs[i];
      if ((m.kind === "agent" || m.kind === "thought") && m.open) v.msgs[i] = { ...m, open: false };
    }
  }

  #keepLastOpen(v: SessionView): void {
    const l = v.msgs[v.msgs.length - 1];
    if (l && (l.kind === "agent" || l.kind === "thought") && v.busy && !l.open) {
      v.msgs[v.msgs.length - 1] = { ...l, open: true };
    }
  }

  /** Fold every thought block except `keepKey` (`null` closes them all).
   *
   *  A thinking burst is "the live one" only while it is the block being WRITTEN: the moment
   *  the agent moves on — a tool call, a reply, or the next burst — the finished one folds to
   *  its `💭 思考 · N 字` header. `open` used to be cleared only at turn-end (#endOpenBubbles),
   *  so every burst of a turn stayed expanded and the transcript read as a wall of reasoning
   *  (measured 2026-10-08, the operator's 「保留的那 5 条里，思考消息都是展开的」). Deferred
   *  here rather than in App: the flag is store state, and a row folded on the far side of a
   *  re-render is exactly the shape that used to freeze (`transcript.foldTextRow`). */
  #foldThoughts(list: MsgView[], keepKey: string | null): void {
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.kind === "thought" && m.open && m.key !== keepKey) list[i] = { ...m, open: false };
    }
  }

  #ingest(
    v: SessionView,
    m: StoredMessage,
    opts?: { delta?: string; n?: number; list?: MsgView[]; index?: Map<string, number>; resync?: boolean },
  ): void {
    // A page of older rows is folded into a scratch list first (so it can be merged by block key
    // with what is already on screen), the live stream folds into the view itself.
    const list = opts?.list ?? v.msgs;
    const index = opts?.index ?? v.blocks;
    const delta = opts?.delta;
    const p0 = m.payload as Record<string, unknown>;
    // Set when this frame is a thought block (see the fold after the switch): the block being
    // written stays open, everything else folds.
    let thoughtKey: string | null = null;
    // Dedup REST-replay vs WS-live (QA#3) — but ONLY for append-only rows.
    // Tool rows are upserted server-side keeping their original seq, so a
    // seq-based guard would swallow every tool_call_update (QA#12: the card
    // stayed "pending" live while a reload showed "completed").
    // A streamed text block that GREW is the same story: the store folds one message into ONE row and
    // that row KEEPS ITS SEQ, so a seq guard dropped every chunk after the first (measured on a phone:
    // a bubble reading "不是" and the rest of the reply nowhere). Growing frames carry `n` — the
    // block's total length — and are guarded by that instead (transcript.planTextFrame).
    const grew = delta !== undefined;
    // A re-delivered frame (the reconnect tail, `resync`) must be re-APPLIED, not skipped: the row the
    // client last saw may have GROWN since — a streamed reply keeps its seq, a tool call's output lands
    // later — and the seq guard would freeze that bubble at whatever version we happened to hold,
    // permanently (until a reload). Re-applying is safe for every kind that folds by IDENTITY: a tool
    // row upserts by callId, a KEYED text row replaces its own block, a user/meta row is skipped when
    // its key is already held. An UNKEYED text row is the one case that cannot be re-applied — its rule
    // is contiguous append, so a re-delivery would grow a second bubble — and it stays behind the guard.
    const keyed = (m.kind === "agent" || m.kind === "thought") && blockKeyOf(m.kind, p0) !== null;
    const reapply = opts?.resync === true
      && (m.kind === "tool" || m.kind === "plan" || m.kind === "user" || m.kind === "meta" || keyed);
    // `approval` / `project-skills` are rows that CHANGE IN PLACE (the decision lands on the row that
    // already asked), so they must re-apply on every delivery — same reason as `note` and `tool`.
    const upsertRow = reapply || m.kind === "tool" || m.kind === "meta" || m.kind === "note"
      || m.kind === "approval" || m.kind === "project-skills" || m.seq <= 0 || grew;
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
        // A re-delivered frame must not become a second bubble (see `reapply` above): the row's key IS
        // its identity, and a user row is a turn boundary, so the counter advances only for a new one.
        if (list.some((x) => x.key === `m${m.seq}`)) break;
        // An agent-to-agent message is stored as a `user` row (it IS a turn boundary), but it must not
        // be drawn as the operator's own words — hence the `from` marker the bubble reads.
        const raw = (p.origin ?? null) as { sessionId?: unknown; title?: unknown } | null;
        list.push({
          key: `m${m.seq}`,
          kind: "user",
          text: String(p.text ?? ""),
          at,
          ...(raw && typeof raw.sessionId === "string"
            ? { from: { id: raw.sessionId, title: String(raw.title ?? "").trim() || "另一个会话" } }
            : {}),
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
        //
        // 🔴 Only while the session is ACTUALLY running, and the check has to be the session's own
        // status rather than `busy`: a delta frame can arrive AFTER the turn-end that closed the block
        // (the last reasoning chunk of a turn lands behind the final answer when the mock/host decides
        // to answer in the middle), and `busy` is already false by then. Re-opening the flag there left
        // a live 「思考中…」 window on screen forever — a row that no longer changes never re-renders,
        // so nothing could ever clear it (measured 2026-10-08; the operator's 「早就结束了还一直在渲染中间
        // 过程，强制刷新才到完结态」). The status is what the server last SAID, so a stale frame cannot
        // outvote it.
        const block = list[idx];
        if (delta !== undefined && v.info.status === "running" && block
          && (block.kind === "agent" || block.kind === "thought") && !block.open) {
          list[idx] = { ...block, open: true };
        }
        // This thought is the one being written; every other thought folds (after the switch).
        if (kind === "thought") thoughtKey = list[idx]?.key ?? null;
        break;
      }
      case "note": {
        // 一条落库的状态行（服务端 Store.appendNote）：位置由 seq 决定，所以它天生排在
        // 「用户那句话之后、回复之前」，不需要客户端再算锚点。同一个 seq 再次到达就是
        // 「还在压缩 → 压完了」这类更新（服务端已折叠），就地替换；新对象而不是改字段，
        // 否则 memo 看不见这次变化。
        const key = `n${m.seq}`;
        const hits = typeof p.hits === "number" ? p.hits : undefined;
        const row: MsgView = {
          key, kind: "note", category: String(p.category ?? ""),
          text: typeof p.text === "string" ? p.text : "", hits, at,
          items: Array.isArray(p.items)
            ? (p.items as StatusNoteItem[]).filter((i) => i && typeof i.text === "string" && i.text.trim())
            : undefined,
          truncated: p.truncated === true,
        };
        const at0 = index.get(key);
        if (at0 !== undefined && list[at0]?.kind === "note") list[at0] = row;
        else {
          list.push(row);
          index.set(key, list.length - 1);
        }
        break;
      }
      case "approval": {
        const key = `p${m.seq}`;
        const decision = p.decision as PermissionDecision | null | undefined;
        const row: MsgView = {
          key,
          kind: "approval",
          requestId: String(p.requestId ?? ""),
          title: String(p.toolCallTitle ?? "tool call"),
          kind2: String(p.kind ?? "other"),
          path: typeof p.path === "string" ? p.path : null,
          diff: (p.diff ?? null) as PermissionRequestView["diff"],
          options: Array.isArray(p.options) ? (p.options as PermissionRequestView["options"]) : [],
          decision: decision ?? null,
          at,
        };
        const at0 = index.get(key);
        if (at0 !== undefined && list[at0]?.kind === "approval") list[at0] = row;
        else {
          list.push(row);
          index.set(key, list.length - 1);
        }
        break;
      }
      case "project-skills": {
        const key = `s${m.seq}`;
        const row: MsgView = {
          key,
          kind: "project-skills",
          root: String(p.root ?? ""),
          count: typeof p.count === "number" ? p.count : 0,
          text: String(p.text ?? ""),
          state: String(p.state ?? "ask"),
          at,
        };
        const at0 = index.get(key);
        if (at0 !== undefined && list[at0]?.kind === "project-skills") list[at0] = row;
        else {
          list.push(row);
          index.set(key, list.length - 1);
        }
        break;
      }
      case "turn-usage": {
        // 一轮的 token 账（issue #70）：append-only，位置由 seq 定 —— 服务端在 turn-end 时才写，
        // 所以它天然排在那一轮回复之后。`available: false` 是「这个 agent 没上报」，不是零。
        const key = `u${m.seq}`;
        const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
        const row: MsgView = {
          key,
          kind: "turn-usage",
          available: p.available !== false,
          input: n(p.input), output: n(p.output), thought: n(p.thought),
          cacheRead: n(p.cacheRead), cacheWrite: n(p.cacheWrite), total: n(p.total),
          durationMs: typeof p.durationMs === "number" ? p.durationMs : undefined,
          cacheHitPercent: typeof p.cacheHitPercent === "number" ? p.cacheHitPercent : null,
          tps: typeof p.tps === "number" ? p.tps : null,
          at,
        };
        if (index.get(key) === undefined) {
          list.push(row);
          index.set(key, list.length - 1);
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
        // 文件变更（#38）：后面几帧可能补上 diff 内容，所以是追加，不是覆盖。
        // 同一 path + 同样的 old/new 再来一遍不追加 —— 否则一次调用会被数成「改了 2 次」。
        const seenChange = new Set((existing?.changes ?? []).map((c) => `${c.path}\u0000${c.oldText ?? ""}\u0000${c.newText ?? ""}\u0000${c.diffText ?? ""}`));
        const fresh = changesOfTool(p).filter((c) => !seenChange.has(`${c.path}\u0000${c.oldText ?? ""}\u0000${c.newText ?? ""}\u0000${c.diffText ?? ""}`));
        const changes = fresh.length ? [...(existing?.changes ?? []), ...fresh] : existing?.changes;
        // upsert semantics (design.md §8-5): update, never append a second bubble
        if (existing) {
          // Replace, never write through (same reason as foldTextRow): a tool card whose status or
          // output lands later must be able to re-render.
          const ai = list.indexOf(existing);
          const next = {
            ...existing,
            title: p.title ? String(p.title) : existing.title,
            status: p.status ? String(p.status) : existing.status,
            // output grows across tool_call_update frames — replace, never append twice
            detail: detail ?? existing.detail,
            input: input ?? existing.input,
            changes,
          };
          if (ai >= 0) list[ai] = next;
        } else {
          list.push({
            key: `tc-${tcId}`, kind: "tool", toolCallId: tcId, at,
            title: String(p.title ?? "tool call"), status: String(p.status ?? "pending"),
            kind2: String(p.kind ?? ""), detail, input, changes,
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
          if (old && old.kind === "plan") {
            const pi = list.indexOf(old);
            list[pi] = { ...old, items, terminal, explanation };
          }
          else list.push({ key: `m${m.seq}`, kind: "plan", items, terminal, explanation, at });
          break;
        }
        // Both writers fold through ONE rule: this frame, and the server's plan object (see
        // #applyPlan — the object is the copy that survives the agent's process).
        this.#applyPlan(v, items, terminal, at, explanation);
        break;
      }
      case "meta":
        // Same reason as a user row: a re-delivered meta frame must not double up.
        if (list.some((x) => x.key === `m${m.seq}`)) break;
        list.push({ key: `m${m.seq}`, kind: "meta", text: text || JSON.stringify(p) });
        break;
    }
    // The burst fold: a frame that is not the thought block being written closes every other
    // thought, so only the newest (still-growing) burst stays expanded.
    this.#foldThoughts(list, thoughtKey);
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

/**
 * In-page navigation for anything that already has this document on screen (issue #20).
 *
 * The Android companion taps a notification: it used to `loadUrl()` the deep link no matter what, so a
 * tap on the session you were READING reloaded the whole page — white flash, lost scroll, a socket
 * teardown and reconnect. The phone now asks this instead. Returns true when it moved (or was already
 * there), false when the id is unknown to this page — the caller then falls back to a real load, which
 * is the honest answer for a link to something we have never heard of.
 *
 * Exposed as a global rather than a custom event because `evaluateJavascript` cannot await: the value
 * has to be right there in the reply.
 */
if (typeof window !== "undefined") {
  const w = window as unknown as { __agentusOpenSession?: (id: string) => boolean };
  w.__agentusOpenSession = (id: string): boolean => {
    const key = String(id ?? "").trim();
    if (!key) return false;
    if (!cockpit.byId.has(key)) return false;
    cockpit.setActive(key); // also rewrites ?session= — the address bar stays truthful
    // a cold slot needs its process back; setActive alone would paint an empty transcript
    const view = cockpit.byId.get(key);
    if (view && !view.loaded) void cockpit.resume(key).catch(() => undefined);
    return true;
  };
  // Back/Forward cannot create a different session (we only replaceState), but a manually edited URL,
  // a link pasted into the omnibox, or the App's fallback load all land here.
  window.addEventListener("popstate", () => cockpit.followUrl());
}

/**
 * Is a turn running on this session?
 *
 * `v.busy` is set by the `turn-start` FRAME, so it is only true for turns this page watched begin. A
 * page that connected (or reconnected) after the turn had already started — the operator typing across
 * a cockpit restart is the everyday case — holds `busy: false` while the agent is mid-turn and the
 * server's own state says `status: "running"`. Trusting `busy` alone is how the composer came to offer
 * a SEND button for a busy agent; the bare prompt it then sent met "turn already running" and the
 * operator's sentence died in a red bubble (2026-10-17). `status` is the server's word and rides every
 * `sessions` snapshot, so it survives reconnects; `busy` still wins for the instant between our own
 * send and the status frame that confirms it.
 */
export function busyNow(v: { busy: boolean; info: { status: string } } | null | undefined): boolean {
  return Boolean(v && (v.busy || v.info.status === "running"));
}

/** The URL that serves a local file's raw bytes (auth rides on the session cookie, same as
 *  every other /api call). Used by the panel's image/PDF/audio viewers AND by the markdown
 *  renderer, so an `![](/Users/…/shot.png)` an agent wrote actually shows the picture.
 *  Both callers must go through this: one place to change if the route ever moves. */
export function rawFileUrl(path: string): string {
  return `/api/fs/raw?path=${encodeURIComponent(path)}`;
}

