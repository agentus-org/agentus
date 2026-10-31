// Unit checks for the streaming TTS path (issue #81).
//
// Why unit tests and not only browser sweeps: the parts that decide whether the operator hears
// the right thing are pure — how the reply is cut into `continue-task` units, and how the s16le
// bytes become floats. A browser sweep proves the relay works end to end but cannot cheaply cover
// the boundaries (an over-long sentence, a PCM frame that ends mid-sample, full-scale clipping).
//
// Run: npm run tts-stream-units   (tsx; no browser, no network, no key)
import { splitForStream, pcmS16leToFloat, TtsRelay } from "../../packages/web/src/voice.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const show = (a: unknown): string => JSON.stringify(a);

// ---------------------------------------------------------------- splitForStream

// 1. The whole point of #81: a sentence is the unit, not an 80-character block. Fed as sentences,
//    the upstream synthesises the first one while the rest of the reply is still arriving.
{
  const t = "第一句话。第二句话比第一句长一些，但也没超过上限。第三句。";
  const units = splitForStream(t);
  check("a normal reply is cut per sentence, not per character count",
    units.length === 3 && units[0] === "第一句话。", show(units));
}
// 2. Every unit must be within the one-frame limit the protocol tolerates from us.
{
  const long = "这是一个很长的句子，".repeat(40) + "结束。";
  const units = splitForStream(long);
  check("no unit exceeds the frame limit", units.every((u) => u.length <= 120), show(units.map((u) => u.length)));
  check("an over-long sentence is still split (never dropped)", units.join("").replace(/\s/g, "").length > 200, show(units.map((u) => u.length)));
}
// 3. Nothing may be lost: the units must contain the whole text (modulo the whitespace collapsing
//    and the stripped markdown, which are deliberate).
{
  const t = "先说要紧的：**三步**。然后 `code` 和 #标签 | 竖线。";
  const units = splitForStream(t);
  const joined = units.join("").replace(/\s/g, "");
  check("markdown is stripped from what is read aloud", !joined.includes("**") && !joined.includes("`") && !joined.includes("#"), show(units));
  check("the words all survive", joined.includes("三步") && joined.includes("竖线"), show(units));
}
// 4. A fenced code block is never read out (the operator hears "code block", not syntax).
{
  const units = splitForStream("看这个：\n```js\nconst a = 1;\n```\n就这样。");
  check("a code block is not read as code",
    units.every((u) => !u.includes("const a")), show(units));
}
// 5. Empty / whitespace / punctuation-only input produces no units at all, so the relay is not
//    opened for nothing (an empty task would bill a round trip and produce silence).
{
  check("empty text yields no units", splitForStream("").length === 0);
  check("whitespace yields no units", splitForStream("  \n\t ").length === 0);
  check("a code block alone yields only the placeholder",
    splitForStream("```\nx\n```").length === 1, show(splitForStream("```\nx\n```")));
}
// 6. A clause boundary is preferred over a hard cut, so the synthesiser is not handed a sentence
//    that starts mid-phrase (which reads with a wrong prosody).
{
  // 40 characters, one sentence, one clause at index 24 — cut at 30 so the clause is in reach.
  const t = "前面这一半已经足够长了所以我们必须在某个地方断开，后面还有更多内容要继续念下去。";
  const units = splitForStream(t, 30);
  check("cuts land after a clause when one is available",
    units.length === 2 && /[，,]$/.test(units[0]), show(units));
  check("the cut does not lose the text after it",
    units[1].startsWith("后面还有"), show(units));
}
// 7. Determinism: the same text always produces the same units (the relay depends on it being
//    able to re-send a sentence without the text shifting under it).
{
  const t = "甲。乙，丙。丁。";
  check("splitting is deterministic", show(splitForStream(t)) === show(splitForStream(t)));
}

// ---------------------------------------------------------------- pcmS16leToFloat

// 8. Full scale must stay inside [-1, 1] and be symmetric — an asymmetric scale is audible as
//    clipping on one half of the waveform.
{
  const pcm = new ArrayBuffer(8);
  const v = new DataView(pcm);
  v.setInt16(0, 32767, true);
  v.setInt16(2, -32768, true);
  v.setInt16(4, 0, true);
  v.setInt16(6, 16384, true);
  const out = new Float32Array(4);
  const n = pcmS16leToFloat(pcm, out);
  check("all four samples are unpacked", n === 4, String(n));
  check("positive full scale does not exceed 1", out[0] <= 1 && out[0] > 0.999, String(out[0]));
  check("negative full scale is exactly -1", out[1] === -1, String(out[1]));
  check("silence is 0", out[2] === 0, String(out[2]));
  check("half scale is ~0.5", Math.abs(out[3] - 0.5) < 0.001, String(out[3]));
}
// 9. A frame that ends mid-sample (an odd byte count) must not read past its end or throw: the
//    relay forwards whole frames, but a truncated one must degrade to "one sample fewer".
{
  const pcm = new ArrayBuffer(5);          // 2 samples + 1 stray byte
  new DataView(pcm).setInt16(0, 1000, true);
  const out = new Float32Array(8);
  let threw = false;
  let n = -1;
  try { n = pcmS16leToFloat(pcm, out); } catch { threw = true; }
  check("a truncated frame is tolerated", !threw);
  check("only the whole samples are unpacked", n === 2, String(n));
  check("the buffer beyond the data is left untouched", out[3] === 0, String(out[3]));
}
// 10. The output array may be longer than the data — that is the normal case (the caller sizes it
//     from the AudioBuffer, which is computed from the same byte count, but the contract should
//     not depend on that).
{
  const pcm = new ArrayBuffer(4);
  new DataView(pcm).setInt16(0, 1, true);
  const out = new Float32Array(1);
  check("a short output array does not overflow", pcmS16leToFloat(pcm, out) === 1, String(out[0]));
}


