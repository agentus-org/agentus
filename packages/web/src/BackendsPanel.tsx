// Backend registry panel (M6) — "which hermes does a slot spawn?" as a table the operator owns.
//
// Why this exists: on this box "which hermes" is three independent choices that used to be
// frozen at server start:
//   1. which CODE  — the command, plus env such as PYTHONPATH at a source checkout
//                    (the box's default `hermes` is the installed Studio runtime);
//   2. which DATA  — HERMES_HOME: the live ~/.hermes (never by accident) or a disposable home;
//   3. which PROFILE — `hermes -p <profile>` inside that home.
// A row is that triple, and the new-slot dialog picks a row. The isolation guard
// (buildSpawnEnv) still runs per spawn, so a row can never smuggle the live home past it:
// the server reports such a row as `blocked` and the dialog refuses to launch it.
import { useCallback, useEffect, useState } from "react";
import { cockpit, type BackendInspect, type BackendInput, type BackendView } from "./state";

const EMPTY: BackendInput = {
  id: "", label: "", kind: "hermes", cmd: "hermes", args: "acp",
  env: "", home: "", profile: "", cwd: "", notes: "", allowLiveHome: false,
};

function argsToText(args?: string[] | string): string {
  if (Array.isArray(args)) return args.join(" ");
  return args ?? "";
}

function envToText(env?: Record<string, string> | string, keys?: string[]): string {
  if (typeof env === "string") return env;
  if (env && typeof env === "object") {
    return Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n");
  }
  // The list endpoint only echoes the NAMES it injects (values are not sent back), so edit
  // mode shows "KEY=" placeholders the operator can fill in (an untouched line is dropped).
  return (keys ?? []).map((k) => `${k}=`).join("\n");
}

function draftOf(row: BackendView): BackendInput {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    cmd: row.cmd,
    args: argsToText(row.args),
    env: envToText(undefined, row.env),
    home: row.home ?? "",
    profile: row.profile ?? "",
    cwd: row.cwd ?? "",
    notes: row.notes ?? "",
    allowLiveHome: Boolean(row.allowLiveHome),
  };
}

function Badge({ tone, children }: { tone: "warn" | "danger" | "dim" | "ok"; children: React.ReactNode }): JSX.Element {
  return <span className={`be-badge be-${tone}`}>{children}</span>;
}

const STATUS_LABEL: Record<string, string> = {
  online: "在线", offline: "不可用", missing: "找不到命令", unchecked: "未检测",
};
const KIND_LABEL: Record<string, string> = { startup: "启动检查", manual: "手动探测", session: "真实会话" };

function statusTone(status?: string): "ok" | "warn" | "danger" | "dim" {
  if (status === "online") return "ok";
  if (status === "offline") return "danger";
  if (status === "missing") return "warn";
  return "dim";
}

/** "刚刚 / 3 分钟前 / 2 小时前 / 4 天前" — a timestamp the operator can act on. */
function ago(ts?: number | null): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return "刚刚";
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}

/**
 * The row's persisted health. Three things have to be readable at a glance: the status, HOW HARD
 * the check looked (a startup sweep only resolves the command — it does not prove a slot starts),
 * and what to do when it failed (the code alone is a riddle).
 */
function HealthLine({ row }: { row: BackendView }): JSX.Element | null {
  const h = row.health;
  if (!h || !h.at) return null; // never checked
  const depth = h.kind ? KIND_LABEL[h.kind] ?? h.kind : "未知深度";
  return (
    <div className="be-health">
      <Badge tone={statusTone(h.status)}>{STATUS_LABEL[h.status] ?? h.status}</Badge>
      <span className="be-dim">
        上次检查 {ago(h.at)} · {depth}
        {h.latencyMs !== null && h.latencyMs !== undefined ? ` · ${h.latencyMs}ms` : ""}
        {h.lastSuccessAt ? ` · 上次成功 ${ago(h.lastSuccessAt)}` : ""}
      </span>
      {h.errorCode ? <code className="be-code">{h.errorCode}</code> : null}
      {h.errorCode && h.guidance ? <div className="be-guidance">{h.guidance}</div> : null}
    </div>
  );
}

