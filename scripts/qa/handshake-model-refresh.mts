// #72 服务端那一半：换模型后，缓存握手里的 currentModelId 必须跟着走。
//
// 为什么这是服务端的事：新建会话的对话框只读 `/api/backends` 里那份**握手快照**（那是上一次真启动时
// 缓存的形状），活会话的完整清单它看不到。快照不刷新 = 对话框永远显示换模型之前的那个 id，用户看到
// 的"默认模型"和配置里的默认值分叉。
//
//   npx tsx scripts/qa/handshake-model-refresh.mts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../packages/server/src/store/store.ts";
import { emptyHealth, handshakeFrom, seedRows } from "../../packages/server/src/acp/registry.ts";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-handshake-refresh-"));
const store = new Store(path.join(dir, "agentus.sqlite"));
store.seedBackendsIfEmpty(seedRows());

const row = store.listBackends().find((r) => r.id === "hermes");
check("the seeded hermes row exists", Boolean(row));
const id = row?.id ?? "hermes";

const handshake = (current: string, available: string[]) => ({
  at: Date.now(),
  protocolVersion: 1,
  loadSession: true,
  fork: null,
  modes: null,
  configOptions: [],
  commands: [],
  models: { currentModelId: current, available },
});

// ---- 1. 换模型后 current 跟着走（这是 #72 的 E 段：陈旧值）
{
  store.recordBackendCheck(id, emptyHealth(), handshake("custom:old-model", ["custom:old-model", "custom:lab:Fast"]));
  check("the snapshot starts on the old id",
    store.getBackend(id)?.handshake?.models?.currentModelId === "custom:old-model");

  store.recordHandshakeModels(id, { currentModelId: "custom:lab:Fast" });
  const after = store.getBackend(id)?.handshake;
  check("switching the model refreshes the cached current",
    after?.models?.currentModelId === "custom:lab:Fast", String(after?.models?.currentModelId));
  check("…without touching the id list it did not supply",
    (after?.models?.available ?? []).length === 2, JSON.stringify(after?.models?.available));
  check("…and without dropping the rest of the handshake",
    after?.protocolVersion === 1 && after?.loadSession === true);
}

// ---- 2. 活会话知道完整清单时，清单也一起更新
{
  store.recordHandshakeModels(id, {
    currentModelId: "custom:lab:Fast",
    available: ["custom:lab:Fast", "custom:lab:DeepSeek-Flash"],
  });
  const models = store.getBackend(id)?.handshake?.models;
  check("a supplied list replaces the cached one", (models?.available ?? []).length === 2,
    JSON.stringify(models?.available));
  check("…and the current id survives", models?.currentModelId === "custom:lab:Fast");
}

// ---- 2b. current 必须在清单里（对话框只显示清单内的 id，缓存一个清单外的 current 等于把它丢掉）
{
  store.recordHandshakeModels(id, { currentModelId: "custom:lab:Brand-New" });
  const models = store.getBackend(id)?.handshake?.models;
  const list = models?.available ?? [];
  check("a current the cached list lacks is added, not silently dropped",
    list.includes("custom:lab:Brand-New") && list[0] === "custom:lab:Brand-New", JSON.stringify(list));
  check("…without growing the cache (the oldest id makes room)",
    list.length === 2, JSON.stringify(list));
}

// ---- 2c. 连续切换不会把清单越堆越长（`available` 就是对话框的模型列表）
{
  for (let i = 0; i < 30; i += 1) store.recordHandshakeModels(id, { currentModelId: `custom:lab:m${i}` });
  const list = store.getBackend(id)?.handshake?.models?.available ?? [];
  check("thirty switches do not turn the model list into a graveyard", list.length <= 2, JSON.stringify(list));
  check("…and the newest switch is still the one shown",
    store.getBackend(id)?.handshake?.models?.currentModelId === "custom:lab:m29", JSON.stringify(list));
}

// ---- 3. 没跑过的行（没有握手）不会被凭空造出快照
{
  const fresh = new Store(path.join(dir, "empty.sqlite"));
  fresh.seedBackendsIfEmpty(seedRows());
  fresh.recordHandshakeModels("hermes", { currentModelId: "whatever" });
  check("a row that never ran gets no invented handshake",
    fresh.getBackend("hermes")?.handshake == null, String(fresh.getBackend("hermes")?.handshake));
}

