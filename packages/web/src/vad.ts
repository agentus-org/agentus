// Is somebody talking, or is this just room tone?
//
// WHY THIS EXISTS. The call used to answer that question with one absolute number: `mic > VOICE_RMS`
// (0.010). An absolute bar is wrong in both directions and the operator met both: a phone lying on a
// table with its own loudspeaker leaking back sits ABOVE the bar with nobody speaking (the call
// interrupted itself mid-answer), and a quiet room with a soft voice sits BELOW it (「我说完了它不
// 发」/ 「语音打断从来没起过作用」). The number nobody can pick by hand is the right one: it is
// whatever the room happens to be today.
//
// So the floor is MEASURED, not configured. It follows the room with a fast fall and a moderate rise,
// and it is taught only by frames that do not look like a voice:
//   · a frame QUIET relative to the floor — obviously the room;
//   · a frame that is STEADY (level barely moved since the last one) — a leak, a fan, a hum. Speech
//     swings frame to frame; a loudspeaker leaking back at a fixed gain does not. This is what lets a
//     steady 0.02 leak become silence within a second instead of taking half a minute.
// While a sentence is in progress and the level is swinging, nothing is learned — otherwise a long
// answer would teach the gate that speech is the new silence (the same trap as the echo baseline).
//
// Speech is then a step over that floor, held for `hangMs` so the gaps inside a sentence
// (「我想… 那个… 就是」) do not read as the end of it.
//
// Deliberately NOT a neural VAD: this runs on every 120 ms tick of a live call on a phone, and the
// package ships as one small npm install (no native dependency, no multi-megabyte model to fetch).
// A Silero ONNX detector is the better answer where the bytes are free — the shape below takes it
// without a rewrite, since all it needs is a “probability of voice” and the same hangover.

/** One frame's worth of state. Owned by the caller (a ref), never by this module. */
export interface VadState {
  /** Slow average of the room while nobody is talking. */
  floor: number;
  /** When the last frame above the gate was seen. -Infinity = never (a fresh call is silent). */
  lastVoiceAt: number;
  /** Last frame's level, for the steadiness test. */
  prev: number;
  /** True while the hangover says a sentence is still going. */
  speech: boolean;
}

export interface VadOpts {
  /** Speech is a step over the floor by this factor. 2.6 ≈ 8 dB. */
  ratio?: number;
  /** …and never below this, because the floor of a digitally silent room can be 0. */
  minRms?: number;
  /** How long a gap may last before the sentence counts as finished. */
  hangMs?: number;
  /** How fast the floor moves UP toward a louder room, per frame that teaches it. */
  rise?: number;
  /** …and DOWN toward a quieter one. Faster: a closed window must not hold the gate open. */
  fall?: number;
}

const D = {
  ratio: 2.6,
  minRms: 0.004,
  hangMs: 700,
  rise: 0.3,
  fall: 0.35,
};

/** A fresh state. `floor` starts at 0 so the first quiet frame teaches it. */
export function newVad(floor = 0): VadState {
  return { floor, lastVoiceAt: -Infinity, prev: Number.NaN, speech: false };
}

/**
 * Advance one frame. Returns 「a voice is present」 INCLUDING the hangover — which is what a caller
 * wants for 「is the operator still mid-sentence」.
 */
export function vadStep(st: VadState, rms: number, now: number, o: VadOpts = {}): boolean {
  const hangMs = o.hangMs ?? D.hangMs;
  const prev = st.prev;
  // A suspended AudioContext reports NaN. That is 「nothing measured」, not 「silence」: leave the state
  // alone and let the hangover expire on its own.
  if (!Number.isFinite(rms)) {
    st.speech = now - st.lastVoiceAt <= hangMs;
    return st.speech;
  }
  const x = Math.max(0, rms);
  st.prev = x;
  const ratio = o.ratio ?? D.ratio;
  const gate = Math.max(o.minRms ?? D.minRms, st.floor * ratio);
  const over = x > gate;
  // Steady = the level did not move since the last frame (a leak, a fan, a hum) — see the header.
  const steady = Number.isFinite(prev) && Math.abs(x - prev) <= Math.max(0.0015, x * 0.08);
  if (!over || steady) {
    const k = x < st.floor ? (o.fall ?? D.fall) : (o.rise ?? D.rise);
    st.floor = st.floor === 0 ? x : st.floor + (x - st.floor) * k;
  }
  if (over) st.lastVoiceAt = now;
  st.speech = now - st.lastVoiceAt <= hangMs;
  return st.speech;
}

/** The level below which this room counts as silent — for the UI's own honesty (and its tests). */
export function vadFloorRms(st: VadState, o: VadOpts = {}): number {
  return Math.max(o.minRms ?? D.minRms, st.floor * (o.ratio ?? D.ratio));
}
