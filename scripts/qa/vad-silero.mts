// The REAL detector, on real audio: Silero VAD v6 through `onnxruntime-web`, the same runtime the
// page uses, fed the same 576-sample window (512 new + 64 context).
//
// Why this test exists: everything else about the speech detector can be faked. This one cannot — it
// is the only place that proves the shipped model + the shipped runtime + the frame layout actually
// score speech as speech. The measurement that chose the model lives here (2026-10-21, this machine):
//
//     speech (its own `say` synthesis): 117 frames · mean 0.814 · peak 1.000
//     silence (1 s of zeros):            31 frames · mean 0.005 · peak 0.009
//
// It synthesises its fixture with `say` (macOS), so on a machine without it the checks are SKIPPED
// rather than failed — the model still gets loaded and exercised on silence, which is the part that
// would break first if the frame layout drifted.
//
// Run: npx tsx scripts/qa/vad-silero.mts
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { newSileroState, sileroStep } from "../../packages/web/src/silero.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { pass++; console.log(`  ok   ${name}${detail ? `  — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`); }
};

const MODEL = path.resolve(import.meta.dirname, "../../packages/web/public/vad/silero_vad.onnx");
check("the model is committed with the app", fs.existsSync(MODEL), `${Math.round((fs.statSync(MODEL).size) / 1024)} KB`);

// ---- the decision layer, without the model ------------------------------------------------
{
  const st = newSileroState();
  check("silence is not speech", sileroStep(st, 0.02, 1000) === false);
  check("a clear voice starts a sentence", sileroStep(st, 0.92, 1200) === true);
  check("a dip to the model's OFF band keeps it alive briefly", sileroStep(st, 0.45, 1400) === true);
  check("…and the hangover ends it 700 ms after the last confident frame", sileroStep(st, 0.10, 2600) === false);
  const st2 = newSileroState();
  sileroStep(st2, 0.9, 0);
  check("a prob under OFF ends it on that frame (no hangover)", sileroStep(st2, 0.20, 100) === false);
}

// ---- the model, on this machine's own audio ----------------------------------------------
const ort = await import("onnxruntime-web");
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = path.resolve(import.meta.dirname, "../../node_modules/onnxruntime-web/dist/") + "/";
ort.env.logLevel = "error";
const session = await ort.InferenceSession.create(MODEL, { executionProviders: ["wasm"] });
check("the model loads in the wasm runtime", session.inputNames.join(",") === "input,state,sr",
  session.inputNames.join(","));

/** 16-bit mono 16 kHz WAV → Float32Array. */
const wavToF32 = (file: string): Float32Array => {
  const b = fs.readFileSync(file);
  let off = 12, at = -1, len = 0;
  while (off < b.length - 8) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === "data") { at = off + 8; len = size; break; }
    off += 8 + size + (size % 2);
  }
  const n = Math.floor(len / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readInt16LE(at + i * 2) / 32768;
  return out;
};

/** Stream 512-sample frames with the 64-sample context Silero v6 expects. */
const scoreAll = async (pcm: Float32Array): Promise<number[]> => {
  let state = new ort.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
  const sr = new ort.Tensor("int64", BigInt64Array.from([16000n]), []);
  let ctx = new Float32Array(64);
  const probs: number[] = [];
  for (let i = 0; i + 512 <= pcm.length; i += 512) {
    const frame = pcm.slice(i, i + 512);
    const input = new Float32Array(576);
    input.set(ctx, 0);
    input.set(frame, 64);
    const out = await session.run({ input: new ort.Tensor("float32", input, [1, 576]), state, sr });
    state = out.stateN as typeof state;
    ctx = frame.slice(-64);
    probs.push(Number((out.output as { data: Float32Array }).data[0]));
  }
  return probs;
};

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

const quiet = await scoreAll(new Float32Array(16000));
check("one second of silence is never scored as speech", Math.max(...quiet) < 0.20,
  `peak ${Math.max(...quiet).toFixed(3)} mean ${mean(quiet).toFixed(3)}`);

let spoke = false;
try {
  const dir = mkdtempSync(path.join(tmpdir(), "vad-silero-"));
  const aiff = path.join(dir, "s.aiff");
  const wav = path.join(dir, "s.wav");
  execFileSync("say", ["-o", aiff, "你好，我是小灵，现在测试一下语音检测。"], { stdio: "ignore" });
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav], { stdio: "ignore" });
  const probs = await scoreAll(wavToF32(wav));
  spoke = true;
  check("real speech is scored as speech", Math.max(...probs) > 0.8,
    `${probs.length} frames · peak ${Math.max(...probs).toFixed(3)} mean ${mean(probs).toFixed(3)}`);
  check("…and the frame layout keeps it there, not just for one frame",
    mean(probs) > 0.5, `mean ${mean(probs).toFixed(3)}`);
} catch (e) {
  console.log(`  skip no speech fixture on this machine (${(e as Error)?.message?.slice(0, 60) ?? e})`);
}
if (!spoke) console.log("  note the model was still exercised on silence above");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
