/**
 * hermes 定时作业的只读门面 + CLI 转发（issue #92）。
 *
 * **驾驶舱不自建调度器。** 调度语义、job 存储、执行历史、失败账本全部留在 Hermes 内核侧：
 *
 *   - 读：`<home>/cron/jobs.json`（作业定义）与 `<home>/cron/executions.db`（执行历史 + 失败账本），
 *     都以只读方式打开，Hermes 的 ticker 同时在写也不受影响；
 *   - 写：exec `hermes cron <verb> <id> --profile <p>`，env 里给 `HERMES_HOME=<home>`，让 CLI 自己
 *     校验、自己改文件。语义一处实现，不在这里复刻。
 *
 * 于是「暂停/恢复/立即运行/删除」这四件事的行为永远等于 CLI 在终端里跑一遍 —— 这也是这份代码
 * 唯一需要守的不变量：**没有一处调度逻辑是这里发明的**。
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import type { CronIncident, CronJob, CronView, CronRun, CronRunsView, CronIncidentsView } from "../../../shared/src/index.js";

/** 一个 hermes 目标：哪个 home、哪个 profile、用哪个可执行文件去转发。 */
export interface CronTarget {
  home: string;
  profile: string | null;
  /** the hermes binary; `hermes` on PATH when the row does not name one */
  cmd: string;
}

/** ① 少一层猜测：cron 目录就是 `<home>/cron`（Hermes 的 `CRON_DIR = HERMES_DIR/"cron"`）。
 *  命名 profile 的数据住在它自己的 home 下，所以这里不做 `profiles/<p>/cron` 的推断 —— 猜错了
 *  会显示另一个 profile 的作业，比显示不出来更坏。 */
export function cronDirOf(t: CronTarget): string {
  return path.join(t.home, "cron");
}

function readJson(file: string): unknown | null {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

const asStr = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const asNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** jobs.json 的一行 → 面板的一行。**只做字段摊平**：没有默认值、没有推断状态、没有排序魔法。 */
/** `schedule` 与 `repeat` 在 jobs.json 里都是对象，不是字符串 —— 照实摊开，别在这里编一个表达式。 */
function scheduleOf(raw: unknown): { schedule: string; scheduleKind: string | null; scheduleDisplay: string | null } {
  if (typeof raw === "string") return { schedule: raw, scheduleKind: null, scheduleDisplay: null };
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    schedule: asStr(o.expr) ?? asStr(o.every) ?? asStr(o.at) ?? "",
    scheduleKind: asStr(o.kind),
    scheduleDisplay: asStr(o.display),
  };
}
function repeatOf(raw: unknown): { times: number | null; completed: number } | null {
  const o = (raw && typeof raw === "object" ? raw : null) as Record<string, unknown> | null;
  if (!o) return null;
  const times = typeof o.times === "number" && Number.isFinite(o.times) ? o.times : null;
  const completed = typeof o.completed === "number" && Number.isFinite(o.completed) ? o.completed : 0;
  return { times, completed };
}

function toJob(raw: Record<string, unknown>): CronJob {
  const state = asStr(raw.state) ?? (raw.enabled === false ? "paused" : "active");
  const sched = scheduleOf(raw.schedule);
  return {
    id: String(raw.id ?? ""),
    name: asStr(raw.name) ?? String(raw.id ?? ""),
    schedule: sched.schedule,
    scheduleKind: sched.scheduleKind,
    scheduleDisplay: asStr(raw.schedule_display) ?? sched.scheduleDisplay,
    state,
    enabled: raw.enabled !== false,
    pausedReason: asStr(raw.paused_reason),
    nextRunAt: asStr(raw.next_run_at),
    lastRunAt: asStr(raw.last_run_at),
    lastStatus: asStr(raw.last_status),
    lastError: asStr(raw.last_error),
    repeat: repeatOf(raw.repeat),
    script: asStr(raw.script),
    noAgent: raw.no_agent === true,
    deliver: asStr(raw.deliver),
    model: asStr(raw.model),
    provider: asStr(raw.provider),
    workdir: asStr(raw.workdir),
    failureStreak: asNum(raw.failure_streak),
    createdAt: asStr(raw.created_at),
    prompt: asStr(raw.prompt),
  };
}

/** 读作业列表。不可用（没有 home/cron 目录/jobs.json 坏了）返回 `available: false` + 原因 ——
 *  面板据此整块隐藏；**这不是错误**，所以不抛。 */
