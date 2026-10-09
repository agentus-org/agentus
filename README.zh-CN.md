[English](README.md) | 简体中文

# Agentus

**让 agent 待在正轨上。** 一个面向会说 ACP 的编码 agent 的多会话 Web 驾驶舱：在浏览器里开多个会话，
每个会话背后是一个真实的 `hermes acp` / `qodercli --acp` 子进程，你可以从任何设备驱动它们。

> **红线：** UI 里**不包含任何智能**。没有 agent 循环，没有模型调用，没有 prompt 工程。服务端只做
> 六件事 —— 门禁、拉起子进程、转发 ACP JSON-RPC、把事件流推给浏览器、持久化 transcript、把权限请求
> 抛出来。推理全在 CLI 进程里。

```
[browser React SPA]  ──HTTP + WS──▶  [Agentus server]  ──ACP/JSON-RPC over stdio──▶  [hermes acp | qodercli --acp]
                                         · session registry (who runs, where, pid)
                                         · ACP client (ClientSideConnection)
                                         · event fan-out → WS, commands → ACP
                                         · SQLite transcript + resume
```

## 安装

**一条命令**（检查 Node、装 npm 上的包、不用 `sudo`）：

```bash
curl -fsSL https://raw.githubusercontent.com/agentus-org/agentus/main/scripts/install.sh | bash
```

```bash
# Node >= 22.5（存储用 node:sqlite；开发环境是 v25）
npx agentus                      # 或者 npm i -g agentus 然后直接跑 `agentus`
# 打开 http://localhost:8787，用 admin / 123456 登录（见下面「登录」），
# 然后「+ 新建会话」，选一个后端和一个工作目录
```

完整指南 —— 安装、参数、所有环境变量、登录、TLS、手机桥：
[`docs/installation.zh-CN.md`](docs/installation.zh-CN.md) · [English](docs/installation.md)。

`npx agentus` 在前台运行驾驶舱 —— Ctrl-C 停掉它，它会把 agent 子进程一起带走。参数：`--port 9000`、
`--data <dir>`、`--open`（起来后自动打开浏览器）、`--where`（打印服务端实际解析出的路径 —— 数据目录、
web bundle、配套 APK —— 然后直接退出，不启动任何东西）。

**npm 装不上的那个前置条件是一个 agent CLI**：`hermes acp`（把 Hermes 装到 PATH 上；`hermes acp --check`
可自检）或 `qodercli --acp`（先 `qodercli login`，否则 `newSession` 会以 `-32000` 失败）。没有它驾驶舱
照样能跑、照样能登录 —— 只是没有后端可以开会话。

你启动的第一个 slot 会使用**你自己的 agent 已经在用的**那个 Hermes home（`~/.hermes`），除非后端那一行
指定了另一个 —— 见下面的「HERMES_HOME」。

### 从 checkout 安装（开发）

```bash
git clone https://github.com/agentus-org/agentus.git
cd agentus
npm start                     # installs if needed, builds, serves (scripts/start.sh)
npm run dev -w @agentus/web   # front-end hot reload (Vite :5173, host: true → reachable over LAN)
npm run agentus               # the same CLI as `npx agentus`, straight from the checkout
```

**要改 Agentus 本身？** 自举开发手册在 [`docs/dev/`](docs/dev/README.md)：怎么在 live 旁边跑一个 dev 实例、
怎么用浏览器 sweep 证明改动有效、怎么发到 live、live 坏了怎么救。既是给人看的，也是给「丢给 coding agent
自己开发」用的。

`npm start`（→ `scripts/start.sh`）会检查 Node 版本，在 `node_modules` 缺失时用 `NODE_ENV=development`
安装依赖，在 web bundle 过期时构建，然后启动服务。用 `AGENTUS_PORT=9000 npm start` 换端口。

### 状态放在哪

默认 `~/.agentus` —— 里面有 `agentus.sqlite`（会话与 transcript）、`credentials.json`、`auth.token`
（机器凭证）、`auth.secret`、`tls/`、`settings.json`。首次启动时以 0700 创建，启动日志会打印它**以及
这个目录获胜的原因**：

