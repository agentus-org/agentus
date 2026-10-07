# Hermes Studio 聊天 UI 设计思想摘要（调研笔记）

> 调研对象：`~/Project/hermes-studio`（Vue 3 + Pinia + Socket.IO + markdown-it + vue-virtual-scroller）。
> 目的：为 Agentus 的聊天 UI 提取可移植的设计思想，不抄代码。行号基于当前 checkout，引用路径相对 `packages/client/src`（服务端相对 `packages/server/src`）。

---

## 1. 流式消息渲染

### 1.1 组件分层

- `views/hermes/ChatView.vue` — 薄壳：只做路由 ↔ store 同步（`routeSessionId` watch → `switchSession`，ChatView.vue:60-75），把 document.title 绑定到会话标题。
- `components/hermes/chat/ChatPanel.vue` — 三栏布局（会话列表 / 聊天区 / 工具面板），持有移动端抽屉、面板拖宽等布局态。
- `MessageList.vue`（1636 行）— 消息列表编排：显示过滤、fork 分隔线、滚动跟随、流式指示器、悬浮审批/排队区。
- `VirtualMessageList.vue` — 纯滚动容器原语，封装 vue-virtual-scroller + stick-to-bottom 逻辑，双向都可用（`virtualized` prop）。
- `MessageItem.vue` — 单条消息：按 `role`（user/assistant/tool/system/command）分支渲染，内嵌思考块、工具行、附件。
- `MarkdownRenderer.vue` — 内容 → HTML 的纯展示组件，被 assistant/user 正文与思考块复用。

**设计规则：**
1. 滚动策略（"怎么跟"）与列表内容（"显示什么"）分离：`VirtualMessageList` 只懂视口数学，`MessageList` 决定何时调用。
2. 列表显示层用 computed 过滤（`displayMessages`，MessageList.vue:127-146），不改 store 里的原始消息数组——流式期间 store 是唯一事实源。
3. 历史页（长消息数）用虚拟滚动；实时聊天页显式传 `:virtualized="false"`（MessageList.vue:484 附近），因为消息数被硬性分页封顶（见 §2.2），全量渲染更简单且避免动态高度测量抖动。历史列表 `HistoryMessageList.vue:186` 则默认开启虚拟化。

### 1.2 chunk 如何合并进消息列表

核心是 store 内的事件 reducer（`stores/hermes/chat.ts`，约 2700-3100 行是一个大 `handleEvent` switch）：

- 每次 run 持有闭包态 `activeAssistantMessageId` / `reasoningAssistantMessageId`（chat.ts:3188-3190 附近）。`message.delta` 到达时：若最后一个流式 assistant 消息还在，就地 `last.content += evt.delta`；否则新建 `{role:'assistant', isStreaming:true}` 并记住 id（chat.ts:2802-2837）。
- `tool.started` 先把流式 assistant 消息 `isStreaming=false` 封口、清空 `activeAssistantMessageId`（chat.ts:2840-2858）——即"文本段与工具段天然切开"，工具之后的新 delta 会另起一条 assistant 消息。
- 生命周期事件（`run.completed` / `abort.completed` / `tool.completed`）负责收尾：封口所有 streaming 消息、把 `running` 工具 settle 为 `done/error`（chat.ts:2936-2945、2876-2894）。
- 兜底：若上游没发任何 `message.delta` 只在 `run.completed.output` 给全文，则补建一条 assistant 消息（chat.ts:2985-3005）；若"无文本+无工具+空输出"判定为被吞掉的错误，插入 system 错误消息（chat.ts:3017-3027）。
- 重连/切回后恢复合并锚点：`resolveResumedAssistantState()` 用消息上的 `finishReason`/`runMarker` 判断"最后一条 assistant 是否是还在跑的 run"，是则继续往它身上追加 delta（chat.ts:356-403）。

