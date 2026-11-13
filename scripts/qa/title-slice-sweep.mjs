// 「rail 上的名字最终是不是模型起的」——按 hermes 的真实两帧形状测，首行超过 48 字符的那一类（issue #105）。
//
// #89 已经证明了两帧的存在（回合开头推用户消息切片、几秒后推模型标题，同一通道、帧里没有来源），
// 也证明了两级去重能让模型标题落地。它没证明的是：这个判别在**首行很长**的会话上成立。判别靠
// 「复算出来的切片 == 帧里的标题」，而复算的上限/切法曾经和 agent 不同（50 硬切 vs 48 词边界 + `…`），
// 于是长首行的会话 100% 判错：切片帧被记成 llm 档，真标题同档不覆盖，rail 永远停在开场白的前缀。
//
// 这个 sweep 用 mock 的 MOCK_TITLE_SLICE 复刻两种生产者：
//   hermes —— 48 + 词边界 + `…`（与客户端对齐后走**全等**那条判据）
//   drift  —— 40 硬切、无标记（两边都不像，只能靠**前缀**那条判据救回来）
//
//   node scripts/qa/title-slice-sweep.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createTcp } from "node:net";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(import.meta.dirname, "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LLM_TITLE = "行情看板公网入口";
// 复刻操作者的真实开场：一行 60+ 字符、带空格（词边界才有东西可退）。注意它不是 48 的整数倍，
// 两种切法给出的字符串必然不同 —— 正是 issue 里那 13/13 的形态。
const LONG_PROMPT =
  "交办：把行情看板 :8790 打通公网 + 家里局域网 HTTPS（照 Agentus 的形状来），先给方案再动手，别改我机器上的现有配置";
const SHORT_PROMPT = "看下新issue";

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

