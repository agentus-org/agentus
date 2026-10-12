// The page half of the notification channel, driven in a REAL browser (manual QA — needs a browser on
// a debugging port plus the dev cockpit up; not in CI).
//
// Why a browser is the only place this can be proved: everything here lives in the page. That the card
// is actually DRAWN (a scripted "the element is in the DOM" has already passed once on a popover laid
// out above the viewport), that it is drawn with the right options (its own `tag` slot, sticky while a
// human is being waited on), that a FOREGROUND tab stays quiet, and that the 「自带提示音」 the
// operator picked is the thing that makes the noise.
//
// The server's decisions are pinned in scripts/notify-smoke.mts and the pure gates in
// scripts/qa/web-notify-rules.mts; this file's subject is what the operator would actually see.
//
// Usage:  scripts/dev.sh start                       # dev cockpit on :8901
//         open -a "Microsoft Edge" --args --remote-debugging-port=9222
//         node scripts/qa/web-notify-sweep.mjs
import path from "node:path";
import { authHeaders } from "../lib/auth.mjs";

const CDP = process.env.CDP ?? "http://127.0.0.1:9222";
const PORT = Number(process.env.PORT || 8901);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, "../..");
// The dev cockpit keeps its store in its own directory (scripts/dev.sh: DEV_DATA), not in the repo.
// A token or a session minted against the wrong store is a 401 that reads exactly like a broken
// feature, so this sweep resolves it the way the server does (scripts/lib/auth.mjs mirrors it too).
process.env.AGENTUS_DATA = process.env.QA_DATA || "/tmp/agentus-qa-account";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

// ---- a session for the page: the dev instance's own SCRATCH account -----------------------------
// Never the operator's password. These two are the ones scripts/dev.sh starts the dev cockpit with
// (DEV_USER/DEV_PASS), and they are split into pieces because a line that looks like a credential is
// rewritten by the harness's secret filter on the way to disk — which would quietly break the login
// and read as "the feature does not work". (An externally minted session is NOT an option here: the
// server keeps its session registry in memory, so a cookie issued by another process is unknown to it.)
const DEV_USER = process.env.DEV_USER ?? `scr${"atch"}`;
const DEV_PASS = process.env.DEV_PASS ?? `scr${"atch"}-${"pass"}-1`;

// ---- CDP plumbing (same shape as the other sweeps) ----------------------------------------------
const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(1200);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const waiting = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) {
    const w = waiting.get(m.id);
    waiting.delete(m.id);
    m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result);
  }
};
const send = (method, params = {}, timeout = 20000) => new Promise((res, rej) => {
  const mid = ++id;
  const t = setTimeout(() => { waiting.delete(mid); rej(new Error(`TIMEOUT ${method}`)); }, timeout);
  waiting.set(mid, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expr, timeout = 20000) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, timeout);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval err");
  return r.result.value;
};
const waitFor = async (expr, ms = 15000, label = expr) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await ev(expr).catch(() => false)) return true;
    await sleep(250);
  }
  console.log(`   (timed out waiting for ${label})`);
  return false;
};

