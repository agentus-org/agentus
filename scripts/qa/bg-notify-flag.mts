// 后台任务行的分流（issue #35）：默认只让「会唤醒 agent」的进程露出来，静默进程收进设置开关。
//
// 为什么这件事必须发生在 wire 上：`notify_on_complete` 的语义是「进程结束时 agent 会被叫醒，
// 它还没收工」。旧帧只有 id/command/pid/status/uptimeSeconds/exitCode，客户端无法把
// 「等唤醒续跑」和「跑完就完事」分开，于是一排后台行同等重要，真正的强信号被噪音淹掉。
//
// 这个 sweep 驱动真实的帧解析 + 真实的 settings，不启服务、不花 token：
//
//   1) 默认（开关关）：一帧两行（一行唤醒型、一行静默型）只留唤醒型；
//   2) 老后端（不发字段）：默认全被过滤掉 —— `undefined` 必须读成静默，而不是「不确定所以显示」；
//   3) 开关打开：两行都回来（保留 fork 原本「快照是唯一见证」的价值）；
//   4) 写入校验：非布尔值必须报错，不能静默转成 false/true；
//   5) 存盘：存进去、重新读回来还在。
//
//   npx tsx scripts/qa/bg-notify-flag.mts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { Store } = await import("../../packages/server/src/store/store.ts");
const settings = await import("../../packages/server/src/settings.ts");
const { backgroundTasksOf, visibleBackgroundTasks } = await import("../../packages/server/src/acp/session-manager.ts");
const { agentSettings, saveAgent, initSettings } = settings;

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  — ${detail}` : ""}`);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-bg-flag-"));
const store = new Store(path.join(dir, "agentus.sqlite"));
initSettings(dir, store);

/** One `kind:"background"` frame, exactly as the agent puts it on the wire. */
const frame = (tasks: Record<string, unknown>[]) => ({
  sessionUpdate: "agent_thought_chunk",
  content: { type: "text", text: "" },
  _meta: { hermes: { kind: "background", tasks } },
});

const wake = { id: "w1", command: "make test", pid: 11, status: "running", uptimeSeconds: 3, notifyOnComplete: true };
const quiet = { id: "q1", command: "tail -f log", pid: 12, status: "running", uptimeSeconds: 3, notifyOnComplete: false };

// ---- 0) parsing keeps EVERYTHING ---------------------------------------------------------
// `live.background` is also what the idle reaper reads (a running child = 「not idle」). Parsing
// must not drop rows, or a reaped slot could still own a live child — the orphan #22 removed.
const parsedAll = backgroundTasksOf(frame([wake, quiet]));
check("解析层保留全部行（reaper 要用）", parsedAll?.length === 2, JSON.stringify(parsedAll?.map((t) => t.id)));
check("标记被翻成布尔", parsedAll?.[0]?.notifyOnComplete === true && parsedAll?.[1]?.notifyOnComplete === false,
  JSON.stringify(parsedAll?.map((t) => t.notifyOnComplete)));

// ---- 1) default: the WIRE only carries wake rows -----------------------------------------
check("默认开关是关的", agentSettings().showSilentBackground === false, String(agentSettings().showSilentBackground));
const def = visibleBackgroundTasks(parsedAll ?? []);
check("默认只发唤醒型（2 行 → 1 行）", def.length === 1, JSON.stringify(def.map((t) => t.id)));
check("留下的那一行就是唤醒型", def[0]?.id === "w1" && def[0]?.notifyOnComplete === true, JSON.stringify(def[0]));

// ---- 2) an old agent never sends the field ----------------------------------------------
const legacy = backgroundTasksOf(frame([
  { id: "old1", command: "npm run build", pid: 1, status: "running", uptimeSeconds: 9 },
]));
check("老后端（无字段）默认被过滤掉，而不是显示成第三种状态",
  visibleBackgroundTasks(legacy ?? []).length === 0, JSON.stringify(legacy?.map((t) => t.id)));

// ---- 3) the toggle brings everything back ------------------------------------------------
saveAgent({ showSilentBackground: true });
const all = visibleBackgroundTasks(backgroundTasksOf(frame([wake, quiet])) ?? []);
check("打开开关后两行都在", all.length === 2, JSON.stringify(all.map((t) => t.id)));
const legacyOn = visibleBackgroundTasks(backgroundTasksOf(frame([{ id: "old1", command: "x", pid: 1, status: "running" }])) ?? []);
check("开关打开时老后端的行也显示", legacyOn.length === 1, JSON.stringify(legacyOn.map((t) => t.id)));

// ---- 4) write validation -----------------------------------------------------------------
let threw = "";
try { saveAgent({ showSilentBackground: "yes" }); } catch (e) { threw = String((e as Error).message); }
check("非布尔值被拒绝（不静默转成 true/false）", /showSilentBackground/.test(threw), threw);

// ---- 5) it survives a reload -------------------------------------------------------------
const reread = new Store(path.join(dir, "agentus.sqlite")).listSettings() as { agent?: { showSilentBackground?: boolean } };
check("存盘后可读回", reread.agent?.showSilentBackground === true, JSON.stringify(reread.agent ?? null));

// ---- 6) back off is the shipped default --------------------------------------------------
saveAgent({ showSilentBackground: false });
check("关回去以后静默行重新隐藏",
  visibleBackgroundTasks(backgroundTasksOf(frame([wake, quiet])) ?? []).length === 1);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
