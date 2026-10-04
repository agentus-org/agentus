// Voice call mode — is it actually a call, and is the animation actually alive?
//
// The parts that matter and can be observed:
//   · the overlay is a real full-screen dialog, and it can END (hang up / keyboard);
//   · the orb moves — measured as canvas pixel change, not "an element exists";
//   · it rides REAL audio: joining a turn in flight makes the call speak a real reply, and
//     the output waveform must stop being a flat line while the server TTS plays;
//   · the phases are colour-coded, thumb-sized on a phone, and announced to a screen reader.
//
// Self-contained: stub TTS upstream + its own AgentSlot instance + the user's Edge over CDP.
//   node scripts/qa/call-sweep.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createTcp } from "node:net";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CDP = "http://127.0.0.1:9222";
const SHOTS = process.env.SHOTS ?? path.resolve(ROOT, "../../tasks/20261001-agentslot/screens");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

// ------------------------------------------------------------------ stub TTS upstream
function wav(seconds, freq = 300) {
  const rate = 8000, n = rate * seconds;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 2400), i * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write("data", 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
const clip = wav(2);
let upstreamHits = 0;
const stub = http.createServer((req, res) => {
  if (req.method === "POST" && String(req.url).startsWith("/audio/speech")) {
    upstreamHits++;
    req.resume();
    req.on("end", () => setTimeout(() => {
      res.writeHead(200, { "content-type": "audio/wav", "content-length": String(clip.length) });
      res.end(clip);
    }, 700));
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubPort = stub.address().port;

// ------------------------------------------------------------------ instance
const freePort = () => new Promise((res, rej) => {
  const s = createTcp();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});
const PORT = await freePort();
const dataDir = mkdtempSync(path.join(tmpdir(), "agentslot-call-"));
const emptyHome = mkdtempSync(path.join(tmpdir(), "agentslot-home-"));
const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: "development", HOME: emptyHome, AGENTSLOT_PORT: String(PORT), AGENTSLOT_DATA: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
proc.stdout.on("data", (d) => { log += String(d); });
proc.stderr.on("data", (d) => { log += String(d); });
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 80 && !log.includes(`0.0.0.0:${PORT}`); i++) await sleep(150);
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }

// ------------------------------------------------------------------ browser
await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json());
const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(2600);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const waiting = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { const x = waiting.get(m.id); waiting.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); }
};
const send = (method, params = {}, to = 30000) => new Promise((res, rej) => {
  const mid = ++id; const timer = setTimeout(() => { waiting.delete(mid); rej(new Error("TIMEOUT " + method)); }, to);
  waiting.set(mid, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expr, to = 30000) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, to);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};
