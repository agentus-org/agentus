// The speech queue: one segment is spoken at a time, and a newer segment replaces whatever was
// still WAITING — but never the one already being spoken.
//
// WHY. Auto-read used to hand every settled paragraph of a turn to the speaker in a chained
// promise, so a turn that arrived in three quick pieces was read 1, 2, 3 even though 2 was already
// out of date by the time 1 finished. The operator's rule is the opposite: never cut the sentence
// that is playing, and when the turn keeps producing newer paragraphs, speak the newest one and
// forget the ones that were queued behind it (a paragraph that has not been STARTED yet is stale by
// definition — a newer one exists).
//
// The state is three fields, so it lives here instead of in the React layer: `scripts/qa/
// auto-read-sweep.mts` drives it with a fake speaker and pins the interruption rules without a
// browser, a server or an agent slot.
export interface SpeechSegment {
  /** the message key, kept so the caller's dedupe set and the diagnostics can name the segment */
  key: string;
  /** what is handed to the speaker */
  text: string;
}

export interface SpeakQueue {
  /** Queue this segment. Idle → it starts now. Speaking → it replaces the waiting one. */
  push(seg: SpeechSegment): void;
  /** Drop the waiting segment. Stopping the audio is the caller's job (`speaker.stop()`). */
  hush(): void;
  /** Is a segment being spoken right now? */
  readonly speaking: boolean;
  /** The segment that will be spoken next, if any (exposed for tests and diagnostics). */
  readonly waiting: SpeechSegment | null;
  /** Test helper: resolves once nothing is speaking and nothing is waiting. */
  settled(): Promise<void>;
}

export function createSpeakQueue(speak: (seg: SpeechSegment) => Promise<void>): SpeakQueue {
  let pending: SpeechSegment | null = null;
  let running = false;
  let waiters: Array<() => void> = [];

  function releaseWaiters(): void {
    const list = waiters;
    waiters = [];
    for (const fn of list) fn();
  }

  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (pending) {
        const seg = pending;
        pending = null;
        try {
          await speak(seg);
        } catch {
          // One broken sentence must not poison the segments behind it.
        }
      }
    } finally {
      running = false;
      releaseWaiters();
    }
  }

  return {
    push(seg: SpeechSegment): void {
      pending = seg;
      void pump();
    },
    hush(): void {
      pending = null;
      // A `pending` that was set while speaking is dropped here too: the operator took over, so
      // nothing that has not started is read at him. The segment already playing is stopped by the
      // caller (`speaker.stop()`), which resolves its `speak()` promise and lets the loop fall out.
      if (!running) releaseWaiters();
    },
    get speaking(): boolean {
      return running;
    },
    get waiting(): SpeechSegment | null {
      return pending;
    },
    settled(): Promise<void> {
      if (!running && !pending) return Promise.resolve();
      return new Promise<void>((resolve) => { waiters.push(resolve); });
    },
  };
}
