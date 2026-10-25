// #62-1 / #62-2 的回归：模型热度计数、冷会话换模型、resume 重放。
//
// 判据全部走 HTTP + 会话行本身，不碰 UI：
//   · 成功的切换让 (backend, modelId) 计数 +1
//   · **被 agent 拒的切换不加分** —— 这是"广告了但不可用"的条目自动沉底的唯一依据
//   · 冷会话（进程被杀）上 setModel 不再 409 "resume it first"，而是记下 pendingModelId
//   · resume 之后 pendingModelId 被清掉，且真实模型就是它
//
//   node scripts/qa/model-picker.mjs
import { spawn } from "node:child_process";
import { createServer as createTcp } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const freePort = () => new Promise((res, rej) => {
  const s = createTcp();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});
const PORT = await freePort();
const dataDir = mkdtempSync(path.join(tmpdir(), "agentus-model-"));
const emptyHome = mkdtempSync(path.join(tmpdir(), "agentus-model-home-"));
const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
  detached: true,
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: "development", HOME: emptyHome, AGENTUS_PORT: String(PORT), AGENTUS_DATA: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
proc.stdout.on("data", (d) => { log += String(d); });
proc.stderr.on("data", (d) => { log += String(d); });
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 120 && !log.includes(`0.0.0.0:${PORT}`); i++) await sleep(150);
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }
const token = () => readFileSync(path.join(dataDir, "auth.token"), "utf8").trim();
const api = async (p, opts = {}) => {
  const r = await fetch(`${BASE}${p}`, {
    ...opts,
    headers: { authorization: `Bearer ${token()}`, ...(opts.body ? { "content-type": "application/json" } : {}), ...(opts.headers ?? {}) },
  });
  const text = await r.text();
  return { status: r.status, text, json: () => (text ? JSON.parse(text) : null) };
};
const usage = async () => (await api("/api/model-usage")).json().usage;
const sessions = async () => (await api("/api/sessions")).json();
// /api/sessions 的形状是 {live, cold, archived, pending}，不是一个数组 —— 三个桶里都要找。
const allSessions = (payload) => (Array.isArray(payload) ? payload : [
  ...(payload?.live ?? []), ...(payload?.cold ?? []), ...(payload?.archived ?? []),
]);
const find = (payload, id) => allSessions(payload).find((s) => s.id === id);

