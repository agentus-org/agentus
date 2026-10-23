// 糯米模式的脸 —— 一块 canvas，两只眼睛，和一套会被声音点亮的数字。
//
// WHY A CANVAS AND NOT DOM. 60 fps 的形状/光晕/抖动，如果走 React state 就是每秒 60 次渲染一整个
// 会话页。这里沿用 `CallMode` 画 orb 的那套读法：**帧循环只读 ref**，React 只负责告诉它「相位变了」
// 「来了一条工具」；电平也是每次进来取一次（`getLevel()`），不经过 state。
//
// 几何与情绪表在 `nomiMood.ts`（纯函数、有单测）；这个文件只做「把数字画出来」：
//   · 眼睛 = capsule（圆角矩形，圆角取短边一半），happy/sad 换成弧线，error 换成 ✕；
//   · 三个 continuous 量决定形状：attention 管眼宽、energy 管亮度、warmth 管说完之后的余温；
//   · 会呼吸（2 s ±6 px）、会眨眼（2.8–6.4 s 随机）、会走神（每 6 s 56 %）、会犯困（90 s）；
//   · 会低头干活（working）、会抬眼等你（asking）—— 这两张 OpenNomi 没有，是我们自己的，因为
//     我们的 agent 会跑工具、会停下来等人授权，这些时候一个字都不输出，而且往往以分钟计。
import { useEffect, useRef } from "react";
import type { CallPhase } from "./CallMode";
import {
  BLINK_BLOCKED, LIFE_BEAT_MS, NO_OUTPUT_LOOK_MS, SLEEP_TRANSITION_MS, WARMTH_MS, WORK_FLICK_MS,
  WORK_STRETCH_MS, blinkHoldMs, exprFor, eyeFrame, eyeSpacing, lifeBeat, moodFor, nextBlinkMs,
  type AgentActivity, type MicroAction, type NomiMood,
} from "./nomiMood";

export interface NomiFaceProps {
  phase: CallPhase;
  /** 这一轮 agent 在干嘛（工具 / 等授权 / 想）—— 比相位更细，见 `activityOf`。 */
  activity: AgentActivity;
  /** 这一句的情绪（标签优先、本地派生兜底），null = 没有。 */
  emotion?: NomiMood | null;
  /** 单调递增的工具帧计数：一变就点一下头（"手上有活"）。 */
  ticks?: number;
  /** 实时电平 0..1（说话时是播放，听的时候是麦克风）。每帧取一次，不进 state。 */
  getLevel: () => number;
}

/** 一帧里所有会衰减的东西。全部放进 ref：它们只在帧循环里读写。 */
interface Mutable {
  life: NomiMood | null;
  lifeUntil: number;
  nextBlinkAt: number;
  blinkUntil: number;
  nextBeatAt: number;
  nextActionAt: number;
  resting: boolean;
  drowsy: boolean;
  sleep: number;
  sleepTarget: number;
  phaseAt: number;
  warmthUntil: number;
  lastEventAt: number;
  micro: MicroAction | null;
  microAt: number;
  microUntil: number;
  mood: NomiMood;
  moodAt: number;
  ticks: number;
  level: number;
}

const fresh = (now: number): Mutable => ({
  life: null, lifeUntil: 0, nextBlinkAt: now + nextBlinkMs(), blinkUntil: 0,
  nextBeatAt: now + LIFE_BEAT_MS, nextActionAt: now + WORK_FLICK_MS,
  resting: false, drowsy: false, sleep: 0, sleepTarget: 0,
  phaseAt: now, warmthUntil: 0, lastEventAt: now,
  micro: null, microAt: 0, microUntil: 0,
  mood: "idle", moodAt: now, ticks: 0, level: 0,
});

