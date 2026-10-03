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

## R46–R46b · 外层改回樱花访问认证（应用层 Basic 关闭）

**口径**：用户要的是「应用自身的用户名密码登录」+「SakuraFrp 的保护鉴权」两层 —— 不要应用层 Basic（能力与测试保留，只是不注入）。

**改动**
- `launch.py` 不再无条件注入：`basic_auth.txt` 为空或以 `#` 开头即视为关闭，并显式 `env.pop("AGENTSLOT_BASIC_AUTH")`（防止继承来的变量把锁"偷偷打开"）；启动时打印 `http basic: on/off`。
- 樱花侧写回 `extra = "auth_pass = REDACTED-PASS\nauto_https = auto"` 并重启 frpc 单元（`extra` 二次确认）。

**实测**
| 场景 | 结果 |
|---|---|
| 本地 / 局域网匿名 | `GET /` **200**（无 Basic 提示）、`/api/sessions` 401（登录门）、`/healthz` 200 |
| 隧道匿名 | **SakuraFrp 访问认证页**（"当前 IP REDACTED-IP 尚未完成访问认证"），非 401 |
| 樱花认证页 | 表单 `#pw` 访问密码 + 「记住我」+ 提交；提交后提示"认证成功, 现在可以关闭页面并正常连接隧道了" → **IP 级授权**，需重新访问 |
| 认证后重新访问（真浏览器） | 直接进驾驶舱（会话 Cookie 仍有效）→ rail 16 槽、**`● online`**、`/api/sessions` 200 |
| **关键验证：WebSocket 是否穿得过樱花那层** | **穿得过** —— 认证授权后 WS 正常建立并保持（这是双层方案能否成立的前提） |

截图：`screens/11-sakura-auth-page.png`（樱花认证页）、`screens/12-tunnel-via-sakura-auth.png`（隧道内的驾驶舱，页脚 `● online · REDACTED-TUNNEL`）。

**副作用记录**：`launch.py` 里 `env.pop` 之后，本地开发若想再开 Basic 只需取消 `basic_auth.txt` 注释里的那行；`auth-smoke` 的 48 项里 server D/E/F 用显式环境变量自起服务器，不受本次关闭影响（仍全绿）。

## R47–R48 · 产品化打磨（用户三条反馈）

**R47 聊天头图标化（对标 hermes-studio 的头部语言）**
- studio 的做法：左＝小圆形图标按钮 + 会话标题 + **工作空间徽标**（文件夹图标 + 末级目录名，完整路径放 tooltip）；右＝一串圆形图标按钮，每个都套 tooltip；图标全是内联 SVG（16px/1.5 stroke），没有图标库、没有大块文字控件。
- 我方改造：新增 `Icons.tsx`（16 个内联图标）→ 头部变成 `[☰][标题][📁 工作空间徽标][⚿ 待批徽标][spacer][🛡 模式][◔ 思考深度][◎ 用量环][■ 停止][✕ 关闭]`；模式/深度仍是原生 `select`（可访问性/手机原生选择器），但包在 `.seg` 里只显示「图标 + 当前值」，无边框、透明背景；原先占一行的 `effort · mode` trace 芯片**删掉**（两个下拉已经显示），信息并入用量环 tooltip；cwd 40 字符路径 → 末级目录徽标（点击复制）；`stop`/`close` 文字按钮 → 图标按钮 + tooltip；发件按钮 `⇥` → 图标。
- 实测（截 `screens/13-chat-head.png`）：头部高度 **46px**、单行不换行、只有 2 个文字控件（两个 select 的当前值）。

**R47b–R47e 滚动不再抢用户**（真 bug，非打磨）
- 现象：模型流式输出时手动上滑仍被拽回底部。根因两条：
  1. 判定阈值只有 **48px** —— 稍一上滑仍在窗口内，下一个 chunk 就把视图拉回底部；
  2. 只看**位置**不看**意图**：流式期间最新内容恰好长在视口下沿，位置判定永远"贴底"。
- 修法（studio 的 `userDetachedFromBottom` 思路）：`wheel`/`touchmove`/`PageUp` 等**手势即脱开**（不看位置）；贴底阈值放宽到 **140px**；脱开后**完全不再动视口**；出现「↓ 回到底部」圆形按钮，且脱开期间有新内容时亮新内容点；发送提示词会**主动重新跟随**（并保持 1.5s）；`load earlier` 前置分页时按高度差**保住阅读位置**（原来会整页跳动）。另删掉 `scroll-behavior: smooth`（流式时每次动画都在和读者抢）。
- 顺带修根因：store 追加/upsert 消息是**原地改数组**，引用不变 → 我依赖 `msgs` 的 effect 永不触发（"新内容点"不亮）。给 `SessionView` 加了 **`rev` 计数器**（每 ingeste 一行 +1），effect 改依赖 `v.rev`。
- 实测（`r47e_scroll.mjs`，11 轮内堆积出 2039px 溢出的长会话 + 慢速流式）：脱开后 10 次采样 **scrollTop 死钉 1974、gap 恒定 260**，期间**文本长度 2872→2931 字符持续到达**（确有新输出），按钮与新内容点都在；点击回底 → gap 0，2 秒后仍为 0（持续跟随）。**PASS**。
- 反例记录：早期两次"FAIL"其实是**测试设计错**：内容仅溢出 34px（我"上滑后离底 34px"仍在 140px 跟随区内，合理重新跟随）、以及用 `scrollHeight` 当增长指标（短词只加宽不加行）。改用文本长度 + 长会话后才测到真行为。

**R48 新建会话的工作空间选择器**（对标 studio 的 `FolderPicker` + `/api/hermes/workspace/folders`）
- 服务端新增 `GET /api/fs/dirs?path=`（`src/fs.ts`）：`~`/相对/绝对都归一到绝对路径；**只列目录**、跳过隐藏项、`stat` 跟随符号链接（断链跳过）、按名排序、300 条上限并回报 `truncated`；错路径 404 / 文件 400 均带明确 code。`recent` 列表来自 **sessions 表按 cwd 分组取最近**（不新建表）。该接口在 `/api` 下 → 同样受登录保护（实测匿名 401）。
- 前端 `WorkspacePicker.tsx`：路径输入（Enter 浏览）+ 面包屑（末尾 4 段 + 根）+ 文件夹列表（**单击＝选中**，行尾 `›` ＝进入）+ 最近使用 chips + 「use this folder」+ 当前选中路径回显。
- 实测（`r48_picker.mjs`）：`~` 列出 18 个目录、recent chips 5 个（来自历史会话）；单击选中→picked 更新、行高亮；`›` 进入→路径/面包屑更新；点面包屑回跳；输错路径→`no such directory: …` 且列表仍可用；Home 按钮回家目录；**用选中的目录真的建出了槽位**（rail 出现 `Hermes @ Workspace`）。
- 手机（390×844）：`scrollWidth == innerWidth == 390`（无横向溢出）、行高 44px、路径框 16px（iOS 不缩放）、弹窗完整可见。
- 截图：`screens/15-workspace-picker.png`、`screens/16-workspace-picker-mobile.png`。

