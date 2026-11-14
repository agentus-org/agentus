#!/usr/bin/env node
/**
 * `agentus <command>` — the CLI client: sessions, their transcripts and plans, and the gated
 * cross-session `send`. Dispatched by `bin/agentus.mjs`, which is also what the cockpit hands agents
 * as `AGENTUS_COCKPIT_BIN`, so there is exactly one command and one spelling everywhere.
 *
 * SHAPE: noun, then verb — `agentus session list|show|messages|plan|send|wake|create|stop`
 * The five things an agent needs are all about ONE object (a session), so the noun is not decoration:
 * it keeps `list` from meaning "list what?" and leaves the top level free for the two commands that
 * are NOT about a session — `capabilities` (this CLI's contract) and `skill` (its manual). The
 * session id is a POSITIONAL argument, like `docker logs <id>` / `git show <rev>`: it is the object
 * the verb acts on, not an option, and `--tail` stays an option exactly because it is a modifier.
 *
 * IDENTITY AND SECRETS
 * The cockpit sets `AGENTUS_COCKPIT_ENDPOINT` / `_TOKEN` / `_SESSION` in the agent's own environment
 * when it spawns it; this file only reads them. NEVER echo/export/print them: one is your session, the
 * other is the key to it. Nothing here takes a token on the command line — a command line ends up in
 * `ps` and in shell history, an environment does not.
 *
 * OUTPUT CONTRACT
 * stdout carries ONE JSON document: `{ success, data, meta }`. Anything a human reads goes to stderr,
 * so a caller can pipe stdout straight into `jq`. A refusal is `{ success: false, error: { code,
 * message } }` on stdout plus a non-zero exit; the code is a STABLE string (`target_busy`,
 * `sends_disabled`, …) that a model can branch on.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** This package's root — `bin/` is one level down. Resolved from the FILE, never from cwd: the CLI is
 *  run from inside an agent's session, whose cwd is the operator's project. */
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The identity channels, in order of authority (#15, #106).
 *
 *  ① the environment — what the cockpit puts in the child it spawns. Still the correct channel for an
 *    in-process backend, and the ONLY one an agent could ever see before this file existed;
 *  ② `~/.agentus/cockpit/<agent-session-id>.json` — for a runtime that owns the session in a shared
 *    gateway (Hermes 0.23+), where the turn's tool processes inherit the GATEWAY's environment and a
 *    per-session secret cannot travel that way. The file is named by the agent-side session id, which
 *    is the one per-session fact such a process does carry (`HERMES_SESSION_CHAT_ID` is byte-identical
 *    to the cockpit's `acp_session_id`), so the lookup needs nothing but what the runtime says about
 *    itself;
 *  ③ the operator credential — a HUMAN at a shell, never an agent (see `inAgentTurn()`).
 *
 *  Both ① and ② are a SESSION identity: they read and dispatch, and they may not touch history (#73). */
const AGENT_SESSION_MARKERS = ["HERMES_SESSION_CHAT_ID", "HERMES_SESSION_ID", "AGENTUS_SESSION_ROLE"];

const ENV_ENDPOINT = (process.env.AGENTUS_COCKPIT_ENDPOINT ?? "").replace(/\/+$/, "");
const ENV_TOKEN = process.env.AGENTUS_COCKPIT_TOKEN ?? "";
const ENV_SELF = process.env.AGENTUS_COCKPIT_SESSION ?? "";
const FILE_IDENTITY = ENV_TOKEN && ENV_SELF ? null : resolveIdentityFile();
const ENDPOINT = ENV_ENDPOINT || FILE_IDENTITY?.endpoint || "";
const TOKEN = ENV_TOKEN || FILE_IDENTITY?.token || "";
const SELF = ENV_SELF || FILE_IDENTITY?.session || "";
/** A session identity is in hand (from either channel) — narrow scope, and NOT the operator. */
const AGENT = Boolean(TOKEN && SELF);

const USAGE = `agentus — read the cockpit from inside a session, and (if the operator allowed it) talk to
another one

  agentus session list [flags]        who you are + the sessions in scope that match
        --here            only MY workspace (usually what you want)
        --workspace <p>   only that workspace            --status running|ready|cold
        --waiting         only sessions with an approval outstanding (the operator's queue)
        --since <when>    activity within 30m/2h/1d/2w or 2026-10-17[T14:30]
        --created-since <when>   same grammar, measured against CREATION
        --grep <text>     title substring        --sort last|created|name
        --limit N         default 20, max 200    --all include 已归档   --include-self
        --by workspace    bucket the page by workspace (groups + sessions)
        --table           print a HUMAN table instead of JSON (for people, not for pipes)
  agentus session rename <id> <title…> | --auto    name it (attributed to you)
  agentus session show <id>           one session in detail, with any approval it is waiting on
  agentus session messages <id> [--tail N] [--role K] [--user]
                                      the last N messages, each cut to the documented size.
                                      --role keeps one kind (user|agent|tool|thought|plan) and
                                      filters BEFORE taking the tail, so --user --tail 3 answers
                                      three user messages even after forty tool rows; --user is
                                      --role user. meta carries filtered = the pool it read from.
  agentus session plan <id>           the plan object the operator's card renders
  agentus session delete <id>         OPERATOR ONLY — close it if live, PURGE the transcript if cold
  agentus session archive <id>        OPERATOR ONLY — hide it from the rail (live: its process stops)
  agentus session unarchive <id>      OPERATOR ONLY — bring it back
  agentus session send <id> <text…> [--wake] [--interrupt] [--reply-on-done]
                                       deliver a message into another session (stdin if no text);
                                       --wake also starts the target when it is cold;
                                       --interrupt cancels the turn it is running first (explicit)
  agentus session wake <id>            start a cold session's process (same switch as send)
  agentus session create <cwd> [--backend <id>] [--title <text>]
                                       open a NEW session in that directory and answer with its row
                                       (same switch as send — it costs one agent process)
  agentus session stop <id> [--close]  interrupt the turn it is running; --close stops the PROCESS
                                       (the slot goes cold, the transcript stays)

  agentus capabilities                the contract: commands, fields, truncation, scope, send state
  agentus skill [--path]              this CLI's manual, as shipped in the package

Operator mode: run outside a session with AGENTUS_DATA (data dir) and AGENTUS_PORT (or
AGENTUS_ENDPOINT) pointing at your cockpit — the CLI then authenticates with <data>/auth.token, the
same credential scripts already use. Inside a session it always prefers the cockpit's own variables.

Read "capabilities" first: it is self-describing, so no doc can drift from the code.
"send" is OFF unless the operator turned 驾驶舱互发消息 on. A busy target answers target_busy and saw
NOTHING — never report that as delivered, and never claim another session READ your message.
`;

function out(doc) {
  process.stdout.write(`${JSON.stringify(doc)}\n`);
}

function fail(code, message, extra = {}) {
  out({ success: false, error: { code, message }, ...extra });
  process.stderr.write(`error [${code}]: ${message}\n`);
  process.exit(1);
}

/** The environment variables a runtime stamps its tool processes with — the agent-side session ids.
 *
 *  Hermes: `HERMES_SESSION_CHAT_ID` is the session (measured byte-identical to our `acp_session_id`);
 *  `HERMES_SESSION_ID` is its chat-row id and is only used as a second chance. `AGENTUS_SESSION_ROLE`
 *  is ours (a 工作播报 observer). Names are matched EXACTLY and read only — nothing here is trusted for
 *  authorisation; the token in the file is what the server verifies. */

/** Session ids this process could be running as, most specific first. */
function agentSessionIds() {
  const ids = [];
  for (const k of AGENT_SESSION_MARKERS) {
    const v = String(process.env[k] ?? "").trim();
    if (v && !ids.includes(v)) ids.push(v);
  }
  return ids;
}

/** Is this process a TOOL SUBPROCESS of an agent's turn, rather than a human's shell?
 *
 *  This is the #106 fail-closed switch. It is not a security boundary on its own — the machine token in
 *  `<data>/auth.token` is readable by anything running as the operator, so a determined same-uid process
 *  can always bypass a client-side check. What it does stop is the case that actually happened: the
 *  cockpit lost its channel, the CLI quietly fell back to the OPERATOR credential, and an agent inside a
 *  session got to purge another session's transcript (`session delete` → `purged`) while every line of
 *  its own documentation said it had no such right. Missing identity must mean AGENT, never operator. */
function inAgentTurn() {
  return agentSessionIds().length > 0;
}

/** Which destructive verb this invocation is, or null.
 *
 *  Read straight from argv because the refusal has to be raisable BEFORE any credential branch: the
 *  operator-only door is a property of the VERB, so an agent that ran out of identity must hear
 *  `agents_may_not_delete` rather than the generic `no_identity` — a model branches on the code. */
function destructiveVerb() {
  const argv = process.argv.slice(2);
  if (argv[0] !== "session") return null;
  const verb = String(argv[1] ?? "");
  return verb === "delete" || verb === "archive" || verb === "unarchive" ? verb : null;
}

/** One wording for the refusal, wherever it is raised from (pre-auth or in the verb's own branch). */
function destructiveRefusal(verb) {
  return `删历史/归档是操作员的动作，不开放给会话内的 agent —— 请以 operator 模式在终端执行（AGENTUS_DATA 指向这个驾驶舱，身份取自 auth.token）。usage: agentus session ${verb} <id>`;
}

/** The rendezvous the cockpit publishes for gateway-owned runtimes — see `AGENT_SESSION_MARKERS`. */
function resolveIdentityFile() {
  const dir = path.join(process.env.HOME ?? "", ".agentus", "cockpit");
  for (const id of agentSessionIds()) {
    const file = path.join(dir, `${id}.json`);
    if (!existsSync(file)) continue;
    try {
      const j = JSON.parse(readFileSync(file, "utf8"));
      if (typeof j?.endpoint === "string" && typeof j?.token === "string" && typeof j?.session === "string") {
        return { endpoint: j.endpoint.replace(/\/+$/, ""), token: j.token, session: j.session };
      }
    } catch { /* half-written or hand-edited: fall through to the next marker */ }
  }
  return null;
}

/** Operator mode — a human at a shell, not an agent inside a session.
 *
 *  The cockpit already trusts `<DATA_DIR>/auth.token` as the operator credential (it is what scripts
 *  and CI use), so the same CLI works from a terminal without inventing a second door. Read from the
 *  FILE, never from argv: the token identifies the operator. Returns null when this is an agent (its
 *  own variables win) or when there is nothing to authenticate with. */
function resolveOperator() {
  if (AGENT) return null; // an agent: its identity is the cockpit's to give, or nothing at all
  // #106: a tool subprocess of a turn is NOT a human's shell. Without this line the operator fallback
  // below makes "the cockpit lost its channel" indistinguishable from "the operator is at the terminal"
  // — and hands an agent the delete/archive verbs it is documented not to have.
  if (inAgentTurn()) return null;
  const dataDir = process.env.AGENTUS_DATA || path.join(process.env.HOME ?? "", ".agentus");
  const file = path.join(dataDir, "auth.token");
  if (!existsSync(file)) return null;
  const port = process.env.AGENTUS_PORT || "8788";
  const endpoint = (process.env.AGENTUS_ENDPOINT || `http://127.0.0.1:${port}`).replace(/\/+$/, "");
  const token = readFileSync(file, "utf8").trim();
  return token ? { endpoint, token } : null;
}

const OPERATOR = resolveOperator();
const EP = ENDPOINT || OPERATOR?.endpoint || "";

function headers(json = false) {
  const h = {};
  if (json) h["content-type"] = "application/json";
  if (TOKEN) h["x-agentus-cockpit-token"] = TOKEN;
  else if (OPERATOR) h.authorization = `Bearer ${OPERATOR.token}`;
  return h;
}

function needAuth() {
  if (!EP || (!TOKEN && !OPERATOR)) {
    // #106: an agent that lost its identity asking for a destructive verb must hear the REAL reason.
    // "no credentials" is not "you are the operator at a terminal", and the operator-only door is a
    // property of the verb — see `destructiveVerb()`.
    const verb = destructiveVerb();
    if (verb && (AGENT || inAgentTurn())) {
      fail(verb === "delete" ? "agents_may_not_delete" : "agents_may_not_archive", destructiveRefusal(verb));
    }
    fail(
      "no_identity",
      "no cockpit to talk to: either run this inside an Agentus session (the cockpit hands the agent AGENTUS_COCKPIT_ENDPOINT/_TOKEN/_SESSION, or — on a gateway-owned runtime — publishes them in ~/.agentus/cockpit/<agent-session-id>.json), or from a shell with AGENTUS_DATA pointing at a cockpit whose auth.token you own. Keep your own notes instead.",
    );
  }
}

async function call(pathname) {
  let res;
  try {
    res = await fetch(`${EP}${pathname}`, { headers: headers() });
  } catch (e) {
    fail("unreachable", `the cockpit did not answer: ${e?.message ?? e}`);
  }
  const body = await res.json().catch(() => null);
  // `error` is the stable code a model branches on; `message` is the explanation a human reads. Doing
  // both from `error` printed 「bad_request: bad_request」 and threw away which argument was wrong.
  if (!res.ok) fail(String(body?.error ?? `http_${res.status}`),
    String(body?.message ?? body?.error ?? `the cockpit answered HTTP ${res.status}`));
  return body;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8").trim();
}

/** Age in the smallest unit that still reads: 12s / 7m / 3h / 5d. Stale-but-live is the case this is
 *  for — a session waiting on an approval shows an old age and that is the signal, not a bug. */
function age(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function tableRow(s, now) {
  const dot = s.cold ? "○" : "●";
  const flags = [s.permissions ? `⏸${s.permissions}` : "", s.plan ? `▶${s.plan.done ?? ""}` : "", s.self ? "self" : ""]
    .filter(Boolean)
    .join(" ");
  const name = String(s.name ?? "").slice(0, 44);
  return `${dot} ${age(now - (s.lastAt ?? now)).padStart(4)}  ${flags.padEnd(8)} ${s.id}  ${name}`;
}

/** Grouped when the answer has groups, flat otherwise — one renderer, so `--table` never disagrees with
 *  `--by workspace` about what the shape of the answer is. */
function renderTable(data) {
  const now = Date.now();
  const self = data?.self;
  const head = [
    self ? `you: ${self.id}  ${self.name ?? ""}` : "you: (operator — no session identity)",
    `${data?.meta?.returned ?? 0}/${data?.meta?.total ?? 0} session(s)${data?.meta?.capped ? ", capped" : ""}`,
    data?.meta?.applied ? `filters: ${JSON.stringify(data.meta.applied)}` : "",
  ].filter(Boolean).join("   ·   ");
  const lines = [head, ""];
  const groups = data?.groups;
  if (groups) {
    for (const g of groups) {
      lines.push(`${g.key}   (${g.sessions.length})`);
      for (const s of g.sessions) lines.push(`  ${tableRow(s, now)}`);
      lines.push("");
    }
  } else {
    for (const s of data?.sessions ?? []) lines.push(tableRow(s, now));
    lines.push("");
  }
  lines.push("● live  ○ cold  ⏸ waiting on approval  ▶ plan");
  return `${lines.join("\n")}\n`;
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
  process.stderr.write(USAGE);
  process.exit(cmd ? 0 : 2);
}

// `skill` answers from the package, with no cockpit involved: the document ships next to this file
// (`skills/agentus-cockpit/SKILL.md`), so an agent whose backend has no native skill discovery can still
// read it on demand instead of having it pasted into every prompt. Keep it OUTSIDE the auth gate —
// needing a token to learn how to use the token would be a locked door with the key behind it.
if (cmd === "skill") {
  const doc = path.join(PKG_ROOT, "skills/agentus-cockpit/SKILL.md");
  if (rest.includes("--path")) {
    process.stdout.write(`${doc}\n`);
    process.exit(0);
  }
  if (!existsSync(doc)) fail("no_skill", `the skill document is missing from this install (expected ${doc})`);
  process.stdout.write(readFileSync(doc, "utf8"));
  process.exit(0);
}

needAuth();
const q = (s) => encodeURIComponent(s);
const meta = (data) => ({ schema_version: data?.schema_version ?? 1, ...(data?.meta ?? {}) });

if (cmd === "capabilities") {
  const data = await call("/api/cockpit/capabilities");
  out({ success: true, data, meta: meta(data) });
} else if (cmd === "session") {
  const [verb, ...args] = rest;
  const id = args[0];
  // `agentus session stop --close`（漏了 id）曾经被当成 id="--close" 打到服务端，回一个 404
  // out_of_scope —— 调用方以为"被拒"，其实是自己打错了（#73）。这一类在解析阶段就拒。
  const TAKES_ID = new Set(["show", "messages", "plan", "send", "wake", "stop", "rename", "delete", "archive", "unarchive"]);
  if (id && id.startsWith("--") && TAKES_ID.has(verb)) {
    fail("bad_request", `expected a session id, got the flag "${id}" — flags come after the id (agentus session ${verb} <id> …)`);
  }

  if (verb === "list") {
    // Flags only after the verb, and the id-less list is the one command where that is the whole
    // surface: everything here narrows WHICH sessions answer, nothing changes them.
    const params = new URLSearchParams();
    // `by` and `table` are display choices: `by` changes the JSON shape (the server buckets), `table`
    // only changes what this process prints — it never travels as a query the server could act on.
    const VALUE_FLAGS = ["workspace", "status", "since", "created-since", "grep", "sort", "limit", "by"];
    const BOOL_FLAGS = ["here", "waiting", "all", "include-self", "table"];
    // flags start at 0 here: `session list` takes no positional id (unlike show/messages/plan)
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (!a.startsWith("--")) fail("bad_request", `unexpected argument "${a}" (session list takes flags only)`);
      const name = a.slice(2);
      if (BOOL_FLAGS.includes(name)) {
        params.set(name.replaceAll("-", "_"), "1");
      } else if (VALUE_FLAGS.includes(name)) {
        const v = args[++i];
        if (v === undefined) fail("bad_request", `--${name} needs a value`);
        if (name === "limit" && !/^\d+$/.test(v)) fail("bad_request", `--limit wants a number, got "${v}"`);
        if (name === "by" && v !== "workspace") fail("bad_request", `--by wants workspace, got "${v}"`);
        params.set(name.replaceAll("-", "_"), v);
      } else {
        fail("bad_request", `unknown flag --${name} (see agentus capabilities)`);
      }
    }
    const wantTable = params.get("table") === "1";
    params.delete("table");
    const qs = params.toString();
    const data = await call(`/api/cockpit/context${qs ? `?${qs}` : ""}`);
    if (wantTable) {
      // Human output REPLACES the JSON document on stdout (documented in `capabilities`). Mixing the
      // two would break both readers: a pipe wants one JSON document, an eye wants columns.
      process.stdout.write(renderTable(data));
    } else {
      out({ success: true, data, meta: meta(data) });
    }
  } else if (verb === "rename") {
    if (!id) fail("bad_request", "usage: agentus session rename <id> <new title…> | --auto");
    const auto = args.includes("--auto");
    const title = args.slice(1).filter((a) => a !== "--auto").join(" ").trim();
    if (!auto && !title) fail("bad_request", "nothing to name it: pass the title after the id, or --auto to clear it");
    if (auto && title) fail("bad_request", "--auto clears the name; do not also pass a title");
    let res;
    try {
      res = await fetch(`${EP}/api/cockpit/rename`, {
        method: "POST",
        headers: headers(true),
        body: JSON.stringify(auto ? { id, auto: true } : { id, title }),
      });
    } catch (e) {
      fail("unreachable", `the cockpit did not answer: ${e?.message ?? e}`);
    }
    const body = await res.json().catch(() => null);
    // `message` is the human half (a route that refuses a bad argument explains WHICH one); `error`
    // is the stable code. Reading only `error` for both threw the explanation away.
    if (!res.ok) fail(String(body?.error ?? `http_${res.status}`),
      String(body?.message ?? body?.error ?? `the cockpit answered HTTP ${res.status}`));
    out({ success: true, data: body, meta: meta(body) });
  } else if (verb === "show") {
    if (!id) fail("bad_request", "usage: agentus session show <id>");
    // Nothing here ignores a stray argument: `show a b` is a typo, and a CLI that silently drops half
    // of its input is a CLI whose answers you cannot trust (AionUi's parser skips non-flag tokens;
    // that is fine for its flag-only surface, wrong for one that takes ids).
    if (args.length > 1) fail("bad_request", `unexpected argument "${args[1]}" (usage: agentus session show <id>)`);
    const data = await call(`/api/cockpit/session?id=${q(id)}`);
    out({ success: true, data, meta: meta(data) });
  } else if (verb === "messages") {
    const USAGE = "usage: agentus session messages <id> [--tail N] [--role user|agent|tool|thought|plan] [--user]";
    if (!id) fail("bad_request", USAGE);
    const at = args.indexOf("--tail");
    const tail = at >= 0 ? args[at + 1] : undefined;
    if (at >= 0 && tail === undefined) fail("bad_request", "--tail needs a number");
    const roleAt = args.indexOf("--role");
    const role = roleAt >= 0 ? args[roleAt + 1] : undefined;
    if (roleAt >= 0 && role === undefined) fail("bad_request", "--role needs a value (one of user, agent, tool, thought, plan)");
    // `--user` is nothing but a shorter `--role user` — the observer's contract writes it, so it is
    // worth the three lines. Both at once is a caller who is guessing: say so instead of picking one.
    const wantUser = args.includes("--user");
    if (wantUser && role !== undefined && role !== "user") {
      fail("bad_request", `--user and --role ${role} contradict each other`);
    }
    const consumed = new Set([0, at, at + 1, roleAt, roleAt + 1].filter((i) => i >= 0));
    for (let i = 0; i < args.length; i += 1) if (args[i] === "--user") consumed.add(i);
    const leftovers = args.filter((_, i) => !consumed.has(i));
    if (leftovers.length) fail("bad_request", `unexpected argument "${leftovers[0]}" (${USAGE})`);
    const roleQ = role ?? (wantUser ? "user" : undefined);
    const data = await call(
      `/api/cockpit/messages?id=${q(id)}${tail ? `&tail=${q(tail)}` : ""}${roleQ ? `&role=${q(roleQ)}` : ""}`,
    );
    out({ success: true, data, meta: meta(data) });
  } else if (verb === "plan") {
    if (!id) fail("bad_request", "usage: agentus session plan <id>");
    if (args.length > 1) fail("bad_request", `unexpected argument "${args[1]}" (usage: agentus session plan <id>)`);
    const data = await call(`/api/cockpit/plan?id=${q(id)}`);
    out({ success: true, data, meta: meta(data) });
  } else if (verb === "send") {
    if (!id) fail("bad_request", "usage: agentus session send <id> <text…>");
    // The text is the plain words after the id — an agent writing a sentence should not have to
    // build JSON to say it. With no words, stdin is accepted: either a JSON `{"message": "…"}` (what
    // older callers sent) or the raw text.
    const wantWake = args.includes("--wake");
    const wantInterrupt = args.includes("--interrupt");
    // #59：`--reply-on-done` 不是"抢话头"，是"别让我在这儿等它跑完" —— 调用立即返回，目标回合
    // 自然结束时服务端往本会话投一条【完成回推】。派活给一个要跑十分钟的会话时才用得上。
    const wantReply = args.includes("--reply-on-done");
    const FLAGS = new Set(["--wake", "--interrupt", "--reply-on-done"]);
    const straySend = args.slice(1).filter((a) => a.startsWith("--") && !FLAGS.has(a));
    if (straySend.length) fail("bad_request", `unknown flag ${straySend[0]} (usage: agentus session send <id> <text…> [--wake] [--interrupt] [--reply-on-done])`);
    let message = args.slice(1).filter((a) => !FLAGS.has(a)).join(" ").trim();
    if (!message) {
      const raw = await readStdin();
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          message = String(parsed?.message ?? parsed?.text ?? "").trim();
        } catch {
          message = raw.trim();
        }
      }
    }
    if (!message) fail("bad_request", "nothing to send: pass the text after the id, or pipe it on stdin");
    let res;
    try {
      res = await fetch(`${EP}/api/cockpit/send`, {
        method: "POST",
        headers: headers(true),
        body: JSON.stringify({ to: id, message, ...(wantWake ? { wake: true } : {}), ...(wantInterrupt ? { interrupt: true } : {}), ...(wantReply ? { replyOnDone: true } : {}) }),
      });
    } catch (e) {
      fail("unreachable", `the cockpit did not answer: ${e?.message ?? e}`);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      // The refusal meanings a model must not blur (see `capabilities.discipline`): none of these is
      // "delivered", and target_busy specifically means the target saw NOTHING.
      // The refusal's MESSAGE is the part a model can act on (it names --wake, or that a box is
      // archived); the code stays the stable token. Dropping the message made `target_cold` a dead
      // end that looked identical to a true prohibition.
      fail(String(body?.error ?? `http_${res.status}`),
        String(body?.message ?? body?.error ?? `the cockpit answered HTTP ${res.status}`));
    }
    out({
      success: true,
      data: body,
      meta: {
        schema_version: 1,
        note: [
          body?.delivered_after_wake
            ? "the target was COLD: this call woke it (a process now exists) and then delivered."
            : null,
          body?.interrupted
            ? "the target was BUSY: its turn was interrupted (cancelled, then the session was waited to really stop) before yours started — the words it had already produced stay in its transcript."
            : null,
          body?.reply_on_done
            ? "reply-on-done: this call returned as soon as the target's turn STARTED. When that turn ends, the cockpit posts a 【完成回推】 notice into this session and wakes you; read the actual result with `session messages <target>`."
            : "delivered means the target agent received it and started a turn — it does NOT mean it read or agreed. Only the operator sees the reply.",
        ].filter(Boolean).join(" "),
      },
    });
  } else if (verb === "wake") {
    // #41: the explicit, gated version of what opening a cold session in the rail does. Kept separate
    // from send because it is a DECISION with a cost (a process, its memory) — an agent must be able
    // to say 「I woke it」 without also having said something.
    if (!id) fail("bad_request", "usage: agentus session wake <id>");
    if (args.length > 1) fail("bad_request", `unexpected argument "${args[1]}" (usage: agentus session wake <id>)`);
    let res;
    try {
      res = await fetch(`${EP}/api/cockpit/wake`, { method: "POST", headers: headers(true), body: JSON.stringify({ id }) });
    } catch (e) {
      fail("unreachable", `the cockpit did not answer: ${e?.message ?? e}`);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      fail(String(body?.error ?? `http_${res.status}`), String(body?.message ?? body?.error ?? `the cockpit answered HTTP ${res.status}`));
    }
    out({
      success: true,
      data: body,
      meta: {
        schema_version: 1,
        note: body?.woke
          ? "the target now has a process and accepts send. Waking costs one process — do it for work you actually need."
          : "the target was already live: nothing was started.",
      },
    });
  } else if (verb === "create") {
    // The FIRST positional is the directory, not an id: this is the one verb that makes an object
    // instead of acting on one. `~` is expanded HERE as well as server-side so the error a caller
    // reads names the path it actually meant.
    // Walk argv once, skipping each flag's VALUE — otherwise `create --backend hermes /tmp/x`
    // reads "hermes" as the directory and then rejects the real path as an extra argument.
    const VALUE_FLAGS = new Set(["--backend", "--title", "--profile", "--model"]);
    let cwdArg;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith("--")) { if (VALUE_FLAGS.has(a)) i++; continue; }
      cwdArg = a;
      break;
    }
    if (!cwdArg) fail("bad_request", "usage: agentus session create <cwd> [--backend <id>] [--title <text>]");
    const flags = { backend: undefined, title: undefined };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === cwdArg) continue;
      if (a === "--backend" || a === "--title") {
        const v = args[++i];
        if (v === undefined) fail("bad_request", `${a} needs a value`);
        flags[a.slice(2)] = v;
      } else fail("bad_request", `unexpected argument "${a}" (usage: agentus session create <cwd> [--backend <id>] [--title <text>])`);
    }
    let res;
    try {
      res = await fetch(`${EP}/api/cockpit/create`, {
        method: "POST",
        headers: headers(true),
        body: JSON.stringify({ cwd: cwdArg, ...flags }),
      });
    } catch (e) {
      fail("unreachable", `the cockpit did not answer: ${e?.message ?? e}`);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      // An unknown backend is only actionable if the caller is told WHICH ones exist — the same reason
      // `target_cold` names `--wake` instead of being a bare prohibition.
      fail(String(body?.error ?? `http_${res.status}`),
        String(body?.message ?? body?.error ?? `the cockpit answered HTTP ${res.status}`),
        Array.isArray(body?.backends) ? { details: { backends: body.backends } } : {});
    }
    out({
      success: true,
      data: body,
      meta: {
        schema_version: 1,
        note: "the session exists and is starting. Read its id from data.session and send into it at once; a slot with no process yet answers cold_target unless you pass --wake.",
      },
    });
  } else if (verb === "stop") {
    if (!id) fail("bad_request", "usage: agentus session stop <id> [--close]");
    const close = args.includes("--close");
    const leftovers = args.slice(1).filter((a) => a !== "--close");
    if (leftovers.length) fail("bad_request", `unexpected argument "${leftovers[0]}" (usage: agentus session stop <id> [--close])`);
    let res;
    try {
      res = await fetch(`${EP}/api/cockpit/stop`, {
        method: "POST",
        headers: headers(true),
        body: JSON.stringify(close ? { id, close: true } : { id }),
      });
    } catch (e) {
      fail("unreachable", `the cockpit did not answer: ${e?.message ?? e}`);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) fail(String(body?.error ?? `http_${res.status}`), String(body?.message ?? body?.error ?? `the cockpit answered HTTP ${res.status}`));
    out({
      success: true,
      data: body,
      meta: {
        schema_version: 1,
        note: close
          ? (body?.closed ? "its agent process is stopped and the slot is cold; the transcript is untouched." : "nothing was running: the slot was already cold.")
          : body?.stopped
            ? `the turn was cancelled${body?.woke ? " (the slot had to be woken first)" : ""}; the words it had already produced stay in the transcript.`
            // #108: 「发出去了」不是「停了」。这条回执必须和服务器说的是同一件事 —— 以前这里一律说
            // 「没有回合在跑」，而真实情况是那一轮还在 agent 里跑。
            : body?.code === "cancel_unconfirmed"
              ? "the stop was sent, but the agent's turn did not end — it is STILL RUNNING. Retry, or close the slot."
              : "no turn was running — nothing was interrupted.",
      },
    });
  } else if (verb === "delete" || verb === "archive" || verb === "unarchive") {
    // 只对 operator 身份开放（#73）。这道边界是刻意的：cockpit 通道 "Deliberately NOT
    // DELETE /api/sessions/:id"（server index.ts 的注释），因为没有任何跨会话调用方该动操作员的
    // 历史。CLI 是操作员的工具，不是 agent 的 —— 所以这里用 <data>/auth.token 直连 operator 路由，
    // 并且在 agent 身份（AGENTUS_COCKPIT_TOKEN/_SESSION 都在）时**一律拒绝**。
    const usage = `usage: agentus session ${verb} <id>`;
    if (!id) fail("bad_request", usage);
    const leftover = args.slice(1);
    if (leftover.length) fail("bad_request", `unexpected argument "${leftover[0]}" (${usage})`);
    if (AGENT || inAgentTurn()) {
      fail(verb === "delete" ? "agents_may_not_delete" : "agents_may_not_archive", destructiveRefusal(verb));
    }
    if (!OPERATOR) {
      fail("no_identity", `this needs the operator credential: set AGENTUS_DATA to the cockpit's data dir so ${verb} can read auth.token. ${usage}`);
    }
    const opHeaders = { authorization: `Bearer ${OPERATOR.token}` };
    const url = verb === "delete"
      ? `${OPERATOR.endpoint}/api/sessions/${q(id)}`
      : `${OPERATOR.endpoint}/api/sessions/${q(id)}/${verb}`;
    let res;
    try {
      res = await fetch(url, { method: verb === "delete" ? "DELETE" : "POST", headers: opHeaders });
    } catch (e) {
      fail("unreachable", `the cockpit did not answer: ${e?.message ?? e}`);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      // operator 路由把稳定码放 `code`、人话放 `error`：按码分支，别把整句英文当码用。
      fail(String(body?.code ?? body?.error ?? `http_${res.status}`), String(body?.message ?? body?.error ?? `the cockpit answered HTTP ${res.status}`));
    }
    out({
      success: true,
      data: body,
      meta: {
        schema_version: 1,
        note: verb === "delete"
          // 这个不对称必须用大白话说清：执行过了 ≠ 彻底删掉了。
          ? (body && "purged" in body
            ? "PURGED — the transcript is gone from the store. Nothing left to recover."
            : "CLOSED, not purged — its agent process is stopped but the record and the transcript are still there. Run delete again to purge a cold session.")
          : (verb === "archive"
            ? "hidden from the rail; run `session delete` to purge it for real, or `session unarchive` to bring it back."
            : "back in the rail."),
      },
    });
  } else {
    process.stderr.write(USAGE);
    fail("bad_request", `unknown session command: ${verb ?? "(none)"}`);
  }
} else {
  process.stderr.write(USAGE);
  fail("bad_request", `unknown command: ${cmd}`);
}
