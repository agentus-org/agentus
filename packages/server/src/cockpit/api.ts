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
  /** the directory the agent process was spawned in */
  cwd: string;
  /** the WORKSPACE the rail groups by (`workspace || cwd` on the session) — what an operator means
   *  when they say 「这个项目里的会话」. Equal to `cwd` unless the operator re-pointed the panels. */
  workspace: string;
  /** when the session was created — the other end of the clock from `lastAt` */
  createdAt: number;
  /** who named it: absent/null = the operator, a session id = that session's agent renamed it */
  titleBy?: string | null;
  /** this row is the CALLER — reported in the list, but never a send target */
  self?: boolean;
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
      {
        name: "session list",
        args: ["--here", "--workspace <path>", "--status <s>", "--waiting", "--since <when>", "--created-since <when>", "--grep <text>", "--sort last|created|name", "--limit N", "--all", "--include-self", "--by workspace", "--table"],
        returns: "who you are + the sessions in scope that match (id/name/workspace/status/cold/createdAt/lastAt/plan/permissions/self/titleBy); --by workspace adds `groups` to data, --table prints a human table INSTEAD of JSON",
      },
      { name: "session rename", args: ["<id>", "<title…>", "--auto"], returns: "name a session (--auto clears back to the generated name)" },
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
      operator: "outside a session the CLI also works for the operator: it reads <DATA_DIR>/auth.token (the machine token scripts already use) and talks to AGENTUS_ENDPOINT or 127.0.0.1:AGENTUS_PORT. In that mode there is no `self`, and a rename records no author (NULL title_by = the operator).",
      rule: "never print, echo, export or pass those variables anywhere — they identify your session",
    },
    session_list: {
      default: `live first, then most recently active, ${LIST_LIMIT_DEFAULT} rows (max ${LIST_LIMIT_MAX}); 已归档 excluded; your OWN row excluded unless you pass --include-self (it then appears marked self:true, and is never a send target)`,
      clocks: "lastAt = when someone last SAID something; createdAt = when the slot was made. --since filters ACTIVITY, --created-since filters CREATION, --sort only orders. Both stamps are on every row.",
      here: "--here is usually what you want: it narrows to YOUR workspace (the project you are working in), which is the same grouping the operator's rail uses",
      waiting: "--waiting is the operator's queue: sessions with an approval outstanding. Do NOT use --since 5m for this — a session waiting on a human has no new messages, so its lastAt goes stale.",
      filter_refusals: "an unparsable --since is an error (bad_request), never a silent 'everything'",
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
      "a rename is a claim about what a session IS, and it is attributed: the row records titleBy, so the operator can see an agent named their conversation",
    ],
  };
}

/** One row of the scope list. `self` is reported separately so a caller cannot mistake its own row
 *  for one it may talk to. */
export function sessionRow(
  info: SessionInfo,
  opts: { plan?: PlanSnapshot | null; permissions?: number; focused?: boolean; self?: boolean } = {},
): CockpitSessionRow {
  const items = opts.plan?.items ?? [];
  return {
    id: info.id,
    name: info.title,
    backend: info.backend,
    status: info.status,
    cwd: info.cwd,
    workspace: info.workspace || info.cwd,
    createdAt: info.createdAt,...(info.titleBy ? { titleBy: info.titleBy } : {}),
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
    ...(opts.self ? { self: true } : {}),
  };
}

/** How many rows `session list` returns unless told otherwise, and the hard ceiling. The point of a
 *  DEFAULT here is the same as the tail's: an agent that lists the whole cockpit burns the operator's
 *  context on a workplace it is not working in. */
export const LIST_LIMIT_DEFAULT = 20;
export const LIST_LIMIT_MAX = 200;

/** What `session list` may be asked to do. Every field is optional; the empty query is the default
 *  view (live first, then most recently active, 20 rows, archived excluded, self included but marked).
 *
 *  ORDER OF THE THREE CLOCKS, because they are easy to confuse and this is the only place that
 *  decides: `lastAt` = when someone last SAID something (activity), `createdAt` = when the slot was
 *  made. `--since` filters on activity, `--created-since` on creation; `--sort` only orders. */
