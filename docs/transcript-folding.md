# The transcript: one message, one row, one bubble

Why this file exists: the operator looked at the `hello` session and found **one reply rendered as five
messages with a markdown table cut in half**, and "show earlier messages" producing a few unrelated
fragments. Both were real, and both came from the same three assumptions being wrong at once. This is
what they were, what was done about them, and how it is verified.

## What was actually wrong

Measured on the operator's own session (`hello`, 8 prompts):

| Fact | Number |
|---|---|
| rows in `messages` for that one session | **3804** |
| rows carrying a `messageId` (real streamed chunks) | 3702, **average 3.8 characters per row** |
| rows with **no** `messageId` (whole messages the agent re-sent) | 57, average 341 characters |
| rows for the reply the operator was reading | **1259** |
| client page size when opening a session / on "load earlier" | 500 rows → ~1900 chars, then 200 rows each |

So three things were true:

1. **A row was a token, and paging was by row.** Opening the session fetched the newest 500 rows — a
   third of ONE reply; each "load earlier" added another 200 rows, i.e. another arbitrary byte slice.
   The client built bubbles from *adjacent same-kind rows*, so every page boundary became a message
   boundary. Measured: the table sat at rows 2875–3142 and the page boundary was row **3105** — the
   table was split exactly there, and nothing in either half was valid markdown any more.
2. **The client merged by adjacency, not by identity**, so the same logical message could not be
   recognised across a page boundary (or across a reconnect replay).
3. **The agent re-sends text it has already sent** (a recap of a message, sometimes with different
   whitespace, sometimes as one anonymous block). Persisted naively, the same answer landed in the
   transcript up to six times, each copy its own bubble.

## What the two sibling projects do

- **hermes-studio** (`packages/server/src/services/agent-runner/coding-agent-run-manager.ts`,
  `run-chat/response-stream.ts`): the streaming accumulator is `appendedTextDelta(existing, next)` — if
  the incoming frame starts with what we hold it is a snapshot (take the tail), otherwise strip the
  longest ≥16-character overlap, otherwise it is a genuine delta. That is the re-send problem solved on
  the server, which is where the row is written.
- **AionUi** (`packages/desktop/src/renderer/pages/conversation/Messages/hooks.ts`): each message has a
  stable key (`type:msg_id`, namespaced so a thought block and a text block sharing one id cannot
  collide), a `msgIdIndex` map so a frame finds **its own** entry instead of "the last one", a
  `replace` flag for snapshot content, and `mergeLoadedPageWithCurrent` / `prependHistoryMessages`
  dedupe a page against what is on screen **by that key** — so a message straddling a page boundary
  stays one entry. Their comment is explicit that a tool/thinking interruption is allowed to keep the
  message boundary.

## What Agentus does now

**1. The store writes one row per message** (`Store.appendTextChunk`, `store/store.ts`):

- chunks are folded into the row that already holds this `messageId` (`messages.block_key`, indexed);
- `appendedTextDelta` decides what is new, so a snapshot adds only its tail and an exact re-send adds
  nothing;
- an **id-less** frame is folded into a recent same-kind row when `reemissionTarget` says it is the
  same block: the normalized text must be equal, or contained with the shorter covering ≥60% of the
  longer (either direction, so "the same block, extended" appends). Below 24 characters it is never
  folded — "好的" twice is two messages, and a short string is contained in almost every long block;
- the surviving row keeps its original `seq` (paging anchors stay valid, nothing is renumbered).

**2. Paging is bounded by rows AND bytes** (`messagesBefore`): 120 rows, 256 KB, always at least one row.
A page can no longer be "a third of a message", and one 30 KB message cannot overflow a phone fetch.

**3. The client folds by key** (`packages/web/src/transcript.ts`, used by `state.ts`):

- a live frame carries `delta` (wire addition on `{ t: "message" }`) and appends to the block with that
  key — even if a tool card arrived in between, because one `messageId` is one message;
