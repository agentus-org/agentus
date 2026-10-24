// Tus 模式的脸 —— 一块 canvas，两只眼睛，和一套会被声音点亮的数字。
//
// WHY A CANVAS AND NOT DOM. 60 fps 的形状/光晕/抖动，如果走 React state 就是每秒 60 次渲染一整个
// 会话页。这里沿用 `CallMode` 画 orb 的那套读法：**帧循环只读 ref**，React 只负责告诉它「相位变了」
// 「来了一条工具」；电平也是每次进来取一次（`getLevel()`），不经过 state。
//
// 几何与情绪表在 `tusMood.ts`（纯函数、有单测）；这个文件只做「把数字画出来」：
//   · 眼睛 = capsule（圆角矩形，圆角取短边一半），happy/sad 换成弧线，error 换成 ✕；
//   · 三个 continuous 量决定形状：attention 管眼宽、energy 管亮度、warmth 管说完之后的余温；
//   · 会呼吸（2 s ±6 px）、会眨眼（2.8–6.4 s 随机）、会走神（每 6 s 56 %）、会犯困（90 s）；
//   · 会低头干活（working）、会抬眼等你（asking）—— 这两张 OpenNomi 没有，是我们自己的，因为
//     我们的 agent 会跑工具、会停下来等人授权，这些时候一个字都不输出，而且往往以分钟计。
import { useEffect, useRef } from "react";
import type { CallPhase } from "./CallMode";
import {
  BLINK_BLOCKED, BLINK_MS, CLIP_PRIORITY, CLIPS, LIFE_BEAT_MS, NO_OUTPUT_LOOK_MS, SLEEP_TRANSITION_MS,
  WAKE_MS, WARMTH_MS, WORK_FLICK_MS, WORK_STRETCH_MS, applyClip, blinkClosureAt, clipDurationMs,
  clipFor, clipFrameAt, exprFor, eyeFrame,
  lifeBeat, moodFor, nextBlinkMs, nextSaccadeMs, saccadeFor, smoothLevel, thinkingStage,
  voiceCue, ballFrame, springStep, gazeAngles, projectEyes,
  type AgentActivity, type ClipName, type MicroAction, type TusMood, type ToolSubstate,
} from "./tusMood";

export interface TusFaceProps {
  phase: CallPhase;
  /** 这一轮 agent 在干嘛（工具 / 等授权 / 想）—— 比相位更细，见 `activityOf`。 */
  activity: AgentActivity;
  /** 工具执行的可观测子状态（读/跑/写/等/完成/失败）—— 五官在 working 脸上再分一层。 */
  substate?: ToolSubstate;
  /** 这一句的情绪（标签优先、本地派生兜底），null = 没有。 */
  emotion?: TusMood | null;
  /** 单调递增的工具帧计数：一变就点一下头（"手上有活"）并播 tool-start。 */
  ticks?: number;
  /** 最后一个工具行的 status：终态变化时播 tool-done / tool-fail。 */
  toolStatus?: string;
  /** 实时电平 0..1（说话时是播放，听的时候是麦克风）。每帧取一次，不进 state。 */
  getLevel: () => number;
  /** 解析后的那张脸（不是相位）。给页面留一个可观测钩子：canvas 像素只能证明「在动」。 */
  onMood?: (mood: TusMood) => void;
}

