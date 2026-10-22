// QA for #47: the rail's three states are WIDE-screen only, and the compact ACTIVE row must
// actually wrap its avatar. Drives a HEADLESS Edge over raw CDP against the scratch instance on
// :8901, so it never touches the operator's own browser window.
//
//   CDP=http://127.0.0.1:9223 node scripts/qa/rail-breakpoints.mjs
//
// What it pins (issue #47's acceptance points):
//   1. wide screen + rail-mode=hidden  → the rail is really gone
//   2. folded/narrow width + the SAME stored mode → the drawer still opens (the deadlock)
//   3. narrow + stored compact → the drawer shows a REAL list (titles, full-width rows), not a
//      column of 40px squares  ← still broken after the first attempt at this fix
//   4. compact on a wide screen → the active row's box wraps its avatar, and nothing in the strip
//      bleeds over the transcript
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const CDP = process.env.CDP ?? "http://127.0.0.1:9223";
const BASE = process.env.BASE ?? "http://127.0.0.1:8901";
const U = process.env.QA_USER ?? "scratch", P = process.env.QA_PASS ?? "scratch-pass-1";
const SHOTS = process.env.SHOTS ?? path.join(process.cwd(), ".qa-shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

// ---- attach -------------------------------------------------------------------------------
// Reuse a listed page rather than the target /json/new hands back: a brand-new tab is not
// attachable straight away (Page.enable then never answers), while a listed page always is.
let pages = (await (await fetch(`${CDP}/json/list`)).json()).filter((x) => x.type === "page");
let created = false;
if (!pages.length) {
  await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" }).catch(() => {});
  await sleep(2500);
  pages = (await (await fetch(`${CDP}/json/list`)).json()).filter((x) => x.type === "page");
  created = true;
}
const t = pages.find((x) => x.url.includes("8901")) ?? pages[pages.length - 1];
if (!t) throw new Error("no page target to drive");

const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const w = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && w.has(m.id)) {
    const x = w.get(m.id); w.delete(m.id);
    m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result);
  }
};
const send = (method, params = {}, to = 25000) => new Promise((res, rej) => {
  const mid = ++id;
  const timer = setTimeout(() => { w.delete(mid); rej(new Error("TIMEOUT " + method)); }, to);
  w.set(mid, {
    res: (v) => { clearTimeout(timer); res(v); },
    rej: (e) => { clearTimeout(timer); rej(e); },
  });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + JSON.stringify(r.result?.value ?? ""));
  return r.result?.value;
};
const size = async (width, height = 800) => {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(320);
};
// A headless tab paints no frames, so a CSS transition freezes at its START value and the drawer
// looks closed forever. Freeze transitions into their END state instead: #47 asks whether the
// drawer is reachable, not what the animation curve looks like.
const freezeAnimations = () => ev(`(() => { if (document.getElementById('qa-no-anim')) return true;
  const st = document.createElement('style'); st.id = 'qa-no-anim';
  st.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}';
  document.head.appendChild(st); return true; })()`);
const shot = async (label) => {
  const cap = await send("Page.captureScreenshot", { format: "png" });
  mkdirSync(SHOTS, { recursive: true });
  const out = path.join(SHOTS, `rail-${label}-${Date.now()}.png`);
  writeFileSync(out, Buffer.from(cap.data, "base64"));
  console.log("SHOT", out);
};

await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});

