// RED-first unit checks for Smart Turn v3 semantic end-of-turn.
// Run: npx tsx scripts/qa/smart-turn-units.mts
import {
  computeWhisperLogMel, endpointDelayMs, EOT_DEFAULT,
} from "../../packages/web/src/smart-turn.ts";
import golden from "./smart-turn-golden.json" with { type: "json" };

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// --- 1. log-mel 与 python golden 逐点等价（golden 来自 pipecat vendored 实现）-------------------
{
  const g = golden as Record<string, { flat: number[]; min: number; max: number; sum: number }>;
  // silence: trivial (all -1.5) but validates shape + constant path.
  const w = new Float32Array(128000);
  const f = computeWhisperLogMel(w);
  check("log-mel shape is 80×800", f.length === 80 * 800, `len=${f.length}`);
  let maxErr = 0;
  for (let i = 0; i < g.silence.flat.length; i++) maxErr = Math.max(maxErr, Math.abs(f[i] - g.silence.flat[i]));
  check("silence log-mel matches golden", maxErr < 1e-3, `maxErr=${maxErr.toExponential(2)}`);

  // tone + speechlike: non-uniform spectra — these actually exercise the FFT/mel path.
  function checkSignal(name: string, samples: Float32Array): void {
    const got = computeWhisperLogMel(samples);
    const want = g[name].flat;
    let err = 0, worst = 0;
    for (let i = 0; i < want.length; i++) { const d = Math.abs(got[i] - want[i]); err = Math.max(err, d); worst += d; }
    let gmin = Infinity, gmax = -Infinity;
    for (let i = 0; i < got.length; i++) { if (got[i] < gmin) gmin = got[i]; if (got[i] > gmax) gmax = got[i]; }
    check(`${name} log-mel matches golden (max abs err < 0.05)`,
      err < 0.05, `maxErr=${err.toFixed(4)} min=${gmin.toFixed(3)}/${g[name].min} max=${gmax.toFixed(3)}/${g[name].max}`);
  }
  const tone = new Float32Array(128000);
  for (let i = 0; i < tone.length; i++) tone[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / 16000);
  checkSignal("tone", tone);
  // multi-tone (deterministic): exercises many mel bins, no PRNG precision mismatch across JS/Python.
  const multi = new Float32Array(128000);
  for (let i = 0; i < multi.length; i++) {
    const t = i / 16000;
    multi[i] = 0.2 * Math.sin(2 * Math.PI * 150 * t) + 0.15 * Math.sin(2 * Math.PI * 900 * t)
      + 0.1 * Math.sin(2 * Math.PI * 2400 * t);
  }
  checkSignal("multitone", multi);
}

// --- 2. 延迟调节：模型只决定等多久，绝不独立发送 -----------------------------------------------
const cfg = { ...EOT_DEFAULT };
check("prob ≥ threshold (say complete) → SHORT delay", endpointDelayMs(0.9, cfg) === cfg.minDelayMs,
  `${endpointDelayMs(0.9, cfg)}`);
check("prob < threshold (say NOT complete) → LONG delay (中文漏判兜底，不抢话)",
  endpointDelayMs(0.3, cfg) === cfg.maxDelayMs, `${endpointDelayMs(0.3, cfg)}`);
check("no model result → fallback to operator's silenceMs (behavior unchanged)",
  endpointDelayMs(null, cfg, 3200) === 3200, `${endpointDelayMs(null, cfg, 3200)}`);
check("maxDelay is the hard ceiling even on extreme 'incomplete'",
  endpointDelayMs(0.0, cfg) <= cfg.maxDelayMs);
check("minDelay default is far below the old one-size 1500ms (fixes the dumb wait)",
  cfg.minDelayMs <= 800, `minDelayMs=${cfg.minDelayMs}`);

// --- 3. 阈值可调：中文校准把阈值抬高 → 更多样本判没说完 → 走长延迟（安全方向）------------------
{
  const strict = { ...cfg, probabilityThreshold: 0.85 };
  check("raising threshold makes a borderline prob go LONG (safer for Chinese)",
    endpointDelayMs(0.7, strict) === strict.maxDelayMs
    && endpointDelayMs(0.7, cfg) === cfg.minDelayMs,
    `strict=${endpointDelayMs(0.7, strict)} default=${endpointDelayMs(0.7, cfg)}`);
}

console.log(`\nsmart-turn-units: ${pass} ok / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
