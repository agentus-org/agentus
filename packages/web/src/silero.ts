// A real speech detector: Silero VAD v6, in the page, on the microphone's own frames.
//
// WHY A MODEL AND NOT A THRESHOLD. The level gate in `vad.ts` is honest but blind: it can tell
// 「louder than the room」 from 「quieter」, and nothing else. It cannot tell a fan from a word, and it
// cannot tell a soft sustained vowel from a hum — I documented exactly that hole. Silero answers the
// actual question («is this speech?») with a probability from a small convolutional net, and the
// measurement that matters here is in `scripts/qa/vad-silero.mts`: real speech from this machine's own
// voice synthesis scores 0.81 mean / 1.00 peak, silence scores 0.005.
//
// WHAT IT COSTS. `onnxruntime-web`'s wasm is 14 MB (copied at build time by `scripts/copy-ort.mjs`,
// git-ignored) and the model is 2.3 MB (committed). Both are fetched LAZILY — only when a call starts,
// only once, and only from this same origin. If anything about that fails (no wasm, a blocked fetch, a
// phone that cannot allocate the session) the caller keeps the level gate: a call must never lose its
// microphone because a model did not load.
//
// WHY 576 SAMPLES. Silero v6 takes 512 new samples PLUS the previous frame's last 64 as context; fed
// 512 alone it returns ~0.00 for loud speech (measured). Stream order and that context window are the
// whole interface — see `push()`.
import type { InferenceSession, Tensor } from "onnxruntime-web/wasm";

/** Silero's own operating point. 0.5/0.35 with the hangover below is what the model's authors ship. */
const ON = 0.5;
const OFF = 0.35;
const FRAME = 512;
const CTX = 64;
const HANG_MS = 700;
export const SILERO_RATE = 16000;

export interface SileroState {
  /** Last probability the model produced (0..1). -1 = nothing has been scored yet. */
  prob: number;
  /** Speech, including the hangover — what a caller wants for 「is the operator mid-sentence」. */
  speech: boolean;
  lastVoiceAt: number;
  /** Frames scored since load (a cheap liveness signal for the QA sweep). */
  frames: number;
}

export function newSileroState(): SileroState {
  return { prob: -1, speech: false, lastVoiceAt: -Infinity, frames: 0 };
}

/** Hysteresis + hangover over one probability sample. Pure, so the tests can drive it directly. */
export function sileroStep(st: SileroState, prob: number, now: number, hangMs = HANG_MS): boolean {
  st.prob = prob;
  if (prob >= ON) st.lastVoiceAt = now;
  // Below the OFF threshold the sentence ends on this frame — no hangover. Between OFF and ON the
  // hangover decides, which is what keeps the gaps inside 「我想… 那个… 就是」 from ending it.
  else if (prob < OFF) st.lastVoiceAt = now - hangMs - 1;
  st.speech = now - st.lastVoiceAt <= hangMs;
  st.frames += 1;
  return st.speech;
}

export class Silero {
  #session: InferenceSession | null = null;
  #ort: typeof import("onnxruntime-web/wasm") | null = null;
  #state: Tensor | null = null;
  #ctx = new Float32Array(CTX);
  /** Samples not yet forming a 512 frame. */
  #buf: number[] = [];
  #busy = false;
  /** At most a couple of frames wait: the microphone keeps producing whether or not we keep up, and a
   *  backlog would make the detector answer about audio from a second ago — useless for barge-in. */
  #queue: Float32Array[] = [];
  #failures = 0;
  st = newSileroState();

  get ready(): boolean {
    return this.#session !== null;
  }

  /** Load the runtime and the model. Resolves false — never throws — when this device cannot run it. */
  async load(modelUrl: string): Promise<boolean> {
    if (this.#session) return true;
    try {
      // `onnxruntime-web/wasm`, not the default entry: the default pulls the JSEP (WebGPU) build and
      // vite bundles its 28 MB wasm into the app for a session that only ever asks for the wasm EP.
      const ort = await import("onnxruntime-web/wasm");
      ort.env.wasm.numThreads = 1;              // one frame at a time; threads would fight the mic
      // No `wasmPaths`: the `/wasm` build references its binary with `new URL(...)`, so vite emits it
      // next to the app with a hashed name and the runtime finds it on its own — same origin, no CDN,
      // and nothing to copy by hand (the first version of this shipped a second, unreferenced copy).
      ort.env.logLevel = "error";
      this.#ort = ort;
      this.#session = await ort.InferenceSession.create(modelUrl, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
      this.#state = new ort.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
      return true;
    } catch (e) {
      console.warn("[vad] silero unavailable, falling back to the level gate:", (e as Error)?.message ?? e);
      this.#session = null;
      this.#ort = null;
      return false;
    }
  }

  /** Drop everything that belongs to the previous call (the model keeps its weights). */
  reset(): void {
    this.st = newSileroState();
    this.#ctx.fill(0);
    this.#buf = [];
    this.#queue = [];
    if (this.#ort && this.#state) {
      this.#state = new this.#ort.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
    }
  }

  /** Feed microphone samples at 16 kHz. Anything left over stays buffered for the next call. */
  push(samples: Float32Array): void {
    if (!this.#session) return;
    for (let i = 0; i < samples.length; i++) this.#buf.push(samples[i]);
    while (this.#buf.length >= FRAME) {
      const frame = new Float32Array(this.#buf.splice(0, FRAME));
      // Keep the newest two: if inference falls behind, stale audio is worse than none.
      this.#queue.push(frame);
      if (this.#queue.length > 2) this.#queue.shift();
    }
    void this.#drain();
  }

  async #drain(): Promise<void> {
    if (this.#busy || !this.#session || !this.#ort || !this.#state) return;
    this.#busy = true;
    try {
      while (this.#queue.length && this.#session) {
        const frame = this.#queue.shift() as Float32Array;
        const input = new Float32Array(CTX + FRAME);
        input.set(this.#ctx, 0);
        input.set(frame, CTX);
        const out = await this.#session.run({
          input: new this.#ort.Tensor("float32", input, [1, CTX + FRAME]),
          state: this.#state,
          sr: new this.#ort.Tensor("int64", BigInt64Array.from([16000n]), []),
        });
        this.#state = out.stateN as Tensor;
        this.#ctx.set(frame.subarray(FRAME - CTX));
        const p = Number((out.output as Tensor).data[0]);
        sileroStep(this.st, Number.isFinite(p) ? p : 0, Date.now());
      }
    } catch (e) {
      // A run that throws is not worth retrying forever inside a live call.
      if (++this.#failures >= 3) {
        console.warn("[vad] silero run failed, falling back to the level gate:", (e as Error)?.message ?? e);
        this.#session = null;
        this.#queue = [];
      }
    } finally {
      this.#busy = false;
    }
  }
}

export const silero = new Silero();