**设计规则：**
1. delta 合并用"目标消息 id 指针"而非"总是找最后一条"，防止并发工具/子代理事件把 delta 追加到错误消息。
2. 直接 mutate 消息对象属性（`last.content = next`）而不是整条替换，配合 Pinia 的深 reactive 减少 diff 成本；但队列消息等跨组件共享态用整 Map 替换触发响应（chat.ts:1912-1917）。
3. 终态事件必须"幂等收尾"：`toolCallId` 找不到对应消息就忽略 completed 事件（chat.ts:2881-2893），completed 早于 started 到达（重连回放场景）也能靠 `resume` 快照补齐。
4. 永远准备"没有 delta 流"的降级路径：`run.completed` 里的最终文本兜底渲染，保证 UI 不出现"成功但空白"。
5. 乐观更新：发送瞬间本地 push user 消息 + `serverWorking.add(sid)`（chat.ts:2331-2337），失败时靠 `run.failed`/错误注入回滚视觉。回调全部捕获发送时的 `sid`，绝不用"当前激活会话"（chat.ts:2289 注释）——这是多会话流式不串台的关键。

### 1.3 Markdown 增量渲染

- 渲染是**全量重渲**：`renderedHtml = computed(() => md.render(repairNestedMarkdownFences(props.content)))`（MarkdownRenderer.vue:146-148），依赖 Vue computed 只在 content 变化时重算，没有做 token 级增量 parser。
- 重渲前先做**语法修复**：`markdownFenceRepair.ts` 修复流式中途常见的"嵌套 fence 未闭合 / 反引号残缺"（repairNestedMarkdownFences，markdownFenceRepair.ts:183），让半截代码块不至于把后面的正文全部染成代码。
- `<think>` 标签类思考由 `thinking-parser.ts` 在渲染前剥离：解析时先用占位符保护 fenced/inline code（避免把代码示例里的 `<think>` 当真标签，thinking-parser.ts:19-33），未闭合的开标签在 `streaming:true` 时归入 `pending`（即正在思考），不进正文（thinking-parser.ts:70-80）。
- 重活后置：mermaid 图表在 `watch(renderedHtml, …, { flush: 'post' })` 后异步渲染（MarkdownRenderer.vue:371-373），并用 `renderGeneration` 计数丢弃过期渲染结果，防止流式重渲期间图表互相覆盖。
- html:false + linkify + breaks 的安全基线（MarkdownRenderer.vue:75-80）；本地文件路径在 HTML 字符串阶段改写为下载 URL / 文件卡片 / 内嵌播放器（MarkdownRenderer.vue:174-235）。

**设计规则：**
1. 增量流式 ≠ 增量渲染：全量 `md.render` + 防抖来自 SSE 帧合并本身；真正需要优化的是"未闭合语法"，用一个 fence/think 修复层解决，比接 streaming markdown 库便宜得多。
2. 思考/代码块等"内联协议"要在 parse 层处理，且处理时必须先屏蔽 code 区域——模型输出里复述标签是常态。
3. 异步二次渲染（图表、高亮）要有 generation token + unmount 标志，防止旧 Promise 写新 DOM。
4. 渲染 HTML 后处理（标题加 id 供大纲锚点、链接改写）集中在一个组件里做字符串替换，保持 md-it 插件链简单。

### 1.4 滚动跟随（stick to bottom）

`VirtualMessageList.vue` 的状态机 + `MessageList.vue` 的触发器：

