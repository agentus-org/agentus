// The plan's `title` slot and the completion card it feeds (issue #11).
//
// The card used to say `会话名 · 用时 1m12s`, and a session name is a PLACE, not a task — on a phone
// 「已完成 · hello」 answers nothing. The plan object already knows what the job was, so it grew a
// `title` (≤40 chars) and the card reads `会话名 · <title> · 用时`, with an honest fallback chain when
// no title was ever written.
//
// This drives the real Store and the real NotifyCenter — no server, no browser, no tokens.
//
//   npx tsx scripts/qa/plan-title-sweep.mts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const { Store } = await import("../../packages/server/src/store/store.ts");
const { NotifyCenter } = await import("../../packages/server/src/notify/center.ts");
const { MAX_TITLE, clampTitle } = await import("../../packages/server/src/plan/plan.ts");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  — ${detail}` : ""}`);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-plan-title-"));
const store = new Store(path.join(dir, "agentus.sqlite"));
const SID = "sess_title_probe";
const items = (...steps: [string, string][]) => steps.map(([content, status]) => ({ content, status }));

// ---- 1. the slot itself, through the store ----
const wrote = store.upsertPlan(SID, {
  items: items(["读失败用例", "completed"], ["改登录超时", "in_progress"]),
  title: "修登录超时", source: "mcp",
});
check("a title written with the plan comes back", wrote.title === "修登录超时", String(wrote.title));

const flip = store.upsertPlan(SID, { items: items(["读失败用例", "completed"], ["改登录超时", "completed"]), source: "mcp" });
check("a later items-only write KEEPS the title (that is what makes one write enough)",
  flip.title === "修登录超时", String(flip.title));
check("…and it is not a partial update of the steps either", flip.items.length === 2 && flip.items[1].status === "completed");

const cleared = store.upsertPlan(SID, { items: flip.items, title: null, source: "mcp" });
check("an explicit null clears it", cleared.title === null, String(cleared.title));

check(`clampTitle cuts at ${MAX_TITLE} chars`, (clampTitle("一".repeat(80)) ?? "").length === MAX_TITLE,
  String((clampTitle("一".repeat(80)) ?? "").length));
check("clampTitle collapses whitespace and refuses a blank title",
  clampTitle("  修  登录\n超时 ") === "修 登录 超时" && clampTitle("   ") === null && clampTitle(42) === null,
  JSON.stringify([clampTitle("  修  登录\n超时 "), clampTitle("   "), clampTitle(42)]));

// ---- 2. the completion card, through the real notify centre ----
const notices: { kind: string; title: string; body: string }[] = [];
const notify = new NotifyCenter({
  dataDir: dir,
  log: () => {},
  sessionTitle: () => "会话名",
  sessionPlan: (id: string) => store.getPlan(id),
});
notify.onNotice((n: { kind: string; title: string; body: string }) => notices.push(n));

/** one finished turn, and the newest completion notice it produced */
const finishTurn = (): string => {
  notices.length = 0;
  notify.observe({ t: "turn-start", sessionId: SID } as never);
  notify.observe({ t: "turn-end", sessionId: SID, durationMs: 72_000 } as never);
  return notices.filter((n) => n.kind === "agent_done").at(-1)?.body ?? "(no card)";
};

store.upsertPlan(SID, {
  items: items(["读失败用例", "completed"], ["改登录超时", "completed"]),
  title: "修登录超时", source: "mcp",
});
const titled = finishTurn();
check("the card reads 会话名 · <title> · 用时 (issue #11)", titled === "会话名 · 修登录超时 · 用时 1m 12s", titled);

// no title → the writer's remark, FIRST SENTENCE only (a remark is prose; the body has one line)
store.upsertPlan(SID, {
  items: items(["读失败用例", "completed"]), title: null,
  explanation: "重写登录链路。顺带补齐了三处测试", source: "mcp",
});
const remarked = finishTurn();
check("without a title, the remark's first sentence is used",
  remarked === "会话名 · 重写登录链路 · 用时 1m 12s", remarked);

// neither → the last step the plan shows as completed
store.upsertPlan(SID, {
  items: items(["读失败用例", "completed"], ["改登录超时", "pending"]), title: null, explanation: null, source: "mcp",
});
const fromStep = finishTurn();
check("with neither, the last CLOSED step names the work",
  fromStep === "会话名 · 读失败用例 · 用时 1m 12s", fromStep);

// nothing at all → exactly the pre-#11 card (a one-step turn has no task line to give)
store.upsertPlan(SID, { items: items(["还没开始的一步", "pending"]), title: null, explanation: null, source: "mcp" });
const bare = finishTurn();
check("nothing usable degrades to 会话名 · 用时 (the pre-#11 shape)",
  bare === "会话名 · 用时 1m 12s", bare);

// a long title never reaches the card longer than its own budget
store.upsertPlan(SID, { items: items(["a", "completed"]), title: clampTitle("很".repeat(60)), source: "mcp" });
const longBody = finishTurn();
check("a long title arrives clipped, never spilling into the duration",
  longBody.startsWith("会话名 · ") && longBody.endsWith(" · 用时 1m 12s") && longBody.length <= "会话名 · ".length + MAX_TITLE + " · 用时 1m 12s".length,
  longBody);

const failed = (() => {
  notices.length = 0;
  notify.observe({ t: "turn-start", sessionId: SID } as never);
  notify.observe({ t: "turn-end", sessionId: SID, error: "boom", durationMs: 5_000 } as never);
  return notices.filter((n) => n.kind === "error").at(-1)?.body ?? "(no card)";
})();
check("a FAILED turn still says the error, not the task title", failed === "会话名 · boom", failed);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
