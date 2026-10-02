# AgentSlot M1 浏览器自测日志（≥20 轮）

规则：每轮记 **现象 → 复现 → 根因 → 修复 → 回归**，并留下可复查的证据（curl 输出、DOM 状态、`ps`/`lsof` 结果）。
环境：server `:8787`（tsx watch，托管 `packages/web/dist`）、Edge over CDP（用户真实浏览器）、
mock 后端做无成本流水线验证、隔离 home 下的真 `hermes acp` 做真后端验证。

**总计 26 轮**：下半段（R8–R22）逐条留档于本文；上半段发生在日志落盘之前，其修复清单见文末"早前轮次"一节（同一批的 12 个缺陷均已实测修复）。

## 轮次总览

| # | 主题 | 结论 |
|---|---|---|
| 1 | 空状态 + WS 连接 | 🐛 Bug#1 幽灵会话 |
| 2 | 侧栏会话列表 | 🐛 Bug#2 SW 陈旧缓存 |
| 3 | 首发 prompt 流式 | 🐛 Bug#3 消息重复 |
| 4 | AC1 新建会话（三后端） | ✅ |
| 5 | AC2 真 Hermes 流式 | 🐛 Bug#4 401（环境向） |
| 6 | AC3 权限卡 + 工具渲染 | ✅（当时被 Bug#5 打断，R8 重跑） |
| 7 | 子进程 home 隔离（事故复盘） | 🐛 **Bug#5 已修** |
| 8 | AC3 权限卡 / 工具 upsert / plan | ✅ |
| 9 | Reject 路径 | ✅ |
| 10 | mode + effort 切换与刷新保持 | 🐛 Bug#7 不记活动会话 |
| 11 | `lastSeq` 正确性 | 🐛 Bug#8 恒为 0 |
| 12 | 服务重启后的侧栏 | 🐛 Bug#9 冷槽位不可见不可恢复 |
| 13 | AC5 孤儿回收 | ✅ |
| 14 | AC5 冷槽位恢复（resume） | ✅ |
| 15 | AC4 三会话并发跨后端 | ✅ + 🐛 Bug#10 create 超时重试会重复 spawn |
| 16 | AC6 WS 断线重连 | ✅ + 🐛 Bug#11 离线时指令被静默丢弃 |
| 17 | 手机视口 390×844 | ✅ + 🐛 Bug#12 头部控件被压扁 |
| 18 | PWA / 离线壳 | ✅ + 🐛 Bug#13 断连无横幅 |
| 19 | 错误路径 + 无障碍 | ✅ + 🐛 Bug#14 select 缺 aria-label |
| 20 | 真 Hermes 端到端 + 长文/代码块/滚动吸附 | ✅ |
| 21 | resume 后 mode/effort 选择器消失 | 🐛 Bug#15 loadSession 响应未采纳 |
| 22 | 会话排序 + 冷槽位列表上限 | 🐛 Bug#16 新建会话不在最上 / archived 无上限 |

---

## Bug#1 — 服务重启后出现"幽灵会话"
- **现象**：server 重启（会话表空）后页面仍显示一个会话内容，消息区是旧的，发消息无反应。
- **复现**：杀掉 server 重新拉起 → 浏览器不刷新 → `__cockpit.activeId` 仍指向已不存在的会话。
- **根因**：WS `sessions` 事件更新了列表，但 `byId` Map 与 `activeId` 没跟着裁剪，旧视图继续渲染内存快照。
- **修复**：收到 `sessions` 时按新列表裁剪 `byId`；`activeId` 若消失则置 null 并清掉记住的值。
- **回归**：重启后回到空状态并提示新建，无残留。

## Bug#2 — 侧栏空但 API 有会话（Service Worker 陈旧缓存）
- **现象**：`/api/sessions` 有 2 条，侧栏空；控制台里加载的是旧 bundle。
- **复现**：改前端重 build → 强刷 → 仍是 v1 缓存。
- **根因**：SW 对导航用 cache-first，缓存名无版本，旧 SW 永不过期。
- **修复**：导航改 network-first，缓存名带版本（v2），`activate` 清旧缓存；`/api`、`/ws`、`/healthz` 一律不拦。
- **回归**：注销旧 SW 后 2 条会话正常渲染（含 modes / effort / cwd）。

