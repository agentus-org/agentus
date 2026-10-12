#!/usr/bin/env python3
"""Drive the companion app's WebView over CDP (the app enables WebView debugging).

    adb forward tcp:9333 localabstract:webview_devtools_remote_$(adb shell pidof app.agentus.companion)

Actions:
    login <token-file>      attach as the machine token (Network.setExtraHTTPHeaders) and reload
    eval <js>               evaluate in the page, print the result as JSON
    click <selector>        real mouse press+release at the element's centre (a true user gesture,
                            which a file-input click needs) -> prints the rect it used
    shot <path>             Page.captureScreenshot to a file
"""
import asyncio
import base64
import json
import sys

import websockets

BASE = "http://127.0.0.1:9333"


async def ws_url() -> str:
    import urllib.request
    with urllib.request.urlopen(BASE + "/json", timeout=5) as r:
        targets = json.load(r)
    for t in targets:
        if t.get("type") == "page":
            return t["webSocketDebuggerUrl"]
    raise SystemExit("no page target")


class Cdp:
    def __init__(self, ws):
        self.ws = ws
        self.n = 0

    async def call(self, method, params=None):
        self.n += 1
        await self.ws.send(json.dumps({"id": self.n, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(await self.ws.recv())
            if msg.get("id") == self.n:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})

    async def js(self, expr):
        r = await self.call("Runtime.evaluate", {
            "expression": expr, "returnByValue": True, "awaitPromise": True,
        })
        res = r.get("result", {})
        if r.get("exceptionDetails"):
            raise RuntimeError(json.dumps(r["exceptionDetails"])[:400])
        return res.get("value")

    async def rect(self, selector):
        return await self.js(
            "(() => { const e = document.querySelector(%s); if (!e) return null;"
            " const r = e.getBoundingClientRect();"
            " return {x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, h: r.height}; })()"
            % json.dumps(selector)
        )

    async def click(self, selector):
        r = await self.rect(selector)
        if not r:
            raise SystemExit(f"selector not found: {selector}")
        for t in ("mousePressed", "mouseReleased"):
            await self.call("Input.dispatchMouseEvent", {
                "type": t, "x": r["x"], "y": r["y"], "button": "left", "clickCount": 1,
            })
        return r


AUTH_PATCH = r"""
(() => {
  const T = %s;
  const add = (u) => (typeof u === 'string' && u.indexOf('/api/') === 0)
    ? u + (u.indexOf('?') >= 0 ? '&' : '?') + 'token=' + T : u;
  const f = window.fetch;
  window.fetch = (input, init) => f(typeof input === 'string' ? add(input) : input, init);
  const xo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) { return xo.call(this, m, add(u), ...rest); };
  const OW = window.WebSocket;
  const W = function (url, protocols) {
    const u = typeof url === 'string' ? add(url) : url;
    return protocols ? new OW(u, protocols) : new OW(u);
  };
  W.prototype = OW.prototype;
  Object.assign(W, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = W;
})();
"""


async def main():
    action = sys.argv[1]
    async with websockets.connect(await ws_url(), max_size=32 * 1024 * 1024) as ws:
        c = Cdp(ws)
        await c.call("Runtime.enable")
        await c.call("Page.enable")
        if action == "login":
            # WebView accepts Network.setExtraHTTPHeaders but does not apply it, so the machine
            # token rides the URL instead: the server takes ?token= on every route (auth.ts
            # authenticate()), and this script wraps fetch/XHR/WebSocket before the SPA loads.
            token = open(sys.argv[2]).read().strip()
            await c.call("Page.addScriptToEvaluateOnNewDocument",
                         {"source": AUTH_PATCH % json.dumps(token)})
            await c.call("Page.reload", {"ignoreCache": False})
            print(json.dumps({"ok": True, "token_len": len(token)}))
        elif action == "eval":
            print(json.dumps(await c.js(sys.argv[2])))
        elif action == "click":
            print(json.dumps(await c.click(sys.argv[2])))
        elif action == "shot":
            r = await c.call("Page.captureScreenshot", {"format": "png"})
            open(sys.argv[2], "wb").write(base64.b64decode(r["data"]))
            print(sys.argv[2])
        else:
            raise SystemExit(f"unknown action {action}")


asyncio.run(main())
