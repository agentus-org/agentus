/**
 * The cockpit CLI's data plane, as pure functions.
 *
 * WHAT THIS IS FOR
 * An agent inside the cockpit is blind: the whole instrument panel (what the other sessions are
 * doing, what they were told, which one is waiting for an approval) lives in this server's store and
 * is visible only to the operator. This module is the READ side of the one channel that lets an agent
 * see it — plus the shape of the controlled `send` — kept as pure functions so the CLI contract can
 * be unit-tested without a server or a socket.
 *
 * WHAT IT DELIBERATELY IS NOT
 * Intelligence. It selects, truncates and labels; it never summarises, never decides what an agent
 * "should" know, and never rewrites a message. The server's red line (the UI holds no intelligence)
 * applies to the agent-facing data plane for the same reason: a machine that paraphrases the cockpit
 * is a machine that can be wrong about the cockpit.
 *
 * The CLI is `bin/agentus-cockpit.mjs`; the routes are in `index.ts` (`/api/cockpit/*`). Both are
 * thin: every decision about WHAT may be seen lives here, so there is one answer, not three.
 */
import type { PlanSnapshot, SessionInfo, StoredMessage } from "../../../shared/src/index.js";

/** Version of the shapes this file produces. Bumped when a field changes MEANING; additive fields
 *  do not bump it (a reader that does not know a field must not break — same rule the ACP plan v2
 *  adoption used). */
export const COCKPIT_SCHEMA_VERSION = 1;

/** How many messages `messages --tail` may return at most. The tail is for "what is it doing NOW",
 *  not for mirroring a transcript into another agent's context — an agent that pastes 400 messages
 *  into its own prompt has spent the operator's tokens on history nobody asked for. */
export const MESSAGES_TAIL_MAX = 40;
export const MESSAGES_TAIL_DEFAULT = 10;

/** How many characters of ONE message are returned. Long replies (a full file dump, a 2000-line
 *  stack trace) are exactly what a reader wants a glimpse of, not a copy of. */
export const MESSAGE_CHARS = 600;

/** Room name of the send gate in the operator's settings (`agent.cockpitSend`). Named in one place
 *  because the CLI text, the settings page and the server gate all have to agree. */
export const SEND_SETTING = "agent.cockpitSend";

export type CockpitSessionRow = {
  id: string;
  name: string;
  backend: string;
  status: string;
  /** the directory the session's panels work in (what an operator would call its workplace) */
  cwd: string;
  /** no agent process: the message would have to wake it first */
  cold: boolean;
  /** on the operator's 已归档 shelf — OUT of scope for the cockpit channel */
  archived: boolean;
  /** last talked to (wall clock) */
  lastAt: number;
  /** plan progress as the card shows it (0/0 = no plan) */
  plan: { done: number; total: number; title: string | null };
  /** approvals this session is WAITING on right now — the one thing worth waking someone for */
  permissions: number;
  /** the operator is looking at this session (it is the active tab) */
  focused?: boolean;
};

export type CockpitMessageRow = {
  seq: number;
  kind: string;
  at: number;
  /** TRUNCATED: see `truncation` in `capabilities`. A cut message ends with `…`. */
  text: string;
  /** the text was longer than the budget */
  truncated: boolean;
};

/** What `cockpit capabilities` prints. Self-description is the reason the CLI can stay thin: an
 *  agent that reads this once knows every command, every field and every truncation rule without a
 *  doc that drifts. */
export function capabilities(sendEnabled: boolean): Record<string, unknown> {
  return {
    schema_version: COCKPIT_SCHEMA_VERSION,
    bin: "agentus <noun> <verb> — sessions are the noun; capabilities/skill sit at the top level",
    commands: [
      { name: "capabilities", args: [], returns: "this object — the contract, without needing a doc" },
      { name: "skill", args: ["--path"], returns: "the CLI's own skill document (skills/agentus-cockpit/SKILL.md), served from the package with no auth" },
      { name: "session list", args: [], returns: "who you are + every session in scope (id/name/status/plan/permissions/lastAt)" },
      { name: "session show", args: ["<id>"], returns: "one session in detail, including any approval it is waiting on" },
      { name: "session messages", args: ["<id>", "--tail N"], returns: `the last N messages (default ${MESSAGES_TAIL_DEFAULT}, max ${MESSAGES_TAIL_MAX}), each cut to ${MESSAGE_CHARS} chars` },
      { name: "session plan", args: ["<id>"], returns: "the plan object the operator's card renders (title/items/explanation/terminal)" },
      { name: "session send", args: ["<id>", "<text…>"], returns: "deliver a message into another session (text after the id, or on stdin)" },
    ],
    truncation: {
      messages: `each message's text is cut to ${MESSAGE_CHARS} characters; a cut one ends with … and reports truncated:true`,
      tail: `at most ${MESSAGES_TAIL_MAX} messages per call`,
      plan_items: "not truncated — a plan is short by construction (it is a step list)",
    },
    auth: {
      how: "environment only: AGENTUS_COCKPIT_ENDPOINT / AGENTUS_COCKPIT_TOKEN / AGENTUS_COCKPIT_SESSION are set by the cockpit when it spawns you; AGENTUS_COCKPIT_BIN is the agentus launcher itself, so every call is \"$AGENTUS_COCKPIT_BIN\" session <verb>",
      rule: "never print, echo, export or pass those variables anywhere — they identify your session",
    },
    scope: {
      read: "every session the operator can see: live and cold, never 已归档",
      send: sendEnabled
        ? "ENABLED: you may deliver a message into another session in scope"
        : "DISABLED: the operator has not turned 驾驶舱互发消息 on; send answers code:sends_disabled",
      send_semantics: "delivered means the target agent RECEIVED the message and started a turn — never that it read it or agreed. Nothing is claimed about a reply.",
    },
    discipline: [
      "read before you assert: call `context` instead of trusting your memory of another session",
      "queued/busy is not read: a target that is mid-turn answers code:target_busy and saw nothing",
      "rate_limited means STOP and tell the operator — two agents can otherwise spin forever",
    ],
  };
}

