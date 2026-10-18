// QA: the turn line must stay ONE line at every width, with a LONG agent status.
//
// The operator's report (2026-10-18): 「处理中和那个秒数它都换行了…尤其在手机上」. The row is
// `spinner · 处理中 · (1 分 30 秒) · <agent status>`, and before the fix every item was `flex: 0 1 auto`:
// on a 360px phone 「处理中」 shrank to 21px and wrapped into THREE lines while the status kept its
// width. This sweep measures that directly.
//
// Why heights and not `getClientRects()`: a flex item is blockified, so it reports ONE rect even when
// its text spans three lines — a rect-count assertion passes on the broken layout (measured, 2026-10-18).
// The honest signal is `height > 1.5 × line-height`, plus the row's own height.
//
// The status sentence is injected because the mock's is shorter than a real one; the stylesheet, the
// markup and the widths are the real ones. No `json/new`: this attaches to the operator's Edge, and a
// tab per run would pile up in their window (30 of them, measured) — so it reuses a blank tab.
//
//   PORT=8901 node scripts/qa/stream-hint-geom.mjs
const CDP = process.env.CDP ?? "http://127.0.0.1:9222";
const BASE = process.env.BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8901}`;
const SHOTS = process.env.SHOTS ?? "/Users/liang/Workspace/agent-dev-workspace/tasks/20261001-agentus/screens";
const LONG = "👁️ Hindsight — recalled 8 memories · 上下文 256K/512K · 已保存 3 条新事实";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const list = await (await fetch(`${CDP}/json/list`)).json();
const target = list.find((t) => t.type === "page" && t.url === "about:blank")
  ?? list.find((t) => t.type === "page" && t.url.startsWith(BASE));
if (!target) throw new Error("no reusable tab — open one blank tab and retry");
console.log(`      using tab ${target.id} (${target.url})`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const w = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && w.has(m.id)) { const x = w.get(m.id); w.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); } };
const send = (m, p = {}, to = 12000) => new Promise((res, rej) => {
  const mid = ++id; const tm = setTimeout(() => { w.delete(mid); rej(new Error("TIMEOUT " + m)); }, to);
  w.set(mid, { res: (v) => { clearTimeout(tm); res(v); }, rej: (e) => { clearTimeout(tm); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method: m, params: p }));
});
const ev = async (x) => {
  const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};
await send("Page.enable"); await send("Runtime.enable");
// The asset name is hashed, but `index.html` is not: a cached document keeps pointing at the OLD
// stylesheet and every measurement below then describes the previous build (measured: a green fix
// reported red until the cache was disabled).
await send("Network.enable").catch(() => {});
await send("Network.setCacheDisabled", { cacheDisabled: true }).catch(() => {});
await send("Page.navigate", { url: `${BASE}/?cachebust=${Date.now()}` }).catch(() => {});
await sleep(2500);

// The line as App.tsx renders it, inside the width a phone actually gives the transcript.
const MOUNT = `(() => {
  document.getElementById('probe-hint')?.remove();
  const host = document.createElement('div');
  host.id = 'probe-hint';
  host.style.cssText = 'position:fixed;left:8px;top:8px;width:calc(100vw - 16px);z-index:99999;background:#111;';
  const row = document.createElement('div');
  row.className = 'stream-hint';
  row.innerHTML = '<span class="stream-spin"></span><span>处理中</span><span class="elapsed">(1 分 30 秒)</span>'
    + '<span class="turn-status">' + ${JSON.stringify(LONG)} + '</span>';
  host.appendChild(row);
  document.body.appendChild(host);
  return getComputedStyle(row).display;
})()`;

const MEASURE = `(() => {
  const el = document.querySelector('#probe-hint .stream-hint');
  if (!el) return { found: false };
  const cs = getComputedStyle(el);
  const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
  const r = el.getBoundingClientRect();
  const kids = [...el.children].map((c) => {
    const b = c.getBoundingClientRect();
    return { cls: c.className || "(word)", text: c.textContent.trim(),
             w: Math.round(b.width), h: Math.round(b.height),
             truncated: c.scrollWidth > c.clientWidth + 1, ws: getComputedStyle(c).whiteSpace };
  });
  return { found: true, w: Math.round(r.width), h: Math.round(r.height), lineH: Math.round(lineH),
           overflowX: el.scrollWidth - el.clientWidth, kids };
})()`;

let cssLoaded = "";
for (const [label, width, mobile] of [["360px 手机", 360, true], ["390px 手机", 390, true], ["414px 手机", 414, true], ["1280px 桌面", 1280, false]]) {
  await send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 2, mobile });
  await sleep(250);
  cssLoaded = await ev(MOUNT);
  await sleep(150);
  const d = await ev(MEASURE);
  if (!d.found) { check(`${label}: the line rendered`, false); continue; }

  const word = d.kids.find((k) => k.text.startsWith("处理中"));
  const clock = d.kids.find((k) => k.cls === "elapsed");
  const status = d.kids.find((k) => k.cls === "turn-status");
  console.log(`      ${label}: row ${d.w}×${d.h}  lineH=${d.lineH}  word ${word?.w}×${word?.h}  clock ${clock?.w}×${clock?.h}  status ${status?.w}×${status?.h}`);

  check(`${label}: 「处理中」 is one line (not squeezed into a column)`,
    !!word && word.h <= d.lineH * 1.5 && word.w >= 30, `${word?.w}×${word?.h} (lineH ${d.lineH})`);
  check(`${label}: 「(1 分 30 秒)」 is one line`,
    !!clock && clock.h <= d.lineH * 1.5 && clock.w >= 30, `${clock?.w}×${clock?.h}`);
  check(`${label}: the whole row is ONE line box`, d.h <= d.lineH + 8, `h=${d.h} lineH=${d.lineH}`);
  check(`${label}: nothing overflows the row horizontally`, d.overflowX <= 1, `overflow=${d.overflowX}px`);
  check(`${label}: the status absorbs the squeeze (ellipsis, not wrapping)`,
    !!status && status.h <= d.lineH * 1.5 && !!status.truncated, `${status?.w}×${status?.h} trunc=${status?.truncated}`);
  // the rule under test, read from the page: a stale stylesheet cannot fake this
  check(`${label}: the stylesheet under test is the FIXED one (word/clock nowrap)`,
    word?.ws === "nowrap" && clock?.ws === "nowrap", `word=${word?.ws} clock=${clock?.ws}`);

  try {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    (await import("node:fs")).writeFileSync(`${SHOTS}/stream-hint-${width}.png`, Buffer.from(shot.data, "base64"));
  } catch { /* evidence, not assertion */ }
}

check("the stylesheet was actually the one under test (flex row, not browser defaults)", cssLoaded === "flex", `display=${cssLoaded}`);

await ev(`document.getElementById('probe-hint')?.remove()`);
await send("Emulation.clearDeviceMetricsOverride").catch(() => {});
ws.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
