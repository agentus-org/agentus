// 会话自动标题的两段升级（issue #89）。
//
// 这个 sweep 证的是「rail 上的名字最终是模型起的，而且只升级一次」：
//   ① 首回合过后 `sessions.title` 是模型标题，不是首条消息切片；`title_src` 记成 llm
//      （不是笼统的 agent —— 那一列要能回答「这个会话到底被模型命名过没有」）。
//   ② 之后连续几轮对话，标题不再变化（每轮重算不闪改，这条纪律必须留着）。
//   ③ 操作员手动改名后，任何后续自动标题都不得覆盖（回归）。
//   ④ 占位名（`<backend> @ <dir>`）仍会被第一帧真名替换（回归）。
//
// 为什么能这样测：hermes 的真实形状是「回合开始推切片、几秒后推模型标题，两帧都走
// session_info_update 且帧里没有来源」。mock 用 `MOCK_TITLE_STAGE=1` 复刻这个形状（见
// packages/server/mock/agent.mjs），否则这条 bug 在测试里根本不存在。
//
// 自给自足：临时数据目录 + 把内置 hermes 后端临时指到 mock agent + 随机端口。
//   node scripts/qa/title-upgrade-sweep.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createTcp } from "node:net";
import { DatabaseSync } from "node:sqlite";

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
const dataDir = mkdtempSync(path.join(tmpdir(), "agentus-title-"));
const emptyHome = mkdtempSync(path.join(tmpdir(), "agentus-title-home-"));
const BASE = `http://127.0.0.1:${PORT}`;
const LLM_TITLE = "Mock model title";
let log = "";
let proc = null;

const boot = async () => {
  log = "";
  proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
    detached: true,
    cwd: ROOT,
    env: {
      ...process.env, NODE_ENV: "development", HOME: emptyHome,
      AGENTUS_PORT: String(PORT), AGENTUS_DATA: dataDir, AGENTUS_AUTH: "off",
      MOCK_SLOW_MS: "20", MOCK_TITLE_STAGE: "1", MOCK_TITLE_LLM: LLM_TITLE, MOCK_TITLE_LLM_MS: "700",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => { log += String(d); });
  proc.stderr.on("data", (d) => { log += String(d); });
  for (let i = 0; i < 160 && !log.includes(`:${PORT}`); i++) await sleep(150);
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* booting */ } await sleep(250); }
};

const cleanup = () => { try { process.kill(-proc.pid, "SIGKILL"); } catch { /* gone */ } };
process.on("exit", cleanup);
await boot();

