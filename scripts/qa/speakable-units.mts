// 播报 L0 规则适配层 —— 纯逻辑检查（packages/web/src/speakable.ts）。
//
// 为什么是单测：这一层的全部内容是「哪些字被换成哪句话」，与像素、网络无关。
// 浏览器那边只需要验证两件别的事（speakable-sweep.mjs）：念稿真的被用来念、meta 真的显示出来。
//
// Run: npm run speakable-units   (tsx; no browser, no server, no network)
import {
  toSpeakable, estimateSpeechSeconds, humanDuration, describeSpeakable,
  TABLE_ROW_LIMIT, SPEAKABLE_RULES_VERSION,
} from "../../packages/web/src/speakable.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// ---- 1. 代码块：只报行数，不念内容，不再出现英文 "code block"
{
  const r = toSpeakable("改好了。\n\n```ts\nexport function a() {\n  return 1;\n}\n```\n\n现在可以了。");
  check("代码块被报成「代码块，N 行」", /代码块，\d+ 行/.test(r.script), r.script);
  check("代码块内容一个字都没进稿子", !/return|export|function/.test(r.script), r.script);
  check("不再出现英文 code block", !/code block/i.test(r.script));
  check("meta 记下了跳过的块数与行数", r.notes.codeBlocks === 1 && r.notes.codeLines >= 3, JSON.stringify(r.notes));
}
// ---- 1b. 开头是注释的代码块，念那句注释当自述
{
  const r = toSpeakable("```python\n# 把持仓表按代码排序\nimport x\n```");
  check("代码块开头的注释被念出来当自述", /把持仓表按代码排序/.test(r.script), r.script);
}

// ---- 2. 表格：内容逐行念，不是只报表头、不是碎词连读
const table = [
  "| 名称 | 状态 | 耗时 |",
  "|---|---|---|",
  "| 接口 X | 运行中 | 2s |",
  "| 接口 Y | 失败 | 超时 |",
].join("\n");
{
  const r = toSpeakable(table);
  check("表格先说明有几列", /一张表，3 列：名称、状态、耗时/.test(r.script), r.script);
  check("表格逐行念出内容（第一行）", /第一行，接口 X，运行中，2s/.test(r.script), r.script);
  check("表格逐行念出内容（第二行）", /第二行，接口 Y，失败，超时/.test(r.script), r.script);
  check("表格的分隔符不再被念成碎词", !/\|/.test(r.script) && !/---/.test(r.script));
  check("没有多余的折叠说明", !/后面还有/.test(r.script), r.script);
  check("meta 记下表格行数", r.notes.tables === 1 && r.notes.tableRows === 2, JSON.stringify(r.notes));
}
// ---- 2b. 超过 15 行必须明说「后面还有 K 行」，不许静默丢
{
  const rows = Array.from({ length: 20 }, (_, i) => `| 行${i + 1} | 值${i + 1} |`);
  const r = toSpeakable(["| 名称 | 值 |", "|---|---|", ...rows].join("\n"));
  check(`超过 ${TABLE_ROW_LIMIT} 行时折叠到 ${TABLE_ROW_LIMIT} 行`, r.notes.tableRows === TABLE_ROW_LIMIT, String(r.notes.tableRows));
  check("折叠时明确播报还剩多少行", /后面还有 5 行，内容类似/.test(r.script), r.script);
  check("meta 里记着折叠了几行", r.notes.tableRowsFolded === 5, JSON.stringify(r.notes));
}

