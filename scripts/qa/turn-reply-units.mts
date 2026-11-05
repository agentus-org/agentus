// #93 回执措辞的单测：`briefOf` 是「说清是哪一笔活」的全部依据（#93-2）。
//
// E2E 在 `reply-on-done.mjs`（真 server、真 CLI，含自我打断与批量合并）；这里守的只是那个纯函数：
// 它必须把任意派活消息压成**一行、可控长度**的摘要 —— 回执会被写进另一个会话的对话流，多行摘要
// 会把一条通知撑成一段。
//
//   npx tsx scripts/qa/turn-reply-units.mts
import { briefOf } from "../../packages/server/src/acp/session-manager.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

check("普通一句话原样返回", briefOf("帮我跑个慢活") === "帮我跑个慢活", briefOf("帮我跑个慢活"));
check("换行/连续空白压成单个空格",
  briefOf("第一行\n\n第二行   带   空格") === "第一行 第二行 带 空格", briefOf("第一行\n\n第二行   带   空格"));
check("首尾空白被裁掉", briefOf("   两头空   ") === "两头空", JSON.stringify(briefOf("   两头空   ")));
check("超过 50 字截断并加省略号", (() => {
  const long = "活".repeat(80);
  const got = briefOf(long);
  return got.length === 51 && got.endsWith("…") && got.startsWith("活".repeat(50));
})(), JSON.stringify(briefOf("活".repeat(80))));
check("恰好 50 字不截断", briefOf("活".repeat(50)) === "活".repeat(50));
check("空消息也有话可说（不返回空串）", briefOf("   ") === "（空消息）", JSON.stringify(briefOf("   ")));
check("多行指令只留首行信息量（全在一行里）", !briefOf("- a\n- b\n- c").includes("\n"), JSON.stringify(briefOf("- a\n- b\n- c")));

console.log(`\n${fail ? "FAIL" : "ALL"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
