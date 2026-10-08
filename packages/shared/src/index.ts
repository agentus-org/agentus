// Agentus shared types. Design lineage: ACP protocol (agentclientprotocol.com)
// and behavioral rules studied from AionUi/hermes-studio (see docs/refs/),
// but types are our own minimal surface for the WS envelope between
// server <-> browser.
//
// WHY THERE IS NO `@agentus/shared` SPECIFIER ANYWHERE ANYMORE
//   The cockpit ships as ONE npm package (`agentus`), not as three workspace
//   packages: a global install must not need a registry scope, and the server runs
//   this file in place. So every consumer imports it by relative path
//   (`../../shared/src/index.js` from packages/server/src, `../../shared/src/index`
//   from packages/web/src — bundler resolution wants no extension). Consequence: the
//   `rootDir` option had to go from both package tsconfigs (it cannot contain a file
//   outside src). This file stays the single source of truth for the wire contract;
//   `packages/shared/package.json` survives only so the workspace layout and
//   `tsconfig.base.json`'s include keep working in-repo.
/** Backend ids are registry rows now (M6): the three builtin ones plus anything the operator
 *  adds in the cockpit ("hermes-fork", "hermes-live", …). The literal union keeps autocomplete
 *  for the builtins while letting a row id through. */
export type BackendId = "hermes" | "qoder" | "mock" | (string & {});

export type SessionStatus =
  | "starting" // subprocess spawned, initialize/newSession in flight
  | "ready" // accepts prompts
  | "running" // a prompt turn is in flight
  | "error" // subprocess died or handshake failed
  | "closed";

/** A model the agent offers (ACP session model state). Hermes reports these on the
 *  wire as ``models: {currentModelId, availableModels}`` — the type is not in the SDK's
 *  published surface, so we model the field ourselves. */
export interface SessionModelState {
  currentModelId: string | null;
  availableModels: { modelId: string; name: string; description?: string | null }[];
}

export interface SessionInfo {
  id: string; // our own id (browser-facing)
  backend: BackendId;
  acpSessionId: string | null; // agent-side id, null until newSession resolved
  cwd: string;
  /** The directory this slot's file/terminal panels work in. Separate from `cwd`
   *  because a live ACP child cannot be re-cd'd: re-pointing a running slot moves
   *  the panels (and the next resume), not the running process. null = same as cwd. */
  workspace?: string | null;
  status: SessionStatus;
  pid: number | null;
  title: string;
  /** The GENERATED name (what the agent announced via ACP `session_info_update`, or our
   *  own derivation from the first prompt). `title` is what the rail shows — normally the
   *  same string, but the operator's rename lives only in `title`, so a hand-written name
   *  is never overwritten by a later automatic one and can always be cleared back. */
  autoTitle?: string | null;
  createdAt: number;
  modes: SessionModeState | null;
  configOptions: ConfigOptionView[];
  /** models the agent advertised for this session (null = it offers none) */
  models?: SessionModelState | null;
  /** Operator override for the context window shown in the gauge. ACP has no method to
   *  change a model's window (it is a property of the provider), so the number is either
   *  what the agent reports via usage_update or this — the operator's declared window.
   *  null = use whatever the agent reports. */
  contextLimit?: number | null;
  /** The window the operator declared for the CURRENT model (remembered per model, the way
   *  hermes-studio stores a context length per provider+model). Precedence for the gauge:
   *  contextLimit (this session) → this → the agent's own usage_update.size. */
  modelContextLimit?: number | null;
  commands: AvailableCommandView[]; // slash commands advertised by the agent
  /** context-window gauge, from ACP usage_update (AionUi F-DISPLAY-07 lineage) */
  usage?: UsageView | null;
  lastError?: string;
  /** highest persisted seq (resume anchor hint) */
  lastSeq?: number;
  /** When this session last received a message (wall clock; creation time when it has none).
   *  This — not `createdAt`, and not `lastSeq` (a per-session counter) — is what the rail
   *  orders by: "which of these did I last talk to". */
  lastAt?: number;
}

export interface AvailableCommandView {
  name: string;
  description?: string;
}

export interface UsageView {
  used: number;
  size: number;
  cost?: number | null;
  at: number;
}

export interface SessionModeState {
  currentModeId: string;
  availableModes: { id: string; name: string; description?: string }[];
}

