// QA: the turn's progress line at the transcript tail, and the agent's own name on its reply.
//
// Two asks from the operator, both checked here off the RENDERED page:
//   1. the tail line is back (「还是加一个吧，放到之前那个位置吧…一行就行，显示处理中，并显示已经处理的时长，
//      时长要是从用户发送消息发起计时哈」) — a spinner, the word, and the elapsed time;
//   2. the reply's label reads as the agent (「AGENT字段能改成对应头像+对应agent名称吗…Hermes 的话就放
//      hermes 的头像和 Hermes 这个单词」), not as the word "AGENT".
//
// The hard part is (1)'s 「从用户发送消息发起计时」. A "time since the last output" clock would pass a
// naive "the number is there" check and still be wrong: the mock backend used here streams a chunk
// every ~900 ms, so such a clock would sit at 0–1 秒 forever. So the sweep reads the number twice,
// seconds apart, and requires it to CLIMB — that is what tells 「我等了多久」 from 「它刚刚说话了吗」. The
// anchor stamp is additionally compared against the page clock captured at the send.
//
//   PORT=8901 node scripts/qa/turn-line-sweep.mjs
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

/** The line as the operator sees it, plus the stamps this sweep reasons about. */
const readLine = () => ev(`(() => {
  const el = document.querySelector('.stream-hint');
  if (!el) return { found: false };
  const spin = el.querySelector('.stream-spin');
  const r = el.getBoundingClientRect();
  return {
    found: true,
    text: el.textContent.trim(),
    seconds: Number((el.textContent.match(/\\((\\d+) 秒\\)/) ?? [])[1] ?? NaN),
    anchor: Number(el.dataset.anchor ?? 0),
    spin: !!spin,
    spinAnim: spin ? getComputedStyle(spin).animationName : "",
    rows: document.querySelectorAll('.stream-hint').length,
    h: Math.round(r.height),
  };
})()`);