## Bug#3 — 消息重复（历史回放与实时事件双写）
- **现象**：一条 prompt 后同一条 agent 消息渲染两遍，刷新后仍重复。
- **根因**：重连/新建时 `GET /messages` 回放历史，WS 又推同一批 `message`；前端无 `seq` 去重。
- **修复**：每会话维护 `seen: Set<seq>`，`#ingest` 前查重；`loadHistory` 整段重建并重置 seen。
- **回归**：只渲染一份，刷新不重复。

## Bug#4 — 真 Hermes 后端 401（环境向）
- **现象**：`hermes acp` 会话能建能握手，但 prompt 回 `HTTP 401: Invalid API-key provided`，以 `agent_message_chunk` 落库。
- **根因**：当时 spawn 的 hermes 用的是 live home（`~/.hermes/.env` 的 key 对该 provider 无效），不是协议层问题。
- **修复**：见 Bug#5（隔离 home）；R20 用隔离 home 实测通过。
- **回归**：真 LLM 回合 → `thought`×5 + `agent`「收到」。

## Bug#5 — 子进程共享 live home，把用户真 state.db 搞坏（**最严重**）
- **现象**：AgentSlot 跑一会儿真 Hermes 会话后，用户 live runtime 的 `~/.hermes/state.db` 报
  `sqlite3.DatabaseError: database disk image is malformed`，gateway 的 `hosted_room_worker` 连续崩，
  需另一 agent 从 `state-db-backup-20261002-0503/` 恢复。
- **复现**：`session-manager.ts` 里 `env: { ...process.env }` → 子进程 `HERMES_HOME` 未设（或被运行时继承一个 live 值）→ 回落 `~/.hermes` → 与 gateway 同开一个 WAL 库。
- **根因**：三点叠加 —— ① 继承 env 导致 home 不确定；② Hermes 侧链接的 SQLite 3.50.4 有 WAL-reset 损坏 bug（`errors.log` 点名）；③ 单库双写 + 版本 bug = 真损坏。（Hermes 事后对 `state.db` 自动改用 `journal_mode=DELETE` 规避。）
- **修复**：AgentSlot 侧 fail-closed 隔离
  - `backends.ts` 增 `isolation { homeVar, homeDefault, liveHome, allowEnv }`，hermes 默认 `~/.agentslot-test/home`；
  - `buildSpawnEnv()` **只认显式开关** `AGENTSLOT_HERMES_HOME`，继承来的 `HERMES_HOME` 只作 warning；
  - 解析结果 == live home → 抛错拒绝 spawn，除非 `AGENTSLOT_ALLOW_LIVE_HOME=1`；
  - 隔离 home 的 `hindsight/config.json` 若仍是共享默认实例名 → 告警；
  - `GET /api/backends` 回传 `home/warnings/blocked`，新建会话弹窗直接显示；
  - 新增 `scripts/setup-hermes-test-home.py` 生成测试床（`mcp_servers: {}`、memory 关闭、`.env` 0600 副本）。
- **回归（证据）**：`HERMES_HOME=~/.agentslot-test/home hermes acp --check` → OK；
  子进程 `ps eww` 显示 `HERMES_HOME=/Users/liang/.agentslot-test/home`；
  `lsof -p <child>` 内 live home 命中 **0 条**，只开测试 home 的 `state.db`/`logs`；
  显式 `AGENTSLOT_HERMES_HOME=~/.hermes` → 被拒。

## Bug#7 — 刷新后不记得所在会话
- **现象**：在会话 A 里切了 mode/effort，刷新后落到了另一个（最早的）会话，看到的像是"设置丢了"。
- **复现**：`POST /api/sessions` 两条 → 切到第二条 → 刷新 → 落在第一条。
- **根因**：`activeId` 无持久化，`sessions` 事件回退到 `sessions[0]`；且这个"第一条"当时是最旧的（列表按插入序）。
- **修复**：`localStorage["agentslot.active"]` 记/恢复；服务端 `list()` 改按 `createdAt desc` 排。
- **回归**：切换后刷新仍停在原会话；API `modes.currentModeId` 显示 `accept_edits`、effort `high` 保持。