export function readJobs(t: CronTarget): CronView {
  const cronDir = cronDirOf(t);
  const base: Omit<CronView, "available"> = { home: t.home, cronDir, profile: t.profile, jobs: [] };
  let st: fs.Stats;
  try {
    st = fs.statSync(cronDir);
  } catch {
    return { available: false, why: `no cron directory at ${cronDir}（这个 home 不是 hermes profile，或从未跑过作业）`, ...base };
  }
  if (!st.isDirectory()) return { available: false, why: `${cronDir} is not a directory`, ...base };
  const file = path.join(cronDir, "jobs.json");
  const doc = readJson(file);
  if (!doc || typeof doc !== "object") {
    return { available: false, why: `could not read ${file}（文件不存在或不是 JSON）`, ...base };
  }
  const bag = doc as { jobs?: unknown; updated_at?: unknown };
  const rows = Array.isArray(bag.jobs) ? bag.jobs : [];
  const jobs = rows
    .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
    .map(toJob)
    .filter((j) => j.id);
  return {
    available: true,
    home: t.home,
    cronDir,
    profile: t.profile,
    updatedAt: asStr(bag.updated_at),
    jobs,
  };
}

/** 只读打开 executions.db。`readOnly` 是关键：Hermes 的 ticker 一直在写，普通打开会跟它抢写锁，
 *  而这个面板是纯读的（实测同一时刻读 1000 行没问题）。 */
function openDb(t: CronTarget): DatabaseSync | null {
  const file = path.join(cronDirOf(t), "executions.db");
  if (!fs.existsSync(file)) return null;
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
}

