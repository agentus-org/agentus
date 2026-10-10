// The live stream, through the CLIENT's own code.
//
// The frames a real server sends are fed to the real cockpit store (`apply`, the same entry point the
// WebSocket calls), and the transcript it builds has to match the rows the store persisted. This is
// the check that catches a frame being dropped — a bug that shipped once: the store folds a message
// into ONE row, that row KEEPS ITS SEQ, so the client's "have I seen this seq?" guard swallowed every
// chunk after the first and a reply rendered as "不是" with an empty bubble after it.
//
// Run: npm run live-stream      (needs the cockpit on 127.0.0.1:8788, mock backend)
import WebSocket from "ws";
import { authHeaders, wsUrl } from "../lib/auth.mjs";

/** the machine token as plain headers (the .mjs helper's union type is not a `HeadersInit`) */
const auth = (): Record<string, string> => ({ ...authHeaders() }) as Record<string, string>;

// The store touches localStorage only to remember the active session; the browser APIs it does not need.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { cockpit } = await import("../../packages/web/src/state.ts");

const BASE = process.env.AGENTUS_BASE || "http://127.0.0.1:8788";
const PROMPT = process.argv[2] || "你好，介绍一下你自己";
const DEADLINE = 45_000;

let ok = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { ok += 1; console.log(`  ok   ${name}`); }
  else { failed += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const created = await fetch(`${BASE}/api/sessions`, {
  method: "POST",
  headers: { "content-type": "application/json", ...auth() },
  body: JSON.stringify({ backend: "mock", cwd: process.cwd() }),
});
if (!created.ok) {
  console.error("cannot create a session:", created.status, await created.text());
  console.error("hint: start the cockpit, or pass AGENTUS_BASE");
  process.exit(1);
}
const session = await created.json();

// the client's own view, driven exactly as the browser drives it
cockpit.apply({ t: "sessions", sessions: [session] } as never);
cockpit.setActive(session.id);

const text = (m: { payload?: unknown }): string => {
  const p = (m?.payload ?? {}) as { content?: { text?: unknown }; text?: unknown };
  const c = p.content?.text;
  if (typeof c === "string") return c;
  return typeof p.text === "string" ? p.text : "";
};
const keyOf = (m: { kind: string; payload?: unknown }): string | null => {
  const mid = (m.payload as { messageId?: unknown } | null)?.messageId;
  return typeof mid === "string" && mid ? `${m.kind}:${mid}` : null;
};

/** every frame of that session, as they arrived on the wire */
const frames: { kind: string; seq: number; key: string | null; text: string; delta?: string; n?: number }[] = [];
let signedOff = false;

const ws = new WebSocket(wsUrl(BASE));
ws.on("open", () => ws.send(JSON.stringify({ t: "prompt", sessionId: session.id, text: PROMPT })));
ws.on("message", (raw) => {
  const e = JSON.parse(String(raw));
  if (e.t === "permission") {
    ws.send(JSON.stringify({
      t: "respond-permission", sessionId: session.id, requestId: e.request.requestId,
      decision: { outcome: "selected", optionId: e.request.options[0].optionId },
    }));
  }
  if (e.t === "message" && (e.message.kind === "agent" || e.message.kind === "thought")) {
    frames.push({ kind: e.message.kind, seq: e.message.seq, key: keyOf(e.message), text: text(e.message), delta: e.delta, n: e.n });
  }
  cockpit.apply(e as never); // the REAL ingest path, guards and all
  if (e.t === "turn-end" || e.t === "error") signedOff = true;
});

const started = Date.now();
while (!signedOff && Date.now() - started < DEADLINE) await new Promise((r) => setTimeout(r, 200));
await new Promise((r) => setTimeout(r, 500)); // let a trailing frame land before comparing
ws.close();

// the stored rows are the truth the client must have reproduced
const { messages } = await fetch(`${BASE}/api/sessions/${session.id}/messages`, { headers: auth() })
  .then((r) => r.json() as Promise<{ messages: { seq: number; kind: string; payload: unknown }[] }>);
const view = cockpit.getSnapshot().active;
const blocks = (view?.msgs ?? []) as { kind: string; text: string }[];
const mine = blocks.filter((b) => b.kind === "agent" || b.kind === "thought");
const theirs = messages.filter((m) => m.kind === "agent" || m.kind === "thought");

check("the turn finished", signedOff, "no turn-end inside the deadline");
check("text frames arrived", frames.length > 0);
check("the client built a bubble for every stored text row", mine.length === theirs.length,
  `${mine.length} bubbles vs ${theirs.length} rows`);

const grew = frames.filter((f) => f.delta !== undefined);
check("frames that GREW a row were seen (the case the seq guard used to drop)", grew.length > 0,
  `${grew.length} of ${frames.length} frames carried a delta`);
check("every growing frame reported its block's total length (`n`)", grew.every((f) => typeof f.n === "number"),
  JSON.stringify(grew.filter((f) => typeof f.n !== "number").slice(0, 3)));
check("`n` is the accumulated length, not the chunk's",
  grew.every((f) => (f.n ?? 0) >= (f.delta?.length ?? 0)), "n smaller than the delta");
check("a growth frame ships ONLY the new part (a long reply is not re-sent on every token)",
  grew.every((f) => f.text === f.delta), JSON.stringify(grew.filter((f) => f.text !== f.delta).slice(0, 2)));

// 1:1 on text: the bubble that holds a stored row's key must hold exactly that row's text
let mismatch = 0;
let empty = 0;
for (const row of theirs) {
  const key = keyOf(row as { kind: string; payload?: unknown });
  const want = text(row);
  if (!want.trim()) continue;
  const got = key ? mine.find((b) => (b as { key?: string }).key === key) : undefined;
  if (!got) { mismatch += 1; console.error(`      no bubble for ${key ?? "(no id)"} seq=${row.seq}: ${JSON.stringify(want.slice(0, 40))}`); continue; }
  if (got.text !== want) { mismatch += 1; console.error(`      ${key} seq=${row.seq}\n        want ${JSON.stringify(want.slice(0, 60))}\n        got  ${JSON.stringify(got.text.slice(0, 60))}`); }
  if (!got.text.trim()) empty += 1;
}
check("every stored text row is rendered with EXACTLY its text (nothing dropped, nothing doubled)",
  mismatch === 0, `${mismatch} mismatched`);
check("no bubble rendered empty while its row has text", empty === 0, `${empty} empty`);

// the growth of ONE message must end up in ONE bubble: bubbles == distinct keys
const distinctKeys = new Set(theirs.map((r) => keyOf(r as { kind: string; payload?: unknown })).filter(Boolean));
const keyed = mine.filter((b) => (b as { key?: string }).key && !String((b as { key?: string }).key).startsWith("anon@"));
check("one message ⇒ one bubble (a reply is never split by the stream)", keyed.length === distinctKeys.size,
  `${keyed.length} keyed bubbles vs ${distinctKeys.size} message ids`);

await fetch(`${BASE}/api/sessions/${session.id}`, { method: "DELETE", headers: auth() }).catch(() => {});
console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${ok} ok, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