export interface ListQuery {
  /** exact workspace path (already resolved by the caller — see `here` in the route) */
  workspace?: string;
  /** a status word, or the pseudo-status `cold` */
  status?: string;
  /** only sessions with an approval waiting — the operator's real to-do queue */
  waiting?: boolean;
  /** `30m` / `2h` / `1d` / `2w` / `2026-10-17` / `2026-10-17T14:30` — measured against ACTIVITY */
  since?: string;
  /** same grammar, measured against CREATION */
  createdSince?: string;
  /** case-insensitive substring of the TITLE (never the transcript — see the skill) */
  grep?: string;
  sort?: "last" | "created" | "name";
  limit?: number;
  /** include 已归档 rows. They are out of scope by default, and that is a product rule, not a default */
  all?: boolean;
  /** include the caller's own row (marked `self`) — off shows only sessions it could talk to */
  includeSelf?: boolean;
  /** bucket the page instead of returning it flat. `workspace` is the only dimension today because it
   *  is the one the operator's rail groups by — anything else would be an invented taxonomy. */
  by?: "workspace";
  /** How many cold rows the caller's own page left out (issue #34). Set by the route from
   *  `cockpitCold()`: absent/0 means "you are looking at everything", non-zero means the view is
   *  partial and the answer must say so. Never a wire parameter. */
  coldOmitted?: number;
  /** fixed clock for tests; never set by a caller over the wire */
  now?: number;
}

export interface ListResult {
  rows: CockpitSessionRow[];
  /** present only when `by` was asked for: the SAME rows, bucketed, in the same order. A caller that
   *  does not want buckets keeps reading `rows`; nothing is duplicated in the JSON. */
  groups?: { key: string; label: string; sessions: CockpitSessionRow[] }[];
  meta: {
    total: number;
    returned: number;
    /** TRUE means "this is not the whole answer" — either the list limit cut it, or (`cold_omitted`)
     *  the cold page itself did. Before #34 only the first was visible, so an agent could not tell a
     *  complete view from a truncated one. */
    capped: boolean;
    /** cold rows that existed but never reached this function (0 = nothing was hidden) */
    cold_omitted: number;
    /** the filters that were actually applied, echoed back so a caller cannot misread an empty list
     *  as "there is nothing" when what happened is "your filter matched nothing" */
    applied: Record<string, string | number | boolean>;
  };
}

const SINCE_UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** Parse a `--since` value.
 *
 *  Relative windows out of `s/m/h/d/w`, or an ISO date (`2026-10-17` = local midnight that day) or an
 *  ISO date-time without a zone (`2026-10-17T14:30`, LOCAL — the operator's clock is the one they
 *  mean; a Z or offset, if sent, is honoured by `Date.parse`).
 *
 *  Deliberately NOT accepted: `yesterday`, `last week`, `1M` (month vs minute is a trap), and empty
 *  strings. A wrong window silently returning everything would be worse than a refusal. */
export function parseSince(raw: string, now = Date.now()): { ok: true; at: number } | { ok: false; why: string } {
  const v = raw.trim();
  const rel = /^(\d+)([smhdw])$/.exec(v);
  if (rel) {
    const at = now - Number(rel[1]) * SINCE_UNITS[rel[2]];
    return { ok: true, at };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const at = new Date(`${v}T00:00:00`).getTime();
    return Number.isFinite(at) ? { ok: true, at } : { ok: false, why: `not a date: ${raw}` };
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?/.test(v)) {
    const at = new Date(v.replace(" ", "T")).getTime();
    return Number.isFinite(at) ? { ok: true, at } : { ok: false, why: `not a date-time: ${raw}` };
  }
  return { ok: false, why: `--since wants 30m/2h/1d/2w or 2026-10-17[T14:30], got "${raw}"` };
}

