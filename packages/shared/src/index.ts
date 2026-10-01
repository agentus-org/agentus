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
  status: SessionStatus;
  pid: number | null;
  title: string;
  createdAt: number;
  modes: SessionModeState | null;
  configOptions: ConfigOptionView[];
  commands: string[]; // available slash commands advertised by agent
  lastError?: string;
  /** highest persisted seq (resume anchor hint) */
  lastSeq?: number;
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
  | { t: "messages"; sessionId: string; messages: StoredMessage[]; hasMore: boolean }
  | { t: "message"; message: StoredMessage } // one appended/updated row
  | { t: "permission"; request: PermissionRequestView }
  | { t: "permission-resolved"; requestId: string; decision: PermissionDecision }
  | { t: "turn-end"; sessionId: string; stopReason?: string; error?: string }
  | { t: "turn-start"; sessionId: string }
  | { t: "error"; error: string };

// ---- WS envelope (browser -> server) ----
export type ClientCommand =
  | { t: "resume"; lastSeq: Record<string, number> }
  | { t: "prompt"; sessionId: string; text: string }
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
