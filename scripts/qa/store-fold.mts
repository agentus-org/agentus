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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-store-fold-"));
const dbPath = path.join(dir, "agentus.sqlite");
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
    + "- `worktrees/agentus`：独立仓不入库\n\n"
    + "**任务索引（TASKS.md）**\n| slug | 状态 |\n|---|---|\n| agentus | 进行中 |\n";
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

// ---- 5. one tool call is ONE row, however many times the agent re-sends it -------------------
// The agent re-sends every call it holds whenever it re-attaches (`session/load` on a resume), and
// those frames used to be appended like fresh output: in the operator's own store 1224 calls had 7507
// extra rows, the worst sitting in one transcript 17 times (2026-10-08).
{
  const toolDb = path.join(dir, "tools.sqlite");
  const store = new Store(toolDb);
  const sid = "s-tools";
  const call = (over: Record<string, unknown> = {}): Parameters<Store["appendToolCall"]>[0] => ({
    sessionId: sid, kind: "tool", toolCallId: "tc-1", createdAt: Date.now(),
    payload: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "读文件", status: "pending", ...over },
  });
  const first = store.appendToolCall(call());
  check("a new call is stored", first.isNew);
  const replay = store.appendToolCall(call());
  check("a re-sent call is NOT a second row", !replay.isNew);
  check("…and it hands back the row we already hold", replay.message.seq === first.message.seq,
    `${replay.message.seq} vs ${first.message.seq}`);
  check("the transcript holds one tool row",
    store.messagesTail(sid, 100).messages.filter((r) => r.kind === "tool").length === 1);
  // the LIVE update path still merges into that same row
  store.upsertToolMessage(sid, "tc-1", { sessionUpdate: "tool_call_update", toolCallId: "tc-1", title: "读文件", status: "completed" });
  const kept = store.messagesTail(sid, 100).messages;
  const keptStatus = (kept[0]?.payload as { status?: string } | undefined)?.status;
  check("an update merges into that one row",
    kept.length === 1 && keptStatus === "completed",
    `${kept.length} rows, status=${keptStatus}`);
  check("a call with no id still lands (nothing to identify it by)",
    store.appendToolCall({ sessionId: sid, kind: "tool", toolCallId: "", createdAt: Date.now(),
      payload: { sessionUpdate: "tool_call", title: "x", status: "pending" } }).isNew);
  store.close();
}

// ---- 6. the one-time cleanup of the rows a replay already wrote ------------------------------
// A burst of identical copies inside one second IS a replay; a repeat spread over different seconds
// is the agent saying the same thing twice, and a copy that is not byte-identical may carry an update
// the live row never got — both are left alone.
{
  const rpDb = path.join(dir, "replay.sqlite");
  new Store(rpDb).close(); // schema only
  const T = 1_700_000_000_000;
  const RAW = "insert into messages (seq, session_id, kind, payload, tool_call_id, block_key, created_at) values (?,?,?,?,?,?,?)";
  const textPayload = (text: string, messageId?: string): string => JSON.stringify({
    sessionUpdate: "agent_message_chunk", content: { type: "text", text }, ...(messageId ? { messageId } : {}),
  });
  const callPayload = (status: string): string => JSON.stringify({
    sessionUpdate: "tool_call", toolCallId: "tc-9", title: "跑测试", status,
  });
  const long = "这一整段是回答的正文，足够长，长到不该被当成一句口头重复来对待。";
  const raw = new DatabaseSync(rpDb);
  const ins = raw.prepare(RAW);
  let seq = 0;
  // the live turn: one call, one reply
  ins.run(++seq, "s-rp", "user", JSON.stringify({ text: "问一下" }), null, null, T);
  ins.run(++seq, "s-rp", "agent", textPayload(long, "m-live"), null, "agent:m-live", T);
  ins.run(++seq, "s-rp", "tool", callPayload("completed"), "tc-9", null, T);
  const liveSeqs = [1, 2, 3];
  // …and what eight re-attaches wrote over the next two days (the bug, reproduced by hand)
  const burst: number[] = [];
  for (let i = 0; i < 6; i += 1) { ins.run(++seq, "s-rp", "tool", callPayload("completed"), "tc-9", null, T + 86_400_000 + i); burst.push(seq); }
  for (let i = 0; i < 4; i += 1) { ins.run(++seq, "s-rp", "agent", textPayload(long), null, null, T + 86_400_000 + i); burst.push(seq); }
  // a copy that DIFFERS (a replay carrying state the live row never got) — kept
  ins.run(++seq, "s-rp", "tool", callPayload("in_progress"), "tc-9", null, T + 90_000_000);
  const differs = seq;
  // a genuine repeat, on its own second — kept
  ins.run(++seq, "s-rp", "agent", textPayload(long), null, null, T + 200_000_000);
  const lone = seq;
  // a short repeat ("好的" twice is a conversation, not a replayed block) — kept
  ins.run(++seq, "s-rp", "agent", textPayload("好的", "m-a"), null, "agent:m-a", T + 300_000_000);
  ins.run(++seq, "s-rp", "agent", textPayload("好的", "m-a"), null, "agent:m-a", T + 300_000_001);
  const shortSeqs = [seq - 1, seq];
  // Version 2 models the operator's real store: the legacy fold had ALREADY run when these copies
  // landed, so it never saw them — that is why a second pass exists at all.
  raw.prepare("pragma user_version = 2").run();
  raw.close();

  const store = new Store(rpDb); // the constructor cleans up
  const rows = store.messagesTail("s-rp", 500).messages;
  const seqs = rows.map((r) => r.seq);
  check("every replayed copy is gone", burst.every((s) => !seqs.includes(s)),
    `still there: ${burst.filter((s) => seqs.includes(s)).join(",")}`);
  check("a copy that DIFFERS is kept (it may carry an update)", seqs.includes(differs));
  check("a genuine repeat on its own second is kept", seqs.includes(lone));
  check("a short repeat is kept (two messages, not a replay)", shortSeqs.every((s) => seqs.includes(s)));
  check("the live rows are untouched", liveSeqs.every((s) => seqs.includes(s)));
  check("…so the transcript holds 2 tool rows and 4 agent rows",
    rows.filter((r) => r.kind === "tool").length === 2 && rows.filter((r) => r.kind === "agent").length === 4,
    `${rows.filter((r) => r.kind === "tool").length} tool, ${rows.filter((r) => r.kind === "agent").length} agent`);
  check("a backup was made before deleting anything", fs.existsSync(`${rpDb}.pre-dedupe.bak`), rpDb);
  store.close();
  const again = new Store(rpDb);
  check("re-opening does not clean again",
    again.messagesTail("s-rp", 500).messages.length === rows.length);
  again.close();
}

