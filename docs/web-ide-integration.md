# Web IDE (code-server) integration

[中文](./web-ide-integration.zh-CN.md) · [Installing Agentus](./installation.md) · [README](../README.md)

Agentus ships the other half of "look at this workspace": a file tree, a preview/editor with
conflict detection, and a real PTY terminal (`ToolPanel.tsx`, `/ws/term`). It ships no IDE. This page
is how to put one in — a code-server instance of your own, opened inside the cockpit panel, with no
second login and no mixed-content warning.

Two parts, in order: **how to start code-server** (and why exactly that shape), then **how to point
Agentus at it** (three rules that are not stylistic).

---

## 1. Start code-server

```bash
code-server --auth none \
    --bind-addr 127.0.0.1:8133 \
    --user-data-dir "$HOME/.local/share/code-server" \
    --config "$HOME/.config/code-server/config.yaml"
```

The port is an example; the mechanism does not care. The rest is not optional:

- **`--auth none` is only safe on loopback.** Its authentication is replaced by Agentus's login: the
  IDE is reachable only through the same-origin proxy below, which sits behind the operator's session
  cookie. `--auth none` **plus** a public bind hands a full IDE — terminal, file writes, extension
  host — to anyone who can reach that port. Never expose this port in your ingress.
- **`--auth password` and a public bind is not "more secure", it is a broken experience.** The
  verified result is a `302` to the login screen inside the iframe: the operator logs in twice, and
  the second login has no relationship to the cockpit session.
- **`--user-data-dir` must point at persistent storage.** Extensions, settings and workspace storage
  live there. If another host (AionUi, a desktop image, your own tooling) also runs code-server, give
  them the **same** directory — extensions and settings stay identical, the only cost is one more
  process.
- **Wait for readiness, do not assume it.** code-server is heavy: a real instance carries a main
  process, a `bootstrap-fork` file watcher and an extension host. `spawn` returning does not mean the
  port answers. If you script the start, poll the port:

  ```bash
  for i in $(seq 1 60); do
    curl -fsS -o /dev/null "http://127.0.0.1:8133/" && break
    sleep 1
  done
  ```

**Agentus does not start it for you.** Every `spawn` in this server starts an ACP agent; a
heavyweight third-party service with a port, a volume and a readiness wait belongs to the deployment.
The cockpit only forwards, and reports whether the upstream is up.

---

## 2. Point Agentus at it

```bash
AGENTUS_IDE_UPSTREAM=http://127.0.0.1:8133 agentus
```

Unset (the default) means the feature is absent: no tab, no routes beyond `GET /api/ide/status`, no
upgrade path. Set it to something unreachable and the tab appears greyed, with the start command from
§1 printed inside it — never a blank frame.

What Agentus then exposes:

