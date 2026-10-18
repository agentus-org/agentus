// The turn line on a phone now stacks: 「处理中 (12 秒)」 keeps the first line, the agent's sentence
// gets a full-width line of its own. This measures exactly that on the dev instance (:8901).
//
// Why a stacked row: with the clock rigid, the only item that could give width was the sentence, so a
// long status became a two-line column squeezed into ~250px beside a 12-char clock — which the
// operator read as 「放不下」. Full width is 360px instead of 250px and nothing has to give.
const CDP = "http://127.0.0.1:9222";
const BASE = process.env.BASE ?? "http://127.0.0.1:8901";
const LONG = "👁️ Hindsight — recalled 8 memories · 上下文 256K/512K · 已保存 3 条新事实";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`${CDP}/json/list`)).json();
let target = list.find((t) => t.type === "page" && t.url.startsWith(BASE));
let opened = null;
if (!target) {
  // No cockpit tab to borrow: open one for the measurement and close it afterwards, so the operator's
  // browser does not accumulate the tabs earlier probes left behind.
  opened = await (await fetch(`${CDP}/json/new?${BASE}`, { method: "PUT" })).json();
  target = opened;
  await sleep(2500);
}

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
await send("Runtime.enable");
// Borrowed tabs were loaded before this build — reload with a cold cache, otherwise we measure the
// previous CSS and call a green build red.
await send("Page.enable").catch(() => {});
await send("Page.reload", { ignoreCache: true }).catch(() => {});
await sleep(2500);

let fails = 0, checks = 0;
const check = (ok, label, extra = "") => {
  checks++; if (!ok) fails++;
  console.log(`      ${ok ? "PASS" : "FAIL"} ${label}${extra ? "  " + extra : ""}`);
};

for (const [label, width, mobile] of [["360px 手机", 360, true], ["390px 手机", 390, true], ["1280px 桌面", 1280, false]]) {
  await send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 2, mobile });
  await sleep(250);
  const display = await ev(`(() => {
    document.getElementById('probe-hint')?.remove();
    const host = document.createElement('div');
    host.id = 'probe-hint';
    host.style.cssText = 'position:fixed;left:8px;top:8px;width:calc(100vw - 16px);z-index:99999;background:#111;color:#ddd;';
    const row = document.createElement('div');
    row.className = 'stream-hint';
    row.innerHTML = '<span class="stream-spin"></span><span>处理中</span><span class="elapsed">(1 分 30 秒)</span>'
      + '<span class="turn-status">' + ${JSON.stringify(LONG)} + '</span>';
    host.appendChild(row);
    document.body.appendChild(host);
    return getComputedStyle(row).display;
  })()`);
  await sleep(150);
  const d = await ev(`(() => {
    const el = document.querySelector('#probe-hint .stream-hint');
    const cs = getComputedStyle(el);
    const lineH = parseFloat(cs.lineHeight);
    const box = (c) => { const b = c.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top), left: Math.round(b.left),
               ws: getComputedStyle(c).whiteSpace, trunc: c.scrollWidth > c.clientWidth + 1,
               fs: parseFloat(getComputedStyle(c).fontSize) }; };
    const kids = [...el.children].map((c) => ({ cls: c.className || '(word)', text: c.textContent.trim(), ...box(c) }));
    const r = el.getBoundingClientRect();
    return { row: [Math.round(r.width), Math.round(r.height)], lineH: Math.round(lineH), kids,
             wrap: cs.flexWrap, overflowX: el.scrollWidth - el.clientWidth };
  })()`);
  const word = d.kids.find((k) => k.text.startsWith("处理中"));
  const clock = d.kids.find((k) => k.cls === "elapsed");
  const status = d.kids.find((k) => k.cls === "turn-status");
  const num = `row ${d.row[0]}×${d.row[1]}  word ${word.w}×${word.h}  clock ${clock.w}×${clock.h}  status ${status.w}×${status.h} fs ${status.fs}`;

  check(display === "flex", `${label}: CSS loaded (row is a flex box)`, `wrap=${d.wrap}`);
  // The word and the clock are one fact in two parts — each on ONE line, never folded.
  check(word.h <= d.lineH * 1.5, `${label}: 「处理中」 one line`, `${word.w}×${word.h} (lineH ${d.lineH})`);
  check(clock.h <= d.lineH * 1.5, `${label}: the clock one line`, `${clock.w}×${clock.h}`);
  check(!word.trunc && !clock.trunc, `${label}: neither is clipped`, `word trunc=${word.trunc} clock trunc=${clock.trunc}`);
  check(d.overflowX <= 1, `${label}: row does not overflow sideways`, `overflowX=${d.overflowX}`);

  if (mobile) {
    // Stacked: the sentence starts on a line BELOW the word, and it owns that line.
    check(status.top >= word.top + word.h - 1, `${label}: 状态句另起一行`, `status.top ${status.top} vs word.bottom ${word.top + word.h}`);
    check(status.w >= d.row[0] * 0.9, `${label}: 状态句占满整行`, `${status.w} / ${d.row[0]}`);
    check(status.fs < word.fs, `${label}: 状态句字号更小`, `${status.fs} < ${word.fs}`);
    check(!status.trunc, `${label}: 状态句不截断`, `trunc=${status.trunc}`);
    check(status.w > 300, `${label}: 句子拿到全宽（不是被挤到 ~250px）`, `${status.w}px`);
  } else {
    // Desktop has room: one line, the sentence beside the clock.
    check(Math.abs(status.top - word.top) <= 3, `${label}: 状态句与「处理中」同一行`, `top ${status.top} vs ${word.top}`);
    check(d.row[1] <= d.lineH * 1.6, `${label}: 整行只有一行高`, `${d.row[1]} (lineH ${d.lineH})`);
  }
  console.log(`      · ${label} ${num}`);
}

await ev(`document.getElementById('probe-hint')?.remove()`);
await send("Emulation.clearDeviceMetricsOverride").catch(() => {});
ws.close();
if (opened) await fetch(`${CDP}/json/close/${opened.id}`).catch(() => {});

console.log(`\n      ${fails ? "RED" : "GREEN"} — ${checks - fails}/${checks}`);
process.exit(fails ? 1 : 0);
