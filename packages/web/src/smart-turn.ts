// Smart Turn v3 — semantic "did the operator finish?" detection, in the page.
//
// WHY. The old end-of-turn (EOT) gate was "quiet for > silenceMs". A pause is not a finish: thinking,
// a breath, or 那个… all pause. Smart Turn answers the actual question from the raw 16 kHz waveform
// (Whisper Tiny encoder + a linear head, 8 MB int8 ONNX, ~12 ms CPU) — it hears "still going" inside a
// pause that a timer calls "done".
//
// THE ONE RULE THAT MATTERS — this module NEVER decides to send. `endpointDelayMs` only picks HOW LONG
// to wait: "complete" → short delay, "not complete" → the hard max. That is LiveKit's design, and it is
// why Chinese's 9.26% miss rate (says "not done" when you finished) degrades to "waits a bit longer",
// never "cuts you off". The caller's state machine (voiceAtRef anchor + re-start on speech) still owns
// the actual send. If any of this fails to load/run, the caller falls back to the plain silenceMs gate.
//
// WHY A PRIVATE FFT. Whisper's log-mel is an rFFT of 400-sample frames; the onnxruntime has no FFT op,
// and the analyser FFT in voice.ts is a different size/window. So the exact vendored numpy math from
// pipecat's `_whisper_features.py` is ported here (BSD-2 / Apache-2.0 upstream), with a golden test.
//
// Model: smart-turn-v3.2-cpu.onnx — input `input_features` [1,80,800], output `logits` [1,1] (already
// sigmoid: P(complete)). BSD-2-Clause, https://huggingface.co/pipecat-ai/smart-turn-v3.

import type { InferenceSession, Tensor } from "onnxruntime-web/wasm";

export const SMART_TURN_RATE = 16000;

/** Seconds of audio the model looks at; pipecat's default. Longer turns keep the LAST window. */
const WINDOW_S = 8;
const WINDOW_SAMPLES = SMART_TURN_RATE * WINDOW_S; // 128000

// ---- Whisper log-mel constants (must match pipecat's vendored _whisper_features.py) --------------
const N_FFT = 400;
const HOP = 160;
const N_MELS = 80;
const MEL_FLOOR = 1e-10;
const NORM_EPS = 1e-7;

/** Slaney hertz→mel (matches librosa / transformers). */
function hzToMel(f: number): number {
  const minLogHz = 1000, minLogMel = 15, logstep = 27 / Math.log(6.4);
  const mel = (3 * f) / 200;
  return f >= minLogHz ? minLogMel + Math.log(f / minLogHz) * logstep : mel;
}
function melToHz(m: number): number {
  const minLogHz = 1000, minLogMel = 15, logstep = Math.log(6.4) / 27;
  const f = (200 * m) / 3;
  return m >= minLogMel ? minLogHz * Math.exp(logstep * (m - minLogMel)) : f;
}

/** Build the (201 bins × 80 mels) Slaney-normalized triangular filterbank, once. */
function buildMelFilters(): Float64Array {
  const numBins = N_FFT / 2 + 1; // 201
  const melMin = hzToMel(0), melMax = hzToMel(SMART_TURN_RATE / 2);
  const melPts = new Float64Array(N_MELS + 2);
  for (let i = 0; i < N_MELS + 2; i++) {
    melPts[i] = melMin + ((melMax - melMin) * i) / (N_MELS + 1);
  }
  const fPts = Array.from(melPts, melToHz);
  const filterFreqs = new Float64Array(numBins);
  for (let i = 0; i < numBins; i++) filterFreqs[i] = (SMART_TURN_RATE / 2) * i / (numBins - 1);
  // filters[m] is a row of `numBins`; stored flat row-major.
  const filters = new Float64Array(N_MELS * numBins);
  for (let m = 0; m < N_MELS; m++) {
    const left = fPts[m], center = fPts[m + 1], right = fPts[m + 2];
    const enorm = 2 / (fPts[m + 2] - fPts[m]);
    for (let k = 0; k < numBins; k++) {
      const f = filterFreqs[k];
      let w = 0;
      if (f >= left && f <= center) w = (f - left) / (center - left);
      else if (f > center && f <= right) w = (right - f) / (right - center);
      filters[m * numBins + k] = w * enorm;
    }
  }
  return filters;
}
const MEL_FILTERS = buildMelFilters();

/** Periodic Hann window of length 400 (torch.hann_window(400, periodic=true) == hanning(401)[:-1]). */
const HANN = (() => {
  const w = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
  return w;
})();