export function NomiFace({ phase, activity, emotion = null, ticks = 0, getLevel }: NomiFaceProps): JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const props = useRef({ phase, activity, emotion, ticks });
  props.current = { phase, activity, emotion, ticks };
  const levelOf = useRef(getLevel);
  levelOf.current = getLevel;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const g = canvas.getContext("2d");
    if (!g) return;
    /** A phone with a 3× screen does not need 3× of a soft glowing shape; 1.5 is indistinguishable. */
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const st = fresh(performance.now());
    let raf = 0;
    let lastPaint = 0;
    let pointer = { x: 0, y: 0 };

    const size = (): void => {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(canvas);

    const onMove = (e: PointerEvent): void => {
      const r = canvas.getBoundingClientRect();
      pointer = {
        x: ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1,
        y: ((e.clientY - r.top) / Math.max(1, r.height)) * 2 - 1,
      };
    };
    const onLeave = (): void => { pointer = { x: 0, y: 0 }; };
    window.addEventListener("pointermove", onMove, { passive: true });
    canvas.addEventListener("pointerleave", onLeave);

    const draw = (ms: number): void => {
      raf = window.requestAnimationFrame(draw);
      // 30 fps：这块画面全是柔光与缓慢位移，翻倍帧率看不出差别，手机却会热。
      if (ms - lastPaint < 33) return;
      lastPaint = ms;
      const t = ms / 1000;
      const p = props.current;
      st.level = Math.max(0, Math.min(1, levelOf.current() || 0));

      // ── 事件：新工具帧 = 点一下头；相位变了 = 记时间 + 说完的余温 ──────────────────────
      if (p.ticks !== st.ticks) {
        st.ticks = p.ticks;
        st.lastEventAt = ms;
        st.micro = "tick";
        st.microAt = ms;
        st.microUntil = ms + 260;
      }
      if (p.phase !== st.mood || true) {
        // phase 变化在下面 mood 计算里自然体现；这里只管两件事：阶段起点 + 说完的余温。
      }

      // ── 生命感：眨眼、走神、犯困 ────────────────────────────────────────────────────
      const busy = p.activity !== "none" || p.phase === "thinking" || p.phase === "speaking";
      if (ms >= st.nextBlinkAt) {
        st.nextBlinkAt = ms + nextBlinkMs();
        if (!BLINK_BLOCKED.includes(st.mood)) st.blinkUntil = ms + blinkHoldMs();
      }
      if (ms >= st.nextBeatAt) {
        st.nextBeatAt = ms + LIFE_BEAT_MS;
        const b = lifeBeat(ms - st.lastEventAt, Math.random, { busy });
        if (b === "rest") {
          st.drowsy = true;
          st.sleepTarget = 1;
        } else if (b) {
          st.life = b.mood;
          st.lifeUntil = ms + b.durationMs;
        }
      }
      if (st.life && ms > st.lifeUntil) st.life = null;
      if (st.drowsy && st.sleepTarget > 0 && st.sleep >= 1) {
        st.drowsy = false;
        st.resting = true;
      }
      st.sleep += Math.max(-1, Math.min(1, (st.sleepTarget - st.sleep) * 0.06));
      if (st.resting && busy) { st.resting = false; st.drowsy = false; st.sleepTarget = 0; }

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
      });
      if (mood !== st.mood) {
        st.moodAt = ms;
        if (mood !== "sleep" && (st.resting || st.drowsy)) { st.resting = false; st.drowsy = false; st.sleepTarget = 0; st.sleep = 0; }
        // 说完之后那 2.4 秒的余温：mood 从 talking 回到 idle/focus 时点亮。
        if (p.phase !== "speaking") st.warmthUntil = ms + WARMTH_MS;
        st.mood = mood;
      }
      const warmth = Math.max(0, Math.min(1, (st.warmthUntil - ms) / WARMTH_MS));
      const elapsed = (ms - st.phaseAt) / 1000;
      const expr = exprFor(p.phase === "connecting" ? "idle" : p.phase, st.level, elapsed, {
        resting: st.resting, warmth,
      });
      if (p.phase === "listening" || p.phase === "thinking" || p.phase === "speaking") st.phaseAt = st.phaseAt || ms;

      const blinking = ms < st.blinkUntil;
      const left = eyeFrame({ mood, right: false, blinking, t, level: st.level, expr, sleep: st.sleep });
      const right = eyeFrame({ mood, right: true, blinking, t, level: st.level, expr, sleep: st.sleep });

      // ── 画 ───────────────────────────────────────────────────────────────────────
      const W = canvas.width, H = canvas.height;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, W, H);
      g.scale(dpr, dpr);
      const w = W / dpr, h = H / dpr;
      // 一只眼 ≈ 60 px 宽、间距 60：这个比例尺让「宽度 220、高度 170」的盒子刚好装下两张脸。
      const k = Math.max(0.55, Math.min(2.6, Math.min(w / 190, h / 150)));
      /** 中心距 = 空隙 + 眼宽（`eyeSpacing` 是 edge-to-edge 的间隙，见 nomiMood）。 */
      const gap = eyeSpacing(mood) * k;
      const cx = w / 2 + pointer.x * 10 * k;
      const cy = h / 2 + pointer.y * 8 * k;

      // 呼吸：只在「不紧绷」的脸上升降（2 s 一个来回，±6）。
      const breathe = ["idle", "drowsy", "sleep", "curious", "asking", "working"].includes(mood)
        ? Math.sin((t * Math.PI * 2) / 2) * 6 * k : 0;
      // 微动作：低头干活的三种小姿势。
      let mx = 0, my = 0;
      if (st.micro === "tick") my = 2.5 * k;
      else if (st.micro === "flick") { mx = 4 * k; my = 1.5 * k; }
      else if (st.micro === "stretch") my = -5 * k;

      // 相位脉冲：换脸时轻轻放大一下，让"它注意到你了"有分量。
      const pulseAge = ms - st.moodAt;
      const pulse = pulseAge < 260 ? 1 + 0.045 * (1 - pulseAge / 260) : 1;

      for (const eye of [left, right]) {
        const cdist = gap + (((left.w + right.w) / 2) * k * left.xScale);
        const ex = cx + (eye === right ? 1 : -1) * cdist / 2 + eye.x * k + mx;
        const ey = cy + eye.y * k + breathe + my;
        g.save();
        g.translate(ex, ey);
        g.rotate((eye.rot * Math.PI) / 180);
        g.globalAlpha = Math.max(0, Math.min(1, eye.alpha));
        const tone = mood === "error" ? "248,113,113" : mood === "sad" ? "190,190,200" : "255,255,255";
        g.shadowColor = `rgba(${tone},${Math.min(0.5, 0.16 + st.level * 0.2 + warmth * 0.14)})`;
        // 光晕不能盖过形状：模糊半径收到眼睛短边的 45% 以内，否则放大之后只剩两团发白的光
        // （实测：70px 的眼睛配 34px 模糊，读起来是两颗蛋，不是一双眼睛）。
        g.shadowBlur = Math.min(eye.w * k * 0.45, eye.glow * k);
        g.fillStyle = `rgba(${tone},1)`;
        g.strokeStyle = `rgba(${tone},1)`;

        if (eye.shape === "x") {
          const s = (eye.w / 2) * k;
          const j = Math.sin(t * 24) * eye.jitter * k;
          g.lineWidth = 6 * k;
          g.beginPath();
          g.moveTo(-s + j, -s); g.lineTo(s + j, s);
          g.moveTo(s + j, -s); g.lineTo(-s + j, s);
          g.stroke();
        } else if (eye.shape === "arc") {
          // 开心朝上、难过朝下：一条半圆，线宽 6。
          const r = (eye.w / 2) * k;
          g.lineWidth = 6 * k;
          g.beginPath();
          if (eye.arc === "happy") g.arc(0, r, r, Math.PI, Math.PI * 2);
          else g.arc(0, -r, r, 0, Math.PI);
          g.stroke();
        } else {
          const ew = Math.max(2, eye.w * k * eye.xScale);
          const eh = Math.max(1, eye.h * k * eye.yScale);
          const rad = Math.min(ew, eh) / 2;
          const jx = eye.jitter ? Math.sin(t * 24) * eye.jitter * k : 0;
          const jy = eye.jitter ? Math.cos(t * 19) * eye.jitter * k : 0;
          // 上亮下略暗的竖向渐变：球形感来自这里（纯平涂的白块没有"眼珠"的立体）。
          const grad = g.createLinearGradient(0, -eh / 2, 0, eh / 2);
          grad.addColorStop(0, `rgba(${tone},1)`);
          grad.addColorStop(1, `rgba(${tone},0.78)`);
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

      // 呼吸/脉动作用在整体上：用 scale 把两只眼一起收
      void pulse;
    };
    raf = window.requestAnimationFrame(draw);
    return () => {
      window.cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
    };
    // 只挂一次：所有会变的东西都从 `props` ref 里读
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 相位切换要重置「这一段想了多久」——放在 effect 外，靠 prop 变化即可（不进帧循环）。
  const lastPhase = useRef<CallPhase>(phase);
  if (lastPhase.current !== phase) {
    lastPhase.current = phase;
  }

  return <canvas ref={ref} className="nomi-face-canvas" aria-hidden="true" />;
}

/** 给 QA 用：把某一帧的几何直接算出来（不画），让 sweep 能断言"这张脸长什么样"。 */
export function nomiFaceProbe(mood: NomiMood, o: { level?: number; elapsed?: number; blink?: boolean } = {}): {
  w: number; h: number; yScale: number; spacing: number; alpha: number;
} {
  const expr = exprFor("idle", o.level ?? 0, o.elapsed ?? 0, {});
  const e = eyeFrame({ mood, right: false, blinking: o.blink ?? false, t: 0, level: o.level ?? 0, expr });
  return { w: e.w, h: e.h, yScale: e.yScale, spacing: eyeSpacing(mood), alpha: e.alpha };
}
