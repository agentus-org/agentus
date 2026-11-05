/**
 * 定时作业面板（issue #92）。
 *
 * 这里**没有调度逻辑**：作业、执行历史、失败账本全部来自 Hermes（`/api/cron` 读 `jobs.json` 与
 * `executions.db`），四个动作（暂停/恢复/立即运行/删除）也只是把 `hermes cron <verb>` 转发出去。
 * 所以这一层做的是三件事：把 Hermes 的字段说人话、把「能不能点」画对、把 CLI 的回执原样贴出来。
 *
 * 面板只在 hermes home 有 cron 目录时出现；`available:false` 是正常降级（不是错误页）。
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { CronIncident, CronJob, CronRun, CronView } from "../../shared/src/index.js";
import { IconClose, IconPlay, IconRefresh, IconTrash } from "./Icons";

const shortAgo = (iso?: string | null): string => {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const d = Date.now() - t;
  if (d < 0) return `in ${Math.round(-d / 60000)} min`;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.round(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)} h ago`;
  return `${Math.round(d / 86_400_000)} d ago`;
};
const whenLocal = (iso?: string | null): string => {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 状态色的三个桶：跑得正常 / 被暂停 / 出过事。字面值直接来自 Hermes，不在这里翻译成别的词。 */
const tone = (job: CronJob): "ok" | "idle" | "bad" => {
  if (job.state === "paused" || job.enabled === false) return "idle";
  if ((job.failureStreak ?? 0) > 0 || (job.lastStatus && job.lastStatus !== "ok")) return "bad";
  return "ok";
};

const repeatText = (j: CronJob): string => {
  const r = j.repeat;
  if (!r) return "—";
  if (r.times === null) return `∞ · ${r.completed} 次`;
  return `${r.completed}/${r.times}`;
};

/** 面板默认管「第一个 hermes 后端行」的 cron；`?cronBackend=<row id>` 可以把这块视图钉到另一个
 *  后端（QA 用临时 home，操作者多 profile 时也能直接切）—— 凭它就不用为了看另一个 profile
 *  先把别的行删掉。 */
const BACKEND = (() => {
  try { return new URLSearchParams(window.location.search).get("cronBackend") ?? ""; } catch { return ""; }
})();
const withBackend = (path: string): string => (BACKEND ? `${path}${path.includes("?") ? "&" : "?"}backend=${encodeURIComponent(BACKEND)}` : path);

