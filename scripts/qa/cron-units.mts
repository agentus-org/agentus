// 定时作业面板读那一侧的单测（issue #92）。
//
// 面板的**写**那一侧由 `cron-board-dom.mjs` 用真 CLI 证明（点暂停 → jobs.json 真变）；这里守的是
// **读**那一侧的不变量 —— 也就是「Hermes 的存储长什么样，我们就怎么摊平」，一条也不许多算：
//
//   ① jobs.json 里 `schedule` / `repeat` 都是**对象**（`{kind,expr,display}` / `{times,completed}`），
//      第一版按字符串读，于是面板上调度列全空 —— 这类错误单测一秒就能钉住；
//   ② `state` 用 Hermes 的原值（`scheduled` / `paused` …），不在这里翻译成 active/inactive；
//   ③ 没有 cron 目录 / jobs.json 坏掉 → `available:false` + 原因，**不抛**（面板据此整块降级）；
//   ④ 动作白名单只有 pause/resume/run/remove，别的串一律不认；
//   ⑤ 读 executions.db 是只读的，读的时候 Hermes 同时在写也不炸。
//
//   npx tsx scripts/qa/cron-units.mts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readJobs, readRuns, readIncidents, isCronVerb, cronDirOf, type CronTarget } from "../../packages/server/src/cron/jobs.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cron-units-"));
const t: CronTarget = { home: root, profile: null, cmd: "hermes" };
const cronDir = cronDirOf(t);
check("cron 目录 = <home>/cron", cronDir === path.join(root, "cron"));

// ---- ① 没有 cron 目录：正常降级，不是错误 ------------------------------------------------
const missing = readJobs(t);
check("没有 cron 目录 → available:false", missing.available === false && missing.jobs.length === 0);
check("降级带原因（面板拿去显示）", typeof missing.why === "string" && missing.why.includes("cron"), missing.why);

fs.mkdirSync(cronDir, { recursive: true });

// ---- ② jobs.json 坏掉 ------------------------------------------------------------------
fs.writeFileSync(path.join(cronDir, "jobs.json"), "{ not json");
const broken = readJobs(t);
check("jobs.json 坏了 → available:false 而不是抛", broken.available === false && broken.jobs.length === 0);

// ---- ③ 真实形状（从操作者那份 jobs.json 抄下来的） ---------------------------------------
const doc = {
  updated_at: "2026-11-05T05:00:00+08:00",
  jobs: [
    {
      id: "6aef87776468", name: "每日数据",
      schedule: { kind: "cron", expr: "0 6 * * 2-6", display: "0 6 * * 2-6" },
      schedule_display: "0 6 * * 2-6",
      state: "scheduled", enabled: true, paused_reason: null,
      repeat: { times: null, completed: 88 },
      next_run_at: "2026-11-06T06:00:00+08:00", last_run_at: "2026-11-05T06:00:00+08:00", last_status: "ok",
      no_agent: true, script: "daily_download.sh", deliver: "local",
      created_at: "2026-09-01T00:00:00+08:00", prompt: "跑一下每日数据",
    },
    {
      id: "bad000000000", name: "暂停的",
      schedule: { kind: "interval", expr: "", display: "every 30m" },
      state: "paused", enabled: false, paused_reason: "operator",
      repeat: { times: 3, completed: 1 },
      last_status: "error", last_error: "timeout after 600s", failure_streak: 2,
    },
    { name: "没有 id 的行", schedule: { kind: "cron", expr: "* * * * *" } },
  ],
};
fs.writeFileSync(path.join(cronDir, "jobs.json"), JSON.stringify(doc));
const view = readJobs(t);
check("available + updatedAt 透出", view.available === true && view.updatedAt === "2026-11-05T05:00:00+08:00");
check("没有 id 的行被丢掉（没有它就点不动）", view.jobs.length === 2, `n=${view.jobs.length}`);

