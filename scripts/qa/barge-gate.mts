// Unit checks for the call's BARGE GATE (packages/web/src/callSettings.ts).
//
// Why a unit test and not a browser sweep: the failure the operator reported is acoustic — the
// call's own loudspeaker came back through its own microphone and the call interrupted ITSELF mid
// answer (「它刚输出一段话就自己打断自己，我都没说话」). A browser sweep can fake a level
// (`__asFeed`) but it cannot fake the relationship between that level and what the page is
// playing; the gate is pure arithmetic on those two numbers, so this is where it gets pinned down.
//
// The two levels are NOT on one scale (see ECHO): mic = rms × 6, playback = rms × 4, both clamped
// at 1. Every case below is written in that unit system, echo = 1.5 × playback.
//
// Run: npm run barge-gate   (tsx; no browser, no server)
import {
  BARGE_COOLDOWN_MS, BARGE_GRACE_MS, CALL_DEFAULT, ECHO, bargeLevelOf, isBargeEvidence,
} from "../../packages/web/src/callSettings.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const S = CALL_DEFAULT.bargeSensitivity;   // 60 → floor 0.23
const ev = (mic: number, play: number, aec = true, s = S): boolean => isBargeEvidence(mic, play, s, aec);

// 1. THE REPORTED BUG. Echo only: the reply is playing and nobody is talking. With cancellation
//    off the echo reads exactly 1.5 × playback, which is ABOVE the old absolute floor — that is
//    why the call used to interrupt itself. The gate must stay shut.
{
  const play = 0.5, echo = play * 1.5;
  check("a raw echo (nobody talking) is NOT the operator taking the floor",
    ev(echo, play, false) === false, `mic ${echo} vs play ${play}`);
  check("…even though it clears the old absolute floor — the bug, kept as a regression",
    echo > bargeLevelOf(S), `echo ${echo} > floor ${bargeLevelOf(S)}`);
}
// 2. …and the same echo with the canceller working is quieter, so it is comfortably rejected.
{
  check("a cancelled echo is rejected too", ev(0.18, 0.6, true) === false, "mic 0.18 / play 0.6");
}
// 3. A human talking over a podcast-loud reply, cancellation OFF: they have to beat the echo.
{
  check("no AEC: talking AT the reply's own level does not count", ev(0.62, 0.42, false) === false,
    "mic 0.62 vs echo 0.63");
  check("no AEC: talking clearly louder than the reply takes the floor", ev(0.9, 0.42, false) === true);
}
// 4. With cancellation ON the sensitivity floor governs: a normal voice takes it back.
{
  check("AEC on: a normal voice over a loud reply takes the floor", ev(0.5, 0.6, true) === true);
  check("AEC on: a quiet room still needs the floor", ev(0.1, 0.05, true) === false);
}
// 5. The browser voice cannot be tapped: playback is -1 (no echo model) — the plain absolute bar.
{
  check("no measurable playback falls back to the absolute floor",
    ev(0.3, -1, true) === true && ev(0.2, -1, true) === false, "0.3 in, 0.2 out");
}
// 6. The sensitivity control still means something — monotone in both directions, and it can
//    never be talked past on the wrong side.
{
  const play = -1;
  check("sensitivity 0% (迟钝) needs a shout", ev(0.45, play, true, 0) === false);
  check("sensitivity 100% (灵敏) opens at a low voice", ev(0.1, play, true, 100) === true);
  check("the floor is monotone: 0% > 60% > 100%",
    bargeLevelOf(0) > bargeLevelOf(60) && bargeLevelOf(60) > bargeLevelOf(100));
}
// 7. A reply loud enough to clamp BOTH meters cannot be talked over on a raw capture — the honest
//    outcome, not a coin flip: the button is the floor control there, and the panel says so.
{
  check("no AEC + clamped meters: voice barge cannot fire (by design)", ev(1, 1, false) === false);
}
// 8. The timing guards the loop applies on top must outlast a clip's attack transient (the click
//    that reads as a spike) and a barge's own tail.
{
  check("the grace window is longer than a speaker's attack transient", BARGE_GRACE_MS >= 400,
    `${BARGE_GRACE_MS}ms`);
  check("the cooldown outlasts the grace window", BARGE_COOLDOWN_MS > BARGE_GRACE_MS,
    `${BARGE_COOLDOWN_MS}ms vs ${BARGE_GRACE_MS}ms`);
  check("the echo model is below the raw echo ratio (1.5) and above zero",
    ECHO.aec > 0 && ECHO.aec < 1 && ECHO.raw > 1.5 && ECHO.raw < 2,
    `aec ${ECHO.aec} raw ${ECHO.raw}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
