// L4 false-interruption revival — the decision half of "barge-in is a mechanism, not a switch".
//
// WHY THIS EXISTS
// The L1 detector (callSettings.isBargeEvidence) and the L2 floor-take (CallMode.takeFloor) were
// already mature; issue #111's "we only did level detection" framing was stale. The one genuine
// gap was L4: a FALSE barge (the call's own echo, a loud noise that passed the L1 dwell) destroyed
// the rest of the answer for good, because takeFloor() stopped playback, cancelled the turn and
// cleared the queue in one destructive step. LiveKit solves this by PAUSING audio, waiting a short
// window, and resuming if no human followed — verified in its source at
// voice/agent_activity.py:2553-2571 (pause-not-destroy) and :5180-5368 (false-interruption timer).
//
// THE ONE SIGNAL
// We pause playback the instant a barge candidate fires. That removes our OWN speaker from the mic
// (the echo that fooled L1 in the first place). What remains in the mic is the discriminator:
//   voice still present after the pause  -> a real human is talking  -> confirm the interruption;
//   mic goes quiet after the pause       -> it was echo/noise         -> revive, keep reading.
//
// WHY IT IS PURE
// The state machine depends on nothing but (state, now, voice). No AudioContext, no clock, no
// React — so `scripts/qa/barge-revive.mts` pins every branch without a browser or a server, in the
// same style as vad.ts / speakQueue.ts / callSettings.ts. The caller drives it from the 120 ms loop
// and performs the side effects (pause / resume / takeFloor / reopen mic).

/** Ignore the mic for this long after pausing: the echo tail and the clip's attack transient die
 *  here. Without it, a self-echo that just crossed L1 would confirm as a "real voice" one tick
 *  later and defeat the whole feature. Mirrors LiveKit's backchannel boundary / grace idea. */
export const FALSE_INTERRUPT_SETTLE_MS = 200;
/** After settle, this much continuous quiet means it was a false interruption: resume playback.
 *  LiveKit's default false_interruption_timeout is 2.0 s; ours is shorter because the discriminator
 *  is the post-pause mic level, not a wait-for-final-transcript. */
export const FALSE_INTERRUPT_SILENCE_MS = 300;
/** Hard ceiling on the suspect window so an ambiguous input can never leave the call frozen with
 *  playback paused. On timeout we side with revival: a wrong revival is recoverable by a second
 *  barge, a lost answer is not. */
export const FALSE_INTERRUPT_MAX_MS = 1200;

export interface SuspectState {
  /** false = idle (no decision pending); true = playback paused, waiting for the verdict. */
  active: boolean;
  /** Date.now() at which the candidate fired and playback was paused. */
  startedAt: number;
  /** Consecutive post-settle ticks with `voice` true. Guards against a single cross-floor spike. */
  voiceTicks: number;
}

export type SuspectVerdict = "wait" | "confirm" | "revive";

/** Consecutive voice ticks required to CONFIRM after the settle window. At 120 ms/tick this is
 *  ~240 ms of a real human still talking — enough to reject a single noise spike above the floor. */
export const FALSE_INTERRUPT_CONFIRM_TICKS = 2;

export const newSuspectState = (): SuspectState => ({ active: false, startedAt: 0, voiceTicks: 0 });

export function beginSuspect(now: number): SuspectState {
  return { active: true, startedAt: now, voiceTicks: 0 };
}

/**
 * Advance the suspect state machine one tick.
 *
 * @param st   current state (returned by a previous call, or beginSuspect/newSuspectState)
 * @param now  Date.now() at this tick
 * @param voice  does the mic still hear a human NOW? The caller computes this AFTER playback was
 *               paused, so the call's own echo is gone. Must be false when muted / no mic.
 * @returns the next state plus a one-shot verdict. On "confirm"/"revive" the returned state is idle;
 *          the caller performs the corresponding side effect exactly once.
 *
 * The rule is a three-way split on (elapsed, voice):
 *   - inside settle            -> wait (absorb the echo tail);
 *   - past settle + voice      -> confirm (a real human kept talking);
 *   - past settle + quiet long -> revive (it was echo/noise);
 *   - elapsed >= MAX           -> revive (never hang), regardless of signal.
 */
export function suspectStep(st: SuspectState, now: number, voice: boolean): { state: SuspectState; verdict: SuspectVerdict } {
  if (!st.active) return { state: st, verdict: "wait" };
  const elapsed = now - st.startedAt;
  if (elapsed < FALSE_INTERRUPT_SETTLE_MS) return { state: st, verdict: "wait" };
  // Require consecutive voice ticks, not a single cross-floor spike (F2). A real human talking over
  // the reply easily holds the floor for 2+ ticks; a one-off noise above the floor does not.
  const voiceTicks = voice ? st.voiceTicks + 1 : 0;
  if (voiceTicks >= FALSE_INTERRUPT_CONFIRM_TICKS) return { state: newSuspectState(), verdict: "confirm" };
  if (elapsed >= FALSE_INTERRUPT_MAX_MS) return { state: newSuspectState(), verdict: "revive" };
  if (!voice && elapsed >= FALSE_INTERRUPT_SETTLE_MS + FALSE_INTERRUPT_SILENCE_MS) {
    return { state: newSuspectState(), verdict: "revive" };
  }
  return { state: { ...st, voiceTicks }, verdict: "wait" };
}
