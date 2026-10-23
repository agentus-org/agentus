// 麦克风的归属：谁拿到、谁还回去（#51）
//
// 报上来的两个症状都是「麦克风没还」：
//   A 开麦的链子很长（等权限弹窗可以等几分钟），中途挂断，弹窗回来之后这路流还是被塞进 `#mic`；
//     此后任何 stop() 都不再找它，页面顶上的录音指示一直亮。
//   B 说完按停止，设备其实在等 ASR 收尾的整段时间里还开着；收尾消息不来就永远开着。
//
// 这段不用浏览器：把 getUserMedia / AudioContext / WebSocket 换成可在测试里控制的可控替身，
// 让权限弹窗「延迟回答」，就能精确复刻两件事发生的时机。
//   npx tsx scripts/qa/mic-release-sweep.mts
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

// ---- the stand-ins -------------------------------------------------------------------------
interface FakeTrack {
  stopped: number;
  stop: () => void;
}
const tracks: FakeTrack[] = [];
const micStream = (): MediaStream => {
  const t: FakeTrack = { stopped: 0, stop() { this.stopped++; } };
  tracks.push(t);
  const track = {
    stop: () => t.stop(),
    getSettings: () => ({ echoCancellation: true, noiseSuppression: true }),
  };
  return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
};

/** getUserMedia that answers only when the test says so — this IS the permission prompt. */
let answerMic: ((s: MediaStream) => void) | null = null;
let askMic = (): Promise<MediaStream> => new Promise<MediaStream>((resolve) => { answerMic = resolve; });

class FakeCtx {
  sampleRate = 48000;
  destination = {};
  closed = 0;
  createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
    return { connect() {}, disconnect() {} };
  }
  createScriptProcessor(): { onaudioprocess: unknown; connect: () => void; disconnect: () => void } {
    return { onaudioprocess: null, connect() {}, disconnect() {} };
  }
  createGain(): { gain: { value: number }; connect: () => void } {
    return { gain: { value: 0 }, connect() {} };
  }
  close(): Promise<void> {
    this.closed++;
    return Promise.resolve();
  }
}

class FakeWs {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = FakeWs.OPEN;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    (globalThis as unknown as { __sockets: FakeWs[] }).__sockets.push(this);
    // A real socket opens on a later tick; the relay code expects that.
    setTimeout(() => this.onopen?.(), 0);
  }
  send(d: unknown): void {
    this.sent.push(d);
  }
  close(): void {
    this.readyState = FakeWs.CLOSED;
    setTimeout(() => this.onclose?.(), 0);
  }
}
(globalThis as unknown as { __sockets: FakeWs[] }).__sockets = [];

// The module reads `window`, `navigator`, `location` and `localStorage` at import time.
const w = globalThis as unknown as Record<string, unknown>;
w.window = globalThis;
w.location = { protocol: "http:", host: "127.0.0.1:8901" };
w.isSecureContext = true;
w.webkitAudioContext = FakeCtx;
w.AudioContext = FakeCtx;
w.WebSocket = FakeWs;
w.localStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};
// `navigator` is read-only in Node, so the media pickups have to be defined, not assigned.
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { mediaDevices: { getUserMedia: () => askMic() } },
});
// Not used by the streaming path, but the module probes for it while deciding which engine to use.
class FakeRecorder {
  static isTypeSupported(): boolean {
    return true;
  }
  state = "inactive";
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(readonly stream: MediaStream) {}
  start(): void {
    this.state = "recording";
  }
  stop(): void {
    this.state = "inactive";
  }
  abort(): void {
    this.state = "inactive";
  }
}
w.MediaRecorder = FakeRecorder;
// `window.setInterval` / `clearInterval` are used by the capture timer.
w.setInterval = setInterval;
w.clearInterval = clearInterval;

const { dictation, loadVoiceCaps } = await import("../../packages/web/src/voice.ts");
// The server says which engines it has; here it is the streaming recogniser (the path with the long
// permission prompt — the one the operator hit).
w.fetch = (): Promise<unknown> =>
  Promise.resolve({
    ok: true,
    json: () =>
      Promise.resolve({
        provider: "bailian",
        tts: { server: true, model: "cosyvoice", voice: "longxiaochun" },
        stt: { server: true, streaming: true, model: "paraformer", batchModel: "paraformer-v2", language: "zh" },
        hotwords: { fixed: 0, dynamic: true, limit: 50 },
      }),
  });
await loadVoiceCaps(true);

const prefs = {
  stt: "stream",
  lang: "zh-CN",
  autoRead: false,
  voiceURI: "",
  rate: 1,
  serverTts: false,
} as unknown as Parameters<typeof dictation.start>[0];

const SID = "session-51";
const st = (): ReturnType<typeof dictation.getSnapshot> => dictation.getSnapshot();

// ---- A: 权限弹窗还没回答就挂断 -------------------------------------------------------------
console.log("\nA · 权限弹窗里挂断，之后被回答");
const a = dictation.start(prefs, SID);
await sleep(20);
// The relay socket opens within a tick and paints "listening" — that is older, deliberate behaviour.
// What matters here is that the DEVICE is not ours yet: the prompt is still open.
check("弹窗还开着时，麦克风还没被拿到（tracks=0）", tracks.length === 0, `tracks=${tracks.length}`);
dictation.stop();                       // = hangUp() 走的那个口
answerMic?.(micStream());               // 弹窗终于被回答
await a;
await sleep(40);
check("晚到的麦克风被就地关掉，没有挂到 #mic 上", tracks.length === 1 && tracks[0].stopped === 1,
  `tracks=${tracks.length} stopped=${tracks[0]?.stopped}`);
check("挂断之后不会再自己回到 listening", st().status !== "listening" && st().status !== "transcribing", st().status);

// ---- 挂断之后还能重新开一次（没有卡在 requesting） ------------------------------------------
askMic = (): Promise<MediaStream> => Promise.resolve(micStream());
await dictation.start(prefs, SID);
await sleep(20);
check("挂断后再开一次仍然能开麦（状态没被卡死）", st().status === "listening", `${st().status} ${st().error}`);

// ---- B: 说完按停止，设备当场还回去 ---------------------------------------------------------
console.log("\nB · 说话中按停止：设备立刻放，识别器自己收尾");
const micB = tracks[tracks.length - 1];
const wsB = (globalThis as unknown as { __sockets: FakeWs[] }).__sockets.at(-1);
check("说话中拿着麦克风和一条 relay", Boolean(micB) && Boolean(wsB));
dictation.stop();
check("stop() 当场关掉采集（不再等 asr-done）", micB.stopped === 1, `stopped=${micB.stopped}`);
check("状态进入 transcribing（还在等最后一句）", st().status === "transcribing", st().status);
check("识别用的 socket 还开着 —— 收尾要它", wsB.readyState === FakeWs.OPEN);
check("发出去的是 asr-stop", wsB.sent.at(-1) === '{"t":"asr-stop"}', String(wsB.sent.at(-1)));

// ---- C: 识别器一直不回话，别把界面卡在 transcribing -----------------------------------------
console.log("\nC · 收尾迟迟不来");
await sleep(100);
check("（8 秒兜底还在，这里只确认它没提前收）", st().status === "transcribing", st().status);
dictation.cancel();
check("取消后回到 idle 且没有多开的麦克风", st().status === "idle" && tracks.every((t) => t.stopped >= 1),
  `status=${st().status} stops=${tracks.map((t) => t.stopped).join(",")}`);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  ${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
