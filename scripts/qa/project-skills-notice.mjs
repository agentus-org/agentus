// Verify the agentus half of #32 over the real socket: a session opened in an UNTRUSTED repo with
// project skills must produce one transient status frame naming the count. Untrusted = no trust
// decision recorded for that root, so we walk the list of seats in order and stop at the first one
// that produces it.
import fs from "node:fs";
import WebSocket from "ws";

const TOKEN = fs.readFileSync("/tmp/agentus-qa-account/auth.token", "utf8").trim();
const BASE = "http://127.0.0.1:8901";
const repo = process.argv[2];
if (!repo) throw new Error("usage: node notice-sweep.mjs <repo-with-untrusted-skills>");

const ws = new WebSocket(`ws://127.0.0.1:8901/ws?token=${encodeURIComponent(TOKEN)}`);
const frames = [];
ws.on("message", (raw) => {
  try {
    frames.push(JSON.parse(String(raw)));
  } catch {}
});

await new Promise((res, rej) => {
  ws.on("open", res);
  ws.on("error", rej);
});

const create = await fetch(`${BASE}/api/sessions`, {
  method: "POST",
  headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify({ backend: "hermes", cwd: repo, title: "notice sweep" }),
});
const session = await create.json();
console.log("created:", session.id, session.status);

const deadline = Date.now() + 25_000;
let notice = null;
while (Date.now() < deadline && !notice) {
  await new Promise((r) => setTimeout(r, 500));
  notice = frames.find(
    (f) => f.t === "status" && f.sessionId === session.id && f.statusKind === "project-skills",
  );
}

console.log("frames seen:", frames.length);
console.log("notice:", notice ? JSON.stringify(notice) : "MISSING");
console.log("config row:", JSON.stringify(
  (await (await fetch(`${BASE}/api/sessions`, { headers: { authorization: `Bearer ${TOKEN}` } }))
    .json()).live?.find?.((s) => s.id === session.id)?.configOptions?.find((o) => o.id === "project_skills"),
)?.slice(0, 240));

ws.close();
process.exit(notice ? 0 : 1);