// ---- 3. 链接：只念文字 / 域名与末段，不念协议、参数、锚点
{
  const r = toSpeakable("见 [那个 issue](https://github.com/agentus-org/agentus/issues/76) 里的说明。");
  check("带锚文本的链接只念文字", /见 那个 issue 里的说明/.test(r.script) && !/github/.test(r.script), r.script);
}
{
  const r = toSpeakable("地址是 https://example.com/a/b/issue-76?x=1#c 你看下。");
  check("裸 URL 念成「链接：域名 上的 末段」", /链接：example\.com 上的 issue-76/.test(r.script), r.script);
  check("协议不再被逐字母念", !/https/.test(r.script), r.script);
  check("查询串与锚点被丢掉", !/\?x=1/.test(r.script) && !/#c/.test(r.script), r.script);
}
{
  const r = toSpeakable("看 https://docs.example.com/guide/setup");
  check("末段不是 ID 时念成人话（下划线换空格）", /链接：docs\.example\.com 上的 setup/.test(r.script), r.script);
}

// ---- 4. 长串、路径、行内代码
{
  const r = toSpeakable("commit 是 9fcaa0a4f9d470e3935fe6cde91cf0819719f959，别弄错。");
  check("长 hex 被说成「一个长串，略过」", /一个长串，略过/.test(r.script) && !/9fcaa0a4/.test(r.script), r.script);
  check("meta 记下略过的长串数", r.notes.longTokens >= 1, JSON.stringify(r.notes));
}
{
  const r = toSpeakable("UUID 3f2504e0-4f89-11d3-9a0c-0305e82c3301 对应的行");
  check("UUID 也不逐段念", /一个长串，略过/.test(r.script) && !/3f2504e0/.test(r.script), r.script);
}
{
  const r = toSpeakable("改的是 /Users/liang/Workspace/agent-dev-workspace/worktrees/agentus/packages/web/src/App.tsx 这个文件");
  check("绝对路径只念文件名", /App\.tsx/.test(r.script) && !/Users\/liang/.test(r.script), r.script);
}
{
  const r = toSpeakable("跑 `npm run build` 就行");
  check("人话形态的行内代码原样念", /npm run build/.test(r.script), r.script);
  check("反引号不念出来", !/`/.test(r.script), r.script);
}
{
  const r = toSpeakable("打开 `max_completion_tokens` 这个字段");
  check("snake_case 里的下划线换成空格", /max completion tokens/.test(r.script), r.script);
}

// ---- 4b. 正文里的相对路径同样只念文件名（这一条是实测抓到的：`packages/server/src/index.ts`
//      一开始被当成「长串」整个略过，等于把「改了哪个文件」这个最有用的信息丢了）
{
  const r = toSpeakable("改动在 packages/server/src/index.ts 里");
  check("相对路径只念文件名", /改动在 index\.ts 里/.test(r.script), r.script);
  check("相对路径不算长串", r.notes.longTokens === 0 && r.notes.paths === 1, JSON.stringify(r.notes));
}
{
  const r = toSpeakable("改的是 `packages/web/src/App.tsx`");
  check("行内代码里的路径也只念文件名", /App\.tsx/.test(r.script) && !/packages\/web/.test(r.script), r.script);
}

// ---- 5. 噪声：HTML、emoji、零宽、标题、列表
{
  const r = toSpeakable("<b>结论</b>：可以 🎉 上线\u200b了");
  check("HTML 标签被剥掉", !/<b>/.test(r.script) && /结论/.test(r.script), r.script);
  check("emoji 被剥掉", !/🎉/.test(r.script), r.script);
  check("零宽字符被剥掉", !/\u200b/.test(r.script));
}
{
  const r = toSpeakable("## 结论\n\n- 先修 A\n- 再修 B\n\n完事。");
  check("标题后面补停顿", /结论。/.test(r.script), r.script);
  check("列表项之间用「；」", /先修 A；再修 B。/.test(r.script), r.script);
}

// ---- 6. 可复现 & 版本
{
  const src = "# 标题\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```sh\nls -la\n```\n\n结尾 https://x.dev/p/123";
  const a = toSpeakable(src), b = toSpeakable(src);
  check("同输入同输出（规则版可复现）", a.script === b.script && JSON.stringify(a.notes) === JSON.stringify(b.notes));
  check("规则版本随稿子走", a.notes.version === SPEAKABLE_RULES_VERSION && SPEAKABLE_RULES_VERSION.length > 0);
  check("回环幂等：对自己再跑一遍不改意思", toSpeakable(a.script).notes.codeBlocks === 0);
}

// ---- 7. 时长预告
{
  check("中文按 4.5 字/秒估算", Math.abs(estimateSpeechSeconds("一二三四五六七八九") - 2) < 0.05, String(estimateSpeechSeconds("一二三四五六七八九")));
  check("两倍速时长减半", estimateSpeechSeconds("一二三四五六七八九", 2) < 1.1);
  check("分钟级说「约 N 分钟」", humanDuration(660) === "约 11 分钟", humanDuration(660));
  check("不到一分钟说秒", humanDuration(40) === "约 40 秒", humanDuration(40));
}
{
  const notes = toSpeakable("```js\nx\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |").notes;
  const line = describeSpeakable(notes, 660);
  check("meta 一句话说清念了什么、漏了什么", /^规则版 · 跳过 1 个代码块（共 1 行） · 表格 1 行全部念出 · 约 11 分钟$/.test(line), line);
}

console.log(`\nspeakable-units: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