| route | what it does |
|---|---|
| `GET /api/ide/status` | `{configured, reachable, base, prefix, start}` — what the tab's visibility is decided on |
| `ANY /api/ide/*` | forwarded to the upstream with the prefix stripped, `x-forwarded-prefix: /api/ide` added, and `Location` re-prefixed |
| `WS /api/ide/*` | raw byte forwarding for the upgrade (the editor's own socket) |

The three rules below are the ones that turn a plausible proxy into a working one. All three were
measured on a live deployment, and each fails in a way that leaves no error message anywhere.

### Rule 1 — the mount must be under `/api/`

`packages/server/src/auth.ts`:

```ts
export function requiresAuth(pathname: string): boolean {
  if (!pathname.startsWith("/api/")) return false; // shell, assets, /healthz
  return !PUBLIC_API.has(pathname);
}
```

Anything outside `/api/` is treated as a static asset and served **without authentication**. A proxy
mounted at `/ide/` therefore either falls into the SPA fallback (the proxy never runs) or runs with no
gate at all — a full IDE, open to the network. Mounting at `/api/ide/` inherits the existing gate with
zero changes, which is also why `GET /api/ide/...` without a session answers `401`.

Verify the inherited gate, rather than trusting it:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8788/api/ide/status   # 401 without a cookie
```

### Rule 2 — the WebSocket path must pass the upgrade whitelist

The upgrade dispatcher rejects unknown paths **before** it checks the cookie:

```ts
if (url.pathname !== "/ws" && url.pathname !== "/ws/term" && url.pathname !== "/ws/asr" && !ide.ownsPath(url.pathname)) {
  socket.destroy();
  return;
}
```

code-server's editor, terminal and file watching ride one socket. A proxy that forwards HTTP only,
or a mount missing from that list, produces the worst failure mode in this integration: **the
interface renders and connects to nothing**, with no request error to point at. Agentus registers
`/api/ide/*` for upgrades whenever `AGENTUS_IDE_UPSTREAM` is set, and keeps the same
"verify the cookie, then upgrade" order the cockpit's own sockets use.

### Rule 3 — the proxy route must run before the SPA fallback

`index.ts` ends with `serveStatic()`, which answers any unknown path with `index.html`. A proxy
registered after it never sees a request, and the symptom is honest but useless: the iframe shows
Agentus's own page. The bridge is dispatched right after the auth gate and before the `/api/` route
table, so it cannot be shadowed.

### What the proxy changes to a request

- `Host`, `Connection`, `Upgrade`, `Transfer-Encoding` and the rest of the hop-by-hop set are dropped
  (they describe our socket, not the new one).
- `Cookie` is **not forwarded**: the upstream runs `--auth none` and has no use for a
  password-equivalent.
- `x-forwarded-proto`, `x-forwarded-host` and `x-forwarded-prefix: /api/ide` are set — the last one is
  what keeps code-server's absolute URLs inside the mount.
- `Location` headers are re-prefixed (`/login` → `/api/ide/login`), because a redirect that escapes
  the mount lands on the SPA shell.
- HTML answers are `Cache-Control: no-store`: the page names a build, and a stale copy 404s its own
  assets.
- WebSocket upgrades are forwarded byte-for-byte through `net.connect` + `pipe` — no frame parsing on
  our side, so compression and subprotocols pass through untouched.

---

## 3. The panel tab

The IDE lives in the workspace panel (`ToolPanel.tsx`), next to `files` and `terminal`:

- The frame is `GET /api/ide/?folder=<session workspace>` — the folder comes from the session, never
  from an input. "Open the IDE" means "open where this agent is working".
- **The frame is mounted once and then hidden, never unmounted.** Switching tabs must not recreate
  the iframe: a fresh iframe is a fresh page load, so code-server restarts its whole front end —
  unsaved buffers, terminal scrollback, extension host. This is the one client-side rule that has to
  hold.
- Visibility is `configured && reachable`. Configured-but-down opens on the start command from §1
  (copyable), because an empty frame reads as "Agentus is broken" and sends the operator looking in
  the wrong place.

---

## 4. Security boundary

- The upstream binds **loopback only**; the proxy is its single door. Do not publish that port in
  your ingress, and do not put it behind the tunnel.
- Authentication is Agentus's cookie, **solely** — which is why Rule 1 is a security requirement and
  not a naming preference.
- The IDE runs with the same account as the cockpit, over any session's working directory. In plain
  terms: **the cockpit login is file-write access to this machine.** On a shared box, keep the
  cockpit on a trusted network, and give the agent's workspace a user of its own.

---

## 5. Troubleshooting

| symptom | cause |
|---|---|
| no `ide` tab at all | `AGENTUS_IDE_UPSTREAM` unset (or empty) |
| tab present, greyed, shows the command | upstream configured but not answering — start it per §1 |
| tab opens, frame stays dark, no error | the upstream's absolute URLs are escaping the mount: confirm the request carries `x-forwarded-prefix` and that the answer's `Location` values start with `/api/ide` |
| frame renders, editor never finishes loading | the WebSocket is not being forwarded — check Rule 2 and the upgrade whitelist |
| `401` on `/api/ide/status` from a script | the route is behind the login: pass the machine token from `<DATA_DIR>/auth.token` (`?token=` or an `authorization` header) |
| second login page inside the frame | the upstream is running `--auth password`; it must be `--auth none` on loopback |

A quick check of the whole chain from a shell:

```bash
TOKEN=$(cat ~/.agentus/auth.token)
curl -s "http://127.0.0.1:8788/api/ide/status?token=$TOKEN"
# {"configured":true,"reachable":true,"base":"http://127.0.0.1:8133", …}
```
