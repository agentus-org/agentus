# AgentSlot M1 浏览器自测日志（≥20 轮约束的执行记录）

规则：每轮记 **现象 → 复现 → 根因 → 修复 → 回归**。少于 20 轮 = M1 不算完成。
环境：server `:8787`（tsx watch）、web 由 server 托管 `packages/web/dist`、Edge over CDP（用户真实浏览器）。
本轮共 **26 轮**，命中 **12 个缺陷**（含 1 个整进程崩溃、1 个用户库损坏事故）。

| # | 轮次主题 | 结论 |
|---|---|---|
| 1 | 空状态 + WS 连接 | 🐛 B#1 |
| 2 | 侧栏会话列表 | 🐛 B#2 |
| 3 | 首发 prompt 流式渲染 | 🐛 B#3 |
| 4 | AC1 新建会话（三后端） | ✅ |
| 5 | AC2 真 Hermes 流式 | 🐛 B#4（环境向） |
| 6 | 权限/工具渲染（被打断） | → B#5 现场 |
| 7 | 子进程 home 隔离（事故复盘） | 🐛 B#5 修复 ✅ |
| 8 | 浏览器建会话"挂死"悬案 | 🐛 B#6（页面级） |
| 9 | UI 建会话复测（三后端 + isolated home） | ✅ |
| 10 | 浏览器侧 REST 计时 | ✅ |
| 11 | `[tool]`/`[plan]` 触发 | 🐛 B#7 |
| 12 | **AC3** 权限卡 → Allow → agent 继续 | ✅ |
| 13 | 工具卡实时状态 | 🐛 B#8 修复 ✅ |
| 14 | 模式切换 + 思考深度 | ✅ |
| 15 | **AC4** 并发三会话跨双后端 | ✅ |
| 16 | **AC5** 杀服务端 / 孤儿回收 / 历史留存 | ✅ |
| 17 | **AC6** 断线重连 | 🐛 B#9 |
| 18 | AC6 修复复测（前缀不丢） | ✅ |
| 19 | 非法输入（含 DELETE 未知会话） | 🐛 B#10（整进程崩） |
| 20 | 13.6KB 大 prompt + 崩溃复测 | ✅ |
| 21 | REST cancel 缺失 | 🐛 B#11 修复 ✅ |
| 22 | 权限超时（6s 实测）+ EADDRINUSE 僵尸 | 🐛 B#12 修复 ✅ |
| 23 | 子进程中途崩溃（[sink]） | ✅ |
| 24 | bogus permission requestId | 🐛 B#12 修复 ✅ |
| 25 | 窄视口移动端抽屉 | ✅ |
| 26 | 双客户端同会话广播 + resume 回放 | ✅ |

---

## B#1 — 服务重启后出现"幽灵会话"
- **现象**：server 重启（会话表已空）后页面仍显示旧会话内容，发消息毫无反应。
- **复现**：杀掉 server 重新拉起 → 浏览器不刷新 → `__cockpit.activeId` 仍指向已不存在的会话。
- **根因**：WS `sessions` 事件覆盖了列表，但 `byId` Map 与 `activeId` 没跟着裁剪；旧视图继续渲染内存里的消息。
- **修复**：收到 `sessions` 时按新列表裁剪 `byId`，`activeId` 已消失则置 null（回空状态）。
- **回归**：重启后页面回到空状态。

## B#2 — 侧栏空但 API 有会话（Service Worker 陈旧缓存）
- **现象**：`/api/sessions` 有 2 条，侧栏空白；控制台里是旧 bundle。
- **根因**：SW 用 cache-first 拦导航、缓存名无版本号，旧 SW 永不过期。
- **修复**：导航 network-first；缓存名带版本（v2）；`/api`、`/ws`、`/healthz` 一律不拦。
- **回归**：注销旧 SW 后 2 条会话正常渲染（含 modes / thinking depth / cwd）。