try {
  // ---- login + fixtures -------------------------------------------------------------------
  await size(1200);
  await send("Page.navigate", { url: BASE });
  await sleep(2600);
  const code = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
  if (code !== 200) { console.error(`login failed (${code}) — nothing below would mean anything`); process.exit(1); }
  console.log("PASS  login accepted  — 200");

  // Fixtures: at least one row, and a KNOWN fold state so the empty-archive note really renders.
  const made = await ev(`Promise.all([0,1].map((i)=>fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({backend:'mock',cwd:i?'/tmp':'/Users/liang'})}).then(r=>r.ok)))`);
  check("fixture sessions created", Array.isArray(made) && made.every(Boolean), JSON.stringify(made));
  await ev(`localStorage.setItem('agentus.rail-mode','hidden');
    for (const k of Object.keys(localStorage)) if (/fold/i.test(k)) localStorage.removeItem(k);`);
  await send("Page.reload"); await sleep(2600);
  await freezeAnimations();
  await size(1200);

  // ---- 1. wide screen: hidden is a real state ---------------------------------------------
  const wide = await ev(`(() => { const s=document.querySelector('.sidebar');
    return { display: getComputedStyle(s).display, cls: s.className }; })()`);
  check("wide screen: rail-mode hidden really hides the rail", wide.display === "none", JSON.stringify(wide));

  // ---- 2. narrow: the SAME stored mode must not deadlock the drawer ------------------------
  await size(600);
  await send("Page.reload"); await sleep(2600);
  await freezeAnimations();
  const narrow = await ev(`(() => { const s=document.querySelector('.sidebar');
    return { display: getComputedStyle(s).display, cls: s.className }; })()`);
  check("phone width: the drawer still exists (display not none)", narrow.display !== "none", JSON.stringify(narrow));

  const clicked = await ev(`(() => { const b = document.querySelector('button.menu-btn'); if (!b) return false; b.click(); return true; })()`);
  check("phone width: the hamburger exists", clicked === true);
  let opened = null;
  for (let i = 0; i < 10; i++) {
    await sleep(250);
    opened = await ev(`(() => {
      const all = [...document.querySelectorAll('.sidebar')];
      const s = all.find(x => x.classList.contains('open')) ?? all[0];
      return { open: s.classList.contains('open'), display: getComputedStyle(s).display,
               left: Math.round(s.getBoundingClientRect().left), w: Math.round(s.getBoundingClientRect().width),
               scrim: !!document.querySelector('.scrim') };
    })()`);
    if (opened.left >= -1) break;
  }
  check("phone width: the hamburger opens the drawer",
    opened.open && opened.display !== "none" && opened.left >= -1, JSON.stringify(opened));

  // ---- 3. narrow + stored compact: a real list, not a column of squares --------------------
  await ev(`localStorage.setItem('agentus.rail-mode','compact')`);
  await send("Page.reload"); await sleep(2600);
  await freezeAnimations();
  await ev(`document.querySelector('button.menu-btn')?.click()`);
  await sleep(700);
  const shell = await ev(`(() => {
    const row = document.querySelector('.sidebar .session-item');
    if (!row) return { none: true };
    const r = row.getBoundingClientRect();
    const title = row.querySelector('.title');
    const railEl = document.querySelector('.sidebar');
    return { rowW: Math.round(r.width), railW: Math.round(railEl.getBoundingClientRect().width),
             titleShown: !!title && getComputedStyle(title).display !== 'none',
             titleLen: title ? title.textContent.trim().length : 0 };
  })()`);
  check("narrow + stored compact: rows are full-width again (not 40px squares)",
    !shell.none && shell.rowW >= 100, JSON.stringify(shell));
  check("narrow + stored compact: session titles are visible",
    !shell.none && shell.titleShown && shell.titleLen > 0, JSON.stringify(shell));

  // ---- 4. compact on a wide screen: the highlight wraps the avatar -------------------------
  await size(1200);
  await send("Page.reload"); await sleep(2600);
  await freezeAnimations();
  const compact = await ev(`(() => {
    const row = document.querySelector('.session-item.active');
    if (!row) return { none: true, active: false };
    const r = row.getBoundingClientRect();
    const av = row.querySelector('.be-avatar');
    const ar = av ? av.getBoundingClientRect() : null;
    return { active: true, w: Math.round(r.width), h: Math.round(r.height),
             avatar: ar ? { w: Math.round(ar.width), h: Math.round(ar.height),
                            inside: ar.left >= r.left - 0.5 && ar.right <= r.right + 0.5 } : null };
  })()`);
  check("compact: an active row exists (the checks below are about the ACTIVE row)",
    !compact.none && compact.active === true, JSON.stringify(compact));
  check("compact: the active row has a real box (>=28px wide)",
    !compact.none && compact.w >= 28, JSON.stringify(compact));
  check("compact: the box contains the avatar (measured via .be-avatar geometry)",
    !compact.none && !!compact.avatar && compact.avatar.inside === true, JSON.stringify(compact));

  // ---- 5. nothing in a 60px strip may bleed over the transcript ---------------------------
  const spill = await ev(`(() => {
    const railEl = document.querySelector('.sidebar');
    const rail = railEl.getBoundingClientRect();
    const leaks = [];
    for (const el of railEl.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (r.right > rail.right + 0.5 || r.left < rail.left - 0.5) {
        leaks.push({ cls: String(el.className || el.tagName).slice(0, 40), left: Math.round(r.left), right: Math.round(r.right) });
      }
    }
    return { railRight: Math.round(rail.right), leaks: leaks.slice(0, 5), count: leaks.length };
  })()`);
  check("compact: nothing inside the rail bleeds past the strip", spill.count === 0, JSON.stringify(spill));

  await shot("compact");
} finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (created) await fetch(`${CDP}/json/close/${t.id}`).catch(() => {});
  process.exit(fail ? 1 : 0);
}
