// Shared message/permission types — aligned with AionUi acpTypes.ts (Apache-2.0).
// ACP session update variants we render.
export type SessionUpdateKind =
  | "agent_message_chunk"
  | "agent_thought_chunk"
  | "tool_call"
  | "tool_call_update"
  | "plan"
  | "available_commands_update"
  | "usage_update";

export interface ChatMessage {
  /** Monotonic per-session sequence (reconnect dedup anchor). */
  seq: number;
  sessionId: string;
  kind: SessionUpdateKind | "user_message";
  /** Raw ACP update payload (agent-side). */
  payload: unknown;
  createdAt: number;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface PermissionRequest {
  requestId: string;
  sessionId: string;
  toolCallTitle: string;
  options: PermissionOption[];
}