export interface ConfigOptionView {
  id: string;
  name: string;
  type: "boolean" | "select" | "string" | "number";
  /** ACP's semantic hint: "model" | "mode" | "thought_level" | … — lets a client place
   *  the control (own button vs settings) instead of guessing from the id (which is all
   *  a backend like Hermes gives us today). */
  category?: string | null;
  currentValue?: string | number | boolean | null;
  options?: { value: string; name: string }[];
  /** The option's ACP `_meta`, passed through verbatim. Custom option kinds describe extra
   *  shape here (e.g. Hermes's `context_budget` marks itself `freeform: true` with a unit,
   *  a floor and preset shortcuts) — a client that understands the marker can offer an input
   *  where a plain dropdown would only ever show the presets. */
  meta?: Record<string, unknown> | null;
}

export type PermissionDecision =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

export type PermissionResolved = {
  requestId: string;
  decision: PermissionDecision;
};

export interface PermissionRequestView {
  requestId: string;
  sessionId: string;
  toolCallTitle: string;
  kind: string;
  options: { optionId: string; name: string; kind: string }[];
  createdAt: number;
  /** The file the request is about, when the agent named one (its own diff content path,
   *  else the tool call's `rawInput.path`). Null for a request that is not about a file. */
  path?: string | null;
  /** What the file looks like now and after, BOUNDED (an edit proposal carries the whole
   *  file twice). Exists so the operator can decide about a file edit from the surface that
   *  asks, instead of from a bare title. */
  diff?: PermissionDiff | null;
}

/** A bounded before/after preview of the file a request proposes to write.
 *  `truncated` is set when either side was cut, so the surface can say so instead of
 *  showing a file whose tail silently went missing. */
export interface PermissionDiff {
  path: string;
  oldText: string | null;
  newText: string | null;
  truncated: boolean;
}

// ---- WS envelope (server -> browser) ----
export type ServerEvent =
  | { t: "hello"; clientId: string; resumed: boolean }
  | { t: "sessions"; sessions: SessionInfo[]; /** requests already waiting for an answer, so a page that connects or refreshes learns about them (they are STATE; the events happened before it existed) */ pending?: PermissionRequestView[] }
  | { t: "session"; session: SessionInfo }
  | { t: "messages"; sessionId: string; messages: StoredMessage[]; hasMore: boolean; partial?: boolean }
  | { t: "message"; message: StoredMessage; /** text to APPEND for a streamed block that grew (absent
   *  for a plain append/replay row, where `message` is the whole truth). The row is authoritative on
   *  reads; the delta only exists so a live turn does not re-send the accumulated text every frame. */
      delta?: string;
      /** the block's TOTAL length after this frame. A row that grew KEEPS its seq, so this — not the
       *  seq — is what tells a client whether it has already applied this frame (see the web
       *  transcript's `planTextFrame`: dedup by seq swallowed every chunk after a reply's first). */
      n?: number }
  | { t: "permission"; request: PermissionRequestView }
  | { t: "permission-resolved"; requestId: string; decision: PermissionDecision }
  /** An answer arrived for a request the server no longer holds (its own timeout fired, or the
   *  agent gave up first). Said out loud instead of dropped: a click that does nothing is the
   *  worst failure shape there is — the operator cannot tell it from a broken button. */
  | { t: "permission-expired"; requestId: string; sessionId: string }
  /** A config pick (thinking depth / context budget) the agent did NOT take: the picker showed the
   *  new value while the wire dropped it — the exact shape an operator reads as "这个设置没用".
   *  `actual` is what the session really runs with, so the cockpit can put the control back and say
   *  so instead of pretending the pick landed. */
  | { t: "config-rejected"; sessionId: string; configId: string; value: string; actual: string; name?: string }
  | { t: "turn-end"; sessionId: string; stopReason?: string; error?: string;
      /** Wall time from the moment the turn was announced to the moment the agent answered (ms).
       *  Exists so a notification can say "用时 1m12s" instead of a protocol token like `end_turn`,
       *  which is a fact about the wire, not about the operator's wait (absent when unknowable). */
      durationMs?: number }
  /** per-turn trace: what model/effort/mode this turn is actually running with
   *  (AionUi F-DISPLAY-11 lineage — "why did it behave differently?" ) */
  | { t: "turn-start"; sessionId: string; trace?: TurnTrace }
  /** The session's plan object — the TRUTH the card renders, not the transcript's frames. Sent on
   *  every change, and the same object is available over GET /api/sessions/:id/plan, so a page that
   *  loads after the agent process died still renders the real plan instead of nothing. */
  | { t: "plan"; sessionId: string; plan: PlanSnapshot }
  /** context-window usage for a slot (ACP usage_update) */
  | { t: "usage"; sessionId: string; usage: UsageView }
  | { t: "error"; error: string };

