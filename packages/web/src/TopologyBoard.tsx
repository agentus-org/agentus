/**
 * 会话拓扑面板 —— 「每个工作空间有哪些会话，谁把活交给了谁」。
 *
 * 三件刻意的事：
 *
 *  · **它是视图，不是第二个控制面**（红线 1）。它读 `/api/topology`，派活走已有的
 *    `/api/bridge`（同一份信封、同一条「等回合真的开起来才算数」的失败路径）。这里不发明
 *    第二条投递协议，也不做摘要、不做判断。
 *  · **所有会话都画，关系是叠加层**。实测 7 天窗口只有 2 条派活边，只画有边的树会是一片空地；
 *    卡片墙 + 边才是今天的真实形状（见 tasks/20261103-agentus-session-topology）。
 *  · **点卡片开的是真会话页**（悬浮窗），不是只读预览：操作者点开就要能用——发消息、看工具、
 *    审批、换模型。窗口由 `App.tsx` 渲染（它才拿得到 `<Main>`），这里只上报「打开了谁」。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { TopologyView } from "../../shared/src/index.js";
import { cockpit } from "./state";
import { IconClose, IconFork, IconPlus, IconRefresh, IconSearch, IconSend } from "./Icons";
import {
  CARD_H, CARD_W, GAP_X, GROUP_HEAD, edgeLabel, filterTopology, layoutTopology, statusLabel, windowSince,
  type TopoWindow,
} from "./topology-layout";

/** 派活的目标：一个已有会话，或者在这个工作空间里新建一个。 */
type DispatchTarget = { kind: "session"; id: string; title: string } | { kind: "new"; workspace: string };

interface Props {
  /** 关掉面板，回到普通会话页。 */
  onClose: () => void;
  /** 打开某个会话的悬浮窗（App 负责渲染真正的会话页）。 */
  onOpen: (id: string) => void;
  /** 当前已经开着的窗口（卡片上标「已打开」）。 */
  openId?: string | null;
}

const WINDOWS: { key: TopoWindow; label: string }[] = [
  { key: "1d", label: "24 小时" },
  { key: "3d", label: "3 天" },
  { key: "7d", label: "7 天" },
  { key: "all", label: "全部" },
];

