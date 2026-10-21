// QA (issue #37) — 记忆召回条目的**数据面**（不起服务、不起浏览器）。
//
// 三件事，都是「注入不当就变成永久伤害」的那种：
//   · 单个条目的上限（agent 会给长记忆，server 必须自己截，因为这条数据要落库）；
//   · 条目数量的上限（`raw.length > items.length` 也要算 truncated —— 被砍掉的条目不能静默）；
//   · 折叠：同一位置上再来一条 memory 行时，条目取**最新一次**（新的召回替换旧的），
//     而 `hits` 照样累加；压缩行永远不带 items。
//
//   npx tsx scripts/qa/recall-items.mts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const { statusItemsOf, NOTE_ITEMS_MAX, NOTE_ITEM_CHARS } = await import("../../packages/server/src/acp/session-manager.ts");
const { Store } = await import("../../packages/server/src/store/store.ts");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  — ${detail}` : ""}`);
};

/** 一帧最简形态的状态载体（形状照 fork `acp_adapter/events.py:make_status_cb`）。 */
const frame = (hermes: Record<string, unknown>) => ({
  sessionUpdate: "agent_thought_chunk",
  content: { type: "text", text: "" },
  _meta: { hermes: { kind: "status", statusKind: "lifecycle", text: "👁️ Hindsight — recalled 3 memories", ...hermes } },
});

// --- 1. 抽取与限幅 ----------------------------------------------------------------------
const plain = statusItemsOf(frame({ items: [{ text: "a" }, { text: " \n b " }] }));
check("只收有 text 的条目，并 trim", JSON.stringify(plain?.items) === JSON.stringify([{ text: "a" }, { text: "b" }]), JSON.stringify(plain));
check("没写 truncated 就是 false", plain?.truncated === false, String(plain?.truncated));
// 丢了条目（空 text / 非对象）也必须算 truncated —— 界面上「3 条」和 agent 说的 5 条对不上时，
// 唯一诚实的做法是把「有东西没显示」说出来，而不是装作 3 就是全部。
const dropped = statusItemsOf(frame({ items: [{ text: "a" }, { text: "" }, { notText: 1 }] }));
check("有条目被丢掉 → truncated=true（不静默）", dropped?.truncated === true && dropped?.items.length === 1, JSON.stringify(dropped));

const longOne = statusItemsOf(frame({ items: [{ text: "x".repeat(NOTE_ITEM_CHARS + 500) }] }));
check(`单条被截到 ${NOTE_ITEM_CHARS} 字符`, longOne?.items[0]?.text.length === NOTE_ITEM_CHARS, String(longOne?.items[0]?.text.length));

const overflow = statusItemsOf(frame({ items: Array.from({ length: NOTE_ITEMS_MAX + 12 }, (_, i) => ({ text: `m${i}` })) }));
check(`条目数被限到 ${NOTE_ITEMS_MAX}`, overflow?.items.length === NOTE_ITEMS_MAX, String(overflow?.items.length));
check("…被砍掉的部分算 truncated（不静默）", overflow?.truncated === true, String(overflow?.truncated));
check("…保留的是前 N 条，不是随机/最后几条", overflow?.items[0]?.text === "m0" && overflow?.items.at(-1)?.text === `m${NOTE_ITEMS_MAX - 1}`, String(overflow?.items.at(-1)?.text));

const withMeta = statusItemsOf(frame({ items: [{ text: "pref", tags: ["a", 2, "", "b"], type: "preference" }] }));
check("tags 只留字符串、type 照抄", JSON.stringify(withMeta?.items[0]) === JSON.stringify({ text: "pref", tags: ["a", "b"], type: "preference" }), JSON.stringify(withMeta?.items[0]));

check("没有 items 的状态行 → undefined（压缩/警告行一个字段都不多）", statusItemsOf(frame({})) === undefined);
check("items 不是数组 → undefined（别家 agent 乱塞也不崩）", statusItemsOf(frame({ items: "oops" })) === undefined);
check("普通 thought 帧（没有 _meta.hermes）→ undefined", statusItemsOf({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hi" } }) === undefined);

// --- 2. 折叠：同一行、最新一次的条目 ------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-recall-"));
const store = new Store(path.join(dir, "agentus.sqlite"));
store.appendMessage({ sessionId: "s1", kind: "user", payload: { text: "hi" }, createdAt: Date.now() });

const first = store.appendNote("s1", { category: "memory", text: "recalled 1 memory", items: [{ text: "旧的那条" }] });
const folded = store.appendNote("s1", { category: "memory", text: "recalled 2 memories", items: [{ text: "新的 A" }, { text: "新的 B" }], truncated: true });
check("同位置同类别 → 折叠成同一行", folded.seq === first.seq, `${first.seq} vs ${folded.seq}`);
const fp = folded.payload as { hits?: number; items?: { text: string }[]; truncated?: boolean };
check("…hits 累加（还是折叠语义）", fp.hits === 2, String(fp.hits));
check("…条目取最新一次，不混旧条目", (fp.items ?? []).map((i) => i.text).join("|") === "新的 A|新的 B", JSON.stringify(fp.items));
check("…truncated 也跟着最新一次", fp.truncated === true);

store.appendMessage({ sessionId: "s1", kind: "agent", payload: { text: "ok" }, createdAt: Date.now() });
const after = store.appendNote("s1", { category: "memory", text: "recalled 9 memories", items: [{ text: "第三轮" }] });
check("位置变了 → 另起一行（记忆是过程，不是心跳）", after.seq > folded.seq, `${folded.seq} → ${after.seq}`);

const compact = store.appendNote("s1", { category: "compaction", text: "Compacting context…" });
check("压缩行不带 items", (compact.payload as { items?: unknown }).items === undefined, JSON.stringify(compact.payload));

// --- 3. 落库再读回来还是同一份（刷新/换设备看到的是库里那份） ------------------------------
const rows = store.messagesTail("s1", 100).messages.filter((m: { kind: string }) => m.kind === "note");
const memRows = rows.filter((m: { payload: unknown }) => (m.payload as { category?: string }).category === "memory");
check("memory 行按 seq 排在库里", memRows.length === 2, String(memRows.length));
check("…最新那行读回来仍带 items", ((memRows.at(-1)!.payload as { items?: unknown[] }).items ?? []).length === 1);

console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
