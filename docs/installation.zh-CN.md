# 安装 Agentus

[English](./installation.md) · [README](../README.md)

Agentus 是面向「说 ACP 协议的编码 agent」的多会话 Web 驾驶舱。一个 npm 包（`agentus`）跑起一个
Node 服务：它提供构建好的 React 单页应用，并按需把 agent CLI（`hermes acp` / `qodercli --acp`）
作为子进程拉起。浏览器负责驾驶会话，推理始终留在 CLI 子进程里。

## 前置条件

必须满足两条：

- **Node >= 22.5。** 存储层用的是 `node:sqlite`，它在 22.5 才落地。版本不够时 Agentus 会直接拒绝
  启动，并给出明确提示。
- **PATH 上有一个 ACP agent CLI** —— `hermes acp` 或 `qodercli --acp`。这是 npm 唯一无法替你装的
  前置项。没有它，驾驶舱照样能跑、也能登录，只是没有后端可以开会话。

```bash
# 检查 agent 侧（Hermes 会自检；qoder 需要先登录）
hermes acp --check
qodercli login          # 否则 newSession 会以 -32000 失败
```

装 Node 本身很简单：

```bash
nvm install 22 && nvm use 22      # 或者
brew install node                 # 或者 https://nodejs.org/en/download
```

## 安装

### 一条命令

```bash
curl -fsSL https://raw.githubusercontent.com/agentus-org/agentus/main/scripts/install.sh | bash
```

安装脚本（`scripts/install.sh`）会检查 Node、用 npm 全局装上已发布的 `agentus` 包；如果全局目录
不可写，它会退回到用户级前缀（`~/.local`），**绝不**动 `sudo`。装完会打印启动命令和要打开的网址。
除非你显式设置 `AGENTUS_ALLOW_ROOT=1`，它拒绝以 root 运行。

可用环境变量覆盖默认行为：

| 变量 | 默认值 | 作用 |
|---|---|---|
| `AGENTUS_VERSION` | `latest` | 固定安装的版本，例如 `0.1.0` |
| `AGENTUS_INSTALL_DIR` | 未设置 | 安装到该 `npm --prefix`，而不是全局目录 |
| `AGENTUS_REGISTRY` | npm 官方源 | 拉取用的源 |
| `AGENTUS_ALLOW_ROOT` | `0` | `1` 允许以 root 运行 |
| `AGENTUS_NODE_MIN` | `22.5` | 覆盖 Node 版本下限检查 |

```bash
# 固定版本 + 指定前缀
AGENTUS_VERSION=0.1.0 AGENTUS_INSTALL_DIR="$HOME/.local" \
  bash scripts/install.sh
```

### 用包管理器

如果你不想把脚本管进 shell：

```bash
npx agentus                # 直接跑一次，不全局安装
npm i -g agentus           # ……或者装上，之后运行 `agentus`
```

`npx agentus` 在前台运行驾驶舱 —— Ctrl-C 即停，并且会把它拉起的 agent 子进程一并带走。

### 从源码（一份 checkout）

```bash
git clone https://github.com/agentus-org/agentus.git
cd agentus
npm start                           # 需要时自动装依赖、构建、起服务（scripts/start.sh）
npm run dev -w @agentus/web         # 前端热更新（Vite :5173，局域网可达）
npm run agentus                     # 与 `npx agentus` 同一个 CLI，直接从 checkout 里跑
```

`npm start`（→ `scripts/start.sh`）会检查 Node 版本，`node_modules` 缺失时以
`NODE_ENV=development` 装依赖，前端产物过期时重新构建，然后只起一次服务（无 watcher）。
用 `AGENTUS_PORT=9000 npm start` 换端口。

## 命令行

```
agentus [options]

  -p, --port <n>     监听端口                        (AGENTUS_PORT，默认 8787)
  -d, --data <dir>   状态目录（sqlite、登录、TLS 材料、设置）
                                                       (AGENTUS_DATA，默认 ~/.agentus)
  -o, --open         就绪后自动在浏览器打开驾驶舱
      --where        打印解析出的路径后退出（不启动任何东西）
  -h, --help         帮助文本
  -v, --version      打印版本
```

`--where` 值得记住：它会打印服务端**实际**解析出的路径 —— 数据目录、前端产物、随附 APK、TLS
监听、Node 版本 —— 然后退出，什么都不启动。它是「我的数据去哪了」的唯一权威答案（见下文）。

## 首次运行

1. 启动：`agentus`（或 `npx agentus`，或 checkout 里的 `npm start`）。
2. 打开 **http://localhost:8787** 登录。默认凭据：

   ```
   username: admin
   password: 123456      ← 请改掉
   ```

   在应用内改：**设置 → 账号**（第一张卡片）。改了立即生效，并写入
   `<DATA_DIR>/credentials.json`（0600，scrypt 哈希）。
