// QA: 启动回收的**归属判定**（incident 2026-10-22 的根因层）。
//
// `orphan-guard-sweep.mjs` 从外部证明了「同 dataDir 的第二个实例会被拒绝」，这个脚本证明更底层的一件事：
// reclaimOrphans() 只杀**能证明是本 dataDir 上一个 server 留下的** agent。六种 pid 都真实起进程：
//
//   1 孤儿（上一轮 server 的 agent，还活着，带 receipt）      → 杀，日志带 pid + 理由
//   2 无辜进程（数据库里记着的 pid 被系统回收给了别人）        → 不杀，warn，pid 置空
//   3 本轮自己的 agent（receipt 的 serverInstance 等于本轮）   → 不杀
//   4 receipt 指向另一个 dataDir（目录被复制/还原过）           → 不杀
//   5 无 receipt 的老行（旧版本写的，argv 仍是 ACP agent）     → 杀（不留孤儿）
//   6 无 receipt 且 argv 不是 agent（pid 被复用）             → 不杀
//   7 进程已经没了                                            → 不杀、不 warn
//
//   node_modules/.bin/tsx scripts/qa/reclaim-owner-sweep.mts
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "../..");
const MOCK = path.join(REPO, "packages/server/mock/agent.mjs");
const { Store } = await import("../../packages/server/src/store/store.ts");
const { SessionManager } = await import("../../packages/server/src/acp/session-manager.ts");
const { recordAgentOwner } = await import("../../packages/server/src/acp/agent-owner.ts");

let passed = 0;
const failures: string[] = [];
function check(ok: boolean, name: string, detail = ""): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-reclaim-"));
const DATA = path.join(ROOT, "data");
const OTHER_DATA = path.join(ROOT, "other-data");
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(OTHER_DATA, { recursive: true });
const RUN = "instance-now";

/** A process that LOOKS exactly like a mock ACP agent and stays alive because WE hold its stdin. */
function fakeAgent(): { pid: number; kill(): void } {
  const child = spawn(process.execPath, [MOCK], { stdio: ["pipe", "pipe", "pipe"] });
  return {
    pid: child.pid!,
    kill() { try { child.kill("SIGKILL"); } catch { /* gone */ } },
  };
}
/** A process that is alive but is NOT an agent — the shape a recycled pid takes. */
function innocent(): { pid: number; kill(): void } {
  const child = spawn("sleep", ["120"], { stdio: "ignore" });
  return {
    pid: child.pid!,
    kill() { try { child.kill("SIGKILL"); } catch { /* gone */ } },
  };
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const logs: string[] = [];
const realLog = console.log;
const realWarn = console.warn;
console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
console.warn = (...a: unknown[]) => { logs.push(a.join(" ")); };

const store = new Store(path.join(DATA, "agentus.sqlite"));
/** one reclaim target row per case */
function row(id: string, pid: number | null, status = "ready"): void {
  store.upsertSession({
    id, backend: "mock", acpSessionId: "a", cwd: "/tmp", title: id, status,
    pid, createdAt: 1, closedAt: null, home: null,
  } as never);
}

// ---- fixtures -----------------------------------------------------------------------------------
const orphan = fakeAgent();          // 1: previous run's agent, receipt in THIS data dir
const bystander = innocent();        // 2: recycled pid
const ours = fakeAgent();            // 3: receipt names THIS run
const foreign = fakeAgent();         // 4: receipt names another data dir
const legacy = fakeAgent();          // 5: no receipt, argv is an agent
const recycled = innocent();         // 6: no receipt, argv is not an agent
recordAgentOwner(DATA, { pid: orphan.pid, sessionId: "s1", startedAt: Date.now(), serverInstance: "run-before", cmd: MOCK });
// 2 deliberately has NO receipt: the row is stale, the pid now belongs to something else
recordAgentOwner(DATA, { pid: ours.pid, sessionId: "s3", startedAt: Date.now(), serverInstance: RUN, cmd: MOCK });
// 4: a receipt that lives in OUR dir but names ANOTHER data dir — a restored/copied directory does
// exactly this, and the server must not kill a process it does not own. (A truly foreign agent cannot
// reach this path any other way: our store never records a pid it did not spawn.)
fs.mkdirSync(path.join(DATA, "agents"), { recursive: true });
fs.writeFileSync(path.join(DATA, "agents", `${foreign.pid}.json`), JSON.stringify({
  pid: foreign.pid, sessionId: "s4", dataDir: OTHER_DATA, serverInstance: "run-before", startedAt: Date.now(), cmd: MOCK,
}), { mode: 0o600 });
// 5/6: no receipts at all (rows written by an older build)
row("s1", orphan.pid);
row("s2", bystander.pid);
row("s3", ours.pid);
row("s4", foreign.pid);
row("s5", legacy.pid);
row("s6", recycled.pid);
row("s7", 999_999); // 7: dead pid
await sleep(400); // let the fake agents settle

const mgr = new SessionManager(store, () => {}, { dataDir: DATA, instanceId: RUN });
const killed = mgr.reclaimOrphans();
await sleep(300);

console.log = realLog;
console.warn = realWarn;
const text = logs.join("\n");

console.log(`[reclaim-owner] killed=${killed} (scratch ${ROOT})`);
check(killed === 2, "只回收了 2 个：上一轮的孤儿 + 无 receipt 的老行", `killed=${killed}`);
check(!alive(orphan.pid), "1 上一轮的孤儿 agent 被杀", `pid ${orphan.pid}`);
check(new RegExp(`killed pid ${orphan.pid}.*receipt`).test(text), "1 日志带 pid 与「receipt」理由");
check(alive(bystander.pid), "2 被复用 pid 的无辜进程活着", `pid ${bystander.pid}`);
check(new RegExp(`SKIPPED pid ${bystander.pid}`).test(text), "2 日志明确 SKIPPED（不是静默）");
check(!alive(ours.pid) === false, "3 本轮自己的 agent 没被杀", `pid ${ours.pid}`);
check(new RegExp(`pid ${ours.pid} was spawned by THIS server run`).test(text), "3 日志说明它属于本轮");
check(alive(foreign.pid), "4 别的 dataDir 的 agent 活着", `pid ${foreign.pid}`);
check(new RegExp(`pid ${foreign.pid} was spawned by the server of`).test(text), "4 日志点明它属于哪个 dataDir");
check(!alive(legacy.pid), "5 无 receipt 的旧行仍然被回收（不留孤儿）", `pid ${legacy.pid}`);
check(/legacy row/.test(text), "5 日志标明是 legacy row 判定");
check(alive(recycled.pid), "6 pid 被复用成非 agent → 不杀", `pid ${recycled.pid}`);
check(new RegExp(`pid ${recycled.pid} is not an ACP agent`).test(text), "6 日志给出 argv 证据");
check(/nothing to kill for session s7/.test(text), "7 已消失的 pid 只记一行、不报警");

// every row lost its pid: a stale number must not be re-examined (or re-endangered) next boot
const remaining = store.listSessions(true).filter((r) => ["s1", "s2", "s3", "s4", "s5", "s6", "s7"].includes(r.id));
check(remaining.every((r) => r.pid == null), "所有 pid 都被置空（下轮不再处理同一个数字）");
// and the live sessions are closed honestly instead of pretending to be ready with no process
check(remaining.every((r) => r.status === "error"), "没有活进程的会话被标成 error（不假装 ready）");

for (const p of [orphan, bystander, ours, foreign, legacy, recycled]) p.kill();
store.close();
fs.rmSync(ROOT, { recursive: true, force: true });

console.log(`\n[reclaim-owner] ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
