// Rail readability sweep (manual QA — needs a real browser, so it is not in CI).
//
// The operator's report, filed twice: 「左边那些字颜色不是很明显，不是很突出，看不太清」 under his blue
// accent. Two things had to change and this sweep measures BOTH off the rendered sidebar, because
// the previous attempt passed its own unit tests and still failed his eyes:
//   ① the accent-as-TEXT colour (`--accent-text`) was a pale blue-grey: readable by contrast, yet
//      indistinguishable from the neutral text, which in this palette is ALSO blue-grey. What a
//      reader needs is chroma — so the assertion is a saturation gap, not just a contrast ratio.
//   ② the secondary token (`--text-dim`) was 5.25:1 on the panel and 4.71:1 on a hovered row,
//      carrying the group labels, timestamps, counts and cold-session titles at 10–11px.
//
// What it does NOT trust: any colour a script tells it. Every number is computed here from the
// styles actually applied to elements the app rendered, and the surfaces are found by walking up
// for the first opaque background. It runs the operator's own blue AND the built-in amber, in both
// palettes, so a fix for the blue cannot quietly wreck the default.
//
// Usage: start Edge/Chrome with --remote-debugging-port=9222, then
//        PORT=8901 node scripts/qa/rail-contrast-sweep.mjs
import fs from "node:fs";

const CDP = "http://127.0.0.1:9222";
const PORT = Number(process.env.PORT || 8901);
const BASE = `http://127.0.0.1:${PORT}`;
const OPERATOR_BLUE = process.env.ACCENT || "#76bbdf";
// why the sweep does not trust a colour it is told: every number below is computed from the
// styles actually applied to elements the app rendered
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (ok, what, detail = "") => {
  if (ok) { pass += 1; console.log(`  ok   ${what}${detail ? `  — ${detail}` : ""}`); }
  else { fail += 1; console.log(`  FAIL ${what}${detail ? `  — ${detail}` : ""}`); }
};

/** Every text-bearing element in the sidebar: its own colour, the surface behind it, the ratio,
 *  and the HSV saturation of the colour. Mirrors (but does not import) theme.ts's maths on
 *  purpose: a bug in the module under test must not be able to write its own verdict. */
const AUDIT = `(() => {
  const px = (s) => { const m = String(s).match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
    const p = m[1].split(',').map(Number); return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 }; };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const hsvS = (c) => { const mx = Math.max(...c); return mx === 0 ? 0 : (mx - Math.min(...c)) / mx; };
  const surface = (el) => { let n = el, seen = null;
    while (n) { const bg = px(getComputedStyle(n).backgroundColor);
      if (bg && bg.a > 0.6) { seen = bg.rgb; break; } n = n.parentElement; }
    return seen || [10, 15, 20]; };
  const out = [];
  for (const el of document.querySelectorAll('.sidebar *')) {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!own) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.5) continue;
    const fg = px(cs.color);
    const r = el.getBoundingClientRect();
    if (!fg || r.width < 2 || r.height < 2) continue;
    const bg = surface(el);
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).join('.') : el.tagName.toLowerCase();
    out.push({ cls, text: (el.textContent || '').trim().slice(0, 22), color: cs.color,
      sat: Math.round(hsvS(fg.rgb) * 1000) / 1000, contrast: Math.round(ratio(fg.rgb, bg) * 100) / 100,
      bg: 'rgb(' + bg.join(',') + ')', size: cs.fontSize, weight: cs.fontWeight });
  }
  const tok = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  return { rows: out, accentText: tok('--accent-text'), textDim: tok('--text-dim'), text: tok('--text'),
    accent: tok('--accent'), mode: document.documentElement.dataset.theme };
})()`;

const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(2600);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const waiting = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result); } };
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