- 核心状态：`userDetachedFromBottom`（用户是否主动上翻）、`keepBottomUntil`（时间窗）、`programmaticScrollUntil`（区分程序滚动与用户滚动）（VirtualMessageList.vue:72-80）。
- 判定：`isNearBottom(threshold)` 用 `scrollHeight - scrollTop - clientHeight < threshold`；`handleScroll` 中"向上位移 >1px 且非程序滚动"→ 置 detached 并取消跟底；回到底部 32px 内 → 自动 re-attach（VirtualMessageList.vue:114-127、146-154）。wheel 事件额外提前打断（VirtualMessageList.vue:129-134）。
- 跟底是**多帧循环**：`scheduleScrollToBottom(frames)` 每帧重设 `scrollTop = scrollHeight - clientHeight`，因为流式内容在下一帧才变高；带 30 次失败上限防止死循环（VirtualMessageList.vue:178-205）。
- 触发分级（MessageList.vue:400-445）：用户发新 run → 强制跟底 `frames:3, keepAliveMs:400`；流式内容 watch（最后一条消息 content 变化）→ 仅 `shouldAutoFollowBottom()` 为真时 `frames:1, keepAliveMs:0`；初始加载 → `frames:8, keepAliveMs:1200`。
- 离开底部时显示"回到底部"悬浮按钮，阈值 1000px（MessageList.vue:283-285）。
- 会话级滚动位置记忆：模块级 `Map<sessionId, {scrollTop, scrollHeight, wasNearBottom}>`，切走保存、切回恢复；`wasNearBottom` 则直接跟底（MessageList.vue:14、296-330）。
- 顶部翻页防跳动：`handleTopReach` 先 `captureScrollPosition()`，prepend 旧消息后按 `scrollHeight 增量` 还原 scrollTop（MessageList.vue:333-342；VirtualMessageList.vue:352-370）。
- 锚点定位（点击大纲/搜索结果跳转）用 token + 最多 8-10 帧的重复对齐，等待异步内容（代码高亮、mermaid）改变高度（VirtualMessageList.vue:267-330）。

**设计规则：**
1. "跟底"必须区分程序滚动与用户滚动：所有程序 scrollTop 赋值前打时间戳（`markProgrammaticScroll`），scroll handler 里据此过滤回声。
2. 单一布尔 `userDetachedFromBottom` + 近底 re-attach，比纯距离阈值可靠：用户上翻 1px 即脱离，滚回底部即重连。
3. 跟底滚动是 rAF 循环不是单次 nextTick——流式期间内容高度逐帧增长，一次性 scrollTo 会落后。
4. 不同事件用不同"力度"（帧数 + keepAlive 时长）：用户主动行为强跟、delta 追加弱跟、初始加载超长跟。
5. 列表增删（尤其头部 prepend）永远配合 scrollHeight 差值快照还原，否则翻页视觉抖动。
6. 每条消息 DOM 上稳定 `id="message-{id}"`，锚点跳转先 `getElementById`、找不到再退化为 index 计算（VirtualMessageList.vue:207-216）。

### 1.5 思考块 / 工具调用的区分展示

- 数据模型：思考文本挂在自己的 assistant 消息上（`message.reasoning`，两条来源：DB 历史字段或 `reasoning.delta`/`thinking.delta` 累加，chat.ts:74-79）；工具调用是**独立 role:'tool' 消息**（有 `toolCallId`/`toolPreview`/`toolStatus` running|done|error/`toolDuration`），不是嵌在 assistant 里的 part。
- 思考块 UI（MessageItem.vue:1056-1090）：可折叠 header（💭 + "思考中"/标签 + 时长 + 字符数），body 复用 MarkdownRenderer。展开策略三级：流式进行中强制展开 → 用户点击 override → 全局设置 `display.show_reasoning`（MessageItem.vue:252-266）。时长来自 store 里的 transient observation（`noteReasoningStart/End`，切会话即清，不入 DB，chat.ts:3894 附近注释）。
- 兜底兼容：若模型把思考写在 content 的 `<think>` 标签里而非独立事件，`parsedThinking` 同样能提取并与 `reasoning` 字段拼接展示（MessageItem.vue:227-243）。
- 工具调用双位置展示：a) 行内：会话流里的 tool 消息渲染成单行"› 工具名 + preview + spinner/error 徽标"，可展开看 args/result 代码块（MessageItem.vue:897-994）；b) 悬浮活动条：run 进行中在列表底部显示"本轮工具栈"（abort/compression 状态也塞进同一面板），工具行含 preview 截断 160 字 + 时长格式化（MessageList.vue:533-700）。
- 显示去重：正在悬浮面板里展示的工具行，从消息流里隐藏（`displayMessages` 过滤 `currentToolIds`，MessageList.vue:127-133）；全局开关 `useToolTraceVisibility`（localStorage 持久化）可整体隐藏 tool 消息（useToolTraceVisibility.ts:1-34）。
- `currentToolCalls` 只取"最近一条 user/command 输入之后"的 tool 消息、最新在上（MessageList.vue:77-92）——工具栈天然按"轮"分组，不需要额外 runId 索引。

