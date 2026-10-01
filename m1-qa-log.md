# AgentSlot M1 浏览器自测日志（≥20 轮约束的执行记录）

规则：每轮记 **现象 → 复现 → 根因 → 修复 → 回归**。少于 20 轮 = M1 不算完成。
环境：server `:8787`（tsx watch）、web 由 server 托管 `packages/web/dist`、Edge over CDP（用户真实浏览器）。

| # | 轮次主题 | 结论 |
|---|---|---|
| 1 | 空状态 + WS 连接 | 🐛 Bug#1 |
| 2 | 侧栏会话列表 | 🐛 Bug#2 |
| 3 | 首发 prompt 流式渲染 | 🐛 Bug#3 |
| 4 | AC1 新建会话（三后端） | ✅ |
| 5 | AC2 真 Hermes 流式 | 🐛 Bug#4（环境向，非 UI） |
| 6 | AC3 权限卡 + 工具渲染 | ⏸ 被 Bug#5 打断，待重跑 |
| 7 | 子进程 home 隔离（事故复盘轮） | 🐛 Bug#5 已修 ✅ |

---

## Bug#1 — 服务重启后出现"幽灵会话"
- **现象**：server 重启（空会话表）后，页面仍显示一个会话的内容，消息区是缓存快照，发消息毫无反应。
- **复现**：`ps` 里杀掉 server 重新拉起 → 浏览器不刷新 → `__cockpit.activeId` 仍指向已不存在的会话。
- **根因**：WS `hello/sessions` 覆盖了 `sessions` 列表，但 `byId` Map 与 `activeId` 没跟着裁剪；旧视图仍在渲染内存里的消息。
- **修复**：收到 `sessions` 事件时按新列表裁剪 `byId`，`activeId` 若已消失则置 null（回空状态）。
- **回归**：重启 server 后页面回到空状态并提示"新建会话"，无残留。

## Bug#2 — 侧栏空但 API 有会话（Service Worker 陈旧缓存）
- **现象**：`/api/sessions` 返回 2 条，页面侧栏是空的；控制台里 JS 是旧 bundle。
- **复现**：改前端重新 build → 强刷页面 → 仍加载 v1 缓存。
- **根因**：SW 用 cache-first 拦了导航请求，`CACHE` 名无版本号，旧 SW 永不过期。
- **修复**：导航请求改 network-first，缓存名带版本（v2），旧缓存 `activate` 时清理；`/api`、`/ws`、`/healthz` 一律不拦。
- **回归**：注销旧 SW + 清缓存后 2 条会话正常渲染（含 modes / thinking depth / cwd）。

## Bug#3 — 消息重复（历史回放和实时事件都落库）
- **现象**：发一条 prompt，界面里同一条 agent 消息出现两遍（刷新后仍重复）。
- **复现**：新建会话 → 发 prompt → 观察同 seq 内容重复渲染。
- **根因**：重连/新建时会 `GET /messages` 回放历史，同时 WS 又推同一批 `message` 事件；前端没有按 `seq` 去重。
- **修复**：每个会话维护 `seen: Set<seq>`，`#ingest` 前查重；`loadHistory` 时整段重建并重置 seen。
- **回归**：同 prompt 只渲染一份，刷新不重复。

## Bug#4 — 真 Hermes 后端 401（环境向）
- **现象**：真 `hermes acp` 会话能建、能握手，但 prompt 回 `HTTP 401: Invalid API-key provided`，以 `agent_message_chunk` 落库。
- **复现**：`POST /api/sessions {backend:"hermes"}` 后发任意 prompt。
- **根因**：当时 spawn 的 hermes 用的是 live runtime 的 home（`~/.hermes/.env` 里的 key 对该 provider 无效）；不是 AgentSlot 的协议层问题。
- **修复**：见 Bug#5 —— 隔离 home 之后本次实测：`thought` 6 块 + `agent` 1 块（"收到"），401 消失。
- **回归**：`GET /api/sessions/749f75a5/messages` → `{user:1, thought:6, agent:1}`，内容是流式分块而非一次性刷出。

## Bug#5 — 子进程共享 live home，把真 state.db 搞脏（**最严重**）
- **现象**：AgentSlot 里跑一会儿真 Hermes 会话后，用户 live runtime 的 `~/.hermes/state.db` 报
  `sqlite3.DatabaseError: database disk image is malformed`，gateway 的 `hosted_room_worker` 连续崩，
  需要另一个 agent 用备份目录 `state-db-backup-20261002-0503/` 做恢复。
- **复现**：`session-manager.ts` 里 `env: { ...process.env }` → 本机 shell 的 `HERMES_HOME` 未设置
  （或由 Hermes 运行时继承下来一个 live 值）→ 子进程 `hermes acp` 回落 `~/.hermes` → 与 gateway 同时打开同一个 WAL 库。
- **根因**：三点叠加
  1. AgentSlot 用了继承 env，子进程 home 不确定（未设置=默认 `~/.hermes`）；
  2. Hermes 侧链接的 SQLite 3.50.4 有 WAL-reset 损坏 bug（`errors.log` 明确点名，建议升 3.51.3+）；
  3. 两个进程同时开同一个 WAL 库 + 版本 bug = 真损坏。
  （另注：Hermes 自己检测到链接的 SQLite 3.50.4 有风险后，对 `state.db` 改用 `journal_mode=DELETE`
  而不是 WAL，作为规避 —— 见 `~/.hermes/logs/errors.log` 05:05 的 `hermes_state` 警告。）
- **修复**：AgentSlot 侧 fail-closed 隔离
  - `backends.ts` 增 `isolation: { homeVar, homeDefault, liveHome, allowEnv }`，hermes 的 `homeDefault = ~/.agentslot-test/home`；
  - `buildSpawnEnv()` 只认显式开关（`AGENTSLOT_HERMES_HOME`），**不认继承来的 `HERMES_HOME`**（继承值只作为 warning 报告）；
  - 解析出的 home 若等于 live home → 直接抛错拒绝 spawn，除非 `AGENTSLOT_ALLOW_LIVE_HOME=1`；
  - 隔离 home 里若 `hindsight/config.json` 的 `profile` 还是共享默认名 `hermes` → 告警（会共用生产记忆 daemon）；
  - `GET /api/backends` 回传 `home/warnings/blocked`，UI 与 CLI 可见。
  - 测试床 `~/.agentslot-test/home`：由 live config 派生，`mcp_servers: {}`（不拉起 4 个 Ekko MCP 子进程）、
    `memory: provider ''/enabled false`（绝不挂生产 Hindsight daemon）、`kanban.dispatch_in_gateway: false`；`.env` 为 0600 快照副本。
- **回归（实测证据）**
  - `HERMES_HOME=~/.agentslot-test/home hermes acp --check` → `Hermes ACP check OK`；
  - 新建真 hermes 会话后 `ps eww -p 86094 | grep HERMES_HOME` → `/Users/liang/.agentslot-test/home`；
  - `lsof -p 86094` 内 `.hermes/` 命中 **0 条**，只开测试 home 的 `state.db`/`logs/*`；
  - `AGENTSLOT_HERMES_HOME=~/.hermes` → 被拒（`isolation refused: ... would run against the live home`）。