## Bug#8 — `lastSeq` 恒为 0
- **现象**：冷槽位与活会话列表里 `lastSeq` 全是 0，即使该会话有 25 条消息。
- **根因**：用 `messagesAfter(id, MAX_SAFE_INTEGER-1, 1)` 取"最新 seq"，条件是 `seq > after`，永远取不到行。
- **修复**：store 增 `maxSeq()`（`select max(seq)`），`list()` / `archived()` 改用它。
- **回归**：`archived` 里该会话 `lastSeq=25`，诱饵会话 `lastSeq=0`。

## Bug#9 — 服务重启后侧栏空、历史不可达
- **现象**：server 重启（tsx watch 很常见）后侧栏空白，磁盘上的历史会话完全看不见。
- **根因**：rail 只渲染内存中的 live 会话；DB 里有记录却没有入口（M4 尚未实现）。
- **修复**（M4-lite）：`GET /api/sessions` 同时返回 `archived`（DB 有、无进程，限 20 条）；
  `POST /api/sessions/:id/resume` 重新 spawn + `loadSession` + 回放存储的 mode/effort；
  UI 侧栏加 "cold slots" 区（虚线、⟲ resume）。
- **回归**：见 R14。

## Bug#10 — create 的超时重试会重复 spawn
- **现象**：并发轮里 hermes 建会话偶发拿不到响应（40s+），UI 侧 15s 超时后重试 → 会再起一个子进程。
- **根因**：`POST /api/sessions` 要等 ACP 握手（真 hermes 冷启 10–40s），而通用 `#req` 超时 15s + 重试 2 次；重试对非幂等写操作是错的。
- **修复**：`#req` 增 `{timeoutMs, retry}` 选项；create/resume 用 120s 且 `retry:false`。
- **回归**：hermes 建会话 201 成功（`pid` 有值、`acpSessionId` 有值），不再出现"点了两次起两个进程"。

## Bug#11 — 断线时指令被静默丢弃
- **现象**：WS 断着的时候点发送，界面把消息显示出来但服务端从未收到（切后台/手机锁屏很常见）。
- **根因**：`send()` 只在 `readyState === OPEN` 时发送，否则静默 return。
- **修复**：加有界出口队列（`prompt` / `respond-permission` 最多 20 条），`onopen` 时按序 flush，并提示"已排队，重连后自动发送"。
- **回归**：手动 `ws.close()` → 发 prompt（入队）→ 约 1.5s 自动重连 → 队列消息送达，服务端消息数 3→6。

## Bug#12 — 手机视口下头部控件被压扁
- **现象**：390×844 下标题/路径/两个下拉/stop/close 挤在一行，可点区域过小。
- **复现**：`Emulation.setDeviceMetricsOverride(390×844)` 后量 `.chat-head select` 与按钮尺寸。
- **根因**：移动端只写了抽屉与 `select max-width`，未处理换行与触控目标；输入框字号 <16px 还会触发 iOS 聚焦缩放。
- **修复**：移动块里头部 `flex-wrap` + 标题占整行 + 控件 `min-height: 34px`；
  composer 字号 16px、`min-height: 46px`、`env(safe-area-inset-bottom)`；
  权限卡按钮 `min-height: 40px`。
- **回归**：390px 无横向溢出（`scrollWidth == innerWidth`），抽屉在 -336px 外、菜单键显示，点击目标 ≥43px。

## Bug#13 — 与服务的连接断开时没有横幅
- **现象**：WS 断了页面只在 footer 有个小圆点，横幅（net-banner）不出现。
- **根因**：横幅条件只看 `net === "degraded"`，而它由 REST 失败驱动；纯 WS 掉线不改这个状态。
- **修复**：横幅条件改为 `net === "degraded" || conn === "offline"`，并按场景换文案（断线 → "正在重连（指令会排队）"）。
- **回归**：离线打开页面时横幅出现；恢复网络后 WS 自动重连、会话列表回来。

## Bug#14 — 两个下拉只有 `title`，没有 `aria-label`
- **现象**：自测脚本用 `aria-label` 找不到控件；读屏也无法播报。
- **修复**：mode / effort 两个 `<select>` 同时给 `title` 与 `aria-label`。
- **回归**：`aria-label` 选择器命中，尺寸检查可用。