export function CronPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const [view, setView] = useState<CronView | null>(null);
  const [runs, setRuns] = useState<CronRun[]>([]);
  const [incidents, setIncidents] = useState<CronIncident[]>([]);
  const [err, setErr] = useState("");
  const [ack, setAck] = useState("");
  const [busy, setBusy] = useState("");
  /** 展开的作业 id：一次只看一个，避免面板被五段 prompt 撑爆 */
  const [open, setOpen] = useState("");
  /** 执行历史按作业过滤；空串 = 全部 */
  const [runJob, setRunJob] = useState("");

  const load = useCallback(async (): Promise<void> => {
    try {
      const jr = await fetch(withBackend("/api/cron"), { credentials: "same-origin" });
      if (!jr.ok) throw new Error(`HTTP ${jr.status}`);
      const next = (await jr.json()) as CronView;
      setView(next);
      setErr("");
      if (next.available) {
        const [rr, ir] = await Promise.all([
          fetch(withBackend(`/api/cron/runs?limit=40${runJob ? `&job=${encodeURIComponent(runJob)}` : ""}`), { credentials: "same-origin" }),
          fetch(withBackend("/api/cron/incidents"), { credentials: "same-origin" }),
        ]);
        setRuns(((await rr.json()) as { runs?: CronRun[] }).runs ?? []);
        setIncidents(((await ir.json()) as { incidents?: CronIncident[] }).incidents ?? []);
      }
    } catch (e) {
      setErr(`读不到定时任务：${String((e as Error)?.message ?? e)}`);
    }
  }, [runJob]);

  useEffect(() => { void load(); }, [load]);

  const act = async (id: string, verb: "pause" | "resume" | "run" | "remove"): Promise<void> => {
    if (verb === "remove" && !window.confirm("删除这个定时作业？Hermes 侧会一起删掉它的执行历史引用。")) return;
    setBusy(`${verb}:${id}`);
    setAck("");
    try {
      const r = await fetch(withBackend(`/api/cron/${encodeURIComponent(id)}/${verb}`), {
        method: "POST", credentials: "same-origin",
      });
      const body = (await r.json()) as { ok?: boolean; out?: string; error?: string };
      setAck(`${verb} ${id} → ${body.out ?? body.error ?? (r.ok ? "ok" : `HTTP ${r.status}`)}`);
      await load();
    } catch (e) {
      setAck(`${verb} ${id} → ${String((e as Error)?.message ?? e)}`);
    } finally {
      setBusy("");
    }
  };

  const jobs = view?.jobs ?? [];
  const incidentsOpen = useMemo(() => incidents.filter((i) => i.state !== "closed").length, [incidents]);

  return (
    <section className="cron-panel" data-cron-panel aria-label="定时任务">
      <header className="cron-head">
        <strong>定时任务</strong>
        {view?.available ? (
          <span className="cron-sub" data-cron-source title={view.cronDir}>
            {view.profile ? `profile ${view.profile}` : "hermes"} · {jobs.length} 个作业
            {view.updatedAt ? ` · 更新于 ${shortAgo(view.updatedAt)}` : ""}
          </span>
        ) : null}
        <span className="cron-spacer" />
        {runJob ? (
          <button type="button" className="icon-btn" onClick={() => setRunJob("")}>全部作业</button>
        ) : null}
        <button type="button" className="icon-btn" title="刷新" aria-label="刷新定时任务" onClick={() => void load()}>
          <IconRefresh size={14} />
        </button>
        <button type="button" className="icon-btn" title="关闭（Esc）" aria-label="关闭定时任务" onClick={onClose}>
          <IconClose size={15} />
        </button>
      </header>

      {err ? <p className="cron-error" role="alert">{err}</p> : null}
      {ack ? <p className="cron-ack" data-cron-ack>{ack}</p> : null}

      {view && !view.available ? (
        // 优雅降级：这个 home 没有 cron（或 hermes 不可达）时，面板说清为什么，而不是画一张空表。
        <div className="cron-empty" data-cron-unavailable>
          <p>这里没有可管理的定时任务。</p>
          <p className="cron-why">{view.why}</p>
        </div>
      ) : null}

      {view?.available ? (
        <div className="cron-body">
          <table className="cron-table" data-cron-table>
            <thead>
              <tr>
                <th>作业</th><th>调度</th><th>状态</th><th>下次</th><th>上次</th><th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => {
                const t = tone(j);
                const paused = j.state === "paused" || j.enabled === false;
                return (
                  <Fragment key={j.id}>
                    <tr className={`cron-row ${open === j.id ? " open" : ""}`} data-cron-job={j.id} data-tone={t}>
                      <td>
                        <button type="button" className="cron-name" onClick={() => setOpen(open === j.id ? "" : j.id)}
                          title={j.prompt ?? j.name}>
                          <span className={`cron-dot ${t}`} aria-hidden />
                          {j.name}
                        </button>
                        <span className="cron-id">{j.id}</span>
                      </td>
                      <td title={j.scheduleKind ?? undefined}>
                        <code>{j.scheduleDisplay || j.schedule || "—"}</code>
                      </td>
                      <td><span className={`cron-state ${t}`}>{j.state}</span></td>
                      <td>{whenLocal(j.nextRunAt)}</td>
                      <td>
                        {j.lastStatus ?? "—"}
                        <span className="cron-ago">{shortAgo(j.lastRunAt)}</span>
                      </td>
                      <td className="cron-acts">
                        <button
                          type="button" className="icon-btn" title={paused ? "恢复" : "暂停"}
                          aria-label={`${paused ? "恢复" : "暂停"} ${j.name}`}
                          disabled={busy === `pause:${j.id}` || busy === `resume:${j.id}`}
                          onClick={() => void act(j.id, paused ? "resume" : "pause")}
                        >{paused ? "▶" : "❚❚"}</button>
                        <button
                          type="button" className="icon-btn" title="立即运行（排到下一个 tick）"
                          aria-label={`立即运行 ${j.name}`}
                          disabled={busy === `run:${j.id}`}
                          onClick={() => void act(j.id, "run")}
                        ><IconPlay size={13} /></button>
                        <button
                          type="button" className="icon-btn" title="删除"
                          aria-label={`删除 ${j.name}`}
                          disabled={busy === `remove:${j.id}`}
                          onClick={() => void act(j.id, "remove")}
                        ><IconTrash size={13} /></button>
                      </td>
                    </tr>
                    {open === j.id ? (
                      <tr className="cron-detail-row">
                        <td colSpan={6}>
                          <div className="cron-detail" data-cron-detail={j.id}>
                            <dl>
                              <dt>调度</dt><dd><code>{j.scheduleKind ?? ""} {j.schedule}</code></dd>
                              <dt>重复</dt><dd>{repeatText(j)}</dd>
                              <dt>投递</dt><dd>{j.deliver || "—"}</dd>
                              <dt>模型</dt><dd>{j.model ? `${j.provider ?? ""}/${j.model}` : j.noAgent ? "no-agent（脚本直出）" : "—"}</dd>
                              {j.script ? (<><dt>脚本</dt><dd><code>{j.script}</code></dd></>) : null}
                              {j.workdir ? (<><dt>目录</dt><dd><code>{j.workdir}</code></dd></>) : null}
                              <dt>创建</dt><dd>{whenLocal(j.createdAt)}</dd>
                              {j.pausedReason ? (<><dt>暂停原因</dt><dd>{j.pausedReason}</dd></>) : null}
                              {j.lastError ? (<><dt>上次错误</dt><dd className="cron-err">{j.lastError}</dd></>) : null}
                            </dl>
                            {j.prompt ? (
                              <details className="cron-prompt">
                                <summary>指令（{j.prompt.length} 字）</summary>
                                <pre>{j.prompt}</pre>
                              </details>
                            ) : null}
                            <button type="button" className="icon-btn" onClick={() => { setRunJob(j.id); void load(); }}>
                              只看这个作业的执行历史
                            </button>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {!jobs.length ? <p className="cron-empty">这个 profile 下还没有定时作业。</p> : null}

          <section className="cron-block" data-cron-runs>
            <h4>
              执行历史
              {runJob ? <span className="cron-sub"> · {runJob}</span> : null}
              <span className="cron-sub"> · 最近 {runs.length} 条</span>
            </h4>
            {runs.length ? (
              <ul className="cron-runs">
                {runs.map((r) => (
                  <li key={r.id} className={r.status === "completed" ? "ok" : "bad"} data-cron-run={r.id}>
                    <code>{r.jobId}</code>
                    <span className="cron-run-status">{r.status}</span>
                    <span>{whenLocal(r.startedAt)}</span>
                    <span className="cron-ago">
                      {r.finishedAt && r.startedAt
                        ? `${Math.max(0, Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000))}s`
                        : ""}
                    </span>
                    {r.error ? <span className="cron-err" title={r.error}>{r.error.slice(0, 80)}</span> : null}
                  </li>
                ))}
              </ul>
            ) : <p className="cron-empty">还没有执行记录。</p>}
          </section>

          <section className="cron-block" data-cron-incidents>
            <h4>
              失败账本
              <span className="cron-sub"> · {incidents.length} 条{incidentsOpen ? `（${incidentsOpen} 条未关闭）` : ""}</span>
            </h4>
            {incidents.length ? (
              <ul className="cron-incidents">
                {incidents.slice(0, 20).map((i) => (
                  <li key={i.id} className={i.state === "closed" || i.state === "resolved" ? "ok" : "bad"} data-cron-incident={i.id}>
                    <code>{i.jobId}</code>
                    <span className="cron-run-status">{i.state}</span>
                    <span>{i.failureType ?? "—"}</span>
                    <span className="cron-ago">{shortAgo(i.lastSeenAt)}</span>
                    {i.error ? <span className="cron-err" title={i.error}>{i.error.slice(0, 80)}</span> : null}
                  </li>
                ))}
              </ul>
            ) : <p className="cron-empty">没有失败记录。</p>}
          </section>
        </div>
      ) : null}
    </section>
  );
}
