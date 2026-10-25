// 模型使用热度（#62-1）：server 记，这里只读。
//
// 为什么不在 localStorage：排序是「这个人常用什么」这个 agent 级属性，要跨会话、跨浏览器、
// 换设备一致；而且所有切换入口（聊天页 / 新建对话框 / cockpit send）在 server 上收敛到同一个
// setModel，记那一处就不会漏。
//
// 计数口径见 server/src/acp/session-manager.ts：**agent 接受之后**才算一次，被拒的不加分 ——
// 于是"广告了但实际不可用"的条目会自己沉底，不需要任何端点探活。
//
// 这里是一个真的外部 store（`useSyncExternalStore`），不是"挂载时取一次快照"：`noteModelUse`
// 改的是模块级 cache，没有订阅的话，已经挂载的列表永远不会重算 —— 组件在切换会话时也不重新挂载，
// 于是排序会冻结在整页首次挂载那一刻，只有 F5 才变。文件里原来那句"下次打开立刻是新的顺序"
// 正好把这件事说反了。
import { useEffect, useMemo, useSyncExternalStore } from "react";

type RawUsage = Record<string, number>;

let cache: RawUsage | null = null;
let inflight: Promise<void> | null = null;
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version += 1;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function load(): Promise<void> {
  if (cache) return Promise.resolve();
  if (!inflight) {
    inflight = fetch("/api/model-usage", { headers: { accept: "application/json" } })
      .then((r) => {
        if (!r.ok) throw new Error(`model-usage ${r.status}`);
        return r.json() as Promise<{ usage?: RawUsage }>;
      })
      .then((j) => { cache = j.usage ?? {}; emit(); })
      .catch(() => {
        // 一次失败不能把这一页永久钉成"没有热度"：清掉缓存让下次挂载重试（服务重启/502 期间
        // 打开页面很常见）。
        cache = null;
        inflight = null;
        emit();
      });
  }
  return inflight;
}

/** 一次**真正生效**的切换之后调一下：列表立刻是新顺序，不用等页面重载。
 *
 *  只在该模型确实成了当前模型时调 —— 冷会话上点选只是记了意图（server 走 pending 分支，
 *  不计分），把它算作一次"使用"会和服务端的口径相反。 */
export function noteModelUse(backend: string, modelId: string): void {
  const key = `${backend}|${modelId}`;
  cache = { ...(cache ?? {}), [key]: ((cache ?? {})[key] ?? 0) + 1 };
  emit();
}

/** `modelId → 次数`，只含当前 backend 的条目（不同 agent 的模型名会撞：`openai/gpt-6` 与
 *  `openrouter:…` 的前缀天然共享命名空间，合并会把另一个后端的用量算进来）。 */
export function useModelUsage(backend: string): Record<string, number> {
  useSyncExternalStore(subscribe, () => version, () => 0);
  useEffect(() => { void load(); }, []);
  return useMemo(() => {
    const out: Record<string, number> = {};
    const raw = cache ?? {};
    const prefix = `${backend}|`;
    for (const [k, n] of Object.entries(raw)) {
      const bar = k.indexOf("|");
      if (bar < 0) continue;
      if (backend && !k.startsWith(prefix)) continue;
      const id = k.slice(bar + 1);
      out[id] = (out[id] ?? 0) + n;
    }
    return out;
  }, [backend, version]);   // version 变了 = cache 变了，必须重算
}