## Bug#15 — resume 之后 mode/effort 选择器消失
- **现象**：从冷槽位恢复的会话头部没有 mode/effort 下拉（同后端的新会话有）。
- **根因**：`resume()` 只用了 DB 里存的 `modes/configOptions`（老行是 null），没有采纳 `conn.loadSession()` 响应里 agent 重新宣告的 modes/options。
- **修复**：采纳 `loadSession` 响应里的 `modes`/`configOptions`，再回写存储值到 ACP 侧。
- **回归**：resume 后 `modes.currentModeId=default`、`configOptions=[('reasoning_effort','medium')]` 都回来了。

## Bug#16 — 新建会话不在列表最上 / 冷槽位无上限
- **现象**：新开的会话排在中部（按内存插入序），且 archived 会把历史全部铺出来。
- **修复**：`list()` 按 `createdAt desc`（同刻按 `lastSeq` desc）；`archived(limit = 20)`。
- **回归**：新建会话立即出现在 rail 顶部；冷槽位最多 20 条并标注 `on disk · N`。

---

## 验收标准对照（实测）

| AC | 判据 | 结果 | 证据 |
|---|---|---|---|
| AC1 | 浏览器新建会话可选后端 + 指定工作目录 | ✅ | 弹窗列出 Hermes/Qoder/Mock，显示隔离 home；`POST /api/sessions` 201 带 `acpSessionId`/`pid` |
| AC2 | `agent_thought_chunk` / `agent_message_chunk` 逐块流式 | ✅ | 真 Hermes 回合 `thought`×5 分块 + `agent`「收到」；mock 一次 prompt 产生 20+ 条 seq |
| AC3 | 审批卡出现，点允许后 agent 继续 | ✅ | 卡片按钮 `Allow/Always Allow/Reject/Dismiss`；Allow → 工具 `pending→completed`；Reject → `failed` |
| AC4 | 3 会话横跨两后端互不串线 | ✅ | 并发跑 A/B（mock）+ C（hermes），逐会话检查消息文本无交叉 |
| AC5 | 杀服务后 `ps` 无残留；重启后历史还在且可续聊 | ✅ | 诱饵进程 pid 被 boot 回收（行转 `error`/`pid=NULL`）；冷槽位 resume 后 25→44 条消息且新回合可跑 |
| AC6 | 断开 WS 再重连，已渲染消息不丢 | ✅ | 断线时发 prompt 入队；重连后送达，渲染无回退、无重复 |

## 早前轮次（本文件落盘之前完成的，记录自 track.md 时间线；同一批 26 轮里的前半段）

这些轮次发生在日志文件尚未落盘时，下列缺陷均已修复并有当时的实测记录：

- **`DELETE /api/sessions/<不存在 id>` 触发 unhandled rejection 把整个服务端打崩**（且 200 已经发出）→ 改为 await + 404，并在 listen 之后加进程级兜底（启动失败仍 fail-fast）。**最危险的一个**。
- 前端 `seq` 去重把同 `seq` 的 upsert 行也吞掉（工具卡永远停在 pending）→ 去重按 `(seq, toolCallId)` 粒度。
- 断线重连回放丢前缀 → 回放事件加 `partial` 语义位：尾部合并而非整段重建。
- mock agent 的 TDZ 报错被 ACP 压成不透明的 `-32603` → 服务端补日志 + 子进程 stderr 尾巴 + `turn-end` 带错误。
- REST 缺 `cancel` / 权限应答端点 → 补齐。
- 权限超时硬编码 → 改成 env 可调，并实测 6s 超时路径。
- 伪造 `requestId` 应答静默 200 → 改 404。
- `.catch(() => {})` 造成的 UI 静默降级 → 加 `net: degraded` 横幅 + 请求超时重试（也就是 Bug#6/#13 的来源）。

## R27 — 真后端思考深度下拉（P1 联调，源码 hermes 测试床）