const api = async (p, init = {}) => {
  const res = await fetch(`${BASE}${p}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
};

// ---- 0. 把内置 hermes 后端临时指向 mock agent（形态不变，只换可执行文件） --------------------
{
  const { body: rows } = await api("/api/backends");
  const hermes = (rows ?? []).find((r) => r.id === "hermes");
  const row = {
    ...hermes, cmd: process.execPath, args: [path.join(ROOT, "packages/server/mock/agent.mjs")],
    home: null, env: [], profile: null, cwd: null,
  };
  const { status } = await api("/api/backends/hermes", { method: "PUT", body: JSON.stringify(row) });
  check("内置 hermes 后端已临时改到 mock", status === 200 || status === 204, `HTTP ${status}`);
}

const db = () => new DatabaseSync(path.join(dataDir, "agentus.sqlite"));
const rowOf = (id) => {
  const d = db();
  try {
    const r = d.prepare("select title, auto_title, title_src from sessions where id = ?").get(id);
    return r ? { title: String(r.title), auto: r.auto_title == null ? null : String(r.auto_title), src: r.title_src == null ? null : String(r.title_src) } : null;
  } finally { d.close(); }
};

let seq = 0;
const waitReady = async (id) => {
  for (let i = 0; i < 120; i++) {
    const { body } = await api("/api/sessions");
    const row = (body?.live ?? []).find((s) => s.id === id);
    if (row?.status === "ready") return true;
    await sleep(250);
  }
  return false;
};
const say = async (id, text) => api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text }) });
const titleOf = async (id) => {
  const { body } = await api("/api/sessions");
  const live = (body?.live ?? []).find((s) => s.id === id);
  const cold = (body?.cold ?? []).find((s) => s.id === id);
  return (live ?? cold)?.title ?? null;
};
/** Wait until the title stops moving, then report it — the model frame lands ~700ms after the slice. */
const settle = async (id, ms = 2500) => {
  let last = null, at = 0;
  for (let i = 0; i < Math.ceil(ms / 200); i++) {
    const t = await titleOf(id);
    if (t !== last) { last = t; at = i; }
    await sleep(200);
  }
  await sleep(300);
  return { title: await titleOf(id), quietForMs: (Math.ceil(ms / 200) - at) * 200 };
};

// ---- ① 首回合后是模型标题，不是切片 --------------------------------------------------------
const created = await api("/api/sessions", {
  method: "POST", body: JSON.stringify({ backend: "hermes", cwd: "/tmp", title: "" }),
});
const id = created.body?.id;
check("建出一个会话", Boolean(id), `HTTP ${created.status} ${created.body?.id ?? ""}`);
check("会话 ready（create 不等握手，打 prompt 前要先等）", id ? await waitReady(id) : false);

const firstText = "调研下 droidance 的原理，为什么能操作手机";
if (id) await say(id, firstText);
const afterFirst = id ? await settle(id) : { title: null };
check("首回合后 rail 上是模型标题（不是首条消息的切片）",
  afterFirst.title === LLM_TITLE, `${JSON.stringify(afterFirst.title)}`);
check("不是切片（回归判据：切片是首行截断）",
  afterFirst.title !== firstText.slice(0, 50), String(afterFirst.title));
const r1 = id ? rowOf(id) : null;
check("title_src 记成 llm —— 这一列要能回答「有没有被模型命名过」",
  r1?.src === "llm", `src=${r1?.src} title=${JSON.stringify(r1?.title)}`);
check("auto_title 同步成模型标题（改名仍可逆）", r1?.auto === LLM_TITLE, JSON.stringify(r1?.auto));

// ---- ② 之后几轮不再变 ---------------------------------------------------------------------
if (id) { await say(id, "再帮我看看第二条消息"); await settle(id, 2000); }
check("第二轮之后标题没变（每轮重算不闪改）", (await titleOf(id)) === LLM_TITLE, String(await titleOf(id)));
if (id) { await say(id, "还有第三条"); await settle(id, 2000); }
check("第三轮之后标题仍然没变", (await titleOf(id)) === LLM_TITLE, String(await titleOf(id)));

// ---- ③ 操作员改名后不被自动标题覆盖 --------------------------------------------------------
const manual = "我手动起的名字";
if (id) await api(`/api/sessions/${id}/rename`, { method: "POST", body: JSON.stringify({ title: manual }) });
check("手动改名生效", (await titleOf(id)) === manual, String(await titleOf(id)));
if (id) { await say(id, "改名之后再聊一轮"); await settle(id, 2500); }
const r3 = id ? rowOf(id) : null;
check("改名后的自动标题不覆盖操作员的名字", (await titleOf(id)) === manual, `${JSON.stringify(r3?.title)} src=${r3?.src}`);

// ---- ④ 占位名仍会被第一帧真名替换（回归） ---------------------------------------------------
// 一个从没发过消息的会话，标题就是 `<backend> @ <dir>` 占位名；模型标题必须能把它换掉。
const fresh = await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "hermes", cwd: "/tmp" }) });
const freshId = fresh.body?.id;
const placeholder = fresh.body?.title ?? "";
if (freshId) await waitReady(freshId);
check("新会话先是占位名", /@/.test(placeholder), placeholder);
if (freshId) { await say(freshId, "换个话头试试"); await settle(freshId, 2500); }
check("占位名被模型标题替换（回归）", (await titleOf(freshId)) === LLM_TITLE, String(await titleOf(freshId)));

// ---- ⑤ 一个已落成切片名的存量行会被下一帧模型标题修好 --------------------------------------
// 这正是 #89 里那 107 个会话的状态：title 是切片、title_src=agent。再聊一轮，它应该自愈。
if (id) {
  const d = db();
  try {
    d.prepare("update sessions set title = ?, auto_title = ?, title_src = 'agent' where id = ?")
      .run(firstText.slice(0, 50), firstText.slice(0, 50), id);
  } finally { d.close(); }
  await say(id, "存量切片名再来一轮");
  await settle(id, 2500);
  const healed = rowOf(id);
  check("存量的「切片名 + src=agent」会被下一帧模型标题修好（107 个会话靠这条自愈）",
    healed?.title === LLM_TITLE && healed?.src === "llm", `title=${JSON.stringify(healed?.title)} src=${healed?.src}`);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
cleanup();
process.exit(fail === 0 ? 0 : 1);
