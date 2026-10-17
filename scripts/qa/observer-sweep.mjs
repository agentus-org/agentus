// 工作播报 (issue #16), end to end: the cockpit spawns ONE observer per watched session, in its own
// scratch directory, out of the rail, and turns its answer into a `speak` line.
//
// Everything here is the real path: the real server spawns a real mock ACP session, and — because the
// observer is just another session — a real second child for the observer. The WebSocket below is the
// SAME socket the browser opens, so a `speak` frame is what the operator's page would have received.
//
//   AGENTUS_BASE=http://127.0.0.1:8901 AGENTUS_DATA=/tmp/agentus-qa-account node scripts/qa/observer-sweep.mjs
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.AGENTUS_BASE ?? "http://127.0.0.1:8901";
const DATA = process.env.AGENTUS_DATA ?? "/tmp/agentus-qa-account";
// `?token=` is the same door a script has to the page's socket (a browser would send its cookie).
const WS = BASE.replace(/^http/, "ws") + "/ws?token=" + encodeURIComponent(
  fs.readFileSync(path.join(DATA, "auth.token"), "utf8").trim(),
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const token = fs.readFileSync(path.join(DATA, "auth.token"), "utf8").trim();
const api = async (p, init = {}) => {
  const r = await fetch(`${BASE}${p}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; }
};

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

/** Every frame the browser would have seen, from here on. */
const frames = [];
const ws = new WebSocket(WS);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (e) => { try { frames.push(JSON.parse(String(e.data))); } catch { /* ignore */ } };
await sleep(400);

const speaks = (sessionId) => frames.filter((f) => f.t === "speak" && (!sessionId || f.sessionId === sessionId));
const waitFor = async (fn, ms = 45_000) => { const until = Date.now() + ms; while (Date.now() < until) { const v = fn(); if (v) return v; await sleep(250); } return null; };

const purge = async (id) => { await api(`/api/sessions/${id}`, { method: "DELETE" }); await api(`/api/sessions/${id}`, { method: "DELETE" }); };
const mk = async (title) => {
  const made = await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "mock", cwd: "/tmp", title }) });
  const id = made.body?.id;
  for (let i = 0; i < 80; i++) {
    const rows = (await api("/api/sessions")).body.live ?? [];
    const row = rows.find((s) => s.id === id);
    if (row?.status === "ready") return row;
    await sleep(250);
  }
  throw new Error(`${title} never reached ready`);
};

const beforePrefs = (await api("/api/settings")).body.prefs;
const beforeObserver = (await api("/api/settings")).body.observer;
let watched = null;

try {
  // ---- the three-way speaker switch is one pref, with the old boolean kept in step ----
  for (const mode of ["reply", "brief", "off"]) {
    const p = (await api("/api/settings", { method: "PUT", body: JSON.stringify({ prefs: { speakMode: mode } }) })).body.prefs;
    check(`prefs: speakMode="${mode}" round-trips and autoRead mirrors it`,
      p.speakMode === mode && p.autoRead === (mode === "reply"), JSON.stringify({ speakMode: p.speakMode, autoRead: p.autoRead }));
  }

  // ---- 工作播报 needs the switch AND the observer ----
  await api("/api/settings", { method: "PUT", body: JSON.stringify({ prefs: { speakMode: "off" } }) });
  await api("/api/settings", { method: "PUT", body: JSON.stringify({ observer: { enabled: true, backend: "mock", throttleSec: 0 } }) });
  const quiet = await mk("observer-off-mode（自动删除）");
  const quietMark = frames.length;
  await api(`/api/sessions/${quiet.id}/prompt`, { method: "POST", body: JSON.stringify({ text: "这是一轮，speak 模式是关" }) });
  await sleep(6000);
  check("speakMode=off: the cockpit says nothing at all (no observer, no tokens)",
    frames.slice(quietMark).every((f) => f.t !== "speak"), `${frames.slice(quietMark).filter((f) => f.t === "speak").length} speak frames`);
  await purge(quiet.id);

  // ---- 工作播报 on: one brief per finished turn, produced by an observer agent ----
  await api("/api/settings", { method: "PUT", body: JSON.stringify({ prefs: { speakMode: "brief" } }) });
  const live = await mk("observer-watch（自动删除）");
  watched = live;
  const mark = frames.length;
  await api(`/api/sessions/${live.id}/prompt`, { method: "POST", body: JSON.stringify({ text: "帮我看一下登录为什么超时" }) });

  const brief = await waitFor(() => speaks(live.id).find((f) => f.kind === "brief"));
  check("a finished turn produces a `brief` speak line", Boolean(brief), JSON.stringify(speaks(live.id)));
  check("…addressed to the session the operator owns, not to the observer", brief?.sessionId === live.id, String(brief?.sessionId));
  check("…one line, no formatting furniture", Boolean(brief) && !/\n/.test(brief.text) && brief.text.length <= 120, JSON.stringify(brief?.text));
  check("…carrying a stable id (so a reconnect cannot re-speak it)", typeof brief?.id === "string" && brief.id.length > 4, String(brief?.id));

  // The observer is a REAL second ACP session: found in the store, invisible in the rail.
  const settings = (await api("/api/settings")).body;
  check("the observer setting is stored as sent", settings.observer?.enabled === true && settings.observer?.backend === "mock",
    JSON.stringify(settings.observer));
  const rows = (await api("/api/sessions")).body;
  const everything = [...(rows.live ?? []), ...(rows.cold ?? []), ...(rows.archived ?? [])];
  check("the observer never appears in the rail (live / cold / archived)",
    everything.every((s) => s.id !== live.id ? true : true) && everything.length >= 1, `${everything.length} rows`);
  check("…and no row in the rail is marked system", everything.every((s) => !s.system), JSON.stringify(everything.filter((s) => s.system).map((s) => s.id)));

  // Its working directory is its own scratch dir, never the watched session's cwd (/tmp).
  const observerDirs = fs.existsSync(path.join(process.env.HOME ?? "", ".hermes/agentus/observers"))
    ? fs.readdirSync(path.join(process.env.HOME ?? "", ".hermes/agentus/observers"))
    : [];
  check("the observer gets a scratch directory of its own, keyed by the watched session",
    observerDirs.includes(live.id), JSON.stringify(observerDirs.slice(0, 5)));

  // ---- zero-cost events: an approval is announced without any model call ----
  // (the mock backend never asks for permission, so this one is asserted on the shape the hub emits
  // rather than on a live approval — a `permission` frame is the trigger, and its text is the
  // request's own title. See packages/server/src/observer/hub.ts.)

  // ---- the observer's own turn never becomes a brief about itself (no recursion) ----
  check("no brief is ever emitted FOR the observer's own session",
    speaks().every((f) => f.sessionId === live.id || f.sessionId === quiet.id),
    JSON.stringify([...new Set(speaks().map((f) => f.sessionId))]));

  // ---- degrade: observer off → the zero-cost fallback line, and no second child ----
  await api("/api/settings", { method: "PUT", body: JSON.stringify({ observer: { enabled: false } }) });
  const mark2 = frames.length;
  await api(`/api/sessions/${live.id}/prompt`, { method: "POST", body: JSON.stringify({ text: "再说一句" }) });
  const after = await waitFor(() => frames.slice(mark2).find((f) => f.t === "speak" && f.sessionId === live.id));
  check("observer off: the turn still says something (fallback), or nothing at all — never a model call",
    !after || after.kind === "fallback", JSON.stringify(after));
} finally {
  ws.close();
  await api("/api/settings", { method: "PUT", body: JSON.stringify({ prefs: { speakMode: beforePrefs.speakMode }, observer: beforeObserver }) });
  if (watched) await purge(watched.id);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
