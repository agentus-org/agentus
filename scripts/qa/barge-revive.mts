// Unit checks for the L4 false-interruption state machine (packages/web/src/barge-in.ts).
//
// The decision is deliberately a PURE function of three inputs: (state, now, voice). `voice` is
// "the mic still hears a human after we paused playback" — pausing removes our own echo, so this
// one bit separates a real barge (operator keeps talking) from a false one (echo/noise that passed
// the L1 gate but stops the moment our own speaker goes quiet). No browser, no server, no clock.
//
// Run: npx tsx scripts/qa/barge-revive.mts
import {
  beginSuspect, newSuspectState, suspectStep,
  FALSE_INTERRUPT_SETTLE_MS as SETTLE, FALSE_INTERRUPT_SILENCE_MS as SILENCE,
  FALSE_INTERRUPT_MAX_MS as MAX, FALSE_INTERRUPT_CONFIRM_TICKS as TICKS,
} from "../../packages/web/src/barge-in.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// --- 1. real interruption: voice continues after the pause -----------------------------------
{
  let st = beginSuspect(1000);
  // within SETTLE: must wait even if a voice blip arrives (echo tail), so it does not confirm on self-echo
  const early = suspectStep(st, 1000 + SETTLE - 1, true);
  check("real: silent decision during settle window", early.verdict === "wait", early.verdict);
  // settle elapsed, voice for ONE tick is not enough (rejects a single spike above the floor)
  const oneTick = suspectStep(st, 1000 + SETTLE, true);
  check("real: a single voice tick after settle does NOT confirm (spike guard)", oneTick.verdict === "wait", oneTick.verdict);
  // a second consecutive voice tick confirms
  const confirmed = suspectStep(oneTick.state, 1000 + SETTLE + 120, true);
  check("real: confirms after consecutive voice ticks past settle", confirmed.verdict === "confirm", confirmed.verdict);
  check("real: verdict is one-shot, state returns to idle", confirmed.state.active === false);
}

// --- 2. false interruption: mic goes quiet after the pause ----------------------------------
{
  let st = beginSuspect(5000);
  let v = "wait";
  // no voice for SETTLE+SILENCE -> revive
  for (let t = 5000; t <= 5000 + SETTLE + SILENCE; t += 20) {
    const r = suspectStep(st, t, false);
    st = r.state; v = r.verdict;
    if (v !== "wait") break;
  }
  check("false: revives after settle+silence of quiet", v === "revive", v);
}

// --- 3. a single voice blip is rejected; it takes consecutive ticks (F2) ----------------------
{
  let st = beginSuspect(9000);
  // quiet through settle, then ONE blip of voice -> not enough to confirm (spike guard)
  st = suspectStep(st, 9000 + SETTLE, false).state;
  const blip = suspectStep(st, 9000 + SETTLE + 100, true);
  check("a single blip after settle is NOT enough to confirm", blip.verdict === "wait", blip.verdict);
  // a second consecutive voice tick -> confirmed (a real human kept talking)
  const held = suspectStep(blip.state, 9000 + SETTLE + 220, true);
  check("a held voice (2 ticks) confirms the interruption", held.verdict === "confirm", held.verdict);
  check("confirm dwell is 2 ticks", TICKS === 2, `TICKS=${TICKS}`);
}

// --- 4. hard cap: a state whose clock is already past MAX is still resolved -------------------
// (In production `now` advances monotonically with startedAt, so the silence rule fires first;
// this pins the ceiling as a backstop so a clock anomaly / monotonic jump can never freeze the
// call with playback paused indefinitely.)
{
  const st = beginSuspect(20000);
  const r = suspectStep(st, 20000 + MAX + 50, false);
  check("hard cap resolves a stale state to revive", r.verdict === "revive", r.verdict);
  check("hard cap returns to idle", r.state.active === false);
}

// --- 5. minimum dwell: a real barge does not confirm before SETTLE even if voice is constant --
{
  const st = beginSuspect(30000);
  let confirmedEarly = false;
  for (let t = 30000; t < 30000 + SETTLE; t += 10) {
    if (suspectStep(st, t, true).verdict === "confirm") confirmedEarly = true;
  }
  check("no confirmation inside the settle window", !confirmedEarly);
}

// --- 6. idle state is inert ------------------------------------------------------------------
{
  const r = suspectStep(newSuspectState(), 12345, true);
  check("idle state never emits a verdict", r.verdict === "wait", r.verdict);
}

// --- 7. constants are sane and match the design doc -----------------------------------------
check("settle < silence+settle < max", SETTLE > 0 && SILENCE > 0 && SETTLE + SILENCE <= MAX,
  `${SETTLE}/${SILENCE}/${MAX}`);

console.log(`\nbarge-revive: ${pass} ok / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
