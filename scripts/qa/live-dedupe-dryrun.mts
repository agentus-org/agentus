// DRY RUN on a COPY of the live store: what will the v4 migration do when it starts?
// Never points at the live file — copies it with `sqlite3 .backup` (WAL-safe) into the scratch dir.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../packages/server/src/store/store.ts";

const LIVE = "/Users/liang/Workspace/agent-dev-workspace/worktrees/agentus/packages/server/.data/agentus.sqlite";
const dir = fs.mkdtempSync("/Users/liang/.hermes/cache/scratch/live-dedupe-");
const copy = path.join(dir, "agentus.sqlite");
const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

console.log(`live : ${LIVE}`);
console.log(`copy : ${copy}`);
execSync(`sqlite3 ${q(LIVE)} ".backup ${q(copy)}"`);

const aheadSql = `last_activity_at is not null
  and last_activity_at > (select max(m.created_at) from messages m where m.session_id = sessions.id)`;

function snap(p: string, label: string): void {
  const db = new DatabaseSync(p);
  const v = db.prepare("pragma user_version").get() as { user_version: number };
  const rows = db.prepare("select count(*) as n from messages").get() as { n: number };
  const sess = db.prepare("select count(*) as n from sessions").get() as { n: number };
  const bumped = db.prepare(`select count(*) as n from sessions where ${aheadSql}`).get() as { n: number };
  const spread = db.prepare(`select min(last_activity_at) as lo, max(last_activity_at) as hi from sessions where ${aheadSql}`)
    .get() as { lo: number | null; hi: number | null };
  db.close();
  const f = (x: number) => new Date(x).toISOString().slice(11, 19);
  console.log(`\n[${label}] user_version=${v.user_version}  messages=${rows.n}  sessions=${sess.n}`);
  console.log(`  clocks sitting AHEAD of their newest surviving row (the replay bump): ${bumped.n}`);
  if (bumped.n && spread.lo) console.log(`  their clock range: ${f(spread.lo)} … ${f(spread.hi!)}`);
}

snap(copy, "before");
console.log("\n--- running the store's migration on the COPY ---");
new Store(copy);
snap(copy, "after");
console.log(`\nscratch dir: ${dir}`);
