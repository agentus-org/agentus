// 存量名修复的一次性趟（issue #105）：判据 + 回写 + 幂等。
//
// 修好「帧怎么分档」不等于 rail 立刻好看：#105 里那些会话的名字早就以 llm 档锁死了（同级永不覆盖），
// 之后的帧再也赢不了它。这一趟把它们捡回来 —— 名字真标题在 agent 自己的 `state.db` 里还留着
// （`title_source='llm'`），没有就至少把档位改回 agent，让下一帧有机会。
//
// 这里用真 Store（临时库）+ 注入的 lookup，不碰任何线上数据。
//   npx tsx scripts/qa/title-repair-sweep.mts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../packages/server/src/store/store.js";
import { deriveTitle, isPromptSliceText } from "../../packages/server/src/title.js";
import {
  agentStateTitle, repairMisTieredTitles, SLICE_TITLE_REPAIR, SLICE_TITLE_REPAIR_VERSION,
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

// ---- 纯判据 --------------------------------------------------------------------------------
check("deriving 规则与 agent 对齐（48 + 词边界 + …）", deriveTitle(LONG_PROMPT) === hermesSlice(LONG_PROMPT),
  `ours=${JSON.stringify(deriveTitle(LONG_PROMPT))} agent=${JSON.stringify(hermesSlice(LONG_PROMPT))}`);
check("对齐之后，agent 发的切片帧按全等就认得出", isPromptSliceText(hermesSlice(LONG_PROMPT), [LONG_PROMPT]));
check("规则漂了（40 硬切、无标记）也认得出来 —— 靠前缀，不靠全等", isPromptSliceText(driftSlice(LONG_PROMPT), [LONG_PROMPT]));
check("旧代码那份 50 硬切同样认得（升级前的库里就长这样）", isPromptSliceText(LONG_PROMPT.slice(0, 50), [LONG_PROMPT]));
check("模型标题不会被误判成切片", !isPromptSliceText(MODEL_TITLE, [LONG_PROMPT]), MODEL_TITLE);
check("短首行的会话仍按全等认（#89 语义）", isPromptSliceText("看下新issue", ["看下新issue"]));
check("最新一条 prompt 的切片也认（恢复会话时推的是它）",
  isPromptSliceText(hermesSlice("第二条完全不同的长消息，用来验证最新一条被检查到：把 tunnel 的心跳从 30s 改成 15s 并回读日志"), [
    LONG_PROMPT,
    "第二条完全不同的长消息，用来验证最新一条被检查到：把 tunnel 的心跳从 30s 改成 15s 并回读日志",
  ]));

// ---- agent 侧读标题（只读） ------------------------------------------------------------------
{
  const home = mkdtempSync(path.join(tmpdir(), "agentus-title105-home-"));
  const db = new DatabaseSync(path.join(home, "state.db"));
  db.exec("create table sessions (id text primary key, title text, title_source text)");
  db.prepare("insert into sessions (id, title, title_source) values (?,?,?)").run("acp-llm", MODEL_TITLE, "llm");
  db.prepare("insert into sessions (id, title, title_source) values (?,?,?)").run("acp-derived", hermesSlice(LONG_PROMPT), "derived");
  db.close();
  check("读到 agent 记下的模型标题", agentStateTitle(home, ["acp-llm"]) === MODEL_TITLE, String(agentStateTitle(home, ["acp-llm"])));
  check("agent 自己那条 derived（就是切片）不算更好的名字", agentStateTitle(home, ["acp-derived"]) === null);
  check("库不存在 = null，不猜", agentStateTitle(path.join(home, "nope"), ["acp-llm"]) === null);
}

// ---- 存量趟 ----------------------------------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "agentus-title105-db-"));
const dbPath = path.join(dir, "agentus.sqlite");
const store = new Store(dbPath);
const HERMES_HOME = "/tmp/fake-hermes-home";
{
  const raw = new DatabaseSync(dbPath);
  const T = 1_760_000_000_000;
  const sess = raw.prepare(
    `insert into sessions (id, backend, acp_session_id, cwd, title, auto_title, title_src, status, created_at, home)
     values (?,?,?,?,?,?,?,?,?,?)`,
  );
  const msg = raw.prepare(
    "insert into messages (seq, session_id, kind, payload, created_at) values (?,?,?,?,?)",
  );
  const seed = (id: string, title: string, src: string, home: string | null, prompt = LONG_PROMPT) => {
    sess.run(id, "hermes", `acp-${id}`, "/tmp", title, title, src, "idle", T, home);
    msg.run(1, id, "user", JSON.stringify({ text: prompt }), T);
    msg.run(2, id, "agent", JSON.stringify({ content: { type: "text", text: "好的" } }), T + 1);
  };
  seed("s-recoverable", hermesSlice(LONG_PROMPT), "llm", HERMES_HOME);        // 名字能救回来
  seed("s-nothing", driftSlice(LONG_PROMPT), "llm", null);                   // 只能改档位
  seed("s-real-title", "把 :8790 的看板打通公网，顺带补一版部署文档…", "llm", HERMES_HOME); // 真标题，别动
  seed("s-operator", hermesSlice(LONG_PROMPT), "operator", HERMES_HOME);     // 手动改名，别动
  raw.close();
}

const res = repairMisTieredTitles(store, {
  lookup: (home) => (home === HERMES_HOME ? MODEL_TITLE : null),
  log: () => {},
});
const rowOf = (id: string) => {
  const r = store.getSession(id);
  return r ? { title: r.title, src: r.titleSrc ?? null } : null;
};
check("只审了三条可疑行（operator 档不进候选）", res.checked === 3, JSON.stringify(res));
check("能救的那条换成了 agent 的真标题", rowOf("s-recoverable")?.title === MODEL_TITLE, JSON.stringify(rowOf("s-recoverable")));
check("…并且仍是 llm 档（名字出自模型）", rowOf("s-recoverable")?.src === "llm", String(rowOf("s-recoverable")?.src));
check("救不回来的那条：名字不动", rowOf("s-nothing")?.title === driftSlice(LONG_PROMPT), JSON.stringify(rowOf("s-nothing")?.title));
check("…但档位从 llm 降回 agent（下一帧还能赢它）", rowOf("s-nothing")?.src === "agent", String(rowOf("s-nothing")?.src));
check("真模型标题（以 … 结尾但不是用户原话的前缀）一个字节都没动",
  rowOf("s-real-title")?.title === "把 :8790 的看板打通公网，顺带补一版部署文档…" && rowOf("s-real-title")?.src === "llm",
  JSON.stringify(rowOf("s-real-title")));
check("手动改名的行没有任何改动", rowOf("s-operator")?.title === hermesSlice(LONG_PROMPT) && rowOf("s-operator")?.src === "operator",
  JSON.stringify(rowOf("s-operator")));
check("计数对得上（1 改名 / 1 改档 / 1 放过）", res.repaired === 1 && res.refiled === 1 && res.skipped === 1, JSON.stringify(res));
check("这一趟记进了 repairs 表（按趟记，不共享 user_version）",
  store.repairRan(SLICE_TITLE_REPAIR, SLICE_TITLE_REPAIR_VERSION));

// 幂等：再跑一次（不带 force）什么都不做。
const again = repairMisTieredTitles(store, { lookup: () => "另一个标题" });
check("再跑一次是空趟（一次性）", again.checked === 0, JSON.stringify(again));

// 变异验证：把名字改回被误判的形态，带 force 重跑，必须又能救回来 —— 证明断言真在读这一趟的产出。
{
  store.setAutoTitle("s-recoverable", hermesSlice(LONG_PROMPT), { force: true, src: "llm" });
  const forced = repairMisTieredTitles(store, { force: true, lookup: (home) => (home === HERMES_HOME ? MODEL_TITLE : null) });
  check("force 重跑仍然命中并救回（断言不是恒真）",
    forced.repaired >= 1 && rowOf("s-recoverable")?.title === MODEL_TITLE, JSON.stringify(forced));
}

store.close();
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
