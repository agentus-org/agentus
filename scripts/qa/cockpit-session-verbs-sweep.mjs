// cockpit CLI 的"收尸"动词（issue #73）：delete / archive / unarchive —— 用真 CLI 跑，不看源码。
//
// 这一份重点是三条边界，它们都不是"能跑就行"能证明的：
//   · delete 的不对称：live 只 close（记录还在），cold 才 purge（transcript 真没了）；
//   · agent 身份一律拒（删历史是操作员的动作），而且拒绝码是稳定的；
//   · `not_found`（打错字）与 `out_of_scope`（有、但被作用域挡住）必须是两个码；
//   · 关闭中回魂：握手没回来就关掉的槽，不能过一会显示成 ready。
//
// 自给自足：自己的 Agentus（mock 后端）、临时数据目录、直接 spawn `bin/cli.mjs`。
//   node scripts/qa/cockpit-session-verbs-sweep.mjs
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createTcp } from "node:net";

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
const dataDir = mkdtempSync(path.join(tmpdir(), "agentus-cli-"));
const { spawn } = await import("node:child_process");
const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
  detached: true,
  cwd: ROOT,
  // 握手故意慢（2s）+ 关闭的有界等待故意短（200ms）：这才造得出「握手还没回来就被关掉」那个窗口，
  // 也就是 #73 附的"关闭中回魂"。参数调反了这一条就是假绿。
  env: {
    ...process.env, NODE_ENV: "development", HOME: mkdtempSync(path.join(tmpdir(), "cli-home-")),
    AGENTUS_PORT: String(PORT), AGENTUS_DATA: dataDir,
    MOCK_SPAWN_MS: "2000", AGENTUS_CLOSE_WAIT_MS: "200",
    // 它不理会 SIGTERM：否则 #stop 那一刀就把进程收掉了，握手根本走不到"落地"这一步 ——
    // 也就永远测不到回魂。只有 SIGKILL 有效 = 真实世界里那个「关不掉的槽」。
    MOCK_IGNORE_TERM: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
proc.stdout.on("data", (d) => { log += String(d); });
proc.stderr.on("data", (d) => { log += String(d); });
const cleanup = () => { try { process.kill(-proc.pid, "SIGKILL"); } catch { /* gone */ } };
process.on("exit", cleanup);
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 120 && !log.includes(`0.0.0.0:${PORT}`); i++) await sleep(150);
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }

const token = (await import("node:fs")).readFileSync(path.join(dataDir, "auth.token"), "utf8").trim();
const api = async (p, init = {}) => {
  const res = await fetch(`${BASE}${p}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  return res.status === 204 ? null : res.json().catch(() => null);
};
// 收尸动词与 stop 都受「驾驶舱互发消息」开关管；这里先打开。
await api("/api/settings", { method: "PUT", body: JSON.stringify({ agent: { cockpitSend: true } }) });

/** 干净的 operator 环境：本进程自己就是跑在 Agentus 会话里的 agent，继承那三个变量会让
 *  CLI 以为自己是 agent（身份优先），于是 operator 动词全被拒 —— 这一版的第一轮就是这么全红的。 */
const OPERATOR_ENV = (() => {
  const e = { ...process.env };
  delete e.AGENTUS_COCKPIT_ENDPOINT;
  delete e.AGENTUS_COCKPIT_TOKEN;
  delete e.AGENTUS_COCKPIT_SESSION;
  return e;
})();

/** 跑一次 CLI，返回 { code, json }（json 是 stdout 的 JSON，失败时为 null）。 */
const cli = (args, env = {}) => new Promise((res) => {
  execFile(process.execPath, [path.join(ROOT, "bin/cli.mjs"), ...args], {
    env: { ...OPERATOR_ENV, AGENTUS_DATA: dataDir, AGENTUS_PORT: String(PORT), ...env },
    timeout: 60_000,
  }, (err, stdout, stderr) => {
    let json = null;
    try { json = JSON.parse(stdout); } catch { /* usage text or error */ }
    res({ code: err ? (err.code ?? 1) : 0, json, stdout, stderr });
  });
});
const newSession = async (title) => {
  const r = await cli(["session", "create", dataDir, "--backend", "mock", "--title", title]);
  // `data.session` 是一整个会话对象（不是字符串）—— 第一版把它当 id 用，日志里出现 [object Object]。
  const sess = r.json?.data?.session;
  const id = typeof sess === "string" ? sess : (sess?.id ?? r.json?.data?.id);
  for (let i = 0; i < 60; i++) {
    const s = await api(`/api/sessions/${id}/messages?tail=1`).catch(() => null);
    const list = await api("/api/sessions");
    const row = [...(list?.live ?? []), ...(list?.cold ?? [])].find((x) => x.id === id);
    if (row && row.status === "ready") break;
    await sleep(250);
  }
  return id;
};

// ---------------------------------------------------------------- 1. not_found ≠ out_of_scope
const bogus = await cli(["session", "stop", "definitely-not-a-session"]);
check("an id that does not exist answers not_found", bogus.json?.error?.code === "not_found", JSON.stringify(bogus.json?.error));
// 稳定码 + 人话：CLI 的 error.message 里要能看见那个 id（否则「打错字」和「被拒」还是分不清）
check("…and the message names the id, so the caller can see the typo",
  /definitely-not-a-session/.test(bogus.json?.error?.message ?? ""), JSON.stringify(bogus.json?.error));

const missing = await cli(["session", "stop", "--close"]);
check("a flag where the id belongs is bad_request, not out_of_scope", missing.json?.error?.code === "bad_request", JSON.stringify(missing.json?.error));

// ---------------------------------------------------------------- 2. delete: live → closed
const liveId = await newSession("要被删掉的会话");
check("session create returned an id", typeof liveId === "string" && liveId.length > 0, String(liveId));
const delLive = await cli(["session", "delete", liveId]);
// operator 路由的形状是 {closed:<id>} / {purged:<id>} —— 值是 id，不是 true（第一版按布尔断的，白红一条）
check("deleting a LIVE session only closes it", delLive.json?.data?.closed === liveId && !("purged" in (delLive.json?.data ?? {})), JSON.stringify(delLive.json?.data));
check("…and says so in words: CLOSED, not purged", /CLOSED, not purged/i.test(delLive.json?.meta?.note ?? ""), delLive.json?.meta?.note);
const stillThere = await cli(["session", "show", liveId]);
check("the record is still there after a close", stillThere.code === 0 && Boolean(stillThere.json?.data), String(stillThere.json?.error?.code ?? "ok"));

// ---------------------------------------------------------------- 3. delete: cold → purged
const delCold = await cli(["session", "delete", liveId]);
check("deleting the now-COLD session purges it", delCold.json?.data?.purged === liveId, JSON.stringify(delCold.json?.data));
check("…and the note stops hedging", /PURGED/i.test(delCold.json?.meta?.note ?? ""), delCold.json?.meta?.note);
const gone = await cli(["session", "show", liveId]);
check("after a purge the session is gone", gone.code !== 0 || !gone.json?.data, JSON.stringify(gone.json?.error ?? gone.json?.data));
const again = await cli(["session", "delete", liveId]);
check("deleting it again answers not_found (not a silent success)", again.json?.error?.code === "not_found", JSON.stringify(again.json?.error));

// ---------------------------------------------------------------- 4. archive / unarchive
const archId = await newSession("要被归档的会话");
const arch = await cli(["session", "archive", archId]);
check("archive succeeds", arch.code === 0 && arch.json?.success === true, JSON.stringify(arch.json?.error ?? arch.json?.data));
const listNoAll = await cli(["session", "list"]);
const listAll = await cli(["session", "list", "--all"]);
const idsNoAll = JSON.stringify(listNoAll.json?.data ?? {});
const idsAll = JSON.stringify(listAll.json?.data ?? {});
check("an archived session is out of the default scope", !idsNoAll.includes(archId), idsNoAll.slice(0, 120));
check("…but --all still sees it", idsAll.includes(archId));
const outOfScope = await cli(["session", "stop", archId]);
check("acting on an archived session is out_of_scope (not not_found)", outOfScope.json?.error?.code === "out_of_scope", JSON.stringify(outOfScope.json?.error));
const unarch = await cli(["session", "unarchive", archId]);
check("unarchive brings it back", unarch.code === 0 && (await cli(["session", "list"])).json?.data !== undefined);

// ---------------------------------------------------------------- 5. agent 身份一律拒
const asAgent = await cli(["session", "delete", archId], {
  AGENTUS_COCKPIT_ENDPOINT: BASE,
  AGENTUS_COCKPIT_TOKEN: "agent-token-whatever",
  AGENTUS_COCKPIT_SESSION: "some-agent-session",
});
check("an agent identity may not delete", asAgent.json?.error?.code === "agents_may_not_delete", JSON.stringify(asAgent.json?.error));
check("…and exits non-zero", asAgent.code !== 0, String(asAgent.code));
const asAgentArch = await cli(["session", "archive", archId], {
  AGENTUS_COCKPIT_ENDPOINT: BASE,
  AGENTUS_COCKPIT_TOKEN: "agent-token-whatever",
  AGENTUS_COCKPIT_SESSION: "some-agent-session",
});
check("…nor archive", asAgentArch.json?.error?.code === "agents_may_not_archive", JSON.stringify(asAgentArch.json?.error));

// ---------------------------------------------------------------- 6. capabilities 说得出这三条
const caps = await cli(["capabilities"]);
const names = JSON.stringify(caps.json?.data ?? {});
check("capabilities lists delete / archive / unarchive", ["session delete", "session archive", "session unarchive"].every((v) => names.includes(v)), names.slice(0, 120));

// ---------------------------------------------------------------- 7. 关闭中回魂（#73 附）
// 用 MOCK_SPAWN_MS 让握手慢下来：一条 starting 的槽在这期间被 --close，握手落地后不许写回 ready。
// 判据：关完 2 秒内它一直是冷的/不出现，且 create 之后消失不出现在 list 的 live 里。
const slow = mkdtempSync(path.join(tmpdir(), "agentus-cli-slow-"));
const createSlow = await cli(["session", "create", slow, "--backend", "mock", "--title", "握手很慢"]);
const slowSess = createSlow.json?.data?.session;
const slowId = typeof slowSess === "string" ? slowSess : (slowSess?.id ?? createSlow.json?.data?.id);
if (slowId) {
  const closed = await cli(["session", "stop", slowId, "--close"]);
  check("closing a session that is still shaking hands answers closed (bounded wait, not a hang)",
    closed.json?.data?.closed === true || closed.json?.data?.already_cold === true,
    JSON.stringify(closed.json ?? closed.stdout ?? closed.stderr).slice(0, 200));
  await sleep(3200);   // 等它的握手真的落地（MOCK_SPAWN_MS=2000），看它会不会把 ready 写回来
  const rows = await api("/api/sessions");
  // 判据要看**库里那一行**，不只是 live map：#updateSession 会把 status 写回 store，
  // 晚到的握手正是这样把「已关闭」的那行改回 ready，然后 rail 上出现一个没有进程的 ready。
  const live = (rows?.live ?? []).find((s) => s.id === slowId);
  const cold = [...(rows?.cold ?? []), ...(rows?.archived ?? [])].find((s) => s.id === slowId);
  check("a slot closed during its handshake does not come back as ready",
    (!live || live.status !== "ready") && (!cold || cold.status !== "ready"),
    JSON.stringify(live ?? cold ?? { status: "gone" }));
} else {
  check("a slot closed during its handshake does not come back as ready", false, "could not create the slow session");
}

cleanup();
console.log(`\ncockpit-session-verbs-sweep: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