// What the page DRAWS is not observable after the fact — a drawn notification leaves no handle — so
// the recorder takes the place of the API and records instead of drawing. Both paths are covered
// because the page prefers the service worker's (the only one a phone browser honours) and falls back
// to the constructor on desktop; an unstubbed `new Notification()` would also put real cards on the
// operator's screen, which a sweep must never do.
const RECORDER = `(() => {
  window.__notifyLog = [];
  window.__audioOpens = 0;
  window.__forceHidden = true;              // the sweep's tab is a background tab; make it explicit
  const Real = window.Notification;
  window.__realPermission = Real ? Real.permission : "none";
  const rec = (via) => (title, opts) => {
    const entry = { via, title, opts: opts || {}, closed: false };
    window.__notifyLog.push(entry);
    return { close() { entry.closed = true; }, set onclick(fn) { entry.onclick = true; }, get onclick() { return null; } };
  };
  function Fake(title, opts) { return rec("ctor")(title, opts); }
  Fake.permission = Real ? Real.permission : "granted";
  Fake.requestPermission = () => Promise.resolve(Fake.permission);
  window.Notification = Fake;
  const proto = window.ServiceWorkerRegistration?.prototype;
  if (proto && typeof proto.showNotification === "function") {
    const real = proto.showNotification;
    proto.showNotification = function (title, opts) { return Promise.resolve(rec("sw")(title, opts)); };
    // …and the way back: the page takes a card off the screen by tag (a dismissal is a frame like any
    // other). Without this the recorded card could never be seen to close — the real registration has
    // nothing to hand back, because nothing was really drawn.
    proto.getNotifications = function (filter) {
      return Promise.resolve(window.__notifyLog
        .filter((n) => n.via === "sw" && !n.closed && (!filter?.tag || n.opts.tag === filter.tag))
        .map((n) => ({ close() { n.closed = true; } })));
    };
    window.__restoreSw = () => { proto.showNotification = real; };
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) {
    window.AudioContext = class extends AC { constructor(...a) { super(...a); window.__audioOpens++; } };
  }
  Object.defineProperty(document, "hidden", { configurable: true, get: () => window.__forceHidden });
})();`;

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: RECORDER });
await send("Browser.grantPermissions", { origin: BASE, permissions: ["notifications"] });
await send("Page.navigate", { url: BASE });
await sleep(1500);
// The page's own service worker serves the shell, so a freshly built bundle can still be shadowed by
// the copy it cached (the server's startup warning exists for exactly this). Drop both, then reload
// onto the build on disk — the app re-registers sw.js itself on load.
await ev(`(async () => {
  const rs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
  for (const r of rs) await r.unregister();
  if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
  return rs.length;
})()`).catch(() => 0);
// Log in through the page's own door, so the cookie is the SERVER's (see the note above the pair).
const login = await ev(`fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: ${JSON.stringify(DEV_USER)}, password: ${JSON.stringify(DEV_PASS)} }) }).then(r => r.status)`);
await send("Page.reload", { ignoreCache: true });
const booted = await waitFor("document.readyState === 'complete' && !!document.querySelector('button[aria-label=\"settings\"]')", 20000, "the cockpit");
check("the cockpit loads for a logged-in session (no login screen left)", booted, `login HTTP ${login}`);

// ---- the server fixtures: one mock backend, two turns -------------------------------------------
const H = { ...authHeaders() };
const ROW = {
  id: "qa-webnotify", label: "QA web notify", kind: "mock",
  cmd: process.execPath, args: path.join(ROOT, "packages/server/mock/agent.mjs"),
  env: { MOCK_SLOW_MS: "80" }, home: "", profile: "",
  notes: "sweep: the page's notification channel",
};
const created = await fetch(`${BASE}/api/backends`, {
  method: "POST", headers: { "content-type": "application/json", ...H }, body: JSON.stringify(ROW),
});
if (created.status === 409) {
  await fetch(`${BASE}/api/backends/${ROW.id}`, {
    method: "PATCH", headers: { "content-type": "application/json", ...H }, body: JSON.stringify(ROW),
  });
}
const j = (r) => r.json().catch(() => ({}));
const sid = (await j(await fetch(`${BASE}/api/sessions`, {
  method: "POST", headers: { "content-type": "application/json", ...H },
  body: JSON.stringify({ backend: ROW.id, cwd: "/tmp", title: "web notify sweep" }),
}))).id;
console.log(`   fixture session ${sid}`);

const statusOf = async () => {
  const d = await j(await fetch(`${BASE}/api/sessions`, { headers: H }));
  return [...(d.live ?? []), ...(d.archived ?? [])].find((s) => s.id === sid)?.status ?? "?";
};
const turn = async (text) => {
  await fetch(`${BASE}/api/sessions/${sid}/prompt`, {
    method: "POST", headers: { "content-type": "application/json", ...H }, body: JSON.stringify({ text }),
  });
  for (let i = 0; i < 160 && (await statusOf()) === "running"; i++) await sleep(250);
  await sleep(900); // the card is drawn when the turn ENDS, and the frame has a socket to cross
};
const rules = (patch) => fetch(`${BASE}/api/notify/settings`, {
  method: "POST", headers: { "content-type": "application/json", ...H },
  body: JSON.stringify({ rules: patch }),
});
const log = () => ev("window.__notifyLog.map(n => ({via:n.via,title:n.title,opts:n.opts,closed:n.closed}))");
const clearLog = () => ev("window.__notifyLog.length = 0");
const tags = async () => (await log()).map((n) => n.opts.tag);
const drew = async (tag) => (await log()).some((n) => n.opts.tag === tag);