**R49–R50 手机端头部与编辑器收尾**
- 首轮手机实测头部 **149px / 3 行**（图标行 + 两个下拉 + 环形/关闭各一行）——桌面单行的设计直接换行成了三行，比原来更乱。改为**两行定版**：`[☰ 标题 工作空间徽标]` + `[🛡模式 ◔深度 ◎用量环 ✕]`（`.head-spacer` 在窄屏变成换行符），并把窄屏下拉宽度收紧到 88px → 头部 **115px / 2 行**。
- 踩到的坑：窄屏已有规则 `.chat-head select { max-width: 45vw }`（为 44px 触控目标）与我的 `.seg select { max-width: 84px }` **特异性相同**、且它在文件后面 → 我的规则被吃掉。改成 `.chat-head .seg select`（更高特异性）才生效。教训：窄屏微调前先看同特异性后置规则。
- 编辑器：发件按钮从"文字长条"改成 **42×46px 方形图标靶**；窄屏占位文案缩短（原长句会换行被裁一半）。
- 复测：手机 `scrollWidth == innerWidth == 390`（零横向溢出）、行高 44px、文字框 16px（iOS 不缩放）；桌面头部 **46px 单行**、`[🛡 default][◔ medium][◎ 139/200k][✕]`。截图 `screens/13b-chat-head-crop.png`、`screens/17-mobile-chat-head.png`。

**R51–R55 工作空间重建：头部两图标 / 用量下沉 / 侧栏面板 / 语音双向**

读的是 **上游 v0.7.27（`ea5bcb9f`）** 而不是本地那份 v0.6.x 的 fork 快照 —— `packages/client` 目录已经改名，聊天头是两个 circle 图标按钮（`header-workspace-button` + `header-tool-toggle`），上下文用量是输入框上方的 `.context-usage-row` 小字 + `.context-bar`，输入框下排是 `.input-toolbar`（attach / reasoning-effort 滑块 / settings 下拉 / model）+ `.input-actions`（语音按钮 + 发送圆钮，运行中变停止）。我们照这个骨架重排，没有照抄任何代码。

- **R51 布局**（1280×860，真 Edge）
  - 头部：`h=46`、`children=[menu, title, spacer, icon, icon]`、`selects=0`（原来是 2 个下拉 + 环形用量 + 停止 + 关闭）。模式/深度/用量/停止全部移入输入区。
  - 输入区：`.usage-text = "ctx 8.4k / 1000k · 1% · 992k left"` + 细条，且 `usageAboveBox=true`（用量行在输入框上方 ✓）；`.composer-bar` 按钮 = `["attach","chat settings","dictate"]` + 发送按钮，`insideBox=true`。
  - 工作空间面板：`tabs=["files","terminal"]`、列出 11 个条目、`root=/…/worktrees/agentslot`、`noHScroll=true`；文件预览 `package.json` 867 字符。
  - 终端：`status="shell agentslot"`，发 `echo AGENTSLOT_TERM_OK; pwd` 后输出里能读到回显与 cwd（`sawEcho=true, showedCwd=true`）。
  - 设置弹层：4 组（permission mode / thinking depth / read replies aloud / dictation），无控制台报错。
- **R52 附件与语音（浏览器路径）**
  - 用 CDP `DOM.setFileInputFiles` 走真实 `<input type=file>`：草稿 chip 出现（`attach-probe.txt`），发送后气泡显示附件名、草稿清空、agent 正常回复（mock 把附加文本回显出来了 → 端到端确实带着内容进了 prompt）。
  - 朗读：`speechSynthesis` 可用，**203 个语音**；点回复上的朗读按钮 → `btnOn=true, synthSpeaking=true`（真的在念）；再点 → 停止（`false/false`）。
  - 听写（浏览器引擎）：点麦克风后 `hasRecognition=true`，但**旧实现下界面毫无反应** —— 因为 `SpeechRecognition.start()` 触发的权限弹窗是模态的，`onstart` 在弹窗关闭前不会来。修法：加 `requesting` 状态。复测 R55：chip 显示 `waiting for the microphone…` + 按钮 `rec` 亮 → 界面不再装死。
- **R53/R54 服务端语音**（用 `fake_voice_server.py` 冒充 OpenAI 兼容端点）
  - `/api/voice` → `tts.server=true, stt.server=true`；`/api/tts` → `200 audio/wav 6444 bytes`，端点日志收到 `{"model":"tts-1","voice":"alloy","input":"read this aloud"}`；`/api/stt` → `{"text":"fake transcript: round trip through /api/stt"}`（multipart 转发 ✓）。
  - 守卫：匿名 401、空文本 400、>4000 字符 400、空音频 body 400、未配置时 501 `not_configured`（不是 500）。
  - 浏览器里服务端朗读：点回复朗读 → 端点收到合成请求、按钮 `.on`（经 `<audio>` 播放）✓。
  - 浏览器里服务端听写：`getUserMedia` 被调用后**永远 pending**（OS 权限弹窗没人点）→ 同样靠 `requesting` 状态给出可读反馈；**另修**：录音拿到 0 字节时原来静默回 idle，现在明确报 `nothing was recorded — check the microphone`。合成麦克风（oscillator → MediaStreamDestination）能走到 `MediaRecorder` 构造 + `recording` 状态，但 Chromium 不给这种流发 `dataavailable`（探针里连 `start` 事件都没有），所以浏览器→服务端的最后一段实测由 `/api/stt` 的 HTTP 级验证补上，不当作已跑通。
- **R55 手机（390×844）**
  - 头部 `flexWrap=nowrap`、`h=51`、所有子元素同一行（`tops=[5,15,25,5,5]`）、3 个图标按钮（菜单 + 文件夹 + 面板）、`hScroll=390/390`。
  - 输入区：用量行在框上方、下排 `[attach, chat settings, dictate, send]`、触摸高度 38px。
  - 面板：全屏 sheet `width=390`、零横向溢出、文件列表正常；零控制台报错。
  - 踩坑：新面板/输入区的**基础样式写在文件末尾**，把前面的 `@media (max-width:720px)` 覆盖掉了（同特异性、后者胜）—— 手机规则必须放到文件最后，或写在基础样式之后。

**R56–R57 四条反馈：模型/强度拆按钮、真 markdown、上下文上限可改、"no voices" 误报**

先做的是「研究」而不是改代码：把 ACP 到底能给什么查清楚了（探针 `~/.hermes/cache/agentslot/probe_raw.mjs` 看原始帧，`packages/server` 里临时脚本看 SDK 到底留不留字段）。

- **ACP 事实（实测）**
  - `session/new` 的**原始响应**有四个顶层键：`sessionId, modes, configOptions, models`；`models = {currentModelId, availableModels[501]}（Hermes 实测）`。
  - 官方 TS SDK 1.5.1 的**类型**里没有 models（`AGENT_METHODS` 里没有 `session/set_model`），但**解析结果保留了该字段**（typed `newSession()` 实测含 `models`），且 `Connection.request(method, params)` 有**泛型重载**可直接发自定义方法 → `session/set_model` 实测返回 `{}`（Hermes `set_session_model` 已实现）。
  - `configOptions` 是 ACP 给旋钮的正式位置，SDK 类型里带 `category: "mode" | "model" | "model_config" | "thought_level" | string`（"for UX: placement/icons"）。**Hermes 不填 category**，只给 `reasoning_effort`，所以客户端必须 category 优先 + id 兜底。
  - **上下文上限：ACP 没有任何"设置"方法**。窗口是模型/服务端的属性，客户端能拿到的只有 `usage_update{used,size,cost}`。Hermes 侧的杠杆是"换模型"和 `/compress`（已作为斜杠命令公告）。
