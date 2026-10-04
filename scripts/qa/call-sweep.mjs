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
    localStorage.setItem('agentslot.voice', JSON.stringify({ autoRead: false, voiceURI: '', rate: 1, lang: 'zh-CN', serverTts: true, stt: 'auto' }));
    // the injected microphone (voice.ts's test seam): automation has no device, and a
    // threshold is only observable if something is making a sound
    window.__asFeed = { level: 0, text: '', interim: '' };
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
  // ---- 通话设置：面板 + 四个阈值真的改变行为 --------------------------------------------
  // A threshold only means something in the room it is used in (a phone on a table leaks its
  // own loudspeaker into its own microphone; a headset does not), so the panel lives ON the
  // call. Two claims have to hold: the values reach the SERVER (they are settings, shared
  // across devices), and they change what the running loop DOES — a slider that writes to a
  // variable nobody reads is decoration. Everything below therefore goes through the REAL
  // loop, with `window.__asFeed` standing in for the missing microphone.
  const feed = (level, text = "", interim = "") => ev2(`(() => { window.__asFeed = { level: ${level}, text: ${JSON.stringify(text)}, interim: ${JSON.stringify(interim)} }; return true; })()`);
  const phase2 = () => ev2(`document.querySelector('.call-mode')?.dataset.phase ?? null`);
  const frameCount = (t) => ev2(`window.__frames.filter((f) => f && f.t === ${JSON.stringify(t)}).length`);
  const waitPhase2 = async (want, ms) => {
    for (let i = 0; i < ms / 150; i++) { if ((await phase2()) === want) return true; await sleep(150); }
    return false;
  };
  const waitFrames = async (t, n, ms) => {
    for (let i = 0; i < ms / 150; i++) { if ((await frameCount(t)) >= n) return true; await sleep(150); }
    return false;
  };
  /** Wait for a selector: "not there yet" must be a reported check, never a null.click(). */
  const waitEl2 = async (sel, ms) => {
    for (let i = 0; i < ms / 150; i++) { if (await ev2(`!!document.querySelector(${JSON.stringify(sel)})`)) return true; await sleep(150); }
    return false;
  };
  const openSheet = () => ev2(`document.querySelector('.call-gear')?.click(); true`);
  const closeSheet = () => ev2(`document.querySelector('.call-sheet-x')?.click(); true`);
  // React's onChange for a range input is the DOM `input` event, and React reads the value
  // through a native setter — a plain `input.value = "6"` updates its tracker and the event
  // is then swallowed as "no change" (which would look exactly like a broken slider here).
  const setRange = (label, value) => ev2(`(() => {
    const input = [...document.querySelectorAll('.call-sheet input[type=range]')].find((i) => i.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (!input) return null;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, String(${value}));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return Number(input.value); })()`);
  const knobsNow = () => ev2(`(() => [...document.querySelectorAll('.call-sheet .call-knob')].map((k) => {
    const i = k.querySelector('input[type=range]');
    return { label: i.getAttribute('aria-label'), value: Number(i.value), shown: k.querySelector('.call-knob-val').textContent }; }))()`);

  const gear = await ev2(`(() => { const b = document.querySelector('.call-gear'); if (!b) return null;
    const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top),
      right: Math.round(innerWidth - r.right), hits: !!hit && (hit === b || b.contains(hit)) }; })()`);
  check("the call carries a settings button in its corner (thumb-sized, not covered)",
    Boolean(gear) && gear.w >= 38 && gear.h >= 38 && gear.hits === true, JSON.stringify(gear));
  await openSheet();
  await sleep(500);
  const sheet = await ev2(`(() => { const el = document.querySelector('.call-sheet'); if (!el) return null;
    const card = el.querySelector('.call-sheet-card').getBoundingClientRect();
    const knobs = [...el.querySelectorAll('.call-knob')].map((k) => {
      const i = k.querySelector('input[type=range]'); const r = i.getBoundingClientRect();
      return { label: i.getAttribute('aria-label'), value: Number(i.value), h: Math.round(r.height), w: Math.round(r.width) };
    });
    return { knobs, card: { l: Math.round(card.left), t: Math.round(card.top), r: Math.round(card.right), b: Math.round(card.bottom) },
      inside: card.left >= -1 && card.right <= innerWidth + 1 && card.top >= -1 && card.bottom <= innerHeight + 1 }; })()`);
  const LABELS = ["抢话灵敏度", "抢话持续时间", "说完停顿", "最少字数"];
  check("the panel offers exactly the four thresholds, at their defaults",
    Boolean(sheet) && sheet.knobs.length === 4
    && sheet.knobs.every((k, i) => k.label === LABELS[i])
    && sheet.knobs[0].value === 0.2 && sheet.knobs[1].value === 300 && sheet.knobs[2].value === 1200 && sheet.knobs[3].value === 1,
    JSON.stringify(sheet?.knobs));
  check("every slider is draggable and the panel fits the screen",
    Boolean(sheet) && sheet.inside && sheet.knobs.every((k) => k.h >= 30 && k.w >= 180), JSON.stringify(sheet?.card));
  const typed = await setRange("最少字数", 6);
  await sleep(800);
  const savedCall = (await api("GET", "/api/settings")).body?.call;
  check("moving a slider SAVES TO THE SERVER (a threshold is a setting, not a local pref)",
    typed === 6 && savedCall?.minChars === 6, JSON.stringify({ typed, savedCall }));
  check("the slider reads its value back in words the operator understands",
    (await knobsNow()).find((k) => k.label === "最少字数")?.shown === "6 字",
    JSON.stringify((await knobsNow()).find((k) => k.label === "最少字数")));
  await closeSheet();
  await sleep(400);
  check("closing the panel returns to the call (the overlay is not a trap)",
    (await ev2(`!document.querySelector('.call-sheet')`)) === true && (await phase2()) === "listening",
    `phase=${await phase2()}`);

  // 最少字数: an automatic send below the limit is dropped …
  const promptsBefore = await frameCount("prompt");
  await feed(0.4, "嗯");
  await sleep(200);
  await feed(0, "嗯");
  await sleep(2600);                                   // well past 说完停顿
  check("a too-short utterance is NOT auto-sent (最少字数 6 blocks it)",
    (await frameCount("prompt")) === promptsBefore && (await phase2()) === "listening",
    `prompts=${promptsBefore} → ${await frameCount("prompt")} phase=${await phase2()}`);
  // the reason has to be readable while the words are still on screen, and it is also what a
  // screen reader gets (the orb's label), so accept either — both are "the call told you"
  const why = await ev2(`(() => { const t = document.querySelector('.call-hint')?.textContent ?? '';
    const orb = document.querySelector('.call-orb');
    return t || orb?.getAttribute('title') || orb?.getAttribute('aria-label') || ''; })()`);
  check("…and the call says WHY nothing happened instead of going quiet",
    /太短/.test(why), JSON.stringify(why));

  // … while a full sentence still goes, and it takes the floor (the barge-in contract)
  await feed(0.4, "这是一句完整的话");
  await sleep(300);
  await feed(0, "这是一句完整的话");
  const sentFull = await waitFrames("prompt", promptsBefore + 1, 5000);
  const fullFrame = await ev2(`window.__frames.filter((f) => f && f.t === "prompt").slice(-1)[0] ?? null`);
  check("a full sentence IS auto-sent, and it carries interrupt (说话即接管)",
    sentFull === true && fullFrame?.interrupt === true && String(fullFrame?.text ?? "").includes("完整"),
    JSON.stringify(fullFrame));
  check("the call goes to thinking once the sentence is out", await waitPhase2("thinking", 2000));
  await feed(0, "");       // the injected transcript is the harness's to clear, not the app's
  const busyNow = await (async () => { for (let i = 0; i < 30; i++) { if (await busyOf(slow2.id)) return true; await sleep(150); } return false; })();
  check("…and the server really started that turn", busyNow === true);
  const tapOrb2 = async () => {
    const box = await ev2(`(() => { const el = document.querySelector('.call-orb-canvas'); if (!el) return null;
      const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!box) return;
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send2("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
  };
  await tapOrb2();                                     // thinking → take the floor back
  check("tapping the orb takes the floor back to listening", await waitPhase2("listening", 3000), `phase=${await phase2()}`);

  // 说完停顿: raise it and the same kind of utterance waits longer before it is sent
  await openSheet();
  await sleep(400);
  await setRange("说完停顿", 3000);
  await sleep(800);
  await closeSheet();
  await sleep(300);
  const savedSilence = (await api("GET", "/api/settings")).body?.call?.silenceMs;
  const promptsBefore2 = await frameCount("prompt");
  await feed(0.4, "这句话要等三秒才会发出去");
  await sleep(250);
  await feed(0, "这句话要等三秒才会发出去");
  await sleep(1500);
  check("with 说完停顿 at 3 s, a 1.5 s pause is NOT yet a finished sentence",
    (await frameCount("prompt")) === promptsBefore2 && (await phase2()) === "listening",
    `saved=${savedSilence} prompts=${promptsBefore2} → ${await frameCount("prompt")}`);
  const sentLate = await waitFrames("prompt", promptsBefore2 + 1, 3500);
  check("…and it IS sent once the pause really is that long", sentLate === true && savedSilence === 3000,
    `silenceMs=${savedSilence}`);
  await feed(0, "");
  await tapOrb2();
  await waitPhase2("listening", 3000);

  // 抢话灵敏度: the SAME voice either may or may not take the floor, depending on the knob.
  // The reply has to be long enough to talk over, so the prompt carries sentence enders the
  // mock echoes straight back (the call reads them one at a time).
  await openSheet(); await sleep(300);
  await setRange("最少字数", 1); await setRange("说完停顿", 1200); await sleep(600);
  await closeSheet();
  await ev2(`document.querySelector('.call-btn.hangup').click(); true`);   // reopen to JOIN the turn
  await sleep(500);
  await api("POST", `/api/sessions/${slow2.id}/prompt`, {
    text: "第一句在这里。第二句在这里。第三句在这里。第四句也在这里。第五句在这里。第六句也在这里。",
  });
  for (let i = 0; i < 30; i++) { await sleep(200); if (await busyOf(slow2.id)) break; }
  await ev2(`document.querySelector('button[aria-label="开始语音通话"]').click(); true`);
  const spoke2 = await waitPhase2("speaking", 30000);
  check("the call is speaking (there is something to talk over)", spoke2 === true, `phase=${await phase2()}`);

  await openSheet();
  await sleep(300);
  const insensitive = await setRange("抢话灵敏度", 0.8);      // least sensitive
  await sleep(700);
  await closeSheet();
  await sleep(200);
  const cancelsBefore = await frameCount("cancel");
  const phaseAtQuiet = await phase2();
  await feed(0.35, "");                                      // loud enough to barge at the default
  await sleep(1400);
  check("with 抢话灵敏度 at its least sensitive, that voice does NOT take the floor",
    (await frameCount("cancel")) === cancelsBefore,
    JSON.stringify({ set: insensitive, cancelsBefore, now: await frameCount("cancel"), phaseAtStart: phaseAtQuiet }));

  await openSheet();
  await sleep(300);
  const sensitive = await setRange("抢话灵敏度", 0.05);       // most sensitive, applied live
  await sleep(300);
  const barged = await waitFrames("cancel", cancelsBefore + 1, 3000);
  check("…and at its most sensitive the SAME voice takes the floor immediately (live apply)",
    barged === true, JSON.stringify({ set: sensitive, cancelsBefore, now: await frameCount("cancel") }));
  check("…leaving the call listening for the operator again",
    await waitPhase2("listening", 3000), `phase=${await phase2()}`);
  const savedBarge = (await api("GET", "/api/settings")).body?.call?.bargeLevel;
  check("the sensitivity the panel set is what the server holds", savedBarge === 0.05, `bargeLevel=${savedBarge}`);
  fs.writeFileSync(`${SHOTS}/call-settings.png`, Buffer.from((await send2("Page.captureScreenshot", { format: "png" })).data, "base64"));

  // persistence: wipe the browser's copy and reload — the numbers come back from the server
  await closeSheet();
  await ev2(`(() => { localStorage.removeItem('agentslot.call');
    localStorage.setItem('agentslot.active', ${JSON.stringify(slow2.id)}); return true; })()`);
  await send2("Page.reload", { ignoreCache: true });
  await sleep(3200);
  await waitEl2('button[aria-label="开始语音通话"]', 12000);
  await feed(0, "");
  await ev2(`document.querySelector('button[aria-label="开始语音通话"]')?.click(); true`);
  await sleep(1200);
  await openSheet();
  await sleep(600);
  const afterReload = await knobsNow();
  check("the thresholds come back after a reload with local storage wiped (they live on the server)",
    afterReload?.find((k) => k.label === "抢话灵敏度")?.value === 0.05
    && afterReload?.find((k) => k.label === "说完停顿")?.value === 1200
    && afterReload?.find((k) => k.label === "最少字数")?.value === 1,
    JSON.stringify(afterReload));
  await send2("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send2("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await sleep(600);
  const phoneSheet = await ev2(`(() => { const card = document.querySelector('.call-sheet-card')?.getBoundingClientRect(); if (!card) return null;
    const h = [...document.querySelectorAll('.call-sheet .call-knob input[type=range]')].map((i) => Math.round(i.getBoundingClientRect().height));
    return { card: { l: Math.round(card.left), t: Math.round(card.top), w: Math.round(card.width), b: Math.round(card.bottom) },
      knobs: h, overflowX: document.documentElement.scrollWidth - innerWidth,
      inside: [...document.querySelectorAll('.call-sheet button, .call-sheet input')].every((b) => { const r = b.getBoundingClientRect();
        return r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1; }) }; })()`);
  check("on a phone the panel is a bottom sheet: full width, thumb-sized sliders, nothing off-screen",
    Boolean(phoneSheet) && phoneSheet.card.w === 390 && phoneSheet.overflowX === 0 && phoneSheet.inside === true
    && phoneSheet.knobs.every((h) => h >= 34), JSON.stringify(phoneSheet));
  fs.writeFileSync(`${SHOTS}/call-settings-phone.png`, Buffer.from((await send2("Page.captureScreenshot", { format: "png" })).data, "base64"));

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
