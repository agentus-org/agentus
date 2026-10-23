// Issue #50: the rail must not re-sort while a turn is running, and reading a session must not
// count as talking to it.
//
// The rail sorts on `SessionInfo.lastAt`, which the SERVER stamps — the page never invents it. That
// field had too many writers: every agent text chunk, every tool call, plan/state rows. A long reply
// arrives as dozens of chunks, so three sessions in parallel swapped places on every token, with rows
// moving out from under the pointer.
//
// The rule now: a turn moves its session at most TWICE — the operator's prompt starts it, the turn's
// end settles it. Reading, replaying and mid-turn rows never move it.
//
// Asserted against a real server (mock backend) over both surfaces the rail actually reads:
//   - the REST snapshot (`/api/sessions`), which is what a reload draws from, and
//   - the live socket, which is what makes the list move under the operator's eyes.
//
//   npx tsx scripts/qa/rail-clock-sweep.mts
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const PORT = Number(process.env.RAIL_CLOCK_PORT ?? 8926);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const data = fs.mkdtempSync(path.join(os.tmpdir(), "rail-clock-"));
const env: NodeJS.ProcessEnv = {
  ...process.env,
  AGENTUS_PORT: String(PORT),
  AGENTUS_DATA: data,
  AGENTUS_DEV: "1",
  MOCK_SLOW_MS: "900",
};
delete env.AGENTUS_BASE;

