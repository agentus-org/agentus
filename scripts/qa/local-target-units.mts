// 纯函数红绿：本地文件链接/图片的双重 percent-encode（issue #110）。
//
// markdown-it 在解析期就 mdurl.encode 了 image src / link href，非 ASCII 路径到达
// localTarget 时已是 %XX。修复前：普通绝对路径分支不解码 -> path 带字面 %XX -> rawFileUrl
// 再 encodeURIComponent -> %25XX -> 后端 404。修复后：localTarget 汇合处 decode 一次 ->
// path 是真实非 ASCII 路径 -> rawFileUrl 单编码 -> 200。
//
// 这里测两件事：localTarget 的解码收口，以及 rawFileUrl 对它是单编码（不是 %25 双编码）。
//   npx tsx scripts/qa/local-target-units.mts
import { localTarget } from "../../packages/web/src/Markdown.tsx";
import { rawFileUrl } from "../../packages/web/src/state.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`); }
};

// 1. 非 ASCII 绝对路径：mdurl 编码形态 -> localTarget 应解码回真实路径
{
  const encoded = "/path/to/shots/1-%E5%8D%95%E6%9C%BA%E7%9B%91%E6%8E%A7%E8%81%9A%E5%90%88.png";
  const t = localTarget(encoded);
  check("CJK absolute path decodes once in localTarget",
    t?.path === "/path/to/shots/1-单机监控聚合.png", JSON.stringify(t));
}
// 2. rawFileUrl 对真实路径是单编码，不含 %25 双编码
{
  const t = localTarget("/path/to/shots/1-%E5%8D%95%E6%9C%BA%E7%9B%91%E6%8E%A7%E8%81%9A%E5%90%88.png");
  const url = rawFileUrl(t!.path);
  check("rawFileUrl produces single-encoding (%E5 not %25E5)",
    url.includes("%E5%8D%95") && !url.includes("%25"), url);
}
// 3. 空格：%20 解码回空格，再单编码成 %20（不是 %2520）
{
  const t = localTarget("/shots/my%20shot.png");
  const url = rawFileUrl(t!.path);
  check("space path: decoded to space, re-encoded once as %20",
    t?.path === "/shots/my shot.png" && url.includes("my%20shot.png") && !url.includes("%2520"),
    `${JSON.stringify(t)} ${url}`);
}
// 4. file:// 仍正常，且只解码一次（不被二次解码破坏）
{
  const t = localTarget("file:///path/to/%E5%9B%BE%E7%89%87.png");
  check("file:// still decodes to real path (no double decode)",
    t?.path === "/path/to/图片.png", JSON.stringify(t));
}
// 5. 纯 ASCII 路径不受影响
{
  const t = localTarget("/path/to/shot.png");
  check("ASCII path unchanged", t?.path === "/path/to/shot.png", JSON.stringify(t));
}
// 6. 行号后缀仍在解码后正确剥离（「粤」=%E7%B2%A4，合法 UTF-8 序列）
{
  const t = localTarget("/path/to/%E7%B2%A4.md:12");
  check("line suffix survives decode", t?.path === "/path/to/粤.md" && t.line === 12,
    JSON.stringify(t));
}
// 7. 非法 % 序列不应抛异常，原样保留
{
  let threw = false, t: ReturnType<typeof localTarget> = null;
  try { t = localTarget("/path/%ZZbad.png"); } catch { threw = true; }
  check("malformed % sequence does not throw", !threw && !!t, JSON.stringify(t));
}

console.log(`\nlocal-target-units: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