3. 添加后端。后端注册表在首次启动时用内置行播种（见[后端](#后端)）；确认 `hermes` 或 `qoder`
   能解析到，或把某一行指向你自己的命令。
4. **+ new session** → 选一个后端 + 一个工作目录 → 开会话。

你启动的第一个会话会使用你自己 agent 已经在用的 Hermes home（`~/.hermes`），除非后端行里指定了
另一个 —— 见 [HERMES_HOME](#hermes_home)。

## 配置参考

### 环境变量

| 变量 | 默认值 | 含义 |
|---|---|---|
| `AGENTUS_PORT` | `8787` | 服务端口（从不读裸 `PORT`） |
| `AGENTUS_DATA` | `~/.agentus` | 状态目录；见[数据目录](#数据目录) |
| `AGENTUS_HERMES_CMD` | `hermes` | hermes 后端要拉起的可执行文件 |
| `AGENTUS_QODER_CMD` | `~/.local/bin/qodercli` | qoder 后端同理 |
| `AGENTUS_HERMES_HOME` | `~/.hermes` | 未在行里指定 home 时的默认 `HERMES_HOME` |
| `AGENTUS_PERM_TIMEOUT_MS` | `300000`（5 分钟） | 权限提示自动取消前的等待时间 |
| `AGENTUS_HISTORY_PAGE` | `500` | 对话记录分页大小 |
| `AGENTUS_TLS_PORT` | 有证书时 `8443`，否则关闭 | TLS 监听端口（`0` = 关闭） |
| `AGENTUS_TLS_CERT` / `AGENTUS_TLS_KEY` | `<DATA_DIR>/tls/{cert,key}.pem` | 该监听用的证书材料 |
| `AGENTUS_TLS_CA` | `<DATA_DIR>/tls/ca.pem` | 设备只需装一次的根证书 |
| `AGENTUS_TTS_BASE_URL` | 未设置 | 服务端语音合成的 OpenAI 兼容 base（`…/v1`）；不设 = 只用浏览器语音 |
| `AGENTUS_TTS_API_KEY` / `AGENTUS_TTS_MODEL` / `AGENTUS_TTS_VOICE` | – / `tts-1` / `alloy` | 同上 |
| `AGENTUS_STT_BASE_URL` | 未设置 | 服务端语音识别的 OpenAI 兼容 base；不设 = 只用浏览器识别 |
| `AGENTUS_STT_API_KEY` / `AGENTUS_STT_MODEL` / `AGENTUS_STT_LANGUAGE` | – / `whisper-1` / – | 同上 |
| `DASHSCOPE_API_KEY` / `DASHSCOPE_BASE_URL` | – | 百炼（DashScope）凭据；从进程环境**和** `~/.hermes/.env` 读取 |

认证相关：

| 变量 | 默认值 | 含义 |
|---|---|---|
| `AGENTUS_AUTH` | `on` | `off` = 完全不要登录（仅供本机折腾） |
| `AGENTUS_USERNAME` | `admin` | 操作员用户名 |
| `AGENTUS_PASSWORD` | `123456` | 操作员密码（环境里是明文） |
| `AGENTUS_PASSWORD_HASH` | — | `scrypt:<salt>:<hex>`；设了就优先于 `AGENTUS_PASSWORD` |
| `AGENTUS_SESSION_TTL_MS` | 604800000（7 天） | 会话有效期 |
| `AGENTUS_AUTH_SECRET` | `<DATA_DIR>/auth.secret` | cookie 签名密钥（0600，自动生成） |
| `AGENTUS_AUTH_TOKEN` | `<DATA_DIR>/auth.token` | 供脚本用的机器令牌（0600，自动生成） |
| `AGENTUS_LOGIN_MAX_FAILS` / `AGENTUS_LOGIN_LOCK_MS` | `5` / `30000` | 按 IP 的暴力破解锁定 |
| `AGENTUS_BASIC_AUTH` | — | 挡在**所有**请求前的 HTTP Basic（`:pass` 只校验密码） |

语音/主题类的环境变量只是**引导值**：之后由设置页（侧栏 ⚙）接管，存到 `<DATA_DIR>/settings.json`
（0600）。页面里的设置优先；环境变量的作用是让一份全新安装在没人打开设置页之前也能正常工作。

### 数据目录

默认 `~/.agentus`。里面有 `agentus.sqlite`（会话 + 记录）、`credentials.json`、`auth.token`、
`auth.secret`、`tls/`、`settings.json`。首次启动时以 `0700` 创建，启动日志会打印它**以及为什么是
这个目录胜出**：

| 顺序 | 规则 |
|---|---|
| 1 | 设置了 `AGENTUS_DATA` 时用它 —— 每个启动器和 dev/QA 实例都钉住这个 |
| 2 | `~/.agentus`，当它已有内容，或仓内还没有数据时 |
| 3 | `<repo>/packages/server/.data` —— 早于这套布局的既有 checkout |

规则 3 的存在是为了让「悄悄换了目录」的安装不会以空的会话列表启动（那读起来就像是「我的会话
都不见了」）。要迁移这样的 checkout，用 `AGENTUS_DATA=~/.agentus` 启动一次即可。`agentus --where`
会打印服务端解析的结果，不用靠猜。

任何东西都不会写进 `node_modules`：对已安装的包来说，`<pkg>/packages/server/.data` 会被下一次
`npm i -g agentus` 删掉，连带记录、登录和 TLS 密钥一起没了。

### 端口

| 端口 | 协议 | 用途 |
|---|---|---|
| `AGENTUS_PORT`（8787） | 纯 HTTP | 局域网、本机回环、`curl`、脚本 —— 无证书警告，CI 不变 |
| `AGENTUS_TLS_PORT`（8443） | HTTPS（自签） | **隧道** —— 加密公网那一跳 |
| 5173 | Vite 开发服务器 | 前端热更新，仅在 `npm run dev` 期间 |

两个监听的 handler、路由、鉴权完全相同，只有 socket 不同。

### 登录

驾驶舱默认在登录后面。存在两种凭据：

| 凭据 | 怎么传递 | 谁在用 |
|---|---|---|
| 会话 cookie | `HttpOnly` + `SameSite=Lax`，HMAC-SHA256 签名，7 天 | 浏览器（`POST /api/auth/login` 签发） |
| 机器令牌 | `Authorization: Bearer <t>` 或 `?token=<t>` | 脚本、CI、启动器 —— 从 `<DATA_DIR>/auth.token` 读（0600） |

会话是无状态 cookie，服务端索引在 `<DATA_DIR>/sessions.json`（0600），所以吊销和「登出所有设备」
是真实生效的，且能跨重启存活。`AGENTUS_USERNAME` / `AGENTUS_PASSWORD` / `AGENTUS_PASSWORD_HASH`
是引导值；一旦你在「账号」卡片里保存过，就以文件为准。删掉 `credentials.json` 即可回退到环境变量。

### TLS

纯 TCP 隧道（SakuraFrp、`ssh -L`、多数 frp 配置）只是转发字节 —— 它**不会**替你终结 TLS。所以
服务端自己会讲 TLS，落在**第二个**监听上：

```bash
scripts/make-cert.sh                    # 自签根证书 + 短期叶证书，SAN = 你实际输入的名字
# -> $AGENTUS_DATA/tls/{ca.pem,cert.pem,key.pem}   （key 0600，已被 git 忽略）
# 启动日志会写：https://0.0.0.0:8443 (self-signed …) ; 把隧道指向这个端口
```

该监听还会在 `/cert.crt` 上提供自己的签发证书，设备只需装一次根证书：
`https://<你的名字>:<tls-port>/cert.crt`。iOS 会直接打开描述文件安装器；Android 会下载它
（设置 → 安全 → CA 证书）；iOS 还需要再到 *关于本机 → 证书信任设置 → 启用*。这是公开材料 ——
私钥永远不会离开 `<DATA_DIR>/tls/`。

`make-cert.sh` 有意签**两**张证书：一张 10 年的根（`ca.pem`，设备装它）和一张 390 天的叶
（`cert.pem`，监听提供它）。Apple 把服务器证书有效期卡在 398 天，所以一张 10 年的叶证书正是
iOS 在用户走完安装流程**之后**才拒绝的东西。叶证书可以随意轮换（`--leaf-only`），已装根证书的
设备不受影响。

### 后端

| id | 命令 | 说明 |
|---|---|---|
| `hermes` | `hermes acp` | 需要 PATH 上有 Hermes 安装（`hermes acp --check`） |
| `qoder` | `qodercli --acp` | 需要先 `qodercli login`，否则 `newSession` 以 `-32000` 失败 |
| `mock` | `node packages/server/mock/agent.mjs` | 离线开发/QA：假流式、权限提示、崩溃/规划/工具触发 |

新增后端就是 `packages/server/src/acp/backends.ts` 里的一行；协议层永远不变。

## HERMES_HOME

被拉起的 agent CLI 会继承服务端的环境，所以服务端**总是显式设置 `HERMES_HOME`**：行里指定了就用
行里的，否则用默认 —— **你真实的 `~/.hermes`**，也就是你的 gateway 和 Studio 正打开的那个
`state.db`。这就是预期的生产设置：一个会话驱动的是你真正的 agent，带着你的配置、凭据、记忆和会话
列表。

**继承来的** `HERMES_HOME` 会被忽略，所以会话往哪写永远是你选定的东西 —— 在后端行上，或经由
`AGENTUS_HERMES_HOME`。要让某个会话的数据独立，就在那行的 HERMES_HOME 里写一个目录，不需要任何
许可。

## 作为服务常驻

Agentus 默认在前台跑；一个服务单元能让它跨登录、跨重启常驻。把单元指向你平时用的同一个
`AGENTUS_DATA`，否则驾驶舱会带着另一份会话列表起来。

**macOS（launchd）** —— `~/Library/LaunchAgents/org.agentus.cockpit.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>          <string>org.agentus.cockpit</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string><string>agentus</string><string>--port</string><string>8787</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>AGENTUS_DATA</key><string>/Users/YOU/.agentus</string></dict>
  <key>RunAtLoad</key>      <true/>
  <key>KeepAlive</key>      <true/>
  <key>StandardOutPath</key>  <string>/tmp/agentus.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/agentus.err.log</string>
</dict>
</plist>
```

```bash
launchctl load  ~/Library/LaunchAgents/org.agentus.cockpit.plist
launchctl kickstart -k gui/$(id -u)/org.agentus.cockpit   # 重启
```

**Linux（systemd，用户单元）** —— `~/.config/systemd/user/agentus.service`：

```ini
[Unit]
Description=Agentus cockpit
After=network.target

[Service]
ExecStart=/usr/bin/env agentus --port 8787
Environment=AGENTUS_DATA=%h/.agentus
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now agentus
journalctl --user -u agentus -f
```

TODO(verify)：launchd/systemd 单元里 `agentus` 能否被 `env` 解析，取决于 npm 把 bin 装到了哪
（用户级前缀默认不在服务进程的 PATH 上）—— 如果单元起不来，把 `ExecStart` / `ProgramArguments`
改成 `agentus` bin 的绝对路径。

## 升级

```bash
npm i -g agentus@latest            # 或者：npx agentus@latest … 跑一次
```

状态不受影响 —— `~/.agentus`（或 `AGENTUS_DATA` 指向的地方）不在包内，升级不会删掉它。如果你
用 `AGENTUS_INSTALL_DIR=~/.local` 装到了某个前缀，就用同一个前缀升级。启动时服务端会一次性接管
既有会话 cookie，而不是把所有设备登出。

## 卸载

```bash
npm rm -g agentus                  # 删程序（状态保留）
rm -rf ~/.agentus                  # 删状态 —— SQLite、登录、TLS 密钥、设置
```

装到用户级前缀的话用 `npm rm -g --prefix ~/.local agentus`。卸载**不会**碰 `~/.hermes`（你 agent
自己的数据），也不会碰任何工作目录。

## 排错

**端口被占用。** 用 `agentus --port 9000`，或找出并停掉占用者：
`lsof -nP -iTCP:8787 -sTCP:LISTEN`。Agentus 从不读裸 `PORT`，原因正在于此。

**「没有后端」/ 会话起不来。** 缺少 agent CLI，或它没登录。跑 `hermes acp --check`，或
`qodercli login`（`newSession` 报 `-32000` 就是 qoder 没登录）。在设置里检查后端行的命令；启动
日志和「探测」都会说明命令能否解析。

**登录问题。**

- 忘了密码：删掉 `<DATA_DIR>/credentials.json` 并重启 —— `AGENTUS_USERNAME` / `AGENTUS_PASSWORD`
  的引导值（或默认值）重新生效。
- 被暴力破解限制器锁了：**设置 → 登录失败锁定** 会列出被锁的 IP，可 unlock / unlock all。
- 彻底进不去（登录不了就够不到设置页）：删掉 `<DATA_DIR>/sessions.json` 丢掉会话索引，或重启
  服务 —— 内存里的锁定会在启动时清除。

**「我的会话不见了。」** 服务端读的是另一个数据目录。跑 `agentus --where` —— 它会打印数据目录
**以及是哪条规则选中的它**（见本页开头）。常见原因是：某个既有 checkout 的会话在
`<repo>/packages/server/.data`，而现在的安装默认到了 `~/.agentus`。用 `AGENTUS_DATA` 指向真正有
数据的那份启动一次，例如 `AGENTUS_DATA=~/.agentus agentus` 或
`AGENTUS_DATA=<repo>/packages/server/.data agentus`。

**页面能打开但一直显示「reconnecting」。** 某条隧道丢掉了 WebSocket 的 `Upgrade`。实时流走
`/ws`；请换成能透传 WebSocket 的隧道（SakuraFrp 的 TCP+auto-HTTPS 隧道已验证可用）。

**局域网里出现证书警告。** 那是 TLS 监听的自签证书（裸局域网 IP 无法承载可信证书）。要么在
局域网里用纯 HTTP 的 `:8787` 端口，要么从 `/cert.crt` 装一次签发证书（见 [TLS](#tls)）。
