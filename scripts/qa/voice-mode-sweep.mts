// QA: 语音通话模式的决策层（issue #48）。
//
// 三态生命周期是这件事最容易写错的地方（“这一轮到底欠不欠一句话”），所以把它做成纯函数再测。
// 这里不碰 ACP、不碰网络：
//
//   node_modules/.bin/tsx scripts/qa/voice-mode-sweep.mts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "../..");
const { voiceModeBlock, voiceExitText, thinkingOptionOf, voiceAppliesToPrompt, VOICE_ENTER_TEXT, VOICE_STEADY_TEXT, VOICE_META_KEY } =
  await import("../../packages/server/src/acp/voice-mode.ts");
const { Store } = await import("../../packages/server/src/store/store.ts");

let passed = 0;
const failures: string[] = [];
function check(ok: boolean, name: string, detail = ""): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const textOf = (b: unknown): string =>
  String((b as { resource?: { text?: string } } | null)?.resource?.text ?? "");
const uriOf = (b: unknown): string => String((b as { resource?: { uri?: string } } | null)?.resource?.uri ?? "");

// ---- 1. the three states ------------------------------------------------------------------------
console.log("\n[1] 三态：进入 / 每轮 / 退出");
{
  const enter = voiceModeBlock("sess1", { inCall: true, boundary: "enter", turns: 0 });
  const t = textOf(enter);
  check(t.includes(VOICE_ENTER_TEXT), "进入边界：带「开始语音通话」那段约束");
  check(t.includes(VOICE_STEADY_TEXT), "进入边界：约束合一（同一块里带上每轮那句）");
  check(/不要表格|不要代码块/.test(t), "进入边界：明确禁止表格/代码块（TTS 会念符号）");
  check(uriOf(enter) === "agentus://voice/sess1", "进入边界：uri 指向该会话");
  check((enter as { _meta?: Record<string, unknown> } | null)?._meta?.[VOICE_META_KEY] === true,
    "进入边界：带 agentus/voice-mode 标记（可与操作者原话区分）");

  const steady = voiceModeBlock("sess1", { inCall: true, boundary: null, turns: 4 });
  check(textOf(steady) === VOICE_STEADY_TEXT, "通话中每轮：只有那句稳定约束（不重复进入边界）");
  check(!textOf(steady).includes(VOICE_ENTER_TEXT), "通话中每轮：不重复进入边界（不刷屏）");

  const exit = voiceModeBlock("sess1", { inCall: false, boundary: "exit", turns: 3 });
  const x = textOf(exit);
  check(/语音通话已结束/.test(x), "退出边界：说清通话结束了");
  check(/3 轮/.test(x), "退出边界：引用刚才几轮是通话（3 轮）", x.slice(0, 60));
  check(/恢复文字对话/.test(x), "退出边界：说明恢复文字与正常格式");
  check(/语音识别|ASR/.test(x), "退出边界：解释用户那侧是转写（有噪声/碎片）");
  check(voiceExitText(0).includes("的对话"), "退出边界：0 轮时不说「0 轮」");

  check(voiceModeBlock("sess1", { inCall: false, boundary: null, turns: 2 }) === null,
    "挂断后的第 2 条起：什么都不注入（完全恢复原样）");
}