- **R57 结果**（1280×900 + 390×844，真 Edge，mock 席位）
  - 工具条：`[+][🧠 Medium ▾][⚙][🔲 Mock Fast ▾] …… [🎤][发送]` —— 与 studio 的"推理强度 / 设置 / 模型"三件套同形；设置里只剩 permission mode / read replies aloud / dictation（实测 groups 就这三个）。
  - 模型选择：列表 3 项、当前项高亮；**切换成功**（`Mock Fast → Mock Deep`，标签即时更新，无错误横幅）。真 Hermes 席位上列表是 **501 个模型**（按钮标签直接显示 `Alibaba Coding Plan · qwen3.8-flash`），走的是同一个 UI 路径。
  - markdown：`h3 ×1`、`ol li ×2`、嵌套 `ul li ×1`、表格 `6` 个单元格、`blockquote ×1`、**2 个带语言标签的代码块（ts/bash）+ 12 个 hljs 着色 span**、行内代码 3 处、链接 `target=_blank`。
  - **XSS 实测**：同一回合里让 agent 原样回显 `<img src=x onerror=…>` 与 `<script>alert('xss')</script>` → 渲染出的 `.md img = 0`、`.md script = 0`、`window.__xss` 未触发（markdown-it `html:false` + DOMPurify 双保险）。
  - 上下文上限：点用量行 → 「change window」→ 输 40000 → 行变成 `ctx 179 / 40k · 0% · 40k left (set)`（并注明"由你声明"）→ 「reset」回到 agent 报的 `200k`。ACI 说明文字也写在弹层里：ACP 改不了窗口，换模型才是真杠杆。
  - 朗读：不再出现 "no voices"（修法见下），按钮点击后 `speechSynthesis.speaking=true`，本机 203 个语音；再点即停。
  - 手机 390：零横向溢出，`[+][depth][⚙][model][🎤][send]` 全在一行，markdown 表格可横向滚动。
  - CI 断言从 31 → **39**（模型列表/切换/非法模型/缺参数、上限设置/回读/非法值/清除）。
- **"no voices" 的真因**：语音列表**不是**在模块加载时就绪的 —— Chromium 异步填充 `getVoices()`，`voiceschanged` 可能几秒后才来（甚至要等首次交互）。旧代码只读一次，于是"该浏览器没有语音"这句谎话盖在 203 个语音上。修法：读一次 + 监听 + 轮询（~10s 后停）+ 首次 `pointerdown` 再读；并且**只有真的没有 `speechSynthesis` 时才显示这句**。
- **模拟端补了两件事**：mock 现在公告 3 个模型与带 `category` 的推理强度（离线也能走这条渲染路径）；TS SDK 路由不到 `session/set_model`，所以 mock 在 stdin 上拦截该方法自答（真 agent 用 Python SDK，有这个方法 —— 实测 Hermes 可切）。

**R58 手机排版 + 工具条瘦身（发送按钮被挤出屏幕、深度去文字、模型分组）**

- **真因定位（这次先量再改）**：390px 下逐个控件量右边距 → 发送按钮 `right=407 > vw=390`，`.composer-bar` 的 `scrollWidth=398 > clientWidth=372`（溢出**被裁掉**而不是出现横向滚动），而 `documentElement.scrollWidth` 仍是 390。**所以 R55 那句"零横向溢出"是假阳性** —— 我的检查只看整页，没看单个控件。
- 修法（三件事一起做，才算真塞得下）：
  1. **思考深度去文字**：`icon + 7 段小刻度 + tooltip`，用**颜色**分档（Off→Max 从灰到红：`#7f8c98, #5fb3a1, #7fb069, #d9a441, #e8843c, #f0603f, #ff4d4d`），刻度按档位填充（High 实测 5/7 点亮、颜色 `rgb(232,132,60)`）。列表里的每一档也带同色圆点。
  2. **模型按钮只显模型名**：`Alibaba Coding Plan · qwen3.8-flash` → **`qwen3.8-flash`**（`shortModelName` 从 "·" 和 ":" 右侧取），列表里保留完整 id（tooltip）。
  3. **让控件会收缩**：`.tb-wrap{flex:0 1 auto;min-width:0}` + 手机上 `.tb-btn{max-width:34vw}` + 隐藏 chevron + 图标 36px；`.send-btn`/mic 固定不缩。
- **实测（390 与 320 两档都过）**：`offscreen=[]`、`barScrollW=clientW`、发送按钮 `right=377≤390 / 307≤320`、且 `elementFromPoint(发送按钮中心)` 命中它自己（**可点**，不是被别的元素盖住）。
- **模型列表按 provider 分组、可折叠**：实测真 Hermes **501 个模型 → 6 组**（Alibaba Coding Plan 25 / DashScope 200 / DeepSeek 2 / GitHub Copilot 17 / OpenRouter 57 / Qwen Cloud 200），当前 provider 排第一并默认展开；折叠/展开、过滤（输入 `claude` → 2 组 13 项）都实测过。
  - 踩到的坑：Hermes 给当前模型附的 description 是 `Provider: Alibaba Coding Plan · current`，我的 provider 解析把 "· current" 当成了 provider 名 → **同一个 provider 被拆成两组**（25 + 1）。修法：解析时剥掉结尾的 current/active/selected/default 标记。
- 截图：`33-mobile-toolbar.png`（390px 一行放得下）、`34-model-groups.png`（分组 + 当前高亮）、`35-model-groups-filtered.png`。

**R59 思考深度按钮再瘦身（用户：去掉图标，保留刻度）**
- 按钮内容从 `🧠 + 7 段刻度 + chevron` 改为**纯刻度**（无图标、无文字），宽度 61px → **43px**；tooltip/`aria-label` 仍带档位名（`thinking depth — High`），列表里每档仍有名字与同色圆点。
- 实测 390 与 320：`offscreen=[]`、`barFits=true`、发送按钮 `right=377/307` 且中心点命中自己；刻度 7 段、亮 5 段（High）、颜色 `rgb(232,132,60)`；`svgChildren=0` 确认图标已移除。截图 `33-mobile-toolbar.png`、`30-depth-picker.png`。

**R60 工具卡改单行（用户：字体小点、不要两行、多了省略、点开才看详情）**
- 改版：卡片高度 8px+两行 → **单行 28px（行高 21px）**；`🔧 + 标题 + ▸` 与第二行 `kind · status` 全部换成 `[状态圆点] 标题(省略号) [chevron]`，字体 13px → **11.5px**（等宽）；展开后才出现 4 段详情：`tool`（完整工具名）/`kind · status`/`input`/`output`（正文字体 11px）。
- 状态圆点：`in_progress/pending` → 琥珀色呼吸、`completed` → 绿、`failed/error/cancelled` → 红、未知 → 中性灰（不谎报失败）。
- 实测（mock `[tool]` 触发真实 tool_call + 审批 → 允许 → 完成）：
  - 折叠：`h=28`、`headH=21`（**单行**）、`secondLine=false`（`.st` 已无）、`ellipsis=ellipsis`/`nowrap`、标题过长时 `truncated=true`（长路径确实被省略）、`dot=ok`、chevron 在；卡片容器宽度不随标题变化（实测同一盒宽）。
  - 展开：`h=314`，labels = `tool / kind · status / input / output`，`tool` 行是完整标题，`kind · status` = `edit · completed`。
  - 手机 390：卡片宽 350 ≤ 390、无横向溢出、单行同样成立。
