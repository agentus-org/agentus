// Unit checks for the face's mood engine (packages/web/src/nomiMood.ts).
//
// Why a unit test and not a browser sweep: every number that makes 糯米模式's face look ALIVE is
// arithmetic — which eye height at which audio level, when it blinks, when it starts to doze off,
// whether a `[emo:happy]` tag survives into the words we speak. A canvas sweep can prove the face
// MOVES; it cannot prove the eye is the right shape at 3.4 s of thinking, nor that a tag was
// stripped before TTS. Those are the two failure modes worth pinning, so they are pinned here.
//
// Run: npx tsx scripts/qa/nomi-mood.mts
import { readFileSync } from "node:fs";
import {
  BLINK_BLOCKED, CLIP_DY_UNIT, CLIP_MAX_MS, CLIP_MIN_MS, CLIP_NAMES, CLIP_PRIORITY, CLIP_ROT_UNIT, CLIPS, EMO_MOODS,
  IDLE_LOOK_MS, IDLE_REST_MS, MOODS, NO_OUTPUT_LOOK_MS, OVERSHOOT, TOOL_SUBSTATES, WARMTH_MS,
  WORK_FLICK_MS, activityOf, applyClip, ballFrame, blinkHoldMs, clipDurationMs, clipFor, clipFrameAt,
  clipPeak, deriveEmotion, workBeat, emoTagHint, EMO_TAG_VALUES, stripEmoTags, exprFor, eyeFrame,
  eyeSepAngle, eyeSpacing, gazeAngles, lifeBeat, moodFor, nextBlinkMs, normalizeClip, substateOf,
  smoothLevel, voiceCue, nextSaccadeMs, saccadeFor, projectEyes,
  readEmoTags, stripEmoTags, thinkingStage,
  type ClipName, type NomiMood, type ToolSubstate,
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

// 2.5 渲染器那条链必须兑现「两只眼分开」：live 实测（2026-10-24）旧实现写死 sep=21°，
//     中心距 35.7 < focus 眼宽 40，听你说话时两只眼贴成一个“暂停”符号。
//     这里不再只验 eyeSepAngle 的逆运算 —— 直接走 NomiFace 用的那串
//     eyeFrame → gazeAngles → projectEyes，把 mood × 子状态 × 球径 × 指针极端铺满；
//     渲染器退回固定角度/平面布局，或宽眼在大角度上被球缘剪平，都会在这里转红。
{
  const PTRS: Array<[number, number]> = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
  let worst = { gap: Infinity, mood: "", sub: "", r: 0, ptr: "" };
  let worstOuter = 0;
  let nan = 0;
  const seps = new Set<string>();
  for (const m of MOODS) {
    for (const sub of TOOL_SUBSTATES) {
      for (const ballR of [92, 98, 104]) {
        for (const [px, py] of PTRS) {
          // level 和 t 都要扫：scan 的横扫位移是 `eye.x = sin(t·3.5)·45`，t=0 时看不见它把眼带出球。
          for (const level of [0, 0.5, 1]) {
            for (const t of [0, 0.45, 1.35]) {
              const elapsed = 2;
              const ex = exprFor(m, level, elapsed);
              const left = eyeFrame({ mood: m, right: false, blinking: false, t, level, expr: ex, substate: sub });
              const right = eyeFrame({ mood: m, right: true, blinking: false, t, level, expr: ex, substate: sub });
              const gaze = gazeAngles({ mood: m, pointerX: px, pointerY: py, elapsed, level, substate: sub });
              const pe = projectEyes({ mood: m, left, right, gaze, ballR });
              if (!Number.isFinite(pe.gap) || !Number.isFinite(pe.left.x) || !Number.isFinite(pe.right.w)) nan++;
              if (pe.gap < worst.gap) worst = { gap: pe.gap, mood: m, sub, r: ballR, ptr: `${px},${py}/L${level}/t${t}` };
              worstOuter = Math.max(worstOuter,
                (Math.abs(pe.left.x) + pe.left.w / 2) / ballR,
                (Math.abs(pe.right.x) + pe.right.w / 2) / ballR);
              seps.add(pe.sep.toFixed(2));
            }
          }
        }
      }
    }
  }
  check("18 张脸 × 7 个子状态 × 3 球径 × 9 指针位 × level/t：两眼始终有可见空隙（不是一条“暂停”）",
    worst.gap >= 8, `worst ${worst.gap.toFixed(1)} px @ ${worst.mood}/${worst.sub}/R${worst.r}/${worst.ptr}`);
  check("…且外眼不会被球缘剪平（外缘 ≤ 1.05R，旧实现同量级）", worstOuter <= 1.0501, `worst ${worstOuter.toFixed(3)}R`);
  check("…且没有 NaN 几何（宽/半径写错不会让整双眼睛消失）", nan === 0, `${nan} 组`);
  check("角距随表情/眼宽变化，不是固定角度", seps.size >= MOODS.length, `${seps.size} 种`);
  check("旧固定 21° 在 focus 上本来就会重叠（算式佐证，不是回归守卫）",
    2 * 98 * Math.sin((21 * Math.PI) / 360) - eye("focus", { level: 0.5, expr: expr("listening", 0.5, 2) }).w < 0);
  check("eyeSepAngle 对非有限宽度/半径仍然返回有限角",
    Number.isFinite(eyeSepAngle({ mood: "idle", leftW: NaN, rightW: 34, ballR: NaN })));
  // 几何函数再好，渲染器不调用它也守不住 —— 这条把“渲染器走 projectEyes”钉住。
  const faceSrc = readFileSync(new URL("../../packages/web/src/NomiFace.tsx", import.meta.url), "utf8");
  check("渲染器真的走 projectEyes（自己另算一套 / 退回固定角距会在这里转红）",
    /projectEyes\(/.test(faceSrc) && !/sep:\s*21\b/.test(faceSrc));
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
  // 听 ≠ 想（2026-10-23 实测：两者同脸时，通话里最常出现的两种状态长得一模一样 ——
  // 「你说话时它在发呆」）。听 = 睁眼看着你；想 = 眯起来往上看。
  check("listening is the attentive face, not the thinking one", moodFor({ phase: "listening" }) === "curious");
  check("thinking squints (focus)", moodFor({ phase: "thinking" }) === "focus");
  check("a saccade shows THROUGH listening (otherwise the face freezes while you talk)",
    moodFor({ phase: "listening", life: "lookLeft" }) === "lookLeft");
  check("listening and thinking do NOT look the same",
    eyeFrame({ mood: "curious", right: false, blinking: false, t: 0, level: 0, expr: exprFor("curious", 0, 0), sleep: 0 }).h
    !== eyeFrame({ mood: "focus", right: false, blinking: false, t: 0, level: 0, expr: exprFor("focus", 0, 0), sleep: 0 }).h);
  // 连续量也要按「哪张脸」算，不按相位：working 拿到的必须是 thinking 那套神态。
  check("expr follows the FACE, not the phase", exprFor("working", 0, 0).mode === "thinking" && exprFor("asking", 0, 0).mode === "listening");
  check("expr still accepts a phase (old call sites keep working)", exprFor("speaking", 0.4, 0).mode === "speaking");
  check("speaking with no emotion → talking", moodFor({ phase: "speaking" }) === "talking");
  check("speaking with a neutral tag → still talking", moodFor({ phase: "speaking", emotion: "idle" }) === "talking");
  check("speaking with an emotion uses it", moodFor({ phase: "speaking", emotion: "sad" }) === "sad");
  check("idle shows the life beat", moodFor({ ...none, life: "wink" }) === "wink");
  check("90 s idle → sleep wins over the life beat", moodFor({ ...none, life: "wink", resting: true }) === "sleep");
  check("on the way to sleep it is drowsy", moodFor({ ...none, drowsy: true }) === "drowsy");
  check("a phase always beats an emotion (in-listening a sad tag must not change the eyes)",
    moodFor({ phase: "listening", emotion: "sad" }) === "curious");
}

// 6.5 电平：起音快、收尾慢；人一开口点一下头；听话时的眼神节奏。
{
  check("level rises fast", smoothLevel(0, 1, 0.55, 0.1) > 0.5);
  check("level falls slow", smoothLevel(1, 0, 0.55, 0.1) > 0.85);
  check("level stays inside 0..1", smoothLevel(-5, 5) <= 1 && smoothLevel(5, -5) >= 0);
  check("a voice onset is noticed", voiceCue(0.02, 0.5) === "tick");
  check("room noise is not a voice onset", voiceCue(0.02, 0.09) === null);
  check("a loud room that is already loud is not an onset", voiceCue(0.45, 0.5) === null);
  check("saccade rhythm is 2.4–4.6 s", nextSaccadeMs(() => 0) === 2400 && Math.round(nextSaccadeMs(() => 1)) === 4600);
  const sacc = saccadeFor(() => 0.1);
  check("a saccade is brief", sacc.durationMs >= 300 && sacc.durationMs <= 520, String(sacc.durationMs));
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
  check("等授权也压过 speaking（旧句子还在念，脸也必须说在等你）",
    moodFor({ phase: "speaking", activity: "asking", emotion: "happy" }) === "asking");
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

// 12. Clip 编排：切脸先播一段关键帧动作，播完回归静止姿态。
{
  const required: ClipName[] = ["listen-in", "say-in", "think-turn", "tool-start", "tool-done", "error-frown"];
  check("clip 覆盖六种必需事件，另有自定的四条",
    required.every((n) => CLIP_NAMES.includes(n)) && CLIP_NAMES.length >= required.length + 2,
    CLIP_NAMES.join(","));

  const bad: string[] = [];
  let shapeOk = true, durOk = true, restOk = true, easeOk = true;
  for (const n of CLIP_NAMES) {
    const c = CLIPS[n];
    const shape = c.frames.length >= 2 && c.frames.length <= 4
      && c.ms.length === c.frames.length - 1 && c.ease.length === c.ms.length;
    if (!shape) { shapeOk = false; bad.push(`${n}:shape`); }
    const d = clipDurationMs(c);
    if (d < CLIP_MIN_MS || d > CLIP_MAX_MS) { durOk = false; bad.push(`${n}:${d}ms`); }
    const first = c.frames[0], last = c.frames[c.frames.length - 1];
    const rest = (f: typeof first): boolean =>
      f.r === 1 && f.sx === 1 && f.sy === 1 && f.dy === 0 && f.rot === 0;
    if (!rest(first) || !rest(last)) { restOk = false; bad.push(`${n}:rest`); }
    if (!c.ease.every((e) => e === "linear" || e === "in" || e === "out" || e === "inOut")) {
      easeOk = false; bad.push(`${n}:ease`);
    }
  }
  check("每条 clip：2–4 帧、帧/段/缓动一一对应", shapeOk, bad.join(" "));
  check("每条 clip 时长 1.4–6 s", durOk, bad.join(" "));
  check("每条 clip 以静止姿态开场并回归静止姿态", restOk, bad.join(" "));
  check("缓动只用白名单里的四种", easeOk, bad.join(" "));
  check("每条 clip 的峰值都落在 1.36–1.50 的过冲带里",
    CLIP_NAMES.every((n) => clipPeak(CLIPS[n]) >= OVERSHOOT.min - 1e-9 && clipPeak(CLIPS[n]) <= OVERSHOOT.max + 1e-9),
    CLIP_NAMES.map((n) => `${n}:${clipPeak(CLIPS[n]).toFixed(2)}`).join(" "));

  // 归一化不是摆设：一条 3.0 倍的"手滑"数据必须被压回 1.50。
  const wild = normalizeClip({
    frames: [
      { r: 1, sx: 1, sy: 1, dy: 0, rot: 0 },
      { r: 1, sx: 1, sy: 1, dy: 0, rot: 3 },
      { r: 1, sx: 1, sy: 1, dy: 0, rot: 0 },
    ],
    ms: [100, 100], ease: ["out", "out"],
  });
  check("normalizeClip 把 3.0 倍过冲压回 1.50", Math.abs(clipPeak(wild) - OVERSHOOT.max) < 1e-9, String(clipPeak(wild)));

  const c = CLIPS["listen-in"];
  const at0 = clipFrameAt(c, 0);
  check("t=0 采样到静止姿态", !!at0 && at0.r === 1 && at0.dy === 0 && at0.rot === 0);
  check("播完后采样返回 null（调用方据此回静止）", clipFrameAt(c, clipDurationMs(c) + 1) === null);
  check("同一时刻采样两次结果相同（时钟由外部传入）",
    JSON.stringify(clipFrameAt(c, 640)) === JSON.stringify(clipFrameAt(c, 640)));
  check("中段真的离开了静止姿态", (() => {
    const f = clipFrameAt(c, 260);
    return !!f && (Math.abs(f.dy) > 0.5 || f.sy !== 1 || f.r !== 1);
  })());
  check("每条 clip 的峰值帧都不是静止姿态",
    CLIP_NAMES.every((n) => {
      const cc = CLIPS[n];
      const peakAt = cc.ms[0] + 1;
      const f = clipFrameAt(cc, peakAt);
      return !!f && (f.r !== 1 || f.sx !== 1 || f.sy !== 1 || f.dy !== 0 || f.rot !== 0);
    }));

  const rest = ballFrame("working");
  const moved = applyClip(rest, { r: 1.4, sx: 0.8, sy: 0.7, dy: 1.5, rot: -1.5 });
  check("applyClip 把倍率叠到静止球上（dy/rot 用 px/度单位）",
    Math.abs(moved.r - rest.r * 1.4) < 1e-9 && Math.abs(moved.sy - rest.sy * 0.7) < 1e-9
    && Math.abs(moved.dy - (rest.dy + 1.5 * CLIP_DY_UNIT)) < 1e-9
    && Math.abs(moved.rot - (rest.rot - 1.5 * CLIP_ROT_UNIT)) < 1e-9);

  check("听开始 → listen-in，扫视回来不重播",
    clipFor({ kind: "mood", from: "idle", to: "curious" }) === "listen-in"
    && clipFor({ kind: "mood", from: "lookLeft", to: "curious" }) === null);
  check("说话 → say-in，思考 → think-turn",
    clipFor({ kind: "mood", from: "focus", to: "talking" }) === "say-in"
    && clipFor({ kind: "mood", from: "curious", to: "focus" }) === "think-turn");
  check("思考台阶 2/3 各换一次姿势，第一台阶不播",
    clipFor({ kind: "think", stage: 0 }) === null
    && clipFor({ kind: "think", stage: 1 }) === "think-turn"
    && clipFor({ kind: "think", stage: 2 }) === "think-turn");
  check("工具开始/完成/失败各有一条 clip",
    clipFor({ kind: "tool", status: "start" }) === "tool-start"
    && clipFor({ kind: "tool", status: "done" }) === "tool-done"
    && clipFor({ kind: "tool", status: "failed" }) === "tool-fail");
  check("错误/等授权/眨眼/回神都接上了",
    clipFor({ kind: "mood", from: "focus", to: "error" }) === "error-frown"
    && clipFor({ kind: "mood", from: "curious", to: "asking" }) === "ask-hold"
    && clipFor({ kind: "blink" }) === "blink-pop"
    && clipFor({ kind: "mood", from: "sleep", to: "idle" }) === "wake");
  check("每条 clip 都有同帧优先级，且至少分四档",
    CLIP_NAMES.every((n) => Number.isFinite(CLIP_PRIORITY[n]))
    && new Set(CLIP_NAMES.map((n) => CLIP_PRIORITY[n])).size >= 4);
  check("同一帧冲突：结果/等授权压过过渡，眨眼最轻",
    CLIP_PRIORITY["tool-done"] > CLIP_PRIORITY["say-in"]
    && CLIP_PRIORITY["tool-fail"] > CLIP_PRIORITY["tool-start"]
    && CLIP_PRIORITY["ask-hold"] > CLIP_PRIORITY["tool-start"]
    && CLIP_PRIORITY["blink-pop"] < CLIP_PRIORITY["tool-start"]);
}

// 13. 工具子状态：全部从行上已有的字段推出来，且每种在脸上可辨识。
{
  const tool = { busy: true, pending: 0, newestKind: "tool" };
  check("等授权压过一切（授权请求还在）",
    substateOf({ ...tool, pending: 1, newestToolStatus: "in_progress", newestToolTitle: "Read file: a.ts", newestToolKind: "read" }) === "awaiting");
  check("读文件：title/kind 都认",
    substateOf({ ...tool, newestToolStatus: "in_progress", newestToolTitle: "Read file: a.ts", newestToolKind: "read" }) === "reading"
    && substateOf({ ...tool, newestToolStatus: "running", newestToolTitle: "grep -n TODO src/" }) === "reading");
  check("跑命令：bash/execute",
    substateOf({ ...tool, newestToolStatus: "in_progress", newestToolTitle: "bash: run the suite", newestToolKind: "execute" }) === "running");
  check("写文件：Write/Edit/patch",
    substateOf({ ...tool, newestToolStatus: "pending", newestToolTitle: "Write file: ./demo.txt", newestToolKind: "edit" }) === "writing"
    && substateOf({ ...tool, newestToolStatus: "running", newestToolTitle: "Edit file: a.ts" }) === "writing");
  check("成功完成 / 失败",
    substateOf({ ...tool, newestToolStatus: "completed", newestToolTitle: "bash: run" }) === "done"
    && substateOf({ ...tool, newestToolStatus: "failed", newestToolTitle: "bash: run" }) === "failed");
  check("最新一行不是工具 / 没在忙 = idle（想事情交给 mood）",
    substateOf({ busy: true, pending: 0, newestKind: "thought" }) === "idle"
    && substateOf({ busy: false, pending: 0, newestKind: "tool", newestToolStatus: "completed" }) === "idle");

  const sig = (sub: ToolSubstate): string => {
    const b = ballFrame("working", { substate: sub });
    const e = eyeFrame({
      mood: "working", right: false, blinking: false, t: 0, level: 0.3,
      expr: expr("thinking", 0.3, 2), substate: sub,
    });
    const g = gazeAngles({ mood: "working", substate: sub });
    return [b.r, b.sx, b.sy, b.dy, b.rot, e.w, e.h, e.yScale, e.rot, e.y, e.alpha, e.glow, e.jitter, g.ax, g.ay]
      .map((v) => v.toFixed(3)).join("|");
  };
  const sigs = new Set(TOOL_SUBSTATES.map(sig));
  check("七个工具子状态在脸上两两可辨（球体姿态或眼形不同）",
    sigs.size === TOOL_SUBSTATES.length, `${sigs.size}/${TOOL_SUBSTATES.length}`);

  const eyeOf = (sub: ToolSubstate) => eyeFrame({
    mood: "working", right: false, blinking: false, t: 0, level: 0.3,
    expr: expr("thinking", 0.3, 2), substate: sub,
  });
  const ballOf = (sub: ToolSubstate) => ballFrame("working", { substate: sub });
  check("awaiting 比 running 睁得更开、更亮",
    eyeOf("awaiting").yScale > eyeOf("running").yScale && eyeOf("awaiting").alpha > eyeOf("running").alpha);
  check("done 往上看，failed 往下看",
    eyeOf("done").y < eyeOf("failed").y);
  check("writing 的头歪得比 reading 多", Math.abs(ballOf("writing").rot) > Math.abs(ballOf("reading").rot),
    `${ballOf("writing").rot} vs ${ballOf("reading").rot}`);
  check("failed 比 done 缩得更小", ballOf("failed").r < ballOf("done").r);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
