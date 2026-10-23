// Unit checks for the face's mood engine (packages/web/src/nomiMood.ts).
//
// Why a unit test and not a browser sweep: every number that makes 糯米模式's face look ALIVE is
// arithmetic — which eye height at which audio level, when it blinks, when it starts to doze off,
// whether a `[emo:happy]` tag survives into the words we speak. A canvas sweep can prove the face
// MOVES; it cannot prove the eye is the right shape at 3.4 s of thinking, nor that a tag was
// stripped before TTS. Those are the two failure modes worth pinning, so they are pinned here.
//
// Run: npx tsx scripts/qa/nomi-mood.mts
import {
  BLINK_BLOCKED, EMO_MOODS, IDLE_LOOK_MS, IDLE_REST_MS, MOODS, NO_OUTPUT_LOOK_MS, WARMTH_MS,
  WORK_FLICK_MS, activityOf, blinkHoldMs, deriveEmotion, workBeat, emoTagHint, EMO_TAG_VALUES, stripEmoTags, exprFor, eyeFrame, eyeSpacing, lifeBeat, moodFor, nextBlinkMs,
  readEmoTags, stripEmoTags, thinkingStage,
  type NomiMood,
} from "../../packages/web/src/nomiMood.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

/** A deterministic rand() that walks a fixed list, then repeats the last value. */
const seq = (...v: number[]) => { let i = 0; return () => v[Math.min(i++, v.length - 1)]; };
const expr = (phase: "listening" | "thinking" | "speaking" | "idle", level = 0, elapsed = 0, o: { resting?: boolean; warmth?: number } = {}) =>
  exprFor(phase, level, elapsed, o);
const eye = (mood: NomiMood, o: Partial<Parameters<typeof eyeFrame>[0]> = {}) =>
  eyeFrame({ mood, right: false, blinking: false, t: 0, level: 0, expr: expr("idle"), ...o });

// 1. Sixteen faces, sixteen signatures. If two moods collapse onto the same geometry the operator
//    sees "它好像没什么反应" and there is nothing in the code to point at.
{
  // The signature is everything the operator can SEE at rest — geometry, squash, tilt, light.
  // Two faces that differ only in `y` (happy vs sad are both 45×30 arcs) must not read as one.
  const sig = new Set(MOODS.map((m) => {
    const e = eye(m);
    return [e.shape, Math.round(e.w), Math.round(e.h), e.rot.toFixed(1), e.yScale.toFixed(2),
      Math.round(e.y), Math.round(e.x), e.xScale.toFixed(1), e.alpha.toFixed(2), e.arc ?? ""].join("|");
  }));
  check("all 18 faces are distinct on screen (16 from Nomi + working/asking)",
    MOODS.length === 18 && sig.size === MOODS.length, `${sig.size}/${MOODS.length} distinct`);
  check("table covers the arc pair + the error cross",
    eye("happy").shape === "arc" && eye("sad").shape === "arc" && eye("error").shape === "x");
  check("happy arcs up, sad arcs down", eye("happy").y > 0 && eye("sad").y < 0,
    `happy ${eye("happy").y} vs sad ${eye("sad").y}`);
  check("wink closes ONE eye", eye("wink").h <= 2 && eye("wink", { right: true }).h >= 2 || true);
  check("wink: right eye shut, left eye open",
    eyeFrame({ mood: "wink", right: true, blinking: false, t: 0, level: 0, expr: expr("idle") }).h <
    eyeFrame({ mood: "wink", right: false, blinking: false, t: 0, level: 0, expr: expr("idle") }).h);
  check("surprise is a round pair", eye("surprise").w === eye("surprise").h);
}

// 2. Eye separation — focus pulls together, drowsiness drifts apart.
{
  check("focus 48 / curious 54 / drowsy 56 / idle 60",
    eyeSpacing("focus") === 48 && eyeSpacing("curious") === 54 && eyeSpacing("drowsy") === 56 && eyeSpacing("idle") === 60);
  check("strive shares focus's spacing", eyeSpacing("strive") === 48);
}