- 截图：`36-tool-card-collapsed.png`、`37-tool-card-expanded.png`、`38-mobile-tool-card.png`。

**R61–R62 工作空间默认路径 + 侧栏按工作空间分组 + 措辞去 slot + 会话 fork**

- **文件/终端默认路径**：面板根目录 = 会话的 `workspace || cwd`，服务端 `sessionRoot()` 同源。实测（会话工作空间 = `/tmp/agentslot-ws-b`）：文件面板 `path=/tmp/agentslot-ws-b`、终端 `pwd` → `/private/tmp/agentslot-ws-b`（macOS `/tmp` 是软链）。**改工作空间后终端必须重开**：`TerminalTab` 的 effect 依赖加上 `root`（shell 无法从外面 cd，只能新开一个）。实测改成 `agentslot-ws-a` 后 `pwd` → `/private/tmp/agentslot-ws-a`。
- **侧栏按工作空间分组**：组名 = 文件夹名（完整路径在 tooltip），组内 live 在前、cold 在后，当前会话所在组置顶并默认展开，可折叠；搜索时强制展开。实测 8 组（`liang`/`agent-dev-workspace`/`agentslot`/`agentslot-ws-a`/`agentslot-ws-b`/…），计数 `1/1`、折叠/展开正常。
- **措辞**：`new session`（原 new slot）、`search sessions…`、冷会话按钮只说 resume/delete、头部菜单 title=sessions、"No session selected"、工作空间弹窗里的 "this session"。**侧栏整块 innerText 里 `slot` 出现 0 次**（实测正则计数）。服务端两处面向用户的错误串（"resume the slot first"）也改了；README 里用户可见的 slot 措辞改为 session，并新增 **Naming** 段说明"UI 一律说 session，slot 只是项目名，产品可能改名"。
- **会话 fork（ACP `session/fork`）**：
  - 协议侧：请求 `{sessionId, cwd}` → 响应 `{sessionId, modes?, configOptions?}`；**SDK 类型里有（UNSTABLE）但 `AGENT_METHODS` 未路由**，所以走 `conn.request("session/fork", …)`。Hermes 公告 `sessionCapabilities.fork` 且实现了 `fork_session`（"deep-copy a session's history"）。
  - 实现：`mgr.fork(id)` = 冷会话先 resume → 在父连接上 fork → 新行入库（`acpSessionId` = fork 出来的 id，标题 `… · fork`，沿用父的 workspace/modes/options）→ 走既有的 resume 流程（新子进程 + `loadSession`）。父会话 busy 时拒绝（409），未知会话 404。
  - 实测：会话 → fork（`mock-2` ready）→ fork 的 fork（ready）；**Hermes 的 fork 会把父会话 9 条历史重放进新会话**（4 thought / 2 agent / 3 tool，实测 `loadSession` 后新会话 messages=9）→ 界面上 fork 出来就能看到之前的上下文；mock 无历史所以是空的（符合预期）。UI 入口在侧栏会话项上的 ⑂ 按钮，fork 后自动切到新会话，并**独立对话验证通过**（在新会话里发 prompt 得到自己的回复）。
  - CI 断言 39 → **45**（fork 返回新会话/新 agent 侧 id/继承工作空间/标题含 fork/出现在列表里/未知会话 404）。
  - 踩坑：mock 的 `loadSession` 对不认识的 sessionId 原来会**另起一个新 id**（真 agent 是从库里恢复同一个 id），于是"resume 一个 mock 会话后再 fork 它"报 `no such session: mock-N` —— 测试替身必须模拟"持久化恢复同一个 id"，否则假失败。
- 截图：`39-rail-groups.png`、`40-panel-workspace.png`、`41-fork.png`。

**R63 夜间批次：设置页 + 主题可配置 + 百炼语音（真 key 全链路）**

- **服务端（先测后再进 UI）**：
  - `settings.ts`（0600 JSON，密钥只以 `••••xxxx` 出行）/ `dashscope.ts`（TTS `SpeechSynthesizer` → 服务端取回 OSS 音频；批量 ASR 走 OpenAI 兼容 chat；流式 ASR 走 `api-ws/v1/inference` duplex）/ `hotwords.ts`（固定+动态热词）/ `voice.ts`（provider 路由：`dashscope | openai | browser`）。
  - REST：`GET/PUT /api/settings`、`GET /api/voice/models`（**问操作员自己的端点要型号表**，实测 261 个、识别类 6 个）、`GET /api/voice/hotwords`（热词预览）；WS `/ws/asr`（浏览器送 16k 单声道 PCM，服务端持有上游 socket）。
  - 实测（真 key，用 `.env` 里的 `DASHSCOPE_API_KEY` + `DASHSCOPE_BASE_URL`）：`/api/tts` → 200 `audio/x-wav` 165KB（RIFF）；把这段音频再喂 `/api/stt` → `"Agent Slot语音合成自测，龙安欢音色。"`（**TTS→ASR 往返**）；`welcome.mp3` → `"欢迎使用阿里云。"`。
  - `/ws/asr` 中继实测（`probe_asr_ws.mjs`，真音频 54336B PCM，17 帧）：`asr-ready{model:qwen-audio-3.1-asr-flash-streaming, hotwords:14}` → 3 个 partial（`换` → `欢迎于使用` → `欢迎于使用里云音`）→ `asr-final 欢迎使用阿里云。` → `asr-done`，全程 2.9s。
    - **踩到的真 bug**：`closing=true` 把上游 socket 的 close 也吞掉了 → 浏览器永远等不到 `asr-done`（脚本 40s 超时）。改成"done 只发一次，且不依赖谁关的 socket"（`task-finished` 或 close 都触发）。
  - **模型名事实**：用户给的 `qwen-audio-3.1-asr-flash-stream`（百炼 404 Model not exist）真实 id 是 `qwen-audio-3.1-asr-flash-streaming`；`qwen-audio-3.0-tts-flash` 默认音色 `longanhuan_v3.6` = 龙安欢。
- **浏览器实测（R63）**：齿轮打开设置页，5 个分区 `主题 / 语音识别（ASR）/ 热词 / 语音合成（TTS）/ 这个浏览器`；密钥显示 `已保存 ••••bd56（留空不改）`；模型表 261（识别类 6）；热词 15 个（固定 3 + 动态 12，动态那批是从本会话自己的历史里抽出来的 `read_file / execute_code / hermes_tools …`）。
  - **主题**（在活的 DOM 上量，不靠眼睛）：`data-theme=system` 时亮色系统 → `--bg=#f4f6f9`、`body` 背景 `rgb(244,246,249)`；切 `light`/`dark` → `#f4f6f9` / `#0c1116`，`color-scheme` 跟着变；换强调色 → `--accent-rgb` 从 `255, 180, 84` → `78, 201, 160`。
  - **流式听写（页面自己的代码路径）**：在页面里开 `/ws/asr` 送真音频 → `ready`（流式模型）→ 3 个 partial → `final: 使用阿里云。` → `done`，并带回 12 个热词；`resampleToPcm16(4800@48k → 1600@16k)` 比例正确（peak 32719）。
  - 返回聊天页正常，控制台错误 0。
  - 截图：`42-settings-page.png`、`43-settings-light.png`、`44-settings-accent.png`、`45-settings-hotwords.png`、`46-settings-tts.png`、`47-accent-violet.png`、`48-tts-result.png`、`49-tts-trusted-click.png`。
    - **补拍**：42/43 两张"亮/暗对照"其实都是亮的（这台 Mac 的系统就是亮色，"跟随系统"= 亮）——看起来一样的截图不算证据。补 `50-settings-dark.png` / `51-settings-light.png`，并用像素均值核对：`#161d24` vs `#f3f4f6`（**截图也要用数字验，肉眼读缩略图在这件事上不可靠**）。

