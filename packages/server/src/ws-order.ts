/**
 * Frames on one websocket are FIFO; their DISPATCH is not (issue #74).
 *
 * `ws.on("message")` runs the handler for every frame in its own async call, so a `prompt` that
 * arrives right after a `set-model` can reach the agent first. That is not a cosmetic ordering
 * problem: the prompt claims the turn, and the model switch then meets a busy session and is
 * dropped — the operator's session runs the agent default with no sign that the pick was lost.
 * The opposite order is no better: the prompt meets the agent's command lock and is "queued",
 * which the client can only read as a turn that ended immediately.
 *
 * The rule this gate enforces is narrow and testable: **a prompt waits for every control frame
 * that had already arrived on the same socket.** Nothing else is serialized — prompts still run
 * concurrently (the agent owns that queue, and a second prompt legitimately waits for the first
 * turn), and a control frame that arrives AFTER a prompt never waits for it.
 */

/** What a controller holds on to for the life of one connection. */
export interface FrameGate {
  /** Run a control frame's work and register it as "in flight" until it settles. */
  control<T>(work: () => Promise<T>): Promise<T>;
  /** Run `run` once every control frame that had arrived before this call has settled. */
  afterControl(run: () => void): void;
}

export function createFrameGate(): FrameGate {
  const inflight = new Set<Promise<unknown>>();
  return {
    control<T>(work: () => Promise<T>): Promise<T> {
      const p = work();
      inflight.add(p);
      const done = (): void => { inflight.delete(p); };
      // `finally` on a rejected promise would re-throw into an unhandled rejection: settle both.
      void p.then(done, done);
      return p;
    },
    afterControl(run: () => void): void {
      if (!inflight.size) { run(); return; }
      // `allSettled`, never `all`: a control frame that FAILED (an unknown model, a dead session)
      // must not swallow the operator's message. The prompt still goes out — the agent is the
      // authority on whether it can serve it, and losing the sentence is the worse failure.
      void Promise.allSettled([...inflight]).then(run);
    },
  };
}