/** One row of the scope list. `self` is reported separately so a caller cannot mistake its own row
 *  for one it may talk to. */
export function sessionRow(
  info: SessionInfo,
  opts: { plan?: PlanSnapshot | null; permissions?: number; focused?: boolean } = {},
): CockpitSessionRow {
  const items = opts.plan?.items ?? [];
  return {
    id: info.id,
    name: info.title,
    backend: info.backend,
    status: info.status,
    cwd: info.workspace || info.cwd,
    cold: Boolean(info.cold),
    archived: Boolean(info.archivedAt),
    lastAt: info.lastAt ?? info.createdAt,
    plan: {
      done: items.filter((i) => i.status === "completed").length,
      total: items.length,
      title: opts.plan?.title?.trim() || null,
    },
    permissions: opts.permissions ?? 0,
    ...(opts.focused ? { focused: true } : {}),
  };
}

/** A transcript row in the CLI's vocabulary: the payload is normalised to TEXT and cut, because an
 *  agent's reader is a prompt, not a renderer. Unknown payload shapes are stringified rather than
 *  dropped — "something happened here that I cannot read" is better than a silent gap. */
export function messageRow(m: StoredMessage): CockpitMessageRow {
  const raw = textOf(m);
  const cut = raw.length > MESSAGE_CHARS;
  return {
    seq: m.seq,
    kind: m.kind,
    at: m.createdAt,
    text: cut ? `${raw.slice(0, MESSAGE_CHARS - 1)}…` : raw,
    truncated: cut,
  };
}

function textOf(m: StoredMessage): string {
  const p = (m.payload ?? null) as
    | { content?: { text?: unknown }; text?: unknown; entries?: { content?: unknown }[]; _meta?: unknown }
    | null;
  if (!p || typeof p !== "object") return "";
  const direct = p.content?.text;
  if (typeof direct === "string") return direct;
  if (typeof p.text === "string") return p.text;
  // plan frames and tool rows: the text a reader wants is the steps / the title
  if (Array.isArray(p.entries)) return p.entries.map((e) => `- ${String(e.content ?? "")}`).join("\n");
  return JSON.stringify(p).slice(0, MESSAGE_CHARS * 2);
}

/** The tail of a transcript. `tail` is clamped rather than refused: a caller asking for 500 gets the
 *  documented maximum, and `meta.truncated` says so — a silent short answer reads as "there was
 *  less". */
export function tailMessages(rows: readonly StoredMessage[], tail: number): { rows: CockpitMessageRow[]; meta: Record<string, unknown> } {
  const want = Number.isFinite(tail) ? Math.max(1, Math.floor(tail)) : MESSAGES_TAIL_DEFAULT;
  const capped = Math.min(MESSAGES_TAIL_MAX, want);
  const slice = rows.slice(-capped);
  return {
    rows: slice.map(messageRow),
    meta: { asked: want, returned: slice.length, available: rows.length, capped: want > capped },
  };
}

/** The `send` gate, in ONE expression so the route and the CLI cannot disagree about it.
 *
 *  `read` is on by default (the operator can see everything; an agent reading it cannot damage
 *  anything, and it is what a 工作播报 observer lives on). `send` is OFF until the operator turns it
 *  on: an agent that can write into another agent's turn without being asked is a loop generator,
 *  and the operator is the one who pays for the tokens. */
export function sendAllowed(setting: unknown): boolean {
  return setting === true;
}

/** Refusal codes the CLI turns into stderr lines. Stable strings, because a model reads them. */
export const COCKPIT_ERRORS = {
  badToken: "bad_token",
  noSuchSession: "no_such_session",
  outOfScope: "out_of_scope",
  sendsDisabled: "sends_disabled",
  targetBusy: "target_busy",
  targetCold: "target_cold",
  rateLimited: "rate_limited",
  badRequest: "bad_request",
} as const;