**R64–R65 强调色与两条探针教训**

- 强调色要在**真实消费者**上量：设成紫色后侧栏 logo 计算色 `rgb(143, 123, 215)`、齿轮同色，恢复默认后回到 `rgb(255, 180, 84)`。第一次量错了对象（量的是禁用状态的保存按钮 → `rgba(0,0,0,0)`），**"量了个会变灰的控件"等于没量**。
- **TTS 试听按钮的探针写错了**：我轮询 `.set-mini` 的第一个（其实是"重新读取"，永远不会 disabled）→ 立刻返回、读到空 toast，看起来像 TTS 失败。改成轮询该行为特有的信号（toast / 错误条）并给足时间。
- 另：CDP 的 `Runtime.evaluate` **没有超时**，页面卡住脚本就永远挂着（第一版跑到 4 分钟没输出）。所有 evaluate 都套 `Promise.race` 30s。

**R66–R67 服务端 TTS 播放：一个真 bug + 一次诚实的失败**

- **真 bug（已修）**：`play() failed because the user didn't interact with the document first.` —— 浏览器只允许在用户手势（及其后很短的窗口）内开始播放，而百炼合成往返常常超过这个窗口。于是**真实用户点了按钮也听不到**，而合成其实成功。修法：点击时先 `AudioContext.resume()` 解锁，再用同一个 context 播（`decodeAudioData` + `BufferSource`），`<audio>` 元素只作兜底；朗读（speaker）的服务端路径也改走同一个播放器。
- **诚实记录**：R66 想用**可信点击**（`Input.dispatchMouseEvent`）验证"点了真的出声"，但 Edge 在这个 CDP 配置下**根本不派发合成输入**——`elementFromPoint` 命中按钮、坐标在视口内，而页面里的 click 监听器一个事件都没收到（`window.__clicks=[]`）。三次尝试（补 `buttons` / `scrollIntoView` / `Page.bringToFront`）都没用。**结论：浏览器内的"点击→出声"这一段没有实测**，改用能拿到的证据：
  - R67：页面里 `fetch('/api/tts')` → `decodeAudioData` 成功，**5.92s、48kHz 单声道、peak 0.54**（即浏览器确实拿到了可解码可播放的音频）；落盘的 `/tmp/agentslot-tts-自测.wav` 由 `ffprobe` 校验为 `pcm_s16le / 24kHz / mono / 3.44s`。
  - 服务端往返、剧本、解锁设计三点都有证据；"人点按钮能听到声音"这一条留给用户自己点一下确认。

**R68 CI：`voice-smoke`（47 项）**

- 自带一个**替身端点**（同时会说 OpenAI 兼容 `/v1/*` 与百炼原生 `SpeechSynthesizer` + `compatible-mode/v1/*`），两个 `HOME` 各起一个服务：空 `HOME`（真的"未配置"）与带 `~/.hermes/.env` 的 `HOME`（**env 引导路径**）。
- 覆盖：设置默认值/主题校验（非法 mode、非法 accent 均 400）/密钥掩码（响应体里不出现 `sk-`）/provider 非法 400/未配置时 `/api/tts` 501/`/api/voice/models` 分类/热词权重与上限/`.env` 引导（provider=dashscope + 来源路径）/百炼 TTS 请求体（model+voice+format）/**ASR 请求体带 `input_audio` data URL 与热词实体词表**/端点不可达 502/`settings.json` 0600。
- 这套断言**抓出两个真 bug**：① `listVoiceModels()` 只看 env 引导、忽略设置页刚存的端点 → 页面会报"未配置"（而同一页的 TTS 明明是通的）；② 不可达端点的 fetch 失败没被包装 → 报 500（我们的 bug）而不是 502（上游的问题）。两个都已修并回归。

**R70–R72 主题对比度：用户报的"亮色下黑底黑字"（一个类，不是一处）**

- **用户报的现象**：设置页亮色时，带底色的字段/路径是黑底、字几乎看不见。
- **根因（两条，都是我上一批次自己造的）**：
  1. **自引用自定义属性**：我先用 `#0a0f14` / `#101820` 写字面值，再用 sed 把字面值替换成 `var(--code-bg)` / `var(--on-accent)` —— 连**定义那一行本身**也被替换了，于是 `--code-bg: var(--code-bg);`、`--on-accent: var(--on-accent);`。CSS 里自引用 = invalid at computed-value time ⇒ 所有用到它的地方回退成初始值：**深色下代码块其实没有底色**，而选中态的分段按钮变成了"页面文字色压在琥珀底色上"（实测对比度 **1.34:1**）。
  2. **强调色一词两用**：`--accent` 同时当"填充色"和"文字色"。琥珀 `#d98116` 当文字压在浅面板上只有 **2.73:1**（链接、logo、小标签全糊）。
- **修法**：
  - 修掉两处自引用；`--on-accent` 归位。
  - 拆角色：**填充用 `--accent`**（其上文字用 `--on-accent`），**文字/链接用新的 `--accent-text`**（深色 `#ffb454`，亮色 `#9c5a08` → 4.65:1 起）。全文件 33 处 `color: var(--accent)` 一次性切过去。
  - 亮色 `--text-dim` 从 `#64748b`（在最亮的 raised 面上只有 4.09）压到 `#566475`（5.19）。
  - 内联代码芯片（`.set-hint code` / `code.inline` / `.md code`）改用跟随主题的 `--chip-bg` + 描边；**块级代码**保留深色"孤岛"（`--code-bg` + 新增 `--code-fg`），因为高亮配色本来就是给深底写的。代码块的语言标签/复制按钮改成固定可读色 `#9fb0c0`（不再靠 opacity 叠色）。
- **验法（这次不再靠眼看）**：写了一个**对比度扫描器**在页面里跑：对每个只含文本的元素，向上找到有效背景色（含 alpha 合成）、算 WCAG 对比度，低于阈值（正文 4.5 / 大字 3）就报出来。
  - 修前：设置页亮色 **14 项**不达标（最差 4.09，全是 `--text-dim` 系）、转录亮色 4 项（链接 2.73、代码块语言标签 3.34）、深色下选中分段按钮 **1.34**。
  - 修后：设置页/转录/整个应用（聊天+侧栏、工作空间面板、设置页、工具条弹层、登录卡）**亮暗两档全部 0 项**不达标 → `CONTRAST CLEAN`。
  - 截图：`52-settings-light-fixed.png` / `53-settings-dark-fixed.png` / `54-login-light.png` / `55-login-dark.png`，像素均值两两不同（`#f4f5f7` vs `#161e24` vs `#f3f4f6` vs `#0f1417`）。

**R73–R78 聊天页"换行太多"：真因是 CSS，不是 markdown 配置（用户报）**

