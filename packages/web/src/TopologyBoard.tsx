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
import { IconChevronDown, IconChevronRight, IconClose, IconFork, IconPlus, IconRefresh, IconSearch, IconSend } from "./Icons";
import {
  CARD_H, CARD_W, GAP_X, edgeLabel, filterTopology, layoutTopology, statusLabel, windowSince,
  type PlacedNode, type TopoWindow,
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

/** 拖动摆位：会话 id → 画布坐标。存在本机 —— 位置是这个人看图的手感，不是团队数据。 */
const POS_KEY = "agentus.topo.pos";
/** 折叠分区：workspace 路径数组。null = 从没动过，走「只展开当前会话那一组」的默认。 */
const COLLAPSE_KEY = "agentus.topo.collapsed";

function readPos(): Record<string, { x: number; y: number }> {
  try {
    const v = JSON.parse(localStorage.getItem(POS_KEY) || "{}") as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, { x: number; y: number }> = {};
    for (const [k, p] of Object.entries(v as Record<string, unknown>)) {
      const q = p as { x?: unknown; y?: unknown };
      if (typeof q?.x === "number" && typeof q?.y === "number" && Number.isFinite(q.x) && Number.isFinite(q.y)) {
        out[k] = { x: q.x, y: q.y };
      }
    }
    return out;
  } catch { return {}; }
}

function readCollapsed(): string[] | null {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    if (raw === null) return null;
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  } catch { return null; }
}

