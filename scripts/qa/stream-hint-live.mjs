// Live check: the turn line's geometry on the RUNNING cockpit (:8788), measured in the operator's own
// logged-in tab — no navigation, no new tab. Sets the phone viewport, injects the row, measures, restores.
const CDP = "http://127.0.0.1:9222";
const BASE = process.env.BASE ?? "http://127.0.0.1:8788";
const LONG = "👁️ Hindsight — recalled 8 memories · 上下文 256K/512K · 已保存 3 条新事实";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`${CDP}/json/list`)).json();
const target = list.find((t) => t.type === "page" && t.url.startsWith(BASE));
if (!target) throw new Error(`no open tab on ${BASE} — open the cockpit and retry`);

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

console.log(`      tab ${target.id}  ${target.url.slice(0, 60)}`);
console.log(`      stylesheet: ${await ev(`[...document.styleSheets].map(s => s.href || 'inline').join(' ')`)}`);

for (const [label, width, mobile] of [["360px 手机", 360, true], ["390px 手机", 390, true], ["1280px 桌面", 1280, false]]) {
  await send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 2, mobile });
  await sleep(300);
  const display = await ev(`(() => {
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
  })()`);
  await sleep(150);
  const d = await ev(`(() => {
    const el = document.querySelector('#probe-hint .stream-hint');
    const cs = getComputedStyle(el);
    const lineH = parseFloat(cs.lineHeight);
    const kids = [...el.children].map((c) => { const b = c.getBoundingClientRect();
      return { cls: c.className || '(word)', text: c.textContent.trim(), w: Math.round(b.width), h: Math.round(b.height),
               ws: getComputedStyle(c).whiteSpace, trunc: c.scrollWidth > c.clientWidth + 1 }; });
    const r = el.getBoundingClientRect();
    return { row: [Math.round(r.width), Math.round(r.height)], lineH: Math.round(lineH), kids,
             overflowX: el.scrollWidth - el.clientWidth };
  })()`);
  const word = d.kids.find((k) => k.text.startsWith("处理中"));
  const clock = d.kids.find((k) => k.cls === "elapsed");
  const status = d.kids.find((k) => k.cls === "turn-status");
  const ok = word?.h <= d.lineH * 1.5 && clock?.h <= d.lineH * 1.5 && d.row[1] <= d.lineH + 8;
  console.log(`      ${ok ? "PASS" : "FAIL"} ${label}: row ${d.row[0]}×${d.row[1]} (lineH ${d.lineH})  word ${word?.w}×${word?.h}  clock ${clock?.w}×${clock?.h}  status ${status?.w}×${status?.h} trunc=${status?.trunc}  ${display === "flex" ? "" : "CSS NOT LOADED"}`);
}

await ev(`document.getElementById('probe-hint')?.remove()`);
await send("Emulation.clearDeviceMetricsOverride").catch(() => {});
ws.close();