try {
  const login = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
  if (login !== 200) throw new Error(`QA login returned ${login} — is this the QA/dev instance? (AGENTUS_DATA)`);
  const mk = async (backend) => (await ev(`fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({backend:${JSON.stringify(backend)},cwd:'/tmp'})}).then(r=>r.json())`))?.id;
  const sid = await mk("mock"), hermes = await mk("hermes");
  if (!sid) throw new Error("could not create the probe mock session");
  console.log(`      mock=${sid}  hermes=${hermes ?? "(not created)"}`);
  await sleep(400);
  await ev(`location.href = ${JSON.stringify(BASE)} + '/?session=' + ${JSON.stringify(sid)}`).catch(() => {});
  const waitFor = async (expr, ms = 12_000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (await ev(expr).catch(() => 0)) return true; await sleep(300); }
    return false;
  };
  check("the probe session is open (a failure here is setup, not the line)", await waitFor(`document.querySelector('.composer textarea') && document.querySelector('[data-session="' + ${JSON.stringify(sid)} + '"].active') ? 1 : 0`));

  // ---- idle: nothing at the tail, so the line means "a turn is running" -------------------------
  check("an idle transcript draws no progress line", (await ev(`document.querySelectorAll('.stream-hint').length`)) === 0);

  // ---- the turn: one line, with the elapsed time counted from THIS send -------------------------
  const t0 = await ev(`Date.now()`);
  const sent = await ev(`fetch('/api/sessions/'+${JSON.stringify(sid)}+'/prompt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'[slow] 尾巴计时'})}).then(r=>r.status)`);
  check("the probe turn was accepted", sent === 202, `HTTP ${sent}`);
  check("a running turn puts the line at the transcript tail", await waitFor(`document.querySelector('.stream-hint') ? 1 : 0`, 10_000));
  const first = await readLine();
  check("it says 处理中", /^处理中/.test(first.text ?? ""), first.text);
  check("…with a spinner attached, on the house `spin` keyframes", first.spin && (first.spinAnim ?? "").includes("spin"), `anim=${first.spinAnim}`);
  check("…and ONE row only (the operator's 「一行就行」)", first.rows === 1 && first.h <= 30, `rows=${first.rows} h=${first.h}px`);
  check("the clock is anchored on the SEND, not on the first token", Math.abs((first.anchor || 0) - t0) <= 2500, `anchor-t0=${(first.anchor || 0) - t0}ms`);
  check("…and the elapsed is rendered as a duration", /\(\d+ 秒\)|\(\d+ 分 \d+ 秒\)/.test(first.text ?? ""), first.text);

  // The distinguishing reading: `[slow]` streams every ~900ms, so a "since last output" clock would
  // stay at 0–1 秒. Counting from the send, the number must climb.
  await sleep(4500);
  const later = await readLine();
  check("the number CLIMBS while chunks are still arriving (time since the send, not since the last chunk)",
    Number.isFinite(later.seconds) && Number.isFinite(first.seconds) && later.seconds >= first.seconds + 2,
    `first=${first.seconds}s later=${later.seconds}s`);
  check("it is still exactly one line after a few seconds", later.rows === 1, `rows=${later.rows}`);
  {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(`${SHOTS}/turn-line.png`, Buffer.from(shot.data, "base64"));
    console.log(`      screenshot ${SHOTS}/turn-line.png`);
  }

  // ---- WHO spoke, on the reply itself ----------------------------------------------------------
  const label = await ev(`(() => {
    const bubbles = [...document.querySelectorAll('.msg.agent')];
    const last = bubbles[bubbles.length - 1];
    if (!last) return { found: false, agents: bubbles.length };
    const role = last.querySelector('.role');
    const marks = last.querySelectorAll('.agent-mark');
    const img = marks.length ? marks[0].querySelector('img') : null;
    const row = document.querySelector('[data-session="' + ${JSON.stringify(sid)} + '"]');
    const rail = row?.querySelector('.be-avatar');
    return {
      found: true, agents: bubbles.length,
      roleText: role?.textContent?.trim() ?? "",
      hasMarkRow: !!role?.classList.contains('with-mark'),
      markCount: marks.length,
      markBackend: marks.length ? marks[0].dataset.backend : "",
      markImg: img?.getAttribute('src') ?? "",
      railBackend: rail?.dataset.backend ?? "",
      railLetter: rail?.dataset.letter ?? "",
      railHasImg: !!rail?.querySelector('img'),
      railTitle: rail?.getAttribute('title') ?? "",
      transcriptSaysAgent: /(^|\\s)AGENT(\\s|$)/.test(document.querySelector('.stream-inner')?.textContent ?? ""),
    };
  })()`);
  check("the reply renders a label block at all (fixture precondition)", label.found === true && label.agents >= 1, `agents=${label.agents}`);
  check("the label is the agent's NAME, not the word AGENT", label.roleText === "Mock" && label.roleText !== "AGENT", `role="${label.roleText}"`);
  check("…and the transcript never says AGENT anywhere", label.transcriptSaysAgent === false);
  check("a backend with NO artwork draws no mark beside the name (a monogram there would read 「MMock」)",
    label.hasMarkRow && label.markCount === 0 && label.markImg === "", `marks=${label.markCount}`);
  check("…while its rail row still wears the monogram (a rail row has no room for a name)",
    label.railBackend === "mock" && label.railLetter === "M" && label.railHasImg === false, `letter=${label.railLetter} img=${label.railHasImg}`);
  check("both labels come from the ONE table (rail names the same agent as the reply)",
    (label.railTitle ?? "").startsWith(label.roleText + " ·"), `rail="${label.railTitle}" role="${label.roleText}"`);

  // The Hermes path (「Hermes 的话就放 hermes 的头像和 Hermes 这个单词」) is the one the operator named, and
  // the mark is drawn from the same table on the rail row — so a hermes row shows the real artwork
  // without needing an agent turn. A fresh session already proves it.
  if (hermes) {
    const h = await ev(`(() => {
      const row = document.querySelector('[data-session="' + ${JSON.stringify(hermes)} + '"]');
      const av = row?.querySelector('.be-avatar');
      return { found: !!av, img: av?.querySelector('img')?.getAttribute('src') ?? "", title: av?.getAttribute('title') ?? "" };
    })()`);
    check("a Hermes session wears the Hermes artwork (not a monogram)",
      h.found && h.img === "/coding-agents/hermes.png", `img="${h.img}"`);
    check("…and its mark is labelled Hermes", /^Hermes · /.test(h.title ?? ""), h.title);
  } else {
    check("a Hermes session could be created for the artwork check", false, "POST /api/sessions backend=hermes failed");
  }

  // ---- the turn ends: the line leaves -----------------------------------------------------------
  const deadline = Date.now() + 45_000;
  let status = "";
  while (Date.now() < deadline) {
    status = await ev(`fetch('/api/sessions').then(r=>r.json()).then(j=>((j.live||[]).find(s=>s.id===${JSON.stringify(sid)})||{}).status ?? 'gone')`);
    if (status !== "running") break;
    await sleep(700);
  }
  check("the probe turn really ended (fixture precondition)", status !== "running", `status=${status}`);
  await sleep(900);
  const after = await readLine();
  check("the line is gone once the turn is over (no stale 处理中)", after.found === false, JSON.stringify(after));

  for (const x of [sid, hermes].filter(Boolean)) {
    await ev(`fetch('/api/sessions/'+${JSON.stringify(x)},{method:'DELETE'})`).catch(() => {});
  }
} finally {
  await fetch(`${CDP}/json/close/${t.id}`, { method: "PUT" }).catch(() => {});
  ws.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