- 测试床：`AGENTSLOT_HERMES_CMD=~/.hermes/cache/agentslot/hermes-acp-src`（`uv run --project ~/Project/hermes-agent hermes` 的 wrapper）
  指向 fork 的 `yl-dev/merge-20261002-1558`（= thinking-depth + mode-persist 合并版）。
  `ps eww` + `lsof` 铁证：子进程跑的是源码仓 `acp_adapter`，`HERMES_HOME=~/.agentslot-test/home`，live `~/.hermes` 零 fd。
- 后端广播（官方 0.21.5 二进制此处是空数组）：`configOptions=[{id:reasoning_effort, type:select,
  options:none..max 七档(路由裁剪), currentValue:""}]`。
- UI：头部出现第二个下拉（aria="reasoning effort"，🧠 标签）；切到 High → WS `config` 命令 →
  服务端 `setSessionConfigOption` → 服务端状态回读 `currentValue:"high"`。
- 切档后真实 prompt「只回答两个字：收到」→ thought 分块 + agent「收到」流式正常（回合未被切换打断）。
- 冷槽恢复：close → `POST /resume` → `restored effort: ['high']`（hermes 侧 `loadSession` 把持久化的
  reasoning_config 重新广播，前端下拉复原）。**R27 PASS**
- 顺带修：resume 回放 configOptions 时 `currentValue===""` 也会被回推（"unset"不是选项值，可能被
  严格后端拒绝）→ 只回推非空选择。
- 顺带观察：tsx 热重启后旧 live 会话被按 pid 重挂但 metadata 空（不重连 ACP 回路）——M2 若做
  服务端热升级需把 boot 路径改为真正 resume；当前 SIGTERM 语义（杀会话+回收）不受影响。

## R28–R30 — AionUi 规格对齐（UI 升级 + 分页）

先精读 AionUi 的 ACP 规格（`docs/prds/conversations/acp/display.md`、`permissions.md`、`Messages/acp/*.tsx`），
挑出我们缺的四处，**自己实现**（学思想，不复制粘贴），顺手抓到并修掉一个真 bug。

### R28 上下文用量 / 斜杠命令 / 工具详情 / 单回合 trace（真后端）
- 服务端：新增 `usage_update` 处理（`usage:{used,size,cost,at}` 落库 + `usage` 事件）、
  `available_commands_update` 保留描述、`turn-start` 带 `trace`（只用会话真知道的 effort/mode，不臆造模型名）。
- 前端：头部用量仪表（8.4k/1000k，65%/85% 变色，只有 used 时降级显示）、斜杠面板（过滤/↑↓/Tab/Esc，
  空态明说"此 agent 未广播命令"）、工具卡可展开 input/output、trace chip、待批计数 chip。
- 实测（源码 hermes 测试床）：`ctx 8.4k/1000k` → 一轮后 `13k`；`/` 列出 hermes 六条真命令带描述；
  `/mo` + ArrowDown + Tab → `/model `；Esc 清空；工具卡展开显示输出；trace 显示 `mode default`。
- mock 也对齐：广播三条命令 + 每轮末尾发 `usage_update`（`MOCK_USAGE_SIZE` 可调），
  这样无真后端也能回归这两条路径。

### R29 手机视口（390×844，CDP 设备模拟）
- 无横向滚动；用量仪表在窄屏正常换行；斜杠面板 `10..380px` 完全落在视口内；
  抽屉开（left 0 + scrim）/ scrim 关闭正常。**PASS**
- 注：抽屉首次读数 `open:false` 是 React 渲染未落 + Edge 后台动画节流的读数假象，加延迟复测即正常
  （同 R23–25 的记录）。

### R30 长会话分页 + 侧栏搜索 —— **抓到真 bug**
- 造了 126 行的 mock 会话（6 轮），把页大小调成 5（`AGENTSLOT_HISTORY_PAGE`，便于实测）后：
- **Bug**：首屏历史用的是 `?after=-1`，语义是"从 replay 锚点**向前**取最旧的 500 行"——
  长会话打开时看到的是**最开头**的几轮，新的内容被静默丢弃；而客户端把响应的 `hasMore`
  （=还有更新的）误当成"还有更旧的"，于是"load earlier"出现一次就消失。
  根因是我们把一个 **replay 锚点接口**当成了 **分页接口**用。
