// The model list — one implementation, both composers.
//
// The chat page always had the rich version: grouped by provider, a filter box once the agent
// advertises more than a dozen models, the current model's group first. The new-session dialog had
// a plain id list instead, and with an agent that knows 439 models that is not a list, it is a
// wall — measured 2026-10-15: 439 flat rows, no filter, no grouping, the current model on row 245
// and therefore invisible. That is the whole of the operator's "显示不清楚是什么模型". So both call
// sites render this, and it carries the fit logic that keeps the box on screen where the dialog
// sits near the top of the window (usePopoverFit, which also brings the current row into view).
//
// Two layout details worth keeping: the filter box is pinned above the scroll area rather than
// scrolling away with 439 rows (AionUi's model list does the same), and group headings stay
// visible while their body scrolls, so the reader always knows which provider they are in.
import { useMemo, useState } from "react";
import { IconChevronRight } from "./Icons";
import { modelProvider, rowModelName } from "./modelNames";
import { usePopoverFit } from "./useDismiss";

export type ModelItem = { modelId: string; name?: string | null; description?: string | null };

/** Above this many models the list gets a filter box. */
const FILTER_FROM = 12;

export function ModelList({ models, current, usage = {}, pending = null, onPick, bad = {}, err = null }: {
  models: ModelItem[];
  current: string;
  /** #62-1 热度：`modelId → 成功切换次数`。两层排序 —— 组按累计热度，组内按各自热度。 */
  usage?: Record<string, number>;
  /** #62-2 冷会话上选定但还没生效的模型（没有 agent 可以发 set_model，等 resume 重放） */
  pending?: string | null;
  /** the pick; the caller decides whether the list closes (a refusal keeps it open, to be read) */
  onPick: (modelId: string) => void;
  /** ids this agent has already refused, with the sentence it gave */
  bad?: Record<string, string>;
  /** the refusal being shown right now, pinned above the list: the row may be filtered away */
  err?: { id: string; text: string } | null;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const listRef = usePopoverFit<HTMLDivElement>();

  // Filtering opens every matching group; otherwise the operator's own groups stay as they are.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? models.filter((m) => `${m.modelId} ${m.name} ${m.description ?? ""}`.toLowerCase().includes(q))
      : models;
    const byProvider = new Map<string, ModelItem[]>();
    for (const m of filtered) {
      const key = modelProvider(m);
      const list = byProvider.get(key);
      if (list) list.push(m);
      else byProvider.set(key, [m]);
    }
    const here = models.find((m) => m.modelId === current);
    const hereKey = here ? modelProvider(here) : "";
    const heat = (id: string): number => usage[id] ?? 0;
    return [...byProvider.entries()]
      .map(([provider, list]) => {
        // 组内：常用在前。同分时按 id，保证顺序稳定（不会因为 Map 迭代顺序抖动）。
        const sorted = [...list].sort((a, b) => (heat(b.modelId) - heat(a.modelId)) || a.modelId.localeCompare(b.modelId));
        return {
          provider,
          list: sorted.slice(0, 200),
          truncated: sorted.length > 200,
          current: provider === hereKey,
          // 组热度 = 组内累计：一个供应商用了很多次，哪怕单个模型分散，也该浮上来。
          heat: sorted.reduce((n, m) => n + heat(m.modelId), 0),
        };
      })
      // 当前模型所在的组永远置首（原有语义），其余按热度，最后才按名字。
      .sort((a, b) => (a.current !== b.current ? (a.current ? -1 : 1) : (b.heat - a.heat) || a.provider.localeCompare(b.provider)));
  }, [models, query, current, usage]);

  return (
    <div className="tb-list wide stacked" ref={listRef}>
      {err ? (
        <div className="tb-err" role="alert" data-model-err={err.id}>
          <span className="tb-err-id">{err.id}</span>
          <span className="tb-err-text">{err.text}</span>
        </div>
      ) : null}
      {models.length > FILTER_FROM ? (
        <input
          className="tb-search"
          autoFocus
          value={query}
          placeholder={`filter ${models.length} models…`}
          aria-label="filter models"
          onChange={(e) => setQuery(e.target.value)}
        />
      ) : null}
      <div className="tb-scroll">
        {groups.map((g) => {
          const open = Boolean(query.trim()) || !closed[g.provider];
          return (
            <div className="tb-group" key={g.provider}>
              <button
                type="button"
                className={`tb-group-head ${open ? "open" : ""}`}
                aria-expanded={open}
                title={`${g.provider} · ${g.list.length} model(s)`}
                data-provider={g.provider}
                onClick={() => setClosed((c) => ({ ...c, [g.provider]: !c[g.provider] }))}
              >
                <IconChevronRight size={11} className={`tb-group-chev ${open ? "open" : ""}`} />
                <span className="tb-group-name">{g.provider}</span>
                <span className="tb-group-count">{g.list.length}</span>
              </button>
              {open ? (
                <div className="tb-group-body">
                  {g.list.map((m) => (
                    <button
                      key={m.modelId}
                      className={`tb-opt ${m.modelId === current ? "sel" : ""} ${pending === m.modelId ? "pending" : ""} ${err?.id === m.modelId || bad[m.modelId] ? "bad" : ""}`}
                      title={bad[m.modelId]
                        ? `${m.modelId} — this agent refused it: ${bad[m.modelId]}`
                        : (m.description ? `${m.modelId} — ${m.description}` : m.modelId)}
                      data-model={m.modelId}
                      data-model-refused={bad[m.modelId] ? "1" : undefined}
                      onClick={() => onPick(m.modelId)}
                    >
                      <span className="tb-opt-name">{rowModelName(m, g.provider)}</span>
                      {pending === m.modelId ? <span className="tb-opt-pending">待生效</span> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
        {!groups.length ? <div className="tb-empty">no model matches “{query}”</div> : null}
      </div>
    </div>
  );
}