/** Filter + order + cap the scope list. Pure, so the CLI contract can be tested without a server.
 *
 *  Reads nothing it was not given: the caller decides WHICH rows exist (the cockpit's own scope rule
 *  lives in `cockpitRows`), this decides which of those answer the question that was asked. */
export function listSessions(rows: CockpitSessionRow[], q: ListQuery = {}): ListResult {
  const now = q.now ?? Date.now();
  const applied: Record<string, string | number | boolean> = {};
  let out = rows;

  if (q.since) {
    const p = parseSince(q.since, now);
    if (p.ok) {
      applied.since = new Date(p.at).toISOString();
      out = out.filter((r) => r.lastAt >= p.at);
    }
    // a bad value is reported by the ROUTE as bad_request; the pure function must not pretend it filtered
  }
  if (q.createdSince) {
    const p = parseSince(q.createdSince, now);
    if (p.ok) {
      applied.created_since = new Date(p.at).toISOString();
      out = out.filter((r) => r.createdAt >= p.at);
    }
  }
  if (q.workspace) {
    const want = normPath(q.workspace);
    applied.workspace = q.workspace;
    out = out.filter((r) => normPath(r.workspace) === want);
  }
  if (q.status) {
    applied.status = q.status;
    out = q.status === "cold" ? out.filter((r) => r.cold) : out.filter((r) => r.status === q.status);
  }
  if (q.waiting) {
    applied.waiting = true;
    out = out.filter((r) => r.permissions > 0);
  }
  if (q.grep) {
    const needle = q.grep.toLowerCase();
    applied.grep = q.grep;
    out = out.filter((r) => r.name.toLowerCase().includes(needle));
  }
  if (!q.all) {
    applied.archived = false;
    out = out.filter((r) => !r.archived);
  }
  if (!q.includeSelf) {
    applied.self = false;
    out = out.filter((r) => !r.self);
  }

  const sort = q.sort ?? "last";
  applied.sort = sort;
  const byName = new Intl.Collator("zh").compare;
  out = [...out].sort((a, b) => {
    // live before cold, always: a session with no process cannot be talked to, and burying it is how
    // an agent ends up "sending" to something the cockpit would only answer target_cold about
    if (a.cold !== b.cold) return a.cold ? 1 : -1;
    if (sort === "name") return byName(a.name, b.name);
    if (sort === "created") return b.createdAt - a.createdAt;
    return b.lastAt - a.lastAt || b.createdAt - a.createdAt;
  });

  const limit = Math.max(1, Math.min(LIST_LIMIT_MAX, Math.round(q.limit ?? LIST_LIMIT_DEFAULT)));
  applied.limit = limit;
  const total = out.length;
  const coldOmitted = Math.max(0, Math.floor(q.coldOmitted ?? 0));
  // `capped` answers "can I trust this as the whole picture?", so a cold page that dropped rows counts
  // even when the list limit itself did not bite (#34).
  const capped = total > limit || coldOmitted > 0;
  const page = out.slice(0, limit);

  let groups: ListResult["groups"];
  if (q.by === "workspace") {
    applied.by = "workspace";
    // Buckets keep the order the rows already have, so the first group is the one that was active
    // most recently — the rail's own reading. Empty/unset workspace is its own bucket rather than
    // being folded into a neighbour: "somewhere I cannot name" is information.
    const byKey = new Map<string, CockpitSessionRow[]>();
    for (const row of page) {
      const key = normPath(row.workspace || "");
      const bucket = byKey.get(key);
      if (bucket) bucket.push(row);
      else byKey.set(key, [row]);
    }
    groups = [...byKey.entries()].map(([key, sessions]) => ({
      key: key || "(no workspace)",
      label: key ? (key.split("/").pop() || key) : "(no workspace)",
      sessions,
    }));
  }

  return { rows: page, ...(groups ? { groups } : {}), meta: { total, returned: Math.min(total, limit), capped, cold_omitted: coldOmitted, applied } };
}

function normPath(p: string): string {
  return p.replace(/\/+$/, "") || "/";
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
