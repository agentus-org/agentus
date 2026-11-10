// issue #98 — a session's `cwd` is a create-once fact, not live status.
//
// 操作者把一条已经活着的会话的工作目录在库里改到新路径（迁移到新的内置工作空间目录、恢复备份、
// 修一条脏行），随后任何一次 live 状态写入（关闭 / idle reaper / 启动同步 / resume / 置 error）
// 都会把**进程启动那一刻的内存副本**写回 `cwd` 列 —— 迁移被静默回滚，且不留日志。下一次 resume
// 用的是旧目录；旧目录若已被移走，agent 就在一个不存在的目录里起来。
//
// `home` / `role` / `archived_at` / `workspace` 都已经从这条 UPDATE 里摘出去了（各自的注释写着
// 「a live-status write must never clobber a choice the operator made」），`cwd` 是漏掉的那一个。
//
// Run: npm run session-cwd-persist   (或 npx tsx scripts/qa/session-cwd-persist.mts)
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-cwd-persist-"));
const dbPath = path.join(dir, "agentus.sqlite");

const row = (id: string, cwd: string) => ({
  id, backend: "hermes" as const, acpSessionId: `acp-${id}`, cwd, title: id,
  status: "ready" as const, pid: 4242, createdAt: 1_700_000_000_000, closedAt: null,
  archivedAt: null, modes: null, configOptions: [], usage: null, commands: [], models: null,
  system: false, role: null, home: "/home/x",
});

const store = new Store(dbPath);
// ---- 1. insert path still writes cwd -------------------------------------------------------
store.upsertSession(row("s1", "/old/path"));
check("create: insert writes the cwd it was given",
  store.getSession("s1")?.cwd === "/old/path", String(store.getSession("s1")?.cwd));

// ---- 2. a routine live-status write must not roll an operator's edit back -------------------
// 模拟操作者直接改库（迁移/备份恢复/修脏行），与 issue 里给的验收判据同一条命令。
const raw = new DatabaseSync(dbPath);
raw.prepare("update sessions set cwd = ? where id = ?").run("/new/path", "s1");
raw.close();
check("precondition: the operator's edit landed in the DB",
  store.getSession("s1")?.cwd === "/new/path", String(store.getSession("s1")?.cwd));

// …然后任何一次 live 状态写入 —— 这里用关闭那条（session-manager 的收尾路径），行里带着的仍是
// 进程启动时抓下来的旧 cwd。
store.upsertSession({ ...row("s1", "/old/path"), status: "closed", pid: null, closedAt: Date.now() });
check("a live-status write leaves the operator's cwd alone (#98)",
  store.getSession("s1")?.cwd === "/new/path",
  `got ${JSON.stringify(store.getSession("s1")?.cwd)} — the in-memory copy overwrote the row`);

// ---- 3. the rest of that UPDATE still works (we did not just delete the branch) -------------
store.upsertSession({ ...row("s1", "/old/path"), title: "renamed", status: "ready", pid: 77 });
const after = store.getSession("s1");
check("status/title/pid still flow through the same statement",
  after?.status === "ready" && after?.title === "renamed" && after?.pid === 77,
  JSON.stringify({ status: after?.status, title: after?.title, pid: after?.pid }));
check("…and cwd is STILL the operator's, not the copy's",
  after?.cwd === "/new/path", String(after?.cwd));

// ---- 4. resume's authority: row.workspace || row.cwd --------------------------------------
check("resume authority reads the row back unchanged (#98)",
  (store.getSession("s1")?.workspace ?? store.getSession("s1")?.cwd) === "/new/path",
  String(store.getSession("s1")?.workspace ?? store.getSession("s1")?.cwd));

// ---- 5. workspace keeps its own override, untouched by the upsert --------------------------
store.setWorkspace("s1", "/picked/workspace");
store.upsertSession({ ...row("s1", "/old/path"), status: "ready" });
check("sessions.workspace keeps its override across a live-status write",
  store.getSession("s1")?.workspace === "/picked/workspace",
  String(store.getSession("s1")?.workspace));

// ---- 5b. the known masking: with a workspace set, resume's `row.workspace || row.cwd` ignores
// the cwd column entirely — so a cwd edit made at the same time is invisible to spawn and
// `session/new` (`session/load` passes `row.cwd` alone). Documented here because a migration that
// moves a session has to clear or move the workspace too, not just the cwd.
const masked = store.getSession("s1");
check("workspace 非空时 resume 的权威是 workspace（此时改 cwd 对 spawn 不可见，迁移要一并处理）",
  Boolean(masked?.workspace) && (masked?.workspace ?? masked?.cwd) === "/picked/workspace",
  JSON.stringify({ workspace: masked?.workspace, cwd: masked?.cwd }));

// ---- 6. home / role stay insert-only (the neighbours we are matching) ----------------------
check("home is untouched by the upsert (the comment this fix copies)",
  store.getSession("s1")?.home === "/home/x", String(store.getSession("s1")?.home));

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${ok} ok, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
