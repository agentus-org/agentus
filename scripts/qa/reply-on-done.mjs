// #59: `send --reply-on-done` — 派活给一个要跑很久的会话，然后不在这里等它。
//
// 今天 `session send` 是同步死等：`await mgr.prompt(…)` 到目标回合结束才返回（几十秒到几十分钟），
// 长任务根本没法用；而一旦不等，调用方就再也没有任何信号，只能自己写 sleep + `session messages`
// 轮询。这个标志补的就是另一半：立即回执 + 目标回合自然结束时把一条【完成回推】投进调用方会话
// （走 #39 那条"唤醒某会话"的链子，冷会话会被叫起来）。
//
// 这里全部走真路径：真 server、真 mock agent、真 CLI 进程（环境里的 AGENTUS_COCKPIT_* 身份是从
// agent 进程上读出来的，和 agent 自己看到的一样）。断言：
//   1. 带标志：调用立即返回（不等回合），回执带 reply_on_done；
//   2. 目标回合结束后，调用方会话里真的多了一条【完成回推】，说清是谁、用了多久；
//   3. 不带标志：行为和今天一模一样（照样等回合跑完）—— 这是"不改变既有行为"的回归项；
//   4. 目标忙且没 --interrupt：仍然 target_busy，而且不会留下一条永远不来的登记；
//   5. 操作者模式（没有 caller）用它：明确拒绝，而不是登记一条没人接的通知。
//
// Run: node scripts/qa/reply-on-done.mjs
import { execFileSync, spawn } from "node:child_process";
import { createServer as createTcp } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const BIN = path.join(ROOT, "bin/agentus.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const freePort = () => new Promise((res, rej) => {
  const s = createTcp();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});

const PORT = await freePort();
const DATA = mkdtempSync(path.join(tmpdir(), "agentus-reply-"));
const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
  detached: true, cwd: ROOT,
  env: { ...process.env, NODE_ENV: "development", AGENTUS_PORT: String(PORT), AGENTUS_DATA: DATA },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
proc.stdout.on("data", (d) => { log += String(d); });
proc.stderr.on("data", (d) => { log += String(d); });
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 120 && !log.includes(`0.0.0.0:${PORT}`); i += 1) await sleep(150);
const token = () => readFileSync(path.join(DATA, "auth.token"), "utf8").trim();
const api = async (p, init = {}) => {
  const r = await fetch(`${BASE}${p}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${token()}`, ...(init.headers ?? {}) },
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
};

/** Run the CLI the way an agent would (identity in the environment). */
const cli = (env, args) => {
  const started = Date.now();
  try {
    const out = execFileSync(process.execPath, [BIN, ...args], {
      cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, doc: JSON.parse(out), ms: Date.now() - started, stderr: "" };
  } catch (e) {
    const out = String(e.stdout ?? "");
    return { code: e.status ?? -1, doc: out ? JSON.parse(out) : null, ms: Date.now() - started, stderr: String(e.stderr ?? "") };
  }
};

/** The cockroft identity the server handed this agent child — read from ITS process, not invented. */
const identityOf = (pid) => {
  const env = execFileSync("ps", ["eww", "-p", String(pid)], { encoding: "utf8" });
  const found = {};
  for (const kv of env.split(/\s+/)) {
    const at = kv.indexOf("=");
    if (at > 0 && kv.startsWith("AGENTUS_COCKPIT_")) found[kv.slice(0, at)] = kv.slice(at + 1);
  }
  return found;
};

const mkSession = async (title) => {
  const made = await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "mock", cwd: "/tmp", title }) });
  const id = made.body?.id;
  if (!id) throw new Error(`could not create ${title}: ${JSON.stringify(made.body)}`);
  for (let i = 0; i < 80; i += 1) {
    const row = ((await api("/api/sessions")).body?.live ?? []).find((s) => s.id === id);
    if (row?.status === "ready" && row.pid) return row;
    await sleep(300);
  }
  throw new Error(`${title} never reached ready`);
};

// the cockpit's own read plane — the same rows an agent sees through `session messages`
const messages = async (id) => {
  const r = await api(`/api/cockpit/messages?id=${id}&tail=60`);
  return r.body?.messages ?? [];
};
const textOf = (m) => String(m?.payload ?? m?.text ?? m?.content ?? "");

