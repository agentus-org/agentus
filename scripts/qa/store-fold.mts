// The store's half of the transcript folding: one row per message, snapshots never duplicate, and the
// one-time repair of transcripts written when every 3-character chunk was its own row.
//
// Run: npm run store-fold
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../packages/server/src/store/store.ts";

let ok = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { ok += 1; console.log(`  ok   ${name}`); }
  else { failed += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentslot-store-fold-"));
const dbPath = path.join(dir, "agentslot.sqlite");
const chunk = (sessionId: string, text: string, messageId?: string, kind: "agent" | "thought" = "agent"):
  { sessionId: string; kind: "agent" | "thought"; payload: unknown; createdAt: number } =>
    ({ sessionId, kind, createdAt: Date.now(), payload: { sessionUpdate: `${kind}_message_chunk`, content: { type: "text", text }, ...(messageId ? { messageId } : {}) } });

// ---- 1. chunks accumulate into ONE row ------------------------------------------------------
{
  const store = new Store(dbPath);
  const sid = "s-chunks";
  const parts = ["通", "知", "功能", "的", "实现", "在 ", "`center.ts`", "（", "服务端", "）。"];
  let deltas = 0;
  let firstSeq = 0;
  parts.forEach((p, i) => {
    const r = store.appendTextChunk(chunk(sid, p, "m-1"));
    if (i === 0) firstSeq = r.message.seq;
    if (r.delta) deltas += 1;
    if (i > 0) {
      check(`chunk ${i}: stays in the same row`, r.message.seq === firstSeq && !r.isNew,
        `seq=${r.message.seq} isNew=${r.isNew}`);
    }
  });
  const rows = store.messagesTail(sid, 100).messages;
  check("a streamed reply is ONE row, not one row per chunk", rows.length === 1, `got ${rows.length}`);
  check("…holding the whole text", (rows[0]?.payload as { content: { text: string } }).content.text === parts.join(""),
    (rows[0]?.payload as { content: { text: string } }).content.text);
  check("every growth returned a delta to send", deltas === parts.length, String(deltas));

  // 2. a snapshot of the same message adds nothing
  const snap = store.appendTextChunk(chunk(sid, parts.join(""), "m-1"));
  check("a full re-send of the same message adds no row", store.messagesTail(sid, 100).messages.length === 1);
  check("…and reports an empty delta (nothing to emit)", snap.delta === "" && !snap.isNew, JSON.stringify(snap.delta));

  // 3. a snapshot that EXTENDS keeps only the new tail
  const ext = store.appendTextChunk(chunk(sid, `${parts.join("")}未完`, "m-1"));
  check("an extending snapshot yields only the new tail", ext.delta === "未完", JSON.stringify(ext.delta));
  check("…still one row", store.messagesTail(sid, 100).messages.length === 1);

  // 4. an anonymous re-emission (the agent's own recap) is folded, not stored twice
  const block = "工作区现状一览：\n\n**结构**（AGENTS.md 约定，运转正常）\n"
    + "- `tasks/`：2 个活跃需求 + `lessons.md`（纠错登记）\n"
    + "- `areas/hindsight-memory/`：README + scripts\n"
    + "- `worktrees/agentslot`：独立仓不入库\n\n"
    + "**任务索引（TASKS.md）**\n| slug | 状态 |\n|---|---|\n| agentslot | 进行中 |\n";
  const a = store.appendTextChunk(chunk("s-anon", block));
  check("an anonymous block is stored once", !!a.message.seq);
  const again = store.appendTextChunk(chunk("s-anon", `\n\n${block}`));
  check("its re-emission (whitespace aside) adds no row", again.delta === "" && !again.isNew);
  check("…so the session still has one row", store.messagesTail("s-anon", 100).messages.length === 1);

  // 5. two different anonymous blocks stay two rows
  store.appendTextChunk(chunk("s-anon", "明白，不动手。总体印象：这是一个组织得很清爽的工作区，按「有没有终点」分流，"
    + "有终点的进 tasks/，没终点的进 areas/，没想好的先丢 inbox/，完结的整目录搬进 archive/。"));
  check("a genuinely different anonymous block is its own row",
    store.messagesTail("s-anon", 100).messages.length === 2, String(store.messagesTail("s-anon", 100).messages.length));
  // and the guard: a SHORT repeat is two messages, not a re-emission
  store.appendTextChunk(chunk("s-anon", "好的"));
  store.appendTextChunk(chunk("s-anon", "好的"));
  const kk = store.messagesTail("s-anon", 100).messages
    .filter((r) => (r.payload as { content: { text: string } }).content.text === "好的");
  check("a short id-less repeat is NOT folded away (two messages stay two)",
    kk.length === 2, `${kk.length} 好的 rows`);

  // 6. paging: rows, and the byte budget on top
  const big = "x".repeat(300 * 1024);
  store.appendMessage({ sessionId: "s-page", kind: "user", payload: { text: "问题" }, createdAt: Date.now() });
  store.appendMessage({ sessionId: "s-page", kind: "agent", payload: { content: { type: "text", text: big } }, createdAt: Date.now() });
  store.appendMessage({ sessionId: "s-page", kind: "user", payload: { text: "再问" }, createdAt: Date.now() });
  const tail = store.messagesTail("s-page", 50);
  check("a page stops on the byte budget, keeping at least one row",
    tail.messages.length >= 1 && tail.messages.length < 3 && tail.hasOlder === true,
    `${tail.messages.length} rows, hasOlder=${tail.hasOlder}`);
  store.close();
}

// ---- 7. the one-time repair of a legacy (chunk-per-row) transcript --------------------------
{
  // write rows the way the old code did, on the same file, and pretend the fold never ran
  const raw = new DatabaseSync(dbPath);
  let seq = 100;
  const ins = raw.prepare(
    "insert into messages (seq, session_id, kind, payload, tool_call_id, block_key, created_at) values (?,?,?,?,?,?,?)",
  );
  const payload = (text: string, messageId?: string) =>
    JSON.stringify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text }, ...(messageId ? { messageId } : {}) });
  const legacy = "看完了，工作区往前走了不少。\n\n| 项目 | 状态 |\n|---|---|\n| track | §20 |\n| lessons | 有 |\n";
  for (const c of legacy) ins.run(++seq, "s-legacy", "agent", payload(c, "old-1"), null, null, Date.now());
  // …and the same message re-sent later as one anonymous block (what Hermes does on every re-attach)
  ins.run(++seq, "s-legacy", "agent", payload(legacy), null, null, Date.now());
  ins.run(++seq, "s-legacy", "user", JSON.stringify({ text: "另一问" }), null, null, Date.now());
  raw.prepare("pragma user_version = 0").run();
  raw.close();

  const store = new Store(dbPath); // the constructor folds
  const rows = store.messagesTail("s-legacy", 100).messages;
  check("a legacy reply collapses to one row", rows.filter((r) => r.kind === "agent").length === 1,
    `${rows.filter((r) => r.kind === "agent").length} agent rows`);
  check("…and keeps its whole text (the table is intact)",
    (rows.find((r) => r.kind === "agent")?.payload as { content: { text: string } }).content.text === legacy,
    JSON.stringify((rows.find((r) => r.kind === "agent")?.payload as { content: { text: string } }).content.text).slice(0, 80));
  check("the other rows are untouched", rows.some((r) => r.kind === "user"));
  check("a backup file was written", fs.existsSync(`${dbPath}.pre-fold.bak`), dbPath);
  // re-open: nothing should change
  store.close();
  const again = new Store(dbPath);
  check("re-opening does not fold again",
    again.messagesTail("s-legacy", 100).messages.filter((r) => r.kind === "agent").length === 1);
  again.close();
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${ok} ok, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
