/**
 * Process feedback for a phone call: what the agent is DOING, out loud.
 *
 * A call has a blind spot the screen does not: between "I heard you" and "here is the answer" the
 * agent thinks, runs tools and waits for approvals, and the line is silent. The operator cannot tell
 * a long tool run from a dead connection (issue #58). This module is the deciding half of the fix —
 * *which* milestone is worth a sentence, and when — kept free of React, the speaker and the DOM so
 * the rules can be tested by hand.
 *
 * The rules come from how production voice agents do it (LiveKit's `with_filler` shape):
 *
 *  · **truthful** — a cue is only ever built from a REAL event (a tool title, a plan step count).
 *    There is no "please wait" filler here: an invented progress line is a lie the operator will
 *    eventually catch, and then no cue is believable.
 *  · **leading** — once thinking has gone on for `leadingDelayMs`, one short ack ("我查一下").
 *  · **coalesce** — tool calls are NOT narrated one by one. Ten calls must not be ten sentences; the
 *    newest state is held and spoken only once the line has been quiet for `dwellMs` (the moment the
 *    operator would otherwise start wondering whether the call died).
 *  · **capped** — at most `maxCues` cues per turn, and at least `minGapMs` between any two.
 *  · **discarded, not queued** — the moment the answer starts being read out, or the turn ends,
 *    every unsaid cue is dropped. A progress line that arrives after the work is done is noise that
 *    makes the call feel broken (the classic "早就执行完了你还在播").
 */

export type CueKind = "leading" | "tool" | "plan";

export interface Cue {
  text: string;
  kind: CueKind;
}

export const BRIEF_DEFAULTS = {
  /** How long thinking has to last before one ack is worth saying. */
  leadingDelayMs: 2_000,
  /** The first tool of a turn is spoken at once — but not sooner than this after the turn began. */
  firstToolGapMs: 5_000,
  /** Hard floor between two cues of the same turn (wall clock). */
  minGapMs: 10_000,
  /** Quiet this long → the held (coalesced) state is worth one sentence. */
  dwellMs: 9_000,
  /** A turn gets this many cues, no more. */
  maxCues: 3,
} as const;

/** Tools whose titles are noise to say out loud; the cue says 「在跑工具」 instead. */
const UNSPEAKABLE = /[\u0000-\u001f]|^\s*$/;

function toolCue(title: string): string {
  const name = title.replace(/\s*·.*$/, "").trim();
  if (!name || UNSPEAKABLE.test(name)) return "在跑一个工具";
  // Shell commands and paths are long, and a path read aloud is noise: take the first token that is
  // actually a word ("terminal", "read_file"), not the empty one a leading "/" splits out.
  const token = name.split(/[\s/\\]+/).find((t) => t.length > 0) ?? "";
  if (!token) return "在跑一个工具";
  return `在跑 ${token.slice(0, 12)}`;
}

export class BriefPlanner {
  #opts: typeof BRIEF_DEFAULTS & Record<string, number>;
  #turnStart = 0;
  #active = false;
  #lastSpokeAt = 0;
  #cues = 0;
  #pending: Cue | null = null;
  #pendingAt = 0;
  #answerStarted = false;
  #leadingDone = false;

  constructor(opts: Partial<typeof BRIEF_DEFAULTS> = {}) {
    this.#opts = { ...BRIEF_DEFAULTS, ...opts } as typeof BRIEF_DEFAULTS & Record<string, number>;
  }

  /** A new turn: everything from the previous one is forgotten. */
  turnStarted(now: number): void {
    this.#active = true;
    this.#turnStart = now;
    this.#lastSpokeAt = 0;
    this.#cues = 0;
    this.#pending = null;
    this.#pendingAt = 0;
    this.#answerStarted = false;
    this.#leadingDone = false;
  }

  get turnActive(): boolean {
    return this.#active && !this.#answerStarted;
  }

  get cuesSpoken(): number {
    return this.#cues;
  }

  /** Thinking has been going on this long without a word from the answer. */
  thinking(now: number): Cue | null {
    if (!this.turnActive || this.#leadingDone) return null;
    if (now - this.#turnStart < this.#opts.leadingDelayMs) return null;
    this.#leadingDone = true;
    return this.#emit({ text: "我查一下", kind: "leading" }, now);
  }

  /** A tool call STARTED (not updated: an update is not a new milestone). */
  tool(now: number, title: string): Cue | null {
    if (!this.turnActive) return null;
    const cue: Cue = { text: toolCue(title), kind: "tool" };
    // The first tool is worth saying immediately — the operator just heard 「我查一下」 and this
    // says WHAT. Everything after it waits for a quiet moment (see `tick`).
    if (this.#cues === 0 && (this.#lastSpokeAt === 0 ? now - this.#turnStart >= this.#opts.firstToolGapMs : true)) {
      return this.#emit(cue, now);
    }
    this.#hold(cue, now);
    return null;
  }

  /** The agent's plan moved. Step counts are free, so this outranks any tool title held. */
  plan(now: number, done: number, total: number): Cue | null {
    if (!this.turnActive || total <= 0) return null;
    const cue: Cue = { text: `第 ${Math.min(done + 1, total)} 步，共 ${total} 步`, kind: "plan" };
    if (this.#cues === 0 && now - this.#turnStart >= this.#opts.firstToolGapMs) return this.#emit(cue, now);
    this.#hold(cue, now);
    return null;
  }

  /**
   * Called on a heartbeat while the turn runs: the only place a COALESCED cue can come out. It needs
   * both a quiet line (dwell) and a legal gap, so a busy turn stays quiet instead of narrating.
   */
  tick(now: number): Cue | null {
    if (!this.turnActive || !this.#pending) return null;
    if (now - this.#pendingAt < this.#opts.dwellMs) return null;
    const out = this.#emit(this.#pending, now);
    // Only a cue that actually came out leaves the slot: one held back by the gap floor keeps its
    // place (and its original timestamp), so it is spoken on the first legal heartbeat after it.
    if (out) this.#pending = null;
    return out;
  }

  /** The answer has begun to stream: from here on, silence. */
  answerStarted(): void {
    this.#answerStarted = true;
    this.#pending = null;
  }

  /** Turn over (however it ended): drop anything still held. */
  turnEnded(): void {
    this.#active = false;
    this.#turnStart = 0;
    this.#pending = null;
    this.#answerStarted = false;
  }

  #hold(cue: Cue, now: number): void {
    // A plan step is a better sentence than a tool name; within one kind the newest wins.
    if (this.#pending?.kind === "plan" && cue.kind === "tool") return;
    this.#pending = cue;
    this.#pendingAt = now;
  }

  #emit(cue: Cue, now: number): Cue | null {
    if (this.#cues >= this.#opts.maxCues) return null;
    if (this.#lastSpokeAt && now - this.#lastSpokeAt < this.#opts.minGapMs) {
      // Too soon. Hold it rather than drop it (dropping a milestone leaves the line silent for a
      // reason the operator cannot see) — and keep the time it first became worth saying, so a cue
      // that waited out the floor is not made to wait out another dwell on top of it.
      if (!this.#pending) this.#hold(cue, now);
      else this.#pendingAt = Math.min(this.#pendingAt, now);
      return null;
    }
    this.#cues += 1;
    this.#lastSpokeAt = now;
    return cue;
  }
}
