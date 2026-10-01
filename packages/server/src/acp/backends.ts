// Backend registry — the entire dual-backend support surface (D5).
// Adding a third backend = adding one row here; NEVER touch the protocol layer.
export const BACKENDS = {
  hermes: { label: "Hermes", cmd: "hermes", args: ["acp"], check: ["acp", "--check"] },
  qoder: { label: "Qoder", cmd: "qodercli", args: ["--acp"], check: null },
} as const;

export type BackendId = keyof typeof BACKENDS;