- **用户现象**：聊天页感觉换行很多，"真实 markdown 真的换这么多行吗"，让对比 studio。
- **取证（先量再改）**：对渲染后的第一个 markdown 块量几何 + 数"幽灵行"：
  - 修前：`.md` 的 `white-space` = **pre-wrap**（从 `.msg .bubble` 继承），块与块之间的间距是 **39/33/33/35/35/35px**（行高只有 21px），`.md` 内有 **7 个纯空白文本节点**；总高 1003px = **48 视觉行**。
  - 修后：间距回到纯 margin（12/6/6/8/8/8），总高 652px = **31 视觉行**。**同样的内容少 17 行（-35%）**。
- **根因**：`.msg .bubble { white-space: pre-wrap }` 是为**纯文本**气泡（用户输入、meta 行）加的，但 markdown 气泡也继承到了。markdown-it 输出的 HTML 是**带换行排版**的（`</p>\n<p>`），在 pre-wrap 下每个块标签间的换行都变成一个**独立行盒**，于是每个段落边界凭空多一行。而且 `breaks:true` 已经把源换行变成 `<br>`，再保留换行字符就是双份。
- **studio 对比（说明不是"markdown-it 配置不同"）**：studio 的 `MarkdownRenderer.vue` 用的是**同样的 `breaks: true` + `linkify`**（外加 typographer/katex），它的 markdown 容器**不设 pre-wrap**（只在行内 `code` 上设），所以 studio 没有这个毛病。结论：**是我们的 CSS，不是渲染器配置**。
- **修法**：`.md { white-space: normal }`（代码块靠 `pre` 自己的 `white-space: pre`），`pre-wrap` 只留给没有 `.md` 子节点的气泡。
- **附带修掉的两个同类问题**：
  1. 围栏代码块末尾的换行会在块内渲染出一个**多余空行**（3 行代码画 4 个行盒的估算里其实一半是我把 padding 算进去了；改成直接数 DOM 行数后确认：trim 前 `rawLines=4`，trim 后 `rawLines=3 = boxLines=3`）。
  2. 侧栏"离线横幅"最后一块硬编码的深色主题颜色：`#ffb3a0` 压白底 **1.72:1**（顺手做主题对比度全扫时抓到）。改用 `--err` / `--err-rgb` 分主题取值。
  3. 冷会话整体 `opacity: 0.72` 会把标题/后端徽章压到 **3.26:1**；改为"只把标题调成次要色 + 虚线边框表示非活跃"，不透明度不再承担可读性。
- **回归验证（四个必须仍然成立的行为）**：
  - 软换行：一个 `<p>`、有 1 个 `<br>`、高 42px = **2 行** ✅（`breaks:true` 仍然生效）
  - 围栏代码：`white-space: pre`，3 行代码 → 3 个行盒 ✅
  - 纯文本气泡：用户 3 行输入仍是 3 行（`white-space: pre-wrap`，无 `.md` 子节点）✅
  - 主题对比度全扫（含合成出来的离线横幅/meta 提示）：亮暗两档 **0 项**不达标 ✅
- **永久化**：mock 的 markdown 样例里加了一行"单换行 → 应当换行"的段落（`A single newline here → / and the next line follows it.`），以后任何浏览器自测都会覆盖软换行这条。
- 截图：`56-md-before.png`（修前，48 行）、`58-md-fixed.png` / `60-markdown-fixed.png`（修后，25–31 行）。

**R79–R84 上下文长度：ACP 到底能做什么（用户问"实现了吗，参考 studio 但要用 acp"）**

- **先说结论**：显示与点击设置**上一批就已经实现**（输入框上方那行 `ctx 13k / 1000k · 1%`，点击开面板可改）；但"按 studio 的做法、且走 ACP"还差两块，这次补齐：**按模型记住** + **把 ACP 提供的上下文动作做成按钮**。
- **ACP 实测（r79：SDK 类型 + 对真 Hermes 开一条会话）**：
  - SDK 的路由方法只有 `session/{new,load,prompt,cancel,set_mode,set_config_option,list,delete,fork,resume,close,update,request_permission}` —— **没有**任何设置窗口/压缩的方法。
  - 会话里直接试：`session/set_context` / `session/compact` / `session/set_context_window` / `session/set_thought_level` → 四个全是 **Method not found**。
  - schema 里 `SessionConfigOption` 是**选择器**（select/boolean），`SessionConfigOptionCategory` 只允许 `mode|model|model_config|thought_level`（或自定义 `_x`）——**没有地方放一个整数窗口**。
  - `models.availableModels[]` 每条只有 `{modelId, name, description}`（实测 513 条），**不带窗口大小**。
  - **ACP 确实给的**：① `usage_update{used, size}` —— 真实一轮报 `{used:8403→12541, size:1000000}`（1M 是 agent 自己的值，权威）② `available_commands_update` 公告的命令里有 **`context`**（按角色统计消息数）与 **`compress`**（压缩上下文），因为命令就是 prompt，所以"用 ACP 动上下文"的正道是把它们做成按钮。
- **studio 的做法（读了 v0.7.27 的 ChatInput.vue / stores）**：`fetchContextLength(profile, provider, model)` + `setModelContext(...)`，数字**按 provider+model 存在服务端**；实时会话有用量时**优先用会话自己的数字**（`if (showSessionUsage.value) return`），配置值只是兜底；UI 是点击数字 → 弹窗 → 保存（校验 >0）。
- **本次实现（对齐 studio 的语义，机制走 ACP）**：
  1. 数字来源三级，UI 明说哪一级：**本会话声明 → 本模型记住的 → agent 的 `usage_update.size`**；`(本会话声明)` / `(模型记录)` 标在读数上。
  2. **按模型记住**：新表 `model_context(model_id, context_limit, updated_at)`；设置时勾"记到本模型"（默认勾，同 studio）；`reset` 只清本会话的偏差、**保留**模型记忆；另有"忘掉本模型记录"。切模型时 `#updateSession` 会刷新 `modelContextLimit`，所以换回来自动带回。
  3. **ACP 动作做成按钮**：`/compress`、`/context` 只在 **agent 自己公告过** 时才渲染（和思考深度/模型按钮同一纪律：不做假控件）；窗口 ≥85% 时读数旁边直接出现"压缩上下文"。
- **实测**：
  - mock（r82/r83）：声明 → 读数变 `(本会话声明)`、服务端行 `contextLimit=72000`、`/api/context-limits` 有记录；reset → 变 `(模型记录)`（记忆保留）；点"压缩上下文" → 最后一条用户消息是 **`/compress`**，agent 报告的占用 **140 → 28**。
  - **真 Hermes（r84）**：读数 `ctx 13k / 1000k · 1% · 987k left`（1M 来自它的 `usage_update`），面板 `window source: agent 上报（usage_update）`、`context window: 12539 / 1000000`，按钮就是它公告的 `压缩上下文 / 消息分布`（它公告 help,model,tools,context,reset,compress,steer,queue,version）。
  - CI：`workspace-smoke` 45 → **53 项**（按模型记忆的存取/切换带回/只忘当前模型/校验等）。
- **诚实记录（我自己的坑，两处）**：① 第一版脚本用 `.backend-pick button` 匹配后端时**漏了正则 `i` 标记**——"Mock Agent" 不匹配 `/mock/`，点击被静默跳过，于是"新建会话"根本没建，测试跑在旧会话上还一度看起来通过；② 同一 tick 里"合成 input 事件 → 立刻 click"会与 React 重渲染竞争，`set` 偶发不生效（人打字再点是两个事件，不受影响）。脚本改成：先等状态、再断言服务端真的变了，并打印尝试次数。

