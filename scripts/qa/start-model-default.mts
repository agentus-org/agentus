// #72 读侧那一半：新建会话对话框的"当前模型"只能来自清单。
//
// 为什么值得一个 suite：对话框没有任何会话可读，它唯一的来源是后端**上一次真启动**时缓存的握手
// （`/api/backends` 的 `handshake.models`）。那个快照在换模型后不会自己更新，旧版本里还会存一条
// 幻影 id（`custom:<模型>`，provider 是个类别）。把这种 id 显示成"当前"，下一步就是把它当成
// 操作者的显式选择重放成 `set-model` —— 错误路由被再固化一遍。判据因此只有一条：**清单外的 id
// 一个字都不许用**。
//
//   npx tsx scripts/qa/start-model-default.mts
import { modelProvider, rowModelName, startModelValue } from "../../packages/web/src/modelNames.ts";

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

// ---- 4. 分组标题：`custom:<条目>:<模型>` 的 provider 是**条目**，不是计费类 `custom`
//      （否则 lab / qoder 这些命名端点全被归进一个叫 "custom" 的组里）
{
  const p = (id: string, description: string | null = null): string => modelProvider({ modelId: id, description });
  check("a named endpoint groups under its entry name",
    p("custom:qoder:qwen3.8-flash") === "qoder", p("custom:qoder:qwen3.8-flash"));
  check("…not under the billing class",
    p("custom:qoder:qwen3.8-flash") !== "custom");
  check("two entries are two groups",
    new Set(["custom:qoder:a", "custom:lab:b"].map((id) => p(id))).size === 2);
  check("a legacy two-part custom id stays with the class (that is all it says)",
    p("custom:Fast") === "custom", p("custom:Fast"));
  check("canonical ids are unchanged", p("openrouter:anthropic/claude") === "openrouter");
  check("slash ids are unchanged", p("openai/gpt-6") === "openai");
  check("a description still wins over the id", p("custom:qoder:a", "Provider: Qoder Gateway") === "Qoder Gateway");
  check("the row label drops the provider, not the model",
    rowModelName({ modelId: "custom:qoder:qwen3.8-flash" }, "qoder") === "qwen3.8-flash",
    rowModelName({ modelId: "custom:qoder:qwen3.8-flash" }, "qoder"));
}

// ---- 7. #75：对话框现在能拿到展示名/描述，两处的 provider 标签必须一致
//
// 同一个 id，活会话（chat 页）画出「ALIBABA CLOUD DASHSCOPE (CHINA)」，起始页却画「ALIBABA-CN」——
// 因为起始页只有 id，只能从 id 里猜。快照带上 name/description 之后，两处读的是同一份事实。
{
  const id = "alibaba-cn:qwen3.8-flash";
  const desc = "Provider: ALIBABA CLOUD DASHSCOPE (CHINA)";
  const live = { modelId: id, name: "qwen3.8-flash", description: desc };
  const dialog = { modelId: id, name: "qwen3.8-flash", description: desc }; // 起始页从快照拼出来的那一行
  check("the dialog labels a model from its description, exactly like the chat page",
    modelProvider(dialog) === modelProvider(live) && modelProvider(dialog) === "ALIBABA CLOUD DASHSCOPE (CHINA)",
    modelProvider(dialog));
  check("with no description the id still labels it — the snapshot may predate the field",
    modelProvider({ modelId: id, name: null, description: null }) === "alibaba-cn",
    modelProvider({ modelId: id, name: null, description: null }));
  check("a named endpoint is still grouped under the entry, name or not",
    modelProvider({ modelId: "custom:lab:qwen38-27b", name: "qwen", description: null }) === "lab",
    modelProvider({ modelId: "custom:lab:qwen38-27b", name: "qwen", description: null }));
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
