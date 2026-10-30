# Web IDE（code-server）集成

[English](./web-ide-integration.md) · [安装 Agentus](./installation.zh-CN.md) · [README](../README.zh-CN.md)

「看这个工作区」的另一半 Agentus 已经有了：文件树、带冲突检测的预览/编辑器、真 PTY 终端
（`ToolPanel.tsx` / `/ws/term`）。差的是 IDE 那一半。这篇讲怎么补上：用你自己的 code-server，开在驾驶舱的侧栏里，
不需要第二次登录，也不会被 mixed-content 拦掉。

两段，按顺序：**怎么起 code-server**（以及为什么必须是那个形态），然后是**怎么把 Agentus 指过去**（三条硬规则，不是风格偏好）。

---

## 1. 起 code-server

```bash
code-server --auth none \
    --bind-addr 127.0.0.1:8133 \
    --user-data-dir "$HOME/.local/share/code-server" \
    --config "$HOME/.config/code-server/config.yaml"
```

端口是示例值，机制与具体取值无关。其余几条不是可选项：

- **`--auth none` 只有在只听回环时才成立。** 它的鉴权由 Agentus 的登录接过去：IDE 只能从下面那层同域代理进来，
  而代理站在操作者的会话 cookie 后面。`--auth none` **加上对外绑定** = 把一个完整的 IDE（终端、写文件、扩展宿主）
  敞给所有能连到这个端口的人。**永远不要把这个端口单独暴露到 ingress。**
- **`--auth password` + 对外绑定不是「更安全」，而是把体验做碎。** 实测是 iframe 里出现 `302` 到登录页：
  操作者要登两次，而第二次登录和驾驶舱的会话没有任何关系。
- **`--user-data-dir` 必须指到持久存储。** 扩展、设置、workspace storage 都落在那儿。如果别的宿主（AionUi、桌面镜像、
  你自己的工具）也跑 code-server，让它们**共享同一个目录**：扩展和设置就一致，代价只是多一个进程。
- **等端口 ready，别假设 spawn 完成就等于可用。** code-server 是重量级的：一个真实实例除主进程外还挂着
  `bootstrap-fork` 的文件监听和 extension host。脚本起的时候要轮询：

  ```bash
  for i in $(seq 1 60); do
    curl -fsS -o /dev/null "http://127.0.0.1:8133/" && break
    sleep 1
  done
  ```

**Agentus 不会替你起它。** 这个服务里每一处 `spawn` 起的都是 ACP agent；要端口、要持久卷、要等待 ready 的
重量级第三方服务属于部署职责。驾驶舱只负责转发，以及如实报告上游在不在。

---

## 2. 把 Agentus 指过去

```bash
AGENTUS_IDE_UPSTREAM=http://127.0.0.1:8133 agentus
```

不设（默认）＝这个功能不存在：没有 tab、除 `GET /api/ide/status` 外没有路由、upgrade 白名单里也没有它。
设了但上游连不上 → tab 出现但置灰，点开显示 §1 那条启动命令（可复制），**不会**给一个空白的 iframe。

设上之后暴露的东西：

| 路由 | 作用 |
|---|---|
| `GET /api/ide/status` | `{configured, reachable, base, prefix, start}` —— tab 的可见性就按它决定 |
| `ANY /api/ide/*` | 去掉前缀转发给上游，加 `x-forwarded-prefix: /api/ide`，并把 `Location` 重新加上前缀 |
| `WS /api/ide/*` | 裸字节转发的 upgrade（编辑器自己那条 socket） |

下面三条规则是把「看起来像样的代理」变成「真能用的代理」的部分。三条都是实测踩出来的，而且每一条失败时都不会留下任何错误信息。

### 规则 1 —— 挂载点必须在 `/api/` 下

`packages/server/src/auth.ts`：

```ts
export function requiresAuth(pathname: string): boolean {
  if (!pathname.startsWith("/api/")) return false; // shell, assets, /healthz
  return !PUBLIC_API.has(pathname);
}
```

非 `/api/` 前缀**一律当静态资源、不走鉴权**。所以挂在 `/ide/` 的代理要么掉进 SPA fallback（代理根本不执行），
要么执行了但**没有任何闸门** —— 一个完整的 IDE 敞在网络里。挂在 `/api/ide/` 则零改动继承现有闸门，
这也是「没 cookie 访问 `/api/ide/...` 回 401」的原因。

