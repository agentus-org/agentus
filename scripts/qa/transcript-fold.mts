// The transcript's folding rules, on their own (no browser, no server).
//
// These are the rules that decide whether one reply is ONE bubble or five: a streamed message is
// identified by its `messageId`, a history read replaces that block's text instead of adding a second
// one, and a frame with no id falls back to the old "merge with the block above it" behaviour.
//
// Run: npm run transcript-fold
import { blockKeyOf, foldTextRow, reindexBlocks, appendedTextDelta } from "../../packages/web/src/transcript.ts";

interface Block { key: string; kind: "agent" | "thought"; text: string; open: boolean }

let ok = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    ok += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const make = (key: string, row: { kind: "agent" | "thought"; text: string }): Block =>
  ({ key, kind: row.kind, text: row.text, open: true });

function fresh(): { list: Block[]; index: Map<string, number> } {
  return { list: [], index: new Map() };
}

// ---- 1. one message, many chunks, one bubble ------------------------------------------------
{
  const { list, index } = fresh();
  const chunks = ["通", "知", "功能", "的", "实现", "在 ", "`notify/", "center.ts`"];
  for (const c of chunks) {
    foldTextRow(list, index, { key: "agent:m1", kind: "agent", text: c, delta: c }, make);
  }
  check("live chunks of one messageId ⇒ ONE bubble", list.length === 1, `got ${list.length}`);
  check("…and its text is the concatenation", list[0]?.text === chunks.join(""), list[0]?.text);
}

// ---- 2. a tool card in between does not spawn a second bubble -------------------------------
{
  const { list, index } = fresh();
  foldTextRow(list, index, { key: "agent:m2", kind: "agent", text: "前半", delta: "前半" }, make);
  // a tool row is pushed by #ingest directly, not by the folder
  list.push({ key: "tc-1", kind: "agent", text: "", open: false });
  foldTextRow(list, index, { key: "agent:m2", kind: "agent", text: "后半", delta: "后半" }, make);
  check("the same messageId still folds into its own bubble (a reply is never split)",
    list.length === 2 && list[0]?.text === "前半后半", JSON.stringify(list.map((b) => b.text)));
}

// ---- 3. a history read REPLACES, it never appends -------------------------------------------
{
  const { list, index } = fresh();
  foldTextRow(list, index, { key: "agent:m3", kind: "agent", text: "abc", delta: "abc" }, make);
  foldTextRow(list, index, { key: "agent:m3", kind: "agent", text: "abc" }, make); // the stored row
  check("a read of the same message replaces the text", list.length === 1 && list[0]?.text === "abc",
    `${list.length} blocks, ${list[0]?.text}`);
  foldTextRow(list, index, { key: "agent:m3", kind: "agent", text: "abcdef" }, make);
  check("…and a longer stored row wins over the live prefix", list[0]?.text === "abcdef", list[0]?.text);
}

// ---- 4. the page boundary: the table is whole because the row is whole ----------------------
{
  // what the page used to look like: a table cut at a byte offset inside a 3-character row
  const table = "| 状态 | 事件 |\n|---|---|\n| 进行中 | `turn-start` |\n| 等审批 | `permission` |\n| 完成 | `turn-end` |\n";
  const { list, index } = fresh();
  // a fresh view opens on the NEWEST page: it holds only the tail of the reply
  for (const c of [table.slice(0, 40)]) foldTextRow(list, index, { key: "agent:m4", kind: "agent", text: c, delta: c }, make);
  check("the tail page alone shows a fragment", list[0]?.text.length === 40, String(list[0]?.text.length));
  // "load earlier" fetches the row that holds the WHOLE message (the store accumulates it)
  foldTextRow(list, index, { key: "agent:m4", kind: "agent", text: table }, make);
  check("the earlier page replaces it with the whole message", list[0]?.text === table);
  const bars = (list[0]?.text.match(/\|/g) ?? []).length;
  const lines = (list[0]?.text ?? "").split("\n").filter((l) => l.trim().startsWith("|")).length;
  check("a markdown table survives the page boundary — header AND all three rows",
    bars === 15 && lines === 5 && list[0]?.text.includes("turn-end"),
    `bars=${bars} lines=${lines}`);
}

// ---- 5. no id: the old contiguous rule still applies ---------------------------------------
{
  const { list, index } = fresh();
  foldTextRow(list, index, { key: null, kind: "agent", text: "匿名甲" }, make);
  foldTextRow(list, index, { key: null, kind: "agent", text: "匿名乙" }, make);
  check("anonymous frames merge with the block above", list.length === 1 && list[0]?.text === "匿名甲匿名乙",
    `${list.length} / ${list[0]?.text}`);
  foldTextRow(list, index, { key: null, kind: "thought", text: "换个种类" }, make);
  check("…but not across kinds", list.length === 2, String(list.length));
}

