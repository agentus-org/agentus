// Splitting an answer into utterances for the speaker.
//
// Pure text logic, deliberately in its own module: the rule below is the difference between a
// smooth reading and a stall the operator hears, so it is unit-tested (scripts/qa/sentence-units.mts)
// rather than only observable through a browser.

/** A sentence shorter than this is read together with the NEXT one.
 *
 *  Why: the reader asks for clip n+1 while clip n plays, so clip n has to last at least as long as
 *  clip n+1 takes to arrive (fetch + provider ≈ 0.8 s warm, 1.5–2 s over a phone network). Real
 *  replies open with 2–8 character sentences ("能。" / "听得清楚。" / "收到三次你好。") whose audio
 *  lasts 0.4–1.4 s — shorter than that, so exactly that boundary goes silent and it is heard as
 *  "the second sentence stalls". Every later sentence is long enough to cover its own successor,
 *  which is why the stall happens once and not at every boundary.
 *
 *  Gluing costs ~0.15 s before the first sound: measured against the live provider, 5 characters
 *  take 0.83 s to synthesise and 29 characters 0.99 s — synthesis is dominated by the request.
 */
export const SHORT_SENTENCE = 12;
/** …and gluing must never build a clip the server would cut again anyway (its own 80-char split). */
export const GLUE_MAX = 80;

/** Split `text` into the utterances that are COMPLETE plus the still-growing tail.
 *
 *  The merge is stable: a piece that has been glued stays glued as more text arrives, so a caller
 *  may track how many utterances it has already queued (a count over this list only ever grows). */
export function splitSentences(text: string): { done: string[]; tail: string } {
  const pieces: string[] = [];
  // sentence enders in both scripts, keeping the punctuation with the sentence
  const re = /[^。！？!?\n…]*[。！？!?\n…]+/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const s = m[0].trim();
    if (s) pieces.push(s);
    last = (m.index ?? 0) + m[0].length;
  }
  const done: string[] = [];
  for (const piece of pieces) {
    const head = done[done.length - 1];
    if (head !== undefined && head.length < SHORT_SENTENCE && head.length + piece.length <= GLUE_MAX) {
      done[done.length - 1] = `${head} ${piece}`;
    } else done.push(piece);
  }
  // A trailing short utterance is not final yet: the next sentence may still glue to it, which would
  // rewrite its text. Left out of `done` it is never handed to the reader, so it cannot change behind
  // the reader's back — it reaches the operator either merged with what follows, or as the tail
  // (which the caller flushes when the turn ends). This is what makes `done` a stable list, the
  // property the call's queue counter depends on.
  const pending: string[] = [];
  const trailing = done[done.length - 1];
  if (trailing !== undefined && trailing.length < SHORT_SENTENCE) pending.push(done.pop() as string);
  return { done, tail: [...pending, text.slice(last).trim()].filter(Boolean).join(" ") };
}