**设计规则：**
1. 思考与正文是**同一消息的两个字段**，而不是两条消息：折叠、时长、字符数都锚定该 assistant 消息；`message.delta` 一到即视为思考结束。
2. 工具是平级消息（role:'tool'），靠 `toolCallId` upsert 合并 started/completed——比嵌套 parts 更简单，虚拟列表项高度也稳定。
3. "流式中的过程信息"放底部悬浮面板，结束后沉降回消息流（过滤反转）：过程可见、历史可回放、同一信息不同时出现两份。
4. 未知上游行为要兜底：`reasoning.available` 的 payload 被当作"结束信号"而非内容源（上游会塞正文前 500 字，chat.ts:2790-2800 注释）；无 delta 只有 available 时不显示时长。
5. 时长/计时器等展示态用轻量 setInterval + watchEffect 自管理，组件卸载必清理（MessageItem.vue:270-293）。

---

## 2. 会话列表 / 切换

### 2.1 状态管理

- 单 store（`useChatStore`，4000 行）持有：`sessions: Session[]`、`activeSessionId`、`focusMessageId`、每会话运行态用 `Map/Set` 侧表（`serverWorking`、`queueLengths`、`queuedUserMessages`、`completedUnreadSessions`、`pendingApprovals`、`compressionStates`，chat.ts:693-742）。会话对象本身不带 running 标志——"是否在跑"是服务端报告的事实，不污染实体。
- 激活会话靠**对象引用**：`activeSession = sessions.value.find(...)` 缓存引用，流式 delta 直接 mutate 该引用（chat.ts:1053-1059 的 CRITICAL 注释）。

**设计规则：**
1. 列表刷新必须**就地合并**而非整表替换：`refreshSessionListOnly()` 把新元数据写回既有 Session 对象，否则 `activeSession` 引用变孤儿、流式立即"断流"（chat.ts:1061 起）。`loadSessions()` 全量替换时同样先快照旧 messages/contextTokens 再回填（chat.ts:1001-1021）。
2. 跨会话侧表（Set/Map）集中放 store，UI 组件只查 `isSessionLive(sid)` 之类的 API；删除/归档会话时统一 prune。
3. 后台列表同步用 12s 轻量轮询 + `document.visibilityState` 和 `isStreaming` 双门闸（chat.ts:3887-3892）——流式期间绝不刷列表。
4. 未读语义自定义："完成时用户不在看该会话"才记 `completedUnreadSessions`，切回即清（chat.ts:820-845）。

### 2.2 加载历史与切换

- `switchSession(sid, focusId?)`：先写 localStorage（记住最后活跃会话）→ `isLoadingMessages=true` → 通过 **Socket.IO `resume`** 而不是 REST 拉消息（chat.ts:1224-1245）：一次往返同时拿到消息、是否在工作中、队列快照、abort/compression 状态、token 计数、fork 血缘、以及运行中事件的回放（`data.events` 逐条重放进 reducer，chat.ts:1307-1400）。带 15s 超时。
- 分页：`LIVE_CHAT_MESSAGE_PAGE_SIZE=150`、`LIVE_CHAT_MAX_LOADED_MESSAGES=300`（chat.ts:21-22）。顶部触达 `topReach` → `loadOlderMessages()` 按 offset 取更早页，按 id 去重后 prepend（chat.ts:1413-1443）。超过 300 条封顶后，UI 显示"去历史页看更早内容"链接而不是继续加载（MessageList.vue:210-232、237-249）。
- 路由是真源：ChatView 监听 `routeSessionId`，store 里目标会话不存在时重新 `loadSessions(preferredSessionId)`；非法路由 id 回退 replace 到无参聊天路由（ChatView.vue:38-75）。切换 URL 与 `switchSession` 双向：列表点击 → `router.push` + 必要时 switch（ChatPanel.vue:205-212）。

