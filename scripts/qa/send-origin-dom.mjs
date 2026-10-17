// The cross-session message's provenance, in the DOM (not just in the view model).
//
// `message-origin.mts` proves the reducer builds `from`; this proves the PAGE tells the truth with it:
// a message another session sent must NOT be labelled «YOU» — that label is the operator's own voice,
// and a cockpit that borrows it for another agent's words is lying quietly. The bubble must say
// 来自「<that session's name>», carry the from-agent class, and name the source id in its tooltip.
//
//   AGENTUS_BASE=http://127.0.0.1:8901 AGENTUS_DATA=/tmp/agentus-qa-account node scripts/qa/send-origin-dom.mjs
//        (needs a browser with --remote-debugging-port=9222)
//
// What it does, in order: two mock sessions on the real server → `send` from one to the other through
// the real CLI (so the origin stamp comes from the real path, not from the test) → open the TARGET in
// a page and read the bubble. Then it restores 驾驶舱互发消息 to whatever it was and deletes both rows.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";
const BASE = process.env.AGENTUS_BASE || "http://127.0.0.1:8901";
const DATA = process.env.AGENTUS_DATA || "/tmp/agentus-qa-account";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const BIN = path.join(REPO, "bin/agentus.mjs");
const U = process.env.AGENTUS_USERNAME || "scratch";
const P = process.env.AGENTUS_PASSWORD || "scratch-pass-1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const token = fs.readFileSync(path.join(DATA, "auth.token"), "utf8").trim();
const api = async (p, init = {}) => {
  const r = await fetch(`${BASE}${p}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const identityOf = (pid) => {
  const env = execFileSync("ps", ["eww", "-p", String(pid)], { encoding: "utf8" });
  const found = {};
  for (const kv of env.split(/\s+/)) {
    const at = kv.indexOf("=");
    if (at > 0 && kv.startsWith("AGENTUS_COCKPIT_")) found[kv.slice(0, at)] = kv.slice(at + 1);
  }
  return found;
};

const mkSession = async (title) => {
  const made = await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "mock", cwd: "/tmp", title }) });
  const id = made.body?.id;
  if (!id) throw new Error(`could not create ${title}: ${JSON.stringify(made.body)}`);
  for (let i = 0; i < 60; i++) {
    const row = ((await api("/api/sessions")).body.live ?? []).find((s) => s.id === id);
    if (row?.status === "ready" && row.pid) return row;
    await sleep(300);
  }
  throw new Error(`${title} never reached ready`);
};
const purge = async (id) => {
  await api(`/api/sessions/${id}`, { method: "DELETE" });
  await api(`/api/sessions/${id}`, { method: "DELETE" });
};

// ---- setup ---------------------------------------------------------------------------
const before = (await api("/api/settings")).body.agent?.cockpitSend ?? false;
const src = await mkSession("来源甲（自动删除）");
const dst = await mkSession("来源乙（自动删除）");
const env = identityOf(src.pid);
const SID = env.AGENTUS_COCKPIT_SESSION;
await api("/api/settings", { method: "PUT", body: JSON.stringify({ agent: { cockpitSend: true } }) });
console.log(`      src=${SID} dst=${dst.id} send was ${before ? "ON" : "OFF"}`);

const SENT = "这条是另一个会话发来的（自动删除）";
try {
  // ---- the send itself goes through the CLI an agent would use ------------------------
  let sent;
  try {
    const out = execFileSync(process.execPath, [BIN, "session", "send", dst.id, SENT], {
      cwd: REPO, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    sent = JSON.parse(out);
  } catch (e) {
    sent = { success: false, error: { code: "threw", message: `${e?.stdout ?? ""}${e?.stderr ?? ""}` } };
  }
  check("the CLI delivered into the target", sent?.success === true, JSON.stringify(sent?.error ?? sent?.data ?? null));

  // ---- the page ----------------------------------------------------------------------
  const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
  await sleep(2500);
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) {
      const w = waiting.get(m.id); waiting.delete(m.id);
      m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result);
    }
  };
  const send = (method, params = {}, timeout = 20000) => new Promise((res, rej) => {
    const mid = ++id; const t = setTimeout(() => { waiting.delete(mid); rej(new Error("TIMEOUT " + method)); }, timeout);
    waiting.set(mid, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const ev = async (expr, timeout = 20000) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, timeout);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval err");
    return r.result.value;
  };
  const until = async (expr, ms = 20000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (await ev(expr)) return true; await sleep(300); }
    return false;
  };
  const closeTab = () => { try { send("Target.closeTarget", { targetId: tab.id }); } catch { /* gone */ } };
  process.on("exit", closeTab);

  send("Page.enable");
  send("Runtime.enable");
  send("Page.navigate", { url: BASE });
  await until(`document.readyState === 'complete'`, 20000);
  await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then((r)=>r.status)`);
  await ev(`location.reload()`);
  await until(`document.readyState === 'complete'`, 20000);
  check("the rail rendered", await until(`document.querySelectorAll('.sidebar .session-item').length > 0`, 30000));

  // Open the TARGET by clicking its row: the page's own navigation, not a hand-built URL.
  const opened = await ev(`(() => {
    const el = document.querySelector('.session-item[data-session=' + ${JSON.stringify(JSON.stringify(dst.id))} + ']');
    if (!el) return false;
    el.click();
    return true;
  })()`);
  check("the target session opened from the rail", opened === true);
  await until(`document.querySelector('.msg.user') !== null`, 25000);
  await sleep(700);

  // Every user bubble in this view: is it ours, and what does it claim?
  const bubbles = await ev(`[...document.querySelectorAll('.msg.user')].map((el) => ({
    role: el.querySelector('.role')?.textContent ?? "",
    tip: el.querySelector('.role')?.getAttribute('title') ?? "",
    fromAgent: el.classList.contains('from-agent'),
    text: el.querySelector('.bubble')?.textContent ?? "",
  }))`);
  const bubble = (bubbles ?? []).find((b) => b.text.includes("这条是另一个会话发来的"));
  check("the message the other session sent is on the page", Boolean(bubble), JSON.stringify((bubbles ?? []).map((b) => b.role)));
  check("…it is NOT labelled YOU (that label is the operator's voice alone)", bubble?.role !== "YOU", bubble?.role ?? "(missing)");
  check("…it says 来自「来源甲（自动删除）」", bubble?.role === `来自「${src.title}」`, bubble?.role ?? "(missing)");
  check("…it carries the from-agent class (so the bubble paints differently)", bubble?.fromAgent === true);
  check("…and its tooltip names the source session id", bubble?.tip === `会话 ${SID}`, `${bubble?.tip ?? "(none)"} vs 会话 ${SID}`);
  check("…while our own operator message, if any, keeps its YOU label",
    (bubbles ?? []).every((b) => b.fromAgent || b.role === "YOU"), JSON.stringify((bubbles ?? []).map((b) => [b.role, b.fromAgent])));
} finally {
  // ---- restore ----------------------------------------------------------------------
  await api("/api/settings", { method: "PUT", body: JSON.stringify({ agent: { cockpitSend: before } }) });
  await purge(dst.id);
  await purge(src.id);
  const after = (await api("/api/settings")).body.agent?.cockpitSend;
  check("驾驶舱互发消息 was restored", after === before, `${String(after)} (was ${String(before)})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