- a **read** (history, replay) carries no `delta` and *replaces* that block's text with the row's, so
  re-reading can never duplicate;
- `loadEarlier` folds the older page into a scratch list first and then merges **by key** into what is on
  screen (longer text wins), then re-indexes;
- a frame with no key falls back to the old adjacent-merge, which is correct for the agent's anonymous
  recaps.

## The rule that was missing: a growing row's version is its LENGTH, not its seq

The first cut of all this shipped a bug, and it is worth writing down because the same trap is one line
away in any streaming UI: **folding a message into one row means that row keeps its seq.** The client
had a guard from before — "skip a frame whose seq I have already seen" — which was correct when every
chunk was its own row, and silently wrong the moment chunks started folding. Every chunk after the
first was dropped. On the phone the reply read `不是` (literally the first chunk) and the next frame
landed in an empty bubble (its first chunk had been whitespace).

The fix has two halves, and both are needed:

- the server sends `n`, the block's **total length after this frame**, and on a growth ships only the new
  part (so a long reply is not re-sent whole on every token);
- the client guards a growing frame by that length, never by `seq`: `missing = n - held.length`, and if
  it is `≤ 0` the frame is a duplicate, otherwise it appends the missing tail (`part.slice(-missing)`,
  which also covers a frame whose head we already hold).

A read (no `delta`) needs none of this: the stored row IS the block, so it either replaces the text or
is a no-op when it matches.

`npm run live-stream` is the guard for it: it sends a real prompt through the mock backend, feeds every
frame the server emits into the **real cockpit store** (`apply`, the same entry point the WebSocket
calls), and asserts that the transcript built from the live frames equals the rows the store persisted —
same bubble count, exactly the same text, no empty bubble. Reverting the guard to `seq`-only makes that
check fail on the text comparison, which is how we know the test has teeth rather than just passing.

## Where the re-send problem is *not* solved

A short id-less message that the agent re-sends (measured: a 12-character "不客气，随时找我干活 👋" three
times) still appears more than once. Folding it needs information beyond the text — a two-character
"好的" repeated is a legitimate second message — so the guard stays at 24 characters and the leftover is
accepted rather than guessed away.

## Invariants to keep

1. **One `messageId` = one row = one bubble.** If a new event kind streams text, it must go through
   `appendTextChunk` with its id, or it re-opens the whole problem.
2. **The row is the truth on reads; `delta` exists only so a live turn does not re-send the whole text
   every frame.** Anything that reads the transcript (`hotwords.ts` context, the phone's notifications)
   reads rows, so it sees accumulated text for free — it used to see 40 chunks of 3.8 characters.
3. **Never fold on a guess.** Same id, or whitespace-insensitive equality, or ≥60% coverage. Everything
   else stays as it is, and the migration is logged (`[store] 历史分片已折叠：3804 行 → …`) with a
   one-time `VACUUM INTO` backup beside the DB (`agentus.sqlite.pre-fold.bak`).
4. **A page boundary must not be able to cut a message.** Page sizes are row- and byte-bounded, and the
   store guarantees a message is one row; if either changes, re-run the checks below.

## Verify it

```bash
npm run transcript-fold   # 17 checks: folding rules on their own (page boundary, snapshot, no-id)
npm run store-fold        # 27 checks: accumulation, re-sends, byte budget, the legacy migration
npm run smoke             # a real (mock) turn through the live server: 2 rows, not 17
```

And against real data — the one-off used when this landed, on the operator's own session:

```bash
# rows → the CLIENT's fold, over the operator API
curl -s -H "Authorization: Bearer $(cat "${AGENTUS_DATA:-$HOME/.agentus}/auth.token")" \
  'http://127.0.0.1:8787/api/sessions/<id>/messages?tail=1'
```

Result for `hello`: **3804 rows → 70** (10 agent messages, 15 thought blocks, 37 tool cards, 8 prompts),
`hasOlder=false`, both markdown tables reported complete (the 2623-character reply holds its 8-row table
in one block), and one duplicate left — the 12-character re-send described above.
