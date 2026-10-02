// AgentSlot shared types. Design lineage: ACP protocol (agentclientprotocol.com)
// and behavioral rules studied from AionUi/hermes-studio (see docs/refs/),
// but types are our own minimal surface for the WS envelope between
// server <-> browser.
export type BackendId = "hermes" | "qoder";

export type SessionStatus =
  | "starting" // subprocess spawned, initialize/newSession in flight
  | "ready" // accepts prompts
  | "running" // a prompt turn is in flight
  | "error" // subprocess died or handshake failed
  | "closed";

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
  createdAt: number;
  modes: SessionModeState | null;
  configOptions: ConfigOptionView[];
  commands: AvailableCommandView[]; // slash commands advertised by the agent
  /** context-window gauge, from ACP usage_update (AionUi F-DISPLAY-07 lineage) */
  usage?: UsageView | null;
  lastError?: string;
  /** highest persisted seq (resume anchor hint) */
  lastSeq?: number;
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
  currentValue?: string | number | boolean | null;
  options?: { value: string; name: string }[];
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
}

// ---- WS envelope (server -> browser) ----
export type ServerEvent =
  | { t: "hello"; clientId: string; resumed: boolean }
  | { t: "sessions"; sessions: SessionInfo[] }
  | { t: "session"; session: SessionInfo }
  | { t: "messages"; sessionId: string; messages: StoredMessage[]; hasMore: boolean; partial?: boolean }
  | { t: "message"; message: StoredMessage } // one appended/updated row
  | { t: "permission"; request: PermissionRequestView }
  | { t: "permission-resolved"; requestId: string; decision: PermissionDecision }
  | { t: "turn-end"; sessionId: string; stopReason?: string; error?: string }
  /** per-turn trace: what model/effort/mode this turn is actually running with
   *  (AionUi F-DISPLAY-11 lineage — "why did it behave differently?" ) */
  | { t: "turn-start"; sessionId: string; trace?: TurnTrace }
  /** context-window usage for a slot (ACP usage_update) */
  | { t: "usage"; sessionId: string; usage: UsageView }
  | { t: "error"; error: string };

export interface TurnTrace {
  model?: string;
  provider?: string;
  effort?: string | null;
  mode?: string | null;
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
  | { t: "prompt"; sessionId: string; text: string; attachments?: PromptAttachment[] }
  | { t: "cancel"; sessionId: string }
  | { t: "set-mode"; sessionId: string; modeId: string }
  | { t: "set-config"; sessionId: string; configId: string; value: string | number | boolean }
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
