// Issue #113, end to end: a path returned by /api/upload travels through a real prompt as an ACP
// resource_link block (the mock echoes block shapes via "[blocks]"), the turn succeeds, and the
// transcript keeps only {kind, name} — never the 300kB body.
//
//   npx tsx scripts/qa/attach-link-e2e.mts
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const PORT = 8933;
const data = fs.mkdtempSync(path.join(os.tmpdir(), `attach-link-e2e-${PORT}-`));
const child = spawn(process.execPath, ["--import", "tsx", "packages/server/src/index.ts"], {
  cwd: REPO, env: { ...process.env, HERMES_STUDIO_PORT: String(PORT), HERMES_STUDIO_DATA: data, HERMES_STUDIO_DEV: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (b) => { log += String(b); });
child.stderr.on("data", (b) => { log += String(b); });
const api = async (p, init = {}) => {
  const token = fs.readFileSync(path.join(data, "auth.token"), "utf8").trim();
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    ...init, headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; }
};
const waitFor = async (frames, pred, ms = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const hit = frames.find(pred); if (hit) return hit; await sleep(100); }
  return null;
};
try {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`server exited: ${log.slice(-800)}`);
    try { if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) break; } catch { /* not up */ }
    await sleep(200);
  }
  const token = fs.readFileSync(path.join(data, "auth.token"), "utf8").trim();
  const made = await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "mock", cwd: "/tmp" }) });
  const sid = made.body?.id;
  for (let i = 0; i < 80; i++) {
    if ((await api("/api/sessions")).body.live?.some((r) => r.id === sid && r.status === "ready")) break;
    await sleep(200);
  }

  const CSV = ("col1,col2\n" + "x,y\n".repeat(80_000)).slice(0, 300 * 1024);
  const fd = new FormData();
  fd.append("file", new Blob([CSV], { type: "text/csv" }), "big.csv");
  const up = await fetch(`http://127.0.0.1:${PORT}/api/upload?sessionId=${sid}`, {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: fd,
  });
  const saved = await up.json() as { name: string; path: string };

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
  const frames = [];
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  ws.on("message", (raw) => { try { frames.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
  ws.send(JSON.stringify({ t: "prompt", sessionId: sid, text: "read this [blocks]",
    attachments: [{ kind: "link", uri: saved.path, name: saved.name }] }));

  const echoText = (f) => String(f.message?.payload?.content?.text ?? f.message?.payload?.text ?? "");
  const echo = await waitFor(frames, (f) => echoText(f).startsWith("BLOCKS "));
  check("the agent actually receives the prompt", Boolean(echo), echo ? "" : `agent=${JSON.stringify(frames.filter((f) => f.message?.kind === "agent")).slice(0, 600)}`);
  const shape = echo ? JSON.parse(echoText(echo).slice(7)) : [];
  const linkBlock = shape.find((b) => b.type === "resource_link");
  check("a resource_link block reaches the agent (no new protocol field)", Boolean(linkBlock), JSON.stringify(shape).slice(0, 300));
  check("no 300kB text block was inlined in its place", !shape.some((b) => String(b.body).includes("col1,col2")),
    JSON.stringify(shape).slice(0, 300));
  check("the turn completes", Boolean(await waitFor(frames, (f) => f.t === "turn-end", 20_000)));

  const rows = (await api(`/api/sessions/${sid}/messages`)).body.messages ?? [];
  const user = rows.find((m) => m.kind === "user" && (m.payload?.attachments ?? []).length);
  check("transcript records the attachment as a link summary", user?.payload?.attachments?.[0]?.kind === "link"
    && user.payload.attachments[0].name === "big.csv", JSON.stringify(user?.payload?.attachments ?? null));
  check("transcript carries no inline file body", !JSON.stringify(user?.payload ?? {}).includes("col1,col2"),
    String(JSON.stringify(user?.payload ?? {}).length));

  ws.close();
  await api(`/api/sessions/${sid}`, { method: "DELETE" });
} finally {
  child.kill("SIGTERM");
  for (let i = 0; i < 60 && child.exitCode === null; i++) await sleep(100);
  if (child.exitCode === null) child.kill("SIGKILL");
  fs.rmSync(data, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