| 顺序 | 规则 |
|---|---|
| 1 | `AGENTUS_DATA` 被设置时用它 —— 每个启动器和 dev/QA 实例都会钉住它 |
| 2 | `~/.agentus` 一旦里面有东西，或者仓库侧还没有任何数据时用它 |
| 3 | `<repo>/packages/server/.data` —— 早于这套布局的老 checkout |

规则 3 不是锦上添花：一个悄悄换了目录的安装会以空的会话列表启动，那读起来完全就是「我的会话没了」。
要迁移这样的 checkout，用 `AGENTUS_DATA=~/.agentus` 启动一次即可。`agentus --where` 会打印服务端解析
出的结果，而不用你自己猜。

### 后端

| id | 命令 | 说明 |
|---|---|---|
| `hermes` | `hermes acp` | 需要 PATH 上有 Hermes 安装（`hermes acp --check`） |
| `qoder` | `qodercli --acp` | 需要先 `qodercli login`，否则 `newSession` 以 `-32000` 失败 |
| `mock` | `node packages/server/mock/agent.mjs` | 离线 dev/QA：假流式、权限请求、crash/plan/tool 触发 |

加一个后端就是 `packages/server/src/acp/backends.ts` 里的**一行**。协议层永远不动。

### 环境变量

| 变量 | 默认值 | 含义 |
|---|---|---|
| `AGENTUS_PORT` | `8787` | 服务端口（从不读取裸 `PORT` —— 这个名字在共享主机上被污染） |
| `AGENTUS_DATA` | `~/.agentus` | 状态所在；完整顺序见「状态放在哪」（已有数据的老 checkout 上是 `<repo>/packages/server/.data`） |
| `AGENTUS_HERMES_CMD` | `hermes` | hermes 后端要拉起的二进制 |
| `AGENTUS_QODER_CMD` | `~/.local/bin/qodercli` | qoder 同上 |
| `AGENTUS_HERMES_HOME` | `~/.hermes` | 未指定 home 的那一行所用的默认 `HERMES_HOME`（运维者自己的 home） |
| `AGENTUS_PERM_TIMEOUT_MS` | `300000` (5 min) | 权限请求自动取消前等待多久 |
| `AGENTUS_HISTORY_PAGE` | `500` | transcript 分页大小（测试里也会调小以覆盖分页路径） |
| `AGENTUS_TERM_PTY` | 未设置 | `1` = 工作区终端走 Python 标准库 `pty`（真 tty；需要 `python3`）而不是管道 |
| `AGENTUS_TERM_CMD` | 未设置 | 完全覆盖终端命令行（例如 `socat …`），空格分隔 |
| `AGENTUS_TLS_PORT` | 存在证书时 `8443`，否则关闭 | **第二个监听器，TLS** —— 公网隧道指向的那个（`0` 关闭它） |
| `AGENTUS_TLS_CERT` / `AGENTUS_TLS_KEY` | `<AGENTUS_DATA>/tls/{cert,key}.pem` | 该监听器的证书材料（见 `scripts/make-cert.sh`） |
| `AGENTUS_TTS_BASE_URL` | 未设置 | **服务端**语音合成的 OpenAI 兼容 base（`…/v1`）。未设置 = 只用浏览器语音 |
| `AGENTUS_TTS_API_KEY` / `AGENTUS_TTS_MODEL` / `AGENTUS_TTS_VOICE` | – / `tts-1` / `alloy` | 同上 |
| `AGENTUS_STT_BASE_URL` | 未设置 | **服务端**转写的 OpenAI 兼容 base。未设置 = 只用浏览器识别 |
| `AGENTUS_STT_API_KEY` / `AGENTUS_STT_MODEL` / `AGENTUS_STT_LANGUAGE` | – / `whisper-1` / – | 同上 |
| `DASHSCOPE_API_KEY` / `DASHSCOPE_BASE_URL` | – | 百炼 (DashScope) 凭证。既从进程 env 读，**也**从 `~/.hermes/.env` 读，因为服务端通常是从一个普通 shell 启动的 |

