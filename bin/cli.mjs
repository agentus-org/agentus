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

const ENDPOINT = (process.env.AGENTUS_COCKPIT_ENDPOINT ?? "").replace(/\/+$/, "");
const TOKEN = process.env.AGENTUS_COCKPIT_TOKEN ?? "";
const SELF = process.env.AGENTUS_COCKPIT_SESSION ?? "";

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
  agentus session messages <id> [--tail N]
                                      the last N messages, each cut to the documented size
  agentus session plan <id>           the plan object the operator's card renders
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

/** Operator mode — a human at a shell, not an agent inside a session.
 *
 *  The cockpit already trusts `<DATA_DIR>/auth.token` as the operator credential (it is what scripts
 *  and CI use), so the same CLI works from a terminal without inventing a second door. Read from the
 *  FILE, never from argv: the token identifies the operator. Returns null when this is an agent (its
 *  own variables win) or when there is nothing to authenticate with. */
function resolveOperator() {
  if (ENDPOINT && TOKEN && SELF) return null; // an agent: its identity is the cockpit's to give
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
    fail(
      "no_identity",
      "no cockpit to talk to: either run this inside an Agentus session (the cockpit hands the agent AGENTUS_COCKPIT_ENDPOINT/_TOKEN/_SESSION), or from a shell with AGENTUS_DATA pointing at a cockpit whose auth.token you own. Keep your own notes instead.",
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
  if (!res.ok) fail(String(body?.error ?? `http_${res.status}`), String(body?.error ?? `the cockpit answered HTTP ${res.status}`));
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
    if (!res.ok) fail(String(body?.error ?? `http_${res.status}`), String(body?.error ?? `the cockpit answered HTTP ${res.status}`));
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
    if (!id) fail("bad_request", "usage: agentus session messages <id> [--tail N]");
    const at = args.indexOf("--tail");
    const tail = at >= 0 ? args[at + 1] : undefined;
    if (at >= 0 && tail === undefined) fail("bad_request", "--tail needs a number");
    const leftovers = args.filter((_, i) => i > 0 && i !== at && i !== at + 1);
    if (leftovers.length) fail("bad_request", `unexpected argument "${leftovers[0]}" (usage: agentus session messages <id> [--tail N])`);
    const data = await call(`/api/cockpit/messages?id=${q(id)}${tail ? `&tail=${q(tail)}` : ""}`);
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
          "delivered means the target agent received it and started a turn — it does NOT mean it read or agreed. Only the operator sees the reply.",
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
    const cwdArg = args.find((a) => !a.startsWith("--"));
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
          : (body?.stopped ? "the turn was cancelled; the words it had already produced stay in the transcript." : "no turn was running — nothing was interrupted."),
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