## B#3 — 消息重复（历史回放与实时事件都落库）
- **现象**：一条 agent 消息出现两遍（刷新后仍重复）。
- **根因**：重连/新建时 `GET /messages` 回放历史，同时 WS 又推同一批 `message`；前端无 `seq` 去重。
- **修复**：每会话 `seen: Set<seq>`，`#ingest` 前查重；`loadHistory` 整段重建时重置。
- **回归**：同 prompt 只渲染一份。

## B#4 — 真 Hermes 后端 401（环境向，非本仓 bug）
- **现象**：真 `hermes acp` 能建会话、能握手，prompt 回 `HTTP 401: Invalid API-key provided`。
- **根因**：当时 spawn 的 hermes 用的是 live runtime 的 home（其 key 对该 provider 无效）。
- **修复**：见 B#5；隔离 home 后复测通过（`thought`×6 + `agent`「收到」，分块流式）。

## B#5 — 子进程共享 live home，把用户真 state.db 搞脏（**最严重**）
- **现象**：跑一会儿真 Hermes 会话后，用户 live runtime 的 `~/.hermes/state.db` 报
  `sqlite3.DatabaseError: database disk image is malformed`，gateway 的 `hosted_room_worker` 连崩；
  用户另找 agent 用 `~/.hermes/state-db-backup-20261002-0503/` 恢复（现 `quick_check = ok`）。
- **复现**：`session-manager.ts` 用 `env: { ...process.env }` → 子进程 `HERMES_HOME` 未定
  （本机终端又继承 `HERMES_HOME=/Users/liang/.hermes`）→ `hermes acp` 回落真 `~/.hermes`
  → 与 gateway 同时打开同一 WAL 库。
- **根因**：三点叠加 —— ①继承 env 导致 home 不确定；②Hermes 链接的 SQLite 3.50.4 有 WAL-reset 损坏 bug
  （`~/.hermes/logs/errors.log` 明确点名，建议升 3.51.3+，Hermes 现自动降级成 `journal_mode=DELETE`）；
  ③两个进程同开一个 WAL 库。
- **修复**：AgentSlot 侧 fail-closed 隔离
  - `backends.ts` 增 `isolation: {homeVar, homeDefault, liveHome, allowEnv}`，hermes 默认 home = `~/.agentslot-test/home`；
  - `buildSpawnEnv()` **只认显式开关** `AGENTSLOT_HERMES_HOME`，继承来的 `HERMES_HOME` 只作 warning；
  - 解析结果 == live home → 抛错拒绝 spawn（除非 `AGENTSLOT_ALLOW_LIVE_HOME=1`）；
  - 隔离 home 若 Hindsight `profile` 仍是共享默认名 → 告警；
  - `/api/backends` 回传 `home/warnings/blocked`，界面显示 `isolated home: …`；
  - 测试床 `~/.agentslot-test/home`：派生自 live config，`mcp_servers: {}`、memory 关闭、kanban 不派发，`.env` 为 0600 快照。
- **回归（实测）**：`hermes acp --check` OK；子进程 `ps eww` 显示 `HERMES_HOME=/Users/liang/.agentslot-test/home`；
  `lsof -p <child>` 内 live home 命中 **0 条**；`AGENTSLOT_HERMES_HOME=~/.hermes` 被拒；
  只有 1 个 Hindsight daemon（生产那个）在跑。

## B#6 — 页面级"所有请求挂死"（服务重启后旧标签页）
- **现象**：旧标签页里 POST 建会话永不返回、modal 永远显示 "spawning…"；curl 同一接口 0.115s 返回。
- **复现**：页面跨过一次 server 被杀/重启，之后该页所有 fetch（含 `GET /`）都不落地；新标签页一切正常（4 个接口全 200）。
- **根因**：浏览器侧连接池被服务重启前的半死 socket 卡住；前端 REST 没有超时/重试/离线态，
  于是表现为"无任何反馈地永久等待"（`fetch('/api/backends')` 失败还会被 `.catch(()=>{})` 吞掉，
  modal 静默退化成只剩一个 Mock 按钮）。
