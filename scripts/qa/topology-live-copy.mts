// 用**真库的副本**跑回填 + 统计，验证 SQL 在 19 万条消息 / 100+ 会话上真的成立。
//   npx tsx scripts/qa/topology-live-copy.mts /tmp/topo-live/copy.sqlite
import { Store } from "../../packages/server/src/store/store.js";

const dbPath = process.argv[2];
if (!dbPath) { console.error("usage: topology-live-copy.mts <sqlite path>"); process.exit(2); }

const t0 = Date.now();
const s = new Store(dbPath);
const opened = Date.now() - t0;
const edgeRows = s.listEdges(0);
const t1 = Date.now();
const all = s.listEdges(0);
const readMs = Date.now() - t1;

console.log(`open+backfill ${opened} ms, listEdges ${readMs} ms`);
console.log(`edges: ${edgeRows.length} rows, kinds: ${JSON.stringify(
  edgeRows.reduce<Record<string, number>>((a, e) => { a[e.kind] = (a[e.kind] ?? 0) + 1; return a; }, {}))}`);
console.log(`top 8 by n: ${edgeRows.sort((a, b) => b.n - a.n).slice(0, 8).map((e) => `${e.origin.slice(0, 6)}→${e.target.slice(0, 6)} ${e.kind}×${e.n}`).join(", ")}`);
console.log(`last 3 days: ${s.listEdges(Date.now() - 3 * 86400_000).length} edges`);
console.log(`sessions: ${s.listSessions(true).length}, open: ${s.listSessions(true).filter((x) => x.status !== "closed").length}`);
console.log(`reopen (idempotent): ${(() => { const b = Date.now(); const s2 = new Store(dbPath); const n = s2.listEdges(0).length; s2.close(); return `${n} edges in ${Date.now() - b} ms`; })()}`);
s.close();
