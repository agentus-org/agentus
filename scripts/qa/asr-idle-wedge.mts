// The call's streaming socket has to survive the operator THINKING.
//
// `dictation` opens one relay socket per utterance (/ws/asr). While the operator has the floor the
// socket sits open and silent — and the upstream recogniser finalises a task that has heard nothing
// for ~23 s with `task-failed: request timeout after 23 seconds`, which our relay forwards as
// `asr-error` and then closes the socket. The call stays in its `listening` phase (nothing changes
// phase while it is the operator's turn), so the microphone is attached to a socket that no longer
// exists: the operator speaks, no words appear, and tapping the orb does nothing (empty transcript =
// nothing to send). Only hanging up recovers. This sweep drives the REAL client module
// (`packages/web/src/voice.ts`) through that exact sequence and asserts the load-bearing property:
//
//   words heard, 26 s of silence, words heard again — the second transcript must arrive.
//
// It needs a real streaming-ASR endpoint (the operator's own provider) plus `ffmpeg` to turn the
// server's own TTS into the 16 kHz PCM the relay speaks; without either it SKIPS rather than fails,
// the way a suite that depends on the operator's machine must.
//
//   AGENTSLOT_BASE=http://127.0.0.1:8901 npx tsx scripts/qa/asr-idle-wedge.mts
//
// The socket is the only thing touched: no session is created, no prompt is sent.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { machineToken } from "../lib/auth.mjs";

const BASE = process.env.AGENTSLOT_BASE || "http://127.0.0.1:8901";
const TOKEN = machineToken();
const GAP_MS = Number(process.env.WEDGE_GAP_MS || 26_000);   // past the upstream's ~23 s idle limit
const FEED_CHUNK = 3200;                                     // 100 ms of 16 kHz mono s16le

let ok = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { ok += 1; console.log(`  ok   ${name}`); }
  else { failed += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- the browser, reduced to what voice.ts touches -------------------------------------------
// The native-microphone bridge path is used on purpose: it is a supported source (the Android
// companion), it needs no AudioContext, and it hands the page frames through `window.__asMic` —
// exactly the seam this sweep has to push audio through.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.window = {
  setInterval: g.setInterval.bind(g),
  clearInterval: g.clearInterval.bind(g),
  setTimeout: g.setTimeout.bind(g),
  clearTimeout: g.clearTimeout.bind(g),
  addEventListener: () => {},
  AgentSlotMic: { available: () => true, start: () => "ok", stop: () => {} },
};
g.location = { protocol: new URL(BASE).protocol, host: new URL(BASE).host };

const withToken = (url: string): string => (TOKEN ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(TOKEN)}` : url);
const realFetch = g.fetch.bind(g);
g.fetch = (input: string | URL | Request, init?: RequestInit) =>
  realFetch(typeof input === "string" ? new URL(input, BASE).toString() : input, {
    ...(init ?? {}),
    headers: { ...((init?.headers as Record<string, string>) ?? {}), ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
  });

const { WebSocket: RealWS } = await import("ws");
/** The page cannot put a token on a handshake, and neither can this harness — so it rides the URL. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const RealWSAny = RealWS as any;
class TokenWS extends RealWSAny {
  constructor(url: string) { super(withToken(url)); }
}
g.WebSocket = TokenWS;

const { dictation, loadVoiceCaps } = await import("../../packages/web/src/voice.ts");

// ---- preconditions: say so and skip when the box cannot run this -------------------------------
if (!TOKEN) { console.log("skip: no machine token (AGENTSLOT_DATA / AGENTSLOT_AUTH_TOKEN)"); process.exit(0); }
if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0) { console.log("skip: ffmpeg is not installed"); process.exit(0); }

const caps = await loadVoiceCaps(true);
if (!caps.stt.streaming) { console.log(`skip: ${BASE} reports no streaming ASR (provider ${caps.provider})`); process.exit(0); }
console.log(`# asr idle wedge — ${BASE} · model ${caps.stt.model}\n`);
check("precondition: the instance really has a streaming ASR model configured", Boolean(caps.stt.model), String(caps.stt.model));

/** The audio: the server's OWN voice, spoken by the operator's configured provider. Three DISTINCT
 *  sentences, because a transcript that is merely non-empty proves nothing after the first utterance:
 *  each phase has to hear the words that phase spoke. */
const CLIPS = {
  a: { text: "帮我看一下通话功能为什么有点卡。", expect: "通话" },
  b: { text: "现在的麦克风还在吗。", expect: "麦克" },
  c: { text: "第三句话，确认一下还能听得见。", expect: "第三" },
} as const;

