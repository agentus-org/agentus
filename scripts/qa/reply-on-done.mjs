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
const startsWithReply = (t) => /^【(完成回推|任务回报)/.test(String(t).trim());

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
  // #93-2：标题取投递时刻的会话名会漂移（靶会话被自动改名后三张回执顶着同一句话）。
  // 回执必须说清「是哪一笔活」—— 登记时刻固化的派活摘要。
  check("…naming the JOB it was dispatched for", notice != null && notice.includes("帮我跑个慢活"), String(notice).slice(0, 140));
  check("…and it no longer borrows the worker's title (that is what drifts)",
    notice != null && !notice.includes("交付B"), String(notice).slice(0, 140));
  check("…with how long it took", /（\d+ 秒）/.test(String(notice)), String(notice).slice(0, 120));
  check("…and it does NOT carry the answer body (that is what session messages is for)",
    notice != null && !/Mock echo/.test(String(notice)) && String(notice).length < 200, String(notice).slice(0, 160));

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
  // #93-1：只说「忙」不够 —— 调用方多半是另一个 agent，它得知道下一步要么等、要么 --interrupt。
  check("…and the refusal names both ways forward (retry later / --interrupt)",
    /--interrupt/.test(JSON.stringify(refused.doc)), JSON.stringify(refused.doc).slice(0, 200));
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

  // ---- 6. --interrupt --reply-on-done：回执必须属于「我送进去的那一轮」，不是被它杀掉的那一轮 ----
  // 登记过去绑在「目标会话」上，于是被取消的旧回合收尾时会把新登记的也一起投出去，然后真正的
  // 回合结束时已经没人等 —— 调用方收到一条凭空出现的「被取消了」，再也没等到自己那一条。
  const C = await mkSession("被打断C");
  const busy = cli(asA, ["session", "send", C.id, "[hold:9000] 先占住", "--reply-on-done"]);
  check("a long turn is running on the worker", busy.code === 0, busy.stderr);
  await sleep(700);
  const preNotices = new Set((await messages(A.id)).map(textOf).filter((t) => t.startsWith("【完成回推】"))).size;
  const interlaced = cli(asA, ["session", "send", C.id, "[hold:2500] 抢话头", "--interrupt", "--reply-on-done"]);
  check("`--interrupt --reply-on-done` is accepted", interlaced.code === 0 && interlaced.doc?.data?.reply_on_done === true,
    interlaced.stderr || JSON.stringify(interlaced.doc?.data));
  check("…and the receipt says it interrupted", interlaced.doc?.data?.interrupted === true, JSON.stringify(interlaced.doc?.data));
  let got = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    const rows = await messages(A.id);
    const fresh = rows.map(textOf).filter((t) => startsWithReply(t) && (t.includes("抢话头") || t.includes("被打断C")));
    if (fresh.length > 0) { got = fresh[fresh.length - 1]; break; }
  }
  await sleep(2000);
  const afterInterrupt = (await messages(A.id)).map(textOf).filter((t) => t.startsWith("【完成回推】"));
  check("…and exactly ONE notice arrives for it (the killed turn's registration is not delivered)",
    got != null && afterInterrupt.length === preNotices + 1, `notices=${afterInterrupt.length} expected=${preNotices + 1}`);

  // ---- 7. 关掉「后台任务完成唤醒」不许把派活回执一起关掉 -------------------------------------
  await api("/api/settings", { method: "PUT", body: JSON.stringify({ agent: { completionWake: false } }) });
  const D = await mkSession("静默D");
  const beforeQuiet = (await messages(A.id)).length;
  const quietSend = cli(asA, ["session", "send", D.id, "[hold:1200] 关掉唤醒也要回我", "--reply-on-done"]);
  check("with completionWake OFF the dispatch is still accepted", quietSend.code === 0, quietSend.stderr);
  let quietNotice = null;
  for (let i = 0; i < 30; i += 1) {
    await sleep(500);
    const hit = (await messages(A.id)).map(textOf).find((t) => startsWithReply(t)
      && (t.includes("关掉唤醒也要回我") || t.includes("静默D")));
    if (hit) { quietNotice = hit; break; }
  }
  check("…and the receipt still arrives (that switch is about background noise, not about peers waiting)",
    quietNotice != null, `rows ${beforeQuiet} -> ${(await messages(A.id)).length}`);
  await api("/api/settings", { method: "PUT", body: JSON.stringify({ agent: { completionWake: true } }) });

  // ---- 8. 目标被 --close：登记不许悬着 --------------------------------------------------------
  const E = await mkSession("要关E");
  const closing = cli(asA, ["session", "send", E.id, "[hold:12000] 长活", "--reply-on-done"]);
  check("a long turn is running before the close", closing.code === 0, closing.stderr);
  await sleep(700);
  const stop = cli(asA, ["session", "stop", E.id, "--close"]);
  check("`session stop --close` closes it", stop.code === 0, stop.stderr || JSON.stringify(stop.doc));
  let closeNotice = null;
  for (let i = 0; i < 30; i += 1) {
    await sleep(500);
    const hit = (await messages(A.id)).map(textOf).find((t) => startsWithReply(t)
      && (t.includes("[hold:12000] 长活") || t.includes("长活") || t.includes("要关E")));
    if (hit) { closeNotice = hit; break; }
  }
  check("closing a target with a reply outstanding tells the dispatcher instead of leaving it waiting",
    closeNotice != null, String(closeNotice).slice(0, 120));
  // ---- 9. #93-3：自我打断不出「被取消」回执；第三方打断照发 ---------------------------
  // 「我主动抢了话头，为什么还给我发一条取消通知」—— 取消的回执只该送给**没参与打断**的等待者。
  const F = await mkSession("自我打断F");
  const selfJob = cli(asA, ["session", "send", F.id, "[hold:9000] 我自己派的长活", "--reply-on-done"]);
  check("#93-3 a dispatch is running on F", selfJob.code === 0 && selfJob.doc?.data?.reply_on_done === true, selfJob.stderr);
  await sleep(700);
  const selfInterrupt = cli(asA, ["session", "send", F.id, "[hold:600] 我自己插一句", "--interrupt"]);
  check("#93-3 …the dispatcher interrupts its own delegated turn", selfInterrupt.code === 0 && selfInterrupt.doc?.data?.interrupted === true,
    selfInterrupt.stderr || JSON.stringify(selfInterrupt.doc?.data));
  await sleep(4000);
  const selfNotices = (await messages(A.id)).map(textOf).filter((t) => startsWithReply(t)
    && (t.includes("我自己派的长活") || t.includes("自我打断F")));
  check("#93-3 …and it gets NO 「被取消」 receipt for a turn IT interrupted itself",
    selfNotices.length === 0, `notices=${JSON.stringify(selfNotices).slice(0, 200)}`);

  // 反例：**别的**会话打断，等活的人有权知道 —— 这条不许被上一条的豁免顺带吞掉。
  const G = await mkSession("第三方打断G");
  const asG = identityOf(G.pid);
  const peerJob = cli(asA, ["session", "send", F.id, "[hold:9000] A派给F的长活", "--reply-on-done"]);
  check("#93-3 a second dispatch is running on F", peerJob.code === 0, peerJob.stderr);
  await sleep(700);
  const peerInterrupt = cli(asG, ["session", "send", F.id, "[hold:600] 第三方插话", "--interrupt"]);
  check("#93-3 …a THIRD PARTY interrupts it", peerInterrupt.code === 0, peerInterrupt.stderr);
  let peerNotice = null;
  for (let i = 0; i < 30; i += 1) {
    await sleep(400);
    const hit = (await messages(A.id)).map(textOf).find((t) => startsWithReply(t)
      && (t.includes("A派给F的长活") || t.includes("自我打断F")));
    if (hit) { peerNotice = hit; break; }
  }
  check("#93-3 …and the WAITING dispatcher still hears about it (someone else took the floor)",
    peerNotice != null && /取消/.test(peerNotice), String(peerNotice).slice(0, 160));

  // ---- 10. #93-4：同一回合边界上的多条回执合并成一条消息 ------------------------------
  // 三笔派活的回执各开一个回合 = 三次完整模型调用，正文全是「一条通知」。合并只发生在投递打包层。
  const W1 = await mkSession("批合并1");
  const W2 = await mkSession("批合并2");
  const W3 = await mkSession("批合并3");
  const H = await mkSession("占住A的H");
  const asH = identityOf(H.pid);
  // A 自己也在跑回合（mock 要 echo 前面的注入），先等它闲下来，否则「占住」这一步本身就是 target_busy
  let holdA = [];
  for (let i = 0; i < 20; i += 1) {
    holdA = [cli(asH, ["session", "send", A.id, "[hold:7000] 先把 A 占住", "--reply-on-done"])];
    if (holdA.every((r) => r.code === 0)) break;
    await sleep(500);
  }
  check("#93-4 the dispatcher is BUSY when the receipts arrive", holdA.every((r) => r.code === 0), holdA.map((r) => r.stderr).join(" | "));
  await sleep(500);
  const jobs = [
    cli(asA, ["session", "send", W1.id, "[hold:900] 批活甲", "--reply-on-done"]),
    cli(asA, ["session", "send", W2.id, "[hold:900] 批活乙", "--reply-on-done"]),
    cli(asA, ["session", "send", W3.id, "[hold:900] 批活丙", "--reply-on-done"]),
  ];
  check("#93-4 three dispatches are accepted", jobs.every((r) => r.code === 0), jobs.map((r) => r.stderr).join(" | "));
  let bundled = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(400);
    const hit = (await messages(A.id)).map(textOf).find((t) => startsWithReply(t) && t.includes("批活丙"));
    if (hit) { bundled = hit; break; }
  }
  check("#93-4 …the three receipts arrive as ONE bundled message",
    bundled != null && /×\s*3/.test(bundled), String(bundled).slice(0, 200));
  check("#93-4 …carrying all three jobs",
    ["批活甲", "批活乙", "批活丙"].every((j) => String(bundled).includes(j)), String(bundled).slice(0, 240));
  const replyRows = (await messages(A.id)).map(textOf).filter(startsWithReply);
  const bundledRows = replyRows.filter((t) => /×\s*3/.test(t));
  check("#93-4 …and not as three separate notices (that would be three extra turns)",
    bundledRows.length >= 1 && replyRows.filter((t) => t.includes("批活甲")).length === 1,
    `rows=${replyRows.length} bundled=${bundledRows.length}`);

} finally {
  try { process.kill(-proc.pid, "SIGTERM"); } catch { /* gone */ }
}
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