**设计规则：**
1. "切换会话"与"重新接上正在跑的 run"是同一条通道（resume 快照 + 事件回放），避免 REST 历史与 WS 实时流两套合并逻辑打架。
2. resume 回放的 events 只用于**状态重建**（compression/approval/tool 卡片），文本 delta 不重放——历史 messages 里已含全文；客户端对回放事件仍走同一个 reducer。
3. 聊天页消息量硬封顶（~300 条），老内容卸载到独立历史页：实时页 DOM 小、滚动简单、无需虚拟化也能流畅。
4. prepend 页必须 id 去重（服务端分页与 resume 快照可能重叠，chat.ts:1428-1430）。
5. 空标题会话用第一条 user 消息前 40 字生成占位标题（chat.ts:1295-1301），等服务端 `session.title.updated` 事件再原地替换。

### 2.3 删除 / 归档 / 批量

- `deleteSession`：先 API 成功再从列表移除；若删的是激活会话，切到剩余第一个，否则新建空会话（chat.ts:1510-1524）。
- `archiveSession` 同构，但非激活会话删除后顺带 `refreshSessionListOnly()` 校准（chat.ts:1526-1546）。
- 批量删除：ChatPanel 维护 `isBatchMode + selectedSessionKeys: Set`，`batchDeleteSessions` 返回 `{deleted, failed}`，partial 成功要 warning 而不是 success（ChatPanel.vue:69-72、785-825）。
- UI 层：删除入口是 hover 才显示的图标 + NPopconfirm 二次确认（SessionListItem.vue:184-191、219-224），移动端常显（media query，SessionListItem.vue:337 附近）。

**设计规则：**
1. 删除流程 = 服务端权威 → 本地乐观移除 → 激活会话善后（自动切邻居），永不出现"删了当前会话却空白页"。
2. 批量操作反馈区分 deleted/failed 计数，部分失败降级为 warning。
3. 所有会话级操作参数带上 `session.profile`（多 profile 是服务端 API 的隐藏维度，chat.ts:1511）。

---

## 3. WS / 事件桥接层

### 3.1 连接拓扑（`api/hermes/chat.ts`）

- 模块级**单例 socket** per (profile, transport)：`connectChatRun()` 若已连接且 profile/transport 匹配直接复用；不匹配则 removeAllListeners + disconnect 重建，杜绝重复监听（chat.ts:658-676）。`io(url, { transports:['websocket','polling'], reconnection:true, reconnectionAttempts:Infinity, reconnectionDelay:1000, reconnectionDelayMax:30000, randomizationFactor:0.5 })`（chat.ts:695-706）。
- 两层监听：全局监听器（每种事件一个 `global*Handler`，只注册一次，chat.ts:708-755）→ 按 `event.session_id` 查 `sessionEventHandlers: Map<sid, handlers>` 分发（chat.ts:549-585）。业务 handler 由 `startRunViaSocket` / `resumeServerWorkingRun` 注册，run 结束即 unregister。
- 服务端对偶（`packages/server/src/services/hermes/run-chat/index.ts`）：客户端 `resume` 时 `socket.join('session:{sid}')`，事件默认向整个 session room 广播（多标签页同步），room 空时回退直发当前 socket（index.ts:981-988）。
- 每会话服务端环形缓冲：`state.events.push(...)`，超过 200 裁头（index.ts:853-854）；`resumeEvents = state.isWorking ? state.events : 只保留 run.reattach_failed`（index.ts:511-513）——空闲会话不回放旧事件，防止重复渲染。

