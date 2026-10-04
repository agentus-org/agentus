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
import { WebSocket } from "ws";

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
const PROVIDER = `http://127.0.0.1:${providerPort}/v1`;

const procs = [];

/** Boot the server. `home` matters: settings.ts falls back to reading ~/.hermes/.env, so
 *  a test that inherits the operator's real home is not a test of the empty case. */
async function boot(dataDir, extraEnv = {}, home = "") {
  const port = Number(extraEnv.AGENTSLOT_PORT ?? PORT);
  if (await portInUse(port)) {
    throw new Error(`port ${port} is already in use — a leaked server from an earlier run? `
      + `(lsof -nP -iTCP:${port} -sTCP:LISTEN)`);
  }
  const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
    detached: true,
    cwd: ROOT,
    env: {
      ...process.env, NODE_ENV: "development", AGENTSLOT_PORT: String(port), AGENTSLOT_DATA: dataDir,
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

const emptyHome = mkdtempSync(path.join(tmpdir(), "agentslot-home-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agentslot-voice-"));
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
    body: JSON.stringify({ voice: { provider: "openai", baseUrl: PROVIDER, apiKey: "sk-test-abc123", asrBatchModel: "qwen3-asr-flash", ttsModel: "qwen-audio-3.0-tts-flash", ttsVoice: "longanhuan_v3.6", hotwords: ["AgentSlot=5", "ACP"] } }),
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
  check("fixed hotwords are carried with their weights", hot.status === 200 && fixed.length === 2 && fixed.some((w) => w.word === "AgentSlot" && w.weight === 5), JSON.stringify(hot.body?.words ?? []).slice(0, 120));
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
  const home2 = mkdtempSync(path.join(tmpdir(), "agentslot-home-env-"));
  fs.mkdirSync(path.join(home2, ".hermes"), { recursive: true });
  fs.writeFileSync(path.join(home2, ".hermes", ".env"), `DASHSCOPE_API_KEY=sk-env-abcdef123\nDASHSCOPE_BASE_URL=http://127.0.0.1:${providerPort}/\n`);
  const dataDir2 = mkdtempSync(path.join(tmpdir(), "agentslot-voice-env-"));
  const second = await boot(dataDir2, { AGENTSLOT_PORT: String(await freePort()) }, home2);
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

  const hotEnv = await fetch(`${base2}/api/settings`, { method: "PUT", headers: H2, body: JSON.stringify({ voice: { hotwords: ["AgentSlot=5", "ACP"] } }) });
  check("hotwords save through the same page api", hotEnv.status === 200, `status ${hotEnv.status}`);
  const ttsEnv = await fetch(`${base2}/api/tts`, { method: "POST", headers: H2, body: JSON.stringify({ text: "百炼合成自测" }) });
  const ttsEnvBytes = Buffer.from(await ttsEnv.arrayBuffer());
  check("百炼 TTS: the synthesizer is called and its audio URL is fetched", ttsEnv.status === 200 && ttsEnvBytes.toString("utf8").startsWith("RIFF"), `${ttsEnv.status} ${ttsEnvBytes.length}B`);
  const synthBody = seen.ttsBodies[seen.ttsBodies.length - 1] ?? "";
  check("百炼 TTS body carries model + voice + format", /qwen-audio-3\.0-tts-flash/.test(synthBody) && /longanhuan_v3\.6/.test(synthBody) && /"format":"wav"/.test(synthBody), synthBody.slice(0, 130));

  const sttEnv = await fetch(`${base2}/api/stt`, { method: "POST", headers: { ...H2, "content-type": "audio/wav" }, body: Buffer.from("RIFFfake-input") });
  const sttEnvBody = await sttEnv.json();
  check("百炼 batch ASR: compat chat/completions answers", sttEnv.status === 200 && /百炼听写结果/.test(String(sttEnvBody.text ?? "")), JSON.stringify(sttEnvBody).slice(0, 90));
  const asrBody = seen.asrBodies[seen.asrBodies.length - 1] ?? "";
  check("the ASR request carries an input_audio data URL", /"type":"input_audio"/.test(asrBody) && /data:audio\/wav;base64,/.test(asrBody), asrBody.slice(0, 110));
  check("hotwords ride along as the entity list", /AgentSlot/.test(asrBody) && /ACP/.test(asrBody), asrBody.slice(0, 160));

  const modelsEnv = await get2("/api/voice/models");
  check("the model list comes from the 百炼 endpoint", modelsEnv.status === 200 && modelsEnv.body?.total === 3 && modelsEnv.body?.tts?.includes("qwen-audio-3.0-tts-flash"), `status ${modelsEnv.status} ${JSON.stringify(modelsEnv.body)}`);
  killGroup(second.proc);

  // ---- 10. the settings are rows in OUR store (not a file, not localStorage) ----
  // They used to be a 0600 JSON beside the DB plus a browser's localStorage. Anything the
  // operator changes belongs with the rest of the data: it then survives a device change, and
  // a second tab cannot disagree with the first.
  const dbPath = path.join(dataDir, "agentslot.sqlite");
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
  const legacyDir = mkdtempSync(path.join(tmpdir(), "agentslot-legacy-"));
  fs.writeFileSync(
    path.join(legacyDir, "settings.json"),
    JSON.stringify({ theme: { mode: "dark", accent: "#123456" }, call: { bargeLevel: 0.3, minChars: 7 }, updatedAt: 1 }),
    { mode: 0o600 },
  );
  const third = await boot(legacyDir, { AGENTSLOT_PORT: String(await freePort()) }, home2);
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
