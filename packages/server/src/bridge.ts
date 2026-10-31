/**
 * 跨工作空间转交（输入框里的 `@`）。
 *
 * 传输层早就有了：`agentus session send <id> <text>` 能把一句话投进另一个会话。缺的是
 * **入口**和**信封** —— 手工复制会话 ID、切工作空间、再打一段说明，是这个功能最贵的部分。
 *
 * 信封的取舍是这个功能的核心，写在这里以免以后被"顺手改得更贴心"：
 *
 *  · **不搬聊天记录**。用户的原话是「不要把所有上下文带过去，只带会话 ID + 怎么查」。
 *    搬记录的代价是那份记录会变成目标会话的上下文，几百行无关的排查过程压着它干活；
 *    而 ID 是稳定的、可以反复查的、且永远是最新的。
 *  · **必须给读法**。只给 ID 等于给对方一个它撬不开的锁：目标 agent 手里没有浏览器，
 *    它唯一的工具是 cockpit CLI。所以信封里写的是能直接粘进终端的命令，不是"你可以去查一下"。
 *  · **信封由服务端拼**。格式只在一处定义：以后再加一个入口（手机、托盘、别的客户端），
 *    不需要把这段文案抄一遍，也不会两份文案慢慢漂移。
 */

/** 目标：一个还没建的新会话（按工作空间建），或者一个已经存在的会话。 */
export type BridgeTarget =
  | { kind: "new"; workspace: string }
  | { kind: "session"; id: string };

export interface BridgeEnvelopeInput {
  /** 来源会话（操作员正待着的那个） */
  from: string;
  fromTitle?: string | null;
  /** 来源工作空间（目录）。给人看的是目录，给 agent 看的是"另一边在哪"。 */
  fromCwd: string;
  /** 操作员在输入框里打的那句话，原样放在最后。 */
  userText: string;
}

/** 命令里用的可执行名：会话内 `$AGENTUS_COCKPIT_BIN` 是 cockpit 交给 agent 的那份 CLI 的绝对路径，
 *  会话外通常就是 `agentus`。两条都写上，因为目标 agent 可能两种环境都待过。 */
const CLI = "agentus";

/**
 * 生成注入给目标会话的正文。
 *
 * 形状是刻意朴素的：三行事实 + 一条命令 + 一句"别猜"，然后才是操作员的话。没有 JSON、
 * 没有 XML 标签 —— 目标 agent 读到的是一段人写的交接便条，而不是一份协议报文；何况
 * 不同后端的 prompt 渲染差别很大，纯文本最不容易被"美化"掉。
 */
export function buildBridgeEnvelope(input: BridgeEnvelopeInput): string {
  const from = input.from;
  const title = (input.fromTitle ?? "").trim();
  const named = title ? `${from} 《${title}》` : from;
  return [
    "[跨工作空间转交] 这条消息由操作员在另一个会话里用 @ 转过来的，不是你正在对话的那个人打的。",
    `来源工作空间：${input.fromCwd}`,
    `来源会话：${named}`,
    `读取原会话：${CLI} session messages ${from} --tail 60`,
    `（在会话内用： "$AGENTUS_COCKPIT_BIN" session messages ${from} --tail 60）`,
    "说明：这里只给了会话编号，没有搬运聊天记录 —— 需要细节就按上面的命令去读原文，不要凭空推断。",
    "",
    "---",
    input.userText,
  ].join("\n");
}

/**
 * 转交新建的那个会话叫什么。
 *
 * 不给名字的话，`#autoTitleFrom` 会拿**信封的第一段**当标题，rail 上就变成一整句
 * 「[跨工作空间转交] 这条消息由操作员在另一个会话里用 @ 转过来的…」—— 一封说明书
 * 占了一行。给个 `← 排查问题` 就够了：认识那边在干什么，也知道它是被谁叫来的。
 */
export function bridgeTitle(fromTitle: string | null | undefined, fromId: string): string {
  const named = (fromTitle ?? "").trim() || fromId;
  const cut = named.length > 40 ? `${named.slice(0, 39)}…` : named;
  return `← ${cut}`;
}

/** 目录比较：去掉尾斜杠再比，`/a/b` 与 `/a/b/` 是同一个工作空间。 */
export function sameCwd(a: string, b: string): boolean {
  const norm = (p: string): string => `/${p.split("/").filter(Boolean).join("/")}`;
  return norm(a) === norm(b);
}

/** 工作空间在弹层里怎么显示：路径的最后一段（与 rail 同一套规则）。 */
export function workspaceLabel(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() ?? cwd;
}
