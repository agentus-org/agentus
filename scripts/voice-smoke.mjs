// Voice + settings smoke — the surface the night build added, with no real provider
// involved: a throwaway OpenAI-compatible endpoint stands in for 百炼 (and for any other
// operator endpoint), so CI can assert the router, the guards and the secret handling.
//
//   node scripts/voice-smoke.mjs
//
// Self-contained like auth-smoke / workspace-smoke: its own server on a scratch port with
// a throwaway data dir, plus its own HTTP stand-in for the voice provider.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createTcp } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { WebSocket, WebSocketServer } from "ws";

const ROOT = path.resolve(import.meta.dirname, "..");

/** Killing the `tsx` WRAPPER is not killing the server: tsx runs the app as its own child, and
 *  a bare SIGKILL to the wrapper leaves that child listening on a random port for good. That is
 *  exactly how a couple of hundred dead servers piled up on the dev machine. `detached: true`
 *  makes the child a process-group leader, so one negative-pid signal takes the whole tree. */
const killGroup = (target) => {
  const pid = typeof target === "number" ? target : target?.pid;
  if (!pid) return;
  try { process.kill(-pid, "SIGKILL"); } catch { try { killGroup(pid); } catch { /* already gone */ } }
};

const PORT = await freePort();   // never a guessed port: see freePort() above
const results = [];
let failed = 0;

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ask the OS for a port that is actually free. A guessed/fixed range collides with a server
 *  leaked by an earlier crashed run: the stale listener answers /healthz instantly, so the
 *  suite silently talks to the WRONG process and dies with something cryptic ("no machine
 *  token"). We also kill every child on exit, so we never become the leaker ourselves. */
async function freePort() {
  return new Promise((res, rej) => {
    const s = createTcp();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}
async function freePorts(n) { const out = new Set(); while (out.size < n) out.add(await freePort()); return [...out]; }
function portInUse(port) {
  return new Promise((res) => {
    const s = createTcp();
    s.once("error", () => res(true));
    s.once("listening", () => s.close(() => res(false)));
    s.listen(port, "127.0.0.1");
  });
}
const CHILDREN = new Set();
process.on("exit", () => { for (const c of CHILDREN) { try { killGroup(c); } catch { /* already gone */ } } });


// ---- the stand-in provider -------------------------------------------------
// Two of the three routes are OpenAI-compatible; /models is what fills the settings
// dropdowns, and it deliberately advertises one non-audio model so the classifier is
// exercised rather than assumed.
const seen = { ttsBodies: [], sttCalls: 0, auth: [], asrBodies: [] };
const provider = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    seen.auth.push(String(req.headers.authorization ?? ""));
    if (req.url?.startsWith("/v1/audio/speech")) {
      seen.ttsBodies.push(body.toString("utf8"));
      const fake = Buffer.from("ID3fake-mp3-bytes");
      res.writeHead(200, { "content-type": "audio/mpeg", "content-length": String(fake.length) });
      res.end(fake);
      return;
    }
    if (req.url?.startsWith("/v1/audio/transcriptions")) {
      seen.sttCalls += 1;
      const utf8 = body.toString("latin1");
      const model = /name="model"\r?\n\r?\n([^\r]+)/.exec(utf8)?.[1] ?? "?";
      const say = /filename="([^"]+)"/.exec(utf8)?.[1] ?? "?";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: `heard ${say} via ${model}` }));
      return;
    }
    // 百炼's native speech-synthesis shape: the audio comes back as a short-lived URL
    if (req.url?.startsWith("/api/v1/services/audio/tts/SpeechSynthesizer")) {
      seen.ttsBodies.push(body.toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output: { audio: { url: `http://127.0.0.1:${providerPort}/audio-out.wav`, expires_at: Date.now() + 86_400_000 } } }));
      return;
    }
    if (req.url?.startsWith("/audio-out.wav")) {
      const wav = Buffer.from("RIFFfake-wav-bytes");
      res.writeHead(200, { "content-type": "audio/x-wav", "content-length": String(wav.length) });
      res.end(wav);
      return;
    }
    // 百炼's OpenAI-compatible routes (batch ASR + the model list)
    if (/\/compatible-mode\/v1\/chat\/completions/.test(req.url ?? "")) {
      seen.asrBodies.push(body.toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "百炼听写结果" } }] }));
      return;
    }
    if (/\/compatible-mode\/v1\/models/.test(req.url ?? "")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "qwen-audio-3.1-asr-flash-streaming" }, { id: "qwen-audio-3.0-tts-flash" }, { id: "qwen3-asr-flash" }] }));
      return;
    }
    if (req.url?.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        data: [
          { id: "qwen3-asr-flash" },
          { id: "qwen-audio-3.0-tts-flash" },
          { id: "qwen3-tts-instruct-flash" },
          { id: "qwen3.8-flash" },
        ],
      }));
      return;
    }
    res.writeHead(404).end("{}");
  });
});
const providerPort = await new Promise((resolve) => {
  provider.listen(0, "127.0.0.1", () => resolve(provider.address().port));
});

// ---- the stand-in streaming synthesiser -------------------------------------
// The real /api-ws/v1/inference protocol, faked: run-task -> task-started -> one
// result-generated + one binary PCM frame per text unit -> task-finished, and a cancel
// directive answered with task-finished and no further audio. That is the whole contract the
// relay depends on, so the suite can assert it without a provider key and without billing.
const wsSeen = { run: 0, texts: [], cancels: 0, finished: 0, socketAuth: [], sockets: 0, params: [], failed: 0 };
/** Delay the upstream handshake, to test what happens when stop lands while the relay is still
 *  dialling (the real dial costs 200-650 ms). */
let wsDialDelayMs = 0;
/** Delay the cancel acknowledgement, to prove the frame-drop window ends on the next task's
 *  `task-started` and not on a timer that the next sentence's own audio would have to outrun. */