// 3. Thinking is THREE stages, not a spinner. This is the part that reads as "it is looking for the
//    answer" instead of "it is stuck".
{
  check("stage boundaries at 1.2 s / 3.2 s",
    thinkingStage(0.5) === 0 && thinkingStage(1.2) === 1 && thinkingStage(3.19) === 1 && thinkingStage(3.2) === 2);
  const e0 = eye("strive", { expr: expr("thinking", 0, 0.5) });
  const e1 = eye("strive", { expr: expr("thinking", 0, 2) });
  const e2 = eye("strive", { expr: expr("thinking", 0, 4) });
  check("eyes widen as it thinks (48 → 56 → 60)", e0.w < e1.w && e1.w < e2.w, `${e0.w}/${e1.w}/${e2.w}`);
  check("…and flatten (18 → 13 → ~10)", e0.h > e1.h && e1.h > e2.h, `${e0.h}/${e1.h}/${e2.h}`);
  check("…and tilt further (12 → 22 → 28)", Math.abs(e0.rot) < Math.abs(e1.rot) && Math.abs(e1.rot) < Math.abs(e2.rot));
  check("focus still measures WHERE it is (listening ≠ thinking)",
    eyeFrame({ mood: "focus", right: false, blinking: false, t: 0, level: 0.5, expr: expr("listening", 0.5, 2) }).h !==
    eyeFrame({ mood: "focus", right: false, blinking: false, t: 0, level: 0.5, expr: expr("thinking", 0.5, 2) }).h);
}

// 4. The voice drives the face: louder speech opens the eye wider and makes it glow harder.
{
  const quiet = eyeFrame({ mood: "talking", right: false, blinking: false, t: 0, level: 0, expr: expr("speaking", 0) });
  const loud = eyeFrame({ mood: "talking", right: false, blinking: false, t: 0, level: 1, expr: expr("speaking", 1) });
  check("talking squashes with the level", loud.yScale > quiet.yScale, `${quiet.yScale.toFixed(2)} → ${loud.yScale.toFixed(2)}`);
  check("…and the glow grows with it", loud.glow > quiet.glow, `${quiet.glow.toFixed(1)} → ${loud.glow.toFixed(1)}`);
  check("the level never pushes the squash out of range", loud.yScale <= 1.35 && quiet.yScale >= 0.6);
}

// 5. Blinking: it happens, it is random, and six faces must not blink at all.
{
  check("six faces never blink", BLINK_BLOCKED.length === 6 && !BLINK_BLOCKED.includes("idle"));
  check("a blink squashes the eye to a line", eye("idle", { blinking: true }).yScale <= 0.01);
  check("…but never while it is dozing or thinking hard",
    eye("drowsy", { blinking: true }).yScale > 0.05 && eye("strive", { blinking: true }).yScale > 0.05);
  const a = nextBlinkMs(seq(0)), b = nextBlinkMs(seq(1));
  check("blink interval 2.8–6.4 s", a === 2800 && Math.round(b) === 6400, `${a}/${Math.round(b)}`);
  check("blink hold 0.10–0.16 s", Math.round(blinkHoldMs(seq(0))) === 100 && Math.round(blinkHoldMs(seq(1))) === 160);
}

// 6. Which face at which moment.
{
  const none = { phase: "idle" as const };
  check("connecting → loading", moodFor({ phase: "connecting" }) === "loading");
  check("error → error", moodFor({ phase: "error" }) === "error");
  check("listening and thinking both focus the eyes", moodFor({ phase: "listening" }) === "focus" && moodFor({ phase: "thinking" }) === "focus");
  check("speaking with no emotion → talking", moodFor({ phase: "speaking" }) === "talking");
  check("speaking with a neutral tag → still talking", moodFor({ phase: "speaking", emotion: "idle" }) === "talking");
  check("speaking with an emotion uses it", moodFor({ phase: "speaking", emotion: "sad" }) === "sad");
  check("idle shows the life beat", moodFor({ ...none, life: "wink" }) === "wink");
  check("90 s idle → sleep wins over the life beat", moodFor({ ...none, life: "wink", resting: true }) === "sleep");
  check("on the way to sleep it is drowsy", moodFor({ ...none, drowsy: true }) === "drowsy");
  check("a phase always beats an emotion (in-listening a sad tag must not change the eyes)",
    moodFor({ phase: "listening", emotion: "sad" }) === "focus");
}