// ---- 4. 坏 JSON 不会炸，也不会覆盖
{
  const broken = new Store(path.join(dir, "broken.sqlite"));
  broken.seedBackendsIfEmpty(seedRows());
  const dbFile = path.join(dir, "broken.sqlite");
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(dbFile);
  raw.prepare("update backends set handshake = ? where id = ?").run("{not json", "hermes");
  raw.close();
  let threw = "";
  try {
    broken.recordHandshakeModels("hermes", { currentModelId: "x" });
  } catch (e) {
    threw = String((e as Error).message ?? e);
  }
  check("an unparseable snapshot is left alone instead of throwing", threw === "", threw);
}

// ---- 5. #75：快照也要带展示名/描述，否则新建会话的对话框只能从 id 里猜 provider
{
  store.recordBackendCheck(id, emptyHealth(), {
    ...handshake("custom:lab:Fast", ["custom:lab:Fast", "custom:lab:Deep"]),
    models: {
      currentModelId: "custom:lab:Fast",
      available: ["custom:lab:Fast", "custom:lab:Deep"],
      names: { "custom:lab:Fast": "Fast", "custom:lab:Deep": "DeepSeek-Flash" },
      descriptions: { "custom:lab:Fast": "Provider: Lab" },
    },
  });
  const models = store.getBackend(id)?.handshake?.models;
  check("a snapshot can carry model names", models?.names?.["custom:lab:Deep"] === "DeepSeek-Flash",
    JSON.stringify(models?.names));
  check("…and descriptions", models?.descriptions?.["custom:lab:Fast"] === "Provider: Lab",
    JSON.stringify(models?.descriptions));

  // 冷的调用方只知道 id（旧代码的调用形状）：不能把已经学到的名字抹掉
  store.recordHandshakeModels(id, { currentModelId: "custom:lab:Deep" });
  const kept = store.getBackend(id)?.handshake?.models;
  check("an ids-only refresh does not wipe the names already learned",
    kept?.names?.["custom:lab:Fast"] === "Fast", JSON.stringify(kept?.names));

  store.recordHandshakeModels(id, {
    currentModelId: "custom:lab:Deep",
    available: ["custom:lab:Deep"],
    names: { "custom:lab:Deep": "DeepSeek-Flash" },
    descriptions: { "custom:lab:Deep": "Provider: Lab · current" },
  });
  const merged = store.getBackend(id)?.handshake?.models;
  check("a richer refresh merges into the name map", merged?.names?.["custom:lab:Fast"] === "Fast"
    && merged?.names?.["custom:lab:Deep"] === "DeepSeek-Flash", JSON.stringify(merged?.names));
  check("…and descriptions merge the same way", merged?.descriptions?.["custom:lab:Deep"] === "Provider: Lab · current",
    JSON.stringify(merged?.descriptions));
}

// ---- 6. #75：抓握手的那一刻就要把 name/description 留住（不是等活会话另说一次）
{
  const hs = handshakeFrom(
    { protocolVersion: 1, agentCapabilities: {} },
    {
      models: {
        currentModelId: "alibaba-cn:qwen3.8-flash",
        availableModels: [
          { modelId: "alibaba-cn:qwen3.8-flash", name: "qwen3.8-flash", description: "Provider: ALIBABA CLOUD DASHSCOPE (CHINA)" },
          { modelId: "alibaba-cn:qwen3.8-max" },
        ],
      },
    },
  );
  check("capturing a handshake keeps the model names", hs.models?.names?.["alibaba-cn:qwen3.8-flash"] === "qwen3.8-flash",
    JSON.stringify(hs.models?.names));
  check("…and the descriptions the picker groups by",
    hs.models?.descriptions?.["alibaba-cn:qwen3.8-flash"] === "Provider: ALIBABA CLOUD DASHSCOPE (CHINA)",
    JSON.stringify(hs.models?.descriptions));
  check("a model the agent did not name still has the id as its name",
    hs.models?.names?.["alibaba-cn:qwen3.8-max"] === "alibaba-cn:qwen3.8-max", JSON.stringify(hs.models?.names));
  check("…and no invented description", hs.models?.descriptions?.["alibaba-cn:qwen3.8-max"] === undefined,
    JSON.stringify(hs.models?.descriptions));
  check("the id list is unchanged by the richer shape",
    (hs.models?.available ?? []).join(",") === "alibaba-cn:qwen3.8-flash,alibaba-cn:qwen3.8-max",
    JSON.stringify(hs.models?.available));
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
