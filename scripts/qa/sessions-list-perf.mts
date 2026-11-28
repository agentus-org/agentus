// /api/sessions 的 N+1 守卫（issue #119）。
//
// 旧代码 #infoFromRow() 每行都调一次 store.lastActivityAt()——而后者是**全会话表**查询：
// 120 条冷会话 = 120 次全表扫描，随会话数平方级增长。这里用调用次数当确定性红证
// （耗时只做辅助展示，避免把机器快慢当判据），并同时钉住 lastAt/lastSeq 的正确性。
//
//   npx tsx scripts/qa/sessions-list-perf.mts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { Store } = await import("../../packages/server/src/store/store.ts");
const { SessionManager } = await import("../../packages/server/src/acp/session-manager.ts");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  ok ? (pass += 1) : (fail += 1);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  — ${detail}` : ""}`);
};

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-sessions-perf-"));
const db = path.join(ROOT, "hermes-studio.sqlite");
const store = new Store(db);
const N = 120;
const MSG = 40;
for (let i = 0; i < N; i += 1) {
  const id = `s${i}`;
  store.upsertSession({
    id, backend: "mock", acpSessionId: `acp-${i}`, cwd: `/ws/w${i % 6}`,
    workspace: `/ws/w${i % 6}`, title: id, status: "ready", pid: null,
    createdAt: 1000 + i, closedAt: null, home: null,
  } as never);
  for (let j = 0; j < MSG; j += 1) {
    store.appendMessage({
      sessionId: id, kind: "agent", payload: { content: { text: "x" } },
      createdAt: 1000 + i * 100 + j,
    } as never);
  }
}

const spy = { last: 0, seq: 0, seqAll: 0 };
const origLast = store.lastActivityAt.bind(store);
const origSeq = store.maxSeq.bind(store);
const origSeqAll = store.maxSeqAll.bind(store);
(store as unknown as { lastActivityAt: () => unknown }).lastActivityAt = () => {
  spy.last += 1;
  return origLast();
};
(store as unknown as { maxSeq: (id: string) => number }).maxSeq = (id: string) => {
  spy.seq += 1;
  return origSeq(id);
};
(store as unknown as { maxSeqAll: () => unknown }).maxSeqAll = () => {
  spy.seqAll += 1;
  return origSeqAll();
};

const mgr = new SessionManager(store, () => {}) as unknown as {
  cold(per: number, total: number): { id: string; lastAt: number; lastSeq: number; cwd: string }[];
  coldPage(per: number, total: number): {
    rows: { id: string }[];
    total: number;
    omitted: number;
  };
  archived(): { id: string; lastAt: number; lastSeq: number }[];
};

console.log("[1] cold(): one activity scan for the whole list, not one per row");
// A small page is the sharp red test: old code builds every one of the 120 rows (and scans the
// whole activity table for each), new code builds only the 18 rows that survive paging.
const t0 = performance.now();
const rows = mgr.cold(3, 100);
const ms = performance.now() - t0;
console.log(`      ${rows.length} rows in ${ms.toFixed(1)} ms; lastActivityAt=${spy.last}, maxSeqAll=${spy.seqAll}, maxSeq(per-row)=${spy.seq}`);
check("cold() 按工作空间分页（6×3）", rows.length === 18, `got ${rows.length}`);
check("lastActivityAt() 每次 cold() 恰好 1 次", spy.last === 1, `calls=${spy.last}`);
check("maxSeqAll() 每次 cold() 恰好 1 次", spy.seqAll === 1, `calls=${spy.seqAll}`);
check("maxSeq() 不再逐行调用（旧代码 = 120 次）", spy.seq === 0, `calls=${spy.seq}`);
const page = mgr.coldPage(3, 100);
check("coldPage 的 total/omitted 契约未变", page.total === N && page.omitted === N - page.rows.length,
  `total=${page.total} omitted=${page.omitted} rows=${page.rows.length}`);
const newest = rows.find((r) => r.id === `s${N - 1}`);
check("lastAt 取的是该会话最后一条消息的时间", newest?.lastAt === 1000 + (N - 1) * 100 + MSG - 1, `got ${newest?.lastAt}`);
check("lastSeq 取的是该会话的消息条数", newest?.lastSeq === MSG, `got ${newest?.lastSeq}`);

console.log("\n[2] archived(): same one-scan rule");
store.setArchived("s0", 20000);
const before = { ...spy };
const archived = mgr.archived();
console.log(`      ${archived.length} archived row(s); extra calls last=${spy.last - before.last}, seqAll=${spy.seqAll - before.seqAll}`);
check("archived() 不会逐行重扫", spy.last - before.last === 1, `calls=${spy.last - before.last}`);
check("archived() 也只做一次批量 seq 查询", spy.seqAll - before.seqAll === 1, `calls=${spy.seqAll - before.seqAll}`);
check("archived 行仍带正确的 lastSeq", archived[0]?.lastSeq === MSG, `got ${archived[0]?.lastSeq}`);

console.log("\n[3] no cold candidates → no all-table snapshots at all (review R1)");
for (let i = 0; i < N; i += 1) store.setArchived(`s${i}`, 20000);
const beforeEmpty = { ...spy };
const empty = mgr.cold(3, 100);
check("全归档时 cold() 返回空页", empty.length === 0 && mgr.coldPage(3, 100).total === 0, `rows=${empty.length}`);
check("空冷列表不再付全表扫描", spy.last === beforeEmpty.last && spy.seqAll === beforeEmpty.seqAll,
  `last=${spy.last - beforeEmpty.last} seqAll=${spy.seqAll - beforeEmpty.seqAll}`);

store.close();
fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