try {
  // ---- 建一个 mock 会话
  const created = await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "mock", cwd: "/tmp" }) });
  if (created.status !== 200) console.log("create said:", created.status, created.text.slice(0, 200));
  const sid = created.json().id;
  check("a mock session came up", Boolean(sid), sid);
  for (let i = 0; i < 60; i++) {
    const s = find(await sessions(), sid);
    if (s && s.status === "ready") break;
    await sleep(250);
  }
  const live = find(await sessions(), sid);
  check("it is ready and advertises models", live?.status === "ready" && (live?.models?.availableModels ?? []).length > 0,
    `${live?.status} · ${(live?.models?.availableModels ?? []).length} models`);

  // ---- #62-1 成功的切换计数
  const before = (await usage())["mock|mock:deep"] ?? 0;
  const ok1 = await api(`/api/sessions/${sid}/model`, { method: "POST", body: JSON.stringify({ modelId: "mock:deep" }) });
  check("switching to a real model succeeds", ok1.status === 200, `${ok1.status} ${ok1.text.slice(0, 80)}`);
  const after = (await usage())["mock|mock:deep"] ?? 0;
  check("the successful switch was counted", after === before + 1, `${before} → ${after}`);

  // ---- 被拒的切换不加分
  const rejectedBefore = (await usage())["mock|mock:gone"] ?? 0;
  const ok2 = await api(`/api/sessions/${sid}/model`, { method: "POST", body: JSON.stringify({ modelId: "mock:gone" }) });
  const rejectedAfter = (await usage())["mock|mock:gone"] ?? 0;
  check("a refused model does not count", ok2.status >= 400 && rejectedAfter === rejectedBefore,
    `${ok2.status} · usage ${rejectedBefore} → ${rejectedAfter}`);

  // ---- 冷会话
  const s2 = find(await sessions(), sid);
  if (s2?.pid) { try { process.kill(s2.pid, "SIGKILL"); } catch { /* gone */ } }
  let cold = null;
  for (let i = 0; i < 60; i++) {
    cold = find(await sessions(), sid);
    // 崩溃的槽位不是"冷"：它还在 manager 的 map 里，状态是 error，行上还留着旧 pid。
    // 界面上这就是"这个会话坏了"的形状 —— 也正是操作者最想换模型重试的时刻。
    if (cold && cold.status === "error") break;
    await sleep(250);
  }
  check("killing the agent leaves the slot in error", cold?.status === "error", `${cold?.status}`);

  const coldPick = await api(`/api/sessions/${sid}/model`, { method: "POST", body: JSON.stringify({ modelId: "mock:vision" }) });
  const coldBody = coldPick.json() ?? {};
  check("a cold slot accepts a model pick instead of 409", coldPick.status === 200, `${coldPick.status} ${coldPick.text.slice(0, 90)}`);
  check("…and parks it as pendingModelId", coldBody.pendingModelId === "mock:vision", String(coldBody.pendingModelId));

  // ---- resume 重放
  // 崩溃的槽位仍在 manager 的 map 里（status=error），/resume 会原样返回它 —— 复活要走 /restart
  // （内部 resume({replace:true})，同样落到重放那段）。这正是界面上"重新启动"按钮的路径。
  const resumed = await api(`/api/sessions/${sid}/restart`, { method: "POST" });
  check("the slot resumes", resumed.status === 200, `${resumed.status} ${resumed.text.slice(0, 90)}`);
  { const rb = resumed.json() ?? {};
    console.log("      resume →", JSON.stringify({ current: rb.models?.currentModelId, pending: rb.pendingModelId ?? null, status: rb.status })); }
  let after2 = null;
  for (let i = 0; i < 60; i++) {
    after2 = find(await sessions(), sid);
    if (after2?.status === "ready" && (after2?.models?.currentModelId === "mock:vision")) break;
    await sleep(250);
  }
  check("the parked model was replayed on resume", after2?.models?.currentModelId === "mock:vision",
    `current=${after2?.models?.currentModelId}`);
  if (after2?.models?.currentModelId !== "mock:vision") {
    console.log("---- log lines mentioning model ----\n" + log.split("\n").filter((l) => /model|pending/i.test(l)).join("\n"));
  }
  check("…and the pending mark is cleared", !after2?.pendingModelId, String(after2?.pendingModelId));
  const replayed = (await usage())["mock|mock:vision"] ?? 0;
  check("the replayed switch counted as a use", replayed >= 1, String(replayed));

  // ---- 新建会话的握手窗口里点模型：那一刻会话是 starting（不是冷），以前这个选择没有任何
  // 路径会兑现 —— 徽标挂着、模型一直是老的，直到几小时后被回收再 resume。create 成功后必须重放。
  {
    const c = await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "mock", cwd: "/tmp" }) });
    const id2 = c.json().id;
    const pick = await api(`/api/sessions/${id2}/model`, { method: "POST", body: JSON.stringify({ modelId: "mock:vision" }) });
    check("a pick during the handshake is accepted", pick.status === 200 && pick.json()?.pendingModelId === "mock:vision",
      `${pick.status} ${pick.text.slice(0, 80)}`);
    let s2 = null;
    for (let i = 0; i < 80; i++) {
      s2 = find(await sessions(), id2);
      if (s2?.status === "ready" && s2?.models?.currentModelId === "mock:vision") break;
      await sleep(250);
    }
    check("…and is applied once the agent is ready", s2?.models?.currentModelId === "mock:vision" && !s2?.pendingModelId,
      `current=${s2?.models?.currentModelId} pending=${s2?.pendingModelId}`);
    await api(`/api/sessions/${id2}`, { method: "DELETE" }).catch(() => {});
  }

  await api(`/api/sessions/${sid}`, { method: "DELETE" }).catch(() => {});
} catch (e) {
  console.log("THREW:", e);
  fail++;
} finally {
  try { process.kill(-proc.pid, "SIGKILL"); } catch { /* gone */ }
}
console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