- **修复**：`state.ts` 增 `#req()`（15s AbortController 超时 + 1 次重试）并把所有 fetch 换成它；
  失败置 `net: degraded`，侧栏顶部出 `⚠ 服务不可达 — 请求超时` + reload 按钮；
  WS `onopen` 时清降级态；modal 的 `loadBackends()` 失败会把错误显示出来而不是静默降级。
- **回归**：建会话 128ms；`net` 保持 ok；人为触发超时会显示横幅（逻辑同路径）。
- **旁注**：第 9 轮我先记的"8 秒建会话"是 CDP 探针延迟造成的假象，in-page 计时 128ms —— 已更正，不作为缺陷。

## B#7 — mock agent 的 TDZ 错误被 ACP 化成不透明 `-32603 Internal error`
- **现象**：发 `[tool]` prompt，UI 只出现一条 `meta: Internal error`，服务端零日志，回合不结束（busy 卡住）。
- **根因**：`mock/agent.mjs` 的 `wantTool` 在定义之前被使用（之前补 `[plan]` 块时把定义挤到后面）→
  抛 `ReferenceError` → SDK 把 handler 异常转成 JSON-RPC `-32603`，细节全丢。
- **修复**：触发器常量上移到 `prompt()` 顶部；同时服务端 prompt 失败路径统一走 `runPrompt()`：
  `console.error` 打印错误 + **agent stderr 尾巴**，写入一条 `meta: turn failed: …`，并补发 `turn-end`（避免 busy 卡死）。
- **回归**：`[tool][think][plan]` 一轮出 6 个 thought、1 个 tool_call、1 个 plan、16 个 agent 分块。

## B#8 — 工具卡实时停在 `pending`（刷新后才是 `completed`）
- **现象**：点 Allow 后工具卡仍显示 `edit · pending`；刷新页面（历史回放）才显示 `completed`。
- **根因**：服务端把 `tool_call_update` **upsert 进原行、保留原 seq**；前端第 3 轮加的 seq 去重
  把同 seq 的更新直接 return 掉了。回放路径清空 `seen` 重建，所以只有回放正确 —— 典型的"两路语义不一致"。
- **修复**：`#ingest` 只对 append-only 行做 seq 去重；`tool`/`meta`/`seq<=0` 行走 upsert 语义。
- **回归**：Allow 后 1.5s 内工具卡变 `completed`，无需刷新；最终文本/状态与服务端库一致。

## B#9 — 断线重连丢前缀（AC6 未达）
- **现象**：turn 中途掐断 WS，重连后 agent 文本从 `to: "r17…` 开始，断线前那 26 个字符没了。
- **根因**：`resume` 回放只发 `messagesAfter(lastSeq)` 的**尾段**，而前端 `messages` 事件处理是
  "清空重建"，于是尾段变成了全部。
- **修复**：协议加 `partial?: true` 标记尾段回放；前端 `partial` 走**增量 ingest**（seq 去重吃掉重叠），
  只有权威全量回放才重建。
- **回归**：断线前 26 字符存活，最终文本 193 字符 == 服务端存储；连接状态采样 `online → offline → online`。

## B#10 — `DELETE /api/sessions/<不存在 id>` 把整个服务端打崩（**最危险**）
- **现象**：DELETE 未知会话返回 200 `{closed: nosuchid}`，随后服务端进程直接退出
  （`Error: no such session: nosuchid` → `Node.js v25.9.0` 退出），所有 live 会话静默丢失。
- **根因**：`mgr.closeSession(id)` 是 async 函数，调用处既没 `await` 也没 `.catch` →
  未处理的 Promise rejection；Node 25 默认 `--unhandled-rejections=throw` → 未捕获异常 → 进程退出。
  而 200 响应已在 rejection 之前发出，所以"看起来成功"。
- **修复**：①该分支 `await` + 未知会话返回 404；②进程级 `unhandledRejection` / `uncaughtException`
  兜底**只在 listen 成功之后安装**（启动失败如 EADDRINUSE 仍要立刻崩，别变僵尸）；
  ③`httpServer.on("error")` → `process.exit(1)`。