/** In-place complex radix-2 FFT on parallel Float64Arrays of power-of-two length. sign=-1 forward, +1 inverse. */
function fftComplex(re: Float64Array, im: Float64Array, sign: number): void {
  const N = re.length;
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/**
 * Exact 400-point rFFT magnitude² via Bluestein chirp-z (numpy rfft uses a direct 400-point DFT;
 * zero-padding to 512 + interpolation was too lossy on sharp peaks). L = next pow2 ≥ 2N-1 = 799 → 1024.
 */
const BLU_N = N_FFT, BLU_L = 1024;
const BLU_B_RE = new Float64Array(BLU_L), BLU_B_IM = new Float64Array(BLU_L);
(() => {
  for (let m = -(BLU_N - 1); m <= BLU_N - 1; m++) {
    const ang = (Math.PI * m * m) / BLU_N;
    BLU_B_RE[m + BLU_N - 1] = Math.cos(ang);
    BLU_B_IM[m + BLU_N - 1] = Math.sin(ang);
  }
  fftComplex(BLU_B_RE, BLU_B_IM, -1);
})();

function powerSpectrum(frame: Float64Array): Float64Array {
  const N = BLU_N;
  const aRe = new Float64Array(BLU_L), aIm = new Float64Array(BLU_L);
  for (let n = 0; n < N; n++) {
    const v = frame[n] * HANN[n];
    const ang = (-Math.PI * n * n) / N;
    aRe[n] = v * Math.cos(ang);
    aIm[n] = v * Math.sin(ang);
  }
  fftComplex(aRe, aIm, -1);
  const cRe = new Float64Array(BLU_L), cIm = new Float64Array(BLU_L);
  for (let i = 0; i < BLU_L; i++) {
    cRe[i] = aRe[i] * BLU_B_RE[i] - aIm[i] * BLU_B_IM[i];
    cIm[i] = aRe[i] * BLU_B_IM[i] + aIm[i] * BLU_B_RE[i];
  }
  fftComplex(cRe, cIm, +1);
  const numBins = N / 2 + 1;
  const out = new Float64Array(numBins);
  for (let k = 0; k < numBins; k++) {
    const convRe = cRe[k + N - 1] / BLU_L, convIm = cIm[k + N - 1] / BLU_L;
    const ang = (-Math.PI * k * k) / N;
    const twRe = Math.cos(ang), twIm = Math.sin(ang);
    const re = convRe * twRe - convIm * twIm;
    const im = convRe * twIm + convIm * twRe;
    out[k] = re * re + im * im;
  }
  return out;
}

/**
 * Whisper-style log-mel for the last 8 s of 16 kHz audio → Float32Array(80*800).
 * Mirrors pipecat `compute_whisper_log_mel_features(..., do_normalize=True)`.
 */
export function computeWhisperLogMel(audio: Float32Array): Float32Array {
  // Exactly WINDOW_SAMPLES, keeping the END (pipecat pads zeroes at the front).
  const x = new Float64Array(WINDOW_SAMPLES);
  const take = Math.min(audio.length, WINDOW_SAMPLES);
  x.set(audio.subarray(audio.length - take), WINDOW_SAMPLES - take);
  // zero-mean / unit-variance in float32 precision, BEFORE the spectrogram.
  let mean = 0; for (let i = 0; i < WINDOW_SAMPLES; i++) mean += x[i]; mean /= WINDOW_SAMPLES;
  let varSum = 0; for (let i = 0; i < WINDOW_SAMPLES; i++) { const d = x[i] - mean; varSum += d * d; }
  const std = Math.sqrt(varSum / WINDOW_SAMPLES + NORM_EPS);
  for (let i = 0; i < WINDOW_SAMPLES; i++) x[i] = (x[i] - mean) / std;

  // Centered reflect-padded frames; number of frames = floor((N-pad-1)/hop)+1 for padding=200 → 800.
  const pad = N_FFT / 2;
  const numFrames = Math.floor((x.length + 2 * pad - N_FFT) / HOP) + 1; // 800
  const numBins = N_FFT / 2 + 1;
  // power spectrogram, column-major frame-major: spec[frame*numBins + bin]
  const spec = new Float64Array(numFrames * numBins);
  const frame = new Float64Array(N_FFT);
  for (let t = 0; t < numFrames; t++) {
    const start = t * HOP;
    for (let i = 0; i < N_FFT; i++) {
      let idx = i + start - pad;
      if (idx < 0) idx = -idx;               // reflect left (pad=200 > max index 199 here)
      else if (idx >= x.length) idx = 2 * x.length - idx - 2; // reflect right
      frame[i] = x[idx];
    }
    const p = powerSpectrum(frame);
    spec.set(p, t * numBins);
  }

  // mel = filterbank(80×201) @ spec(201×800), then log10 / clamp / (·+4)/4.
  const logSpec = new Float64Array(N_MELS * numFrames);
  for (let m = 0; m < N_MELS; m++) {
    for (let t = 0; t < numFrames; t++) {
      let acc = 0;
      const fRow = m * numBins, sCol = t * numBins;
      for (let k = 0; k < numBins; k++) acc += MEL_FILTERS[fRow + k] * spec[sCol + k];
      logSpec[m * numFrames + t] = Math.log10(Math.max(MEL_FLOOR, acc));
    }
  }
  // drop trailing frame (799→800 kept as 800 columns from 0..798? numpy drops last → 799 cols;
  // but the model wants 800, so we keep all numFrames which equals 800 after the drop below).
  // numpy: log_spec[:, :-1] on 801 frames → 800. Ours produced 800 already; keep as-is.
  let gmax = -Infinity;
  for (let i = 0; i < logSpec.length; i++) if (logSpec[i] > gmax) gmax = logSpec[i];
  const floor = gmax - 8;
  const out = new Float32Array(N_MELS * 800);
  for (let m = 0; m < N_MELS; m++) {
    for (let t = 0; t < 800; t++) {
      const v = Math.max(logSpec[m * numFrames + t], floor);
      out[m * 800 + t] = (v + 4) / 4;
    }
  }
  return out;
}

// ---- Delay decision (pure) ----------------------------------------------------------------------
export interface EOTConfig {
  /** P(complete) at/above which we use the short delay. */
  probabilityThreshold: number;
  /** Delay when the model says "done" (or is absent). */
  minDelayMs: number;
  /** Hard ceiling when the model says "not done" — never cut the operator off. */
  maxDelayMs: number;
}
export const EOT_DEFAULT: EOTConfig = {
  probabilityThreshold: 0.5,
  minDelayMs: 600,
  maxDelayMs: 3000,
};

/** Model only decides HOW LONG to wait; `fallbackMs` is the operator's plain silenceMs. */
export function endpointDelayMs(probability: number | null, cfg: EOTConfig, fallbackMs = 1500): number {
  if (probability === null || !Number.isFinite(probability)) return fallbackMs;
  return probability >= cfg.probabilityThreshold ? cfg.minDelayMs : cfg.maxDelayMs;
}

/** Latest probability + whether inference has ever succeeded. */
export interface SmartTurnResult { probability: number | null; ok: boolean; }

export class SmartTurn {
  #session: InferenceSession | null = null;
  #ort: typeof import("onnxruntime-web/wasm") | null = null;
  #buf: number[] = [];
  #busy = false;
  probability: number | null = null;
  lastRunAt = 0;

  get ready(): boolean { return this.#session !== null; }

  /** Load runtime + model. Resolves false — never throws — on any device that cannot run it. */
  async load(modelUrl: string): Promise<boolean> {
    if (this.#session) return true;
    try {
      const ort = await import("onnxruntime-web/wasm");
      ort.env.wasm.numThreads = 1;
      ort.env.logLevel = "error";
      this.#ort = ort;
      this.#session = await ort.InferenceSession.create(modelUrl, {
        executionProviders: ["wasm"], graphOptimizationLevel: "all",
      });
      return true;
    } catch (e) {
      console.warn("[smart-turn] unavailable, falling back to the silence gate:", (e as Error)?.message ?? e);
      this.#session = null; this.#ort = null;
      return false;
    }
  }

  /** Drop everything from the previous call (the model keeps its weights). */
  reset(): void { this.#buf = []; this.probability = null; this.lastRunAt = 0; }

  /** Feed 16 kHz samples. Ring buffer keeps at most the last 8 s. */
  push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) this.#buf.push(samples[i]);
    const overflow = this.#buf.length - WINDOW_SAMPLES;
    if (overflow > 0) this.#buf.splice(0, overflow);
  }

  /** Run one inference on the current window. Never throws; ok:false on any failure. */
  async analyze(): Promise<SmartTurnResult> {
    if (!this.#session || !this.#ort || this.#busy) return { probability: this.probability, ok: false };
    this.#busy = true;
    try {
      const feats = computeWhisperLogMel(Float32Array.from(this.#buf));
      const input = new this.#ort.Tensor("float32", feats, [1, 80, 800]);
      const out = await this.#session.run({ input_features: input });
      const p = Number((out.logits as Tensor).data[0]);
      if (Number.isFinite(p)) { this.probability = p; this.lastRunAt = Date.now(); return { probability: p, ok: true }; }
      return { probability: this.probability, ok: false };
    } catch (e) {
      console.warn("[smart-turn] inference failed, using the silence gate:", (e as Error)?.message ?? e);
      return { probability: this.probability, ok: false };
    } finally {
      this.#busy = false;
    }
  }
}

export const smartTurn = new SmartTurn();
