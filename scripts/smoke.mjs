// End-to-end smoke: REST create session (mock backend) + WS event capture.
// Usage: node scripts/smoke.mjs [backend] [promptText]
// Needs a credential since the API is closed: the machine token (scripts/lib/auth.mjs).
import WebSocket from "ws";
import { authHeaders, wsUrl } from "./lib/auth.mjs";

const BASE = process.env.AGENTSLOT_BASE || "http://127.0.0.1:8787";
const backend = process.argv[2] || "mock";
const promptText = process.argv[3] || "hello agentslot";

const res = await fetch(`${BASE}/api/sessions`, {
  method: "POST",
  headers: { "content-type": "application/json", ...authHeaders() },
  body: JSON.stringify({ backend, cwd: process.cwd() }),
});
if (!res.ok) {
  console.error("create failed:", res.status, await res.text());
  console.error(res.status === 401 ? "hint: scripts use the machine token — see scripts/lib/auth.mjs" : "");
  process.exit(1);
}
const session = await res.json();
console.log("session:", JSON.stringify(session));

const ws = new WebSocket(wsUrl(BASE));
const events = [];
let chunks = 0;
ws.on("open", async () => {
  ws.send(JSON.stringify({ t: "prompt", sessionId: session.id, text: promptText }));
});
ws.on("message", async (raw) => {
  const e = JSON.parse(String(raw));
  events.push(e.t + (e.message ? `:${e.message.kind}` : ""));
  if (e.t === "message" && e.message?.kind === "agent") chunks++;
  if (e.t === "permission") {
    console.log("PERMISSION:", JSON.stringify(e.request));
    // auto-allow the first option
    ws.send(JSON.stringify({
      t: "respond-permission", sessionId: session.id,
      requestId: e.request.requestId,
      decision: { outcome: "selected", optionId: e.request.options[0].optionId },
    }));
  }
  if (e.t === "turn-end") {
    console.log("turn-end:", e.stopReason ?? e.error ?? "");
    console.log("agent chunks seen:", chunks, "| total events:", events.length);
    const evs = [...new Set(events)].sort().join(", ");
    console.log("event kinds:", evs);
    // verify persistence
    const msgs = await fetch(`${BASE}/api/sessions/${session.id}/messages`, { headers: authHeaders() }).then((r) => r.json());
    console.log("stored messages:", msgs.messages.length, "| first seq:", msgs.messages[0]?.seq);
    console.log(chunks > 0 && msgs.messages.length > 0 ? "SMOKE PASS" : "SMOKE FAIL");
    // cleanup
    fetch(`${BASE}/api/sessions/${session.id}`, { method: "DELETE", headers: authHeaders() }).catch(() => {});
    ws.close();
    process.exit(chunks > 0 && msgs.messages.length > 0 ? 0 : 2);
  }
  if (e.t === "error") console.log("WS ERROR:", e.error);
});
ws.on("error", (e) => { console.error("ws fail", e.message ?? e); process.exit(1); });
setTimeout(() => { console.error("TIMEOUT waiting for turn-end"); process.exit(3); }, 30000);