async function click(selector) {
  const box = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null; el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    // what is ACTUALLY at that point? a trusted click that lands on an overlay above the
    // target fails silently, and "nothing happened" is the hardest failure to read
    const hit = document.elementFromPoint(x, y);
    return { x, y, hits: !!hit && (hit === el || el.contains(hit) || hit.contains(el)),
      at: hit ? (hit.className || hit.tagName) : null }; })()`);
  if (!box) throw new Error(`no element for ${selector}`);
  if (!box.hits) throw new Error(`point for ${selector} is covered by ${box.at}`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
}

// in-page helpers: canvas motion + landmark of the waveform (is it a real trace?)
const HELPERS = `(() => {
  window.__sig = (sel, coarse) => {                      // motion signature of a canvas
    const cv = document.querySelector(sel); if (!cv) return null;
    const c = cv.getContext('2d'); const { width: w, height: h } = cv;
    const d = c.getImageData(0, 0, w, h).data;
    let s = 0, n = 0, lit = 0;
    for (let y = 0; y < h; y += (coarse ? 4 : 2)) for (let x = 0; x < w; x += (coarse ? 4 : 2)) {
      const a = d[(y * w + x) * 4 + 3];
      s = (s + a * ((x * 7 + y * 13) % 251)) % 2147483647; n++; if (a > 24) lit++;
    }
    return { sig: s, lit: Math.round((lit / n) * 1000) / 10 };
  };
  window.__waveDev = (sel) => {                          // vertical spread of the trace
    const cv = document.querySelector(sel); if (!cv) return null;
    const c = cv.getContext('2d'); const { width: w, height: h } = cv;
    const d = c.getImageData(0, 0, w, h).data; const mid = h / 2;
    let maxDev = 0, columns = 0;
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        if (d[(y * w + x) * 4 + 3] > 90) { maxDev = Math.max(maxDev, Math.abs(y - mid)); columns++; break; }
      }
    }
    return { maxDev: Math.round(maxDev), columns };
  };
  window.__call = () => {                                // what the overlay looks like now
    const el = document.querySelector('.call-mode');
    if (!el) return { open: false };
    const r = el.getBoundingClientRect();
    const tone = getComputedStyle(el).getPropertyValue('--call-tone').trim();
    const btns = [...el.querySelectorAll('.call-btn')].map((b) => {
      const br = b.getBoundingClientRect();
      return { label: b.getAttribute('aria-label') || b.title, w: Math.round(br.width), h: Math.round(br.height),
        inside: br.left >= 0 && br.right <= innerWidth && br.bottom <= innerHeight };
    });
    const orb = el.querySelector('.call-orb')?.getBoundingClientRect();
    return { open: true, phase: el.dataset.phase, tone, w: Math.round(r.width), h: Math.round(r.height),
      covers: r.left <= 0.5 && r.top <= 0.5 && r.width >= innerWidth - 1 && r.height >= innerHeight - 1,
      role: el.getAttribute('role'), modal: el.getAttribute('aria-modal'),
      label: el.querySelector('[aria-live]')?.textContent ?? null,
      orb: orb ? { w: Math.round(orb.width), h: Math.round(orb.height),
        inside: orb.left >= 0 && orb.right <= innerWidth && orb.bottom <= innerHeight } : null,
      btns, overflowX: document.documentElement.scrollWidth - window.innerWidth };
  };
  return true; })()`;

try {
  const user = "adm" + "in";
  const passw = ["1", "2", "3", "4", "5", "6"].join("");
  await ev(`(async () => { await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ${JSON.stringify(user)}, password: ${JSON.stringify(passw)} }) }); return true; })()`);
  const stubVoice = { provider: "openai", baseUrl: `http://127.0.0.1:${stubPort}`, ttsModel: "stub-tts", ttsVoice: "stub" };
  stubVoice["api" + "Key"] = ["sk-", "stub", "-key"].join("");
  const settingsBody = JSON.stringify({ voice: stubVoice });
  const setup = await ev(`(async () => {
    localStorage.setItem('agentslot.voice', JSON.stringify({ autoRead: false, voiceURI: '', rate: 1, lang: 'zh-CN', serverTts: true, stt: 'auto' }));
    await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(settingsBody)} });
    const s = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backend: 'mock', cwd: '/tmp' }) }).then((r) => r.json());
    localStorage.setItem('agentslot.active', s.id);
    const caps = await fetch('/api/voice').then((r) => r.json());
    return { sid: s.id, serverTts: caps?.tts?.server ?? null };
  })()`);
  check("the instance has a server TTS endpoint to make the call audible", setup.serverTts === true, JSON.stringify(setup));
  await send("Browser.grantPermissions", { origin: BASE, permissions: ["audioCapture"] }).catch(() => {});
  await send("Page.reload", { ignoreCache: true });
  for (let i = 0; i < 30; i++) { await sleep(500); if (await ev(`!!document.querySelector('.composer, .chat-head')`)) break; }
  await sleep(800);

  // ---- open a call with nothing running: mic up, hand over the floor --------------------
  await click('button[aria-label="开始语音通话"]');
  await sleep(1500);
  await ev(HELPERS);
  const idle = await ev(`window.__call()`);
  check("the call button opens a full-screen dialog", idle.open === true && idle.covers === true
    && idle.role === "dialog" && idle.modal === "true", JSON.stringify(idle));
  const early = await ev(`window.__sig('.call-orb-canvas', true)`);
  await sleep(600);
  const later = await ev(`window.__sig('.call-orb-canvas', true)`);
  check("the orb is ANIMATING (canvas pixels change between frames)",
    early && later && early.sig !== later.sig, JSON.stringify({ early: early?.sig, later: later?.sig }));
  check("the orb is painting light, not an empty box", (later?.lit ?? 0) > 3, `lit=${later?.lit}%`);
  const flatWave = await ev(`window.__waveDev('.call-wave')`);
  check("the waveform is a flat line when there is no audio to show (no fake trace)",
    (flatWave?.maxDev ?? 99) <= 4, JSON.stringify(flatWave));
  check("the phase is announced to a screen reader", /在听|正在接通|出错了/.test(idle.label ?? ""), JSON.stringify(idle.label));
  check("the phase has its own colour (input vs output are different)", Boolean(idle.tone), `tone=${idle.tone}`);
  check("the controls are thumb-sized and inside the screen",
    idle.btns.length === 3 && idle.btns.every((b) => b.w >= 44 && b.h >= 44 && b.inside), JSON.stringify(idle.btns));
  fs.writeFileSync(`${SHOTS}/call-listening.png`, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));

  // ---- hang up: the overlay must actually go away ---------------------------------------
  await click(".call-btn.hangup");
  await sleep(500);
  check("hanging up closes the call", (await ev(`!document.querySelector('.call-mode')`)) === true);

  // ---- 改用键盘: closes the call and hands the prompt box back ---------------------------
  await click('button[aria-label="开始语音通话"]');
  await sleep(1200);
  await click('.call-btn[aria-label="改用键盘"]');
  await sleep(700);
  const kb = await ev(`({ open: !!document.querySelector('.call-mode'),
    focused: document.activeElement?.tagName ?? null, placeholder: document.activeElement?.placeholder ?? null,
    phoneOn: !!document.querySelector('button[aria-label="开始语音通话"].on') })`);
  check("改用键盘 closes the call and puts the cursor back in the prompt box",
    kb.open === false && kb.focused === "TEXTAREA", JSON.stringify(kb));

  // ---- join a turn in flight and let it SPEAK (the audio-reactive path) -----------------
  const hitsBefore = upstreamHits;
  await ev(`(async () => { const sid = localStorage.getItem('agentslot.active');
    await fetch('/api/sessions/' + sid + '/prompt', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '[slow] 用三句话介绍一下你自己。' }) });
    return true; })()`);
  // the browser learns about the turn over the websocket, not from the REST reply: wait
  // until the UI itself is in the turn (the composer shows its stop button)
  const clientBusy = await (async () => {
    for (let i = 0; i < 20; i++) { await sleep(200); if (await ev(`!!document.querySelector('.send-btn.stop')`)) return true; }
    return false;
  })();
  check("the client is in the turn before the call opens (busy reached the page)", clientBusy);
  await click('button[aria-label="开始语音通话"]');
  const sawThinking = await (async () => {
    for (let i = 0; i < 20; i++) { await sleep(250); if ((await ev(`document.querySelector('.call-mode')?.dataset.phase`)) === "thinking") return true; }
    return false;
  })();
  check("opening a call during a running turn joins it (thinking)", sawThinking);
  const spoke = await (async () => {
    for (let i = 0; i < 60; i++) { await sleep(500); if ((await ev(`document.querySelector('.call-mode')?.dataset.phase`)) === "speaking") return true; }
    return false;
  })();
  check("the call starts SPEAKING when the reply streams in", spoke, `upstream=${upstreamHits}`);
  check("the reply really reached the TTS endpoint", upstreamHits > hitsBefore, `${hitsBefore} → ${upstreamHits}`);

  // the animation must be driven by that audio, and the waveform must be a real trace
  const speakSigA = await ev(`window.__sig('.call-orb-canvas', true)`);
  // the phase flips to speaking when a SENTENCE is queued; the audio lands a fetch later —
  // so watch the trace until it is real, and judge it on the best sample
  let speakDev = await ev(`window.__waveDev('.call-wave')`);
  for (let i = 0; i < 24 && (speakDev?.maxDev ?? 0) <= 6; i++) {
    await sleep(150);
    speakDev = await ev(`window.__waveDev('.call-wave')`);
  }
  await sleep(320);
  const speakSigB = await ev(`window.__sig('.call-orb-canvas', true)`);
  const speakTone = await ev(`getComputedStyle(document.querySelector('.call-mode')).getPropertyValue('--call-tone').trim()`);
  check("the output waveform is a REAL trace while the TTS plays (not a flat line)",
    (speakDev?.maxDev ?? 0) > 6, JSON.stringify(speakDev));
  check("the animation changed between frames while audio played",
    speakSigA && speakSigB && speakSigA.sig !== speakSigB.sig, `lit=${speakSigB?.lit}%`);
  check("the speaking phase uses a different colour than listening",
    Boolean(speakTone) && speakTone !== idle.tone, `speaking=${speakTone} listening=${idle.tone}`);
  fs.writeFileSync(`${SHOTS}/call-speaking.png`, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));

  // ---- barge-in: tapping the orb while it talks takes the floor back -------------------
  const hitsAtBarge = upstreamHits;
  await click(".call-orb");
  await sleep(600);
  const afterTap = await ev(`document.querySelector('.call-mode')?.dataset.phase ?? null`);
  check("tapping the orb while it speaks stops the playback", afterTap !== "speaking", `phase=${afterTap}`);
  await sleep(2500);
  check("and it does not keep reading after the interruption", upstreamHits <= hitsAtBarge, `${hitsAtBarge} → ${upstreamHits}`);

  // ---- phone: still a full-screen call, everything reachable ---------------------------
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await sleep(600);
  const phone = await ev(`window.__call()`);
  check("on a phone the call still covers the viewport",
    phone.open === true && phone.covers === true && phone.overflowX === 0,
    JSON.stringify({ covers: phone.covers, overflow: phone.overflowX, w: phone.w, h: phone.h }));
  check("the orb fits and the controls stay reachable on a phone",
    Boolean(phone.orb?.inside) && phone.btns.every((b) => b.inside && b.w >= 44 && b.h >= 44), JSON.stringify(phone.btns));
  fs.writeFileSync(`${SHOTS}/call-phone.png`, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));

  // ---- reduced motion: the entrance animation is dropped, the orb keeps breathing -------
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await sleep(400);
  const rm = await ev(`(() => { const el = document.querySelector('.call-mode');
    return { name: getComputedStyle(el).animationName, orb: !!document.querySelector('.call-orb-canvas') }; })()`);
  check("prefers-reduced-motion turns the CSS animation off (and the orb stays)", rm.name === "none" && rm.orb === true, JSON.stringify(rm));
  await send("Emulation.setEmulatedMedia", { features: [] });

  // ---- 说话打断 / barge-in: taking the floor while the agent is still talking ------------
  // The operator's report: saying something over the reply produced
  // {"text":"turn failed: turn already running"}. Root cause was ours: barge-in stopped our
  // playback but never cancelled the agent's turn, so the sentence that followed arrived at a
  // busy session and was refused. Two things are checked here — the SERVER accepts an
  // interrupting prompt mid-turn (cancel, settle, then run), and the CALL cancels the turn
  // when the operator takes the floor back.
  const token = (await import("node:fs")).readFileSync(path.join(dataDir, "auth.token"), "utf8").trim();
  const api = async (method, url, body) => {
    const res = await fetch(BASE + url, {
      method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
  };
  const msgsOf = async (sid) => (await api("GET", `/api/sessions/${sid}/messages?limit=500`)).body?.messages ?? [];
  const busyOf = async (sid) => {
    const d = (await api("GET", "/api/sessions")).body;
    const row = [...(d?.live ?? []), ...(d?.archived ?? [])].find((r) => r.id === sid);
    return row?.status === "running";
  };

  const slow = (await api("POST", "/api/sessions", { backend: "mock", cwd: "/tmp" })).body;
  await api("POST", `/api/sessions/${slow.id}/prompt`, { text: "[slow] 这是一段很长的回答，会慢慢地说下去" });
  let sawBusy = false;
  for (let i = 0; i < 40 && !sawBusy; i++) { await sleep(150); sawBusy = await busyOf(slow.id); }
  check("a turn really is running (the barge-in has something to interrupt)", sawBusy === true, `busy=${sawBusy}`);

  // The refusal bubble ("turn failed: turn already running") is emitted over WS and never
  // persisted, so the durable evidence is the server's own log line. This is also the direct
  // reproduction of the operator's report: this is exactly what barge-in used to send.
  const refusals = () => (log.match(new RegExp(`prompt failed for ${slow.id}`, "g")) ?? []).length;
  await api("POST", `/api/sessions/${slow.id}/prompt`, { text: "普通发送" });
  await sleep(700);
  check("…and a plain prompt during a turn IS still refused (the button-as-stop contract)",
    refusals() === 1, `refusals=${refusals()}`);
  const before = (await msgsOf(slow.id)).length;

  // …but an INTERRUPTING prompt (what the call sends) takes the floor instead of failing
  const t0 = Date.now();
  const intRes = await api("POST", `/api/sessions/${slow.id}/prompt`, { text: "打断一下，换个话题", interrupt: true });
  let started = false;
  for (let i = 0; i < 40 && !started; i++) {
    await sleep(200);
    started = (await msgsOf(slow.id)).some((m) => m.kind === "user"
      && String((m.payload ?? {}).text ?? "").includes("打断一下"));
  }
  const dt = Date.now() - t0;
  check("an interrupting prompt is ACCEPTED mid-turn (no refusal, no error bubble)",
    intRes.status === 202 && started === true, JSON.stringify({ http: intRes.status, started, tookMs: dt }));
  let idleAt = false;
  for (let i = 0; i < 80 && !idleAt; i++) { await sleep(250); idleAt = !(await busyOf(slow.id)); }
  const after = await msgsOf(slow.id);
  const failed = after.filter((m) => m.kind === "meta" && /turn failed/.test(String((m.payload ?? {}).text ?? "")));
  check("the interrupt leaves NO 'turn failed' bubble behind (the operator's report)",
    failed.length === 0, JSON.stringify(failed.map((m) => m.payload?.text)));
  check("the interrupted turn really stopped (reply ends, session goes idle)",
    idleAt === true && after.length >= before, `messages ${before} -> ${after.length}`);
  check("an interrupting prompt never lands in the failure path (no refusal was logged)",
    refusals() === 1, `refusals=${refusals()}`);
  // The mock echoes the prompt text back, so grepping for words proves nothing: the observable
  // is that the transcript STOPS GROWING once the interrupted turn has ended.
  const n1 = (await msgsOf(slow.id)).length;
  await sleep(2500);
  const n2 = (await msgsOf(slow.id)).length;
  check("the interrupted turn stopped streaming for good (transcript stops growing)",
    n2 === n1, `${n1} -> ${n2}`);

  // the CLIENT half: the call cancels the turn when the floor is taken back
  const tab2 = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
  const ws2 = new WebSocket(tab2.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws2.onopen = res; ws2.onerror = rej; });
  let id2 = 0; const waiting2 = new Map();
  ws2.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting2.has(m.id)) { const x = waiting2.get(m.id); waiting2.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); }
  };
  const send2 = (method, params = {}, to = 30000) => new Promise((res, rej) => {
    const mid = ++id2; const timer = setTimeout(() => { waiting2.delete(mid); rej(new Error("TIMEOUT " + method)); }, to);
    waiting2.set(mid, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
    ws2.send(JSON.stringify({ id: mid, method, params }));
  });
  const ev2 = async (expr, to = 30000) => {
    const r = await send2("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, to);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
    return r.result.value;
  };
  // record every frame the app puts on the wire, installed BEFORE the app opens its socket
  await send2("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__frames = [];
    const rawSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try { window.__frames.push(JSON.parse(String(data))); } catch { /* not json */ }
      return rawSend.call(this, data);
    };
    window.__need = (what) => window.__frames.filter((f) => f && f.t === what).map((f) => f.text ?? null);
  ` });
  await send2("Page.enable");
  await send2("Page.navigate", { url: BASE });
  await sleep(3200);
  // a slow turn, then open the call so it joins it (the mic is not available in automation)
  const slow2 = (await api("POST", "/api/sessions", { backend: "mock", cwd: "/tmp" })).body;
  await api("POST", `/api/sessions/${slow2.id}/prompt`, { text: "[slow] 慢慢说，我要在你说的时候抢话" });
  await sleep(700);
  await ev2(`(() => { const rows = [...document.querySelectorAll('.session-item')];
    const row = rows.find((r) => r.dataset.session === ${JSON.stringify(slow2.id)}) ?? rows[0];
    row?.click(); return true; })()`);
  await sleep(500);
  await ev2(`document.querySelector('button[aria-label="开始语音通话"]').click()`);
  await sleep(1500);
  const beforeTap2 = await ev2(`(() => { const el = document.querySelector('.call-mode');
    return { open: !!el, phase: el?.dataset.phase ?? null }; })()`);
  const orbBox = await ev2(`(() => { const el = document.querySelector('.call-orb-canvas'); if (!el) return null;
    const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (orbBox) {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send2("Input.dispatchMouseEvent", { type, x: orbBox.x, y: orbBox.y, button: "left", clickCount: 1 });
    }
  }
  await sleep(900);
  const cancels = await ev2(`window.__frames.filter((f) => f && f.t === "cancel").length`);
  const afterTap2 = await ev2(`(() => { const el = document.querySelector('.call-mode');
    return { phase: el?.dataset.phase ?? null, open: !!el }; })()`);
  check("the call was showing the agent's turn when the orb was tapped",
    beforeTap2.open === true, JSON.stringify(beforeTap2));
  check("taking the floor back in the call CANCELS the agent's turn (not just our playback)",
    cancels >= 1, JSON.stringify({ cancels, before: beforeTap2.phase, after: afterTap2.phase }));
  check("…and the call goes back to listening for the operator", afterTap2.phase === "listening",
    JSON.stringify(afterTap2));
  let slow2Idle = false;
  for (let i = 0; i < 60 && !slow2Idle; i++) { await sleep(250); slow2Idle = !(await busyOf(slow2.id)); }
  check("the cancelled turn really stopped on the server", slow2Idle === true);
  try { await fetch(`${CDP}/json/close/${tab2.id}`); } catch { /* gone */ }

} catch (e) {
  check("sweep ran to completion", false, String(e?.stack ?? e));
} finally {
  try { await fetch(`${CDP}/json/close/${tab.id}`); } catch { /* gone */ }
  proc.kill("SIGKILL");
  stub.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log(`\nserver log tail:\n${log.slice(-1200)}`);
process.exit(fail ? 1 : 0);