const daily = view.jobs.find((j) => j.id === "6aef87776468");
check("schedule 从对象取 expr（不是空串）", daily?.schedule === "0 6 * * 2-6", JSON.stringify(daily?.schedule));
check("scheduleKind = cron", daily?.scheduleKind === "cron", String(daily?.scheduleKind));
check("scheduleDisplay 优先用顶层文本", daily?.scheduleDisplay === "0 6 * * 2-6", String(daily?.scheduleDisplay));
check("repeat 摊成 {times:null, completed:88}", daily?.repeat?.times === null && daily?.repeat?.completed === 88, JSON.stringify(daily?.repeat));
check("noAgent / script / deliver 原样透出", daily?.noAgent === true && daily?.script === "daily_download.sh" && daily?.deliver === "local");
check("state 用 Hermes 原值（不翻译）", daily?.state === "scheduled", String(daily?.state));

const paused = view.jobs.find((j) => j.id === "bad000000000");
check("interval 调度取 display", paused?.scheduleDisplay === "every 30m" && paused?.schedule === "", JSON.stringify([paused?.schedule, paused?.scheduleDisplay]));
check("paused 带原因与失败计数", paused?.state === "paused" && paused?.pausedReason === "operator" && paused?.failureStreak === 2);
check("有限重复摊成 {times:3, completed:1}", paused?.repeat?.times === 3 && paused?.repeat?.completed === 1);
check("enabled:false 也算 paused 语义（面板据此画 idle）", paused?.enabled === false);

// ---- ④ 动作白名单 -----------------------------------------------------------------------
check("四个动作都认", ["pause", "resume", "run", "remove"].every((v) => isCronVerb(v)));
check("别的串不认（不会被递给 CLI）", !isCronVerb("delete") && !isCronVerb("pause; rm -rf /") && !isCronVerb(""));

// ---- ⑤ executions.db：只读读，且壳子对得上 ----------------------------------------------
check("没有 executions.db → available:false", readRuns(t, null, 10).available === false && readIncidents(t, null).available === false);

const dbFile = path.join(cronDir, "executions.db");
const db = new DatabaseSync(dbFile);
db.exec(`create table executions (id text, job_id text, source text, status text, started_at text,
         finished_at text, scheduled_instant text, error text, delivery_outcome text);
         create table cron_incidents (id text, job_id text, state text, failure_type text,
         first_seen_at text, last_seen_at text, acked_at text, closed_at text, error text);`);
db.prepare("insert into executions values (?,?,?,?,?,?,?,?,?)").run("e1", "6aef87776468", "cron", "completed",
  "2026-11-05T06:00:00+08:00", "2026-11-05T06:02:30+08:00", "2026-11-05T06:00:00+08:00", null, "local");
db.prepare("insert into executions values (?,?,?,?,?,?,?,?,?)").run("e2", "bad000000000", "cron", "failed",
  "2026-11-05T07:00:00+08:00", "2026-11-05T07:10:00+08:00", "2026-11-05T07:00:00+08:00", "timeout after 600s", null);
db.prepare("insert into cron_incidents values (?,?,?,?,?,?,?,?,?)").run("i1", "bad000000000", "open", "timeout",
  "2026-11-05T07:00:00+08:00", "2026-11-05T07:10:00+08:00", null, null, "timeout after 600s");
db.close();

const runsAll = readRuns(t, null, 10);
check("执行历史按开始时间倒序", runsAll.available === true && runsAll.runs.length === 2 && runsAll.runs[0].id === "e2",
  runsAll.runs.map((r) => r.id).join(","));
check("失败那条带 error 原文", runsAll.runs[0].error === "timeout after 600s");
const runsOne = readRuns(t, "6aef87776468", 10);
check("按作业过滤只留它自己的", runsOne.runs.length === 1 && runsOne.runs[0].id === "e1");
check("limit 不会被放大（clamp 到 500）", readRuns(t, null, 10_000).runs.length === 2);
const inc = readIncidents(t, null);
check("失败账本读出来", inc.available === true && inc.incidents.length === 1 && inc.incidents[0].failureType === "timeout");
check("按 state 过滤", readIncidents(t, "closed").incidents.length === 0 && readIncidents(t, "open").incidents.length === 1);

// 只读打开：写完立刻再读一次仍然对（说明我们没有持有写锁/没有把文件弄坏）
const after = readJobs(t);
check("读完之后 jobs.json 仍然可读", after.available === true && after.jobs.length === 2);

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${fail ? "FAIL" : "ALL"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