let wsCancelAckDelayMs = 0;
const fakeUpstream = new WebSocketServer({ noServer: true });
provider.on("upgrade", (req, socket, head) => {
  if (!String(req.url ?? "").startsWith("/api-ws/v1/inference")) { socket.destroy(); return; }
  const go = () => fakeUpstream.handleUpgrade(req, socket, head, (ws) => fakeUpstream.emit("connection", ws, req));
  if (wsDialDelayMs) setTimeout(go, wsDialDelayMs); else go();
});
fakeUpstream.on("connection", (sock, req) => {
  wsSeen.sockets += 1;
  wsSeen.socketAuth.push(String(req.headers.authorization ?? ""));
  let taskId = "";
  let cancelled = false;
  const send = (obj) => { try { sock.send(JSON.stringify(obj)); } catch { /* gone */ } };
  const pcm = () => {
    // 240 samples of a quiet tone at 24 kHz: real s16le, not filler bytes, so the relay
    // forwards something a decoder can actually turn into sound.
    const buf = Buffer.alloc(480);
    for (let i = 0; i < 240; i++) buf.writeInt16LE(Math.round(Math.sin((i / 240) * Math.PI * 4) * 3000), i * 2);
    return buf;
  };
  sock.on("message", (raw, isBinary) => {
    if (isBinary) return;
    const msg = JSON.parse(String(raw));
    const action = msg.header?.action;
    if (action === "run-task") {
      wsSeen.run += 1;
      taskId = msg.header.task_id;
      wsSeen.params.push(msg.payload?.parameters ?? {});
      send({ header: { task_id: taskId, event: "task-started", attributes: {} }, payload: {} });
      return;
    }
    if (action === "continue-task") {
      const text = String(msg.payload?.input?.text ?? "");
      wsSeen.texts.push(text);
      if (cancelled) return;
      if (/上游失败/.test(text)) {
        // The shape a real provider failure takes mid-stream: some audio, then task-failed.
        wsSeen.failed += 1;
        try { sock.send(pcm()); } catch { /* gone */ }
        send({ header: { task_id: taskId, event: "task-failed", error_message: "synthetic upstream failure", attributes: {} }, payload: {} });
        return;
      }
      send({ header: { task_id: taskId, event: "result-generated", attributes: {} },
        payload: { output: { type: "sentence-begin", original_text: text, sentence: { index: 0, words: [] } } } });
      send({ header: { task_id: taskId, event: "result-generated", attributes: {} },
        payload: { output: { type: "sentence-end", original_text: text, sentence: { index: 0, words: [] } }, usage: { characters: text.length } } });
      try { sock.send(pcm()); } catch { /* gone */ }
      return;
    }
    if (action === "finish-task") {
      if (msg.payload?.input?.directive === "cancel") {
        cancelled = true;
        wsSeen.cancels += 1;
        // A frame of the cancelled sentence, still in flight when the cancel arrives. It must
        // NOT reach the page: it belongs to a task nobody will hear.
        try { sock.send(pcm()); } catch { /* gone */ }
        const ack = () => send({ header: { task_id: taskId, event: "task-finished", attributes: {} }, payload: { output: {}, usage: {} } });
        if (wsCancelAckDelayMs) setTimeout(ack, wsCancelAckDelayMs); else ack();
        return;
      }
      wsSeen.finished += 1;
      // The tail frame only for a real finish: a cancel must produce no further audio.
      send({ header: { task_id: taskId, event: "result-generated", attributes: {} },
        payload: { output: { type: "sentence-synthesis", sentence: { index: 0, words: [] } } } });
      try { sock.send(pcm()); } catch { /* gone */ }
      send({ header: { task_id: taskId, event: "task-finished", attributes: {} }, payload: { output: {}, usage: { characters: 7 } } });
      return;
    }
  });
});
const PROVIDER = `http://127.0.0.1:${providerPort}/v1`;

const procs = [];

/** Boot the server. `home` matters: settings.ts falls back to reading ~/.hermes/.env, so
 *  a test that inherits the operator's real home is not a test of the empty case. */
async function boot(dataDir, extraEnv = {}, home = "") {
  const port = Number(extraEnv.AGENTUS_PORT ?? PORT);
  if (await portInUse(port)) {
    throw new Error(`port ${port} is already in use — a leaked server from an earlier run? `
      + `(lsof -nP -iTCP:${port} -sTCP:LISTEN)`);
  }
  const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
    detached: true,
    cwd: ROOT,
    env: {
      ...process.env, NODE_ENV: "development", AGENTUS_PORT: String(port), AGENTUS_DATA: dataDir,
      ...(home ? { HOME: home } : {}),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  CHILDREN.add(proc);
  let log = "";
  procs.push(proc);
  proc.stdout.on("data", (d) => { log += String(d); });
  proc.stderr.on("data", (d) => { log += String(d); });
  // Wait for THIS child to own the port (its own boot line). Probing the port instead is
  // what made the leaked-server collision look like a credential bug: a stale listener
  // answers /healthz, and the suite then reads its own empty data dir.
  for (let i = 0; i < 80 && !log.includes(`0.0.0.0:${port}`); i++) {
    if (proc.exitCode !== null) throw new Error(`server exited (${proc.exitCode}) before listening on ${port}:\n${log}`);
    await sleep(150);
  }
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return { proc, base, log: () => log };
    } catch { /* not up yet */ }
    await sleep(250);
  }
  killGroup(proc);
  throw new Error(`server never came up on ${port}:\n${log}`);
}

function tokenFor(dataDir) {
  const file = path.join(dataDir, "auth.token");
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(file)) {
      const tok = fs.readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).pop();
      if (tok) return tok;
    }
    // no sleep: the file is written before listen; a tight loop over readFileSync is fine
  }
  throw new Error("no machine token");
}

const emptyHome = mkdtempSync(path.join(tmpdir(), "agentus-home-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agentus-voice-"));
const { proc, base, log } = await boot(dataDir, {}, emptyHome);
const token = tokenFor(dataDir);
const H = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const get = async (p) => {
  const res = await fetch(base + p, { headers: H });
  return { status: res.status, body: await res.json().catch(() => null), raw: res };
};