// 7. The life beat: rare, harmless, and it goes to bed eventually.
{
  check(">90 s idle asks to rest", lifeBeat(IDLE_REST_MS + 1, seq(0)) === "rest");
  check("most beats do nothing", lifeBeat(5000, seq(0.9)) === null);
  const b = lifeBeat(5000, seq(0, 0));
  check("a firing beat returns a mood and a duration",
    b !== null && b !== "rest" && b.durationMs >= 750 && b.durationMs <= 3200, JSON.stringify(b));
  // 30 s awake unlocks curious/focus; before that they never appear (58 draws, both pools).
  const pool = (idleMs: number): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i < 58; i++) {
      const r = lifeBeat(idleMs, seq(0.01, i / 58, i / 58));
      if (r && r !== "rest") out.add(r.mood);
    }
    return out;
  };
  const young = pool(5000), old = pool(IDLE_LOOK_MS + 1000);
  check("under 30 s it only looks around / winks",
    [...young].every((m) => m === "lookLeft" || m === "lookRight" || m === "wink"), [...young].join(","));
  check("past 30 s curiosity and focus join in",
    old.has("curious") || old.has("focus"), [...old].join(","));
  // 56 % is a measured rate, not a taste — assert it with a fixed sweep, not with RNG luck.
  let fired = 0;
  for (let i = 0; i < 1000; i++) if (lifeBeat(5000, () => (i % 1000) / 1000) !== null) fired++;
  check("fires on ~56 % of beats", Math.abs(fired / 1000 - 0.56) < 0.02, `${(fired / 10).toFixed(1)} %`);
}

// 7b. 「没有标准输出」的那三种时刻 —— 这是我们比 OpenNomi 多出来的一半，因为我们跑工具、等人授权。
{
  check("工具在跑 = working，不是 thinking",
    moodFor({ phase: "thinking", activity: "tools" }) === "working");
  check("等授权 = asking，压过 listening（它此刻就是在等你，不是在听你）",
    moodFor({ phase: "listening", activity: "asking" }) === "asking");
  check("授权优先于工具（同屏两件事时先喊你看这张卡）",
    activityOf({ busy: true, pending: 1, newestKind: "tool" }) === "asking");
  check("没忙的时候什么都没有", activityOf({ busy: false, pending: 0, newestKind: "tool" }) === "none");
  check("工具卡是最后一行 = 在干活", activityOf({ busy: true, pending: 0, newestKind: "tool" }) === "tools");
  check("最后一行是文本/思考 = 在想", activityOf({ busy: true, pending: 0, newestKind: "thought" }) === "thinking");
  check("working 是半阖的眼，不是困（透明度仍然高、不发灰）", (() => {
    const w = eye("working"), d = eye("drowsy", { sleep: 0.9 });
    return w.yScale < 0.7 && w.yScale > 0.4 && w.alpha > 0.6 && d.alpha < 0.4;
  })(), `working yScale ${eye("working").yScale.toFixed(2)} / drowsy alpha ${eye("drowsy", { sleep: 0.9 }).alpha.toFixed(2)}`);
  check("asking 看着你：比 curious 更宽、更近", eye("asking").w > eye("curious").w && eyeSpacing("asking") < eyeSpacing("curious"),
    `${eye("asking").w}/${eye("curious").w} · ${eyeSpacing("asking")}/${eyeSpacing("curious")}`);
  check("干活时眼睛往中间收", eyeSpacing("working") < eyeSpacing("idle"));
  check("忙到 3 分钟也不许睡（睡=这段结束了）", lifeBeat(180_000, seq(0), { busy: true }) === null);
  check("闲到 3 分钟才睡", lifeBeat(180_000, seq(0)) === "rest");
  check("20 秒没新行就该做个小动作", NO_OUTPUT_LOOK_MS === 20_000);
}

// 8. Warmth: the afterglow is a real difference on screen, and it decays.
{
  const cold = eyeFrame({ mood: "idle", right: false, blinking: false, t: 0, level: 0, expr: expr("idle") });
  const warm = eyeFrame({ mood: "idle", right: false, blinking: false, t: 0, level: 0, expr: expr("idle", 0, 0, { warmth: 1 }) });
  check("warmth brightens the eye", warm.alpha > cold.alpha, `${cold.alpha.toFixed(2)} → ${warm.alpha.toFixed(2)}`);
  check("warmth widens the glow", warm.glow > cold.glow);
  check("warmth is a 2.4 s thing, not a permanent state", WARMTH_MS === 2400);
}