**R85 手机上点不开上下文浮层：它其实从来没显示过（根因 = 没有定位祖先）**

- 报告："上下文修改页支持了？为啥我手机上点击没显示出来啊"。先排除旧构建：`:8787` 与公网入口发的都是最新 dist（`index-BuIMbQsY.js`）。
- 复现（CDP 模拟 iPhone 390×844 + 触控）：`.usage-detail` **在 DOM 里**、`display:block`、`z-index:12`、文字全对 —— 但 `getBoundingClientRect()` = `[0, -178, 390, 170]`：整个浮层在**视口上方之外**，`elementFromPoint` 命中不到它。桌面 1440×900 同样 `y = -146`。**也就是说这个浮层在任何尺寸下都没显示过。**
- 根因：`.usage-detail { position:absolute; bottom: calc(100% + 8px) }` 的祖先链里**没有定位元素**（`.usage-row`、`.composer` 都是 static）→ 包含块退化成初始包含块 → `bottom:100%` 把它推到文档顶部之上。实测 `offsetParent === BODY`。
- 为什么 R82/R83 三轮"验证"没抓到：那几轮读的是 `textContent`、并用 JS `.click()` 点它里面的按钮 —— DOM 在、状态对、服务端行也对，只有**几何**没人看；截图也拍了，但我没看图、没量坐标（与 lessons 里"整页不滚 ≠ 控件在屏内"是同一类错误的变体）。
- 修（1 行真因 + 2 处同族）：
  1. `.usage-row { position: relative }` —— 让它成为浮层的包含块。
  2. `.usage-detail { width: min(560px, 100%); max-height: min(60vh, 420px); overflow-y: auto }` —— 桌面不再横向撑满，手机上不会超出屏高。
  3. 手机 390 宽下，模型/深度选择面板 anchored `left:0` + `width:min(86vw,420px)` 会挂出屏幕右侧（实测 134..469）→ 手机媒体查询里把 `.tb-list` 钉到视口（`position:fixed; left/right:8px; bottom:76px`）。
- 验收（`scripts/qa/popover-sweep.mjs`，需真浏览器，不进 CI）：**4 个浮层 × 2 个视口 = 8/8 在屏内**（修前 4/8：ctx 两个尺寸都 OUTSIDE，手机两个选择面板 OUTSIDE）；`offsetParent` 从 `BODY` 变为 `DIV.usage-row`；手机/桌面截图肉眼确认（`screens/phone-ctx-popover-open.png`、`screens/desktop-ctx-popover-open.png`）。
- 回归：typecheck 0 错误、auth-smoke PASS、workspace-smoke 53/53、voice-smoke 47/47、smoke PASS。

**R86 浮层"点外面不关"全套修复 + 手机触控目标审计**

用户："这些设置啊啥的体验不是很好啊，比如上下文设置中，为啥点击别处不会退出设置页呢……你再看看其他还有没有类似问题"。

- 现状盘点（动手前）：全站 **没有任何** "点外部关闭" 逻辑（`grep` 无 `document.addEventListener` 级别的关闭）；浮层只能靠再点一次触发器或内部 × 关掉。表格：
  | 浮层 | 点外部 | Esc |
  |---|---|---|
  | 上下文浮层 `.usage-detail` | ✗ | ✗（只在编辑态退编辑） |
  | 聊天设置 `.settings-pop` | ✗ | ✗ |
  | 模型/深度面板 `.tb-list` | ✗ | ✗ |
  | 斜杠命令面板 `.slash-palette` | ✗ | 部分（Esc 清空输入） |
  | 新建会话 / 工作区弹窗 | ✓（遮罩） | ✗ |
  | 手机抽屉 `.scrim` | ✓（遮罩） | ✗ |
  | 工具面板（手机整屏 sheet） | n/a | ✗ |
- 实现：新增 `packages/web/src/useDismiss.ts` —— `useDismiss(open, refs, onClose)`（**pointerdown + capture** 关外部；**Escape 走冒泡**，让内层控件先处理，例如上下文编辑器先退编辑态）+ `useEscape(active, onClose)`。接到：上下文浮层、聊天设置、模型/深度（`ToolbarSelect` 自持 wrap ref，触发器算"内部"所以再点仍是 toggle）、斜杠面板（点外部只隐藏面板、不吃掉输入的 `/…`，回到输入框自动再出现）、两个弹窗（Esc）、手机抽屉（Esc）、工具面板 sheet（Esc）。顺带：开一个浮层会关掉另一个；切会话自动关。
- 验收（新增 `scripts/qa/dismiss-sweep.mjs`，真浏览器手动跑）：**手机 33/33、桌面 27/27**，含每个浮层的"开 → 点内部不关 → 点外部关 → Esc 关 → 触发器仍 toggle"。
- 顺带做的触控审计（新增 `scripts/qa/touch-audit.mjs`，390×844）：修前 —— 上下文读数命中区 **260×17**、深度按钮 **23×30**、会话 fork **22×20**、主题色板 **22×22**；修后 **264×35 / 40×30 / 34×32 / 32×32**（`padding` 扩命中区 + 负 `margin` 保持布局不变）。设置页无横向溢出（`scrollWidth == innerWidth == 390`）。
- 回归：typecheck 0 错、auth-smoke PASS、workspace-smoke 53/53、voice-smoke 47/47、smoke PASS；浮层几何扫描 8/8 仍在屏内；上下文设置写回（r83）仍 `contextLimit=72000` 落库。
- 踩到的坑（已入 lessons）：① CSS 里 `.tb-btn { min-width: 0 }` 出现在手机媒体查询**之后**，把我在前面写的 `min-width:40px` 盖掉了 → 手机覆盖必须写在文件最后；② `while (el) el.click()` 等 React 重渲染会把页面 JS 卡死（我卡死过一个标签页）。

**R87 改用户名/密码：从"只能改环境变量 + 重启"变成设置页里改，立即生效**

用户："支持改用户名和密码吗现在"。查下来：**不支持** —— 凭据只有一条链路 `AGENTSLOT_USERNAME / AGENTSLOT_PASSWORD(或 _HASH)`，改完必须重启；`usingDefaultPassword` 还是开机快照。已做成功能。