别只信这句话，直接验：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8788/api/ide/status   # 没 cookie → 401
```

### 规则 2 —— WebSocket 的 path 必须在 upgrade 白名单里

upgrade 分派器在验 cookie **之前**就把未知 path 拒掉：

```ts
if (url.pathname !== "/ws" && url.pathname !== "/ws/term" && url.pathname !== "/ws/asr" && !ide.ownsPath(url.pathname)) {
  socket.destroy();
  return;
}
```

code-server 的编辑器、终端、文件监听全走同一条 socket。只转 HTTP、或挂载点没登记在白名单里，会产生这个集成里**最难自查的**
半死状态：**界面出来了，但连不上后端**，而且没有任何一条请求报错可以指。只要设了 `AGENTUS_IDE_UPSTREAM`，
Agentus 就为 `/api/ide/*` 放行 upgrade，并保持和驾驶舱自己的 socket 一样「先验 cookie 再 upgrade」的顺序。

### 规则 3 —— 代理路由必须排在 SPA fallback 之前

`index.ts` 最后是 `serveStatic()`，任何未知路径都用 `index.html` 兜底。注册在它后面的代理永远收不到请求，
症状很诚实但没有用：iframe 里显示的是 Agentus 自己的页面。桥接挂在鉴权闸之后、`/api/` 路由表之前，所以不会被遮住。

### 代理对请求做了哪些改动

- `Host`、`Connection`、`Upgrade`、`Transfer-Encoding` 等逐跳头被丢掉（它们描述的是我们自己的 socket，不是新那条）。
- `Cookie` **不转发**：上游跑的是 `--auth none`，一个等同于口令的东西对它没有用。
- 设 `x-forwarded-proto`、`x-forwarded-host`，以及 `x-forwarded-prefix: /api/ide` —— 最后这个是让 code-server
  的绝对路径留在挂载点内的关键。
- `Location` 重新加前缀（`/login` → `/api/ide/login`）：逃出挂载点的重定向会落到 SPA shell 上。
- HTML 响应带 `Cache-Control: no-store`：页面里写着构建号，缓存下来的旧页面会 404 掉自己的资源。
- WebSocket upgrade 用 `net.connect` + `pipe` 逐字节转发 —— 我方不解析帧，压缩和子协议原样透传。

---

## 3. 侧栏 tab

IDE 住在工作区侧栏（`ToolPanel.tsx`），和 `files`、`terminal` 并排：

- iframe 地址是 `GET /api/ide/?folder=<会话工作区>` —— `folder` 来自会话，不是输入框。所谓「打开 IDE」就是
  「打开这个 agent 正在干活的地方」。
- **iframe 只挂一次，之后只隐藏，绝不卸载。** 切 tab 不能重建 iframe：重建等于一次新的页面加载，code-server 的整个前端
  会重启 —— 未保存的编辑、终端回滚、扩展宿主全丢。这是整个前端侧唯一「必须这么做」的细节。
- 可见性 = `configured && reachable`。配了但没起来 → 直接打开 §1 那条启动命令（可复制），因为空白的 frame 会被读成
  「Agentus 坏了」，把人引到错的地方排查。

---

## 4. 安全边界

- 上游**只听回环**；代理是它唯一的门。别把这个端口单独暴露到 ingress，也别把它塞进隧道。
- 鉴权**只有** Agentus 的 cookie 这一层 —— 这就是为什么规则 1 是安全要求而不是命名偏好。
- IDE 用的是驾驶舱同一个账号权限，能开任意会话的工作目录。说白了：**驾驶舱的登录凭据 = 这台机器上的文件写权限。**
  多人共用的机器上，把驾驶舱放在可信网络内，并给 agent 的工作区单独一个用户。

---

## 5. 排错

| 症状 | 原因 |
|---|---|
| 根本没有 `ide` tab | `AGENTUS_IDE_UPSTREAM` 没设（或为空） |
| tab 在、置灰、显示命令 | 上游配了但没应答 —— 按 §1 起起来 |
| tab 能开、frame 一直黑、无报错 | 上游的绝对路径逃出了挂载点：确认请求带了 `x-forwarded-prefix`，且响应的 `Location` 以 `/api/ide` 开头 |
| frame 渲染出来了、编辑器一直转圈 | WebSocket 没被转发 —— 查规则 2 与 upgrade 白名单 |
| 脚本打 `/api/ide/status` 回 `401` | 路由在登录后面：带 `<DATA_DIR>/auth.token` 里的机器 token（`?token=` 或 `authorization` 头） |
| frame 里出现第二个登录页 | 上游跑的是 `--auth password`；回环上必须是 `--auth none` |

整条链路从 shell 验一下：

```bash
TOKEN=$(cat ~/.agentus/auth.token)
curl -s "http://127.0.0.1:8788/api/ide/status?token=$TOKEN"
# {"configured":true,"reachable":true,"base":"http://127.0.0.1:8133", …}
```