/** 一帧里所有会衰减的东西。全部放进 ref：它们只在帧循环里读写。 */
interface Mutable {
  /** 上一帧的相位：变了就重置 "这一段想了多久"（thinkingStage 的台阶靠它）。 */
  phase: CallPhase | "idle";
  life: TusMood | null;
  lifeUntil: number;
  nextBlinkAt: number;
  /** 这一眨的起点（0.26 s 包络从它往外算）。 */
  blinkAt: number;
  nextBeatAt: number;
  nextActionAt: number;
  resting: boolean;
  drowsy: boolean;
  sleep: number;
  sleepTarget: number;
  phaseAt: number;
  warmthUntil: number;
  lastEventAt: number;
  /** Last REAL event (a tool frame, a phase change) — saccades do not count. */
  quietSince: number;
  micro: MicroAction | null;
  microAt: number;
  microUntil: number;
  mood: TusMood;
  moodAt: number;
  ticks: number;
  /** 最后一个工具行的 status（终态变化 → 播完成/失败 clip）。 */
  toolStatus: string;
  /** 正在播的短 clip 与它的起点/时长。null = 停在当前 mood 的静止姿态上。 */
  clip: ClipName | null;
  clipAt: number;
  clipMs: number;
  /** 上一次的思考台阶：1→2、2→3 各播一次 think-turn。 */
  thinkStage: number;
  /** 平滑后的电平（画眼睛用的就是它）。 */
  level: number;
  /** 这一帧拿到的原始电平，用来判「人刚开口」。 */
  rawLevel: number;
  /** 下一次「扫一眼／偏一下」的时刻（只在 listening 里走）。 */
  nextSaccadeAt: number;
  /** 球体（本体）的弹簧状态：半径 + 两个方向的缩放 + 垂直偏移，各自一条弹簧。 */
  ball: { r: number; sx: number; sy: number; dy: number };
  ballV: { r: number; sx: number; sy: number; dy: number };
  /** 球的倾角（度）与角速度 —— 也走弹簧，歪头才有惯性。 */
  ballRot: number;
  ballRotV: number;
  /** 授权请求是这一刻挂上的；0 = 现在没有挂起的请求（120 s 后脸会转 drowsy）。 */
  askingSince: number;
  /** 从困/睡里被叫醒的「惊一下」到什么时候（Grok 的 waking，1.6 s）。 */
  wakeUntil: number;
  /** 三点 morph 的权重 0..1：1 = 只剩三个点（官方 thinking → dots），0 = 完整一张脸。 */
  dots: number;
}

const fresh = (now: number): Mutable => ({
  phase: "idle",
  life: null, lifeUntil: 0, nextBlinkAt: now + nextBlinkMs(), blinkAt: now - BLINK_MS,
  nextBeatAt: now + LIFE_BEAT_MS, nextActionAt: now + WORK_FLICK_MS,
  resting: false, drowsy: false, sleep: 0, sleepTarget: 0,
  phaseAt: now, warmthUntil: 0, lastEventAt: now, quietSince: now,
  micro: null, microAt: 0, microUntil: 0,
  mood: "idle", moodAt: now, ticks: 0, level: 0, rawLevel: 0,
  toolStatus: "", clip: null, clipAt: 0, clipMs: 0, thinkStage: 0,
  nextSaccadeAt: now + 900,
  ball: { r: 98, sx: 1, sy: 1, dy: 0 },
  ballV: { r: 0, sx: 0, sy: 0, dy: 0 },
  ballRot: 0, ballRotV: 0,
  askingSince: 0, wakeUntil: 0, dots: 0,
});

