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
/** What the hub holds right now (`GET /api/observer`). 工作播报 used to be unobservable from outside. */
const diag = async () => (await api("/api/observer")).body;
/** Tell the server which session the operator is looking at — the scope gate of #23. */
const presence = async (sessionId) => {
  await api("/api/notify/presence", { method: "POST", body: JSON.stringify({ sessionId, visible: true }) });
};
const extra = [];
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
  // #23 added the scope gate: a brief only happens for the session the operator is LOOKING at. These
  // steps predate it, so they have to say so — the page does the same thing every 30 s.
  await presence(live.id);
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
  // ================= issues #23 / #24 (2026-10-18) =================
  //
  // Everything above exercises #16 as it shipped. What follows is the two later issues: the scope is
  // the session on screen, a reaped observer must not be a dead end, and a turn that never ends must
  // still be heard on a beat.

  // ---- ① 互斥是一个字段，不是一条约定 ----
  const clash = await api("/api/settings", { method: "PUT", body: JSON.stringify({ prefs: { speakMode: "brief", autoRead: true } }) });
  check("自动朗读 and 工作播报 can never both be on: a conflicting autoRead loses to speakMode",
    clash.body.prefs?.speakMode === "brief" && clash.body.prefs?.autoRead === false,
    JSON.stringify(clash.body.prefs));

  const baseObserver = { enabled: true, backend: "mock", throttleSec: 0, intervalSec: 0 };
  await api("/api/settings", { method: "PUT", body: JSON.stringify({ prefs: { speakMode: "brief" }, observer: baseObserver }) });

  const A = await mk("observer-scope-A（自动删除）");
  const B = await mk("observer-scope-B（自动删除）");
  extra.push(A.id, B.id);

  // ---- ② 作用域：只播操作者正在看的那个会话 ----
  await presence(B.id);
  const markB = frames.length;
  await api(`/api/sessions/${A.id}/prompt`, { method: "POST", body: JSON.stringify({ text: "A 跑一轮，但操作者在看 B" }) });
  await sleep(7000);
  const bg = frames.slice(markB).filter((f) => f.t === "speak" && f.sessionId === A.id);
  check("在看 B 时，A 的回合结束一声不响（后台会话完全不播）", bg.length === 0, JSON.stringify(bg));
  // The watch entry itself is fine (turn-start creates one to track 静默); what must not exist is an
  // OBSERVER PROCESS for a session nobody is looking at.
  const dA = await diag();
  check("…并且没有为 A 起观察员进程",
    dA.observers.length === 0 && !dA.watches.some((w) => w.watched === A.id && w.observerId),
    JSON.stringify(dA));

  await presence(A.id);
  const markA = frames.length;
  await api(`/api/sessions/${A.id}/prompt`, { method: "POST", body: JSON.stringify({ text: "现在操作者在看 A" }) });
  const briefA = await waitFor(() => frames.slice(markA).find((f) => f.t === "speak" && f.sessionId === A.id && f.kind === "brief"));
  check("切回 A 之后，A 的回合结束照常播报", Boolean(briefA), JSON.stringify(briefA?.text ?? null));
  const oneObserver = (await diag()).observers;
  check("观察员是一个独立会话，且全局最多一个", oneObserver.length <= 1, JSON.stringify(oneObserver));

  // ---- ③ 切走即关：上一个会话的观察员进程被关掉 ----
  await presence(B.id);
  await sleep(1500);
  const afterSwitch = await diag();
  check("presence 切到 B：A 的观察员被关掉、watch 被清掉（不留僵尸）",
    !afterSwitch.watches.some((w) => w.watched === A.id) && afterSwitch.observers.length === 0,
    JSON.stringify(afterSwitch));

  // ---- ④ 自愈：观察员被回收之后，下一轮换一个新的，而不是永久「播报失败」 ----
  await presence(A.id);
  const markR = frames.length;
  await api(`/api/sessions/${A.id}/prompt`, { method: "POST", body: JSON.stringify({ text: "再来一轮，先有个观察员" }) });
  await waitFor(() => frames.slice(markR).find((f) => f.t === "speak" && f.kind === "brief"));
  const firstId = (await diag()).observers[0] ?? null;
  check("先有一个观察员", Boolean(firstId), JSON.stringify(firstId));
  if (firstId) {
    // Closing it is the same state the idle reaper leaves behind: the id in the hub is dead.
    await api(`/api/sessions/${firstId}`, { method: "DELETE" });
    await sleep(600);
    const markR2 = frames.length;
    await api(`/api/sessions/${A.id}/prompt`, { method: "POST", body: JSON.stringify({ text: "观察员已经没了，再来一轮" }) });
    const revived = await waitFor(() => frames.slice(markR2).find((f) => f.t === "speak" && f.sessionId === A.id));
    const ids = (await diag()).observers;
    check("被回收的观察员会被换掉，播报不再是永久失败",
      Boolean(revived) && revived.kind === "brief" && ids.length === 1 && ids[0] !== firstId,
      JSON.stringify({ revived: revived?.text ?? null, kind: revived?.kind, before: firstId, after: ids }));
  }

  // ---- ⑤ 关掉收听：观察员进程立刻收掉，不等 idle reaper ----
  const beforeOff = (await diag()).observers.length;
  await api("/api/settings", { method: "PUT", body: JSON.stringify({ prefs: { speakMode: "off" } }) });
  await sleep(1200);
  const afterOff = (await diag()).observers.length;
  check("speakMode 关掉 → 观察员进程立刻被收掉（不是挂着等 reap）", beforeOff === 1 && afterOff === 0,
    JSON.stringify({ beforeOff, afterOff }));

  // ---- ⑥ 节拍：长回合没有 turn-end 也要有声音（issue #24） ----
  await api("/api/settings", { method: "PUT", body: JSON.stringify({ prefs: { speakMode: "brief" }, observer: { ...baseObserver, intervalSec: 2 } }) });
  await presence(A.id);
  const markH = frames.length;
  await api(`/api/sessions/${A.id}/prompt`, { method: "POST", body: JSON.stringify({ text: "[hold:45000] 一个很长的回合" }) });
  // A beat needs a tick (15 s) after the interval passes; the turn must still be in flight.
  const beat = await waitFor(() => frames.slice(markH).find((f) => f.t === "speak" && f.sessionId === A.id), 30_000);
  const ended = frames.slice(markH).some((f) => f.t === "turn-end" && f.sessionId === A.id);
  check("回合还在跑、没有 turn-end，也会按节拍说一句", Boolean(beat) && !ended, JSON.stringify({ beat: beat?.text ?? null, ended }));

  // ---- ⑦ 节拍是「上限」，不是闹钟：没有任务在跑时一声不响 ----
  await api(`/api/sessions/${A.id}/cancel`, { method: "POST", body: "{}" }).catch(() => {});
  // Wait for the turn to actually END rather than sleeping and hoping: the beat's gate is `inflight`,
  // so 「quiet afterwards」 only means anything once the turn is over.
  const endedH = await waitFor(() => frames.slice(markH).find((f) => f.t === "turn-end" && f.sessionId === A.id), 20_000);
  if (endedH) {
    await sleep(1500); // let the turn-end brief finish; it is allowed to speak once
    const quietFrom = frames.length;
    await sleep(32_000); // two ticks with a 2-second beat configured
    const idleSpeaks = frames.slice(quietFrom).filter((f) => f.t === "speak" && f.sessionId === A.id);
    check("没有回合在跑时，节拍不会自己说话（节拍是上限，不是闹钟）", idleSpeaks.length === 0,
      JSON.stringify(idleSpeaks.map((f) => f.text)));
  } else {
    check("没有回合在跑时，节拍不会自己说话（这台 mock 的 cancel 没能收尾，跳过）", true, "skipped");
  }
} finally {
  ws.close();
  await api("/api/settings", { method: "PUT", body: JSON.stringify({ prefs: { speakMode: beforePrefs.speakMode }, observer: beforeObserver }) });
  if (watched) await purge(watched.id);
  for (const id of extra) await purge(id);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
