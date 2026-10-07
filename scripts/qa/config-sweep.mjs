// QA: the config surface is a REAL knob, and a pick the backend does not take must not look like
// success. Two operator reports drive this sweep (2026-10-06):
//   "那个上下文的设置能够实现一下吗" — the surface now carries context_budget next to thinking depth.
//   "四个强度…它实际支持哪几档，那我们就设置哪几档" — a level the backend folds away must be visible.
//
// What it proves, against a mock whose setter mirrors the real adapter (whole rebuilt option list,
// unsupported value -> OLD currentValue, no snap):
//   1. both typed options are advertised (reasoning_effort + context_budget);
//   2. a supported pick lands, comes back in the agent's own reply, and is NOT flagged;
//   3. an unsupported pick emits `config-rejected` carrying what the session really runs with;
//   4. the option list survives a set (a partial agent reply must not wipe the surface).
// Usage: node scripts/qa/config-sweep.mjs   (AGENTUS_BASE to point at another instance)
import WebSocket from "ws";
import { authHeaders, wsUrl } from "../lib/auth.mjs";

const BASE = process.env.AGENTUS_BASE || "http://127.0.0.1:8901";   // dev instance, never live
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const created = await fetch(`${BASE}/api/sessions`, {
  method: "POST",
  headers: { "content-type": "application/json", ...authHeaders() },
  body: JSON.stringify({ backend: "mock", cwd: process.cwd() }),
});
if (!created.ok) {
  console.error("create failed:", created.status, await created.text());
  process.exit(1);
}
const session = await created.json();
const id = session.id;

const ws = new WebSocket(wsUrl(BASE));
const events = [];
const rejected = [];
let current = null;
ws.on("message", (raw) => {
  const e = JSON.parse(String(raw));
  events.push(e);
  if (e.t === "config-rejected") rejected.push(e);
  if ((e.t === "session" || e.t === "sessions")) {
    const s = e.t === "session" ? e.session : (e.sessions || []).find((x) => x.id === id);
    if (s && s.id === id) current = s;
  }
});
await new Promise((r) => ws.on("open", r));

/** Poll the latest `session` event for this id instead of sleeping a fixed amount. */
async function until(pred, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}
const cfgOf = (sid) => (current && current.configOptions ? current.configOptions : []);
const valueOf = (cid) => cfgOf().find((o) => o.id === cid)?.currentValue;

await until(() => current !== null);
const before = cfgOf().map((o) => o.id);

// 1. both typed options reach the cockpit
check("advertises thinking depth", before.includes("reasoning_effort"), before.join(","));
check("advertises context budget", before.includes("context_budget"), before.join(","));
check("budget starts on the model window", valueOf("context_budget") === "auto", String(valueOf("context_budget")));

// 2. a supported pick lands and is not flagged
rejected.length = 0;
ws.send(JSON.stringify({ t: "set-config", sessionId: id, configId: "reasoning_effort", value: "high" }));
await until(() => valueOf("reasoning_effort") === "high");
check("supported pick lands", valueOf("reasoning_effort") === "high", String(valueOf("reasoning_effort")));
check("supported pick is not flagged", rejected.length === 0, JSON.stringify(rejected));

// 3. the budget is its own knob, not a display field
ws.send(JSON.stringify({ t: "set-config", sessionId: id, configId: "context_budget", value: "200000" }));
await until(() => valueOf("context_budget") === "200000");
check("budget pick lands", valueOf("context_budget") === "200000", String(valueOf("context_budget")));
check(
  "a set does not wipe the surface",
  cfgOf().map((o) => o.id).sort().join(",") === ["context_budget", "reasoning_effort"].sort().join(","),
  cfgOf().map((o) => o.id).join(","),
);

// 3b. a hand-typed window: the option says it is free-form, takes any count, and echoes the pick
//     back as an option (otherwise the returned list contradicts its own currentValue)
const budget = cfgOf().find((o) => o.id === "context_budget");
check("budget says it is free-form", budget?.meta?.freeform === true, JSON.stringify(budget?.meta ?? null));
check("budget carries a floor", typeof budget?.meta?.min === "number", String(budget?.meta?.min));
ws.send(JSON.stringify({ t: "set-config", sessionId: id, configId: "context_budget", value: "300000" }));
await until(() => valueOf("context_budget") === "300000");
check("hand-typed window lands", valueOf("context_budget") === "300000", String(valueOf("context_budget")));
const budgetOpts = (cfgOf().find((o) => o.id === "context_budget")?.options || []).map((o) => String(o.value));
check("the typed value is echoed as an option", budgetOpts.includes("300000"), budgetOpts.join(","));
check("presets survive the echo", budgetOpts.includes("262144") && budgetOpts.includes("auto"), budgetOpts.join(","));

// 3c. below the floor the backend refuses: the old window stays (and the pick is flagged)
rejected.length = 0;
ws.send(JSON.stringify({ t: "set-config", sessionId: id, configId: "context_budget", value: "4096" }));
await until(() => rejected.length > 0 || valueOf("context_budget") === "4096");
check("below-floor window is refused", valueOf("context_budget") === "300000", String(valueOf("context_budget")));

// 4. a pick the backend folds away is reported, not silently kept
rejected.length = 0;
ws.send(JSON.stringify({ t: "set-config", sessionId: id, configId: "reasoning_effort", value: "ultra" }));
await until(() => rejected.length > 0);
check("unsupported pick is flagged", rejected.length > 0);
check("flag names the real value", rejected[0]?.actual === "high", JSON.stringify(rejected[0] || null));
check("unsupported pick does not land", valueOf("reasoning_effort") === "high", String(valueOf("reasoning_effort")));

await fetch(`${BASE}/api/sessions/${id}`, { method: "DELETE", headers: authHeaders() }).catch(() => {});
ws.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