// ---- 6. prepending a page keeps later chunks landing in the right bubble -------------------
{
  const { list, index } = fresh();
  foldTextRow(list, index, { key: "agent:m6", kind: "agent", text: "新", delta: "新" }, make);
  const page: Block[] = [];
  const pageIndex = new Map<string, number>();
  foldTextRow(page, pageIndex, { key: "agent:m5", kind: "agent", text: "旧" }, make);
  const merged = [...page, ...list];
  const reindexed = reindexBlocks(merged);
  foldTextRow(merged, reindexed, { key: "agent:m6", kind: "agent", text: "的", delta: "的" }, make);
  check("after a prepend, the live message still grows in its own bubble",
    merged.length === 2 && merged[1]?.text === "新的", JSON.stringify(merged.map((b) => b.text)));
}

// ---- 7. the helpers themselves -------------------------------------------------------------
{
  check("blockKeyOf reads the ACP messageId", blockKeyOf("agent", { messageId: "x" }) === "agent:x");
  check("blockKeyOf is null without one", blockKeyOf("agent", { content: { text: "hi" } }) === null);
  check("appendedTextDelta: a snapshot yields only the new tail",
    appendedTextDelta("abc", "abcdef") === "def");
  check("appendedTextDelta: an overlapping re-send drops the overlap (≥16 chars is a real overlap)",
    appendedTextDelta("AAAAAAAAAAAAAAAA1122334455667788", "1122334455667788BBB") === "BBB",
    appendedTextDelta("AAAAAAAAAAAAAAAA1122334455667788", "1122334455667788BBB"));
  check("appendedTextDelta: a short coincidence is treated as new text",
    appendedTextDelta("hello world", "world again") === "world again");
  check("appendedTextDelta: a real delta passes through", appendedTextDelta("abc", "d") === "d");
}

// ---- 8. the frame that must never be dropped (this one shipped a bug) ----------------------
{
  // Exactly what the phone showed: the store keeps ONE row per message, so a growing frame re-uses
  // that row's seq. The client used to deduplicate frames by seq and therefore applied only the FIRST
  // chunk of every reply — the bubble read "不是" and the rest went nowhere. The first chunk happened
  // to be whitespace, which is why the bubble after it looked empty.
  const { list, index } = fresh();
  const chunks = ["\n\n", "不是", " webhook，", "也不是「自己发明协议」那么重", "——是自建的一套 WS 契约。"];
  const reply = chunks.join("");
  let n = 0;
  for (const c of chunks) {
    n += c.length;
    foldTextRow(list, index, { key: "agent:p1", kind: "agent", text: c, delta: c, n }, make);
  }
  check("every chunk of a growing row is applied (the seq repeats, only `n` grows)",
    list.length === 1 && list[0]?.text === reply, `${list.length} blocks / ${JSON.stringify(list[0]?.text)}`);

  // the same frame twice (a replay racing the live stream) must not double the text
  foldTextRow(list, index, { key: "agent:p1", kind: "agent", text: chunks[4], delta: chunks[4], n }, make);
  check("a replayed frame (the same `n`) is dropped", list[0]?.text === reply, JSON.stringify(list[0]?.text));

  // a frame whose head we already hold: only the missing tail is appended
  const tail = "后半句。";
  const grown = reply + tail;
  foldTextRow(list, index,
    { key: "agent:p1", kind: "agent", text: chunks[4] + tail, delta: chunks[4] + tail, n: grown.length }, make);
  check("a frame whose head we already hold appends only its tail", list[0]?.text === grown,
    JSON.stringify(list[0]?.text));

  // and without a version (an older server) the overlap rule still protects the text
  foldTextRow(list, index, { key: "agent:p2", kind: "agent", text: "AAAA", delta: "AAAA" }, make);
  const again: { key: string; kind: "agent"; text: string; delta: string } =
    { key: "agent:p2", kind: "agent", text: "AAAAAAAAAAAAAAAA", delta: "AAAAAAAAAAAAAAAA" };
  foldTextRow(list, index, again, make);
  foldTextRow(list, index, again, make);
  check("with no `n`, a re-sent chunk is not appended twice",
    list[1]?.text === "AAAAAAAAAAAAAAAA", JSON.stringify(list[1]?.text));
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${ok} ok, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
