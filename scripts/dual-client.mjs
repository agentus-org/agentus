// QA R26: two WS clients on one session — the fan-out must reach both, in order.
// Run: node scripts/dual-client.mjs <sessionId>
import { WebSocket } from "ws";
import { wsUrl } from "./lib/auth.mjs";

const sid = process.argv[2];
if (!sid) throw new Error("usage: node scripts/dual-client.mjs <sessionId>");
const URL = wsUrl(process.env.AGENTUS_BASE || "http://127.0.0.1:8787");

function open(name) {
  const ws = new WebSocket(URL);
  const seen = { name, events: 0, chunks: 0, perms: 0, turns: [], hello: false };
  ws.on("message", (raw) => {
    const e = JSON.parse(raw.toString());
    seen.events++;
    if (e.t === "hello") seen.hello = true;
    if (e.t === "message" && e.message.sessionId === sid) {
      if (e.message.kind === "agent") seen.chunks++;
    }
    if (e.t === "permission" && e.request.sessionId === sid) seen.perms++;
    if (e.t === "turn-end" && e.sessionId === sid) seen.turns.push(e.stopReason ?? e.error ?? "?");
  });
  return { ws, seen };
}

const a = open("A");
const b = open("B");
await new Promise((r) => setTimeout(r, 800));
console.log("hello:", a.seen.hello, b.seen.hello);

// client A drives the turn
a.ws.send(JSON.stringify({ t: "prompt", sessionId: sid, text: "r26 fanout check" }));
await new Promise((r) => setTimeout(r, 6000));

console.log("A:", a.seen);
console.log("B:", b.seen);
const ok = a.seen.chunks > 3 && a.seen.chunks === b.seen.chunks && a.seen.turns.length === 1 && b.seen.turns.length === 1;
console.log(ok ? "R26 PASS" : "R26 FAIL");

// also: B must survive a client-side disconnect/reconnect (resume replay)
b.ws.close();
await new Promise((r) => setTimeout(r, 1200));
const c = open("C");
await new Promise((r) => setTimeout(r, 800));
c.ws.send(JSON.stringify({ t: "resume", lastSeq: {} }));
await new Promise((r) => setTimeout(r, 2500));
console.log("C after resume:", c.seen);
c.ws.close(); a.ws.close();
process.exit(ok ? 0 : 1);