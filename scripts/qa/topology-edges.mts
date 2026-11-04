// QA: 会话拓扑的「关系」数据面 —— `edges` 表、回填、以及窗口过滤。
//
// 拓扑面板画出来的每一条线都必须有出处（目标会话那条 user 消息的 `payload.origin`，或者
// `cockpit create` 的调用方）。这个脚本钉住三件最容易悄悄坏掉的事：
//
//   1. 回填把历史转录里的关系抽出来，并且**能把 handoff 与 dispatch 分开**（桥接信封开口是
//      `[跨工作空间转交]`）；`background`（后台任务回推）与自环不是会话关系，必须丢掉。
//   2. 回填是**一次性**的：再开一次库不会把 `n` 翻倍。这条不做，重启几次之后每条边都会变成 ×8。
//   3. 窗口按 `last_at` 过滤 —— 3 天窗里不该出现 5 天前就断掉的关系。
//
//   npx tsx scripts/qa/topology-edges.mts        # 全绿才算过
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../packages/server/src/store/store.js";

let passed = 0;
const failures: string[] = [];
function check(ok: boolean, name: string, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-qa-edges-"));
const DB = path.join(DIR, "agentus.sqlite");
const now = Date.now();

function user(store: Store, target: string, text: string, origin?: string): void {
  store.appendMessage({
    sessionId: target,
    kind: "user",
    createdAt: now,
    payload: { text, ...(origin ? { origin: { sessionId: origin, title: "x" } } : {}) } as unknown,
  });
}

// ---- 1. 造一段「历史」：关系藏在消息里 --------------------------------------
const first = new Store(DB);
user(first, "S1", "[跨工作空间转交] 这条消息由操作员在另一个会话里用 @ 转过来的", "X");
user(first, "S1", "把这件活干了", "X");                       // send 派过去的
user(first, "S2", "[完成回推] 后台任务跑完了", "background");   // 不是会话
user(first, "S2", "自己给自己", "S2");                        // 自环
user(first, "S3", "操作者自己打的字");                         // 没有 origin
first.close();

// 把「回填跑过了」的记录删掉，模拟一个升级上来的旧库
const raw = new DatabaseSync(DB);
raw.exec("delete from repairs where name = 'edges'");
raw.close();

// ---- 2. 回填 ---------------------------------------------------------------
const backfilled = new Store(DB);
const edges = backfilled.listEdges(0);
const pair = edges.filter((e) => e.origin === "X" && e.target === "S1");
check(edges.length === 2, "回填只留下真正的两条关系", `实际 ${edges.length} 条: ${edges.map((e) => `${e.origin}→${e.target}:${e.kind}`).join(", ")}`);
check(pair.some((e) => e.kind === "handoff"), "桥接信封的那条判成 handoff");
check(pair.some((e) => e.kind === "dispatch"), "普通 send 的那条判成 dispatch");
check(!edges.some((e) => e.origin === "background"), "background 回推不产生边");
check(!edges.some((e) => e.origin === e.target), "自环不产生边");
check(!edges.some((e) => e.target === "S3"), "没有 origin 的消息不产生边");
backfilled.close();

// ---- 3. 幂等：再开一次库，n 不许翻倍 ---------------------------------------
const again = new Store(DB);
const after = again.listEdges(0);
const n1 = after.find((e) => e.origin === "X" && e.target === "S1" && e.kind === "dispatch")?.n ?? -1;
check(after.length === 2 && n1 === 1, "回填是一次性的（重开库 n 仍为 1）", `edges=${after.length} n=${n1}`);

// ---- 4. recordEdge：累加、跳过不该记的 --------------------------------------
again.recordEdge("X", "S1", "dispatch", now);
const bumped = again.listEdges(0).find((e) => e.origin === "X" && e.target === "S1" && e.kind === "dispatch");
check(bumped?.n === 2, "同一条关系再来一次 n+1", `n=${bumped?.n}`);
again.recordEdge("background", "S1", "dispatch", now);
again.recordEdge("S1", "S1", "dispatch", now);
check(again.listEdges(0).length === 2, "background 与自环仍被拒之门外");
// spawn：派活时新建出来的会话是**子会话**，跟「派给已有会话」不是一回事 —— 图上要靠它分叉画。
again.recordEdge("X", "S9", "spawn", now);
const spawned = again.listEdges(0).find((e) => e.target === "S9");
check(spawned?.kind === "spawn", "新建会话记成 spawn", `kind=${spawned?.kind}`);
again.recordEdge("X", "S9", "handoff", now);
check(again.listEdges(0).filter((e) => e.target === "S9").length === 2, "同一个父子同时有 spawn 和 handoff 时不合并", "同 kind 才累加");

// ---- 5. 窗口：按 last_at 过滤 ----------------------------------------------
check(again.listEdges(now + 60_000).length === 0, "3 天窗（这里是「未来」）过滤掉旧边");
check(again.listEdges(now - 1).length === 4, "窗口内仍在（2 条回填 + 2 条 S9）", `${again.listEdges(now - 1).length}`);
again.close();

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
