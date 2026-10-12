#!/usr/bin/env python3
"""A throwaway page for the emulator, served on the port the app has saved as a server.

The app decides "this is one of MY servers" by (host, port) — and the emulator reaches the Mac's
loopback as 10.0.2.2, which is exactly the saved BOX profile (http://10.0.2.2:8901). So this server
puts the real cockpit's two file shapes on screen:

  * `<input type=file multiple>`  — the composer's 📎 (needs WebChromeClient.onShowFileChooser)
  * a link + a window.open() to a Content-Disposition: attachment route — 导出会话's shape
    (needs setDownloadListener / onCreateWindow)

The counters let the test read back what the page actually received.
"""
import base64
import http.server
import json
import socketserver
import sys

PAYLOAD = "agentus download test\n" + ("x" * 4096) + "\n"

PAGE = """<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>file harness</title>
<style>body{font:16px -apple-system,sans-serif;padding:18px}button,input,a{font-size:18px;margin:12px 0;display:block}
#log{white-space:pre-wrap;background:#eee;padding:8px;border-radius:6px;margin-top:14px}</style>
<h3>file harness</h3>
<input id="f" type="file" multiple>
<a id="dl" href="/file.txt">download via link</a>
<a id="png" href="/pic.png">download a png</a>
<button id="pop" onclick="window.open('/file.txt','_blank')">download via window.open</button>
<div id="log">waiting…</div>
<script>
  const log = (s) => { document.getElementById('log').textContent = s; };
  window.__state = { picked: [], clicks: 0 };
  document.getElementById('f').addEventListener('change', (e) => {
    window.__state.picked = Array.from(e.target.files).map((f) => f.name + ':' + f.size);
    log('picked: ' + JSON.stringify(window.__state.picked));
  });
  document.getElementById('dl').addEventListener('click', () => { window.__state.clicks++; });
</script>
"""


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        sys.stderr.write("harness %s\n" % (a[0] % a[1:] if a else ""))

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/file.txt":
            body = PAYLOAD.encode()
            self.send_response(200)
            self.send_header("content-type", "text/plain; charset=utf-8")
            self.send_header("content-disposition", 'attachment; filename="agentus-test.txt"')
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/pic.png":
            body = base64.b64decode(
                "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAXklEQVR42u3QMQEAAAgDoC1p"
                "0A0z0A0MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAA4LcBXgAAAV/2m9cAAAAASUVORK5CYII=")
            self.send_response(200)
            self.send_header("content-type", "image/png")
            self.send_header("content-disposition", 'attachment; filename="agentus-test.png"')
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/state":
            body = json.dumps({"ok": True}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        body = PAGE.encode()
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class S(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


S(("127.0.0.1", 8901), H).serve_forever()
