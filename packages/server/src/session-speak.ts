// 会话级的「喇叭档位」(issue #68).
//
// 全局 `prefs.speakMode` 表达的是「我怎么工作」，所以它跟着人跨设备走（见 settings.ts 文件头）。
// 但「我在盯这一个长任务，把它念出来」是**某一个会话**的意图 —— 一个会话打开喇叭，其它会话跟着
// 一起念，正是 issue #68 报的行为。两层不冲突：全局是**默认层**，会话行一旦存在就覆盖它。
//
// 存储用 settings 表里的一行 JSON（key = "sessionSpeak"）：
//   { "<sessionId>": { "mode": "off"|"reply"|"brief", "intervalSec": number, "at": number } }
// 不新开表，因为这一层没有任何按条件查询的需求（一次全读，一次一行写），而 settings 表本来就在做
// 「操作员配置」这件事；新表还要配迁移与清理。
import type { Store } from "./store/store.js";

export type SpeakMode = "off" | "reply" | "brief";

export interface SessionSpeak {
  mode: SpeakMode;
  /** 只在 mode === "brief" 时有意义：每 N 秒报一次。 */
  intervalSec: number;
  at: number;
}

/** 存储层的粗校验上限；真正的可选档位由前端的喇叭菜单决定。 */
export const SPEAK_INTERVAL_MAX = 3600;

let db: Store | null = null;

export function initSessionSpeak(store: Store): void {
  db = store;
}

function pick(raw: unknown): SessionSpeak | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const mode = r.mode;
  if (mode !== "off" && mode !== "reply" && mode !== "brief") return null;
  const iv = Number(r.intervalSec);
  const intervalSec = Number.isFinite(iv) && iv >= 0 && iv <= SPEAK_INTERVAL_MAX ? Math.round(iv) : 0;
  const at = Number(r.at);
  return { mode, intervalSec, at: Number.isFinite(at) ? at : 0 };
}

/** 所有会话自己的档位。**没有**这一行的会话 = 继承全局默认（这正是兼容性的全部内容）。 */
export function allSessionSpeak(): Record<string, SessionSpeak> {
  const raw = db?.getSetting("sessionSpeak");
  const out: Record<string, SessionSpeak> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const s = pick(v);
    if (s) out[id] = s;
  }
  return out;
}

export function sessionSpeakOf(sessionId: string): SessionSpeak | null {
  if (!sessionId) return null;
  return allSessionSpeak()[sessionId] ?? null;
}

export function setSessionSpeak(sessionId: string, mode: SpeakMode, intervalSec = 0): SessionSpeak {
  const all = allSessionSpeak();
  const next: SessionSpeak = {
    mode,
    intervalSec: mode === "brief" ? Math.min(SPEAK_INTERVAL_MAX, Math.max(0, Math.round(intervalSec))) : 0,
    at: Date.now(),
  };
  all[sessionId] = next;
  db?.setSetting("sessionSpeak", all);
  return next;
}

/** 回到「跟全局默认走」。删掉这一行，**而不是**写一条 `off` —— 写 off 会让这个会话永远不再继承
 *  默认层，下次操作员改全局默认时它还会是静音的，那就成了另一种「莫名其妙」。 */
export function clearSessionSpeak(sessionId: string): void {
  const all = allSessionSpeak();
  if (!(sessionId in all)) return;
  delete all[sessionId];
  db?.setSetting("sessionSpeak", all);
}

/** 一个会话实际生效的档位：会话行优先，否则全局默认。
 *  这是唯一一处把两层合成一个答案的地方 —— hub 的闸门、喇叭的显示、诊断端点都读它。 */
export function resolveSpeak(
  sessionId: string,
  dflt: { mode: SpeakMode; intervalSec: number },
): { mode: SpeakMode; intervalSec: number; source: "session" | "default" } {
  const own = sessionSpeakOf(sessionId);
  if (own) return { mode: own.mode, intervalSec: own.intervalSec, source: "session" };
  return { mode: dflt.mode, intervalSec: dflt.intervalSec, source: "default" };
}
