// #72 读侧那一半：新建会话对话框的"当前模型"只能来自清单。
//
// 为什么值得一个 suite：对话框没有任何会话可读，它唯一的来源是后端**上一次真启动**时缓存的握手
// （`/api/backends` 的 `handshake.models`）。那个快照在换模型后不会自己更新，旧版本里还会存一条
// 幻影 id（`custom:<模型>`，provider 是个类别）。把这种 id 显示成"当前"，下一步就是把它当成
// 操作者的显式选择重放成 `set-model` —— 错误路由被再固化一遍。判据因此只有一条：**清单外的 id
// 一个字都不许用**。
//
//   npx tsx scripts/qa/start-model-default.mts
import { startModelValue } from "../../packages/web/src/modelNames.ts";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const ids = ["deepseek:deepseek-flash", "custom:lab:Fast", "custom:lab:DeepSeek-Flash"];

// ---- 1. 清单里有就用（pick 优先于缓存）
check("a pick that is in the list wins", startModelValue("custom:lab:Fast", "deepseek:deepseek-flash", ids) === "custom:lab:Fast");
check("with no pick the cached current is used", startModelValue(null, "custom:lab:Fast", ids) === "custom:lab:Fast");

// ---- 2. 幻影 / 陈旧 id 永不被采用
check("a phantom cached id is dropped, not shown",
  startModelValue(null, "custom:Fast", ids) === "", startModelValue(null, "custom:Fast", ids));
check("a phantom pick falls back to the cached current when that one is real",
  startModelValue("custom:Fast", "custom:lab:Fast", ids) === "custom:lab:Fast");
check("two stale sources leave the dialog on the agent default",
  startModelValue("custom:Fast", "custom:Old", ids) === "");

// ---- 3. 空清单 = 没有依据，不要拿陈旧值冒充
check("an empty list never resurrects the cached id", startModelValue(null, "deepseek:deepseek-flash", []) === "");
check("an empty list also drops an explicit pick", startModelValue("custom:lab:Fast", null, []) === "");
check("a row that never ran yields the default", startModelValue(null, null, []) === "");

// ---- 4. 返回值永远要么是清单里的 id，要么是空串
{
  const probes: Array<[string | null, string | null]> = [
    ["custom:Fast", null], [null, "custom:Fast"], ["custom:lab:Fast", "custom:Old"],
    ["deepseek:deepseek-flash", null], [null, null], ["", ""],
  ];
  const ok = probes.every(([pick, cached]) => {
    const out = startModelValue(pick, cached, ids);
    return out === "" || ids.includes(out);
  });
  check("the dialog never carries an id that is not in the list", ok);
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