/** What this backend advertised the last time a slot really started from it. */
function HandshakeLine({ row }: { row: BackendView }): JSX.Element | null {
  const hs = row.handshake;
  if (!hs) return null;
  const parts = [
    hs.modes ? `模式 ${hs.modes.available.length}` : null,
    hs.configOptions?.length ? `选项 ${hs.configOptions.length}` : null,
    hs.models ? `模型 ${hs.models.available.length}` : null,
    hs.commands?.length ? `命令 ${hs.commands.length}` : null,
    hs.loadSession === null || hs.loadSession === undefined ? null : `session/load ${hs.loadSession ? "有" : "无"}`,
  ].filter(Boolean) as string[];
  return (
    <div className="be-handshake">
      握手（上次真实会话）：<code>{parts.join(" · ") || "无可用信息"}</code>
      <span className="be-dim"> · {ago(hs.at)}</span>
    </div>
  );
}

export function BackendsPanel(): JSX.Element {
  const [rows, setRows] = useState<BackendView[]>([]);
  const [draft, setDraft] = useState<BackendInput | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // row id being edited (null = creating)
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [inspect, setInspect] = useState<{ id: string; data: BackendInspect } | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await cockpit.loadBackends());
      setErr("");
    } catch (e) {
      setErr(`后端列表拉取失败：${String((e as Error).message ?? e)}`);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const field = <K extends keyof BackendInput>(k: K, v: BackendInput[K]) =>
    setDraft((d) => ({ ...(d ?? EMPTY), [k]: v }));

  const save = async () => {
    if (!draft) return;
    setBusy("save"); setErr(""); setMsg("");
    try {
      if (editing) {
        const patch = { ...draft };
        delete (patch as { id?: string }).id; // the id is the key, not a patchable field
        await cockpit.updateBackend(editing, patch);
      } else {
        await cockpit.createBackend(draft);
      }
      setMsg(editing ? "已保存" : "已创建");
      setDraft(null); setEditing(null);
      await load();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy("");
    }
  };

  const remove = async (row: BackendView) => {
    if (!window.confirm(`删除后端 ${row.id}？（被会话引用的后端不能删）`)) return;
    setBusy(`del:${row.id}`); setErr(""); setMsg("");
    try {
      await cockpit.deleteBackend(row.id);
      setMsg(`已删除 ${row.id}`);
      if (editing === row.id) { setEditing(null); setDraft(null); }
      await load();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy("");
    }
  };

  const probe = async (row: BackendView) => {
    setBusy(`probe:${row.id}`); setErr(""); setMsg("");
    try {
      const data = await cockpit.inspectBackend(row.id);
      setInspect({ id: row.id, data });
      // the server persisted the verdict onto the row: re-read so the row line shows it too
      await load();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
      await load();
    } finally {
      setBusy("");
    }
  };

  return (
    <section className="set-card" id="set-backends" data-setgroup="agent">
      <h3>后端（用哪个 hermes）</h3>
      <p className="set-hint">
        一条后端 = <b>用哪个命令</b>（+ 额外环境变量，例如 <code>PYTHONPATH</code> 指向源码树）·
        <b> 哪个 HERMES_HOME</b> · <b>哪个 profile</b>（<code>-p</code>）。
        新建会话时按行选择，因此每个槽位可以各自隔离。指向 live <code>~/.hermes</code> 默认会被拒绝，
        除非在这一行显式勾选。
      </p>

      <div className="be-list">
        {rows.map((row) => (
          <div key={row.id} className={`be-row ${row.blocked ? "blocked" : ""}`}>
            <div className="be-row-main">
              <div className="be-row-title">
                <b>{row.label}</b> <code>{row.id}</code>
                {row.builtin ? <Badge tone="dim">内置</Badge> : null}
                {row.health?.at ? (
                  <Badge tone={statusTone(row.health.status)}>{STATUS_LABEL[row.health.status] ?? row.health.status}</Badge>
                ) : null}
                {row.allowLiveHome ? <Badge tone="danger">live home</Badge> : null}
                {row.blocked ? <Badge tone="warn">被隔离规则拦住</Badge> : null}
              </div>
              <div className="be-row-sub">
                <code>{row.cmd} {(row.args ?? []).join(" ")}</code>
                {row.profile ? <> · profile <code>{row.profile}</code></> : null}
                {row.home ? <> · home <code>{row.home}</code></> : null}
                {(row.env ?? []).length ? <> · env <code>{(row.env ?? []).join(", ")}</code></> : null}
              </div>
              {row.notes ? <div className="be-row-note">{row.notes}</div> : null}
              {row.blocked ? <div className="set-err">{row.blocked}</div> : null}
              {(row.warnings ?? []).map((w, i) => <div key={i} className="hint-warn">{w}</div>)}
              <HealthLine row={row} />
              <HandshakeLine row={row} />
            </div>
            <div className="be-row-actions">
              <button className="set-mini" onClick={() => void probe(row)} disabled={busy === `probe:${row.id}`}>
                {busy === `probe:${row.id}` ? "探测中…" : "探测"}
              </button>
              <button className="set-mini" onClick={() => { setEditing(row.id); setDraft(draftOf(row)); setMsg(""); }}>
                编辑
              </button>
              <button
                className="set-mini"
                onClick={() => {
                  setEditing(null);
                  setDraft({ ...draftOf(row), id: `${row.id}-copy`, label: `${row.label} copy` });
                  setMsg("复制为新行：确认 id 后保存");
                }}
              >
                复制
              </button>
              <button className="set-mini" onClick={() => void remove(row)} disabled={busy === `del:${row.id}`}>
                删除
              </button>
            </div>
          </div>
        ))}
        {!rows.length ? <p className="set-hint">还没有后端行。</p> : null}
      </div>

      {inspect ? (
        <div className="be-inspect">
          <div className="be-inspect-head">
            <b>探测结果：{inspect.id}</b>
            <button className="set-mini" onClick={() => setInspect(null)}>收起</button>
          </div>
          <ul>
            <li>
              判定: <Badge tone={statusTone(inspect.data.status)}>{STATUS_LABEL[inspect.data.status] ?? inspect.data.status}</Badge>
              {inspect.data.errorCode ? <> <code className="be-code">{inspect.data.errorCode}</code></> : null}
              <span className="be-dim"> · 用时 {inspect.data.latencyMs}ms</span>
              {inspect.data.guidance ? <div className="be-guidance">{inspect.data.guidance}</div> : null}
            </li>
            <li>命令: <code>{inspect.data.cmd}</code>{inspect.data.resolved ? <> → <code>{inspect.data.resolved}</code></> : <> <span className="be-danger">找不到</span></>}</li>
            <li>argv: <code>{(inspect.data.args ?? []).join(" ")}</code>{inspect.data.profile ? <>（profile <code>{inspect.data.profile}</code>）</> : null}</li>
            <li>版本: <code>{inspect.data.version ?? "—"}</code></li>
            <li>
              代码树（它真正加载的那份）: <code>{inspect.data.installDir ?? "—"}</code>
            </li>
            <li>
              home: <code>{inspect.data.home ?? "—"}</code>
              {inspect.data.homeExists
                ? <>（存在，{inspect.data.homeEntries} 项{inspect.data.stateDb ? `，state.db ${(inspect.data.stateDb.bytes / 1024).toFixed(0)}KB` : "，无 state.db"}）</>
                : <>（<span className="be-danger">不存在</span>，首次启动会创建）</>}
            </li>
            {inspect.data.acpCheck ? (
              <li>
                acp --check: {inspect.data.acpCheck.ok ? "OK" : <span className="be-danger">失败</span>}
                {" "}<span className="be-dim">（过了也不代表能起会话：检查在适配器的 server 模块导入之前就返回了）</span>
                <div className="be-inspect-out">{inspect.data.acpCheck.output}</div>
              </li>
            ) : null}
            {inspect.data.blocked ? <li className="be-danger">被拦住：{inspect.data.blocked}</li> : null}
            {inspect.data.error ? <li className="be-danger">{inspect.data.error}</li> : null}
            {(inspect.data.warnings ?? []).map((w, i) => <li key={i} className="hint-warn">{w}</li>)}
          </ul>
        </div>
      ) : null}

      {draft ? (
        <div className="be-editor">
          <div className="set-row">
            <label>id</label>
            <input
              className="set-input" value={draft.id ?? ""} spellCheck={false}
              disabled={Boolean(editing)} placeholder="hermes-fork"
              onChange={(e) => field("id", e.target.value.trim())}
            />
          </div>
          <div className="set-row">
            <label>名称</label>
            <input className="set-input" value={draft.label ?? ""} onChange={(e) => field("label", e.target.value)} placeholder="Hermes（源码树）" />
          </div>
          <div className="set-row">
            <label>类型</label>
            <select className="set-select" value={draft.kind ?? "hermes"} onChange={(e) => field("kind", e.target.value)}>
              <option value="hermes">hermes（ACP + home 隔离）</option>
              <option value="qoder">qoder</option>
              <option value="mock">mock（QA）</option>
            </select>
          </div>
          <div className="set-row">
            <label>命令</label>
            <input className="set-input" value={draft.cmd ?? ""} spellCheck={false} onChange={(e) => field("cmd", e.target.value)} placeholder="hermes 或 /path/to/hermes-dev" />
          </div>
          <div className="set-row">
            <label>参数</label>
            <input className="set-input" value={argsToText(draft.args)} spellCheck={false} onChange={(e) => field("args", e.target.value)} placeholder="acp" />
          </div>
          <div className="set-row">
            <label>HERMES_HOME</label>
            <input className="set-input" value={draft.home ?? ""} spellCheck={false} onChange={(e) => field("home", e.target.value)} placeholder="~/.agentslot-test/home" />
          </div>
          <div className="set-row">
            <label>profile</label>
            <input className="set-input" value={draft.profile ?? ""} spellCheck={false} onChange={(e) => field("profile", e.target.value)} placeholder="留空 = 该 home 的默认 profile" />
          </div>
          <div className="set-row">
            <label>额外环境</label>
            <textarea
              className="set-textarea" value={typeof draft.env === "string" ? draft.env : ""} spellCheck={false}
              placeholder={"每行 KEY=VALUE，例如\nPYTHONPATH=/Users/liang/Project/hermes-agent"}
              onChange={(e) => field("env", e.target.value)}
            />
          </div>
          <div className="set-row">
            <label>默认工作目录</label>
            <input className="set-input" value={draft.cwd ?? ""} spellCheck={false} onChange={(e) => field("cwd", e.target.value)} placeholder="留空 = 新建会话时再选" />
          </div>
          <div className="set-row">
            <label>备注</label>
            <input className="set-input" value={draft.notes ?? ""} onChange={(e) => field("notes", e.target.value)} />
          </div>
          <div className="set-row">
            <label>live home</label>
            <label className="set-check">
              <input type="checkbox" checked={Boolean(draft.allowLiveHome)} onChange={(e) => field("allowLiveHome", e.target.checked)} />
              允许这一行直接驱动 live <code>~/.hermes</code>（危险：与运行时同开一个 state.db）
            </label>
          </div>
          <div className="row">
            <button className="set-mini" onClick={() => { setDraft(null); setEditing(null); }}>取消</button>
            <button className="set-save" onClick={() => void save()} disabled={busy === "save" || !(draft.id || "").trim()}>
              {busy === "save" ? "保存中…" : editing ? "保存" : "创建"}
            </button>
          </div>
        </div>
      ) : (
        <div className="row">
          <button className="set-mini" onClick={() => { setEditing(null); setDraft({ ...EMPTY }); setMsg(""); }}>
            新建后端
          </button>
          <button className="set-mini" onClick={() => void load()}>刷新</button>
        </div>
      )}

      {msg ? <span className="set-toast">{msg}</span> : null}
      {err ? <div className="set-err" role="alert">{err}</div> : null}
    </section>
  );
}
