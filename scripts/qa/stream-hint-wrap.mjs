// QA: the turn line must stay ONE line — on a phone too.
//
// The operator's report (2026-10-18): 「处理中和那个秒数它都换行了…尤其在手机上」. The line is a flex row
// (spinner · 处理中 · (12 秒) · the agent's own status), and on a narrow screen the long status sentence
// squeezed the word and the clock until each wrapped INSIDE itself. This sweep measures that failure
// directly instead of looking at a screenshot:
//
//   · a wrapped inline element yields MORE THAN ONE rect from `getClientRects()` — that is the signal
//     「处理中」 breaking in half, and it is invisible to `textContent` checks;
//   · the row must never overflow its own width horizontally;
//   · the row's height must stay within one line box.
//
// It runs the SAME turn twice: once at 390×844 (phone) and once at 1280×900 (desktop), because a fix
// that only survives desktop is the bug being fixed.
//
//   PORT=8901 node scripts/qa/stream-hint-wrap.mjs
const CDP = process.env.CDP ?? "http://127.0.0.1:9222";
const BASE = process.env.BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8901}`;
const U = process.env.QA_USER ?? "scratch", P = process.env.QA_PASS ?? "scratch-pass-1";
const SHOTS = process.env.SHOTS ?? "/Users/liang/Workspace/agent-dev-workspace/tasks/20261001-agentus/screens";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const t = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(2000);
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
await send("Page.enable"); await send("Runtime.enable");

const viewport = async (width, height, mobile) => {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  await sleep(400);
};

/** Everything this sweep reasons about, read from the LIVE line — heights, not strings.
 *  A flex item is blockified, so `getClientRects()` reports ONE rect even when the text wrapped into
 *  three lines (measured 2026-10-18): the honest signal is `height > 1.5 × line-height`. */
const readRow = () => ev(`(() => {
  const el = document.querySelector('.stream-hint');
  if (!el) return { found: false };
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
  const spans = [...el.children].map((c) => {
    const b = c.getBoundingClientRect();
    return {
      cls: c.className || "(word)", text: c.textContent.trim(),
      h: Math.round(b.height), w: Math.round(b.width),
      truncated: c.scrollWidth > c.clientWidth + 1, ws: getComputedStyle(c).whiteSpace,
    };
  });
  return {
    found: true, text: el.textContent.trim(),
    w: Math.round(r.width), h: Math.round(r.height), lineH: Math.round(lineH),
    overflowX: el.scrollWidth - el.clientWidth, spans,
  };
})()`);

try {
  const login = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
  if (login !== 200) throw new Error(`QA login returned ${login} — is this the QA/dev instance?`);

  const made = await ev(`fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({backend:'mock',cwd:'/tmp',title:'stream-hint wrap（自动删除）'})}).then(async r=>r.status+' '+await r.text())`);
  const sid = (() => { try { return JSON.parse(String(made).slice(4))?.id; } catch { return undefined; } })();
  if (!sid) throw new Error(`could not create the probe session — ${String(made).slice(0, 300)}`);
  console.log(`      mock=${sid}`);

  for (const [label, width, height, mobile] of [["phone 390", 390, 844, true], ["desktop 1280", 1280, 900, false]]) {
    await viewport(width, height, mobile);
    await ev(`location.href = ${JSON.stringify(BASE)} + '/?session=' + ${JSON.stringify(sid)}`).catch(() => {});
    await sleep(2500);

    // `[status]` makes the mock send the agent's own line mid-turn (issue #18); `[slow]` keeps the turn
    // running long enough to read it twice.
    await ev(`fetch('/api/sessions/'+${JSON.stringify(sid)}+'/prompt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'[slow] [status] 换行测量'})}).then(r=>r.status)`);

    let row = { found: false };
    for (let i = 0; i < 40 && !row.found; i++) { await sleep(300); row = await readRow(); if (row.found && !row.text.includes("Hindsight")) row = { found: false }; }
    if (!row.found) { check(`${label}: the turn line appeared with the agent's status`, false, "never rendered"); continue; }
    console.log(`      ${label}: "${row.text}"  h=${row.h} lineH=${row.lineH} w=${row.w}`);

    const word = row.spans.find((s) => s.text.startsWith("处理中"));
    const clock = row.spans.find((s) => s.cls === "elapsed");
    const status = row.spans.find((s) => s.cls === "turn-status");

    check(`${label}: 「处理中」 sits on ONE line`, !!word && word.h <= row.lineH * 1.5 && word.w >= 30,
      `${word?.w}×${word?.h} lineH=${row.lineH}`);
    check(`${label}: the seconds sit on ONE line`, !!clock && clock.h <= row.lineH * 1.5 && clock.w >= 30,
      `${clock?.w}×${clock?.h}`);
    check(`${label}: the row is a single line box (no wrap to a second line)`,
      row.h <= row.lineH + 8, `h=${row.h} lineH=${row.lineH}`);
    check(`${label}: the row does not overflow horizontally`, row.overflowX <= 1, `overflow=${row.overflowX}px`);
    check(`${label}: the agent's status keeps its own line and truncates`,
      !!status && status.h <= row.lineH * 1.5, `${status?.w}×${status?.h}`);
    check(`${label}: the fixed rule is in the page under test`, word?.ws === "nowrap" && clock?.ws === "nowrap",
      `word=${word?.ws} clock=${clock?.ws}`);

    try {
      const shot = await send("Page.captureScreenshot", { format: "png" });
      const file = `${SHOTS}/stream-hint-${mobile ? "phone" : "desktop"}.png`;
      (await import("node:fs")).writeFileSync(file, Buffer.from(shot.data, "base64"));
      console.log(`      shot ${file}`);
    } catch { /* screenshots are evidence, not an assertion */ }

    // end the turn so the next viewport starts clean
    await ev(`fetch('/api/sessions/'+${JSON.stringify(sid)}+'/cancel',{method:'POST'}).then(r=>r.status)`).catch(() => {});
    await sleep(600);
  }

  await ev(`fetch('/api/sessions/'+${JSON.stringify(sid)},{method:'DELETE'}).then(r=>r.status)`).catch(() => {});
} catch (e) {
  console.log(`\nERROR ${e.message}`);
  process.exit(1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