const iso = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** 执行历史（`hermes cron runs` 的同一份数据，直接读表：CLI 只输出人类表格，解析它比读自己的库脆弱）。 */
export function readRuns(t: CronTarget, jobId: string | null, limit = 50): CronRunsView {
  const db = openDb(t);
  if (!db) return { available: false, why: `no executions.db under ${cronDirOf(t)}`, runs: [] };
  try {
    const cap = Math.max(1, Math.min(500, Math.trunc(limit) || 50));
    const stmt = jobId
      ? db.prepare(`select id, job_id, source, status, started_at, finished_at, scheduled_instant, error, delivery_outcome
                    from executions where job_id = ? order by started_at desc limit ?`)
      : db.prepare(`select id, job_id, source, status, started_at, finished_at, scheduled_instant, error, delivery_outcome
                    from executions order by started_at desc limit ?`);
    const rows = (jobId ? stmt.all(jobId, cap) : stmt.all(cap)) as Array<Record<string, unknown>>;
    const runs: CronRun[] = rows.map((r) => ({
      id: String(r.id ?? ""),
      jobId: String(r.job_id ?? ""),
      status: String(r.status ?? ""),
      source: asStr(r.source),
      startedAt: iso(r.started_at),
      finishedAt: iso(r.finished_at),
      scheduledInstant: iso(r.scheduled_instant),
      error: asStr(r.error),
      deliveryOutcome: asStr(r.delivery_outcome),
    }));
    return { available: true, runs };
  } catch (e) {
    return { available: false, why: `could not read executions: ${(e as Error).message}`, runs: [] };
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

/** 失败账本（`hermes cron incidents`）：同一错误签名聚成一条，所以「踩了几次」是看得见的。 */
export function readIncidents(t: CronTarget, state: string | null): CronIncidentsView {
  const db = openDb(t);
  if (!db) return { available: false, why: `no executions.db under ${cronDirOf(t)}`, incidents: [] };
  try {
    const stmt = state
      ? db.prepare(`select id, job_id, state, failure_type, first_seen_at, last_seen_at, acked_at, closed_at, error
                    from cron_incidents where state = ? order by last_seen_at desc limit 200`)
      : db.prepare(`select id, job_id, state, failure_type, first_seen_at, last_seen_at, acked_at, closed_at, error
                    from cron_incidents order by last_seen_at desc limit 200`);
    const rows = (state ? stmt.all(state) : stmt.all()) as Array<Record<string, unknown>>;
    const incidents: CronIncident[] = rows.map((r) => ({
      id: String(r.id ?? ""),
      jobId: String(r.job_id ?? ""),
      state: String(r.state ?? ""),
      failureType: asStr(r.failure_type),
      firstSeenAt: iso(r.first_seen_at),
      lastSeenAt: iso(r.last_seen_at),
      ackedAt: iso(r.acked_at),
      closedAt: iso(r.closed_at),
      error: asStr(r.error),
    }));
    return { available: true, incidents };
  } catch (e) {
    return { available: false, why: `could not read incidents: ${(e as Error).message}`, incidents: [] };
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

/** 面板允许的四个动作，与 `hermes cron` 的子命令同形。`run` 只把作业排到下一个 tick，
 *  不是在这里执行 —— 那句语义属于 Hermes，转发方不该替它解释。 */
export const CRON_VERBS = ["pause", "resume", "run", "remove"] as const;
export type CronVerb = (typeof CRON_VERBS)[number];
export const isCronVerb = (v: string): v is CronVerb => (CRON_VERBS as readonly string[]).includes(v);

export interface VerbResult {
  ok: boolean;
  /** the CLI's own words, trimmed — the panel shows them verbatim rather than inventing a message */
  out: string;
  code: number;
}

/** 找一个**真能跑 `cron` 子命令**的 hermes 可执行文件。
 *
 *  为什么不能直接用后端行的 `cmd`：那一列是给 spawn（`… acp`）用的，常常是个 wrapper
 *  （本机是 `hermes-acp-src` → `hermes-dev` → 某个 venv），它能否跑 CLI 取决于**谁调的它** ——
 *  同一份 wrapper 在操作者 shell 里能跑 `cron list`，在 server 进程的环境里就会 import 到另一个
 *  解释器然后 `ModuleNotFoundError: ruamel`。与其猜环境，不如实测一次 `cron list`：跑得通的就是对的，
 *  结论按 home 缓存（hermes 自我升级后换了解释器也只需重启面板/服务）。
 *
 *  探测是只读的（`cron list`），代价一次几十毫秒，且只在第一次点动作时发生。 */
const cliCache = new Map<string, string>();
const probes = new Map<string, Promise<string | null>>();

function installHermesCandidates(): string[] {
  const out: string[] = [];
  const root = path.join(process.env.HOME || "", ".hermes", "installs");
  try {
    for (const id of fs.readdirSync(root)) {
      const envs = path.join(root, id, "environments");
      let gens: string[] = [];
      try { gens = fs.readdirSync(envs); } catch { continue; }
      // 新的 generation 排在后面；倒序拿最新的
      for (const g of gens.sort().reverse()) out.push(path.join(envs, g, "venv", "bin", "hermes"));
    }
  } catch { /* no installs dir — the candidates below still apply */ }
  return out;
}

function cliCandidates(t: CronTarget): string[] {
  const seen = new Set<string>();
  const list = [
    process.env.AGENTUS_HERMES_CLI || "",
    t.cmd,
    ...installHermesCandidates(),
    path.join(process.env.HOME || "", ".local", "bin", "hermes-dev"),
    "hermes",
  ];
  return list.filter((c) => c && !seen.has(c) && (seen.add(c), true));
}

function probeCli(cmd: string, home: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, ["cron", "list"], { timeout: 25_000, env: { ...process.env, HERMES_HOME: home }, maxBuffer: 1 << 20 },
      (err) => resolve(err ? null : cmd));
  });
}

/** 解析一次并按 home 缓存；并发点击共用同一个探测（否则五个按钮会各自 fork 一次 CLI）。 */
export async function resolveCli(t: CronTarget): Promise<string | null> {
  const hit = cliCache.get(t.home);
  if (hit) return hit;
  const pending = probes.get(t.home);
  if (pending) return pending;
  const p = (async () => {
    for (const cmd of cliCandidates(t)) {
      const ok = await probeCli(cmd, t.home);
      if (ok) { cliCache.set(t.home, ok); return ok; }
    }
    return null;
  })().finally(() => probes.delete(t.home));
  probes.set(t.home, p);
  return p;
}

/** 转发一次写操作。超时给 60 s：`remove`/`run` 都可能碰到 CLI 自己的锁等待。 */
export async function runCronVerb(t: CronTarget, verb: CronVerb, jobId: string, timeoutMs = 60_000): Promise<VerbResult> {
  const cli = await resolveCli(t);
  if (!cli) {
    return {
      ok: false, code: 127,
      out: `找不到能跑 \`hermes cron\` 的可执行文件（试过：${cliCandidates(t).join(" / ")}）。`
        + "这台机器上 PATH 的 hermes 可能缺依赖 —— 用 AGENTUS_HERMES_CLI 指定一个能用的二进制。",
    };
  }
  const args = ["cron", verb, jobId, ...(t.profile ? ["-p", t.profile] : [])];
  return new Promise((resolve) => {
    execFile(cli, args, {
      timeout: timeoutMs,
      env: { ...process.env, HERMES_HOME: t.home },
      maxBuffer: 1 << 20,
    }, (err, stdout, stderr) => {
      const out = `${String(stdout ?? "")}${String(stderr ?? "")}`.trim();
      if (!err) return resolve({ ok: true, out: out || `${verb} ${jobId}: ok`, code: 0 });
      const code = typeof (err as NodeJS.ErrnoException & { code?: number }).code === "number"
        ? Number((err as unknown as { code: number }).code)
        : 1;
      resolve({ ok: false, out: out || (err as Error).message, code });
    });
  });
}
