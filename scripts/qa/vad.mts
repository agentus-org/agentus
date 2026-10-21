// Unit checks for the call's voice detector (packages/web/src/vad.ts).
//
// Why a unit test and not a browser sweep: the failures this replaces were measured on real calls and
// are about LEVELS a browser cannot be told to produce — a phone whose own loudspeaker leaks back
// over 0.010 (the call interrupted itself), and a quiet speaker under it (「语音打断从来没起过作用」).
// The numbers below are those two rooms.
//
// Run: npx tsx scripts/qa/vad.mts
import { newVad, vadFloorRms, vadStep } from "../../packages/web/src/vad.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { pass++; console.log(`  ok   ${name}${detail ? `  — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`); }
};

/** Feed n frames, 120 ms apart (the call's own tick), and collect the verdicts. */
const run = (st: ReturnType<typeof newVad>, rms: number, n: number, t0: number, step = 120) => {
  const out: boolean[] = [];
  for (let i = 0; i < n; i++) out.push(vadStep(st, rms, t0 + i * step));
  return out;
};

// 1. A quiet room with nobody in it: nothing is ever speech, and the floor learns the room.
{
  const st = newVad();
  const v = run(st, 0.003, 40, 0);
  check("a quiet room is silent", v.every((x) => !x));
  check("the floor learned the room", Math.abs(st.floor - 0.003) < 0.0006, st.floor.toFixed(5));
}

// 2. THE SELF-INTERRUPTION CASE: a phone lying on a table, its own reply leaking back at 0.02 —
//    above the old absolute bar (0.010) with nobody speaking. Measured over must stay silent.
{
  const st = newVad();
  const v = run(st, 0.02, 60, 0);
  // The first frames are indistinguishable from a voice; what matters is that a STEADY level settles
  // into the floor instead of holding the gate open for the whole reply (a leak is steady, speech is not).
  check("a loud steady leak stops counting as a voice within a second",
    v.slice(12).every((x) => !x), `firstTrue=${v.findIndex((x) => !x)} floor=${st.floor.toFixed(4)}`);
  check("…and the gate sits above it once the floor is learned",
    vadFloorRms(st) > 0.02, vadFloorRms(st).toFixed(4));
}

// 3. THE INAUDIBLE-OPERATOR CASE: a quiet voice at 0.009, under the old 0.010 bar, in a room whose
//    floor is 0.003. A step over the measured floor IS speech.
{
  const st = newVad(0.003);
  const v = run(st, 0.009, 5, 0);
  check("a quiet voice over a quiet floor is heard", v.every((x) => x === true), vadFloorRms(st).toFixed(4));
}

// 4. Hangover: the gaps INSIDE a sentence (「我想… 那个… 就是」) must not read as the end of it.
{
  const st = newVad(0.003);
  vadStep(st, 0.05, 0);                       // a voiced frame
  vadStep(st, 0.003, 300);                    // a 300 ms gap
  check("a 300 ms gap keeps the sentence alive", st.speech === true);
  vadStep(st, 0.003, 900);                    // …but 900 ms is the end of it
  check("a 900 ms gap ends it", st.speech === false);
}

// 5. The room gets louder (a fan, a window): the floor follows, so the fan does not become a voice
//    and does not hide the operator either.
{
  const st = newVad(0.003);
  run(st, 0.003, 40, 0);
  const v = run(st, 0.03, 80, 5000);          // ~10 s of a louder room
  check("a louder room is not a voice", v.slice(-10).every((x) => !x));
  check("…and the floor followed it up", st.floor > 0.02, st.floor.toFixed(4));
  check("…and a voice over THAT room is still heard", vadStep(st, 0.12, 5000 + 80 * 120) === true);
}

// 6. A long sentence must not teach the gate that speech is silence.
{
  const st = newVad(0.003);
  // A real sentence swings: loud syllable, quieter one. A CONSTANT loud tone is a leak, not speech,
  // and the test above already says the floor must swallow that.
  for (let i = 0; i < 100; i++) vadStep(st, i % 2 ? 0.07 : 0.03, i * 120);
  check("a long swinging sentence does not raise the floor", st.floor < 0.01, st.floor.toFixed(4));
  check("…and it is heard the whole way through", st.speech === true);
}

// 7. A quieter room (window closed) drops the floor fast enough to keep a soft voice audible.
{
  const st = newVad(0.05);
  run(st, 0.004, 20, 0);
  check("the floor falls quickly when the room goes quiet", st.floor < 0.02, st.floor.toFixed(4));
}

// 8. Garbage in the meter must not poison the state (a suspended AudioContext reports NaN).
{
  const st = newVad(0.003);
  const v = run(st, Number.NaN, 5, 0);
  check("NaN frames are treated as silence, not as voice", v.every((x) => !x));
  check("…and do not move the floor", Math.abs(st.floor - 0.003) < 1e-9, String(st.floor));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