try {
  await api("/api/settings", { method: "PUT", body: JSON.stringify({ agent: { cockpitSend: true } }) });
  const A = await mkSession("总管A");
  const B = await mkSession("交付B");
  check("fixture: two sessions (a dispatcher and a worker)", Boolean(A.id && B.id), `${A.id} ${B.id}`);
  const asA = identityOf(A.pid);
  check("the dispatcher's own cockpit identity came from its process", Boolean(asA.AGENTUS_COCKPIT_SESSION), JSON.stringify(Object.keys(asA)));

  // ---- 1. 带标志：立即返回，不等回合 ------------------------------------------------
  const sent = cli(asA, ["session", "send", B.id, "[hold:6000] 帮我跑个慢活", "--reply-on-done"]);
  check("`send --reply-on-done` is accepted", sent.code === 0 && sent.doc?.success === true, sent.stderr || JSON.stringify(sent.doc));
  check("…and it carries reply_on_done in the receipt", sent.doc?.data?.reply_on_done === true, JSON.stringify(sent.doc?.data));
  check("…and it answers AT ONCE — it does not wait for the 6 s turn", sent.ms < 2500, `${sent.ms}ms`);

  // ---- 2. 目标跑完 → 调用方收到【完成回推】 ------------------------------------------
  let notice = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    const rows = await messages(A.id);
    const hit = rows.find((m) => textOf(m).includes("完成回推"));
    if (hit) { notice = textOf(hit); break; }
  }
  check("when the worker's turn ends the dispatcher gets a 【完成回推】", notice != null, String(notice).slice(0, 120));
  check("…naming the worker, not just \"something finished\"", notice != null && notice.includes("交付B"), String(notice).slice(0, 120));
  check("…with how long it took", /（\d+ 秒）/.test(String(notice)), String(notice).slice(0, 120));
  check("…and it does NOT carry the answer body (that is what session messages is for)",
    notice != null && !/Mock echo|慢活/.test(String(notice)), String(notice).slice(0, 160));

  // ---- 3. 不带标志：行为必须和今天一模一样（照样等回合跑完） --------------------------
  const blocking = cli(asA, ["session", "send", B.id, "[hold:4000] 老写法"]);
  check("`send` without the flag still waits for the turn (existing behaviour untouched)",
    blocking.code === 0 && blocking.ms >= 3500, `${blocking.ms}ms`);

  // ---- 4. 忙目标 + 不抢话头：仍然 target_busy，而且不留登记 -------------------------
  const slow = cli(asA, ["session", "send", B.id, "[hold:7000] 占住它", "--reply-on-done"]);
  check("the worker is now busy with a long turn", slow.code === 0, slow.stderr);
  const refused = cli(asA, ["session", "send", B.id, "抢不了就该拒", "--reply-on-done"]);
  check("a BUSY target still answers target_busy (reply-on-done does not buy a queue slot)",
    refused.code !== 0 && /target_busy/.test(JSON.stringify(refused.doc)), JSON.stringify(refused.doc).slice(0, 160));
  await sleep(9000);   // 让上面那条慢回合跑完
  const rowsAfter = await messages(A.id);
  // the mock ECHOES whatever it is given, so each notice shows up twice in the transcript (the
  // injected user row + the agent repeating it) — count distinct texts, not rows.
  const notices = new Set(rowsAfter.map(textOf).filter((t) => t.startsWith("【完成回推】")));
  check("…and the refused send left no stale reply behind (exactly the two real ones)",
    notices.size === 2, `distinct notices=${notices.size}`);

  // ---- 5. 操作者模式：没有 caller 就没有人接这条通知 -------------------------------
  const operator = cli(
    { AGENTUS_ENDPOINT: BASE, AGENTUS_DATA: DATA, AGENTUS_PORT: String(PORT) },
    ["session", "send", B.id, "我是操作者", "--reply-on-done"],
  );
  // 操作者身份没有「我的会话」，所以没人接这条回推。今天它在更早的一层就被拒（拿不到目标行），
  // 这里只要它**没有**被当成一次成功的派活。
  check("in operator mode it is refused (there is no origin session to reply to)",
    operator.code !== 0, JSON.stringify(operator.doc).slice(0, 200));
} finally {
  try { process.kill(-proc.pid, "SIGTERM"); } catch { /* gone */ }
}
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