- 修复：显式 tail 契约 —— `?tail=1`（默认）取**最新**一页 + `hasOlder`；`?before=<seq>` 向上翻页；
  `?after=<seq>` 仅作重连回放锚点。前端首屏改走 tail，`loadEarlier` 读 `hasOlder` 逐步 prepend
  （走同一 ingest/dedup 路径，`minSeq` 按行种类跟踪，WS 回放抢跑也不会重复）。
- 复测：25 次翻页取完全部 126 行 → 34 气泡 / 6 条用户消息 / **0 重复**，最早一轮与最新一轮同时在屏；
  侧栏搜索"paging"只剩命中项，无命中时显示"no live slot matches that search."。**R30 PASS**

## 已知遗留（不影响"可用"，但记档）
- 手机经局域网 **http://** 访问时浏览器不给注册 Service Worker（非安全上下文）→ 可加到主屏当快捷方式，
  离线壳要在 HTTPS 下才有；桌面 localhost 与 HTTPS 均已验证可用。
- Hermes 自身链接的 SQLite 3.50.4 仍有 WAL-reset bug（`hermes update` 才根治），
  现在只靠 Hermes 自动降级 `journal_mode=DELETE` 顶着。
- mini-markdown 只覆盖代码块/行内码/粗体/链接；表格、嵌套列表留给 M3。
## R31–R33 — 新界面能力 + 手机/PWA 复验（2026-10-02）

**R31 桌面新能力（真 Edge，CDP）**：上下文用量表 `ctx 161/200k`、每回合追踪行
`effort medium · mode default`、工具卡 `🔧 Write file …` + 展开后的 input/output
（`{"path":"./demo.txt",…}` / `wrote 24 bytes …`）、斜杠面板 `/help /mock /slow`（带描述与来源）。

**R31 抓到的真 bug —— plan 只渲染 1/3 项**（不是我们的代码）：
- 裸 JSON-RPC 探针证明 mock 线上发了 3 条 entries；经 `@agentclientprotocol/sdk@1.5.1`
  到达服务端只剩 1 条（唯一带 `priority` 的）。
- 根因：ACP 规范要求 `PlanEntry` 的 `content`+`priority`+`status` 全必填，SDK 对**数组项**
  是"逐项丢弃"而非报错（其自带测试 `zPlan.parse(...)` 就是这么断言的）。我们 mock 漏了
  `priority` → 被丢。真 hermes 合规（`acp_adapter/events.py` 固定补 `priority="medium"`）。
- 修复：mock 三件套补齐；坑记入 `docs/refs/aionui-acp-rules.md`。
- 复验 R32：`☑ read the failing test / ▶ patch the flaky timing assert / ☐ run full suite` 三项齐全。

**R32 手机视口 390×844**：无横向溢出；侧栏默认收起、`☰` 开抽屉（left 0 + scrim）、点 scrim 关闭；
发现顶栏下拉只有 **34px** → 低于 44px 触控标准。

**R33 修复后复验**：顶栏 select 44/44、ghost 按钮 44、发送键 46、权限卡按钮 8 个全 44；
斜杠面板移动端 44px 行 + 40vh 上限。PWA：SW `scope=http://127.0.0.1:8787/`、`active`、
缓存 `agentslot-shell-v2`；**断网后 reload 仍出壳**（logo + "服务已断开（指令会排队）" 横幅）。

## R34–R38 — 真 hermes 回归 + 冷槽位语义连修三处（2026-10-02 下午）

**R34 真 hermes（源码测试床）**：新建会话广播 `reasoning_effort`；顶栏切 High 生效；
prompt「只回答两个字：收到」→ 思考块 + 「收到」；用量表 **`ctx 13k/1000k`**（真 agent 上报
used/size，1M 窗口）；追踪行 `effort high · mode default`。

**R36/R37/R38 抓到三处真问题（都属"重启/关闭后信息丢失"类）**：
1. `#updateSession` 只持久化 status/pid/title，**不写 modes/configOptions/usage/commands** →
   运行期切的档位、累积的用量、agent 广播的命令列表在重启/关闭后全丢（AionUi F-DISPLAY-07
   明确要求用量持久化，我们此前没做到）。修：`?? row.*` 合并写回。