// ---- 2. the thinking dial -----------------------------------------------------------------------
console.log("\n[2] 思考档位识别（通话中要压低、退出要还原）");
{
  const mock = [
    { id: "reasoning_effort", name: "Reasoning Effort", type: "select", category: "thought_level",
      currentValue: "medium", options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }] },
    { id: "context_budget", name: "Context budget", type: "select", category: "_context_window",
      currentValue: "auto", options: [{ value: "auto", name: "Auto" }] },
  ];
  const knob = thinkingOptionOf(mock);
  check(knob?.id === "reasoning_effort", "按 category=thought_level 认出思考档位", String(knob?.id));
  check(knob?.current === "medium", "记住当前值（退出时还原到它）", String(knob?.current));
  check(knob?.lowest === "low", "最低档 = low（通话中压到这里）", String(knob?.lowest));
  check(thinkingOptionOf([{ id: "context_budget", options: [{ value: "a" }, { value: "b" }] }]) === null,
    "没有思考档位的后端：返回 null（不自己造一个）");
  const hermesLike = [{ id: "thinking", name: "Thinking", currentValue: "high",
    options: [{ value: "off", name: "Off" }, { value: "high", name: "High" }] }];
  check(thinkingOptionOf(hermesLike)?.lowest === "off", "名字里带 think 也认；off 优先于第一个");

  // Review M3: ACP puts no ordering on the value list. Guessing `options[0]` can pick the HIGHEST
  // level, i.e. make the call slower — the exact failure this feature exists to remove.
  const descending = [{ id: "thought_level", name: "Thinking", currentValue: "3",
    options: [{ value: "3", name: "3 档" }, { value: "1", name: "1 档" }] }];
  check(thinkingOptionOf(descending)?.lowest === "1", "数字档位：认出 1 是最低，不是列表第一个");
  check(thinkingOptionOf(descending)?.current === "3", "数字 currentValue 也要能记住（否则永不还原）");
  const localized = [{ category: "thought_level", id: "effort", currentValue: "high",
    options: [{ value: "high", name: "高" }, { value: "low", name: "低" }] }];
  check(thinkingOptionOf(localized)?.lowest === "low", "本地化「低/高」：靠 value 也能认出最低档");
  const boolish = [{ category: "thought_level", id: "thinking", currentValue: true,
    options: [{ value: "true", name: "开" }, { value: "false", name: "关" }] }];
  check(thinkingOptionOf(boolish)?.lowest === "false", "布尔档位：关（false）才是最低，不是「开」");
  check(thinkingOptionOf(boolish)?.current === "true", "布尔 currentValue 记成字符串");
  const unorderable = [{ category: "thought_level", id: "effort",
    options: [{ value: "deep" }, { value: "wide" }] }];
  check(thinkingOptionOf(unorderable) === null, "认不出最低档：返回 null（宁可不压，不许调高）");

  // Review M1: a background-completion wake is a synthetic turn. It must not carry the block, or it
  // burns the pending exit boundary and the operator's next real message never learns the call ended.
  check(voiceAppliesToPrompt({}) === true, "操作者自己发的 prompt：带通话块");
  check(voiceAppliesToPrompt({ origin: { sessionId: "background" } }) === false,
    "后台完成唤醒（带 origin）：不带、也不消费通话块");
}

// ---- 3. the persisted state ---------------------------------------------------------------------
console.log("\n[3] 持久化：边界必须活过刷新/回收");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-voice-"));
  const store = new Store(path.join(dir, "agentus.sqlite"));
  const d = store.getVoiceMode("nobody");
  check(d.inCall === false && d.boundary === null && d.turns === 0, "没记录过的会话：默认不在通话、没有欠账");
  store.upsertVoiceMode("s1", { inCall: true, boundary: "enter", turns: 0, thoughtBefore: "medium" });
  let v = store.getVoiceMode("s1");
  check(v.inCall && v.boundary === "enter", "进入通话：in_call + 边界 enter 落库");
  store.upsertVoiceMode("s1", { boundary: null, turns: 1 });
  v = store.getVoiceMode("s1");
  check(v.boundary === null && v.turns === 1 && v.inCall, "消费边界后：只清边界、不动 in_call/turns");
  check(v.thoughtBefore === "medium", "退出时要还原的原值还在（partial 写不覆盖）");
  store.upsertVoiceMode("s1", { inCall: false, boundary: "exit" });
  v = store.getVoiceMode("s1");
  check(!v.inCall && v.boundary === "exit" && v.turns === 1, "挂断：in_call 关掉、退出边界待发、轮数保留");
  store.upsertVoiceMode("s2", { inCall: true, boundary: null });
  check(store.listInCall().map((r) => r.sessionId).join(",") === "s2",
    "listInCall 只列真的在通话里的（挂断的不算）", store.listInCall().map((r) => r.sessionId).join(","));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

void REPO;
console.log(`\n[voice-mode] ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
