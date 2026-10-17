#!/usr/bin/env node
/**
 * `agentus <command>` — the CLI client: sessions, their transcripts and plans, and the gated
 * cross-session `send`. Dispatched by `bin/agentus.mjs`, which is also what the cockpit hands agents
 * as `AGENTUS_COCKPIT_BIN`, so there is exactly one command and one spelling everywhere.
 *
 * SHAPE: noun, then verb — `agentus session list|show|messages|plan|send`
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

  agentus session list                who you are + every session in scope, one line each
  agentus session show <id>           one session in detail, with any approval it is waiting on
  agentus session messages <id> [--tail N]
                                      the last N messages, each cut to the documented size
  agentus session plan <id>           the plan object the operator's card renders
  agentus session send <id> <text…>   deliver a message into another session (stdin if no text)

  agentus capabilities                the contract: commands, fields, truncation, scope, send state
  agentus skill [--path]              this CLI's manual, as shipped in the package

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

function needAuth() {
  if (!ENDPOINT || !TOKEN || !SELF) {
    fail(
      "no_identity",
      "this command only works inside an Agentus session: the cockpit hands AGENTUS_COCKPIT_ENDPOINT/_TOKEN/_SESSION to the agent it spawns. Keep your own notes instead.",
    );
  }
}

async function call(pathname) {
  let res;
  try {
    res = await fetch(`${ENDPOINT}${pathname}`, { headers: { "x-agentus-cockpit-token": TOKEN } });
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
    const data = await call("/api/cockpit/context");
    out({ success: true, data, meta: meta(data) });
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
    let message = args.slice(1).join(" ").trim();
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
      res = await fetch(`${ENDPOINT}/api/cockpit/send`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-agentus-cockpit-token": TOKEN },
        body: JSON.stringify({ to: id, message }),
      });
    } catch (e) {
      fail("unreachable", `the cockpit did not answer: ${e?.message ?? e}`);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      // The refusal meanings a model must not blur (see `capabilities.discipline`): none of these is
      // "delivered", and target_busy specifically means the target saw NOTHING.
      fail(String(body?.error ?? `http_${res.status}`), String(body?.error ?? `the cockpit answered HTTP ${res.status}`));
    }
    out({
      success: true,
      data: body,
      meta: {
        schema_version: 1,
        note: "delivered means the target agent received it and started a turn — it does NOT mean it read or agreed. Only the operator sees the reply.",
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