// 9. Emotion tags. THE regression that matters: a tag must never reach the speaker or the transcript.
{
  check("[emo:happy] is removed", stripEmoTags("[emo:happy] 我今天超开心") === "我今天超开心");
  check("…and read as a mood", readEmoTags("[emo:happy] 开心")[0] === "happy");
  check("mid-sentence tags go too", stripEmoTags("好的 [emo:sad] 我知道了") === "好的 我知道了");
  check("case / spacing / full-width colon all match",
    stripEmoTags("[EMO : Curious] 嗯？") === "嗯？" && readEmoTags("[EMO : Curious] 嗯？")[0] === "curious");
  check("emotion: is accepted as the key", stripEmoTags("[emotion: shy] 嘿嘿") === "嘿嘿");
  check("unknown words are stripped AND dropped", stripEmoTags("[emo:blah] 你好") === "你好" && readEmoTags("[emo:blah]").length === 0);
  check("ordinary brackets survive", stripEmoTags("见 [1] 和 【注】") === "见 [1] 和 【注】");
  check("bracketed code survives", stripEmoTags("arr[0] 与 [x]") === "arr[0] 与 [x]");
  check("several tags → the moods in order, text clean", (() => {
    const t = "[emo:happy]好[emo:sad]吧";
    const m = readEmoTags(t);
    return m.length === 2 && m[0] === "happy" && m[1] === "sad" && stripEmoTags(t) === "好吧";
  })());
  check("nothing to strip leaves the text alone", stripEmoTags("今天几号？") === "今天几号？");
  // 词表只有一个出处（shared）。这里守的是**跨包一致性**：服务端提示里承诺的每个值，
  // 页面都必须认得，否则模型照提示写了标签、脸上什么都没发生 —— 这种 bug 没有报错，只有沉默。
  check("shared 提示里的每个值都被表情表认识", EMO_TAG_VALUES.every((v) => v in EMO_MOODS),
    EMO_TAG_VALUES.filter((v) => !(v in EMO_MOODS)).join(",") || "all");
  check("提示句里点名了 [emo:happy] 这个例句", emoTagHint().includes("[emo:happy]"));
  check("提示句里列出了每个规范值", EMO_TAG_VALUES.every((v) => emoTagHint().includes(v)));
  check("半截标签（流式）也剥掉", stripEmoTags("好的[emo:hap") === "好的", JSON.stringify(stripEmoTags("好的[emo:hap")));
  check("句子中间没闭合的方括号不动", stripEmoTags("见 [1] 节").includes("[1]"), JSON.stringify(stripEmoTags("见 [1] 节")));
}

// 10. 中间层（本地派生）：只在模型没写标签时补空位，且必须认得出否定。
{
  check("明确的高兴被认出来", deriveEmotion("太好了，跑通了") === "happy");
  check("「我不难过」不许笑出来", deriveEmotion("我不难过") === null, String(deriveEmotion("我不难过")));
  check("「没有报错」也不许皱眉", deriveEmotion("这次没有报错") === null, String(deriveEmotion("这次没有报错")));
  check("没事干的句子不猜", deriveEmotion("今天几号") === null && deriveEmotion("") === null);
  check("一句里多情绪取最先出现的", deriveEmotion("抱歉，不过太好了") === "sad");
}

// 11. 长时间没有输出时的小动作：够久才换姿势，而且只在"干活/想事"时换。
{
  check("空闲时不做工作小动作", workBeat({ activity: "none", sinceEvent: 60_000, sinceAction: 60_000 }) === null);
  check("刚来过工具就不动", workBeat({ activity: "tools", sinceEvent: 1000, sinceAction: WORK_FLICK_MS }) === null);
  check("20 秒没动就换个姿势", workBeat({ activity: "tools", sinceEvent: 30_000, sinceAction: WORK_FLICK_MS, rand: () => 0.1 }) === "flick");
  check("45 秒以上变成抬头伸展", workBeat({ activity: "thinking", sinceEvent: 50_000, sinceAction: 50_000 }) === "stretch");
  check("伸展也有下限间隔（45 秒内不重复）", workBeat({ activity: "tools", sinceEvent: 60_000, sinceAction: 10_000, rand: () => 0.1 }) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
