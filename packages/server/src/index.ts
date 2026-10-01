import { createServer } from "node:http";
import { BACKENDS } from "./acp/backends.js";

// AGENTSLOT_PORT only: generic PORT leaks from ambient shells (observed 8648).
const port = Number(process.env.AGENTSLOT_PORT ?? 8787);

const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, ts: Date.now(), backends: Object.keys(BACKENDS) }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[agentslot-server] http://127.0.0.1:${port}/healthz`);
});
