// 存量名修复的一次性趟（issue #105）：判据 + 回写 + 失败语义 + 幂等。
//
// 修好「帧怎么分档」不等于 rail 立刻好看：#105 里那些会话的名字早就以 llm 档锁死了（同级永不覆盖），
// 之后的帧再也赢不了它。这一趟把它们捡回来 —— 名字真标题在 agent 自己的 `state.db` 里还留着
// （`title_source='llm'`），没有就至少把档位改回 agent，让下一帧有机会。
//
// 一轮 review 抓出的三条在这里都有断言：
//   ① agent 库读不到 ≠「它没有真名」：那一行一个字节都不许动，且这一趟不许记成已跑（否则永久失去机会）；
//   ② 回写的新名字本身也必须是「不是用户原话开头」，否则等于把同一缺陷重新锁死；
//   ③ 主 agent / 系统行（产品名）不是候选。
//
// 这里用真 Store（临时库）+ 注入的 lookup，不碰任何线上数据。
//   npx tsx scripts/qa/title-repair-sweep.mts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../packages/server/src/store/store.js";
import { deriveTitle, isPromptSliceText } from "../../packages/server/src/title.js";
import {
  agentStateTitle, repairMisTieredTitles, SLICE_TITLE_REPAIR, SLICE_TITLE_REPAIR_VERSION,
  type AgentTitleLookup,
} from "../../packages/server/src/title-repair.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const LONG_PROMPT =
  "交办：把行情看板 :8790 打通公网 + 家里局域网 HTTPS（照 Agentus 的形状来），先给方案再动手，别改我机器上的现有配置";