const child = spawn(process.execPath, ["--import", "tsx", "packages/server/src/index.ts"], {
  cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (b) => { log += String(b); });
child.stderr.on("data", (b) => { log += String(b); });

try {
  let up = false;
  for (let i = 0; i < 200 && !up; i++) {
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
  const make = async (title: string) => {
    const made = await api("/api/sessions", {
      method: "POST", body: JSON.stringify({ backend: "mock", cwd: "/tmp", title }),
    });
    const sid = made.body?.id as string;
    for (let i = 0; i < 120; i++) {
      const rows = ((await api("/api/sessions")).body.live ?? []) as { id: string; status: string }[];
      if (rows.some((r) => r.id === sid && r.status === "ready")) break;
      await sleep(200);
    }
    return sid;
  };
  const lastAtOf = async (sid: string): Promise<number> => {
    const rows = ((await api("/api/sessions")).body.live ?? []) as { id: string; lastAt?: number }[];
    return rows.find((r) => r.id === sid)?.lastAt ?? 0;
  };

  const a = await make("rail clock A");
  const b = await make("rail clock B");
  check("two mock sessions are up", Boolean(a && b), `${a} / ${b}`);

  // ── the wire the rail actually moves on ──────────────────────────────────────────────────────
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
  await new Promise<void>((res, rej) => { ws.on("open", () => res()); ws.on("error", rej); });
  const frames: Record<string, unknown>[] = [];
  ws.on("message", (raw) => { try { frames.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
  await sleep(300);

  // Both sessions run a `[slow]` turn at once: the shape the operator reported (parallel sessions
  // swapping places on every streamed chunk).
  const prompt = (sid: string, tag: string) =>
    api(`/api/sessions/${sid}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: `[slow] 巡检 ${tag} ` + "这是一段很长的回答，用来产生足够多的流式块。".repeat(8) }),
    });
  await prompt(a, "A");
  await prompt(b, "B");
  // The moment the turn started — before a single chunk of the answer exists.
  const aImmediate = await lastAtOf(a);
  // Wait for A's first streamed row, then look again: the old code stamped `lastAt` with THAT row's
  // time, so one turn moved the session as soon as the answer began. That single move is the smallest
  // unit of the jitter the operator reported, and the cheapest thing to prove red.
  for (let i = 0; i < 60; i++) {
    if (frames.some((f) => f.t === "message" && (f.message as { sessionId?: string })?.sessionId === a)) break;
    await sleep(100);
  }
  const aAfterFirstRow = await lastAtOf(a);
  check("the answer's first row does NOT move the clock (the old code stamped it with that row's time)",
    aAfterFirstRow === aImmediate, `turn-start=${aImmediate} after-first-row=${aAfterFirstRow}`);

  await sleep(500);
  const aStart = await lastAtOf(a);
  const bStart = await lastAtOf(b);
  const mark = frames.length;

  const samples: { a: number[]; b: number[] } = { a: [], b: [] };
  for (let i = 0; i < 12; i++) {           // ~6 s of a running turn
    samples.a.push(await lastAtOf(a));
    samples.b.push(await lastAtOf(b));
    await sleep(500);
  }
  const distinct = (xs: number[]) => new Set(xs).size;
  check("A's lastAt is FROZEN for the whole running turn (no re-sort per chunk)",
    distinct(samples.a) === 1 && samples.a[0] === aStart,
    `distinct=${distinct(samples.a)} start=${aStart}`);
  check("B's lastAt is frozen too — two parallel turns cannot swap places",
    distinct(samples.b) === 1 && samples.b[0] === bStart,
    `distinct=${distinct(samples.b)}`);

  const window = frames.slice(mark);
  const chunkFrames = window.filter((f) => f.t === "message");
  check("the turn really streamed while the clock stood still (the freeze is not an idle turn)",
    chunkFrames.length >= 6, `${chunkFrames.length} message frames`);

  // The live half: no state frame on the socket may carry a NEWER lastAt for a running session —
  // that is exactly the frame that re-sorts the list under the pointer.
  const moving = window
    .filter((f) => f.t === "session" || f.t === "sessions")
    .flatMap((f) => {
      const rows = (f.t === "sessions" ? (f.sessions as Record<string, unknown>[]) : [f.session as Record<string, unknown>])
        ?? [];
      return rows.filter((r) => (r?.id === a || r?.id === b));
    })
    .filter((r) => Number(r.lastAt ?? 0) > aStart);
  check("no socket frame moves a running session's clock mid-turn (nothing to re-sort on the page)",
    moving.length === 0, `${moving.length} moving rows`);

  const afterRead = await lastAtOf(a);
  await api(`/api/sessions/${a}/messages`);                      // "open the session": read history
  await api(`/api/sessions/${a}/messages`);
  check("reading a session's history does not move its clock (the server half of 「点一下跳一下」)",
    (await lastAtOf(a)) === afterRead, `${afterRead} -> ${await lastAtOf(a)}`);

  // Wait for both turns to finish: END moves the clock, exactly once.
  for (let i = 0; i < 160; i++) {
    const rows = ((await api("/api/sessions")).body.live ?? []) as { id: string; status: string }[];
    const busy = rows.filter((r) => (r.id === a || r.id === b) && r.status === "running").length;
    if (!busy) break;
    await sleep(500);
  }
  await sleep(400);
  const aEnd = await lastAtOf(a);
  check("the END of a turn DOES move the clock (the one move a turn is allowed besides its start)",
    aEnd > aStart, `${aStart} -> ${aEnd}`);

  // And the whole rail ordering is now driven by two events per turn: sample the rank twice inside a
  // running turn — it must not change.
  await prompt(a, "A2");
  await prompt(b, "B2");
  await sleep(800);
  const rankOf = async (): Promise<string> => {
    const rows = ((await api("/api/sessions")).body.live ?? []) as { id: string; lastAt?: number }[];
    return rows.filter((r) => r.id === a || r.id === b)
      .sort((x, y) => (y.lastAt ?? 0) - (x.lastAt ?? 0))
      .map((r) => (r.id === a ? "A" : "B")).join("");
  };
  const r1 = await rankOf();
  await sleep(2500);
  const r2 = await rankOf();
  check("the rail's ORDER is identical at both ends of a running turn (this is the bug the operator saw)",
    r1 === r2, `${r1} vs ${r2}`);

  ws.close();
  await api(`/api/sessions/${a}`, { method: "DELETE" });
  await api(`/api/sessions/${b}`, { method: "DELETE" });
} finally {
  child.kill("SIGTERM");
  for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(100);
  if (child.exitCode === null) child.kill("SIGKILL");
  fs.rmSync(data, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
