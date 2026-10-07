# AionUi ACP 行为规则摘要（主代理亲读 PRD 提炼；子代理因 429 配额中断未完成）

> 来源：`~/Project/AionUi/docs/prds/conversations/acp/`（9 份 PRD，1798 行）。
> 本文件只记**对 Agentus 有约束力的行为规则**，不含代码。Agentus 采纳/调整见每条末尾。

## permissions.md (F-PERM)
1. **F-PERM-01 审批卡**：卡片必须含 操作类型 + 操作内容(title) + 选项(允许/始终允许/拒绝)。
   → 采纳：我们的 PermissionCard 三态按钮直接映射 ACP options.kind（allow_once/allow_always/reject_once）。
2. **超时自动拒绝**：30 分钟未响应自动 reject（AionUi 自己还没实现，只有 createdAt 预留）。
   → 采纳但收紧：Agentus 服务端 pending 权限 5 分钟超时 → `{outcome:"cancelled"}`（防会话永久卡死，design.md §8-4）。
3. **停止联动**：用户点"停止"时 pending 权限必须同时被取消。→ 采纳：cancel 路径 resolve 该会话所有 pending。
4. **并发多个请求按序展示**。→ 采纳：UI 按 createdAt 排队渲染。
5. "始终允许"仅当前会话生效，重置即清。→ 采纳：allow_always 记在 LiveSession 内存 Map，不落库。

## reliability.md (F-RELIABILITY)
6. 连接超时给明确提示，首次失败自动重试一次。→ 采纳：WS 重连指数退避；spawn 失败错误进 session.lastError + 红色 meta 气泡。
7. **AI 回复超时的"活跃即续命"规则**：持续输出会重置计时器；工具调用与权限等待期间不触发超时。
   → 采纳：Agentus 不做整回合硬超时（prompt 由 agent 自己负责），但 UI 上 running 态超过 3 分钟无任何事件时显示"仍在等待…"提示（仅提示不杀进程）。
8. 启动失败给友好提示（后端命令不存在/未登录）。→ 采纳：create() 的 catch 把 stderr 尾巴带进 lastError（已实现 stderrTail），qoder 未登录时提示 `qodercli login`。

## session.md / messaging.md（扫读要点）
9. 一条消息的流式 chunk 合并进**同一条** assistant 消息（不是每个 chunk 一个气泡）。→ 已实现：前端按 kind 聚合（见 web/store）。
10. tool_call_update 按 toolCallId upsert 合并，永不新增气泡。→ 已实现：store.upsertToolMessage。
11. 会话切换/刷新后必须能恢复到"正在跑的回合"的实时流（resume 回放）。→ 采纳：WS resume 带 lastSeq per session，服务端从 SQLite 补发（已实现），并广播当前 busy 态。

## config.md / display.md（扫读要点）
12. config options（如思考深度）在 newSession 响应里声明，UI 按 type 渲染控件。→ 已实现：ConfigOptionView select → 顶栏下拉。
13. 思考块默认折叠、流式期间自动展开、结束后按全局设置。→ 部分采纳：thought 块默认折叠、可点开（MVP 不做全局设置项）。

## 版权红线
本文件是规则提炼（思想），非逐字翻译；Agentus 代码不 derived 自 AionUi 源码文本，故 SPDX 头仅在未来真搬代码时添加。

## 坑：SDK 会静默丢弃"不合规的嵌套条目"（2026-10-02 实测）

`@agentclientprotocol/sdk@1.5.1` 的入站校验对**数组项**不是报错而是**逐项丢弃**
（`acp.test.js`: `zPlan.parse({entries:[...]})` 只保留通过校验的项）。实测证据：

- 原始线上（裸 JSON-RPC 探针）：`sessionUpdate:"plan"` 带 3 条 entries。
- 经 SDK：只剩 1 条 —— 唯一带 `priority` 的那条。
- 原因：ACP 规范要求 `PlanEntry` 的 `content` + `priority` + `status` **三者必填**；
  漏 `priority` 的条目被丢。同理适用于 `tool_call.content[]`、`locations[]` 等嵌套数组。

**对我们的意义**：界面侧完全看不到"丢了什么"，只会看到更短的 plan/更空的工具卡。
所以：① 自家 mock 必须严格合规；② 接入 Qoder 等第三方 agent 时，若 plan 项/工具输出
莫名变少，先怀疑对端字段缺失，用裸探针（`assets/raw_probe.mjs` 思路）对比线上与 SDK 侧；
③ 真 hermes 是合规的（`acp_adapter/events.py` 固定补 `priority="medium"`）。
