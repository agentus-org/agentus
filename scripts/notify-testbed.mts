// Notify test bed — the contract's server half, standalone.
//
// Why it exists: wiring NotifyCenter into the cockpit server needs a restart, and a
// restart kills live slots. This runner mounts the SAME centre (same code, same wire
// format, same pairing code stored next to the real store) on its own ports, so the
// Android companion can be paired, poked and diagnosed without touching the cockpit.
//
//   npx tsx scripts/notify-testbed.mts                 # http 8790 + https 8791 (if a cert exists)
//   npx tsx scripts/notify-testbed.mts --port 9000     # override
//
// Routes: /api/notify/* (contract) + /healthz + /dl/<file> (APK download) + / (pairing page).
import fs from "node:fs";
import path from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import type { Duplex } from "node:stream";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { NotifyCenter } from "../packages/server/src/notify/center.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DATA_DIR = path.resolve(arg("data", path.join(REPO, "packages/server/.data-notify-testbed")));
const PORT = Number(arg("port", String(process.env.AGENTSLOT_NOTIFY_PORT ?? 8790)));
const TLS_PORT = Number(arg("tls-port", String(process.env.AGENTSLOT_NOTIFY_TLS_PORT ?? 8791)));
const CERT = path.resolve(arg("cert", path.join(REPO, "packages/server/.data/tls/cert.pem")));
const KEY = path.resolve(arg("key", path.join(REPO, "packages/server/.data/tls/key.pem")));
const APK_DIR = path.resolve(arg("apk-dir", path.join(REPO, "android/artifacts")));
const TLS_READY = TLS_PORT > 0 && fs.existsSync(CERT) && fs.existsSync(KEY);

/** The test bed's own operator token: never the cockpit's machine token, because this
 *  page prints whatever unlocks it. */