### 3.2 断线重连与追赶

- 客户端把 disconnect 原因分类：`TRANSIENT_DISCONNECT_REASONS = {transport close, transport error, ping timeout, …}`（chat.ts:140+）。瞬时断开只置 `sawTransientDisconnect` 标记**不**报错；`connect` 事件回来后发 `resume`，并挂一次性 `resumed` 监听把快照交给 `onReconnectResume` 回调（chat.ts:846-900）。真正的业务错误只走 `run.failed` / 非瞬断 / connect_error（非重试期间）。
- `applyReconnectResume`（store，chat.ts:2480-2530）：用快照修正 `serverWorking`、队列、abort 状态，然后 `resumeServerWorkingRun()` 重建 handler + 用 `resolveResumedAssistantState`（runMarker/finishReason）找回"该往哪条消息续 delta"。
- 服务端-引擎侧也有游标追赶：Node ↔ Python agent bridge 之间是 HTTP 轮询（100ms），带 `cursor`/`event_cursor` 增量拉取（handle-bridge-run.ts:750、788-789、799-805）；resume 时先 snapshot 未消费的 `missingOutput` 再设游标，保证断点不漏字。reattach 失败发 `run.reattach_failed` 事件（带去重：同 error 不重复 push，index.ts:598-610）。

### 3.3 缓冲 / 去重 / 顺序

- **无客户端 seq 号**。事件本身带 `session_id`，所有 handler 校验 `data.session_id === sid` 且 `activeSessionId === sid` 才应用（chat.ts:1240-1242 resume 回调、851 reconnect 回调），乱序/跨会话事件被丢弃。
- 幂等靠**语义键 upsert**：工具消息按 `toolCallId` 查找 existing 再 update（chat.ts:2843-2846、2881-2885）；分页 prepend 按消息 id 集合去重（chat.ts:1428）；队列消息按 `queue_id` 记录"已出队"集合防 peer 消息重复入列（`dequeuedQueueIds`，chat.ts:711-712）。
- 事件→消息的合并在 store reducer 一处完成（单一 switch 同时服务 live 流和 resume 回放流），桥接层不做二次加工。

**设计规则：**
1. Socket 层保持"哑管道"：全局监听一次、按 session_id 路由到 handler map；业务状态全在 store。换 WS 库成本被隔离在 `api/hermes/chat.ts`。
2. 断线恢复的正确姿势不是缓存 delta，而是**服务端持权威缓冲 + 客户端重连后拉快照对账**（resume payload），UI 端只需一个 `applySnapshot`。缓冲设上限（200 事件）且仅运行中回放。
3. 区分瞬断与终断：对瞬断容忍（socket.io 自动重连 + resume），对终断（服务器主动 leave、auth 失败）才向 UI 抛错，避免网络抖动误报"连接失败"。
4. 去重不靠全局 seq，靠 per-entity 幂等键（toolCallId / message id / queue_id / approval_id）——事件流是多类实体交织的，seq 只解决顺序解决不了语义重复。
5. `queue_remaining > 0` 时跳过终态清理（不 close run handle、不卸载 handler），排队 run 复用同一连接与会话 handler（chat.ts:309-327、api 层 onRunCompleted 等）。
6. 若底层引擎是轮询（bridge），也要做 cursor 增量 + snapshot-then-cursor 的追赶协议，与 WS 层 resume 快照同构。

---

## 4. 移动端 / 窄屏适配

单一断点 `$breakpoint-mobile: 768px`（styles/variables.scss:178），CSS media query 与 JS `matchMedia('(max-width: 768px)')` 双轨并用。