- **回归**：DELETE 未知会话 → 404 且服务端存活；随后 13.6KB 大 prompt 正常流式；healthz 200。

## B#11 — REST 缺 cancel 端点（API 不对称）
- **现象**：`POST /api/sessions/:id/cancel` 返回 404，脚本化测试无法停一个 turn（UI 走 WS 才可以）。
- **根因**：只有 WS `ClientCommand.cancel`，REST 面漏了。
- **修复**：补 `POST /:id/cancel` 与 `POST /:id/permission` 两个 REST 孪生端点（未知会话 404）。
- **回归**：cancel 返回 200，agent 分块数 3 → 3（停住），会话状态回 `ready`。

## B#12 — 权限超时路径无人验证 + bogus requestId 静默成功 + EADDRINUSE 僵尸
- **现象 A**：`AGENTSLOT_PERM_TIMEOUT_MS` 不可配（写死 5 分钟），超时路径从没被实测过。
- **现象 B**：`/permission` 传不存在的 `requestId` 也返回 200（静默 no-op，无从判断是否生效）。
- **现象 C**：新装的 `uncaughtException` 兜底把启动期 `EADDRINUSE` 吞成"活着但没有监听"的僵尸进程。
- **修复**：A → 超时改成 env 可调（默认仍 5 分钟）；B → `respondPermission()` 返回 boolean，
  未命中 pending 时 REST 回 404；C → 兜底只在 listen 成功后安装。
- **回归**：`AGENTSLOT_PERM_TIMEOUT_MS=6000` 实测 —— 2s 时工具行 `pending`，10s 时 `completed`
  （超时自动 cancelled，回合继续，最终 20 个 agent 分块）；bogus requestId → 404；未知会话 → 404（原 500）。

---

## AC 对照（M1 收口）

| AC | 状态 | 证据 |
|---|---|---|
| AC1 建会话/选后端/指定 cwd | ✅ | 第 4/9 轮；modal 三后端 + `isolated home` 提示 |
| AC2 逐块流式（thought/message） | ✅ | 真 hermes：`thought`×6 + `agent`「收到」分块；mock 18 分块 |
| AC3 权限卡 → 允许 → 继续 | ✅ | 第 12/13 轮；Allow 后卡片消失、工具转 `completed`、回合结束 |
| AC4 3 会话跨双后端互不串线 | ✅ | 第 15 轮：2×mock + 1×real hermes 并发，无跨会话内容/ID 泄漏 |
| AC5 杀服务端无残留 + 历史留存 | ✅ | 第 16 轮：SIGKILL 后无残留；诱饵 pid 被 `reclaimOrphans()` 击杀；重启后历史消息仍在 |
| AC6 断线重连不丢消息 | ✅ | 第 17/18 轮：断线前缀存活、文本与服务端一致；双客户端广播事件数一致（26 轮） |

**已知未做（计划内，非缺陷）**：重启后"历史会话列表 + `loadSession` 恢复"属 M4
（现在 `/api/sessions` 已返回 `archived` 计数，但侧栏只列 live 会话）；Qoder 需 `qodercli login` 后实测。

## 复现命令速查

```bash
# 端到端冒烟（不碰真 CLI）
node scripts/smoke.mjs mock "hello"

# mock QA 触发器：prompt 文本里带这些标签
#   [tool]  -> tool_call + requestPermission 流程
#   [plan]  -> plan 条目
#   [think] -> agent_thought_chunk
#   [slow]  -> 每块 900ms（够掐 socket 做 AC6）
#   [sink]  -> 中途 process.exit（需 prompt 里有 >15 字符的长词）

# 双客户端广播
node scripts/dual-client.mjs <sessionId>

# 权限超时（秒级）
AGENTSLOT_PERM_TIMEOUT_MS=6000 npm run dev -w @agentslot/server
```