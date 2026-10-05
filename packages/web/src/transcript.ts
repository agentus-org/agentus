// Folding the agent's stream into blocks — the one rule the transcript is built on, kept out of the
// store class so it can be exercised with real rows and no browser.
//
// Why it needs its own module: the agent emits `agent_message_chunk` / `agent_thought_chunk` per
// token, and it ALSO re-sends text it has already sent (a full snapshot of the message so far, or an
// earlier message replayed as one block). Three things therefore have to be true at once:
//
//   1. every chunk of ONE message (`messageId`) lands in ONE block, no matter which page it arrived
//      on, whether it arrived live or from a history read — otherwise "show earlier messages" cuts a
//      markdown table in half (measured: the same reply came back as 5 messages, the table split at
//      the page boundary);
//   2. a re-send must never become a second block;
//   3. a live frame must never be DROPPED. The store folds a message into ONE row that KEEPS ITS SEQ,
//      so "have I seen this seq?" is not a duplicate test any more — a client that used it lost every
//      chunk after the first two characters of a reply (measured on a phone: the bubble read "不是",
//      the rest of the reply went nowhere, and the frame after it landed in an empty bubble). A
//      growing frame therefore carries `n`, its block's TOTAL length: the length is the frame's
//      version, and a duplicate or late frame is one whose growth we already hold.
//
// The store does the same folding on the way in (`Store.appendTextChunk`), so a read and a live frame
// agree. AionUi's renderer solves this with the same shape (a `msg_id` → index map plus a `replace`
// flag for snapshots, `mergeLoadedPageWithCurrent` folding by that key across a page boundary);
// hermes-studio solves the re-send with `appendedTextDelta`. This is the two of them, kept small.

/** The identity of one logical message, or null when the agent sent none (its history recaps). */
export function blockKeyOf(kind: string, payload: unknown): string | null {
  const mid = (payload as { messageId?: unknown } | null)?.messageId;
  return typeof mid === "string" && mid ? `${kind}:${mid}` : null;
}

export interface TextBlock {
  kind: string;
  text: string;
}

/** What the folder needs from a block; the caller's richer union only has to match it here. */
type FoldList = TextBlock;

export interface TextRow {
  /** `blockKeyOf(...)` — null when the agent sent no id */
  key: string | null;
  kind: "agent" | "thought";
  /** the row's text: the whole block on a read, the new part when `delta` is set */
  text: string;
  /** present on a live frame that GREW an existing block (see the wire type) */
  delta?: string;
  /** the block's TOTAL length after this frame — the version of a growing frame (rule 3 above) */
  n?: number;
}

/** What one frame does to the block it targets. */
export type FramePlan =
  | { action: "create"; text: string }
  | { action: "append"; add: string }
  | { action: "replace"; text: string }
  | { action: "skip" };

/** Whitespace-insensitive: a re-send of a block differs from what we hold by formatting only. */
function sameText(a: string, b: string): boolean {
  return a === b || a.replace(/\s+/g, "") === b.replace(/\s+/g, "");
}

/**
 * Decide what a frame does, given the text we already hold for its block (`undefined` = no block yet).
 *
 * A read (`delta` absent) carries the stored row — the accumulated truth — so it REPLACES what the
 * block holds. A live frame (`delta` present) carries only the part that is new, and cannot be
 * deduplicated by seq: see rule 3 in the header.
 */
export function planTextFrame(held: string | undefined, f: TextRow): FramePlan {
  const part = f.delta;
  if (part === undefined) {
    if (held === undefined) return { action: "create", text: f.text };
    // An id-less row has no identity to compare against, so it keeps the transcript's old contiguous
    // rule (a stored row without a `messageId` is its own message, rendered next to its sibling). A
    // keyed block is different: the stored row IS its accumulated truth, so a read replaces it.
    if (!f.key) return { action: "append", add: f.text };
    return sameText(held, f.text) ? { action: "skip" } : { action: "replace", text: f.text };
  }
  if (held === undefined) return { action: "create", text: part };
  if (f.n !== undefined) {
    const missing = f.n - held.length; // how much of `part` we do not hold yet
    if (missing <= 0) return { action: "skip" }; // we already applied this growth
    if (missing >= part.length) return { action: "append", add: part };
    return { action: "append", add: part.slice(part.length - missing) }; // we hold its head already
  }
  // No version on the wire (an older server): fall back to the overlap rule, which drops the overlap
  // of a re-sent snapshot but treats a short coincidence as new text.
  const add = appendedTextDelta(held, part);
  return add ? { action: "append", add } : { action: "skip" };
}

/**
 * Fold one row into the transcript. Returns true when a new block was pushed.
 *
 * With a key, the block holding that key is the target (a live `delta` appends to it, a read REPLACES
 * its text). Without a key the old contiguous rule applies, because an anonymous recap is only
 * meaningful next to its sibling.
 */
export function foldTextRow<T extends { kind: string }>(
  list: T[],
  index: Map<string, number>,
  row: TextRow,
  create: (key: string, row: TextRow) => T,
): { pushed: boolean; at: number } {
  // only the text-bearing members ever reach this function
  const blocks = list as unknown as FoldList[];
  const asBlock = (b: T): FoldList => b as unknown as FoldList;
  const push = (text: string): { pushed: boolean; at: number } => {
    const key = row.key ?? `anon@${blocks.length}`;
    blocks.push(asBlock(create(key, { ...row, text })));
    if (row.key) index.set(row.key, blocks.length - 1);
    return { pushed: true, at: blocks.length - 1 };
  };
  const keyed = row.key ? index.get(row.key) : undefined;
  const keyedBlock = keyed === undefined ? undefined : blocks[keyed];
  // a key is only followed into a block of the same kind (a thought and a message can share an id)
  const at =
    keyedBlock && keyedBlock.kind === row.kind
      ? keyed
      : !row.key && blocks.length > 0 && blocks[blocks.length - 1].kind === row.kind
        ? blocks.length - 1 // no id: merge with the block above it, never across kinds
        : undefined;
  const plan = planTextFrame(at === undefined ? undefined : blocks[at].text, row);
  if (plan.action === "create") return push(plan.text);
  if (at === undefined) {
    if (plan.action === "append") return push(plan.add);
    if (plan.action === "replace") return push(plan.text);
    return push(row.delta ?? row.text); // unreachable: skip/create both handled above
  }
  if (plan.action === "skip") return { pushed: false, at };
  blocks[at].text = plan.action === "append" ? blocks[at].text + plan.add : plan.text;
  return { pushed: false, at };
}

/** Rebuild the key → index map after the list has been rebuilt or prepended to. */
export function reindexBlocks<T extends { key: string; kind: string }>(list: T[]): Map<string, number> {
  const index = new Map<string, number>();
  list.forEach((b, i) => {
    // only the LAST block of a key is the target of later chunks
    if (b.key.startsWith("anon@")) index.delete(b.key);
    else index.set(b.key, i);
  });
  return index;
}

/** Text that is genuinely new in `next`, given `existing` — hermes-studio's `appendedTextDelta`. */
export function appendedTextDelta(existing: string, next: string): string {
  if (!existing || !next) return next;
  if (next.startsWith(existing)) return next.slice(existing.length);
  const max = Math.min(existing.length, next.length);
  for (let length = max; length >= 16; length--) {
    if (existing.endsWith(next.slice(0, length))) return next.slice(length);
  }
  return next;
}