/** 手机上组头的高度：手指的命中区（44px），桌面沿用布局默认的 34px。 */
const MOBILE_GROUP_HEAD = 44;

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
  /* Esc 在拓扑里是三层的：派活面板 → 会话浮窗 → 拓扑本身。App 的两层已经有了，面板这一层原先
     漏了 —— 开着面板按 Esc 会连着整个拓扑一起退出去，框里写了一半的活也就跟着没了。
     `useEscape` 的判据是「`!e.defaultPrevented` 才关」，所以这里 preventDefault 就够，不必把
     状态提到 App 去。但**必须走捕获阶段**：App 的 useEscape 在拓扑打开那一刻就注册了，比这个
     （面板打开才注册）早，同一阶段里它会先跑 —— 那样 Esc 还是整个退出拓扑。 */
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      setTarget(null);
      setText("");
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [target]);

  const [ack, setAck] = useState("");
  /* 折叠（issue #95）：默认**只展开当前会话所在的分区**，其余收成一行。14 个会话铺开时，
     问题不是卡片画得不好，是一次要看的太多 —— 先给一张「有哪些组、各有多少」的目录，
     想看哪组点开哪组。手动动过之后就以操作为准（refreshing 不该把人的选择收回去）。 */
  const [collapsedRaw, setCollapsedRaw] = useState<string[] | null>(readCollapsed);
  /* 拖动摆位：线交叉是因为自动排版只认「同一层按顺序」，不认「谁跟谁更近」。让人自己把卡片
     拖开是唯一能治这个的办法，坐标压过网格布局（见 topology-layout 的 overrides）。 */
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>(readPos);
  const [dragId, setDragId] = useState<string | null>(null);
  const dragRef = useRef<{ id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const movedRef = useRef(false);
  useEffect(() => {
    try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch { /* 隐私模式：位置只在本次会话生效 */ }
  }, [pos]);
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
  // 默认聚焦组 = 当前打开的会话所在分区；没打开任何会话就取最近活跃的那组。
  const collapsed = useMemo(() => {
    if (collapsedRaw) return new Set(collapsedRaw);
    const focusId = openId ?? snap.activeId;
    const focusWs = (focusId ? filtered.nodes.find((n) => n.id === focusId)?.workspace : undefined)
      ?? [...filtered.nodes].sort((a, b) => b.lastAt - a.lastAt)[0]?.workspace;
    return new Set(filtered.nodes.map((n) => n.workspace).filter((ws) => ws !== focusWs));
  }, [collapsedRaw, filtered.nodes, openId, snap.activeId]);

  const layout = useMemo(
    // 手机上组头抬到 44px：手指点卡片区之前先要能点中「展开/收起」这一行。
    () => layoutTopology(filtered.nodes, filtered.edges, {
      cols, collapsed, overrides: pos, headH: narrow ? MOBILE_GROUP_HEAD : undefined,
    }),
    [filtered, cols, collapsed, pos, narrow],
  );
  const placedNodes = useMemo(() => layout.groups.flatMap((g) => g.nodes), [layout]);

  const toggleGroup = (workspace: string): void => {
    const next = new Set(collapsed);
    next.has(workspace) ? next.delete(workspace) : next.add(workspace);
    const arr = [...next];
    setCollapsedRaw(arr);
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(arr)); } catch { /* 同上 */ }
  };

  // 拖动 = 指针位移 > 4px 才算（阈值内仍是点击，卡片该正常打开会话）。
  const dragStart = (e: React.PointerEvent<HTMLDivElement>, p: PlacedNode): void => {
    if (e.button !== 0) return;
    /* 只有鼠标拖得动卡片。手指在图上滑动要能滚页面 —— 触屏拖动和滚动抢同一个手势，抢输了
       就是「滑不动」，抢赢了就是「不小心把卡片挪走」。手机上一列摆开、线本来就少，让位给滚动。 */
    if (e.pointerType !== "mouse") return;
    // 派活按钮上不起拖：那是「点一下派活」，不该把卡片带走。
    if ((e.target as HTMLElement).closest(".topo-card-act")) return;
    dragRef.current = { id: p.node.id, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, moved: false };
    movedRef.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const dragMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    if (!d.moved) { d.moved = true; movedRef.current = true; setDragId(d.id); }
    // 不让它拖进负坐标：拖出画布左上角就再也抓不回来了。
    setPos((prev) => ({ ...prev, [d.id]: { x: Math.max(0, d.ox + dx), y: Math.max(0, d.oy + dy) } }));
  };
  const dragEnd = (): void => {
    dragRef.current = null;
    setDragId(null);
  };
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
        {Object.keys(pos).length ? (
          <button
            type="button"
            className="topo-reset"
            title="把所有卡片放回自动排版的位置"
            aria-label="重置卡片位置"
            data-topo-reset-pos
            onClick={() => { setPos({}); try { localStorage.removeItem(POS_KEY); } catch { /* ignore */ } }}
          >重置布局</button>
        ) : null}
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
                className={`topo-group ${g.collapsed ? "collapsed" : ""}`}
                data-topo-group={g.label}
                data-topo-collapsed={g.collapsed ? "1" : "0"}
                style={{ left: g.x, top: g.y, width: g.w, height: g.h }}
              >
                {/* 组头就是折叠开关：整行可点，不用瞄准一个小三角。折叠后这一行还在，
                    说的仍是「这里有几个会话、几条关系」——收起不是消失。 */}
                <header
                  className="topo-group-head"
                  role="button"
                  tabIndex={0}
                  aria-expanded={!g.collapsed}
                  title={g.collapsed ? `展开 ${g.label}` : `收起 ${g.label}`}
                  data-topo-group-toggle={g.label}
                  onClick={() => toggleGroup(g.workspace)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleGroup(g.workspace); }
                  }}
                >
                  <span className="topo-group-caret" aria-hidden>
                    {g.collapsed ? <IconChevronRight size={11} /> : <IconChevronDown size={11} />}
                  </span>
                  <span className="topo-group-name" title={g.workspace}>{g.label}</span>
                  <span className="topo-group-meta">{g.nodeCount} 会话{g.links ? ` · ${g.links} 条关系` : ""}</span>
                  <button
                    type="button"
                    className="topo-group-add"
                    title="在这个工作空间新建一个会话并派活"
                    aria-label={`在 ${g.label} 里新建会话并派活`}
                    data-topo-dispatch-new={g.label}
                    onClick={(e) => { e.stopPropagation(); setTarget({ kind: "new", workspace: g.workspace }); setAck(""); }}
                  ><IconPlus size={12} />派活</button>
                </header>
              </section>
            ))}
            {/* 卡片是画布级的绝对定位（不在分区框里）：拖到别的分区上面时不该被那个分区的底色
                盖住，也不该被裁掉。分区框只负责画「这是一组」和折叠。 */}
              {placedNodes.map((p) => {
                const n = p.node;
                const st = statusLabel(n);
                return (
                  <div
                    key={n.id}
                    className={`topo-card ${openId === n.id ? "open" : ""} ${n.archived ? "archived" : ""} ${dragId === n.id ? "dragging" : ""}`}
                    style={{ left: p.x, top: p.y, width: CARD_W, height: CARD_H }}
                    data-topo-node={n.id}
                    data-status={st.tone}
                    data-depth={p.depth}
                    data-dragging={dragId === n.id ? "1" : "0"}
                    onPointerDown={(e) => dragStart(e, p)}
                    onPointerMove={dragMove}
                    onPointerUp={dragEnd}
                    onPointerCancel={dragEnd}
                  >
                    <button
                      type="button"
                      className="topo-card-main"
                      title={`${n.title}\n${n.workspace}\n${st.text} · ${shortAgo(n.lastAt)}`}
                      onClick={() => { if (movedRef.current) return; onOpen(n.id); }}
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