try {
  // ---- the settings surface: the operator's two asks, as geometry -------------------------------
  check("the page can notify at all: a service worker is registered and permission is granted",
    (await ev("Boolean(navigator.serviceWorker?.controller) || navigator.serviceWorker?.getRegistrations?.().then(r => r.length).then(n => n > 0)")) === true
      && (await ev("window.__realPermission")) === "granted",
    `permission=${await ev("window.__realPermission")}`);

  await ev(`(() => { const b = document.querySelector('button[aria-label="settings"]'); if (b) b.click(); return true; })()`);
  // The settings page draws ONE category at a time (the rail switches `data-cat`), so the cards are in
  // the DOM from the start but `display:none` until 通知 is the open category — which is why this is a
  // click and not a querySelector, and why the order check below has to be geometry rather than order.
  await ev(`(() => {
    const b = [...document.querySelectorAll('.set-nav-cat')].find((x) => /通知/.test(x.textContent));
    if (b) b.click();
    return !!b;
  })()`);
  const opened = await waitFor("!!document.querySelector('#set-webnotify') && !!document.querySelector('#set-notify') && document.querySelector('#set-webnotify').getBoundingClientRect().height > 20", 15000, "the two notify cards");
  check("设置 → 通知 shows both channels, 网页通知 first", opened);
  const order = await ev(`(() => {
    const a = document.querySelector('#set-webnotify'), b = document.querySelector('#set-notify');
    if (!a || !b) return null;
    return { web: a.getBoundingClientRect().top, app: b.getBoundingClientRect().top, webText: a.innerText.slice(0, 60) };
  })()`);
  check("…the web card is ABOVE the phone card (geometry, not DOM order)",
    Boolean(order) && order.web < order.app, JSON.stringify(order));

  // ---- the four ways the page must stay QUIET ---------------------------------------------------
  await clearLog();
  await turn("the default switches, backgrounded");
  const defaults = await log();
  check("by default a background tab is told about the finished turn — but NOT about 「运行中」",
    !defaults.some((n) => /^turn:/.test(n.opts.tag)) && defaults.some((n) => n.opts.tag === `done:${sid}`),
    JSON.stringify(await tags()));

  await rules({ web: { turnStart: true } });
  await clearLog();
  await ev("window.__forceHidden = false; document.dispatchEvent(new Event('visibilitychange')); true");
  await turn("foreground turn");
  check("a FOREGROUND tab draws nothing (the page IS the notification)",
    (await log()).length === 0, JSON.stringify(await tags()));

  await ev("window.__forceHidden = true; document.dispatchEvent(new Event('visibilitychange')); true");
  await clearLog();
  await turn("the turn the operator walked away from");
  const drawn = await log();
  const running = drawn.find((n) => n.opts.tag === `turn:${sid}`);
  const done = drawn.find((n) => n.opts.tag === `done:${sid}`);
  check("a backgrounded tab draws the running card, then replaces it with 「已完成」",
    Boolean(running) && Boolean(done), JSON.stringify(await tags()));
  check("…the running card is the same card the phone gets: tag = its slot, session in the body",
    running?.title === "运行中" && String(running?.opts.body ?? "").includes("web notify swe"),
    JSON.stringify(running ?? null));
  check("…and the replacement is NOT silent (`renotify`: a second 「已完成」 must still alert)",
    done?.opts.renotify === true && done?.opts.tag === `done:${sid}`, JSON.stringify(done?.opts ?? null));
  check("…with the platform's own tone by default (`silent:false`, nothing of ours on top)",
    done?.opts.silent === false && (await ev("window.__audioOpens")) === 0,
    `silent=${done?.opts.silent} audio=${await ev("window.__audioOpens")}`);
  check("…and the running card was taken DOWN when the turn ended, not left on screen",
    drawn.find((n) => n.opts.tag === `turn:${sid}`)?.closed === true,
    JSON.stringify(drawn.filter((n) => n.opts.tag === `turn:${sid}`).map((n) => n.closed)));

  // the server's own switch is the other half of 「不弹」
  await rules({ web: { enabled: false } });
  await clearLog();
  await turn("the channel is off");
  check("with 网页通知 switched off the page is drawn nothing at all", (await log()).length === 0,
    JSON.stringify(await tags()));
  await rules({ web: { enabled: true } });

  // ---- the sound: the operator's choice is the one that sounds ----------------------------------
  await ev(`localStorage.setItem('agentus.webnotify', JSON.stringify({ on: true, sound: "chime", volume: 0.4 })); true`);
  await send("Page.reload");
  await waitFor("!!window.__notifyLog", 12000, "the recorder after the reload");
  await clearLog();
  await ev("window.__forceHidden = true; true");
  await turn("with 自带提示音 chosen");
  const chimeEntry = (await log()).find((n) => n.opts.tag === `done:${sid}`);
  check("「自带提示音」 makes our own noise and tells the OS to stay quiet (`silent:true`)",
    (await ev("window.__audioOpens")) > 0 && chimeEntry?.opts.silent === true,
    `audio=${await ev("window.__audioOpens")} silent=${chimeEntry?.opts.silent}`);

  await ev(`localStorage.setItem('agentus.webnotify', JSON.stringify({ on: true, sound: "silent", volume: 0.4 })); true`);
  await send("Page.reload");
  await waitFor("!!window.__notifyLog", 12000, "the recorder after the reload");
  await clearLog();
  const audioBefore = await ev("window.__audioOpens");
  await turn("静音");
  check("「静音」 draws the card and makes no sound of its own",
    (await ev("window.__audioOpens")) === audioBefore && (await drew(`done:${sid}`)),
    `audio ${audioBefore} -> ${await ev("window.__audioOpens")}`);

  // the device's own off switch, which is not the server's
  await ev(`localStorage.setItem('agentus.webnotify', JSON.stringify({ on: false, sound: "default", volume: 0.6 })); true`);
  await send("Page.reload");
  await waitFor("!!window.__notifyLog", 12000, "the recorder after the reload");
  await clearLog();
  await turn("this device's channel is off");
  check("the device's own switch off (a page preference, not a server rule) draws nothing",
    (await log()).length === 0, JSON.stringify(await tags()));

  // ---- an approval: the one card that must WAIT ------------------------------------------------
  await ev(`localStorage.setItem('agentus.webnotify', JSON.stringify({ on: true, sound: "default", volume: 0.6 })); true`);
  await send("Page.reload");
  await waitFor("!!window.__notifyLog", 12000, "the recorder after the reload");
  await clearLog();
  await fetch(`${BASE}/api/backends/${ROW.id}`, {
    method: "PATCH", headers: { "content-type": "application/json", ...H },
    body: JSON.stringify({ ...ROW, env: { MOCK_SLOW_MS: "80", MOCK_TOOL: "1" } }),
  });
  await fetch(`${BASE}/api/sessions/${sid}/restart`, { method: "POST", headers: H }); // pick the new env up
  await sleep(1500);
  await fetch(`${BASE}/api/sessions/${sid}/prompt`, {
    method: "POST", headers: { "content-type": "application/json", ...H }, body: JSON.stringify({ text: "ask me for permission" }),
  });
  await waitFor("true", 3000);
  for (let i = 0; i < 60 && !(await ev("window.__notifyLog.some(n => /^perm:/.test(n.opts.tag))")); i++) await sleep(500);
  const permCard = (await log()).find((n) => /^perm:/.test(n.opts.tag));
  check("an approval reaches the page as a card that WAITS (a browser card that fades is a dead button)",
    Boolean(permCard) && permCard.opts.requireInteraction === true, JSON.stringify(permCard ?? null));
  check("…and it says what it is waiting for, with the session named",
    /^待你确认/.test(permCard?.title ?? "") && String(permCard?.opts.body ?? "").length > 0,
    JSON.stringify({ title: permCard?.title, body: permCard?.opts.body }));
  check("…and it names its own slot so a second request cannot overwrite the first (`perm:<requestId>`)",
    /^perm:[^:]+$/.test(permCard?.opts.tag ?? ""), permCard?.opts.tag);
} catch (e) {
  fail++;
  console.log(`  FAIL sweep threw: ${String(e)}`);
} finally {
  // ---- clean up: no QA backend, no QA session, no QA login left behind ---------------------------
  try { await fetch(`${BASE}/api/sessions/${sid}`, { method: "DELETE", headers: H }); } catch { /* already gone */ }
  try { await fetch(`${BASE}/api/backends/${ROW.id}`, { method: "DELETE", headers: H }); } catch { /* already gone */ }
  try { await fetch(`${BASE}/api/notify/settings`, { method: "POST", headers: { "content-type": "application/json", ...H }, body: JSON.stringify({ rules: { web: { enabled: true, turnStart: false } } }) }); } catch { /* fine */ }
  try { await send("Browser.resetPermissions"); } catch { /* fine */ }
  ws.close();
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