function operatorToken(): string {
  const file = path.join(DATA_DIR, "notify/testbed.token");
  try {
    const v = fs.readFileSync(file, "utf8").trim();
    if (v) return v;
  } catch { /* first run */ }
  const v = randomBytes(16).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${v}\n`, { mode: 0o600 });
  return v;
}
const TOKEN = process.env.AGENTSLOT_NOTIFY_TOKEN?.trim() || operatorToken();

const equal = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const center = new NotifyCenter({
  dataDir: DATA_DIR,
  log: (line) => console.log(line),
  sessionTitle: () => null,
  // The test bed's own door for username/password pairing — deliberately NOT the cockpit's
  // credentials, and deliberately a fixed pair so the smoke test can drive both outcomes.
  credentials: (username, password, _ip) => (username === "test" && password === "test-pass-1234")
    ? { ok: true }
    : { ok: false, reason: "wrong username or password" },
  operator: (req: IncomingMessage, url: URL): boolean => {
    const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
    const q = url.searchParams.get("token") ?? "";
    return Boolean((bearer && equal(bearer, TOKEN)) || (q && equal(q, TOKEN)));
  },
});

// Every button press is logged; that is the whole answer to "did the interaction work?".
center.onAction((e) => {
  console.log(`[notify] ACTION device=${e.device.name} activity=${e.activity.activityId} action=${e.action.actionId} ` +
    `ref=${JSON.stringify(e.ref)} input=${JSON.stringify(e.action.input ?? null)}`);
});

function page(req: IncomingMessage): string {
  const host = String(req.headers.host ?? `localhost:${PORT}`);
  const scheme = (req.socket as { encrypted?: boolean }).encrypted ? "https" : "http";
  const pairUri = `agentslot://pair?u=${encodeURIComponent(`${scheme}://${host}`)}&c=${center.code}`;
  const apks = fs.existsSync(APK_DIR) ? fs.readdirSync(APK_DIR).filter((f) => f.endsWith(".apk")) : [];
  const devices = center
    .devices()
    .map((d) => `<tr><td>${d.name}</td><td>${d.platform} ${d.sdkInt}</td><td>${d.capabilities.join(" ")}</td>` +
      `<td>${d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleTimeString() : "—"}</td></tr>`)
    .join("");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentSlot notify test bed</title>
<style>body{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:24px;max-width:46em}
code{background:#f2f2ef;padding:2px 6px;border-radius:4px;word-break:break-all}
td{padding:2px 10px 2px 0;font-family:ui-monospace,monospace;font-size:12px}</style>
<h1>AgentSlot · notify test bed</h1>
<p>配对串（粘进 APK 首屏即可）：</p><p><code id="uri">${pairUri}</code></p>
<p>APK：${apks.map((f) => `<a href="/dl/${f}">${f}</a>`).join(" · ") || "<i>还没有构建产物</i>"}</p>
<p><button onclick="fetch('/api/notify/probe?token=${TOKEN}',{method:'POST'})">发一条探针通知</button>
   <button onclick="fetch('/api/notify/pair-code/rotate?token=${TOKEN}',{method:'POST'}).then(()=>location.reload())">换配对码</button></p>
<h3>已配对设备</h3>
<table>${devices || "<tr><td>（无）</td></tr>"}</table>
<p style="color:#888">http ${PORT} · https ${TLS_READY ? TLS_PORT : "off"} · seq ${"<span>"}</p>`;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  if (await center.handleHttp(req, res, url)) return;
  // Test-bed only (the cockpit has no such route): feed a synthetic ServerEvent through the very
  // same observe() the real server calls. That is how the smoke test proves the rules + presence
  // gate over real HTTP/WS instead of trusting the unit-level code path.
  if (url.pathname === "/test/observe" && req.method === "POST") {
    const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
    const q = url.searchParams.get("token") ?? "";
    if (!((bearer && equal(bearer, TOKEN)) || (q && equal(q, TOKEN)))) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "token required" }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    try {
      center.observe(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Parameters<typeof center.observe>[0]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
    return;
  }
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, devices: center.devices().length, seq: 0 }));
    return;
  }
  if (url.pathname === "/dl") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(fs.existsSync(APK_DIR)
      ? fs.readdirSync(APK_DIR).map((f) => `<a href="/dl/${f}">${f}</a><br>`).join("")
      : "no artifacts yet");
    return;
  }
  if (url.pathname.startsWith("/dl/")) {
    const file = path.join(APK_DIR, path.basename(url.pathname.slice(4)));
    if (!fs.existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": "application/vnd.android.package-archive",
      "content-length": fs.statSync(file).size,
      "content-disposition": `attachment; filename="${path.basename(file)}"`,
    });
    fs.createReadStream(file).pipe(res);
    return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(page(req));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end("{}");
}

const httpServer = createServer((req, res) => void handle(req, res));
httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  if (center.handleUpgrade(req, socket, head)) return;
  socket.destroy();
});

const listeners = [`http://0.0.0.0:${PORT}`];
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[notify-testbed] listening ${listeners.join(" ")}`);
  for (const group of Object.values(networkInterfaces())) {
    for (const addr of group ?? []) {
      if (addr.family === "IPv4" && !addr.internal) {
        console.log(`[notify-testbed]   LAN   http://${addr.address}:${PORT}/   pair-code ${center.code}`);
      }
    }
  }
});

let httpsServer: ReturnType<typeof createHttpsServer> | null = null;
if (TLS_READY) {
  httpsServer = createHttpsServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) }, (req, res) => void handle(req, res));
  httpsServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (center.handleUpgrade(req, socket, head)) return;
    socket.destroy();
  });
  httpsServer.listen(TLS_PORT, "0.0.0.0", () => {
    console.log(`[notify-testbed] https://0.0.0.0:${TLS_PORT} (self-signed, CA embedded in the APK)`);
  });
} else {
  console.log(`[notify-testbed] no cert at ${CERT} — https listener off (run scripts/make-cert.sh)`);
}

const bye = () => {
  center.close();
  httpServer.close();
  httpsServer?.close();
  process.exit(0);
};
process.on("SIGINT", bye);
process.on("SIGTERM", bye);