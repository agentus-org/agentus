// Unit checks for the call's BARGE GATE (packages/web/src/callSettings.ts).
//
// Why a unit test and not a browser sweep: the failure the operator reported is acoustic — the
// call's own loudspeaker came back through its own microphone and the call interrupted ITSELF mid
// answer (「它刚输出一段话就自己打断自己，我都没说话」), and later 「语音打断从来没起过作用」.
// A browser sweep can fake a level (`__asFeed`) but it cannot fake the relationship between that
// level and what the page is playing; the gate is pure arithmetic on those numbers, so this is
// where it gets pinned down.
//
// UNITS: everything is real microphone / playback RMS, 0..1 (`levelRms()` / `playbackRms()`).
// The previous version of this test was written in DISPLAY units (mic = rms×6, playback = rms×4,
// both clamped at 1) and that is precisely why it passed while the real call could never barge:
// a loud reply pinned both meters at 1.0, so the bar (0.45 × 1.0) sat above any human voice.
//
// Run: npm run barge-gate   (tsx; no browser, no server)
import {
  BARGE_COOLDOWN_MS, BARGE_GRACE_MS, CALL_DEFAULT, ECHO, ECHO_RISE, INTERRUPT_MODES, bargeFloorRms,
  isBargeEvidence, matchesWakePhrase, normalizeCall, normalizeWakePhrase,
} from "../../packages/web/src/callSettings.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const S = CALL_DEFAULT.bargeSensitivity;         // 60 %
const FLOOR = bargeFloorRms(S);                  // ≈ 0.0156 RMS
/** A quiet room: echo of a mid-level reply, no voice. */
const PLAY = 0.10;
const ECHO_MIC = 0.05;                           // what that reply puts back into the microphone

const ev = (mic: number, play: number, base: number, aec = true, s = S): boolean =>
  isBargeEvidence(mic, play, base, s, aec);

// 1. THE REPORTED BUG. Echo only — the reply is playing, nobody is talking. Whatever the echo
//    level is, "no rise over the learned echo" must not take the floor.
{
  check("a steady echo is NOT the operator taking the floor", ev(ECHO_MIC, PLAY, ECHO_MIC, false) === false,
    `mic ${ECHO_MIC} vs base ${ECHO_MIC}`);
  check("…even a LOUD reply's echo, once the baseline is learned",
    ev(0.35, 0.35, 0.35, false) === false, "mic = play = base = 0.35");
  check("…and with the canceller on, an echo that stays put is still not speech",
    ev(0.02, PLAY, 0.02, true) === false);
}
// 2. A human voice over a reply IS a step over that baseline (the primary proof).
{
  // (strictly above the threshold, not exactly on it: `>` is the test, and floats are floats)
  check(`a voice ${ECHO_RISE}× the echo takes the floor`,
    ev(ECHO_MIC * (ECHO_RISE + 0.05), PLAY, ECHO_MIC, false) === true);
  check(`…and ${ECHO_RISE}× exactly does not`, ev(ECHO_MIC * ECHO_RISE, PLAY, ECHO_MIC, false) === false);
  check("a voice over a LOUD reply also counts (the case the old gate could never reach)",
    ev(0.60, 0.35, 0.35, false) === true, "mic 0.60 vs base 0.35 with play 0.35");
}
// 3. Before the baseline exists (first ~600 ms of a clip) the playback comparison is the only test,
//    and it must stay shut when the microphone hears only the speaker.
{
  check("no baseline yet + a raw echo: gate shut", ev(PLAY * 1.0, PLAY, 0, false) === false);
  check("no baseline yet + a voice clearly above the reply: floor taken", ev(PLAY * 1.5, PLAY, 0, false) === true);
  check("no baseline yet, AEC on: a modest voice over the reply counts", ev(PLAY * 0.6, PLAY, 0, true) === true);
  check("no baseline yet, AEC on, echo only: still shut", ev(PLAY * 0.5, PLAY, 0, true) === false);
}
// 4. The floor: quieter than the sensitivity's RMS floor never counts, no matter the ratio.
{
  check("a murmur under the floor is ignored even over a silent room",
    ev(FLOOR * 0.9, -1, 0, true) === false);
  check("nothing playing: a voice over the floor takes the floor", ev(FLOOR * 1.4, -1, 0, true) === true);
  check("nothing playing: room noise under the floor does not", ev(0.006, -1, 0, true) === false);
}
// 5. The sensitivity control still means something, monotonically, at both ends.
{
  check("sensitivity 0 % (迟钝) needs a raised voice", ev(0.02, -1, 0, true, 0) === false);
  check("sensitivity 100 % (灵敏) opens at a murmur", ev(0.010, -1, 0, true, 100) === true);
  check("the floor is monotone: 0 % > 60 % > 100 %",
    bargeFloorRms(0) > bargeFloorRms(60) && bargeFloorRms(60) > bargeFloorRms(100));
  check("the default floor sits between room noise and speech", FLOOR > 0.02 && FLOOR < 0.05, `${FLOOR.toFixed(4)}`);
}
// 6. An echo canceller that LIES (reports on, cancels nothing) cannot re-open the self-interrupt:
//    once a baseline exists, the rise test decides — not the canceller's claim.
{
  check("AEC claims on, echo is as loud as the reply: baseline still keeps the gate shut",
    ev(PLAY, PLAY, PLAY, true) === false);
}
// 7. The timing guards the loop applies on top must outlast a clip's attack transient (the click
//    that reads as a spike) and a barge's own tail.
{
  check("the grace window is longer than a speaker's attack transient", BARGE_GRACE_MS >= 400, `${BARGE_GRACE_MS}ms`);
  check("the cooldown outlasts the grace window", BARGE_COOLDOWN_MS > BARGE_GRACE_MS,
    `${BARGE_COOLDOWN_MS}ms vs ${BARGE_GRACE_MS}ms`);
  check("the echo model is below 1 (a real canceller removes most of it) and the raw ratio is above it",
    ECHO.aec > 0 && ECHO.aec < 1 && ECHO.raw > 1,
    `aec ${ECHO.aec} raw ${ECHO.raw}`);
  check("the rise threshold is above unity (echo may wobble) and reachable by a voice",
    ECHO_RISE > 1.2 && ECHO_RISE < 2.2, `${ECHO_RISE}`);
}

// 8. 关键词打断 (#42's comment): the confirmation is a WORD, not a level. The recogniser writes the
//    same two syllables differently every time (`小灵`, `小 灵`, `小灵，`, `小灵。`), so both sides of
//    the comparison are stripped of spaces/punctuation/case before the match.
{
  check("a phrase match needs no spaces and survives punctuation",
    matchesWakePhrase("小灵，停一下", "小灵") && matchesWakePhrase("小 灵", "小灵"));
  check("…and the operator's capitalisation does not matter",
    matchesWakePhrase("Hey Agent, stop", "hey agent"));
  check("a phrase that was NOT said does not take the floor",
    matchesWakePhrase("你好呀，今天天气不错", "小灵") === false);
  check("an empty phrase is INERT, never 'always on'", matchesWakePhrase("小灵", "") === false
    && matchesWakePhrase("", "") === false);
  check("switching to keyword without typing a phrase changes nothing",
    normalizeCall({ ...CALL_DEFAULT, interruptMode: "keyword" }).wakePhrase === "");
  check("the stored phrase is trimmed and capped at 24 characters",
    normalizeWakePhrase("  小  灵  ") === "小 灵" && normalizeWakePhrase("x".repeat(40)).length === 24);
  check("keyword is a real interrupt mode the server also accepts",
    INTERRUPT_MODES.some((m) => m.id === "keyword"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