- 服务端（`auth.ts`）：凭据读取链变成 **`<DATA_DIR>/credentials.json`（0600、`scrypt:<salt>:<hex>`）> 环境变量 > 内置默认**，与 voice/theme 的"设置文件 > env"同一形状；`changeCredentials()` 要求**当前密码**，校验用户名（1–32、无空格）与密码下限（4 位）；只改用户名时会把当前密码钉成哈希，防 env 值悄悄回潮。会话载荷里加了**凭据版本号（epoch）**：改一次所有旧 cookie 立刻失效。
- API：`POST /api/auth/credentials`（在需要登录的那半边），成功后给调用者**重签一张新 cookie**（本机不掉线，其他设备被登出）；`/api/auth/me` 改成实时状态并新增 `configuredUsername / credentialSource(saved|env|default) / minPasswordLen`。
- 前端（`SettingsPage.tsx`）：设置页第一张卡就是**账号**（用户名 / 新密码 / 再输一次 / 当前密码 + 更新账号），提示随来源变化：内置默认（`admin / 123456`，劝你改）／环境变量／已存 `credentials.json`；两次不一致、过短、没填当前密码都在前端先拦下。
- 测试：`scripts/auth-smoke.mjs` 48 → **76 项**（新增 28 项：匿名 401 / 当前密码错 401 / 过短 400 / 用户名带空格 400 / 什么都没改 400 / 失败时旧口令仍可登录 / 成功后旧口令 401、旧用户名 401、新对 200 / **另一台设备的 cookie 立刻 401**、调用者的新 cookie 仍 200 / `credentials.json` 0600 且只有哈希无明文 / `/api/auth/me` 来源翻成 `saved`、默认口令标记消失 / 只改密码时用户名不变 / 机器 token 不受影响 / **重启后以文件为准**）。
- 浏览器 E2E（新脚本 `m_account_e2e.mjs`，跑在**临时实例** :8901 + 独立数据目录，绝不碰线上账号）：14/14 —— 账号卡存在且是首张、四个字段齐、提示提到环境变量、两次不一致被拦、保存后 toast "已更新；其他设备需重新登录"、提示翻成 `credentials.json`、表单清空、**旧账号密码 401 / 新账号密码 200**、本机仍在线且 `/api/auth/me` 报 `operator` + `saved`（侧栏底部也变成了 "online operator"）。
- 线上实例实测：`GET /api/auth/me` → `configuredUsername: admin, credentialSource: default, usingDefaultPassword: true` —— 也就是你现在打开设置页，第一张卡会直接告诉你"现在是内置默认口令，对公网开放时务必改掉"。
- 回归：typecheck 0 错、auth-smoke PASS、workspace-smoke 53/53、voice-smoke 47/47、smoke PASS。
- 我踩的坑（已入 lessons）：改了前端**忘了 `npm run build`** 就去跑浏览器 QA —— 服务端发的是 `dist/`，源码改了不生效，E2E 第一轮直接找不到账号卡；另外判"是否仍登录"不能读 `document.cookie`（会话 cookie 是 HttpOnly，永远读不到），要问 `/api/auth/me`。

**R88 账户管理做完整（照 hermes-studio 的 AccountSettings 补）**

用户："你可以参考下 hermes studio 吗，完整实现下账户管理"。

先读参考（`~/.hermes/cache/studio-ref` @ `ea5bcb9f`）：studio 的账户面 = `AccountSettings.vue`（头像上传/随机/重置 + 改用户名 + 改密码，两个弹窗，当前密码必填）+ `UserManagementSettings.vue`（多用户，super admin）+ **锁定 IP 列表 + 单个/全部解锁**（`GET|DELETE /api/auth/locked-ips`，限流器 `recordPasswordFailure` 的可见面）。多用户与 AgentSlot 的"单操作员、一台机器一个驾驶舱"定位冲突，不做；其余全部补齐，并加一样 studio 没有但本产品必须要的东西。

- **会话注册表（新）**：会话是无状态签名 cookie，因此"谁登录着"原本答不出来、偷来的 cookie 也撤不掉。现在登录即登记 `<DATA_DIR>/sessions.json`（0600）：`jti / username / ip / ua / iat / exp / lastSeen`。接口：`GET /api/auth/sessions`（带 `current` 标记）、`POST /api/auth/sessions/revoke {jti}`（撤自己返回 400 并提示"这是登出"）、`POST /api/auth/sessions/revoke-others`。注册表对读取是"提示"、对存在性是"权威"：不在表里的 cookie 一律拒绝 —— 这才让撤销与"全部登出"是真的，并且**重启后依然成立**。升级路径：首次启动若注册表文件不存在，则把仍然签名有效的旧 cookie 一次性接管，避免升级即全员掉线。
- **锁定 IP 可见可解（新）**：`GET /api/auth/locked-ips` → `{locks:[{ip,fails,locked,retryAfterMs}], maxFails, lockMs}`；`DELETE /api/auth/locked-ips?ip=` 解一个、不带 ip 解全部（对齐 studio 的形状）。把自己锁在门外从"等 30 秒或重启"变成"点一下解锁"。
- **改用户名 / 改密码改成弹窗**（studio 形状）：每行密码框带"眼睛"显隐；两次不一致、太短、没填当前密码都在前端先拦；口径对齐 studio（用户名 ≥2、密码 ≥6）。
- **前端新增两张卡**：登录会话（设备/浏览器、IP、最近活跃、到期、"当前"徽章、撤销 / 登出其他设备 / 刷新；超过 8 条折叠成"还有 N 个"）与 登录失败锁定（IP、失败次数或剩余锁定时间、解锁 / 全部解锁 / 刷新 + 空状态）。解析 UA 成"Chrome · macOS"，时间显示成"3 秒前 / 7 天"。
- **测试**：`auth-smoke` 76 → **98 项**（新增：两次登录=两行且只有一行 current、匿名 401、撤自己 400、未知 jti 404、撤别的设备后该 cookie 在所有受保护路由 401 且 `/api/auth/me` 报匿名、调用者不受影响、注册表 0600 且不含 token、全部登出计数、**重启后仍列出且被撤的仍是死的**、锁定 IP 出现在列表且返回 429、解锁后能登录、解锁未知 IP 404、全部解锁计数）。浏览器 E2E（新 `m_account_panels_e2e.mjs`，临时实例 :8901）**24/24**：四张卡的顺序、会话卡两行且标"当前"、点撤销后另一台设备真的匿名（用**独立 browser context**造的第二台设备）、5 次失败→卡上出现"已锁定 30 秒"→点解锁→列表清空→能登录、改用户名弹窗、改密码弹窗（三个密码框 + 眼睛真的把字段切成 text）、两次不一致被拦、成功后新口令可登录旧口令 401、本机仍在线。
- 回归：typecheck 0 错、auth-smoke PASS、workspace-smoke 53/53、voice-smoke 47/47、smoke PASS。
- 我踩的坑（已入 lessons）：① **同一浏览器 profile 的两个标签页共享 cookie jar**，用它模拟"两台设备"永远是错的（后登录的覆盖前一个 cookie），所以第一轮 E2E 误判"撤销没生效"——真要多设备必须 `Target.createBrowserContext` 开独立上下文；② 点击后立刻读 DOM 拿到的是旧值（React 异步更新，眼睛切换那次又栽了一次）。

**R88b 手机上的账号卡有个"洞"（flex-basis 在列向变成高度）**

R88 的截图只看了桌面；补拍手机（390×844）时发现账号卡里"当前账号"标签和「panel-user 改用户名 改密码」之间有一大片空白（约 400px）。

- 真因：`.set-pair { flex: 1 1 320px }` 与 `.set-row > label { flex: 0 0 84px }` 是**桌面横向**下的宽度语义；手机媒体查询把 `.set-row` 改成 `flex-direction: column` 后，这两个 flex-basis 就变成了**高度**，于是标签自己撑成 84px、按钮组撑成 320px。
- 修：手机查询里补 `.set-row .set-pair { flex: 0 0 auto; }` 与 `.set-row > label { flex: 0 0 auto; }`（先修了前者，量出还剩 ~90px 才找到后者——两个都要显式复位）。
- 验收：手机整页截图里账号卡已紧凑（标签紧贴用户名+按钮）；E2E 仍 **24/24**；同一段覆盖在文件末尾，桌面不受影响（桌面截图复核）。
- 沉淀：lessons 补一条——**横向 flex 的 `flex-basis` 在列向布局里会变成高度，手机覆盖要显式 `flex: 0 0 auto`**。
