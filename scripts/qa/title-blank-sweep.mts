// Two things the operator reported in one breath (2026-10-17): 「跑着跑着会话标题就变了」 and
// 「发消息后最下面有个思考，显示 0 个字」.
//
// Part A — the title settles. Three sources write one column: `derived` (a truncation of the first
// prompt, no model), `agent` (the name the agent announced — Hermes regenerates one EVERY turn via
// auxiliary `title_generation`) and `operator` (typed by hand). Rank decides who may overwrite whom:
// derived < agent < operator, and an `agent` name never replaces another `agent` name. Subscribing to
// every generated name was the churn.
//
// Part B — an empty thought is not a row. The status carrier is an empty `agent_thought_chunk`; when
// its `_meta` is lost the frame arrives as a bare empty thought, and storing it drew 「思考 0 字」.
// The `[blank]` fixture sends exactly that shape.
//
//   npx tsx scripts/qa/title-blank-sweep.mts
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

// ── Part A: the title settles ────────────────────────────────────────────────────────────────
{
  const { Store } = await import("../../packages/server/src/store/store.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-title-"));
  const store = new Store(path.join(dir, "agentus.sqlite"));
  const SID = "sess_title_settle";
  store.upsertSession({
    id: SID, backend: "mock", acpSessionId: null, cwd: "/tmp", title: "Mock @ tmp", status: "ready",
    pid: null, createdAt: Date.now(), closedAt: null,
  } as never);

  store.setAutoTitle(SID, "修一下语音热词", { src: "derived" });
  check("a derived name (first prompt) does name the row", store.getSession(SID)?.title === "修一下语音热词",
    String(store.getSession(SID)?.title));

  store.setAutoTitle(SID, "修复语音识别的热词与上下文", { src: "agent" });
  check("…the agent's own name replaces it (a real summary beats a truncation)",
    store.getSession(SID)?.title === "修复语音识别的热词与上下文", String(store.getSession(SID)?.title));

  // the churn: Hermes re-titles on every turn
  for (const t of ["语音热词修复（第二次）", "语音与上下文（第三次）", "热词（第四次）"]) {
    store.setAutoTitle(SID, t, { src: "agent" });
  }
  check("…and every LATER agent name leaves it alone (this is the churn that was reported)",
    store.getSession(SID)?.title === "修复语音识别的热词与上下文", String(store.getSession(SID)?.title));
  check("…a stale generated name never comes back through autoTitle either",
    store.getSession(SID)?.autoTitle === "修复语音识别的热词与上下文", String(store.getSession(SID)?.autoTitle));

  store.renameSession(SID, "我自己的名字", null);
  store.setAutoTitle(SID, "又一个新的生成名", { src: "agent" });
  check("an operator name is never overwritten by a generated one",
    store.getSession(SID)?.title === "我自己的名字", String(store.getSession(SID)?.title));

  store.setAutoTitle(SID, "操作员点了重新生成", { src: "agent", force: true });
  check("…but 重新生成 (force) IS allowed to replace it — the operator asked",
    store.getSession(SID)?.title === "操作员点了重新生成", String(store.getSession(SID)?.title));

  store.renameSession(SID, null, null);
  check("clearing a name falls back to the generated one",
    store.getSession(SID)?.title === "操作员点了重新生成", String(store.getSession(SID)?.title));
  store.setAutoTitle(SID, "清空之后生成的第二个名字", { src: "agent" });
  check("…and after the reset the row is generated again, so later agent names are sticky again",
    store.getSession(SID)?.title === "操作员点了重新生成", String(store.getSession(SID)?.title));
  store.close?.();
}

// ── Part B: an empty thought never becomes a row ────────────────────────────────────────────
{
  const PORT = Number(process.env.BLANK_SWEEP_PORT ?? 8926);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-blank-"));
  const env = { ...process.env, AGENTUS_PORT: String(PORT), AGENTUS_DATA: data, AGENTUS_DEV: "1" };
  delete env.AGENTUS_BASE;
  const child = spawn(process.execPath, ["--import", "tsx", "packages/server/src/index.ts"], {
    cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (b) => { log += String(b); });
  child.stderr.on("data", (b) => { log += String(b); });
  try {
    let up = false;
    for (let i = 0; i < 150 && !up; i++) {
      if (child.exitCode !== null) throw new Error(`server exited: ${log.slice(-600)}`);
      up = await fetch(`http://127.0.0.1:${PORT}/healthz`).then((r) => r.ok).catch(() => false);
      if (!up) await sleep(200);
    }
    if (!up) throw new Error(`server never came up: ${log.slice(-600)}`);
    const token = fs.readFileSync(path.join(data, "auth.token"), "utf8").trim();
    const api = async (p: string, init: RequestInit = {}) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
        ...init,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      });
      const t = await r.text();
      try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t }; }
    };
    const made = await api("/api/sessions", {
      method: "POST", body: JSON.stringify({ backend: "mock", cwd: "/tmp", title: "空思考（自动删除）" }),
    });
    const sid = made.body?.id as string;
    for (let i = 0; i < 100; i++) {
      const rows = (await api("/api/sessions")).body.live ?? [];
      if (rows.some((r: { id: string; status: string }) => r.id === sid && r.status === "ready")) break;
      await sleep(200);
    }
    await api(`/api/sessions/${sid}/prompt`, { method: "POST", body: JSON.stringify({ text: "[blank] 跑一个空思考回合" }) });
    let rows: any[] = [];
    for (let i = 0; i < 120; i++) {
      await sleep(250);
      rows = (await api(`/api/sessions/${sid}/messages`)).body.messages ?? [];
      if (rows.some((m) => m.kind === "agent")) break;
    }
    const thoughts = rows.filter((m) => m.kind === "thought");
    check("an empty thought frame stores NO row (no 「思考 0 字」 in the transcript)",
      thoughts.every((m) => String(m.payload?.content?.text ?? "").trim().length > 0),
      `${thoughts.length} thought rows`);
    check("…the turn itself still answered (the frame was dropped, not the turn)",
      rows.some((m) => m.kind === "agent" && String(m.payload?.content?.text ?? "").length > 0),
      `${rows.length} rows`);
    await api(`/api/sessions/${sid}`, { method: "DELETE" });
    await api(`/api/sessions/${sid}`, { method: "DELETE" });
  } finally {
    child.kill("SIGTERM");
    for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(100);
    if (child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(data, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