// ---------------------------------------------------------------- the relay's settlement rules
//
// These are the paths a browser sweep cannot reach: `/ws/tts` always closes right after a failure
// there, so "the run settled BEFORE the close" is unobservable through the network. Driving the
// relay with a stand-in socket that stays OPEN after `tts-error` is the only way to prove the page
// does not wait for an event that may never come.

// The relay is browser code and schedules through `window`; node has no such global.
(globalThis as unknown as { window: unknown }).window = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>),
};

/** Minimal stand-in for the browser's WebSocket: records what the relay sends, lets the test
 *  deliver messages, and never fires anything on its own. */
class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 1;
  binaryType = "blob";
  sent: string[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send(data: unknown): void { this.sent.push(String(data)); }
  addEventListener(): void { /* the relay passes `once` listeners it may remove again */ }
  removeEventListener(): void { /* idem */ }
  close(): void { this.readyState = 3; }
  deliver(msg: unknown): void { this.onmessage?.({ data: JSON.stringify(msg) }); }
  deliverBytes(buf: ArrayBuffer): void { this.onmessage?.({ data: buf }); }
  closeQuietly(): void { this.readyState = 3; this.onclose?.(); }
}

const stubCtx = { state: "running", currentTime: 0, destination: {}, createBuffer: () => ({}) } as unknown as AudioContext;

{
  const sock = new FakeSocket();
  const relay = new TtsRelay(stubCtx, 24000, () => sock as unknown as WebSocket);
  const ac = new AbortController();
  // The socket stays OPEN after the error on purpose: the run must not wait for the close.
  const pending = relay.speak("这一句会失败。", ac.signal, 1);
  sock.deliver({ t: "tts-ready", sampleRate: 24000 });
  // The socket stays OPEN after the error on purpose: the run must not wait for the close.
  sock.deliver({ t: "tts-error", error: "boom" });
  let settled = false;
  const raced = Promise.race([
    pending.then(() => "resolved", () => "rejected"),
    new Promise<string>((r) => setTimeout(() => r("still pending"), 300)),
  ]);
  pending.catch(() => { settled = true; });
  const outcome = await raced;
  check("a tts-error settles the run even if the socket stays open", outcome === "rejected", `${outcome}, settled=${settled}`);
  check("…and the relay closes itself afterwards (it cannot be reused)", relay.usable === false, String(relay.usable));
}

{
  // A clean close with no audio must ALSO reject: the caller still has the one-shot route, and
  // resolving here would tell it the sentence had been spoken when nothing was heard.
  const sock = new FakeSocket();
  const relay = new TtsRelay(stubCtx, 24000, () => sock as unknown as WebSocket);
  const ac = new AbortController();
  const pending = relay.speak("这一句没有声音。", ac.signal, 1);
  sock.deliver({ t: "tts-ready", sampleRate: 24000 });
  const raced = Promise.race([
    pending.then(() => "resolved", () => "rejected"),
    new Promise<string>((r) => setTimeout(() => r("still pending"), 300)),
  ]);
  sock.closeQuietly();
  const outcome = await raced;
  check("a close with no audio at all rejects (so the fallback can run)", outcome === "rejected", outcome);
}

{
  // The rate the operator chose must ride the start frame, not a hardcoded 1.0.
  const sock = new FakeSocket();
  const relay = new TtsRelay(stubCtx, 24000, () => sock as unknown as WebSocket);
  const ac = new AbortController();
  const pending = relay.speak("语速测试。", ac.signal, 1.4);
  const startFrame = JSON.parse(sock.sent.find((m) => m.includes("tts-start")) ?? "{}");
  check("the start frame carries the operator's rate", startFrame.rate === 1.4, JSON.stringify(startFrame));
  const sayFrames = sock.sent.filter((m) => m.includes("tts-say")).map((m) => JSON.parse(m).text);
  check("the text is fed as sentences, not as one blob", sayFrames.length === 1 && sayFrames[0] === "语速测试。", JSON.stringify(sayFrames));
  relay.cancel();
  await pending.catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
