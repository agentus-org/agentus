// 模型使用热度（#62-1）：server 记，这里只读。
//
// 为什么不在 localStorage：排序是「这个人常用什么」这个 agent 级属性，要跨会话、跨浏览器、
// 换设备一致；而且所有切换入口（聊天页 / 新建对话框 / cockpit send）在 server 上收敛到同一个
// setModel，记那一处就不会漏。
//
// 计数口径见 server/src/acp/session-manager.ts：**agent 接受之后**才算一次，被拒的不加分 ——
// 于是"广告了但实际不可用"的条目会自己沉底，不需要任何端点探活。
import { useEffect, useMemo, useState } from "react";

type RawUsage = Record<string, number>;

let cache: RawUsage | null = null;
let inflight: Promise<void> | null = null;

function load(): Promise<void> {
  if (cache) return Promise.resolve();
  if (!inflight) {
    inflight = fetch("/api/model-usage", { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : { usage: {} }))
      .then((j: { usage?: RawUsage }) => { cache = j.usage ?? {}; })
      .catch(() => { cache = {}; });
  }
  return inflight;
}

/** 一次成功的切换之后调一下：下次打开列表立刻是新的顺序，不用等页面重载。 */
export function noteModelUse(backend: string, modelId: string): void {
  const key = `${backend}|${modelId}`;
  cache = { ...(cache ?? {}), [key]: ((cache ?? {})[key] ?? 0) + 1 };
}

/** `modelId → 次数`，只含当前 backend 的条目（不同 agent 的模型名会撞）。 */
export function useModelUsage(backend: string): Record<string, number> {
  const [raw, setRaw] = useState<RawUsage>(cache ?? {});
  useEffect(() => {
    let alive = true;
    void load().then(() => { if (alive) setRaw(cache ?? {}); });
    return () => { alive = false; };
  }, []);
  return useMemo(() => {
    const out: Record<string, number> = {};
    const prefix = `${backend}|`;
    for (const [k, n] of Object.entries(raw)) {
      const bar = k.indexOf("|");
      if (bar < 0) continue;
      // backend 为空 = 还没定下哪一个 agent（新建对话框）：把所有条目合并。
      // 不同后端的模型 id 基本不重叠，合并只会让"我常用的模型"更早浮上来。
      if (backend && !k.startsWith(prefix)) continue;
      const id = k.slice(bar + 1);
      out[id] = (out[id] ?? 0) + n;
    }
    return out;
  }, [raw, backend]);
}