try {
  // ---- 1. defaults: no provider configured, nothing leaks ----
  const s0 = await get("/api/settings");
  check("GET /api/settings answers", s0.status === 200, `status ${s0.status}`);
  check("defaults carry a theme", Boolean(s0.body?.theme), JSON.stringify(s0.body?.theme));
  // The shipped default is 百炼 with no credentials: the page states the intent, and the
  // capability probe tells the truth (no key => the browser does the work).
  check("default provider is 百炼, unconfigured", s0.body?.provider === "dashscope" && s0.body?.apiKeySet === false, `provider=${s0.body?.provider} keySet=${s0.body?.apiKeySet}`);
  check("default ASR models are the 百炼 ones", s0.body?.asrModel === "qwen-audio-3.1-asr-flash-streaming" && s0.body?.asrBatchModel === "qwen3-asr-flash");
  check("default TTS voice is 龙安欢", s0.body?.ttsVoice === "longanhuan_v3.6" && s0.body?.ttsModel === "qwen-audio-3.0-tts-flash");
  // mp3, not wav: the same 84-character reply measured 664 KB of wav versus 193 KB of mp3, and
  // the operator is often on a phone or through a tunnel where those bytes are the wait.
  check("the shipped synthesis format is mp3 (wav is 3× the bytes for the same audio)",
    s0.body?.defaults?.ttsFormat === "mp3", `ttsFormat=${s0.body?.ttsFormat}`);
  check("settings body carries no key material", !/sk-/.test(JSON.stringify(s0.body)), "");

  const caps0 = await get("/api/voice");
  check("voice caps say the server has no STT yet", caps0.body?.stt?.server === false && caps0.body?.stt?.streaming === false);
  const tts0 = await fetch(`${base}/api/tts`, { method: "POST", headers: H, body: JSON.stringify({ text: "hi" }) });
  check("POST /api/tts is 501 when nothing is configured", tts0.status === 501, `status ${tts0.status}`);

  // ---- 2. theme: round trip + validation ----
  const t1 = await fetch(`${base}/api/settings`, { method: "PUT", headers: H, body: JSON.stringify({ theme: { mode: "dark", accent: "#4ec9a0" } }) });
  const t1b = await t1.json();
  check("theme saves", t1.status === 200 && t1b.theme.mode === "dark" && t1b.theme.accent === "#4ec9a0", JSON.stringify(t1b.theme));
  const t2 = await fetch(`${base}/api/settings`, { method: "PUT", headers: H, body: JSON.stringify({ theme: { mode: "light" } }) });
  check("partial theme update keeps the accent", (await t2.json()).theme.accent === "#4ec9a0");
  const t3 = await fetch(`${base}/api/settings`, { method: "PUT", headers: H, body: JSON.stringify({ theme: { mode: "sepia" } }) });
  check("an unknown theme mode is rejected", t3.status === 400, `status ${t3.status}`);
  const t4 = await fetch(`${base}/api/settings`, { method: "PUT", headers: H, body: JSON.stringify({ theme: { accent: "red" } }) });
  check("a non-hex accent is rejected", t4.status === 400, `status ${t4.status}`);
  const t5 = await fetch(`${base}/api/settings`, { method: "PUT", headers: H, body: JSON.stringify({ theme: { accent: "" } }) });
  check("an empty accent clears back to the default", (await t5.json()).theme.accent === "");

  // ---- 2b. the talk-to-agent prefs: the operator's own setup, now server-side ----
  // (read-aloud switch, voice, speed, recogniser). These used to be browser-local, which meant
  // a phone and a laptop disagreed about them — and a second tab of one instance disagreed
  // with the first. They are settings like the rest: stored here, validated here.
  const p1 = await fetch(`${base}/api/settings`, {
    method: "PUT", headers: H,
    body: JSON.stringify({ prefs: { autoRead: true, rate: 1.5, lang: "zh-CN", serverTts: true, stt: "stream", voiceURI: "Microsoft Xiaoxiao" } }),
  });
  const p1b = await p1.json();
  check("prefs save (自动朗读 / voice / rate / recogniser)",
    p1.status === 200 && p1b.prefs?.autoRead === true && p1b.prefs?.rate === 1.5 && p1b.prefs?.stt === "stream" && p1b.prefs?.voiceURI === "Microsoft Xiaoxiao",
    JSON.stringify(p1b.prefs));
  const p2 = await fetch(`${base}/api/settings`, { method: "PUT", headers: H, body: JSON.stringify({ prefs: { rate: 9 } }) });
  check("an out-of-range speech rate is rejected", p2.status === 400, `status ${p2.status}`);
  const p3 = await fetch(`${base}/api/settings`, { method: "PUT", headers: H, body: JSON.stringify({ prefs: { stt: "telepathy" } }) });
  check("an unknown recogniser is rejected", p3.status === 400, `status ${p3.status}`);
  const p4 = await fetch(`${base}/api/settings`, { method: "PUT", headers: H, body: JSON.stringify({ prefs: { autoRead: "yes" } }) });
  check("a non-boolean switch is rejected", p4.status === 400, `status ${p4.status}`);
  const p5 = await get("/api/settings");
  check("a rejected write leaves the stored prefs alone", p5.body?.prefs?.autoRead === true && p5.body?.prefs?.rate === 1.5, JSON.stringify(p5.body?.prefs));
  check("the prefs ship with their defaults", p5.body?.prefsDefaults?.autoRead === false && p5.body?.prefsDefaults?.stt === "auto", JSON.stringify(p5.body?.prefsDefaults));

  // ---- 3. provider + key: the settings page's whole job ----
  const bad = await fetch(`${base}/api/settings`, { method: "PUT", headers: H, body: JSON.stringify({ voice: { provider: "nope" } }) });
  check("an unknown provider is rejected", bad.status === 400, `status ${bad.status}`);
  const badKey = await fetch(`${base}/api/settings`, { method: "PUT", headers: H, body: JSON.stringify({ voice: { apiKey: "hunter2" } }) });
  check("a key that is not sk-… is rejected", badKey.status === 400, `status ${badKey.status}`);

  const put = await fetch(`${base}/api/settings`, {
    method: "PUT",
    headers: H,
    body: JSON.stringify({ voice: { provider: "openai", baseUrl: PROVIDER, apiKey: "sk-test-abc123", asrBatchModel: "qwen3-asr-flash", ttsModel: "qwen-audio-3.0-tts-flash", ttsVoice: "longanhuan_v3.6", hotwords: ["Agentus=5", "ACP"] } }),
  });
  const putBody = await put.json();
  check("provider + endpoint + key save", put.status === 200 && putBody.provider === "openai", `status ${put.status}`);
  check("the key is reported as set, masked", putBody.apiKeySet === true && /^••••/.test(putBody.apiKeyMasked), putBody.apiKeyMasked);
  check("the raw key never comes back", !putBody.apiKeyMasked.includes("sk-test") && !JSON.stringify(putBody).includes("sk-test"));

  const caps1 = await get("/api/voice");
  check("caps follow the settings page", caps1.body?.provider === "openai" && caps1.body?.tts?.server === true && caps1.body?.stt?.server === true);
  check("streaming stays off for an OpenAI-compatible endpoint", caps1.body?.stt?.streaming === false);

  // ---- 4. the two directions through the router ----
  const tts = await fetch(`${base}/api/tts`, { method: "POST", headers: H, body: JSON.stringify({ text: "读这一句", voice: "longanhuan_v3.6" }) });
  const ttsBytes = Buffer.from(await tts.arrayBuffer());
  check("POST /api/tts returns audio from the provider", tts.status === 200 && tts.headers.get("content-type") === "audio/mpeg" && ttsBytes.length > 4, `${tts.status} ${tts.headers.get("content-type")} ${ttsBytes.length}B`);
  check("the provider was called with our model + voice", seen.ttsBodies.some((b) => b.includes("qwen-audio-3.0-tts-flash") && b.includes("longanhuan_v3.6")), seen.ttsBodies[0]?.slice(0, 90) ?? "(no body)");
  check("the provider saw our key, not the browser's", seen.auth.every((a) => a.startsWith("Bea")), seen.auth[seen.auth.length - 1] ?? "");

  const stt = await fetch(`${base}/api/stt`, { method: "POST", headers: { ...H, "content-type": "audio/webm" }, body: Buffer.from("fake-webm-audio") });
  const sttBody = await stt.json();
  check("POST /api/stt returns a transcript", stt.status === 200 && /heard/.test(String(sttBody.text ?? "")), JSON.stringify(sttBody).slice(0, 90));
  check("the upload carried the batch model", seen.sttCalls === 1 && /qwen3-asr-flash/.test(JSON.stringify(sttBody)));

  const empty = await fetch(`${base}/api/stt`, { method: "POST", headers: { ...H, "content-type": "audio/webm" }, body: Buffer.alloc(0) });
  check("an empty recording is refused", empty.status === 400, `status ${empty.status}`);

  // ---- 5. the model list comes from the operator's endpoint ----
  const models = await get("/api/voice/models");
  check("GET /api/voice/models lists the endpoint's models", models.status === 200 && models.body?.total === 4, `status ${models.status} total ${models.body?.total}`);
  check("audio models are classified, the rest dropped", models.body?.asr?.includes("qwen3-asr-flash") && models.body?.tts?.includes("qwen-audio-3.0-tts-flash") && !models.body?.asr?.includes("qwen3.8-flash"), JSON.stringify({ asr: models.body?.asr, tts: models.body?.tts }));

  // ---- 6. hotwords: fixed parses, dynamic is on by default ----
  const hot = await get("/api/voice/hotwords");
  const fixed = (hot.body?.words ?? []).filter((w) => w.origin === "fixed");
  check("fixed hotwords are carried with their weights", hot.status === 200 && fixed.length === 2 && fixed.some((w) => w.word === "Agentus" && w.weight === 5), JSON.stringify(hot.body?.words ?? []).slice(0, 120));
  check("dynamic extraction is on by default", hot.body?.words?.every((w) => w.origin === "fixed"), "no transcript yet");

  const limit = await fetch(`${base}/api/settings`, { method: "PUT", headers: H, body: JSON.stringify({ voice: { hotwords: ["a", "b", "c", "d"], hotwordLimit: 2 } }) });
  check("hotword limit saves", limit.status === 200);
  const hot2 = await get("/api/voice/hotwords");
  check("the limit caps what a request would carry", (hot2.body?.words ?? []).length <= 2, JSON.stringify(hot2.body?.words ?? []));

  // ---- 7. the streaming socket refuses when it cannot stream ----
  const wsErr = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/asr?token=${encodeURIComponent(token)}`);
    const done = (v) => { try { ws.close(); } catch { /* noop */ } resolve(v); };
    ws.on("message", (raw) => done(JSON.parse(String(raw)).t));
    ws.on("error", (e) => done(`error:${e.message}`));
    setTimeout(() => done("timeout"), 6000);
  });
  check("streaming ASR answers asr-error when unconfigured", wsErr === "asr-error", String(wsErr));

  // ---- 8. a bad endpoint fails loudly, not silently ----
  await fetch(`${base}/api/settings`, { method: "PUT", headers: H, body: JSON.stringify({ voice: { baseUrl: "http://127.0.0.1:9/v1" } }) });
  const dead = await fetch(`${base}/api/tts`, { method: "POST", headers: H, body: JSON.stringify({ text: "hi" }) });
  check("an unreachable endpoint surfaces as 502", dead.status === 502, `status ${dead.status}`);
  const deadModels = await get("/api/voice/models");
  check("an unreachable endpoint fails the model list too", deadModels.status === 502, `status ${deadModels.status}`);

  // ---- 9. the env bootstrap: this is how the operator's own machine is set up
  //         (DASHSCOPE_* in ~/.hermes/.env), and it must work with no page visit at all.
  killGroup(proc);
  const home2 = mkdtempSync(path.join(tmpdir(), "agentus-home-env-"));
  fs.mkdirSync(path.join(home2, ".hermes"), { recursive: true });
  fs.writeFileSync(path.join(home2, ".hermes", ".env"), `DASHSCOPE_API_KEY=sk-env-abcdef123\nDASHSCOPE_BASE_URL=http://127.0.0.1:${providerPort}/\n`);
  const dataDir2 = mkdtempSync(path.join(tmpdir(), "agentus-voice-env-"));
  const second = await boot(dataDir2, { AGENTUS_PORT: String(await freePort()) }, home2);
  const base2 = second.base;
  const token2 = tokenFor(dataDir2);
  const H2 = { ...H, authorization: `Bea${"rer"} ${token2}` };
  const get2 = async (p) => {
    const res = await fetch(base2 + p, { headers: H2 });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const env0 = await get2("/api/settings");
  check("the .env bootstrap shows up as the provider", env0.body?.provider === "dashscope" && env0.body?.apiKeySet === true, `${env0.body?.provider} keySet=${env0.body?.apiKeySet}`);
  check("the .env source is named for the operator", String(env0.body?.apiKeySource ?? "").includes(".hermes/.env"), String(env0.body?.apiKeySource));
  const capsEnv = await get2("/api/voice");
  check("caps report 百炼 streaming with the default models", capsEnv.body?.provider === "dashscope" && capsEnv.body?.stt?.streaming === true && capsEnv.body?.stt?.model === "qwen-audio-3.1-asr-flash-streaming", JSON.stringify(capsEnv.body?.stt));

  const hotEnv = await fetch(`${base2}/api/settings`, { method: "PUT", headers: H2, body: JSON.stringify({ voice: { hotwords: ["Agentus=5", "ACP"] } }) });
  check("hotwords save through the same page api", hotEnv.status === 200, `status ${hotEnv.status}`);
  const ttsEnv = await fetch(`${base2}/api/tts`, { method: "POST", headers: H2, body: JSON.stringify({ text: "百炼合成自测" }) });
  const ttsEnvBytes = Buffer.from(await ttsEnv.arrayBuffer());
  check("百炼 TTS: the synthesizer is called and its audio URL is fetched", ttsEnv.status === 200 && ttsEnvBytes.toString("utf8").startsWith("RIFF"), `${ttsEnv.status} ${ttsEnvBytes.length}B`);
  const synthBody = seen.ttsBodies[seen.ttsBodies.length - 1] ?? "";
  // mp3 since 2026-10-04 (the same audio measured 2.4x smaller than wav); the assertion is the
  // shipped default, and the settings check above pins `defaults.ttsFormat` to the same value.
  check("百炼 TTS body carries model + voice + format", /qwen-audio-3\.0-tts-flash/.test(synthBody) && /longanhuan_v3\.6/.test(synthBody) && /"format":"mp3"/.test(synthBody), synthBody.slice(0, 130));

  // ---- 9b. the streaming synthesis relay (#81) ----
  // Runs on THIS instance on purpose: the relay refuses to open at all without a configured
  // provider (the first instance asserts exactly that above), so the contract has to be
  // checked here, where 百炼 is configured against the stand-in upstream.
  // The browser cannot set an auth header on a WebSocket handshake, so the relay exists: the
  // page sends {say|end|cancel} and receives s16le PCM as BINARY frames. This asserts the whole
  // contract against the stand-in upstream above, with no provider key involved.
  {
    const port2 = Number(new URL(base2).port);
    const openRelay = () => new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port2}/ws/tts?token=${encodeURIComponent(token2)}`);
      const state = { ws, audio: 0, bytes: 0, sentences: [], done: 0, errors: [], ready: null, startedAt: 0, firstAudioAt: 0 };
      ws.on("message", (raw, isBinary) => {
        if (isBinary) {
          state.audio += 1;
          state.bytes += raw.length;
          if (!state.firstAudioAt) state.firstAudioAt = Date.now();
          return;
        }
        const m = JSON.parse(String(raw));
        if (m.t === "tts-ready") state.ready = m;
        else if (m.t === "tts-sentence") state.sentences.push(m.text);
        else if (m.t === "tts-done") state.done += 1;
        else if (m.t === "tts-error" || m.t === "tts-closed") state.errors.push(m.error ?? m.why ?? m.t);
        if (state.done || state.errors.length) resolve(state);
      });
      ws.on("error", (e) => { state.errors.push(e.message); resolve(state); });
      ws.on("open", () => {
        state.startedAt = Date.now();
        ws.send(JSON.stringify({ t: "tts-start" }));
        ws.send(JSON.stringify({ t: "tts-say", text: "第一句。" }));
        ws.send(JSON.stringify({ t: "tts-say", text: "第二句。" }));
        ws.send(JSON.stringify({ t: "tts-end" }));
      });
      setTimeout(() => resolve(state), 8000);
    });

    const run1 = await openRelay();
    check("the /ws/tts relay opens a task upstream", wsSeen.run >= 1, `run=${wsSeen.run}`);
    check("the relay reports the PCM format and rate", run1.ready?.format === "pcm" && run1.ready?.sampleRate === 24000, JSON.stringify(run1.ready));
    check("the sentences reach the upstream as continue-task text", wsSeen.texts.includes("第一句。") && wsSeen.texts.includes("第二句。"), JSON.stringify(wsSeen.texts.slice(-3)));
    check("audio comes back to the page as binary PCM", run1.audio >= 2 && run1.bytes > 0, `${run1.audio} frames ${run1.bytes}B`);
    check("the run ends with tts-done, not an error", run1.done >= 1 && run1.errors.length === 0, `done=${run1.done} errors=${JSON.stringify(run1.errors)}`);
    check("the upstream was authenticated by the server, not the page", wsSeen.socketAuth.some((a) => /^Bear/.test(a) && a.length > 20), wsSeen.socketAuth.length ? `${wsSeen.socketAuth.length} socket(s)` : "none");
    try { run1.ws.close(); } catch { /* already gone */ }

    // A cancel must stop the audio AND leave the connection usable: that is what makes an
    // interruption cheap on the call, where the next sentence follows immediately.
    const cancelsBefore = wsSeen.cancels;
    const run2 = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port2}/ws/tts?token=${encodeURIComponent(token2)}`);
      // Only frames that arrive between the cancel and the NEXT task starting are "late audio":
      // the second task is expected to produce its own, so they must not be counted as strays.
      const state = { audioAfterCancel: 0, sawDone: false, errors: [] };
      let window = false;
      ws.on("message", (raw, isBinary) => {
        if (isBinary) { if (window) state.audioAfterCancel += 1; return; }
        const m = JSON.parse(String(raw));
        if (m.t === "tts-error" || m.t === "tts-closed") state.errors.push(m.error ?? m.why ?? m.t);
        if (m.t === "tts-ready" && state.cancelledAt) window = false;   // the new task is live
      });
      ws.on("open", () => {
        ws.send(JSON.stringify({ t: "tts-start" }));
        ws.send(JSON.stringify({ t: "tts-say", text: "这一句会被打断。" }));
        setTimeout(() => {
          ws.send(JSON.stringify({ t: "tts-cancel" }));
          state.cancelledAt = Date.now();
          window = true;
          // The same connection must accept a fresh task straight away.
          setTimeout(() => {
            ws.send(JSON.stringify({ t: "tts-start" }));
            ws.send(JSON.stringify({ t: "tts-say", text: "打断后的一句。" }));
            ws.send(JSON.stringify({ t: "tts-end" }));
          }, 60);
        }, 120);
      });
      ws.on("message", (raw, isBinary) => {
        if (isBinary) return;
        const m = JSON.parse(String(raw));
        if (m.t === "tts-done") { state.sawDone = true; resolve(state); }
      });
      setTimeout(() => resolve(state), 8000);
    });
    check("a cancel reaches the upstream as finish-task + directive:cancel", wsSeen.cancels > cancelsBefore, `cancels=${wsSeen.cancels}`);
    check("the connection survives a cancel and runs the next task", run2.sawDone === true, JSON.stringify(run2));
    check("a cancelled task produces no further audio", run2.audioAfterCancel === 0, `${run2.audioAfterCancel} late frame(s)`);

    // One connection per reply, not per sentence: the dial costs 200-650 ms upstream, so the
    // relay is reused. Two tasks on one socket = the saving this whole change is about.
    const runsBefore = wsSeen.run;
    const socketsBefore = wsSeen.sockets;
    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port2}/ws/tts?token=${encodeURIComponent(token2)}`);
      let tasks = 0;
      ws.on("open", () => {
        ws.send(JSON.stringify({ t: "tts-start" }));
        ws.send(JSON.stringify({ t: "tts-say", text: "甲。" }));
        ws.send(JSON.stringify({ t: "tts-end" }));
      });
      ws.on("message", (raw, isBinary) => {
        if (isBinary) return;
        const m = JSON.parse(String(raw));
        if (m.t !== "tts-done") return;
        tasks += 1;
        if (tasks === 1) {
          ws.send(JSON.stringify({ t: "tts-start" }));
          ws.send(JSON.stringify({ t: "tts-say", text: "乙。" }));
          ws.send(JSON.stringify({ t: "tts-end" }));
        } else { ws.close(); resolve(); }
      });
      setTimeout(resolve, 8000);
    });
    const newTasks = wsSeen.run - runsBefore;
    const newSockets = wsSeen.sockets - socketsBefore;
    check("two replies are two tasks on ONE upstream socket (the dial is not paid per reply)",
      newTasks === 2 && newSockets === 1, `tasks=${newTasks} sockets=${newSockets}`);

    // The operator's 语速 used to be hardcoded to 1.0 on the socket path: the setting silently
    // stopped working the day synthesis moved off HTTP.
    const rateSeen = wsSeen.params[wsSeen.params.length - 1]?.["rate"];
    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port2}/ws/tts?token=${encodeURIComponent(token2)}`);
      ws.on("open", () => {
        ws.send(JSON.stringify({ t: "tts-start", rate: 1.6 }));
        ws.send(JSON.stringify({ t: "tts-say", text: "语速一点六倍。" }));
        ws.send(JSON.stringify({ t: "tts-end" }));
      });
      ws.on("message", (raw, isBinary) => { if (!isBinary && JSON.parse(String(raw)).t === "tts-done") { ws.close(); resolve(); } });
      setTimeout(resolve, 8000);
    });
    const rateAfter = wsSeen.params[wsSeen.params.length - 1]?.["rate"];
    check("the operator's speech rate reaches the provider", Number(rateAfter) === 1.6,
      `rate=${JSON.stringify(rateAfter)} (was ${JSON.stringify(rateSeen)} before)`);

    // A failing task must TERMINATE the run. The first cut reported tts-error and left the socket
    // open, so the page waited for a tts-done that could never come: lamp on, no audio, and the
    // documented HTTP fallback never ran.
    const failRun = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port2}/ws/tts?token=${encodeURIComponent(token2)}`);
      const state = { audio: 0, error: null, closed: false, done: 0 };
      ws.on("message", (raw, isBinary) => {
        if (isBinary) { state.audio += 1; return; }
        const m = JSON.parse(String(raw));
        if (m.t === "tts-error") state.error = m.error;
        if (m.t === "tts-done") state.done += 1;
      });
      // Wait for the CLOSE, not just the error frame: the point of the fix is that the server
      // tears the bridge down, so the page can fall back instead of waiting for a tts-done.
      ws.on("close", () => { state.closed = true; resolve(state); });
      ws.on("open", () => {
        ws.send(JSON.stringify({ t: "tts-start" }));
        ws.send(JSON.stringify({ t: "tts-say", text: "这一句会让上游失败。" }));
        ws.send(JSON.stringify({ t: "tts-end" }));
      });
      setTimeout(() => resolve(state), 8000);
    });
    check("a failed task closes the bridge (error + close, so the page can fall back)",
      Boolean(failRun.error) && failRun.closed === true && failRun.done === 0, JSON.stringify(failRun));

    // Stop landing INSIDE the dial window must not synthesise (and bill) the cancelled sentence.
    // The upstream holds its handshake for 400 ms so the cancel is guaranteed to beat it.
    const runsBeforeDial = wsSeen.run;
    const textsBeforeDial = wsSeen.texts.length;
    wsDialDelayMs = 400;
    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port2}/ws/tts?token=${encodeURIComponent(token2)}`);
      ws.on("open", () => {
        ws.send(JSON.stringify({ t: "tts-start" }));
        ws.send(JSON.stringify({ t: "tts-say", text: "拨号期间就被取消的一句。" }));
        setTimeout(() => { ws.send(JSON.stringify({ t: "tts-cancel" })); ws.close(); }, 60);
      });
      ws.on("close", () => setTimeout(resolve, 700));
      setTimeout(resolve, 2500);
    });
    wsDialDelayMs = 0;
    check("a cancel inside the dial window withdraws the queued task (nothing is billed)",
      wsSeen.run === runsBeforeDial && wsSeen.texts.length === textsBeforeDial,
      `runs +${wsSeen.run - runsBeforeDial}, texts +${wsSeen.texts.length - textsBeforeDial}`);

    // The cancel acknowledgement can be slow (upstream queues, ~0.15 s throttling is a known
    // shape). The window that drops the cancelled task's audio must end when the NEXT task starts,
    // not on a 400 ms timer: the next sentence's own opening frame arrives at ~350 ms, so a timer
    // would eat its first syllable.
    wsCancelAckDelayMs = 600;
    const slowAck = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port2}/ws/tts?token=${encodeURIComponent(token2)}`);
      const state = { framesAfterRestart: 0, sawDone: false, errors: [] };
      let restarted = false;
      ws.on("message", (raw, isBinary) => {
        if (isBinary) { if (restarted) state.framesAfterRestart += 1; return; }
        const m = JSON.parse(String(raw));
        if (m.t === "tts-error" || m.t === "tts-closed") state.errors.push(m.error ?? m.why ?? m.t);
        if (m.t === "tts-done") { state.sawDone = true; resolve(state); }
      });
      ws.on("open", () => {
        ws.send(JSON.stringify({ t: "tts-start" }));
        ws.send(JSON.stringify({ t: "tts-say", text: "先这一句。" }));
        setTimeout(() => {
          ws.send(JSON.stringify({ t: "tts-cancel" }));
          setTimeout(() => {
            restarted = true;
            ws.send(JSON.stringify({ t: "tts-start" }));
            ws.send(JSON.stringify({ t: "tts-say", text: "紧接着的下一句。" }));
            ws.send(JSON.stringify({ t: "tts-end" }));
          }, 40);
        }, 120);
      });
      setTimeout(() => resolve(state), 8000);
    });
    wsCancelAckDelayMs = 0;
    check("a slow cancel acknowledgement does not swallow the next sentence's audio",
      slowAck.framesAfterRestart > 0 && slowAck.sawDone === true, JSON.stringify(slowAck));

    // The protocol's own ceilings: 20000 characters per frame, 200000 per task. Eleven maximum-size
    // frames are individually legal and must still be refused as a task.
    const capRun = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port2}/ws/tts?token=${encodeURIComponent(token2)}`);
      const state = { error: null, closed: false };
      ws.on("message", (raw, isBinary) => {
        if (isBinary) return;
        const m = JSON.parse(String(raw));
        if (m.t === "tts-error") state.error = m.error;
      });
      ws.on("close", () => { state.closed = true; resolve(state); });
      ws.on("open", () => {
        ws.send(JSON.stringify({ t: "tts-start" }));
        const unit = "字".repeat(20_000);
        for (let i = 0; i < 11; i++) ws.send(JSON.stringify({ t: "tts-say", text: unit }));
        ws.send(JSON.stringify({ t: "tts-end" }));
      });
      setTimeout(() => resolve(state), 8000);
    });
    check("a task past the protocol's 200000-character ceiling is refused, not billed",
      Boolean(capRun.error) && /text limit/i.test(capRun.error) && capRun.closed === true, JSON.stringify(capRun));
  }

  const sttEnv = await fetch(`${base2}/api/stt`, { method: "POST", headers: { ...H2, "content-type": "audio/wav" }, body: Buffer.from("RIFFfake-input") });
  const sttEnvBody = await sttEnv.json();
  check("百炼 batch ASR: compat chat/completions answers", sttEnv.status === 200 && /百炼听写结果/.test(String(sttEnvBody.text ?? "")), JSON.stringify(sttEnvBody).slice(0, 90));
  const asrBody = seen.asrBodies[seen.asrBodies.length - 1] ?? "";
  check("the ASR request carries an input_audio data URL", /"type":"input_audio"/.test(asrBody) && /data:audio\/wav;base64,/.test(asrBody), asrBody.slice(0, 110));
  check("hotwords ride along as the entity list", /Agentus/.test(asrBody) && /ACP/.test(asrBody), asrBody.slice(0, 160));

  const modelsEnv = await get2("/api/voice/models");
  check("the model list comes from the 百炼 endpoint", modelsEnv.status === 200 && modelsEnv.body?.total === 3 && modelsEnv.body?.tts?.includes("qwen-audio-3.0-tts-flash"), `status ${modelsEnv.status} ${JSON.stringify(modelsEnv.body)}`);
  killGroup(second.proc);

  // ---- 10. the settings are rows in OUR store (not a file, not localStorage) ----
  // They used to be a 0600 JSON beside the DB plus a browser's localStorage. Anything the
  // operator changes belongs with the rest of the data: it then survives a device change, and
  // a second tab cannot disagree with the first.
  const dbPath = path.join(dataDir, "agentus.sqlite");
  const dbMode = fs.existsSync(dbPath) ? (fs.statSync(dbPath).mode & 0o777).toString(8) : "missing";
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare("select key, value from settings").all();
  db.close();
  const keys = rows.map((r) => r.key);
  const voiceRow = String(rows.find((r) => r.key === "voice")?.value ?? "");
  check("the store is 0600 (it holds the endpoint key)", dbMode === "600", dbMode);
  check("voice / theme / call / prefs are rows in our own database",
    ["voice", "theme", "call", "prefs"].every((k) => keys.includes(k)), keys.join(","));
  check("the endpoint key is in the store, server-side only", /"apiKey"/.test(voiceRow) && voiceRow.length > 40, `${voiceRow.length}B`);
  check("no settings file is left behind", !fs.existsSync(path.join(dataDir, "settings.json")));

  // ---- 11. migration: a pre-store installation must not lose its settings ----
  const legacyDir = mkdtempSync(path.join(tmpdir(), "agentus-legacy-"));
  fs.writeFileSync(
    path.join(legacyDir, "settings.json"),
    JSON.stringify({ theme: { mode: "dark", accent: "#123456" }, call: { bargeLevel: 0.3, minChars: 7 }, updatedAt: 1 }),
    { mode: 0o600 },
  );
  const third = await boot(legacyDir, { AGENTUS_PORT: String(await freePort()) }, home2);
  const token3 = tokenFor(legacyDir);
  const get3 = async (p) => {
    const res = await fetch(third.base + p, { headers: { ...H, authorization: `Bearer ${token3}` } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const mig = await get3("/api/settings");
  check("a pre-store settings.json is imported into the DB", mig.body?.theme?.accent === "#123456", JSON.stringify(mig.body?.theme));
  check("…and a knob keeps its value across the import", mig.body?.call?.minChars === 7, JSON.stringify(mig.body?.call));
  check("…and a knob that no longer exists is dropped (bargeLevel → bargeSensitivity)",
    mig.body?.call?.bargeLevel === undefined && mig.body?.call?.bargeSensitivity === 60,
    JSON.stringify(mig.body?.call));
  check("…and the legacy file is kept as .imported, not deleted",
    fs.existsSync(path.join(legacyDir, "settings.json.imported")) && !fs.existsSync(path.join(legacyDir, "settings.json")));
  killGroup(third.proc);

  // a call section that is STILL at the old shipped defaults (最少字数 1 was the old default)
  // must follow the new ones instead of carrying a fossil of them into the panel
  const fossilDir = mkdtempSync(path.join(tmpdir(), "agentus-fossil-"));
  fs.writeFileSync(
    path.join(fossilDir, "settings.json"),
    JSON.stringify({ call: { bargeLevel: 0.2, bargeMs: 300, silenceMs: 1200, minChars: 1 }, updatedAt: 1 }),
    { mode: 0o600 },
  );
  const fourth = await boot(fossilDir, { AGENTUS_PORT: String(await freePort()) }, home2);
  const mig2 = await (async () => {
    const res = await fetch(fourth.base + "/api/settings", { headers: { ...H, authorization: `Bearer ${tokenFor(fossilDir)}` } });
    return { status: res.status, body: await res.json().catch(() => null) };
  })();
  check("a call section still at the OLD defaults adopts the new ones (最少字数 1 → 3)",
    mig2.body?.call?.minChars === 3 && mig2.body?.call?.bargeSensitivity === 60, JSON.stringify(mig2.body?.call));
  killGroup(fourth.proc);

  // A row that sits at the CURRENT shipped numbers with an empty wake phrase is the shape every
  // existing install has (the phrase is new): it must adopt 「hi, Tus」, otherwise Tus mode — which
  // forces keyword interruption — stays inert on exactly the machines that already had settings.
  const phraseDir = mkdtempSync(path.join(tmpdir(), "agentus-phrase-"));
  fs.writeFileSync(
    path.join(phraseDir, "settings.json"),
    JSON.stringify({ call: { bargeSensitivity: 60, bargeMs: 300, silenceMs: 1500, minChars: 3, wakePhrase: "" }, updatedAt: 1 }),
    { mode: 0o600 },
  );
  const fifthP = await boot(phraseDir, { AGENTUS_PORT: String(await freePort()) }, home2);
  const mig4 = await (async () => {
    const res = await fetch(fifthP.base + "/api/settings", { headers: { ...H, authorization: `Bearer ${tokenFor(phraseDir)}` } });
    return { status: res.status, body: await res.json().catch(() => null) };
  })();
  check("a call section at the CURRENT defaults still adopts the shipped wake phrase（空的就是没人设过）",
    mig4.body?.call?.wakePhrase === "hi, Tus", JSON.stringify(mig4.body?.call));
  killGroup(fifthP.proc);

  // …but a phrase the operator typed is theirs, never overwritten by a new default
  const typedDir = mkdtempSync(path.join(tmpdir(), "agentus-typed-"));
  fs.writeFileSync(
    path.join(typedDir, "settings.json"),
    JSON.stringify({ call: { bargeSensitivity: 60, bargeMs: 300, silenceMs: 1500, minChars: 3, wakePhrase: "小灵" }, updatedAt: 1 }),
    { mode: 0o600 },
  );
  const sixth = await boot(typedDir, { AGENTUS_PORT: String(await freePort()) }, home2);
  const mig5 = await (async () => {
    const res = await fetch(sixth.base + "/api/settings", { headers: { ...H, authorization: `Bearer ${tokenFor(typedDir)}` } });
    return { status: res.status, body: await res.json().catch(() => null) };
  })();
  check("…and a phrase the operator typed is kept as-is", mig5.body?.call?.wakePhrase === "小灵",
    JSON.stringify(mig5.body?.call));
  killGroup(sixth.proc);

  // …but a section the operator really tuned is left exactly as it is
  const tunedDir = mkdtempSync(path.join(tmpdir(), "agentus-tuned-"));
  fs.writeFileSync(
    path.join(tunedDir, "settings.json"),
    JSON.stringify({ call: { bargeSensitivity: 85, bargeMs: 500, silenceMs: 900, minChars: 1 }, updatedAt: 1 }),
    { mode: 0o600 },
  );
  const fifth = await boot(tunedDir, { AGENTUS_PORT: String(await freePort()) }, home2);
  const mig3 = await (async () => {
    const res = await fetch(fifth.base + "/api/settings", { headers: { ...H, authorization: `Bearer ${tokenFor(tunedDir)}` } });
    return { status: res.status, body: await res.json().catch(() => null) };
  })();
  check("…while a hand-tuned section is left alone (最少字数 1 是操作者选的)",
    mig3.body?.call?.minChars === 1 && mig3.body?.call?.bargeSensitivity === 85 && mig3.body?.call?.silenceMs === 900,
    JSON.stringify(mig3.body?.call));
  killGroup(fifth.proc);
} catch (e) {
  check("suite ran to completion", false, String(e?.stack ?? e).slice(0, 300));
} finally {
  for (const p of procs) { try { killGroup(p); } catch { /* already gone */ } }
  provider.close();
}

console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) {
  console.log("--- server log tail ---");
  console.log(log().split("\n").slice(-25).join("\n"));
}
process.exit(failed ? 1 : 0);
