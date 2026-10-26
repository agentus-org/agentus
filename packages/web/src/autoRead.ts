// What auto-read should say, and when (issues #66 / #67).
//
// WHY THIS FILE EXISTS. The choice of segments used to be a private function in App.tsx that picked
// exactly one message: the LAST agent message of the turn, and only once the turn was over
// (`!v.busy`). A turn split by tool calls — "我先看下配置" → tool → result — therefore lost every
// paragraph except the tail, and nothing was said until the very end (issue #67).
//
// Both halves of that decision are arithmetic over a session view, so they live here and
// `scripts/qa/auto-read-sweep.mts` can stand up hand-built turns and pin the selection without a
// server, an agent slot or a browser.
import { stripEmoTags } from "./tusMood";

/** The three speaker positions. It used to be one global setting; since #68 it is resolved PER
 *  SESSION (a session's own value wins, otherwise the global default). */
export type SpeakMode = "off" | "reply" | "brief";

/** One thing to read: the message key (the dedupe handle) and the text as spoken. */
export interface ReadTarget { key: string; text: string; }

/** The slice of a session view this decision needs. Structural on purpose: the sweep feeds plain
 *  objects, the app feeds `SessionView`. */
export interface AutoReadMsg { key: string; kind: string; text?: string | null }

export interface AutoReadView {
  msgs: ReadonlyArray<AutoReadMsg>;
  busy: boolean;
  loaded: boolean;
  lastAt: number;
}

/** How recently the session must have carried activity for auto-read to fire at all: a slot opened
 *  from history must never start talking to the room. */
export const AUTO_READ_FRESH_MS = 30_000;

/**
 * The segments of the CURRENT turn, oldest first, that are settled enough to be read.
 * `null` = nothing to read right now (no session, transcript not loaded, or not fresh).
 *
 * "Settled" means the message has stopped growing:
 *  - the newest message while the turn is busy may still be receiving text → skipped for now;
 *  - anything before it (a paragraph a tool call interrupted) is final → read immediately, mid-turn,
 *    instead of waiting for the whole turn to end.
 *
 * The 30 s freshness gate stays last so a re-render of an old session cannot slip through.
 */
export function settledReplies(v: AutoReadView | undefined, now = Date.now()): ReadTarget[] | null {
  if (!v || !v.loaded) return null;
  if (now - v.lastAt > AUTO_READ_FRESH_MS) return null;
  // The turn starts after the operator's own last message; anything above it is an earlier turn
  // (already read) or history (never read).
  let start = 0;
  for (let i = v.msgs.length - 1; i >= 0; i -= 1) {
    if (v.msgs[i].kind === "user") {
      start = i + 1;
      break;
    }
  }
  const out: ReadTarget[] = [];
  for (let i = start; i < v.msgs.length; i += 1) {
    const m = v.msgs[i];
    const text = String(m.text ?? "");
    if (m.kind !== "agent" || !text.trim()) continue;
    if (v.busy && i === v.msgs.length - 1) continue;   // still streaming: not landed yet
    out.push({ key: m.key, text: stripEmoTags(text) });
  }
  return out;
}
