// 「这一轮还要跑多久」—— `session_busy` 唯一能回答这个问题的地方（issue #238）。
//
// 0.23 起回合由 gateway 持有：agent 在回合开始时往 `<HERMES_HOME>/state.db` 的
// `session_turn_leases` 写一行（`conversation_id / holder / acquired_at / expires_at`），回合期间
// 续期，正常结束时删掉。被腰斩的回合（自己 promote 重启、进程被杀）既不再续期也不立刻删，于是一句
// `session_busy` 能连着说十几分钟 —— 而客户端只知道「不让进」，不知道还要等多久。
//
// 这里只**读**：拿会话的 ACP id 去查那一行，返回剩余毫秒 + holder 的 pid 还在不在。看不到行（库不在、
// 没表、没有租约）就返回 null，让调用方退回旧的「重试几次」行为 —— 绝不猜一个数字糊弄人。
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export interface BusyTurnEta {
  /** 租约到期还剩多少毫秒（>= 0，已经过期就是 0）。 */
  remainingMs: number;
  /** 谁还攥着：`…:pid=<n>:…`，写进日志用。 */
  holder: string;
  /** 这一行自己声明的到期时刻（epoch ms）。 */
  expiresAt: number;
  /** holder 的 pid 还活着吗：`true` 活着、`false` 确定已经没了、`null` 说不清（holder 没带 pid，
   *  或不在本机的 PID 命名空间里）。`false` 才允许「不等它、直接去试」—— gateway 自己会用同一条
   *  判据回收这行，我们去试就是让它回收；`null` 只能老老实实等，和 agent 的判断保持一致。 */
  holderAlive: boolean | null;
  /** 这一行租约**还在**。判「agent 侧有没有一轮在跑」只认这个布尔，不认 `remainingMs`：
   *  TTL 只是一句预告（实测 540s、回合中途不续期），超过 9 分钟的回合会读到 `remainingMs === 0`
   *  而**那一轮仍在跑**。用剩余时间当判据，冷槽位的「停」就会对任何长回合说「没有回合在跑」——
   *  正是 #107 要消灭的那句谎。 */
  held: true;
}

/** holder 里的 `pid=<n>`（gateway 与 agent 的约定，`hermes_state._compression_lock_holder_process_is_dead`）。 */
function holderPid(holder: string): number {
  const m = /(?:^|:)pid=(\d+)(?::|$)/.exec(holder || "");
  return m ? Number(m[1]) : 0;
}

/** 本机的 pid 还活着吗。只认「确定没了」（ESRCH），别人的进程（EPERM）算活着。 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** 会话在 agent 侧有没有一轮（以及还剩多久）。**读到行就返回**（哪怕已经过期，`held` 说明它还在）；
 *  没有行、读不到（库不在 / 没表 / 被锁）才返回 null —— 后者是「不知道」，调用方不许把它当成「没有」。
 *
 *  `home` 是该后端自己的 HERMES_HOME；`conversationIds` 按「最可能命中」的顺序给（ACP 会话 id、
 *  它的压缩链根、行 id）。租约键是 conversation（= 谱系根），本地会话通常就是 ACP id 本身。 */
export function busyTurnEta(home: string | null, conversationIds: (string | null | undefined)[]): BusyTurnEta | null {
  const ids = conversationIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  if (!home || !ids.length) return null;
  const dbPath = path.join(home, "state.db");
  if (!fs.existsSync(dbPath)) return null;
  let db: DatabaseSync | null = null;
  try {
    // 只读：另开一个写者会和 gateway 抢 SQLite（WAL 下读是安全的）。
    // `timeout` 而不是默认的 0：默认值下一个瞬时 SQLITE_BUSY 就抛，而这里的 catch 会把它变成
    // 「没有租约」——那正是停/恢复会误判的方向。250ms 足够让一次 checkpoint 走开。
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 250 });
    const placeholders = ids.map(() => "?").join(",");
    const row = db
      .prepare(`SELECT holder, expires_at FROM session_turn_leases WHERE conversation_id IN (${placeholders})`)
      .get(...ids) as { holder?: string; expires_at?: number } | undefined;
    if (!row || typeof row.expires_at !== "number") return null;
    const holder = String(row.holder ?? "");
    const pid = holderPid(holder);
    return {
      remainingMs: Math.max(0, Math.round(row.expires_at * 1000 - Date.now())),
      held: true,
      holder,
      expiresAt: Math.round(row.expires_at * 1000),
      // pid 是我们自己（同一个进程里另一轮的租约）时不算死 —— 与 gateway 的判据一致。
      holderAlive: pid > 0 && pid !== process.pid ? pidAlive(pid) : null,
    };
  } catch {
    // 库被锁、schema 还没迁移、字段名换了：都当「不知道」，不要因此让 resume 失败。
    return null;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

/** 给人看的等待描述：`约 6 分 12 秒`。 */
export function waitWords(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `约 ${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `约 ${minutes} 分 ${seconds} 秒` : `约 ${minutes} 分钟`;
}