/** 窄屏（≤720px）：卡片改成单列。和侧栏/面板同一条断点。 */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState<boolean>(() => window.matchMedia("(max-width: 720px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 720px)");
    const on = (): void => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

function shortAgo(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return "刚刚";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  return `${Math.floor(d / 86_400_000)} 天前`;
}

export function TopologyBoard({ onClose, onOpen, openId }: Props): JSX.Element {
  const snap = useSyncExternalStore(cockpit.subscribe, cockpit.getSnapshot);
  const [win, setWin] = useState<TopoWindow>("3d");
  const [archived, setArchived] = useState(false);
  const [onlyLinked, setOnlyLinked] = useState(false);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<TopologyView | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<DispatchTarget | null>(null);
  const [text, setText] = useState("");
  const [ack, setAck] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const [canvasW, setCanvasW] = useState(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCanvasW(el.clientWidth));
    ro.observe(el);
    setCanvasW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const load = useCallback(async (w: TopoWindow, withArchived: boolean): Promise<void> => {
    try {
      const since = windowSince(w);
      const r = await fetch(`/api/topology?since=${since}&archived=${withArchived ? 1 : 0}`, { credentials: "same-origin" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setView((await r.json()) as TopologyView);
      setErr("");
    } catch (e) {
      setErr(`读不到拓扑：${String((e as Error)?.message ?? e)}`);
    }
  }, []);

  useEffect(() => { void load(win, archived); }, [load, win, archived]);

  // 实时：会话帧一到就重取。刻意用 1.5 s 去抖，而不是把每次 message 都变成一个请求 ——
  // 一个回合能推几百帧，面板要的是「大致现在」，不是逐帧精确。
  const version = snap.version;
  useEffect(() => {
    const t = window.setTimeout(() => void load(win, archived), 1500);
    return () => window.clearTimeout(t);
  }, [version, load, win, archived]);

  const filtered = useMemo(
    () => (view ? filterTopology(view, { query, onlyLinked, hideArchived: false }) : { nodes: [], edges: [] }),
    [view, query, onlyLinked],
  );
  // 列数由画布**真实宽度**决定，不是写死 4：写死的时候第四张卡会被窗口右缘切掉（量过一次：
  // 1280 视口下 4×232 + 3×18 = 1000px 装得下，含目录栏剩 1012 — 但那是巧合，换个屏就不成立）。
  const narrow = useNarrow();
  const cols = useMemo(() => {
    if (narrow) return 1;
    const inner = Math.max(0, canvasW - 32);            // .topo-canvas 两侧 padding
    return Math.max(1, Math.floor((inner + GAP_X) / (CARD_W + GAP_X)));
  }, [narrow, canvasW]);
  const layout = useMemo(
    () => layoutTopology(filtered.nodes, filtered.edges, { cols }),
    [filtered, cols],
  );
  // 每张卡的关系数取自**被画出来的那批边**（过窗口、过筛子之后），所以「派给 3」和图上 3 条线永远对得上。
  const degree = useMemo(() => {
    const out = new Map<string, number>();
    const inn = new Map<string, number>();
    for (const e of filtered.edges) {
      out.set(e.from, (out.get(e.from) ?? 0) + 1);
      inn.set(e.to, (inn.get(e.to) ?? 0) + 1);
    }
    return { out, inn };
  }, [filtered.edges]);

  // 发起方 = 操作者正待着的那个会话。派活的意义就在「从这儿派到那儿」，所以它必须是真的。
  const sourceId = snap.activeId ?? null;
  const sourceTitle = (sourceId ? cockpit.byId.get(sourceId)?.info.title : "") ?? "";

  const send = async (): Promise<void> => {
    if (!target || !sourceId || !text.trim()) return;
    setBusy(true);
    setErr("");
    setAck("");
    try {
      const body = {
        from: sourceId,
        text: text.trim(),
        to: target.kind === "session" ? { kind: "session", id: target.id } : { kind: "new", workspace: target.workspace },
      };
      const r = await fetch("/api/bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
      const j = (await r.json()) as { id?: string; created?: boolean; error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setAck(j.created ? "已在这个工作空间建了新会话并派出" : "已派出");
      setText("");
      setTarget(null);
      await load(win, archived);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const counts = `${filtered.nodes.length} 个会话 · ${filtered.edges.length} 条关系`;

  return (
    <section className="topo" data-topo-board aria-label="会话拓扑">
      <header className="topo-head">
        <IconFork size={16} />
        <h1>会话拓扑</h1>
        <span className="topo-count" data-topo-count>{counts}</span>
        {layout.edges.length ? (
          <div className="topo-legend" aria-hidden="true">
            <span><i className="sw dispatch" />派活</span>
            <span><i className="sw handoff" />转交</span>
            <span><i className="sw spawn" />新建</span>
          </div>
        ) : null}
        <span className="topo-spacer" />
        <div className="topo-windows" role="group" aria-label="时间窗">
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              type="button"
              className={`topo-wbtn ${win === w.key ? "on" : ""}`}
              aria-pressed={win === w.key}
              data-topo-window={w.key}
              onClick={() => setWin(w.key)}
            >{w.label}</button>
          ))}
        </div>
        <label className="topo-check">
          <input type="checkbox" checked={onlyLinked} onChange={(e) => setOnlyLinked(e.target.checked)} data-topo-only-linked />
          只看有关系的
        </label>
        <label className="topo-check">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} data-topo-archived />
          含已归档
        </label>
        <label className="topo-search">
          <IconSearch size={13} />
          <input
            type="search"
            placeholder="搜索会话 / 工作空间"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-topo-search
          />
        </label>
        <button type="button" className="icon-btn" title="刷新" aria-label="刷新拓扑" onClick={() => void load(win, archived)}>
          <IconRefresh size={14} />
        </button>
        <button type="button" className="icon-btn" title="关闭拓扑" aria-label="关闭拓扑" onClick={onClose} data-topo-close>
          <IconClose size={15} />
        </button>
      </header>

      {err ? <p className="topo-error" role="alert">{err}</p> : null}

      <div className="topo-canvas" ref={scroller} data-topo-canvas>
        {!view ? (
          <p className="topo-empty">正在读拓扑…</p>
        ) : !filtered.nodes.length ? (
          <p className="topo-empty">
            这个时间窗里没有会话。{query ? "（试着清掉搜索词）" : "（换个时间窗，或勾上「含已归档」）"}
          </p>
        ) : (
          <div className="topo-sheet" style={{ width: layout.width, height: layout.height }} data-topo-sheet>
            <svg className="topo-lines" width={layout.width} height={layout.height} aria-hidden="true">
              {layout.edges.map((e) => (
                <g key={`${e.from}-${e.to}-${e.kind}`} data-topo-edge={e.kind} data-live={e.live ? "1" : "0"}>
                  <path
                    className={`topo-line ${e.kind} ${e.live ? "live" : ""}`}
                    d={`M${e.x1},${e.y1} C${e.x1},${(e.y1 + e.y2) / 2} ${e.x2},${(e.y1 + e.y2) / 2} ${e.x2},${e.y2}`}
                  />
                  <circle className={`topo-line-dot ${e.live ? "live" : ""}`} cx={e.x2} cy={e.y2} r={2.5} />
                  <text className="topo-line-n" x={(e.x1 + e.x2) / 2} y={(e.y1 + e.y2) / 2}>
                    {e.n > 1 ? `×${e.n}` : ""}
                  </text>
                  <title>{`${edgeLabel(e.kind, e.n)}${e.live ? " · 正在跑" : ""}`}</title>
                </g>
              ))}
            </svg>
            {layout.groups.map((g) => (
              <section
                key={g.workspace || "(unknown)"}
                className="topo-group"
                data-topo-group={g.label}
                style={{ left: g.x, top: g.y, width: g.w, height: g.h }}
              >
                <header className="topo-group-head">
                  <span className="topo-group-name" title={g.workspace}>{g.label}</span>
                  <span className="topo-group-meta">{g.nodes.length} 会话{g.links ? ` · ${g.links} 条关系` : ""}</span>
                  <button
                    type="button"
                    className="topo-group-add"
                    title="在这个工作空间新建一个会话并派活"
                    aria-label={`在 ${g.label} 里新建会话并派活`}
                    data-topo-dispatch-new={g.label}
                    onClick={() => { setTarget({ kind: "new", workspace: g.workspace }); setAck(""); }}
                  ><IconPlus size={12} />派活</button>
                </header>
                <div className="topo-cards">
                  {g.nodes.map((p) => {
                    const n = p.node;
                    const st = statusLabel(n);
                    return (
                      <div
                        key={n.id}
                        className={`topo-card ${openId === n.id ? "open" : ""} ${n.archived ? "archived" : ""}`}
                        style={{ left: p.x, top: p.y - g.y - GROUP_HEAD, width: CARD_W, height: CARD_H }}
                        data-topo-node={n.id}
                        data-status={st.tone}
                        data-depth={p.depth}
                      >
                        <button
                          type="button"
                          className="topo-card-main"
                          title={`${n.title}\n${n.workspace}\n${st.text} · ${shortAgo(n.lastAt)}`}
                          onClick={() => onOpen(n.id)}
                        >
                          <span className={`topo-dot ${st.tone}`} aria-hidden />
                          <span className="topo-title">
                            {n.role === "main" ? "★ " : ""}{n.title || "(未命名)"}
                          </span>
                          <span className="topo-meta">
                            <span className={`topo-status ${st.tone}`}>{st.text}</span>
                            <span>{n.backend}</span>
                            {n.plan?.total ? <span className="topo-plan">{n.plan.done}/{n.plan.total}</span> : null}
                            <span className="topo-ago">{shortAgo(n.lastAt)}</span>
                          </span>
                          <span className="topo-sub">
                            {n.id.slice(0, 8)}
                            {degree.out.get(n.id) ? ` · 派给 ${degree.out.get(n.id)}` : ""}
                            {degree.inn.get(n.id) ? ` · 派自 ${degree.inn.get(n.id)}` : ""}
                            {n.waitingOn?.length ? ` · 等 ${n.waitingOn.length} 个回报` : ""}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="topo-card-act"
                          title="派活给这个会话"
                          aria-label={`派活给 ${n.title}`}
                          data-topo-dispatch={n.id}
                          onClick={(e) => { e.stopPropagation(); setAck(""); setTarget({ kind: "session", id: n.id, title: n.title }); }}
                        ><IconSend size={12} /></button>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      {target ? (
        <aside className="topo-dispatch" data-topo-dispatch-panel>
          <header>
            <strong>
              {target.kind === "session" ? "派活" : "新会话 + 派活"}
            </strong>
            <button type="button" className="icon-btn" aria-label="取消派活" onClick={() => { setTarget(null); setText(""); }}>
              <IconClose size={13} />
            </button>
          </header>
          <p className="topo-target" title={target.kind === "session" ? target.title : target.workspace}>
            → {target.kind === "session" ? target.title : `新会话 @ ${target.workspace.split("/").filter(Boolean).pop() ?? target.workspace}`}
          </p>
          {sourceId ? (
            <p className="topo-source" title={sourceCwd(sourceId)}>来自「{sourceTitle || sourceId.slice(0, 8)}」</p>
          ) : (
            <p className="topo-source warn">左边先选一个会话当发起方 —— 派活要有一个「从哪儿派出去」。</p>
          )}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="一句话说清要它干什么（它会带着你的原话和被派方的身份开始）"
            rows={4}
            data-topo-dispatch-text
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); }
            }}
          />
          <div className="topo-dispatch-foot">
            <span className="hint">⌘↵ 送出</span>
            <button
              type="button"
              className="topo-send"
              disabled={!sourceId || !text.trim() || busy}
              onClick={() => void send()}
              data-topo-dispatch-send
            >{busy ? "派出中…" : "派过去"}</button>
          </div>
          {ack ? <p className="topo-ack" role="status">{ack}</p> : null}
          {err ? <p className="topo-error" role="alert">{err}</p> : null}
        </aside>
      ) : ack ? (
        <p className="topo-toast" role="status">{ack}</p>
      ) : null}
    </section>
  );
}

/** 发起方的工作空间（悬停时说明「这句话从哪个目录过去」）。 */
function sourceCwd(id: string): string {
  const v = cockpit.byId.get(id);
  return v ? (v.info.workspace || v.info.cwd) : "";
}