2. 冷槽位栏用 `listSessions(false)`（排除 `status='closed'`）→ **点 close 的槽位从界面消失**，
   与 close 提示词"转存为冷槽位可恢复"矛盾（真删除是冷槽位上的 ✕ purge）。修：`archived()`
   含 closed 行。
3. resume 时以 agent 重播的 currentValue 为准 → **记不住自身状态的后端会在每次 resume 把档位/
   模式悄悄重置**（mock 就复现了：high → medium）。修：以归档快照里的操作者选择覆盖同名选项，
   再回推给 agent；mock 的 `loadSession` 也改成"重播同一会话"以贴合真 agent 行为。
   证据（R38）：close 前后与 resume 后均为 `effort@high` + `mode=dont_ask`。

**顺带修复**：`WEB_DIST`/`DATA_DIR` 改按**文件位置**解析（此前按 cwd，`scripts/start.sh`
从仓库根启动会指向 `packages/server/web/dist` → 配上浏览器 SW 缓存 = 白页且无任何报错）；
启动时 dist 缺失会**大声告警**；mock 路径用 `fileURLToPath`（路径含空格不再 %编码）。

## R39–R44 · 登录鉴权（默认 admin / 123456，参考 hermes-studio）

**R39 界面速览实拍**：为 `track.md` §10 拍 6 张真 Edge 截图（真 hermes 槽 → 会话流 / 权限卡 / 完整回合 / 工具卡展开 / 手机抽屉 / 手机会话）。拍摄脚本 `shots{,2,3}.mjs`；顺带修正 `track.md` 时间线里一处漏换行。

**R40 登录门（真 Edge + CDP）**
- 匿名首屏 → 登录卡（`用户名` 预填 `admin`、密码、登录按钮、默认口令警告），错误密码 → `用户名或密码不正确`，正确 → 驾驶舱（rail 14 槽、WS `● online`）
- 页面内 `fetch('/api/sessions')` 无 Cookie → **401**；`new WebSocket('/ws')` 无 Cookie → **refused**（升级在握手前被拒）
- `document.cookie` 为空 → 会话 Cookie **HttpOnly 生效**（JS 读不到，也写不动）

**R41 登出与吊销**：点 ⏻ → 回登录卡；`/api/sessions` → 401；reload 仍在门内。
（设计点：无状态 Cookie 若只"清 Cookie"，登出后旧值直到过期仍然有效；故会话体带 `jti`，登出写入内存吊销集 —— 实测复用旧 Cookie 立即 401。）

**R42 手机登录（390×844）**：`scrollWidth == innerWidth == 390`（零横向溢出）、输入框 `16px`（iOS 不缩放）、登录按钮 `46.5px`（≥44）。

**R43 鉴权不破坏本职**：登录后建真 hermes 槽 → `configOptions=[reasoning_effort]`、`modes` 有 → 切 high → 流式回「在线」，trace `effort high · mode default`、`ctx 13k/1000k`、WS `● online`。

**R44 伪 Cookie（CDP 在网线上注入，JS 注入被浏览器拒掉正好证明 HttpOnly 起效）**：伪造签名段 → 首屏落回登录卡、`/api/sessions` 401、WS refused，且 **6 秒内 0 次 `/api` 请求**（客户端退避，不会对着门狂敲）。

**自动化矩阵** `npm run auth-smoke`（30 项，自带服务器 + 临时数据目录，已进 CI）：匿名 REST/WS 全拒、错口令 401、连续错 → 429（限流，连对的口令也先挡）、Cookie 属性（HttpOnly/SameSite；HTTP 下**不**加 Secure，否则局域网根本存不下）、篡改/手写伪造 → 401、WS 凭 Cookie 与 `?token=` 均可、机器令牌 Bearer 可用、登出吊销、短 TTL 实测过期 401、`AGENTSLOT_AUTH=off` 时匿名可用。另断言 `auth.token`/`auth.secret` 为 **0600**。

## R45–R45c · 公网隧道（SakuraFrp）+ 应用层 HTTP Basic