语音/主题变量只是**引导值**：设置页（侧栏里的 ⚙）才是 provider、endpoint、key、模型、热词表和配色的
所有者，它把这些存进 `<AGENTUS_DATA>/settings.json`（0600，key 从不回传给浏览器）。以页面里说的为准；
env 的存在只是让一个全新的 checkout 在没人打开设置页之前就能用。

## 登录

驾驶舱默认在登录后面 —— 这东西会拉起往你磁盘上写东西的进程，所以一个开放的端口就是一个随时会发生的
远程 shell。

```
username: admin
password: 123456     (default — change it)
```

**在应用里**改：Settings → 账号（第一张卡片）接受新的用户名和/或新密码，立即生效，并写入
`<DATA_DIR>/credentials.json`（0600，scrypt 哈希 —— 磁盘上没有明文）。改密码会让其他所有会话失效；
发起改动的那台设备会拿到一个新 cookie，所以它保持登录。任何改动都需要当前密码，包括只改用户名。

`AGENTUS_USERNAME` / `AGENTUS_PASSWORD` / `AGENTUS_PASSWORD_HASH` 仍可作为引导：它们是应用的起
点，一旦你在 账号 卡片里保存了东西，从那以后就是文件说了算（和语音、主题一样的「设置文件 > env」顺序）。
只改密码会把当天的密码固化成哈希，这样 env 里的值就再也不能悄悄回来起作用。删掉 `credentials.json`
即可回退到环境变量。

账号管理住在 Settings → 账号（形状与 hermes-studio 的 AccountSettings 相同，去掉了多用户部分 —— 这个
驾驶舱只有一个运维者）：

| 卡片 | 做什么 |
|---|---|
| **账号** | 改用户名或密码（各在一个小模态里，需要当前密码） |
| **登录会话** | 每个持有会话的浏览器和脚本：客户端、IP、最近活动、过期时间。可撤销一个，或「登出其他所有」。改密码会对其他所有会话一次性做同样的事。 |
| **登录失败锁定** | 登录限流器，可见：哪些 IP 被锁、锁多久，带 解锁 / 全部解锁 —— 这样把自己锁在自己的驾驶舱外面是一键问题，而不是要重启 |

会话是无状态 cookie，所以服务端在 `<DATA_DIR>/sessions.json`（0600）维护一份索引。它对于显示是参考
性的，但对于「是否存在」是权威的：不在索引里、或被撤销的 cookie 会被拒绝 —— 这才让撤销和「登出所有
设备」是真的，并且它能撑过重启。从旧版本升级时，会一次性收编已经存在的 cookie，而不是把所有设备踢下线。

登录后面的端点：`POST /api/auth/credentials`、`GET /api/auth/sessions`、
`POST /api/auth/sessions/revoke`、`POST /api/auth/sessions/revoke-others`、
`GET|DELETE /api/auth/locked-ips`。

刻意存在两种凭证：

