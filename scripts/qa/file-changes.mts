// QA (issue #38) — 回合级文件变更的**数据面**。
//
// 这个文件只测纯函数（packages/web/src/changes.ts），不起服务、不起浏览器：
//   · 一条 tool payload 里三种形状都能抽出「改了哪个文件」（Hermes 的 diff block / 无 type 的
//     oldText-newText / 别的后端塞在 text block 里的 unified diff）；
//   · 同一文件在一回合里被改两次 → 合并成一条（改前取最早、改后取最新），编辑次数记在 edits；
//   · 没有 path 的调用（bash / 搜索 / 读文件）一条都不产出；
//   · diffLines 的 hunk 行为不变（审批卡和面板共用它，抽组件时不能顺手改行为）。
//
// 页面那一半（面板真的画出来了、点开有 diff、刷新后还在）在 file-changes-sweep.mjs。
//
//   npx tsx scripts/qa/file-changes.mts
import { changesOfTool, mergeChanges, diffLines, parseUnifiedDiff, baseName } from "../../packages/web/src/changes";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const OLD_A = "const a = 1;\nconst b = 2;\n";
const MID_A = "const a = 1;\nconst b = 20;\n";
const NEW_A = "const a = 1;\nconst b = 20;\nconst c = 3;\n";

// ── 1. 抽取：Hermes 的 diff block（`{type:"diff", path, oldText, newText}`） ──────────────
{
  const got = changesOfTool({
    toolCallId: "t1", kind: "edit",
    content: [{ type: "diff", path: "/repo/a.ts", oldText: OLD_A, newText: MID_A }],
  });
  check("diff block → 一个变更", got.length === 1 && got[0].path === "/repo/a.ts");
  check("diff block → 带全文", got[0]?.oldText === OLD_A && got[0]?.newText === MID_A);
}

// ── 2. 抽取：没有 type，但带 path + oldText/newText（同义写法） ───────────────────────────
{
  const got = changesOfTool({ content: [{ path: "src/b.ts", oldText: "x\n", newText: "y\n" }] });
  check("无 type 的 oldText/newText 也认", got.length === 1 && got[0].path === "src/b.ts");
}

// ── 3. 抽取：没 path 的调用不产出（bash / 搜索 / 读文件） ─────────────────────────────────
{
  const got = changesOfTool({
    content: [
      { type: "content", content: { type: "text", text: "total 12\ndrwxr-xr-x 3 user staff 96 .\n" } },
      { type: "content", content: { type: "text", text: "grep: 3 matches" } },
    ],
  });
  check("无 path 的输出 → 0 个变更", got.length === 0, `got ${got.length}`);
}

// ── 4. 抽取：别的后端把 unified diff 放在 text block 里 ───────────────────────────────────
{
  const patch = [
    "--- a/src/c.ts",
    "+++ b/src/c.ts",
    "@@ -1,2 +1,3 @@",
    " keep",
    "-old line",
    "+new line",
    "+another line",
  ].join("\n");
  const got = changesOfTool({ content: [{ type: "content", content: { type: "text", text: patch } }] });
  check("text block 里的 unified diff 也认", got.length === 1 && got[0].path === "src/c.ts", got[0]?.path ?? "");
  const parsed = parseUnifiedDiff(patch);
  check("unified diff 计数（+2 / −1）", parsed?.insertions === 2 && parsed?.deletions === 1,
    `+${parsed?.insertions} −${parsed?.deletions}`);
}

// ── 5. 合并：同一文件改两次 = 一条，改前最早 / 改后最新，edits=2 ──────────────────────────
{
  const merged = mergeChanges([
    { path: "/repo/a.ts", oldText: OLD_A, newText: MID_A },
    { path: "/repo/a.ts", oldText: MID_A, newText: NEW_A },
    { path: "/repo/b.md", oldText: "", newText: "hello\n" },
  ]);
  const a = merged.find((f) => f.path === "/repo/a.ts");
  check("同一文件两次编辑合并成一条", merged.length === 2, `got ${merged.length}`);
  check("合并后 edits=2", a?.edits === 2, String(a?.edits));
  check("改前取最早", a?.oldText === OLD_A);
  check("改后取最新", a?.newText === NEW_A);
  // a.ts：b 那一行改了（−1/+1），加了一行（+1）
  check("合并后计数 = 累计 diff", a?.insertions === 2 && a?.deletions === 1, `+${a?.insertions} −${a?.deletions}`);
  check("新文件不编造删除行", merged.find((f) => f.path === "/repo/b.md")?.deletions === 0);
}

// ── 6. 只有 unified diff 的文件：给计数，不给全文（画不了逐行） ────────────────────────────
{
  const patch = "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
  const merged = mergeChanges([{ path: "x.ts", diffText: patch }]);
  check("只有 diff 文本 → 计数可用", merged[0].insertions === 1 && merged[0].deletions === 1);
  check("只有 diff 文本 → 没有全文", merged[0].oldText === "" && merged[0].newText === "");
}

// ── 7. diffLines：抽到 changes.ts 之后行为不变（这三条是审批卡一直在用的形状） ────────────
{
  const lines = diffLines("a\nb\nc\n", "a\nB\nc\n");
  check("diffLines 未变行标 ctx / 改行标 del+add",
    lines.filter((l) => l.kind === "ctx").length === 2
    && lines.filter((l) => l.kind === "del").length === 1
    && lines.filter((l) => l.kind === "add").length === 1);
  const big = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const edited = big.replace("line 20", "line twenty");
  const hunk = diffLines(big, edited);
  const gaps = hunk.filter((l) => l.kind === "gap");
  check("40 行文件只改一行 → 折叠成 gap（hunk-only）", gaps.length >= 1, `${gaps.length} 个 gap`);
  check("diffLines 新文件全 +", diffLines("", "x\ny\n").every((l) => l.kind === "add" || l.kind === "gap"));
}

// ── 8. baseName 两种分隔符 ────────────────────────────────────────────────────────────────
{
  check("baseName 处理 /", baseName("/a/b/c.ts") === "c.ts");
  check("baseName 处理 \\（Windows cwd）", baseName("C:\\a\\b\\c.ts") === "c.ts");
}

console.log(`\n${fail === 0 ? "OK" : "FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
