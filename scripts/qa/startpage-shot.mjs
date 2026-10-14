// One-shot: screenshot the new-session start page (desktop + phone) so the SHAPE can be looked at.
//   node scripts/qa/startpage-shot.mjs
const CDP = process.env.CDP ?? "http://127.0.0.1:9222";
const BASE = process.env.BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8901}`;
const U = process.env.QA_USER ?? "scratch", P = process.env.QA_PASS ?? "scratch-pass-1";
const OUT = process.env.OUT ?? "/Users/liang/.hermes/cache/scratch";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = await import("node:fs");

const t = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(2600);
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const w = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && w.has(m.id)) { const x = w.get(m.id); w.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); } };
const send = (m, p = {}, to = 25000) => new Promise((res, rej) => {
  const mid = ++id; const timer = setTimeout(() => { w.delete(mid); rej(new Error("TIMEOUT " + m)); }, to);
  w.set(mid, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method: m, params: p }));
});
const ev = async (x, to = 25000) => {
  const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }, to);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};
const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  const p = `${OUT}/${name}.png`;
  fs.writeFileSync(p, Buffer.from(r.data, "base64"));
  console.log("shot:", p);
};

await send("Page.enable"); await send("Runtime.enable");
const login = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
console.log("login:", login);

await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false });
await sleep(600);
await ev(`document.querySelector('.new-btn')?.click()`);
await sleep(1400);
await shot("startpage-desktop");

// what the bar actually carries
const info = await ev(`(() => {
  const m = document.querySelector('.modal.start-page');
  const bar = m?.querySelector('.composer-bar');
  return JSON.stringify({
    modal: Boolean(m),
    box: Boolean(m?.querySelector('.composer-box')),
    barChildren: [...(bar?.children ?? [])].map((el) => el.className + '/' + (el.getAttribute('data-testid') ?? '') + '/' + (el.getAttribute('aria-label') ?? '')),
    pill: m?.querySelector('.ws-pill')?.textContent?.trim() ?? null,
    treeOnPage: Boolean(m?.querySelector('.wp-list')),
    backends: [...(m?.querySelectorAll('.be-card') ?? [])].length,
  });
})()`);
console.log("start page:", info);

// the workspace dialog
await ev(`document.querySelector('.modal.start-page .ws-pill')?.click()`);
await sleep(900);
await shot("startpage-ws-dialog");
console.log("ws dialog:", await ev(`Boolean(document.querySelector('.ws-modal'))`));
await ev(`document.querySelector('.ws-modal .cancel')?.click()`);
await sleep(400);

// phone
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(700);
await shot("startpage-phone");
await fetch(`${CDP}/json/close/${t.id}`).catch(() => {});