**隧道**：j 上新增 frpc 实例 `...:29355218`（隧道名 `agentslot`，TCP + `auto_https = auto`，本地 `192.168.0.109:8787`，公网 `REDACTED-TUNNEL`）。登记在 `~/Workspace/nat-dev-workspace/areas/sakurafrp-tunnels/README.md`。

**R45a 认证分层实测**
- j→Mac:8787 前置条件 OK（`/healthz` 200），隧道启动成功、online=true。
- 樱花自带的 `auth_pass` 实测**不返回 401**：未认证时返回 **HTTP 200 + "访问认证"页面**（IP 白名单制）。只看状态码会误判成"没挡"（我犯过一次，随后用响应体特征词核实）。对照：`openclaw` 也是认证页，`hermes_studio`（绑域名路径）直通应用。
- 决定分层：**移除**樱花 `auth_pass`，外层改成 AgentSlot 自身的 **HTTP Basic**（标准 401 + `WWW-Authenticate`，脚本可 `curl -u`），内层仍是操作者登录。

**R45b/R45c 浏览器端到端（真 Edge + CDP）**
- 裸访问隧道 URL → 自签证书拦一次（`NET::ERR_CERT_AUTHORITY_INVALID`）。
- 首次测试用 URL 内嵌凭据（`https://user:pass@host`）→ 应用能加载但**页内 fetch 全废**：`Request cannot be constructed from a URL that includes credentials`（Chrome 行为，非产品 bug）→ 改用正规 CDP：`Security.setIgnoreCertificateErrors` + `Fetch.enable({handleAuthRequests:true})` 响应 `Fetch.authRequired` 填凭据。
- 换新 origin（`dx./lt.REDACTED-TUNNEL`）严格复验：**匿名 → 1 次 Basic 挑战 → 应用加载 → 登录 admin → 驾驶舱 `● online`（WS 穿隧道成功）、rail 16 槽**；`/api/auth/me` 返回 `{who:"admin",kind:"session"}`。
- Cookie 走 HTTPS 隧道时为 `Secure: true / HttpOnly: true / SameSite: Lax` → natfrp 确实转发了 `X-Forwarded-Proto: https`，代码里的判定生效。

**自动化**：`npm run auth-smoke` 扩到 **40 项**（新增 server D：Basic 开启下匿名 `/healthz`、`/`、`/api` 全 401、挑战头存在、错口令 401、对口令 200、WS 无凭据拒、WS 有凭据 `hello`）。全绿。

## R45d–R45e · 基础认证改「只验密码」

**动机**：HTTP Basic（RFC 7617）协议上必然带用户名，但单人服务没有用户体系 —— 每次都要填用户名是无谓摩擦。改成只验密码后用户名随便填/留空。

**代码**（`auth.ts`）：`AGENTSLOT_BASIC_AUTH` 支持三种形式 —— `user:pass`（都验）、`:pass` / `pass`（只验密码）。**顺带修掉一个自设的坑**：旧解析器要求冒号下标 ≥1，`:pass` 会被判为"格式错误"从而**静默关闭整层认证**（看起来"配了却没生效"，实际是裸奔）——现在只要求密码非空。

**配置**：口令改为 `REDACTED-PASS`（与现有 nano_ssh/openclaw 等服务的 `auth_pass` 同口令，少记一个）。

**实测**
| 场景 | 结果 |
|---|---|
| 本机匿名 / 错口令 | 401 / 401 |
| 本机 `admin:REDACTED-PASS`、`:REDACTED-PASS`（空用户名）、`随便填:REDACTED-PASS` | 全 200 |
| 隧道外匿名 / 带正确口令 | 401 / 200（返回真实 `/healthz` JSON） |
| 隧道外 `whatever:REDACTED-PASS` | 200 |
| 浏览器（新 origin `yd.REDACTED-TUNNEL`，用户名随便填 `admin`） | 1 次挑战 → 登录页 → 应用登录 → 驾驶舱 **`● online`**（WS 穿隧道） |

**自动化**：`auth-smoke` 扩到 **48 项** —— 新增 server E（`:pass` 形式：匿名仍 401 即"没有静默关闭"、空用户名/任意用户名过、错口令 401、WS 通过）与 server F（裸 `pass` 形式）。全绿。