const U = process.env.DEV_USER || "scratch";
const P = process.env.DEV_PASS || "scratch-pass-1";
if (!(await ev(`fetch('/api/auth/me',{credentials:'same-origin'}).then(r=>r.json()).then(d=>d.authenticated)`))) {
  const code = await ev(`fetch('/api/auth/login',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
  if (code !== 200) { console.log("login failed"); process.exit(2); }
  await ev(`location.reload()`);
  await sleep(3200);
}
// one live session, so the rail renders a WARM row (a cold row's title is drawn in --text-dim by
// design, and auditing only that would measure the wrong thing)
let SID = "";
for (let i = 0; i < 10 && !SID; i++) {
  SID = await ev(`fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({backend:'mock',cwd:'/tmp'})}).then(r=>r.json()).then(d=>d.id||'')`);
  if (!SID) await sleep(700);
}
if (!SID) { console.log("could not create a session"); process.exit(2); }
await ev(`location.href = ${JSON.stringify(BASE + "/?session=")} + ${JSON.stringify(SID)}`);
await sleep(3000);

const setTheme = async (mode, accent) => {
  await ev(`fetch('/api/settings',{method:'PUT',credentials:'same-origin',headers:{'content-type':'application/json'},
    body: JSON.stringify({theme:{mode:${JSON.stringify(mode)}, accent:${JSON.stringify(accent)}}})}).then(r=>r.status)`);
  // a real reload, not `location.href = <the same url>`: assigning the identical URL is a no-op,
  // so the app never re-boots, never runs loadServerTheme(), and the audit silently measures the
  // PREVIOUS palette (measured: the light pass reported data-theme=dark).
  await ev(`location.reload()`);
  await sleep(2600);
  for (let i = 0; i < 20; i += 1) {
    const ready = await ev(`document.documentElement.dataset.theme === ${JSON.stringify(mode)}
      && Boolean(document.querySelector('.sidebar .session-item'))`);
    if (ready) break;
    await sleep(400);
  }
  return ev(AUDIT);
};

/** the colour of the first element matching a class fragment, from the audit rows */
const rowFor = (audit, frag) => audit.rows.find((r) => r.cls.includes(frag));

console.log(`== rail readability @ :${PORT} — operator accent ${OPERATOR_BLUE} ==`);
let darkBlueDim = "";
let darkBlueText = "";
for (const mode of ["dark", "light"]) {
  console.log(`-- ${mode}, operator blue --`);
  const audit = await setTheme(mode, OPERATOR_BLUE);
  if (mode === "dark") { darkBlueDim = audit.textDim; darkBlueText = audit.text; }
  check(audit.mode === mode, `${mode} palette is on screen`, `data-theme=${audit.mode}`);

  // ② every piece of text in the rail is readable against what is actually behind it
  const dimmest = [...audit.rows].sort((a, b) => a.contrast - b.contrast)[0];
  check(dimmest.contrast >= 4.5, `the dimmest text in the rail clears AA (4.5:1)`,
    `${dimmest.contrast}:1  ${dimmest.cls} ${JSON.stringify(dimmest.text)} ${dimmest.color} on ${dimmest.bg} @${dimmest.size}`);
  const below = audit.rows.filter((r) => r.contrast < 4.5);
  check(below.length === 0, "no rail text is under AA",
    below.slice(0, 4).map((r) => `${r.contrast}:1 ${r.cls}`).join(", ") || "none");

  // the secondary token really is the brighter one, and it carries the labels the operator named
  const secondary = audit.rows.filter((r) => r.cls.includes("rail-at") || r.cls.includes("meta") || r.cls.includes("tagline") || r.cls.includes("rail-group-count"));
  check(secondary.length >= 2, "the secondary labels are on screen to audit", `${secondary.length} of them`);
  check(secondary.every((r) => r.contrast >= 6.0), "the secondary labels (time / group / tagline) are readable",
    secondary.map((r) => `${r.contrast}:1`).join(" ") || "none");
  const warmth = rowFor(audit, "title");
  check(!warmth || warmth.contrast >= 7.0, "a session title reads as primary text",
    warmth ? `${warmth.contrast}:1 ${warmth.color}` : "no title row");
  // The DIRECTORY name is primary on purpose — the operator asked for it in as many words
  // 「工作空间的目录颜色应该和会话颜色一样比较亮」 — so it is judged with the titles, not as a secondary
  // label. (Judging it as secondary broke this file's own rule on a correct build: in the light theme
  // --text is #1c2735, whose HSV saturation is 0.47 only because it is near-black, which left no 0.4
  // saturation gap to the accent even though nothing had got greyer.)
  const dirRow = rowFor(audit, "rail-group-name");
  check(!dirRow || dirRow.contrast >= 7.0, "a directory name reads as primary text, like a session title",
    dirRow ? `${dirRow.contrast}:1 ${dirRow.color}` : "no group name row");

  // ① the accent-as-text is a COLOUR, not a brighter grey
  const accentEls = audit.rows.filter((r) => r.color.toLowerCase().replace(/\s/g, "") === hexToRgbCss(audit.accentText));
  check(accentEls.length >= 1, "accent-coloured labels are on screen", `${accentEls.length} (${audit.accentText})`);
  check(accentEls.every((r) => r.contrast >= 4.8), "every accent label clears the floor",
    accentEls.map((r) => `${r.contrast}:1`).join(" ") || "none");
  const accentSat = Math.max(0, ...accentEls.map((r) => r.sat));
  const dimSat = Math.max(...secondary.map((r) => r.sat));
  check(accentSat >= 0.6, "the accent label carries real chroma",
    `hsv-saturation ${accentSat} (${audit.accentText})`);
  check(accentSat - dimSat >= 0.4, "…and separates from the neutral text by saturation, not brightness",
    `${accentSat} vs ${dimSat} = ${(accentSat - dimSat).toFixed(2)}`);
}

console.log("-- dark, built-in amber (the default must not regress) --");
{
  const audit = await setTheme("dark", "#ffb454");
  const dimmest = [...audit.rows].sort((a, b) => a.contrast - b.contrast)[0];
  check(dimmest.contrast >= 4.5, "amber palette: dimmest rail text clears AA",
    `${dimmest.contrast}:1 ${dimmest.cls} ${dimmest.color} on ${dimmest.bg}`);
  // the NEUTRAL tokens are the palette's, not the accent's: swapping the accent must not move them
  // (compare against the blue run rather than a hardcoded hex — the hex is theme.css's to change)
  check(Boolean(darkBlueDim) && audit.textDim === darkBlueDim,
    "the palette's own --text-dim is unchanged by the accent", `${darkBlueDim || "?"} -> ${audit.textDim}`);
  check(Boolean(darkBlueText) && audit.text === darkBlueText, "…and so is --text", `${darkBlueText} -> ${audit.text}`);
}

// leave the operator's own theme exactly as it was found
await setTheme("dark", OPERATOR_BLUE);
console.log(`\n${pass} ok, ${fail} failed`);
await send("Target.closeTarget", { targetId: tab.id }).catch(() => {});
process.exit(fail ? 1 : 0);

function hexToRgbCss(hex) {
  const n = Number.parseInt(String(hex).replace("#", "").slice(0, 6), 16);
  return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`;
}