| 凭证 | 怎么传 | 谁用 |
|---|---|---|
| **session cookie** | `HttpOnly` + `SameSite=Lax`，HMAC-SHA256 签名，7d | 浏览器（由 `POST /api/auth/login` 下发） |
| **machine token** | `Authorization: Bearer *** 或 `?token=<t>` | 脚本、CI、启动器 —— 从 `<DATA_DIR>/auth.token`（0600）读 |

cookie 用 `HttpOnly` 而不是 `localStorage` 里的 token，并且它会顺带搭上 WebSocket 握手。`/api` 下的
一切都对匿名调用者关闭；应用外壳、它的静态资源、`/healthz` 和 `/api/auth/*` 保持开放，好让登录页本身
能加载。`scripts/*.mjs` 会自动读取机器 token（`scripts/lib/auth.mjs`）。

认证相关环境变量：

| 变量 | 默认值 | 含义 |
|---|---|---|
| `AGENTUS_AUTH` | `on` | `off` = 完全不登录（本地折腾用；启动日志会骂你） |
| `AGENTUS_USERNAME` | `admin` | 运维者用户名 |
| `AGENTUS_PASSWORD` | `123456` | 运维者密码（env 里是明文） |
| `AGENTUS_PASSWORD_HASH` | — | `scrypt:<salt>:<hex>`；设置后优先于 `AGENTUS_PASSWORD` |
| `AGENTUS_SESSION_TTL_MS` | 604800000 (7d) | 会话有效期 |
| `AGENTUS_AUTH_SECRET` | `<DATA_DIR>/auth.secret` | cookie 签名密钥（0600，自动生成） |
| `AGENTUS_AUTH_TOKEN` | `<DATA_DIR>/auth.token` | 机器 token（0600，自动生成） |
| `AGENTUS_LOGIN_MAX_FAILS` / `AGENTUS_LOGIN_LOCK_MS` | `5` / `30000` | 按 IP 的暴力破解锁定 |
| `AGENTUS_BASIC_AUTH` | — | 在**所有东西**前面加一道 HTTP Basic 质询（包括 `/healthz` 和 WS 升级）。`user:pass` 两者都校验；`:pass`（或裸 `pass`）**只校验密码**并接受任意用户名。这是你在暴露隧道之前想要的那道外层锁；见「公网暴露」。 |

### 公网暴露（隧道 / 反向代理）

把 `AGENTUS_BASIC_AUTH=:pass` 放进服务端环境，然后把隧道指向 `<lan-ip>:8787`。这样你就有了两把独立
的锁 —— 边缘的 Basic，里面的运维者登录 —— 脚本依然能进（`curl -u :pass` 加上机器 token）。

这里推荐只用密码的形式（`:pass`，或裸 `pass`）：HTTP Basic 总是会让浏览器问用户名（RFC 7617 传
`user:pass`），但一个单运维者的服务从中一无所获 —— 随便打一个名字、或者留空，都能过。如果你确实配了
用户名，那它也会被校验。

**选一道外层锁，不要两把都开：**

- **隧道自带的门**，如果它有的话。SakuraFrp 的 `auth_pass` 是 IP 级授权：首次访问显示一个小页面要访问
  密码，之后记住该 IP，WebSocket 也能穿过它继续工作（两端实测过）。这一侧零配置；代价是机器想进就得
  走那套额外的授权流程（`POST /v4/tunnel/auth`）。
- **`AGENTUS_BASIC_AUTH`**，当隧道没有门、是纯 TCP 转发，或者你想要可脚本化的访问（`curl -u :pass`）。
  真正的 401 质询被每个浏览器、代理和 HTTP 客户端理解 —— 不像某些隧道的「访问鉴权」形式，它们返回 HTTP
  **200** 加一个「授权你的 IP」页面，对 `curl` 不可见。

两个都开会连续弹三次密码，所以选一个。

关于这个应用前面的隧道，要知道两件事：

- **WebSocket 必须能穿过。** 驾驶舱的实时流跑在 `/ws` 上；一个会丢掉 `Upgrade` 的 HTTP/1.1 隧道会让你
  得到「页面能加载、然后永远显示重连中」。已验证能穿过 SakuraFrp 的 TCP+自动 HTTPS 隧道。
- **在边缘终结 TLS。** 当请求带着 `X-Forwarded-Proto: https` 到达时，session cookie 会自动以 `Secure`
  下发（在同一隧道上实测过），所以无需配置。你 LAN 内的最后一跳仍然是纯 HTTP。

#### TLS：刻意做成第二个监听器

纯 TCP 隧道（SakuraFrp、safe-nat、`ssh -L`、大多数 frp 配置）只转发字节 —— 它**不会**替你终结 TLS。
把它指向 `:8787`，运维者的密码和 session cookie 就会以明文穿过互联网。所以服务端可以自己讲 TLS：

```bash
scripts/make-cert.sh                    # self-signed, SAN = the name you actually type
# -> $AGENTUS_DATA/tls/{cert.pem,key.pem} (0600, git-ignored) — ~/.agentus/tls by default
# boot log then says: https://0.0.0.0:8443 (self-signed …) ; point a tunnel at THIS port
```

| 端口 | 讲什么 | 给谁 |
|---|---|---|
| `AGENTUS_PORT` (8787) | 纯 HTTP | LAN、loopback、`curl`、脚本 —— 无证书警告，CI 不变 |
| `AGENTUS_TLS_PORT` (8443) | HTTPS（自签名） | **隧道** —— 加密公网那一跳 |

同一套 handler，同一套路由，同一套认证；只有 socket 不同。两个监听器胜过另外两种做法：把单端口变成
HTTPS 会把证书警告挡在你自己 LAN 的使用前面（并弄坏 `curl` 脚本），而在一个端口上嗅探首字节来同时服
务两者会掩盖一次访问到底有没有被加密。

**在你的设备上退掉那个警告。** 开着 TLS 时，监听器在 `/cert.crt` 提供自己的证书：

```bash
https://<your-name>:<tls-port>/cert.crt     # iOS: opens the profile installer directly
                                            # Android: downloads it → Settings → Security → CA certificate
curl --cacert <AGENTUS_DATA>/tls/cert.pem https://<your-name>:<tls-port>/healthz   # scripts, no -k
```

装成受信任的根证书后（iOS 还需要 *关于 → 证书信任设置 → 启用*），浏览器就不再追问，地址栏也就干净了。
它是公开材料 —— 私钥永远不离开 `<AGENTUS_DATA>/tls/`。

证书是**刻意自签名**的 —— 对一个未注册的域名或裸 IP，没有 CA 会签发，所以浏览器每台设备显示一次「不
是私密连接 → 继续」，而装上签发者（`/cert.crt`，见上）连这个都能退掉。把 SAN 保持为你实际输入的名字
（**DDNS 名**，而不是公网 IP：动态 IP 会需要重签，而名字不匹配会多一个警告）。

`make-cert.sh` 刻意签发**两张**证书：一张 10 年根证书（`ca.pem`，设备装的就是它）和一张 390 天的叶子
证书（`cert.pem`，监听器提供的就是它）。Apple 把*服务器证书*有效期上限定在 398 天 —— 一张 10 年的自
签名叶子证书恰恰是 iOS 在用户走完那套安装流程*之后*会拒绝的东西。根证书不是服务器证书，所以可以活得
久；轮换叶子证书（`--leaf-only`）永远不碰已经装好的设备。

`npm run tls-smoke`（在 CI 里，真 socket）守着这一切：一个做校验的客户端必须被*拒绝*（这才证明该端口
真的是 TLS），叶子证书必须能链到根证书、且 `/cert.crt` 发出的就是它、并保持在 398 天上限内，API 登录
和 `wss://…/ws` 握手必须能在 TLS 上工作（升级 handler 绑定在两个监听器上 —— 这是最容易忘的地方），而
LAN 端口必须保持明文。

登出会在服务端撤销 session id，所以「登出」是结束会话，而不只是藏起 UI —— cookie 立刻失效。

## HERMES_HOME（一个 slot 读写哪个数据目录）

被拉起的 agent CLI 会继承服务端的环境，所以服务端**总是显式设置 `HERMES_HOME`**：这一行自己指定了
home 就用它，否则用默认值 —— **你真实的 `~/.hermes`**，也就是你的 gateway 和 Studio 打开的那个
`state.db`。这就是预期的生产设置：一个 slot 驱动你真实的 agent，带着你的配置、凭证、记忆和会话列表。

*继承来的* `HERMES_HOME` 会被忽略（一个由 Hermes 启动的 shell 会把自己的泄漏下去），所以一个 slot 往
哪写永远是你选的东西 —— 在那一行上，或在 `AGENTUS_HERMES_HOME` 里。

要让某个 slot 的数据单独放（干净的会话列表、不同的 profile、一次性的实验），在那一行的 HERMES_HOME 里
命名一个目录即可 —— 不需要权限。早期开发的**隔离护栏**已经去掉了：它当初直接拒绝真实 home，是因为
Hermes 内置的 SQLite 3.50.4（落在 WAL-reset 区间内）在两个写入者共享一个 WAL 文件时会损坏真实的
`state.db`（2026-10-02）。运行时现在链接的是 SQLite 3.53.1，而共享一个 home 本来也是 Hermes 自己整天
在做的事（gateway + Studio bridge），所以驾驶舱不再挡路。

指向自己 home 的一行不需要权限 —— 只要一个名字。当一行指向别处时还剩一个陷阱：一个全新的 home，其
`hindsight/config.json` 保持默认 profile 名 `"hermes"` 的话，会接上你的生产记忆守护进程，所以这种
情况下那一行会给出警告。

## 目前能做什么（M0 → M4）

- 多会话侧栏，**按工作目录分组** —— 运行中的会话和**已关闭的案例**（进程已退出的 transcript；
  点击可重新拉起 + `loadSession` 恢复，并重新套用存下的 permission mode/effort），
  两者都支持按标题 / 后端 / cwd 搜索
- **会话自己起名**：agent 自己的标题（ACP `session_info_update` —— Hermes 在回合开场里生成一个）被
  原样采用，而一个从不发标题的后端仍然会得到一个由第一条 prompt 派生的名字（首行，去掉 markdown，
  ≤50 字符）；菜单里的 **重新生成会话名** 会让 agent 根据它**当前**的内容给对话起名，跑在一次性的
  `session/fork` 上，所以会话自己的 transcript 不受影响
- 流式渲染 `agent_message_chunk` / `agent_thought_chunk`、工具调用（按 `toolCallId` upsert，从不
  追加）、plan 更新、用量。一个工具调用就是一行紧凑的行 —— 状态点、截断的标题、折叠箭头 —— 只有展开
  时才显示完整名字、kind、status、input 和 output（二十个调用的 transcript 依然可读）
- 每会话的**上下文窗口仪表**，来自 ACP `usage_update`（在 65% / 85% 告警；当 agent 不上报窗口大小时
  降级为只显示 used）以及一个每回合的 trace chip，显示这一回合实际用的 effort/mode
- 由 agent 自己的 `available_commands_update` 驱动的**斜杠命令面板**（过滤、↑/↓、Tab 接受、Esc）——
  永远不是一份我们编造的命令列表
- **fork 一个会话**（ACP `session/fork`，一个 Hermes 确实提供的不稳定能力）：agent 把父会话的上下文
  复制进一个新会话，在这里它会作为一个自己的会话出现 —— 同样的工作区，同样的模式，此后彼此独立
- 权限卡片（允许 / 总是允许 / 拒绝 / 忽略），接到 ACP 的服务端→客户端 `requestPermission`，带一个待
  处理计数 chip 和一个超时，这样会话不会卡死
- permission mode + 推理强度切换（`setSessionMode` / `setSessionConfigOption`），按会话持久化
- SQLite transcript，每会话单调的 `seq`；重连只重放尾部；长 transcript 向后**分页**（「加载更早」）
  而不是截断
- 孤儿进程回收：每个子进程都是 detached 拉起并记录 pid，所以一个崩溃的服务端留下的残渣会在下次启动
  时被杀掉
- 容忍离线：WS 重连带 outbox（断线期间的输入被排队，而不是被吞掉），离线应用外壳走 service worker
- PWA + 手机布局：抽屉式侧栏、拇指大小的控件、安全区 padding、16px 输入框（避免 iOS 缩放）、390px
  下无横向溢出
- 一个头部带**两个**控件：这个会话在哪个目录里工作，以及工作区面板。原来放在那上面的所有东西都挪到了
  prompt 旁边它该在的地方
- **工作区面板**（头部 ▤）：一个只读文件浏览器（面包屑、大小、文本预览）和一个以会话工作区为根的
  shell，两者都随 socket 一起被杀掉。Cwd 是每会话字段：一个*运行中*的 agent 保持它启动时的目录，面板
  和下一次恢复则跟随你选的那个
- **回复按 markdown 渲染**（markdown-it + highlight.js，用 DOMPurify 和 `html: false` 消毒，这样
  agent 的 `<script>` 依然是可见文本）：标题、列表、表格、引用、带语言标签的围栏代码、复制按钮和语法
  着色
- **agent 自己的旋钮，按 ACP 本意摆放**：模型按钮只印出模型名（"qwen3.8-flash"）；它的列表按 provider
  分组并可折叠（Hermes 提供 501 个模型 —— 平铺的列表没法用）；思考深度只显示一个小刻度（七格，按级别
  填充，颜色从灰到红），这样手机宽的一行也放得下发送按钮：一个思考深度按钮和一个模型按钮，各自读取
  agent 公布的选项（`configOptions[].category`，回退到 option id）—— 当 agent 一个都不提供时则隐藏。
  模型切换用 ACP `session/set_model`，Hermes 实现了它（我们在用的 SDK 没有给它类型，所以走通用的
  request() 重载）
- **上下文窗口由你声明**：点用量那一行来设定仪表所依据的窗口，按会话、持久化。ACP 没有改变一个模型窗口
  的方法（那是 provider 的属性 —— 也就是 `usage_update.size` 所报告的），所以这个数字只驱动仪表；切
  模型才是真正的杠杆
- 读起来像聊天框而不是工具栏的输入区：附件（`+`）、设置（permission mode · 思考深度 · voice）和口述
  都在输入框下的一行上，上下文/花费那一行是它*上方*的小字，回合运行中发送键变成停止键
- **附件**作为真实的 ACP content blocks：图片（`type: "image"`）、带文件名头内联的文本文件、链接作为
  `resource_link`。只有文件名被持久化 —— 从不持久化字节
- **语音，双向，浏览器优先**：朗读任意回复（每条消息一个按钮加一个自动朗读开关、音色选择、语速），口述
  一条 prompt（带实时中间词）。服务端端点是可选的、且只是一个代理（`AGENTUS_TTS_BASE_URL` /
  `AGENTUS_STT_BASE_URL`）；什么都不配时，浏览器来做这件事，UI 会这样说明
- **语音通话模式**（聊天头部里的 📞）：一个与会话的全屏通话 —— 一个随真实音频起伏的 canvas 光球，每个
  阶段一种颜色（listening / thinking / speaking / error，会向屏幕阅读器播报），回复在流式生成时逐句念
  出，以及**真正抢过话语权的 barge-in**：在回复上说话会停掉我们的播放、*取消 agent 的回合*并把麦克风
  交还。它的阈值就是通话本身上的旋钮（角落里的 ⚙）：抢话灵敏度（0-100 %，越高越容易打断，默认
  60 %）、抢话持续时间、说完停顿 和 最少字数（默认 3）—— 放在桌上的手机把自己的扬声器漏进自己的麦克风，
  戴耳机则不会，所以这些是每套安装的设置（存在服务端，跨设备共享）而不是常量。`最少字数` 只把关自动
  发送；点一下光球永远会发送。通话打开时它拥有语音权：同一回复的自动朗读会让位，而一次通话只念**这一
  回合**的答案 —— 永远不是上一个问题的答案
- **设置页**（侧栏里的 ⚙）：主题（浅色 / 深色 / 跟随系统，外加一个给整个驾驶舱重新上色的强调色）、语音
  provider、endpoint 和 key、模型（从 endpoint 自己的列表里选）、热词表，以及每个方向一个测试按钮。运维
  者选择的一切 —— 主题、语音端点、通话的阈值，以及对话偏好（朗读回复、音色、语速、语言、识别器、服务
  端合成）—— 都是**store 的 `settings` 表里的一行**（`voice` / `theme` / `call` / `prefs`，每段一行），
  不是它旁边的一个文件，也不是浏览器的 localStorage：设置从手机跟到笔记本，同一个实例的两个标签页也不
  可能不一致。一个 pre-store 时代的 `settings.json` 会被导入一次并保留为 `.imported`；浏览器只保存每段
  的一个副本，好让首帧就已经正确
- **百炼 (DashScope) 语音，一等公民**：经其推理 WebSocket 做流式识别
  （`qwen-audio-3.1-asr-flash-streaming` —— 话一出口词就出现），经 OpenAI 兼容 chat 路由做批量识别
  （`qwen3-asr-flash`），经 `SpeechSynthesizer` 做合成（`qwen-audio-3.0-tts-flash`，音色如
  `longanhuan_v3.6`）。浏览器打不开那个 socket（握手需要 auth header），而 key 不能离开服务端，所以驾驶
  舱拥有上游连接，浏览器通过 `/ws/asr` 转发 PCM
- **热词，固定的和动态的**：一份固定列表（`词=权重`，`50` = 超级热词）进入识别器的即时词表，外加上从
  这个会话自己的 transcript 及其邻居里挖出的实体词 —— 合并、去重、封顶，并可在设置页预览
- 一个会话的口述带着**那个会话的上下文**（它最近几回合）作为识别器的偏置，这就是让产品名和标识符保持
  完整的原因
- 不与读者较劲的流式：滚轮/触摸手势会立即脱离，新输出由一个「跳到最新」按钮宣告，而不是把视口猛拽
  下去
- 工作区选择器：浏览服务端的目录（`GET /api/fs/dirs`，一次一层）或从你之前用过的工作目录里挑；同一个
  选择器可以重新指向一个已有的会话

## 命名

UI 到处都说 **session**（侧栏、空状态、对话框）。「Slot」只是项目的名字 —— 运维者面对的概念是会话，而
产品很可能还会改名；界面里没有任何东西依赖这个比喻。

名字有两层：`title` 是侧栏显示的，`auto_title` 是它回退到的生成名。生成名（agent 的，或我们从第一条
prompt 派生的）永远不覆盖手写的名字；清除一次重命名会把它恢复；而一次明确的**重新生成会话名**是刻意
替换它。重新生成走 agent，不走我们自己的模型：我们 fork 会话，fork 从复制过来的历史里总结，然后 fork
被丢弃 —— 我们这一层依然不含智能（红线 D）。

会话操作住在一个每会话菜单上（⋯ / 右键 / 手机长按）：重命名（原地，可逆 —— 清除它恢复生成名）、
**从当前对话重新生成名字**、fork、工作区、**导出**
（`GET /api/sessions/:id/export?format=md|json` —— 从我们自己持久化的 transcript 渲染，所以一个已归档
的会话导出时无需唤醒 agent；ACP 本身没有导出的概念）、复制 id、归档（= 关闭：进程退出，记录保留），
以及对于已归档的 slot，恢复或删除。

## 测试

```bash
npm run typecheck
npm run auth-smoke                        # 48 assertions: the lock, both credentials
npm run backend-smoke                     # 42: the backend registry, spawn env, health evidence
npm run workspace-smoke                   # 85: workspace field, file API, shell, attachments
npm run voice-smoke                       # 47: settings/theme guards, voice router, 百炼 shapes
npm run tls-smoke                         # the second listener, real sockets + real certs
npm run package-smoke                     # packs, installs into a throwaway prefix + HOME, boots
                                          # that install, drives a mock turn, checks ~/.agentus
node scripts/smoke.mjs mock "hello"       # end-to-end against the mock agent
```

每个测试都在一个临时端口上、用一个一次性数据目录启动自己的服务端，所以它们在哪都能跑（包括 CI）：

- `auth-smoke` —— 匿名 REST/WS 拒绝、暴力破解锁定、cookie 签名与篡改检测、过期、经 cookie 的 WS、
  机器 token、登出撤销、`AGENTUS_AUTH=off`。
- `workspace-smoke` —— 每会话工作区、只读文件 API、PTY shell、prompt 上的附件、语音端点护栏。
- `voice-smoke` —— 设置/主题契约（校验、掩码、0600 文件）、对着一个替身端点（OpenAI 兼容**和**百炼的
  原生形状）的语音路由、热词合并与封顶，以及在一个空 `$HOME` 下的 `.env` 引导。

浏览器 QA 证据（63 轮，每轮都有 repro → 根因 → 修复 → 回归）在
[`m1-qa-log.md`](./m1-qa-log.md)。`mock` 后端按需触发额外路径：`[tool]`（权限流程）、`[think]`、
`[plan]`、`[slow]`（重连演练）、`[sink]`（回合中途子进程崩溃）。

## 许可证

Apache-2.0。关于 AionUi 灵感的致谢（只有想法 —— 没有拷贝代码）见 [NOTICE](./NOTICE)。