- **JS 侧响应**：ChatPanel 维护 `isMobile = ref(false)`，由 `mobileQuery.addEventListener('change')` 更新（ChatPanel.vue:216-229）。面板拖拽宽度、localStorage 持久化在移动端全部禁用（ChatPanel.vue:129-155）。
- **首帧防闪**：`showSessions` 初始值**同步**读 matchMedia 而不是等 onMounted 翻转（ChatPanel.vue:74-83 有专门注释：异步初始化会导致窄屏首帧会话抽屉盖住聊天区）。移动端下会话列表变成绝对定位 overlay（z-index 120）+ backdrop，点开后选择会话即自动收起（ChatPanel.vue:212、2226-2260 样式）。
- **工具面板全屏化**：移动端右侧 files/terminal 面板改为覆盖整个内容区（`position:absolute; inset:0; width:100%`），resize handle 隐藏（ChatPanel.vue:2825-2843）；大纲面板跳转后自动关闭（ChatPanel.vue:102-105）。
- **视口高度**：不用 `100vh`，用 `--vh` 变量：默认 `1vh`，`@supports (height: 100dvh)` 时改 `1dvh`，根容器 `height: calc(100 * var(--vh))`（styles/global.scss:68-74；App.vue:109；ChatView.vue:84-88）——解决移动浏览器地址栏伸缩导致的 100vh 溢出。
- **iOS 输入缩放**：≤768px 时所有 input/textarea 强制 `font-size: 16px !important`，防止聚焦自动放大页面（styles/global.scss:285-293）。
- **刘海/安全区**：header、浮动元素用 `calc(16px + env(safe-area-inset-top))` / `env(safe-area-inset-bottom)`（ChatPanel.vue:2650、global.scss:276、TerminalPanel.vue:917、VoiceTranscriptOverlay.vue:136）。
- **消息区**：窄屏下 user/assistant/system 消息体 `max-width: 100%`，diff 卡片改 `calc(100vw - 24px)`（MessageItem.vue:2154-2179）；代码块、markdown 容器各自有窄屏 media 块（MarkdownRenderer.vue:835）。
- **输入框**：ChatInput 用 `isMobileChatInputViewport(window.innerWidth)` 监听 resize，移动端忽略用户自定义高度（不 clamp），并禁用 hover tooltip（`NTooltip :disabled="isMobileViewport"`）——触屏上 hover 提示只会碍事（utils/chat-input-height.ts:14-16；ChatInput.vue:87、1050 附近多处）。
- **侧边栏**：AppSidebar 窄屏默认收起（AppSidebar.vue:61），全局 hamburger 按钮 + backdrop 类在 global.scss 统一提供。

**设计规则：**
1. 断点值只定义一次（SCSS 变量），JS 侧硬编码 768 与之对齐；判断逻辑收敛到少量 composable/util（chat-input-height.ts），组件不各自猜断点。
2. 凡是影响布局的媒体查询状态，初始值必须同步求得（首帧正确），异步 onMounted 翻转=闪烁 bug。
3. 窄屏不是"缩小桌面"而是**改换交互形态**：并排栏 → overlay + 完成即自动关闭；拖宽 → 禁拖全屏。
4. 触屏差异要逐点处理：禁用 hover-only affordance（tooltip、hover 才显示的删除按钮改为常显）。
5. 移动端 web 三件套必修：dvh 视口、16px 输入防缩放、safe-area inset。

---

## 附：值得移植 vs 不必照搬

- **值得移植**：resume 快照 + 事件回放的会话切换协议；`userDetachedFromBottom` 跟底状态机与多帧 rAF；fence/think 修复层；"tool 平级消息 + toolCallId upsert + 底部活动条"三件套；服务端小环形事件缓冲；12s 列表轮询的门闸条件。
- **不必照搬**：4000 行单 store（按 sessions/stream/reducer 拆分）；模板里字符串 replace 生成 HTML（Agentus 若用 React 可直接组件化）；`session_id` 无 seq 的方案在 ACP 多后端下建议升级为 per-run runMarker（他们已有雏形 `runMarker`/`finishReason`，值得正式化）。
