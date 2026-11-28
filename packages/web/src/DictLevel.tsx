// The composer's little "did the microphone hear anything" meter.
//
// It reads the SAME frame the call's orb reads — `dictation.wave()` / `levelRms()` from
// `Dictation.#measure` — every animation frame, straight from the DOM. Nothing here goes
// through React state: 60 fps of setState is 60 renders/second of the whole composer.
//
// Two honesty rules drive the shape:
//   · no level source (SpeechRecognition / batch upload / device recorder) => say so in
//     words, never paint a flat line that could be read as "you were silent";
//   · below the noise floor => a flat line and NO animation at all. A procedural breath
//     here would turn "nothing arrived" into "it is listening", which is the bug this
//     indicator exists to catch.
import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { dictation, useDictation } from "./voice";

const W = 76;
const H = 20;
const DPR = 2;
const SAMPLES = 64;
/** Speech sits around 0.02–0.2 RMS (voice.ts:1707); under this it is room tone at best. */
const SILENT_RMS = 0.006;

export function DictLevel({ glowRef }: { glowRef?: RefObject<HTMLElement | null> }): JSX.Element | null {
  const state = useDictation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const buf = useRef(new Float32Array(SAMPLES));
  const active = (state.status === "listening" || state.status === "recording")
    && dictation.levelSource() === "pcm";

  useEffect(() => {
    const glow = glowRef?.current ?? null;
    if (!active) {
      glow?.style.removeProperty("--mic-lv");
      return;
    }
    let raf = 0;
    let themeKey = "";
    let ink = "#4aacdf";
    let idle = "#b6bec3";
    let rgb = "74, 172, 223";
    // Read the palette only when it changes — not once per frame.
    const palette = (): void => {
      const cs = getComputedStyle(document.documentElement);
      const key = `${document.documentElement.dataset.theme ?? ""}|${cs.getPropertyValue("--accent")}|${cs.getPropertyValue("--text-dim")}`;
      if (key === themeKey) return;
      themeKey = key;
      ink = cs.getPropertyValue("--accent").trim() || ink;
      idle = cs.getPropertyValue("--text-dim").trim() || idle;
      rgb = cs.getPropertyValue("--accent-rgb").trim() || rgb;
    };

    const draw = (): void => {
      const cv = canvasRef.current;
      const src = dictation.wave();
      const loud = dictation.levelRms() > SILENT_RMS;
      if (cv) {
        const ctx = cv.getContext("2d");
        if (ctx) {
          palette();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, cv.width, cv.height);
          ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
          const b = buf.current;
          const step = Math.max(1, Math.floor(src.length / b.length));
          for (let j = 0; j < b.length; j++) b[j] = loud ? (src[Math.min(src.length - 1, j * step)] || 0) : 0;
          const mid = H / 2;
          const pt = (j: number): { x: number; y: number } => ({ x: (j / (b.length - 1)) * W, y: mid - b[j] * H * 1.35 });
          const trace = (): void => {
            ctx.beginPath();
            for (let j = 0; j < b.length; j++) { const p = pt(j); j ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); }
          };
          trace();
          if (loud) {
            // A lit body under the trace: a bare squiggle reads as a glitch (same as CallMode).
            for (let j = b.length - 1; j >= 0; j--) { const p = pt(j); ctx.lineTo(p.x, mid - (p.y - mid) * 0.35); }
            ctx.closePath();
            const g = ctx.createLinearGradient(0, 0, 0, H);
            g.addColorStop(0, `rgba(${rgb}, .08)`);
            g.addColorStop(0.5, `rgba(${rgb}, .32)`);
            g.addColorStop(1, `rgba(${rgb}, .08)`);
            ctx.fillStyle = g;
            ctx.fill();
            trace();
          }
          ctx.strokeStyle = loud ? ink : idle;
          ctx.lineWidth = loud ? 1.6 : 1.2;
          ctx.lineJoin = "round";
          ctx.stroke();
        }
      }
      // The button's halo is audio-driven too: no CSS keyframes, zero while silent.
      if (glow) glow.style.setProperty("--mic-lv", loud ? Math.min(1, dictation.level()).toFixed(3) : "0");
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      glow?.style.removeProperty("--mic-lv");
    };
  }, [active, glowRef]);

  if (state.status !== "listening" && state.status !== "recording") return null;
  if (dictation.levelSource() !== "pcm") {
    return <span className="dict-level-none" title="当前识别引擎不向页面提供音频电平">当前引擎不提供电平</span>;
  }
  return <canvas ref={canvasRef} className="dict-level-wave" width={W * DPR} height={H * DPR} aria-hidden="true" />;
}