const dir = mkdtempSync(path.join(tmpdir(), "asr-idle-"));
async function clip(name: keyof typeof CLIPS): Promise<Buffer> {
  const res = await fetch(`${BASE}/api/tts`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify({ text: CLIPS[name].text, speed: 1 }),
  });
  if (!res.ok) { console.log(`skip: the instance has no working /api/tts (${res.status})`); process.exit(0); }
  const mp3 = path.join(dir, `${name}.mp3`);
  writeFileSync(mp3, Buffer.from(await res.arrayBuffer()));
  const out = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", mp3, "-ar", "16000", "-ac", "1", "-f", "s16le", "-"], { maxBuffer: 1 << 26 });
  if (out.status !== 0 || !out.stdout?.length) { console.log("skip: ffmpeg could not decode the TTS clip"); process.exit(0); }
  return out.stdout;
}
const PCM = { a: await clip("a"), b: await clip("b"), c: await clip("c") };
console.log(`  (# audio fixtures: ${Object.entries(PCM).map(([k, v]) => `${k} ${(v.length / 32000).toFixed(1)}s`).join(" · ")} of the operator's own TTS voice)`);

/** Push `seconds` of a fixture through the page's own frame sink, at real time.
 *  Returns false when the page has no sink left — that IS the deafness under test, so it is
 *  reported by the assertion rather than thrown. */
async function speak(name: keyof typeof CLIPS, seconds: number): Promise<boolean> {
  const push = g.window.__asMic as ((b64: string) => void) | undefined;
  if (!push) return false;
  const pcm = PCM[name];
  const end = Math.min(pcm.length, seconds * 32000);
  for (let off = 0; off < end; off += FEED_CHUNK) {
    push(pcm.subarray(off, Math.min(off + FEED_CHUNK, end)).toString("base64"));
    await sleep(100);
  }
  return true;
}

/** What the CALL reads: a partial is a word the operator said, and the call's own loop takes
 *  `text || interim` (`CallMode.tsx`). Asserting only on the finalized text would call a working
 *  utterance empty. */
const snap = (): { status: string; text: string; heard: string; error: string; sink: boolean } => {
  const s = dictation.getSnapshot();
  const heard = `${s.text}${s.interim ? ` ${s.interim}` : ""}`.replace(/\s+/g, " ").trim();
  return { status: s.status, text: s.text, heard, error: s.error, sink: Boolean(g.window.__asMic) };
};

const prefs = { autoRead: false, voiceURI: "", rate: 1, lang: "zh-CN", serverTts: true, stt: "auto" as const };
const started = await dictation.start(prefs, undefined);
check("the call can open its microphone (streaming engine)", started && dictation.getSnapshot().engine === "stream", JSON.stringify(snap()));

// A — the baseline: the operator speaks and the words arrive.
await speak("a", 2.5);
await sleep(1300);
const first = snap();
console.log(`  (# first utterance: ${JSON.stringify(first)})`);
check(`★ baseline: speaking is transcribed (expect "${CLIPS.a.expect}")`, first.heard.includes(CLIPS.a.expect), JSON.stringify(first));

// B — the operator goes quiet on their own turn (thinking about the answer). Nothing sends, nothing
// closes: the relay stays open with the relay gate ON, exactly as the call leaves it while listening.
await sleep(GAP_MS);
const idle = snap();
console.log(`  (# after ${GAP_MS / 1000}s of silence on the operator's turn: ${JSON.stringify(idle)})`);

// C — the load-bearing assertion: the operator finally speaks, and MUST be heard — with ITS OWN
// sentence, so a transcript left over from before the gap cannot pass this.
dictation.resetText();
const spoke = await speak("b", 2.5);
await sleep(1300);
const second = snap();
console.log(`  (# second utterance: ${JSON.stringify(second)})`);
check(`★ the microphone is still live after the operator's silence (expect "${CLIPS.b.expect}")`,
  spoke && second.heard.includes(CLIPS.b.expect),
  spoke ? `heard "${second.heard}"` : `the page has no frame sink left: ${JSON.stringify(second)}`);
check("the upstream idle timeout never surfaces as an operator-visible error", !idle.error && !second.error,
  `error "${idle.error || second.error}"`);

// D — the call's own turn, end to end: the operator's words are sent, the relay goes quiet while the
// agent thinks and reads its reply out loud — which can take minutes — and then the floor comes back.
// The socket must not have been left to die of idleness, and the operator must be heard again.
dictation.setRelay(false);                       // CallMode does this when the turn is sent
await sleep(GAP_MS);
const during = snap();
console.log(`  (# the agent's turn, ${GAP_MS / 1000}s long: ${JSON.stringify(during)})`);
check("★ the agent's own turn leaves no error behind", !during.error, `error "${during.error}"`);
dictation.resetText();
dictation.setRelay(true);                        // CallMode's backToListening
await sleep(500);
const spokeAgain = await speak("c", 2.5);
await sleep(1500);
const after = snap();
console.log(`  (# the floor comes back after the turn: ${JSON.stringify(after)})`);
check(`★ the operator is heard again after the agent's reply (expect "${CLIPS.c.expect}")`,
  spokeAgain && after.heard.includes(CLIPS.c.expect),
  spokeAgain ? `heard "${after.heard}"` : `no frame sink: ${JSON.stringify(after)}`);

dictation.stop();
await sleep(300);
console.log(`\n${failed ? "FAIL" : "ok"}: ${ok} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
