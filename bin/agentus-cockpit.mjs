#!/usr/bin/env node
/**
 * `agentus cockpit <command>`: the cockpit's data plane, for AGENTS.
 *
 * WHY THIS IS A CLI AND NOT ANOTHER MCP TOOL
 * Three reasons, in the order they mattered (issue #15):
 *   1. BATCH — one bash call (plus `jq` if you like) can read every session's summary; the same thing
 *      through MCP is N round-trips of tool calls.
 *   2. EVERY RUNTIME HAS BASH — the MCP tool set is lazy-loaded on some agents, which is exactly why
 *      the plan tool needed a prompt-level nudge to be discovered at all. A command in the shell has
 *      no such gate.
 *   3. THE SERVER STAYS DUMB — the CLI is a thin client of `/api/cockpit/*`; every decision about
 *      what may be seen lives on the server (packages/server/src/cockpit/api.ts).
 *
 * IDENTITY AND SECRETS
 * The cockpit sets `AGENTUS_COCKPIT_ENDPOINT` / `_TOKEN` / `_SESSION` in the agent's own environment
 * when it spawns it, and this file only reads them. NEVER echo/export/print them: one is your session,
 * the other is the key to it. Nothing here ever takes a token on the command line — a command line
 * ends up in `ps` and in shell history, an environment does not.
 *
 * OUTPUT CONTRACT
 * stdout carries ONE JSON document: `{ success, data, meta: { schema_version, ... } }`. Anything a
 * human reads goes to stderr, so a caller can pipe stdout straight into `jq` without ceremony. A
 * refusal is `{ success: false, error: { code, message } }` on stdout plus a non-zero exit; the code
 * is a STABLE string (`target_busy`, `sends_disabled`, …) that a model can branch on.
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

const USAGE = `agentus cockpit — read the cockpit, and (if the operator allowed it) talk to another session

  cockpit capabilities              the contract: commands, fields, truncation, scope
  cockpit context                   who you are + every session in scope
  cockpit session <id>              one session in detail, with any approval it is waiting on
  cockpit messages <id> [--tail N]  the last N messages, each cut to the documented size
  cockpit plan <id>                 the plan object the operator's card renders
  cockpit skill [--path]            this CLI's own skill document, straight from the package
  cockpit send <<'JSON'             {"to": "<session id>", "message": "…"} on stdin

Run "capabilities" first: it is self-describing, so no doc can drift from the code.
"send" is OFF unless the operator turned 驾驶舱互发消息 on; a busy target answers target_busy and
saw nothing — never report that as delivered, and never claim another session READ your message.
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

async function call(path) {
  let res;
  try {
    res = await fetch(`${ENDPOINT}${path}`, { headers: { "x-agentus-cockpit-token": TOKEN } });
  } catch (e) {
    fail("unreachable", `the cockpit did not answer: ${e?.message ?? e}`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const code = body?.error ?? `http_${res.status}`;
    fail(String(code), String(body?.error ?? `the cockpit answered HTTP ${res.status}`));
  }
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
// (`skills/cockpit-cli/SKILL.md`), so an agent whose backend has no native skill discovery can still
// read it on demand instead of having it pasted into every prompt. Keep it OUTSIDE the auth gate —
// needing a token to learn how to use the token would be a locked door with the key behind it.
if (cmd === "skill") {
  const doc = path.join(PKG_ROOT, "skills/cockpit-cli/SKILL.md");
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

if (cmd === "capabilities") {
  const data = await call("/api/cockpit/capabilities");
  out({ success: true, data, meta: { schema_version: data?.schema_version ?? 1 } });
} else if (cmd === "context") {
  const data = await call("/api/cockpit/context");
  out({ success: true, data, meta: { schema_version: data?.schema_version ?? 1 } });
} else if (cmd === "session") {
  const id = rest[0];
  if (!id) fail("bad_request", "usage: cockpit session <id>");
  const data = await call(`/api/cockpit/session?id=${q(id)}`);
  out({ success: true, data, meta: { schema_version: data?.schema_version ?? 1 } });
} else if (cmd === "messages") {
  const id = rest[0];
  if (!id) fail("bad_request", "usage: cockpit messages <id> [--tail N]");
  const at = rest.indexOf("--tail");
  const tail = at >= 0 ? rest[at + 1] : undefined;
  const data = await call(`/api/cockpit/messages?id=${q(id)}${tail ? `&tail=${q(tail)}` : ""}`);
  out({ success: true, data, meta: { schema_version: data?.schema_version ?? 1, ...(data?.meta ?? {}) } });
} else if (cmd === "plan") {
  const id = rest[0];
  if (!id) fail("bad_request", "usage: cockpit plan <id>");
  const data = await call(`/api/cockpit/plan?id=${q(id)}`);
  out({ success: true, data, meta: { schema_version: data?.schema_version ?? 1 } });
} else if (cmd === "send") {
  const raw = (await readStdin()) || rest.join(" ");
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    fail("bad_request", "send reads one JSON object on stdin: {\"to\": \"<session id>\", \"message\": \"…\"}");
  }
  const to = String(payload?.to ?? "");
  const message = String(payload?.message ?? "");
  if (!to || !message) fail("bad_request", "both `to` and `message` are required");
  let res;
  try {
    res = await fetch(`${ENDPOINT}/api/cockpit/send`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentus-cockpit-token": TOKEN },
      body: JSON.stringify({ to, message }),
    });
  } catch (e) {
    fail("unreachable", `the cockpit did not answer: ${e?.message ?? e}`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const code = String(body?.error ?? `http_${res.status}`);
    // The refusal meanings a model must not blur (see `capabilities.discipline`): none of these is
    // "delivered", and target_busy specifically means the target saw NOTHING.
    fail(code, body?.error ?? `the cockpit answered HTTP ${res.status}`);
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
  fail("bad_request", `unknown command: ${cmd}`);
}