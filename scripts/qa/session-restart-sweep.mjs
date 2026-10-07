// QA: 「重启 agent 进程」— a LIVE slot must be able to swap its agent process (same session, same
// picks, new pid) so a code change on disk — or a changed backend config — becomes real without
// archiving the slot first. Operator ask (2026-10-07): "你能加个按钮吗，支持重启 acp 进程，
// 这样点击某个会话重启就能用了吧".
//
// What it proves, against the mock agent (whose loadSession restores a session's OWN config, which
// is what a real Hermes does too):
//   1. POST /restart on a live slot answers 200 and keeps the slot id AND the ACP session id;
//   2. the pid is a NEW process (the old one is gone — the swap really happened);
//   3. the transcript survives the swap (history is not reset);
//   4. the operator's pick survives it too (thinking depth stays where they left it);
//   5. the new process really serves the slot: a prompt gets an answer, not a refusal;
//   6. a cold slot has no process to restart -> 404 pointing at /resume.
// Usage: AGENTUS_BASE=http://127.0.0.1:8901 node scripts/qa/session-restart-sweep.mjs
import WebSocket from "ws";
import { authHeaders, wsUrl } from "../lib/auth.mjs";

const BASE = process.env.AGENTUS_BASE || "http://127.0.0.1:8901";
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const api = (p, init = {}) =>
  fetch(`${BASE}${p}`, {
    ...init,
    headers: { "content-type": "application/json", ...authHeaders(), ...(init.headers || {}) },
  });

const created = await api("/api/sessions", {
  method: "POST",
  body: JSON.stringify({ backend: "mock", cwd: process.cwd() }),
});
if (!created.ok) {
  console.error("create failed:", created.status, await created.text());
  process.exit(1);
}
const session = await created.json();
const id = session.id;

// The slot's own state comes off the event stream: pid and configOptions are announced there.
const ws = new WebSocket(wsUrl(BASE));
let live = session;
let turns = 0;
// While a restart is in flight the slot must stay in the LIVE list: taking it out for the swap made
// the rail flash it into the archive.
let watchingSwap = false;
let vanishedMidSwap = false;
ws.on("message", (raw) => {
  const e = JSON.parse(String(raw));
  if (e.t === "session" && e.session?.id === id) live = { ...live, ...e.session };
  if (e.t === "sessions") {
    const s = (e.sessions || []).find((x) => x.id === id);
    if (s) live = { ...live, ...s };
    else if (watchingSwap) vanishedMidSwap = true;
  }
  if (e.t === "turn-end" && e.sessionId === id) turns++;
});
await new Promise((r) => ws.on("open", r));

/** Poll a predicate instead of sleeping a fixed amount. */
async function until(pred, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}
const messages = async () => ((await (await api(`/api/sessions/${id}/messages`)).json()).messages || []).length;
const effortOf = (s) => (s?.configOptions || []).find((o) => o.id === "reasoning_effort")?.currentValue;
const prompt = (text) => api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text }) });

// 1. the slot is live and carries a process + an ACP session
await until(() => live.pid);
const pidBefore = live.pid;
const acpBefore = live.acpSessionId;
check("slot is live with a process", Boolean(pidBefore), `pid=${pidBefore}`);
check("slot carries an ACP session id", Boolean(acpBefore), String(acpBefore));

// 2. a real turn, so there is a transcript worth keeping
await prompt("hello before the restart");
await until(() => turns >= 1, 30000);
const msgsBefore = await messages();
check("a turn landed as history", turns >= 1 && msgsBefore > 0, `turns=${turns} messages=${msgsBefore}`);

// 3. an operator pick, so the swap has something to carry over
ws.send(JSON.stringify({ t: "set-config", sessionId: id, configId: "reasoning_effort", value: "high" }));
await until(() => effortOf(live) === "high");
check("thinking depth pick lands before the restart", effortOf(live) === "high", String(effortOf(live)));

// 4. the restart — and the slot must never read as cold while it happens
watchingSwap = true;
const restarted = await api(`/api/sessions/${id}/restart`, { method: "POST" });
const fresh = restarted.ok ? await restarted.json() : null;
watchingSwap = false;
check("slot never reads as cold mid-swap", !vanishedMidSwap, vanishedMidSwap ? "it vanished from the live list during the swap" : "");
check("restart answers 200", restarted.ok, `${restarted.status} ${JSON.stringify(fresh ?? null).slice(0, 200)}`);
check("same slot id", fresh?.id === id, String(fresh?.id));
check("same ACP session (history is agent-side)", fresh?.acpSessionId === acpBefore, `${acpBefore} -> ${fresh?.acpSessionId}`);
check("a NEW pid really replaced the old one", Boolean(fresh?.pid) && fresh.pid !== pidBefore, `${pidBefore} -> ${fresh?.pid}`);
check("thinking depth survives the swap", effortOf(fresh) === "high", String(effortOf(fresh)));

// 5. the transcript is still there
const msgsAfter = await messages();
check("transcript survives the swap", msgsAfter >= msgsBefore, `${msgsBefore} -> ${msgsAfter}`);

// 6. the NEW process serves the slot (a dead handoff would answer `refusal` and look alive)
turns = 0;
await prompt("hello after the restart");
await until(() => turns >= 1, 30000);
check("the new process answers a prompt", turns >= 1, `turns=${turns}`);

// 7. a cold slot has no process to swap — that is /resume, and the route must say so
await api(`/api/sessions/${id}`, { method: "DELETE" });
await until(() => !live.pid, 15000);
const cold = await api(`/api/sessions/${id}/restart`, { method: "POST" });
check("cold slot -> 404 (no process to restart)", cold.status === 404, String(cold.status));

// cleanup: purge the row + transcript this sweep created
await api(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
ws.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);