// ---- 7. the session's own activity clock -----------------------------------------------------
// A derived `max(messages.created_at)` counts a REPLAY as activity — that is how every resumed session
// came back reading 「刚刚」 (2026-10-08). The clock is its own column, written by real activity only.
{
  const clDb = path.join(dir, "clock.sqlite");
  const store = new Store(clDb);
  const sid = "s-clock";
  store.upsertSession({
    id: sid, backend: "mock", acpSessionId: "a", cwd: "/tmp", title: "t", status: "idle",
    pid: null, createdAt: 1, closedAt: null, home: null,
  } as never);
  check("a session that never spoke has no clock of its own",
    store.lastActivityAt().get(sid) === 1, String(store.lastActivityAt().get(sid)));
  store.touchActivity(sid, 5_000);
  check("real activity advances the clock", store.lastActivityAt().get(sid) === 5_000);
  store.touchActivity(sid, 4_000);
  check("…and it never walks backwards", store.lastActivityAt().get(sid) === 5_000);
  // rows written later (a replay landing) must not move it
  store.appendMessage({ sessionId: sid, kind: "agent", payload: { content: { type: "text", text: "迟到的行" } }, createdAt: 9_000 });
  check("a row written without activity does not move the clock (that is the whole point)",
    store.lastActivityAt().get(sid) === 5_000, String(store.lastActivityAt().get(sid)));
  store.close();
}

// ---- 8. a store that predates the column gets its clock from the rows it KEPT -----------------
// The cleanup above runs first precisely so this number is when the conversation was last talked to,
// not when its agent was last resumed.
{
  const oldDb = path.join(dir, "legacy-clock.sqlite");
  new Store(oldDb).close();
  const T = 1_600_000_000_000;
  const raw = new DatabaseSync(oldDb);
  raw.exec("drop table sessions");
  raw.exec(`create table sessions (
    id text primary key, backend text not null, acp_session_id text, cwd text not null,
    title text not null, status text not null, pid integer, created_at integer not null,
    closed_at integer, home text)`);
  raw.prepare("insert into sessions (id, backend, cwd, title, status, created_at) values (?,?,?,?,?,?)")
    .run("s-old", "mock", "/tmp", "旧会话", "idle", T - 10_000);
  const ins = raw.prepare("insert into messages (seq, session_id, kind, payload, tool_call_id, block_key, created_at) values (?,?,?,?,?,?,?)");
  const body = "很久以前的一段回答，长度足够当作一整块内容来看待，不会被当成口头重复。";
  ins.run(1, "s-old", "user", JSON.stringify({ text: "hi" }), null, null, T);
  ins.run(2, "s-old", "agent", JSON.stringify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: body }, messageId: "m-1" }), null, "agent:m-1", T + 1_000);
  // the restart that polluted it: the same block replayed twice, a day later
  ins.run(3, "s-old", "agent", JSON.stringify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: body } }), null, null, T + 86_400_000);
  ins.run(4, "s-old", "agent", JSON.stringify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: body } }), null, null, T + 86_400_001);
  ins.run(5, "s-old", "agent", JSON.stringify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: body } }), null, null, T + 86_400_002);
  raw.prepare("pragma user_version = 0").run(); // this store predates every repair
  raw.close();
  const store = new Store(oldDb); // adds the column, cleans up, then reads the clock
  check("the legacy session's clock is its real last activity, not the restart",
    store.lastActivityAt().get("s-old") === T + 1_000,
    String(store.lastActivityAt().get("s-old") - T));
  check("…and the replayed copies are gone", store.messagesTail("s-old", 500).messages.length === 2,
    String(store.messagesTail("s-old", 500).messages.length));
  store.close();
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${ok} ok, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
