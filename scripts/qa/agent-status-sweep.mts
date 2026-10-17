// The agent's own status line (issue #18): `👁️ Hindsight — recalled 8 memories`, a compaction
// countdown, a provider wait.
//
// On ACP there is no status object, so the carrier is an EMPTY thought chunk with the sentence in
// `_meta.hermes` — the extension door the protocol does leave open. Two claims have to hold, and the
// second is the one that is easy to get wrong:
//
//   1. the sentence reaches the page as a `status` frame (so it can be drawn next to the turn), and
//   2. it never becomes a transcript row. A recall count describes the turn that is running; stored,
//      it would sit above a conversation from last month and read as history.
//
// The store half (the line appears, then goes at turn-end) is asserted against the client's own code,
// like `live-stream.mts` does, so this is not a hand-rolled imitation of the web.
//
//   npx tsx scripts/qa/agent-status-sweep.mts
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const PORT = Number(process.env.STATUS_SWEEP_PORT ?? 8923);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const data = fs.mkdtempSync(path.join(os.tmpdir(), "status-sweep-"));
const env = { ...process.env, AGENTUS_PORT: String(PORT), AGENTUS_DATA: data, AGENTUS_DEV: "1" };
delete env.AGENTUS_BASE; delete env.AGENTUS_TITLE;
const child = spawn(process.execPath, ["--import", "tsx", "packages/server/src/index.ts"], {
  cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (b) => { log += String(b); });
child.stderr.on("data", (b) => { log += String(b); });

try {
  let up = false;
  for (let i = 0; i < 150 && !up; i++) {
    if (child.exitCode !== null) throw new Error(`server exited: ${log.slice(-800)}`);
    up = await fetch(`http://127.0.0.1:${PORT}/healthz`).then((r) => r.ok).catch(() => false);
    if (!up) await sleep(200);
  }
  if (!up) throw new Error(`server never came up: ${log.slice(-800)}`);

  const token = fs.readFileSync(path.join(data, "auth.token"), "utf8").trim();
  const api = async (p: string, init: RequestInit = {}) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
    const text = await r.text();
    try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; }
  };

  const made = await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "mock", cwd: "/tmp", title: "状态行（自动删除）" }) });
  const sid = made.body?.id as string;
  for (let i = 0; i < 100; i++) {
    const rows = (await api("/api/sessions")).body.live ?? [];
    if (rows.some((r: { id: string; status: string }) => r.id === sid && r.status === "ready")) break;
    await sleep(200);
  }

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
  await new Promise<void>((res, rej) => { ws.on("open", () => res()); ws.on("error", rej); });
  const frames: any[] = [];
  ws.on("message", (raw) => { try { frames.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
  const waitFor = async (pred: (f: any) => boolean, ms = 20_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = frames.find(pred);
      if (hit) return hit;
      await sleep(100);
    }
    return null;
  };

  // `[slow][status]`: the turn lasts long enough for the line to arrive while it is still running.
  ws.send(JSON.stringify({ t: "prompt", sessionId: sid, text: "[slow][status] 跑一个带状态行的回合" }));
  const started = await waitFor((f) => f.t === "turn-start");
  check("the turn started (fixture precondition)", Boolean(started));
  const statusFrame = await waitFor((f) => f.t === "status");
  check("the agent's status reaches the page as a `status` frame (issue #18)",
    Boolean(statusFrame) && String(statusFrame.text).includes("recalled 8 memories"),
    JSON.stringify(statusFrame ?? null));
  check("…carrying the sentence verbatim, and the kind the agent labelled it with",
    String(statusFrame?.text) === "👁️ Hindsight — recalled 8 memories" && statusFrame?.statusKind === "lifecycle",
    JSON.stringify({ text: statusFrame?.text, kind: statusFrame?.statusKind }));
  check("…and it is NOT a transcript row on the wire (no message frame carries it)",
    !frames.some((f) => f.t === "message" && JSON.stringify(f.message ?? {}).includes("recalled 8 memories")));

  const ended = await waitFor((f) => f.t === "turn-end", 40_000);
  check("the turn ended", Boolean(ended) && !ended.error, ended ? `error=${String(ended.error ?? "")}` : "no turn-end");

  const rows = (await api(`/api/sessions/${sid}/messages`)).body.messages ?? [];
  const persisted = rows.filter((m: any) => JSON.stringify(m.payload ?? "").includes("recalled 8 memories"));
  check("nothing of the status line was PERSISTED (the store has no trace of it)", persisted.length === 0,
    `${persisted.length} rows`);
  check("…and it did not become an empty thought bubble either (an empty chunk is not a row)",
    !rows.some((m: any) => m.kind === "thought" && !String(m.payload?.content?.text ?? "").trim()),
    JSON.stringify(rows.map((m: any) => m.kind)));

  // ── the client's own rule: show it, drop it at turn-end ──────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  // the store schedules queue drains on `window`; node has none (same stub as live-stream.mts)
  (globalThis as any).window ??= { setTimeout, clearTimeout, addEventListener: () => {} };
  const { cockpit } = await import("../../packages/web/src/state.ts");
  cockpit.apply({ t: "sessions", sessions: [{ id: "s1", title: "x", status: "running" }] } as never);
  cockpit.setActive("s1");
  cockpit.apply({ t: "turn-start", sessionId: "s1" } as never);
  cockpit.apply({ t: "status", sessionId: "s1", text: "👁️ Hindsight — recalled 8 memories", statusKind: "lifecycle" } as never);
  const live = (cockpit as any).byId.get("s1");
  check("the store puts the line on the running turn (it renders beside 处理中)", live?.status === "👁️ Hindsight — recalled 8 memories",
    String(live?.status));
  cockpit.apply({ t: "turn-end", sessionId: "s1" } as never);
  check("…and drops it when the turn ends (a status belongs to one turn, never to the conversation)",
    (cockpit as any).byId.get("s1")?.status == null, String((cockpit as any).byId.get("s1")?.status));
  cockpit.apply({ t: "turn-start", sessionId: "s1" } as never);
  cockpit.apply({ t: "status", sessionId: "s1", text: "压缩倒计时 3 分钟" } as never);
  cockpit.apply({ t: "turn-start", sessionId: "s1" } as never);
  check("a new turn does not inherit the previous turn's line",
    (cockpit as any).byId.get("s1")?.status == null, String((cockpit as any).byId.get("s1")?.status));

  ws.close();
  await api(`/api/sessions/${sid}`, { method: "DELETE" });
  await api(`/api/sessions/${sid}`, { method: "DELETE" });
} finally {
  child.kill("SIGTERM");
  for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(100);
  if (child.exitCode === null) child.kill("SIGKILL");
  fs.rmSync(data, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