/** Boot one throwaway cockpit whose hermes backend runs the mock agent. */
const startInstance = async (sliceMode, llmDelayMs) => {
  const PORT = await freePort();
  const dataDir = mkdtempSync(path.join(tmpdir(), "agentus-title105-"));
  const home = mkdtempSync(path.join(tmpdir(), "agentus-title105-home-"));
  const BASE = `http://127.0.0.1:${PORT}`;
  let log = "";
  const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
    detached: true,
    cwd: ROOT,
    env: {
      ...process.env, NODE_ENV: "development", HOME: home,
      AGENTUS_PORT: String(PORT), AGENTUS_DATA: dataDir, AGENTUS_AUTH: "off",
      MOCK_SLOW_MS: "20", MOCK_TITLE_STAGE: "1",
      MOCK_TITLE_LLM: LLM_TITLE, MOCK_TITLE_LLM_MS: String(llmDelayMs),
      ...(sliceMode ? { MOCK_TITLE_SLICE: sliceMode } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => { log += String(d); });
  proc.stderr.on("data", (d) => { log += String(d); });
  for (let i = 0; i < 200 && !log.includes(`:${PORT}`); i++) await sleep(150);
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }

  const api = async (p, init = {}) => {
    const res = await fetch(`${BASE}${p}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  // The builtin hermes row keeps its identity; only the executable changes — no live home, no real
  // agent. Same trick the other cockpit sweeps use.
  const { body: rows } = await api("/api/backends");
  const hermes = (rows ?? []).find((r) => r.id === "hermes");
  await api("/api/backends/hermes", {
    method: "PUT",
    body: JSON.stringify({
      ...hermes, cmd: process.execPath, args: [path.join(ROOT, "packages/server/mock/agent.mjs")],
      home: null, env: [], profile: null, cwd: null,
    }),
  });

  const row = (id) => {
    const d = new DatabaseSync(path.join(dataDir, "agentus.sqlite"), { readOnly: true });
    try {
      const r = d.prepare("select title, title_src from sessions where id = ?").get(id);
      return r ? { title: String(r.title), src: r.title_src == null ? null : String(r.title_src) } : null;
    } finally { d.close(); }
  };
  const liveTitle = async (id) => {
    const { body } = await api("/api/sessions");
    return (body?.live ?? []).find((s) => s.id === id)?.title ?? null;
  };
  const create = async () => {
    const { body } = await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "hermes", cwd: "/tmp", title: "" }) });
    const id = body?.id;
    for (let i = 0; i < 120 && id; i++) {
      const { body: list } = await api("/api/sessions");
      if ((list?.live ?? []).find((s) => s.id === id)?.status === "ready") break;
      await sleep(250);
    }
    return id;
  };
  const say = (id, text) => api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text }) });
  // The model frame lands `llmDelayMs` after the slice; wait for the title to stop moving.
  const settle = async (id, ms = 4000) => {
    let last = null, quiet = 0;
    for (let i = 0; i < Math.ceil(ms / 200); i++) {
      const t = await liveTitle(id);
      if (t === last) quiet++; else { last = t; quiet = 0; }
      await sleep(200);
    }
    return { title: await liveTitle(id), quietTicks: quiet };
  };
  return { PORT, dataDir, BASE, api, row, liveTitle, create, say, settle, stop: () => { try { process.kill(-proc.pid, "SIGKILL"); } catch { /* gone */ } }, log: () => log };
};

// ---- A. 真实形状（48 + 词边界 + …）：长首行必须落到模型标题，且切片帧本身记 agent 档 --------------
{
  const inst = await startInstance("hermes", 2500);
  try {
    const id = await inst.create();
    check("A0 建出一个会话并 ready", Boolean(id), String(id));
    await inst.say(id, LONG_PROMPT);

    // Read BEFORE the model frame lands: this is the state #105 locked in forever. Our own derived
    // name also ends in `…` (same rule), so wait for the FRAME (src=agent) rather than for the shape.
    let mid = null;
    for (let i = 0; i < 40; i++) {
      const r = inst.row(id);
      if (r && r.src === "agent") { mid = r; break; }
      await sleep(120);
    }
    check("A1 切片帧到达时，名字是用户原话的前缀（形态正确）",
      Boolean(mid && LONG_PROMPT.startsWith(mid.title.replace(/…$/, ""))),
      JSON.stringify(mid?.title));
    check("A2 切片帧记 agent 档（不是 llm —— 这才是 #105 的错档）",
      mid?.src === "agent", `src=${mid?.src} title=${JSON.stringify(mid?.title)}`);

    const done = await inst.settle(id);
    check("A3 模型标题覆盖了切片（rail 上是摘要名）", done.title === LLM_TITLE, JSON.stringify(done.title));
    check("A4 名字不再以 … 结尾（不是用户原话的半截）",
      !String(done.title).endsWith("…") && !String(done.title).includes("…"), JSON.stringify(done.title));
    const r = inst.row(id);
    check("A5 title_src 记 llm —— 这一列要能回答「被模型命名过没有」", r?.src === "llm", `src=${r?.src}`);

    await inst.say(id, "再聊一轮，标题不许变");
    const again = await inst.settle(id, 3000);
    check("A6 下一轮不闪改标题（每轮重算不覆盖同级）", again.title === LLM_TITLE, JSON.stringify(again.title));

    // 短首行走的是「全等」那条老判据，#89 的语义不许回退。
    const id2 = await inst.create();
    await inst.say(id2, SHORT_PROMPT);
    const short = await inst.settle(id2);
    check("A7 首行 ≤48 的会话同样落到模型标题（#89 语义不回退）", short.title === LLM_TITLE, JSON.stringify(short.title));
  } finally { inst.stop(); }
}

// ---- B. 生产者换了切法（drift：40 硬切、无省略号）：只有前缀判据能救 ------------------------
{
  const inst = await startInstance("drift", 800);
  try {
    const id = await inst.create();
    await inst.say(id, LONG_PROMPT);
    const done = await inst.settle(id, 3500);
    const r = inst.row(id);
    check("B1 切片规则两边都不一致时，模型标题仍然落地（前缀判据）",
      done.title === LLM_TITLE, `${JSON.stringify(done.title)} src=${r?.src}`);
    check("B2 这种形状下 title_src 仍是 llm", r?.src === "llm", `src=${r?.src}`);
  } finally { inst.stop(); }
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
await sleep(300);
process.exit(fail === 0 ? 0 : 1);