/** hermes `agent/title_generator.py::derive_title` 的规则，逐字照抄：48、词边界、rstrip 标点、加 `…`。 */
const hermesSlice = (raw: string): string => {
  const line = (raw.split("\n").map((l) => l.trim()).find((l) => l) || "").replace(/^[#>*\-\d.、\s]+/u, "").replace(/\s+/g, " ").trim();
  if (line.length <= 48) return line;
  const cut = line.slice(0, 48);
  const space = cut.lastIndexOf(" ");
  return (space > 24 ? cut.slice(0, space) : cut).replace(/[ ,.;:—-]+$/u, "") + "…";
};
const driftSlice = (raw: string): string => raw.replace(/\s+/g, " ").slice(0, 40);
const MODEL_TITLE = "行情看板公网入口";
const HERMES_HOME = "/tmp/fake-hermes-home";
const SLICE_HOME = "/tmp/fake-hermes-home-slice";
const MID = [
  "第一条：把 tunnel 的心跳从 30s 改成 15s，并回读日志确认没有报错",
  "第二条：给我看一下今天的持仓变动，重点看 NVDA 和 VRT 的仓位",
  "第三条：把 nagios 的告警邮件模板改成中文，别动收件人列表",
  "第四条：把 cockpit 的分屏比例记到 localStorage，键名要和别的偏好一致",
  "第五条：跑一遍全量回归，把红的用例名字列出来，不要只报条数",
];

// ---- 纯判据 --------------------------------------------------------------------------------
check("deriving 规则与 agent 对齐（48 + 词边界 + …）", deriveTitle(LONG_PROMPT) === hermesSlice(LONG_PROMPT),
  `ours=${JSON.stringify(deriveTitle(LONG_PROMPT))} agent=${JSON.stringify(hermesSlice(LONG_PROMPT))}`);
check("对齐之后，agent 发的切片帧按全等就认得出", isPromptSliceText(hermesSlice(LONG_PROMPT), [LONG_PROMPT]));
check("规则漂了（40 硬切、无标记）也认得出来 —— 靠前缀，不靠全等", isPromptSliceText(driftSlice(LONG_PROMPT), [LONG_PROMPT]));
check("旧代码那份 50 硬切同样认得（升级前的库里就长这样）", isPromptSliceText(LONG_PROMPT.slice(0, 50), [LONG_PROMPT]));
check("模型标题不会被误判成切片", !isPromptSliceText(MODEL_TITLE, [LONG_PROMPT]), MODEL_TITLE);
check("短首行的会话仍按全等认（#89 语义）", isPromptSliceText("看下新issue", ["看下新issue"]));

// ---- agent 侧读标题（只读） ------------------------------------------------------------------
{
  const home = mkdtempSync(path.join(tmpdir(), "agentus-title105-home-"));
  const db = new DatabaseSync(path.join(home, "state.db"));
  db.exec("create table sessions (id text primary key, title text, title_source text)");
  db.prepare("insert into sessions (id, title, title_source) values (?,?,?)").run("acp-llm", MODEL_TITLE, "llm");
  db.prepare("insert into sessions (id, title, title_source) values (?,?,?)").run("acp-derived", hermesSlice(LONG_PROMPT), "derived");
  db.close();
  const llm = agentStateTitle(home, ["acp-llm"]);
  check("读到 agent 记下的模型标题", llm.readable && llm.title === MODEL_TITLE, JSON.stringify(llm));
  check("agent 自己那条 derived（就是切片）不算更好的名字", agentStateTitle(home, ["acp-derived"]).title === null);
  check("没有 state.db 的家目录 = 可读但没有名字（不是读失败）",
    agentStateTitle(path.join(home, "nope"), ["acp-llm"]).readable === true
    && agentStateTitle(path.join(home, "nope"), ["acp-llm"]).title === null);
  // 文件在、但读不出来 → readable:false，绝不是「它没有名字」
  const broken = mkdtempSync(path.join(tmpdir(), "agentus-title105-broken-"));
  writeFileSync(path.join(broken, "state.db"), "not a database at all");
  check("库读不出来时明确说 readable:false（不许当成「它没有真名」）", agentStateTitle(broken, ["acp-llm"]).readable === false);
}

// ---- 存量趟 ----------------------------------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "agentus-title105-db-"));
const dbPath = path.join(dir, "agentus.sqlite");
const store = new Store(dbPath);
{
  const raw = new DatabaseSync(dbPath);
  const T = 1_760_000_000_000;
  const sess = raw.prepare(
    `insert into sessions (id, backend, acp_session_id, cwd, title, auto_title, title_src, status, created_at, home, role, system)
     values (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const msg = raw.prepare("insert into messages (seq, session_id, kind, payload, created_at) values (?,?,?,?,?)");
  const seed = (id: string, title: string, src: string, home: string | null, prompts: string[], role: string | null = null) => {
    sess.run(id, "hermes", `acp-${id}`, "/tmp", title, title, src, "idle", T, home, role, 0);
    prompts.forEach((p, i) => msg.run(i + 1, id, "user", JSON.stringify({ text: p }), T + i));
  };
  seed("s-recoverable", hermesSlice(LONG_PROMPT), "llm", HERMES_HOME, [LONG_PROMPT]);          // 首轮锁死，能救
  seed("s-nothing", driftSlice(LONG_PROMPT), "llm", null, [LONG_PROMPT]);                      // 只能改档
  seed("s-real-title", "把 :8790 的看板打通公网，顺带补一版部署文档…", "llm", HERMES_HOME, [LONG_PROMPT]); // 真标题
  seed("s-operator", hermesSlice(LONG_PROMPT), "operator", HERMES_HOME, [LONG_PROMPT]);        // 手动改名
  seed("s-main", hermesSlice(LONG_PROMPT), "llm", HERMES_HOME, [LONG_PROMPT], "main");         // 产品名
  seed("s-midturn", hermesSlice(MID[3]), "llm", HERMES_HOME, MID);                             // 第 4 轮锁死（非首非末）
  seed("s-better-slice", hermesSlice(LONG_PROMPT), "llm", SLICE_HOME, [LONG_PROMPT]);          // 生产者给的「真名」还是切片
  raw.close();
}

const lookup = (home: string | null): AgentTitleLookup => {
  if (home === HERMES_HOME) return { readable: true, title: MODEL_TITLE };
  if (home === SLICE_HOME) return { readable: true, title: LONG_PROMPT.slice(0, 30) };
  return { readable: true, title: null };
};
const res = repairMisTieredTitles(store, { lookup: (home) => lookup(home), log: () => {} });
const rowOf = (id: string) => {
  const r = store.getSession(id);
  return r ? { title: r.title, src: r.titleSrc ?? null } : null;
};

check("候选里不含 operator 档、也不含主 agent 的产品名（5 条 llm 行进来，主 agent 与手动改名都不进）",
  res.checked === 5, JSON.stringify(res));
check("能救的那条换成了 agent 的真标题", rowOf("s-recoverable")?.title === MODEL_TITLE, JSON.stringify(rowOf("s-recoverable")));
check("…并且仍是 llm 档（名字出自模型）", rowOf("s-recoverable")?.src === "llm", String(rowOf("s-recoverable")?.src));
check("救不回来的那条：名字不动", rowOf("s-nothing")?.title === driftSlice(LONG_PROMPT), JSON.stringify(rowOf("s-nothing")?.title));
check("…但档位从 llm 降回 agent（下一帧还能赢它）", rowOf("s-nothing")?.src === "agent", String(rowOf("s-nothing")?.src));
check("真模型标题（以 … 结尾但不是用户原话的前缀）一个字节都没动",
  rowOf("s-real-title")?.title === "把 :8790 的看板打通公网，顺带补一版部署文档…" && rowOf("s-real-title")?.src === "llm",
  JSON.stringify(rowOf("s-real-title")));
check("手动改名的行没有任何改动",
  rowOf("s-operator")?.title === hermesSlice(LONG_PROMPT) && rowOf("s-operator")?.src === "operator",
  JSON.stringify(rowOf("s-operator")));
check("主 agent 的产品名没有被当成摘要名",
  rowOf("s-main")?.title === hermesSlice(LONG_PROMPT) && rowOf("s-main")?.src === "llm",
  JSON.stringify(rowOf("s-main")));
check("第 4 轮锁死的行也救回来（不只是首条/末条）", rowOf("s-midturn")?.title === MODEL_TITLE,
  JSON.stringify(rowOf("s-midturn")));
check("生产者给的「真名」本身是切片时不回写（否则重新锁死），只降档",
  rowOf("s-better-slice")?.title === hermesSlice(LONG_PROMPT) && rowOf("s-better-slice")?.src === "agent",
  JSON.stringify(rowOf("s-better-slice")));
check("计数对得上（2 改名 / 2 改档 / 1 放过）",
  res.repaired === 2 && res.refiled === 2 && res.skipped === 1 && res.unreadable === 0, JSON.stringify(res));
check("这一趟记进了 repairs 表（按趟记，不共享 user_version）",
  res.complete && store.repairRan(SLICE_TITLE_REPAIR, SLICE_TITLE_REPAIR_VERSION));

// 幂等：再跑一次（不带 force）什么都不做。
const again = repairMisTieredTitles(store, { lookup: () => ({ readable: true, title: "另一个标题" }) });
check("再跑一次是空趟（一次性）", again.checked === 0, JSON.stringify(again));

// 变异验证：把名字改回被误判的形态，带 force 重跑，必须又能救回来 —— 证明断言真在读这一趟的产出。
{
  store.setAutoTitle("s-recoverable", hermesSlice(LONG_PROMPT), { force: true, src: "llm" });
  const forced = repairMisTieredTitles(store, { force: true, lookup: () => ({ readable: true, title: MODEL_TITLE }) });
  check("force 重跑仍然命中并救回（断言不是恒真）",
    forced.repaired >= 1 && rowOf("s-recoverable")?.title === MODEL_TITLE, JSON.stringify(forced));
}
store.close();

// ---- ① 「读不到」不许被当成「没有」：不复位行、不记录，下次开机再来 -------------------------
{
  const dir2 = mkdtempSync(path.join(tmpdir(), "agentus-title105-db2-"));
  const db2 = path.join(dir2, "agentus.sqlite");
  const store2 = new Store(db2);
  const raw = new DatabaseSync(db2);
  raw.prepare(
    `insert into sessions (id, backend, acp_session_id, cwd, title, auto_title, title_src, status, created_at, home)
     values (?,?,?,?,?,?,?,?,?,?)`,
  ).run("s-locked", "hermes", "acp-s-locked", "/tmp", hermesSlice(LONG_PROMPT), hermesSlice(LONG_PROMPT), "llm", "idle", 1, HERMES_HOME);
  raw.prepare("insert into messages (seq, session_id, kind, payload, created_at) values (?,?,?,?,?)")
    .run(1, "s-locked", "user", JSON.stringify({ text: LONG_PROMPT }), 1);
  raw.close();

  const blind = repairMisTieredTitles(store2, { lookup: () => ({ readable: false, title: null }) });
  const kept = store2.getSession("s-locked");
  check("库读不到时：这一行不动（名字与 llm 档都保留）",
    kept?.title === hermesSlice(LONG_PROMPT) && kept?.titleSrc === "llm",
    JSON.stringify({ title: kept?.title, src: kept?.titleSrc }));
  check("库读不到时：这一趟不记录（下次开机还来）",
    blind.unreadable === 1 && blind.complete === false && !store2.repairRan(SLICE_TITLE_REPAIR, SLICE_TITLE_REPAIR_VERSION),
    JSON.stringify(blind));

  const healed = repairMisTieredTitles(store2, { lookup: () => ({ readable: true, title: MODEL_TITLE }) });
  check("下一次开机（库可读）真的补上了",
    healed.repaired === 1 && store2.getSession("s-locked")?.title === MODEL_TITLE, JSON.stringify(healed));
  check("补上之后才记成已跑", store2.repairRan(SLICE_TITLE_REPAIR, SLICE_TITLE_REPAIR_VERSION));
  store2.close();
}

// ---- 空库首启：没有候选就不算跑过（之后拷进来的旧库才会被修） --------------------------------
{
  const store3 = new Store(path.join(mkdtempSync(path.join(tmpdir(), "agentus-title105-db3-")), "agentus.sqlite"));
  const empty = repairMisTieredTitles(store3, { lookup: () => ({ readable: true, title: null }) });
  check("空库首启不落「已跑」标记",
    empty.checked === 0 && empty.complete === false && !store3.repairRan(SLICE_TITLE_REPAIR, SLICE_TITLE_REPAIR_VERSION),
    JSON.stringify(empty));
  store3.close();
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