export function TusFace({ phase, activity, substate = "idle", emotion = null, ticks = 0, toolStatus = "", getLevel, onMood }: TusFaceProps): JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const props = useRef({ phase, activity, substate, emotion, ticks, toolStatus });
  props.current = { phase, activity, substate, emotion, ticks, toolStatus };
  const levelOf = useRef(getLevel);
  levelOf.current = getLevel;
  const moodOf = useRef(onMood);
  moodOf.current = onMood;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const g = canvas.getContext("2d");
    if (!g) return;
    /** A phone with a 3× screen does not need 3× of a soft glowing shape; 1.5 is indistinguishable. */
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const st = fresh(performance.now());
    // 挂载时就把计数/状态对齐：历史里已有的工具行不是"刚刚发生"的事件，不该在开场播动作。
    st.ticks = props.current.ticks;
    st.toolStatus = props.current.toolStatus;
    // 新动作直接顶掉旧动作：切脸和工具事件永远比上一段动作新。**同一帧**里两条同时触发时
    // 按 CLIP_PRIORITY 决定谁留下（"结果"压过"过渡"，眨眼永远让路），否则谁后写谁赢，
    // 授权答复那一刻的 tool-done 就会被 say-in 吞掉。
    const startClip = (name: ClipName, at: number): void => {
      if (st.clip && st.clipAt === at && CLIP_PRIORITY[name] < CLIP_PRIORITY[st.clip]) return;
      st.clip = name;
      st.clipAt = at;
      st.clipMs = clipDurationMs(CLIPS[name]);
    };
    let raf = 0;
    let lastPaint = 0;

    const size = (): void => {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(canvas);

    const draw = (ms: number): void => {
      raf = window.requestAnimationFrame(draw);
      // 30 fps：这块画面全是柔光与缓慢位移，翻倍帧率看不出差别，手机却会热。
      if (ms - lastPaint < 33) return;
      lastPaint = ms;
      const t = ms / 1000;
      const p = props.current;
      // 电平：先平滑（起音快、收尾慢），再判「人刚开口」—— 那一帧点一下头，等于「我听见了」。
      st.rawLevel = Math.max(0, Math.min(1, levelOf.current() || 0));
      const before = st.level;
      st.level = smoothLevel(st.level, st.rawLevel);
      const cue = voiceCue(before, st.level);
      if (cue && p.phase === "listening") {
        st.micro = cue;
        st.microAt = ms;
        st.microUntil = ms + 280;
        st.quietSince = ms;          // someone is talking to it — never doze off mid-conversation
      }

      // ── 事件：新工具帧 = 点一下头；相位变了 = 记时间 + 说完的余温 ──────────────────────
      if (p.phase !== st.phase) {
        st.phase = p.phase;
        st.phaseAt = ms;
        st.quietSince = ms;          // a phase change is a real event: it is not "quiet"
      }
      if (st.micro && st.microAt === ms) st.quietSince = ms;
      if (p.ticks !== st.ticks) {
        st.ticks = p.ticks;
        st.lastEventAt = ms;
        st.quietSince = ms;
        st.micro = "tick";
        st.microAt = ms;
        st.microUntil = ms + 260;
        startClip("tool-start", ms);
      }
      // 最后一个工具行的 status 变了：完成 → 弹一下；失败 → 沉一下。终态是"结果"，
      // 它值得一个动作，而不只是卡片上的点变个颜色。
      if (p.toolStatus !== st.toolStatus) {
        const s = p.toolStatus.toLowerCase();
        st.toolStatus = p.toolStatus;
        if (s === "completed" || s === "success") startClip("tool-done", ms);
        else if (s === "failed" || s === "error" || s === "cancelled") startClip("tool-fail", ms);
        else if (s) startClip("tool-start", ms);
      }
      // ── 生命感：眨眼、走神、犯困 ────────────────────────────────────────────────────
      const busy = p.activity !== "none" || p.phase === "thinking" || p.phase === "speaking";
      if (ms >= st.nextBlinkAt) {
        st.nextBlinkAt = ms + nextBlinkMs();
        if (!BLINK_BLOCKED.includes(st.mood)) {
          st.blinkAt = ms;   // 0.26 s 的闭合/保持/睁开包络从这里往外算
          // 眨眼自己的球体动作很轻，别打断正在播的切脸/工具 clip。
          if (!st.clip) startClip("blink-pop", ms);
        }
      }
      if (ms >= st.nextBeatAt) {
        st.nextBeatAt = ms + LIFE_BEAT_MS;
        const b = lifeBeat(ms - st.quietSince, Math.random, { busy });
        if (b === "rest") {
          st.drowsy = true;
          st.sleepTarget = 1;
        } else if (b) {
          st.life = b.mood;
          st.lifeUntil = ms + b.durationMs;
        }
      }
      // 听你说话的时侯别只剩呼吸：每 2.4–4.6 s 扫一眼／偏一下／眨个眼（300–520 ms）。
      // 这条节奏是「活的」和「一张图」之间最便宜的分界，比呼吸幅度好认。
      if (p.phase === "listening" && ms >= st.nextSaccadeAt) {
        st.nextSaccadeAt = ms + nextSaccadeMs();
        if (!st.life) {
          const s2 = saccadeFor();
          st.life = s2.mood;
          st.lifeUntil = ms + s2.durationMs;
          st.lastEventAt = ms;
        }
      }
      if (st.life && ms > st.lifeUntil) st.life = null;
      if (st.drowsy && st.sleepTarget > 0 && st.sleep >= 0.995) {
        st.drowsy = false;
        st.resting = true;
      }
      st.sleep += Math.max(-1, Math.min(1, (st.sleepTarget - st.sleep) * 0.06));
      if ((st.resting || st.drowsy) && busy) {
        // 被叫醒不是瞬切：头 1.6 s 先「惊一下」（Grok 的 waking = surprised → idle），
        // 同时眼睛慢慢睁开（sleepTarget 归零后 sleep 自己衰减）。伸懒腰的 clip 同帧起播。
        st.resting = false;
        st.drowsy = false;
        st.sleepTarget = 0;
        st.wakeUntil = ms + WAKE_MS;
        startClip("wake", ms);
      }
      // 授权请求挂了多久（脸在 120 s 后会从「等你」转「走神」，见 ASKING_DOZE_MS）。
      if (p.activity === "asking") {
        if (!st.askingSince) st.askingSince = ms;
      } else {
        st.askingSince = 0;
      }

      // ── 「没有输出」太久：换个小姿势，别让一张脸盯成死机 ────────────────────────────
      const sinceEvent = ms - st.lastEventAt;
      if (busy && sinceEvent > NO_OUTPUT_LOOK_MS && ms - st.microAt > WORK_FLICK_MS) {
        const pick: MicroAction = sinceEvent > WORK_STRETCH_MS ? "stretch" : (Math.random() < 0.7 ? "flick" : "tick");
        st.micro = pick;
        st.microAt = ms;
        st.microUntil = ms + (pick === "stretch" ? 1400 : 420);
      }
      if (st.micro && ms > st.microUntil) st.micro = null;

      // ── 表情：相位 + 活动 + 情绪，三层叠出来 ────────────────────────────────────────
      const mood = moodFor({
        phase: p.phase,
        activity: p.activity,
        emotion: p.emotion,
        life: st.life,
        resting: st.resting,
        drowsy: st.drowsy,
        waking: ms < st.wakeUntil,
        askingMs: st.askingSince ? ms - st.askingSince : 0,
      });
      if (mood !== st.mood) {
        const clip = clipFor({ kind: "mood", from: st.mood, to: mood });
        st.moodAt = ms;
        try { moodOf.current?.(mood); } catch { /* 可选钩子，绝不打断帧循环 */ }
        if (mood !== "sleep" && (st.resting || st.drowsy)) { st.resting = false; st.drowsy = false; st.sleepTarget = 0; st.sleep = 0; }
        // 说完之后那 2.4 秒的余温：mood 从 talking 回到 idle/focus 时点亮。
        if (p.phase !== "speaking") st.warmthUntil = ms + WARMTH_MS;
        st.mood = mood;
        if (clip) startClip(clip, ms);
      }
      // 官方 thinking 不是一张脸，是三点的 morph（grok-recipes: thinking → morph "dots"，
      // dotsGap 62 / dotsStagger 0.12 / liftPeriodMs 1400）。球和眼睛让位，只剩中点大、
      // 两侧小的三点错开上下浮。0.2 s 淡入淡出，不硬切；球体弹簧照常跑，退出时脸从
      // "正在呼吸的位置"接回来，不会跳一下。
      const wantDots = p.phase === "thinking" && mood === "focus" ? 1 : 0;
      st.dots += (wantDots - st.dots) * 0.14;
      if (st.dots < 0.002) st.dots = 0;
      else if (st.dots > 0.998) st.dots = 1;
      const warmth = Math.max(0, Math.min(1, (st.warmthUntil - ms) / WARMTH_MS));
      const elapsed = (ms - st.phaseAt) / 1000;
      const expr = exprFor(mood, st.level, elapsed, {
        resting: st.resting, warmth,
      });
      // 想事情的三个台阶（1.2 s / 3.2 s）每上一个都换个姿势 —— 光靠眼形变窄，
      // 在通话那种小窗里看不出来。
      const stage = thinkingStage(elapsed);
      if (stage !== st.thinkStage) {
        st.thinkStage = stage;
        if (mood === "focus") {
          const c = clipFor({ kind: "think", stage });
          if (c) startClip(c, ms);
        }
      }

      const blink = blinkClosureAt(ms - st.blinkAt);
      const left = eyeFrame({ mood, right: false, blink, t, level: st.level, expr, sleep: st.sleep, substate: p.substate });
      const right = eyeFrame({ mood, right: true, blink, t, level: st.level, expr, sleep: st.sleep, substate: p.substate });

      // ── 画 ───────────────────────────────────────────────────────────────────────
      const W = canvas.width, H = canvas.height;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, W, H);
      g.scale(dpr, dpr);
      const w = W / dpr, h = H / dpr;
      // ── 球（本体）────────────────────────────────────────────────────────────────
      // 比例尺：球半径 ≈ 98 逻辑单位（和 tusMood.ballFrame 的基准一致），整块高度装得下球
      // 加上一圈留白；眼睛按同一个比例尺缩放，所以球变大时眼睛跟着变，不会「球大眼小」。
      const k = Math.max(0.5, Math.min(3.2, Math.min(w / 260, h / 260)));
      let target = ballFrame(mood, {
        level: st.level,
        breath: ["idle", "drowsy", "sleep", "curious", "asking", "working"].includes(mood)
          ? Math.sin((t * Math.PI * 2) / 2) * 6 : 0,
        sleep: st.sleep,
        substate: p.substate,
      });
      // 正在播的 clip 叠在静止姿态上；播完（或越界）就回到静止值，弹簧负责把最后一下收住。
      if (st.clip) {
        if (ms - st.clipAt >= st.clipMs) st.clip = null;
        else {
          const cf = clipFrameAt(CLIPS[st.clip], ms - st.clipAt);
          if (cf) target = applyClip(target, cf);
          else st.clip = null;
        }
      }
      // 给 e2e/操作者留两个可读的事实：此刻哪张脸、哪个子状态、在播哪条 clip。
      // 只写 canvas 的 dataset（不进 React state），每帧一次字符串比较，成本可以忽略。
      const clipNow = st.clip ?? "";
      if (canvas.dataset.clip !== clipNow) {
        if (clipNow) canvas.dataset.clip = clipNow;
        else delete canvas.dataset.clip;
      }
      if (canvas.dataset.substate !== p.substate) canvas.dataset.substate = p.substate;
      // 给 e2e 一个可读信号：此刻是不是三点 morph（脸已经淡出）。像素判据只能证明"在动"。
      const dotsNow = st.dots >= 0.5 ? "1" : "";
      if ((canvas.dataset.dots ?? "") !== dotsNow) {
        if (dotsNow) canvas.dataset.dots = dotsNow;
        else delete canvas.dataset.dots;
      }
      // 弹簧跑 120 Hz（和原引擎同一个积分步长），一个 30 fps 帧里补 4 步 —— 帧率掉到 15 也不会散。
      for (let i = 0; i < 4; i++) {
        const dt = 1 / 120;
        const sr = springStep(st.ball.r, st.ballV.r, target.r, dt, 22, 0.6);
        st.ball.r = sr.x; st.ballV.r = sr.v;
        const sx = springStep(st.ball.sx, st.ballV.sx, target.sx, dt, 30, 0.5);
        st.ball.sx = sx.x; st.ballV.sx = sx.v;
        const sy = springStep(st.ball.sy, st.ballV.sy, target.sy, dt, 30, 0.5);
        st.ball.sy = sy.x; st.ballV.sy = sy.v;
        const dy = springStep(st.ball.dy, st.ballV.dy, target.dy, dt, 24, 0.62);
        st.ball.dy = dy.x; st.ballV.dy = dy.v;
        const rt = springStep(st.ballRot, st.ballRotV, target.rot, dt, 18, 0.5);
        st.ballRot = rt.x; st.ballRotV = rt.v;
      }
      const R = st.ball.r * k;
      const cx = w / 2;
      const cy = h / 2 + st.ball.dy * k;

      // 呼吸：只在「不紧绷」的脸上升降（2 s 一个来回，±6）。
      const breathe = ["idle", "drowsy", "sleep", "curious", "asking", "working", "calm"].includes(mood)
        ? Math.sin((t * Math.PI * 2) / 2) * 6 * k : 0;
      // 微动作：低头干活的三种小姿势。
      let mx = 0, my = 0;
      if (st.micro === "tick") my = 2.5 * k;
      else if (st.micro === "flick") { mx = 4 * k; my = 1.5 * k; }
      else if (st.micro === "stretch") my = -5 * k;

      // 相位脉冲：换脸时轻轻放大一下，让"它注意到你了"有分量。
      const pulseAge = ms - st.moodAt;
      const pulse = pulseAge < 260 ? 1 + 0.045 * (1 - pulseAge / 260) : 1;

      // ── 球本体：深色，左上柔光 ──────────────────────────────────────────────────
      // 「伪 3D 的光泽来自 fill，而不是几何」（grokbot 解剖的 Glow Lab 结论）：一个径向渐变就够，
      // 不需要三层模糊、不需要阴影贴图。底部再垫一层很淡的接触阴影，让它看起来"坐"在背景上。
      g.save();
      g.globalAlpha = 1 - st.dots;
      g.translate(cx, cy);
      g.rotate((st.ballRot * Math.PI) / 180);
      g.scale(st.ball.sx, st.ball.sy);
      g.beginPath();
      g.arc(0, 0, R, 0, Math.PI * 2);
      g.shadowColor = "rgba(15,20,26,0.30)";
      g.shadowBlur = 30 * k;
      g.shadowOffsetY = 12 * k;
      const bg = g.createRadialGradient(-R * 0.32, -R * 0.42, R * 0.06, 0, 0, R * 1.02);
      bg.addColorStop(0, "#31383f");
      bg.addColorStop(0.52, "#171b20");
      bg.addColorStop(1, "#0a0c0f");
      g.fillStyle = bg;
      g.fill();
      g.shadowBlur = 0;
      g.shadowOffsetY = 0;
      // 顶缘一圈极淡的高光：没有它，球在浅色背景上会读成"一块平的圆片"。
      g.strokeStyle = "rgba(255,255,255,0.12)";
      g.lineWidth = Math.max(1, 1.6 * k);
      g.stroke();
      g.restore();

      // 眼睛剪进球里：这样眨眼/眯眼/偏移都不会把白块甩到球外（原引擎同样把眼睛画在球内）。
      g.save();
      g.translate(cx, cy);
      g.rotate((st.ballRot * Math.PI) / 180);
      g.beginPath();
      g.ellipse(0, 0, R * st.ball.sx, R * st.ball.sy, 0, 0, Math.PI * 2);
      g.clip();
      g.translate(-cx, -cy);

      // 视点：情绪决定眼睛往哪看；投影到球面上（正交），越往侧越窄。
      // 两眼的位置/宽度统一由 `projectEyes` 给出（和单测同一套算式），这里只负责画。
      const gaze = gazeAngles({ mood, elapsed, level: st.level, substate: p.substate });
      const pe = projectEyes({ mood, left, right, gaze, ballR: st.ball.r, k });
      for (const eye of [left, right]) {
        const side: -1 | 1 = eye === right ? 1 : -1;
        const se = side === 1 ? pe.right : pe.left;
        // 投影出的眼心 + 情绪自己那点水平偏移已经在 `projectEyes` 里算过
        const ex = cx + se.x + mx;
        const ey = cy + se.y + breathe * 0.4 + my;
        g.save();
        g.translate(ex, ey);
        g.rotate((eye.rot * Math.PI) / 180);
        g.globalAlpha = Math.max(0, Math.min(1, eye.alpha)) * (1 - st.dots);
        const tone = mood === "error" ? "248,113,113" : mood === "sad" ? "190,190,200" : "255,255,255";
        g.shadowColor = `rgba(${tone},${Math.min(0.5, 0.16 + st.level * 0.2 + warmth * 0.14)})`;
        // 光晕不能盖过形状：模糊半径收到眼睛短边的 45% 以内，否则放大之后只剩两团发白的光
        // （实测：77px 的眼睛配 34px 模糊，读起来是两颗蛋，不是一双眼睛）。
        g.shadowBlur = Math.min(eye.w * k * 0.45, eye.glow * k);
        g.fillStyle = `rgba(${tone},1)`;
        g.strokeStyle = `rgba(${tone},1)`;

        if (eye.shape === "x") {
          const s = se.w / 2;
          const j = Math.sin(t * 24) * eye.jitter * k;
          g.lineWidth = 6 * k;
          g.beginPath();
          g.moveTo(-s + j, -s); g.lineTo(s + j, s);
          g.moveTo(s + j, -s); g.lineTo(-s + j, s);
          g.stroke();
        } else if (eye.shape === "arc") {
          // 开心朝上、难过朝下：一条半圆，线宽 6。
          const r = se.w / 2;
          g.lineWidth = 6 * k;
          g.beginPath();
          if (eye.arc === "happy") g.arc(0, r, r, Math.PI, Math.PI * 2);
          else g.arc(0, -r, r, 0, Math.PI);
          g.stroke();
        } else {
          const ew = se.w;
          const eh = Math.max(1, eye.h * k * eye.yScale);
          const rad = Math.min(ew, eh) / 2;
          const jx = eye.jitter ? Math.sin(t * 24) * eye.jitter * k : 0;
          const jy = eye.jitter ? Math.cos(t * 19) * eye.jitter * k : 0;
          // 上亮下略暗的竖向渐变：球形感来自这里（纯平涂的白块没有"眼珠"的立体）。
          // 眼球不是一块平涂白：上缘亮、下缘略暗（0.94 而不是 0.78 —— 压在浅底上 0.78 会读成灰）
          const grad = g.createLinearGradient(0, -eh / 2, 0, eh / 2);
          grad.addColorStop(0, `rgba(${tone},1)`);
          grad.addColorStop(1, `rgba(${tone},0.94)`);
          g.fillStyle = grad;
          g.beginPath();
          if (typeof g.roundRect === "function") g.roundRect(-ew / 2 + jx, -eh / 2 + jy, ew, eh, rad);
          else g.ellipse(0, 0, ew / 2, eh / 2, 0, 0, Math.PI * 2);
          g.fill();
          // 一圈很淡的边：给形状一个终点，屏幕小的时候尤其重要
          g.shadowBlur = 0;
          g.lineWidth = 1;
          g.strokeStyle = `rgba(${tone},0.5)`;
          g.stroke();
        }
        g.restore();
      }
      g.restore();   // 解除剪裁

      // ── 三点的 thinking morph（官方 thinking → dots）──────────────────────────────
      // 尺寸与节奏取自 recipe：span / 半径 / 错相 / 1.4 s 周期都是常数，不跟电平。
      // 点比球小一圈（整排约球直径的 0.78），所以看起来是"身体缩小让位给装饰图元"，
      // 而不是一个加载动画盖在脸上。
      if (st.dots > 0) {
        const span = R * 0.56;
        const lift = R * 0.08;
        const wave = (offset: number): number => Math.sin((t * Math.PI * 2) / 1.4 + offset * Math.PI * 2);
        const dots: { x: number; r: number; tone: string; offset: number }[] = [
          { x: cx - span, r: R * 0.17, tone: "109,114,120", offset: -0.12 },
          { x: cx, r: R * 0.24, tone: "13,15,18", offset: 0 },
          { x: cx + span, r: R * 0.19, tone: "125,131,139", offset: 0.12 },
        ];
        g.save();
        for (const d of dots) {
          const y = cy + wave(d.offset) * lift;
          const r = d.r * (1 + 0.04 * wave(d.offset + 0.25));
          g.globalAlpha = st.dots;
          g.fillStyle = `rgb(${d.tone})`;
          g.shadowColor = `rgba(${d.tone},0.28)`;
          g.shadowBlur = r * 0.9;
          g.beginPath();
          g.arc(d.x, y, r, 0, Math.PI * 2);
          g.fill();
        }
        g.restore();
      }

      // 呼吸/脉动作用在整体上：用 scale 把两只眼一起收
      void pulse;
    };
    raf = window.requestAnimationFrame(draw);
    return () => {
      window.cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // 只挂一次：所有会变的东西都从 `props` ref 里读
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 相位切换要重置「这一段想了多久」——放在 effect 外，靠 prop 变化即可（不进帧循环）。
  const lastPhase = useRef<CallPhase>(phase);
  if (lastPhase.current !== phase) {
    lastPhase.current = phase;
  }

  return <canvas ref={ref} className="tus-face-canvas" aria-hidden="true" />;
}
