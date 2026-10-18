// QA: a plan step must stay on ONE line on a phone — by shrinking its type, not by wrapping.
//
// The operator's ask (2026-10-18): 「计划里面每个步骤…它也会换行，我不太喜欢它换行…手机上面能不能缩小字体？
// 就是它如果出现字数太多」. So on a 360px screen a long step must fit on one line, at a font size BELOW
// the stylesheet's (12px phones), and never below the readable floor. Desktop is the control: same
// fixture, same card, 13px, no shrinking.
//
// Two things this sweep has to get right, both learned the hard way:
//   · the mock's plan frames are DROPPED unless the backend row opts into the frame path
//     (`nativePlanSource: 'acp'`) — every backend defaults to MCP-driven, so a bare `[plan]` prompt
//     produces no card at all and the sweep would fail for the wrong reason;
//   · `getClientRects()` cannot see a wrap (a flex item is blockified → always one rect), so the
//     signal is height vs line-height.
//
//   PORT=8901 node scripts/qa/plan-step-fit.mjs
const CDP = process.env.CDP ?? "http://127.0.0.1:9222";
const BASE = process.env.BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8901}`;
const U = process.env.QA_USER ?? "scratch", P = process.env.QA_PASS ?? "scratch-pass-1";
const SHOTS = process.env.SHOTS ?? "/Users/liang/Workspace/agent-dev-workspace/tasks/20261001-agentus/screens";
const FLOOR = 9.5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const list = await (await fetch(`${CDP}/json/list`)).json();
const target = list.find((t) => t.type === "page" && t.url === "about:blank")
  ?? list.find((t) => t.type === "page" && t.url.startsWith(BASE));
if (!target) throw new Error("no reusable tab — open one blank tab and retry");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const w = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && w.has(m.id)) { const x = w.get(m.id); w.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); } };
const send = (m, p = {}, to = 20000) => new Promise((res, rej) => {
  const mid = ++id; const tm = setTimeout(() => { w.delete(mid); rej(new Error("TIMEOUT " + m)); }, to);
  w.set(mid, { res: (v) => { clearTimeout(tm); res(v); }, rej: (e) => { clearTimeout(tm); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method: m, params: p }));
});
const ev = async (x, to = 20000) => {
  const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }, to);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};
await send("Page.enable"); await send("Runtime.enable");
await send("Network.enable").catch(() => {});
await send("Network.setCacheDisabled", { cacheDisabled: true }).catch(() => {});

await send("Page.navigate", { url: BASE }).catch(() => {});
await sleep(2000);
const login = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
if (login !== 200) throw new Error(`QA login returned ${login} — is this the QA/dev instance?`);

// opt the mock row into the FRAME path (default is MCP-driven, frames dropped) — put it back at the end
const rowBefore = await ev(`fetch('/api/backends/mock').then(r=>r.json())`);
await ev(`fetch('/api/backends/mock',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign(${JSON.stringify(rowBefore)},{nativePlanSource:'acp'}))}).then(r=>r.status)`);

const made = await ev(`fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({backend:'mock',cwd:'/tmp',title:'plan fit（自动删除）'})}).then(async r=>r.status+' '+await r.text())`);
const sid = (() => { try { return JSON.parse(String(made).slice(4))?.id; } catch { return undefined; } })();
if (!sid) throw new Error(`could not create the probe session — ${String(made).slice(0, 300)}`);
console.log(`      mock=${sid}`);

const status = () => ev(`fetch('/api/sessions').then(r=>r.json()).then(d=>(d.live||[]).find(s=>s.id===${JSON.stringify(sid)})?.status||'')`).catch(() => "");
const idle = async (ms = 30000) => { const t0 = Date.now(); for (;;) { const st = await status(); if (st !== "running" && st !== "starting") return st; if (Date.now() - t0 > ms) return st; await sleep(300); } };

/** The expanded plan card's steps, with the numbers this sweep reasons about. */
const readSteps = () => ev(`(() => {
  // the newest one: earlier turns' cards are archived into the transcript, and this sweep opens all
  // of them so the LAST match is the plan the prompt just produced
  const cards = [...document.querySelectorAll('.plan-bar, .plan-card')];
  const card = cards[cards.length - 1];
  if (!card) return { found: false };
  const steps = [...card.querySelectorAll('.plan-step')].map((li) => {
    const t = li.querySelector('.step-title');
    const cs = getComputedStyle(t);
    const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
    const r = t.getBoundingClientRect();
    return { text: t.textContent.trim(), fontSize: parseFloat(cs.fontSize),
             lineH: Math.round(lineH * 10) / 10, h: Math.round(r.height * 10) / 10, w: Math.round(r.width) };
  });
  return { found: true, steps };
})()`);

try {
  for (const [label, width, mobile, basePx] of [["360px 手机", 360, true, 12], ["390px 手机", 390, true, 12], ["1280px 桌面", 1280, false, 13]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 2, mobile });
    await sleep(200);
    await send("Page.navigate", { url: `${BASE}/?session=${sid}` }).catch(() => {});
    await sleep(2200);

    await idle();
    await ev(`fetch('/api/sessions/${sid}/prompt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'[plan-long] 步骤换行测量'})}).then(r=>r.status)`);
    await idle(60000);
    await sleep(500);

    // the bar arrives pinned above the composer, collapsed; open it
    let opened = false;
    for (let i = 0; i < 30 && !opened; i++) {
      opened = await ev(`(() => { const heads = [...document.querySelectorAll('.plan-bar .plan-head, .plan-card .plan-head')];
        if (!heads.length) return false;
        for (const b of heads) if (b.getAttribute('aria-expanded') !== 'true') b.click();
        return true; })()`);
      if (!opened) await sleep(300);
    }
    await sleep(600);

    const d = await readSteps();
    if (!d.found || !d.steps?.length) { check(`${label}: the plan card rendered`, false, JSON.stringify(d).slice(0, 120)); continue; }

    const worst = d.steps.reduce((a, b) => (b.h > a.h ? b : a), d.steps[0]);
    console.log(`      ${label}: ${d.steps.length} steps, worst "${worst.text.slice(0, 16)}…" ${worst.fontSize}px h=${worst.h} (lineH ${worst.lineH})`);

    check(`${label}: every step is on ONE line`,
      d.steps.every((s) => s.h <= s.lineH * 1.2), d.steps.map((s) => `${s.h}/${s.lineH}`).join(" "));
    check(`${label}: no step is squeezed below the readable floor`,
      d.steps.every((s) => s.fontSize >= FLOOR), d.steps.map((s) => `${s.fontSize}px`).join(" "));
    if (mobile) {
      check(`${label}: the long steps really were shrunk (the fit ran, this is not just a wider card)`,
        d.steps.some((s) => s.fontSize < basePx), d.steps.map((s) => `${s.fontSize}px`).join(" "));
      // one size for the column: a shrunk step beside a normal one reads as a mistake
      check(`${label}: every step in the card shares ONE size`,
        new Set(d.steps.map((s) => s.fontSize)).size === 1, d.steps.map((s) => `${s.fontSize}px`).join(" "));
    } else {
      check(`${label}: desktop type is untouched (no shrink where there is width)`,
        d.steps.every((s) => s.fontSize === basePx), d.steps.map((s) => `${s.fontSize}px`).join(" "));
    }

    try {
      const shot = await send("Page.captureScreenshot", { format: "png" });
      (await import("node:fs")).writeFileSync(`${SHOTS}/plan-fit-${width}.png`, Buffer.from(shot.data, "base64"));
    } catch { /* evidence, not assertion */ }
  }
} finally {
  await ev(`fetch('/api/backends/mock',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign(${JSON.stringify(rowBefore)},{nativePlanSource:${JSON.stringify(rowBefore?.nativePlanSource ?? null)}}))}).then(r=>r.status)`).catch(() => {});
  await send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  await ev(`fetch('/api/sessions/${sid}',{method:'DELETE'})`).catch(() => {});
  ws.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