export interface TurnTrace {
  model?: string;
  provider?: string;
  effort?: string | null;
  mode?: string | null;
}

/** One step of a plan: ACP's own shape (`PlanEntry` in v1) and nothing more. There is no per-step
 *  note in the protocol, so we do not invent one — Studio keeps its remark at the plan level
 *  (`PlanSnapshot.explanation`), and so do we. */
export interface PlanItem {
  content: string;
  /** pending | in_progress | completed | cancelled — unknown values pass through (v2 reserves
   *  `_`-prefixed ones), because dropping what we do not understand shows a quietly wrong plan. */
  status: string;
  priority?: string;
}

/** The session's plan as the SERVER holds it.
 *
 *  Why the server and not the transcript: an ACP plan frame is a replace-semantics SNAPSHOT, and the
 *  agent's own todo state dies with its process — so a plan read from replayed frames can be empty
 *  or stale exactly when it matters (after a restart). The object below has a monotonic `revision`
 *  so a client can treat it as a cursor. */
export interface PlanSnapshot {
  sessionId: string;
  revision: number;
  items: PlanItem[];
  /** plan-level remark, Studio-style ("brief reason for the update or scope change"), ≤1000 chars */
  explanation?: string | null;
  /** who wrote it: a native ACP frame, the plan MCP tool, or the server's own turn lifecycle */
  source: "acp" | "mcp" | "server";
  /** set by the turn lifecycle when the run ended with unfinished steps */
  terminal?: string | null;
  updatedAt: number;
}

// ---- WS envelope (browser -> server) ----
/** Media the operator attaches to a prompt. Images ride ACP as base64 blocks (that
 *  is the wire shape the protocol defines), text files are inlined as text with a
 *  header naming the file, links pass through as resource_link. Nothing is uploaded
 *  anywhere: an attachment is turned into a prompt block and nothing else. */
export type PromptAttachment =
  | { kind: "image"; mimeType: string; data: string; name?: string }
  | { kind: "text"; name: string; text: string }
  | { kind: "link"; uri: string; name?: string };

/** What the transcript remembers about an attachment (never the bytes: a 4MB
 *  base64 blob has no business in the message log). */
export interface AttachmentSummary {
  kind: PromptAttachment["kind"];
  name?: string;
  mimeType?: string;
}

export type ClientCommand =
  | { t: "resume"; lastSeq: Record<string, number> }
  /** `interrupt: true` = "I am taking the floor": if a turn is still running, cancel it and
   *  wait for it to actually stop before sending this prompt. Call mode sends every utterance
   *  this way (the operator speaking over the agent IS the interrupt), which is also what
   *  removes the race between an async cancel and the next prompt. */
  | { t: "prompt"; sessionId: string; text: string; attachments?: PromptAttachment[]; interrupt?: boolean }
  | { t: "cancel"; sessionId: string }
  | { t: "set-mode"; sessionId: string; modeId: string }
  | { t: "set-config"; sessionId: string; configId: string; value: string | number | boolean }
  | { t: "set-model"; sessionId: string; modelId: string }
  | {
      t: "respond-permission";
      sessionId: string;
      requestId: string;
      decision: PermissionDecision;
      optionKind?: string; // kind of chosen option (allow_always etc.)
      signature?: string; // "<kind>:<toolCallTitle>" for always-allow memory
    };

export interface StoredMessage {
  seq: number; // monotonic per session — reconnect dedup anchor
  sessionId: string;
  kind: "user" | "agent" | "thought" | "tool" | "plan" | "meta";
  payload: unknown; // raw ACP content/update fragment (kept lossless)
  toolCallId?: string; // set for kind=tool; upsert key
  createdAt: number;
}
