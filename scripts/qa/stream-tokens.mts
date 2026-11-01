// 流式测速的 token 估算口径（issue #70 step 1）。
//
// 这个函数唯一要保证的事：**别装成真数字**。ACP 的流里没有 usage，操作员要 t/s，我们只能从字符估；
// 估错了要能一眼看出来「是估的」，且量级不能离谱（中文 0.6 token/字、英文 ~4 字符/token）。
//   npm run stream-tokens
import { estimateStreamTokens } from "../../packages/shared/src/index.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// 1. 中文：0.6 token/字（1 token ≈ 1.67 汉字）
{
  const n = estimateStreamTokens("你好世界");
  check("4 个汉字 ≈ 2.4 token", Math.abs(n - 2.4) < 1e-9, String(n));
}
// 2. 英文/代码：0.25 token/字符（~4 字符/token）
{
  const n = estimateStreamTokens("hello world");
  check("10 个非空字符 ≈ 2.5 token", Math.abs(n - 2.5) < 1e-9, String(n));
  const code = estimateStreamTokens("const x = 1;");
  check("代码行也按同一条口径算", code > 2 && code < 5, String(code));
}
// 3. 空白不计：它跟着词一起计过价了，再算一遍就是虚高
{
  check("空串 = 0", estimateStreamTokens("") === 0);
  check("纯空白 = 0", estimateStreamTokens("  \n\t ") === 0);
  check("换行/缩进不改变数字", estimateStreamTokens("你好\n\n  世界") === estimateStreamTokens("你好世界"));
}
// 4. 混排：两种口径各算各的，别一刀切
{
  const mixed = estimateStreamTokens("你好 hello");
  check("中英混排落在两者之间", mixed > 1.2 && mixed < 2.6, String(mixed));
}
// 5. 全角标点算中文那一档（中文标点在 BPE 里是独立 token，按 0.6 更接近真实）
{
  check("全角标点按中文档计", estimateStreamTokens("好！") > estimateStreamTokens("好") , String(estimateStreamTokens("好！")));
}

console.log(`\nstream-tokens: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
