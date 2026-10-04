// Voice call mode — the full-screen conversation UI (the ChatGPT / 豆包 shape).
//
// What the research settled (2026-10-04), and what each finding turned into here:
//   · Every implementation converges on ONE state contract — idle → connecting → listening →
//     thinking → speaking (+error). VoiceOrbs publishes exactly that prop contract, the
//     ElevenLabs orb drives itself from live input/output volume, and the voice-mode UI specs
//     add the interaction rules: input/output COLOUR-CODED waveform, a barge-in affordance,
//     mute, end session. So: one phase enum, one palette per phase.
//   · The animation has to ride REAL audio, and it must not re-render: the level is read from
//     an analyser every frame (VoiceOrbs' `levelRef` idea — amplitude in 0..1, negative when
//     there is nothing to measure, which is our procedural-fallback switch). 60 fps through
//     React state would be 60 renders a second for a decoration.
//   · The states without audio still have to feel alive — that is the breathing the operator
//     asked for: a slow (3.6 s) scale plus drifting glow, biased by nothing but time.
//
// Honest edges (deliberate, v1):
//   · the reply is spoken sentence-by-sentence as it streams (low latency), not as raw audio
//     chunks — our TTS is request/response, so a sentence is the smallest useful unit;
//   · barge-in is level-driven with a high threshold plus a tap; a phone speaker leaking into
//     its own mic is a real risk, so the threshold is conservative and the sustained window
//     is 300 ms;
//   · tapping during `thinking` cancels the turn (that is what people expect from a "stop").
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { cockpit } from "./state";
import { dictation, playbackLevel, playbackWave, speaker, useVoicePrefs } from "./voice";
import { IconKeyboard, IconMic, IconMicOff, IconPhoneDown } from "./Icons";

export type CallPhase = "connecting" | "listening" | "thinking" | "speaking" | "error";

/** One palette per phase: input and output are deliberately different colours (a call has
 *  two speakers, and the operator should see at a glance who has the floor). */
const PALETTE: Record<CallPhase, { core: [number, number, number]; glow: string }> = {
  connecting: { core: [125, 145, 200], glow: "rgba(125,145,200,0.30)" },
  listening: { core: [56, 189, 248], glow: "rgba(56,189,248,0.34)" },
  thinking: { core: [167, 139, 250], glow: "rgba(167,139,250,0.30)" },
  speaking: { core: [251, 191, 36], glow: "rgba(251,191,36,0.32)" },
  error: { core: [248, 113, 113], glow: "rgba(248,113,113,0.30)" },
};

const PHASE_LABEL: Record<CallPhase, string> = {
  connecting: "正在接通…",
  listening: "在听你说",
  thinking: "思考中…",
  speaking: "正在回答",
  error: "出错了",
};

/** Speech threshold for "the operator is talking" (mic RMS is already ×6 + clamped). */
const VOICE_LEVEL = 0.06;
/** Silence that ends a turn. Long enough to survive a thinking pause mid-sentence. */
const SILENCE_MS = 1200;
/** Barge-in: louder, and sustained. Our own TTS leaks into the mic, so this is deliberately
 *  well above speech-in-a-quiet-room and needs 300 ms of it. */
const BARGE_LEVEL = 0.2;
const BARGE_MS = 300;

function splitSentences(text: string): { done: string[]; tail: string } {
  const done: string[] = [];
  // sentence enders in both scripts, keeping the punctuation with the sentence
  const re = /[^。！？!?\n…]*[。！？!?\n…]+/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const s = m[0].trim();
    if (s) done.push(s);
    last = (m.index ?? 0) + m[0].length;
  }
  return { done, tail: text.slice(last).trim() };
}

/** The full-screen call. Mount it and it takes over; unmounting (hang up) ends the call. */
export function CallMode({ sessionId, onClose, onKeyboard }: {
  sessionId: string;
  onClose: () => void;
  onKeyboard: () => void;
}): JSX.Element {
  const [prefs] = useVoicePrefs();
  const [phase, setPhase] = useState<CallPhase>("connecting");
  const [muted, setMuted] = useState(false);
  const [err, setErr] = useState("");
  const [heard, setHeard] = useState("");     // what the recogniser has so far
  const [reply, setReply] = useState("");     // what the agent is saying right now

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const waveRef = useRef<HTMLCanvasElement | null>(null);
  const phaseRef = useRef<CallPhase>("connecting");
  phaseRef.current = phase;

  // ---- refs the animation loop owns (never React state: it runs at 60 fps) --------------
  const levelRef = useRef(0);          // displayed level (smoothed twice: audio + visual)
  const ringsRef = useRef<{ born: number; strength: number }[]>([]);
  const lastPeakRef = useRef(0);
  const voiceAtRef = useRef(0);        // last moment the operator was audible
  const bargeRef = useRef(0);          // how long we have been above the barge threshold
  const sentRef = useRef(false);       // a turn is in flight (do not send twice)
  const queueRef = useRef<string[]>([]);
  const queueRunRef = useRef(false);
  const queuedRef = useRef(0);         // sentences of the current reply already queued
  const replyKeyRef = useRef("");      // which agent message we are reading

  const view = useSyncExternalStore(cockpit.subscribe, cockpit.getSnapshot);
  const reduced = useMemo(
    () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  // ---- connect -------------------------------------------------------------------------
  // Two ways in, both deliberate:
  //   · a turn is already running (the operator typed the question and tapped 打电话 to
  //     HEAR the answer): join it — go straight to thinking/speaking and read the reply;
  //   · otherwise: mic up and hand them the floor.
  // The join path also means the audio-reactive speaking animation is reachable without a
  // microphone, which is how the QA sweep drives it.
  useEffect(() => {
    let dead = false;
    const boot = async (): Promise<void> => {
      try {
        const snap = cockpit.getSnapshot();
        const live = snap.active?.info.id === sessionId ? snap.active : undefined;
        if (live?.busy) {
          if (dead) return;
          sentRef.current = true;             // a turn is already in flight
          replyKeyRef.current = "";
          setPhase("thinking");
          return;
        }
        dictation.stop();
        const ok = await dictation.start(prefs, sessionId);
        if (dead) return;
        if (!ok) throw new Error(dictation.getSnapshot().error || "无法打开麦克风");
        setPhase("listening");
      } catch (e) {
        if (dead) return;
        setErr(String((e as Error)?.message ?? e));
        setPhase("error");
      }
    };
    void boot();
    return () => {
      dead = true;
      speaker.stop();
      dictation.stop();
    };
    // prefs/sessionId are fixed for the lifetime of a call on purpose
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- the conversation loop ------------------------------------------------------------
  // listening → (silence after speech) → thinking → speaking → listening …
  useEffect(() => {
    const iv = window.setInterval(() => {
      const st = dictation.getSnapshot();
      const lvl = dictation.level();
      if (lvl > VOICE_LEVEL) voiceAtRef.current = Date.now();
      if (phaseRef.current === "listening") {
        setHeard((st.text + (st.interim ? ` ${st.interim}` : "")).trim());
        const text = (st.text || st.interim).trim();
        const quietFor = Date.now() - voiceAtRef.current;
        if (text && quietFor > SILENCE_MS && !sentRef.current) {
          sentRef.current = true;
          setPhase("thinking");
          setHeard(text);
          // stop feeding our own audio to the recogniser while the turn runs
          dictation.setRelay(false);
          // `interrupt`: if the agent is somehow still finishing the previous turn (the
          // cancel we send below is async), the server cancels it and queues this utterance
          // instead of refusing it. Without this the operator got "turn already running" for
          // doing exactly what a call invites.
          cockpit.send({ t: "prompt", sessionId, text, interrupt: true });
        }
      } else if (phaseRef.current === "speaking") {
        // barge-in: the operator talking over the reply takes the floor back. Two things have
        // to happen — stop reading aloud (our own output goes quiet) AND cancel the agent's
        // turn. Stopping only the speaker left the turn running, so the sentence the operator
        // said next was refused with "turn already running": barge-in that doesn't hand the
        // floor over isn't barge-in.
        const over = dictation.level() > BARGE_LEVEL;
        bargeRef.current = over ? bargeRef.current + 250 : 0;
        if (bargeRef.current >= BARGE_MS) {
          bargeRef.current = 0;
          void bargeIn();
        }
      } else {
        bargeRef.current = 0;
      }
    }, 250);
    return () => window.clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // ---- what the agent is saying: queue it sentence by sentence --------------------------
  const active = view.active?.info.id === sessionId ? view.active : undefined;
  const lastAgent = active ? [...active.msgs].reverse().find((m) => m.kind === "agent") : undefined;
  const agentText = lastAgent?.kind === "agent" ? lastAgent.text : "";
  const agentKey = lastAgent?.key ?? "";
  const busy = Boolean(active?.busy);

  useEffect(() => {
    if (phaseRef.current !== "thinking" && phaseRef.current !== "speaking") return;
    if (agentKey !== replyKeyRef.current) {          // a new reply started
      replyKeyRef.current = agentKey;
      queuedRef.current = 0;
      queueRef.current = [];
    }
    const { done, tail } = splitSentences(agentText);
    const fresh = done.slice(queuedRef.current);
    if (fresh.length) {
      queuedRef.current = done.length;
      queueRef.current.push(...fresh);
      setReply((r) => `${r}${r ? " " : ""}${fresh.join(" ")}`);
      if (phaseRef.current === "thinking") setPhase("speaking");
    }
    if (!busy && tail) {                             // turn over: flush the last fragment
      if (queuedRef.current >= done.length) {
        queuedRef.current = done.length + 1;
        queueRef.current.push(tail);
        setReply((r) => `${r}${r ? " " : ""}${tail}`);
      }
    }
    if (!busy && phaseRef.current === "thinking" && !queueRef.current.length && done.length === 0 && !tail) {
      // a turn with no text at all (a tool-only turn): do not sit in "thinking" forever
      void backToListening(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentText, agentKey, busy]);

  // the speaker: one sentence at a time, in order
  useEffect(() => {
    if (phaseRef.current !== "speaking" || queueRunRef.current) return;
    queueRunRef.current = true;
    void (async () => {
      while (queueRef.current.length && phaseRef.current !== "error") {
        const sentence = queueRef.current.shift() as string;
        await speaker.speak(sentence, "call", prefs);
        if (phaseRef.current !== "speaking") break;   // barged in / hung up
      }
      queueRunRef.current = false;
      if (phaseRef.current === "speaking" && !queueRef.current.length && !busy) {
        void backToListening(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, reply, busy]);

  /** Talking over the agent: drop our playback, cancel ITS turn, listen again. */
  const bargeIn = async (): Promise<void> => {
    speaker.stop();
    cockpit.send({ t: "cancel", sessionId });
    await backToListening(false);
  };

  /** Back to the operator's turn: fresh transcript, mic relaying again. */
  const backToListening = async (interrupted: boolean): Promise<void> => {
    if (interrupted) speaker.stop();
    queueRef.current = [];
    queuedRef.current = 0;
    queueRunRef.current = false;
    sentRef.current = false;
    setPhase("listening");
    setReply("");
    setHeard("");
    voiceAtRef.current = Date.now();
    try {
      const st = dictation.getSnapshot();
      if (st.status === "idle" || st.status === "error" || st.status === "transcribing") {
        await dictation.start(prefs, sessionId);
      } else {
        dictation.resetText();
        dictation.setRelay(true);
      }
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
      setPhase("error");
    }
  };

  const hangUp = (): void => {
    speaker.stop();
    dictation.stop();
    onClose();
  };

  const toggleMute = async (): Promise<void> => {
    if (muted) {
      setMuted(false);
      try {
        await dictation.start(prefs, sessionId);
        dictation.setRelay(phaseRef.current === "listening");
      } catch (e) {
        setErr(String((e as Error)?.message ?? e));
      }
      return;
    }
    setMuted(true);
    dictation.stop();
  };

  /** The orb is the one control that means "the floor changes hands". */
  const tapOrb = async (): Promise<void> => {
    const p = phaseRef.current;
    if (p === "listening") {
      const st = dictation.getSnapshot();
      const text = (st.text || st.interim).trim();
      if (text) {
        sentRef.current = true;
        setPhase("thinking");
        dictation.setRelay(false);
        cockpit.send({ t: "prompt", sessionId, text, interrupt: true });
      }
      return;
    }
    if (p === "speaking") { await bargeIn(); return; }
    if (p === "thinking") { await bargeIn(); return; }   // stop the turn, take the floor back
    if (p === "error") await backToListening(false);
  };

  // ---- the animation -------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    const wave = waveRef.current;
    if (!canvas || !wave) return;
    const ctx = canvas.getContext("2d");
    const wctx = wave.getContext("2d");
    if (!ctx || !wctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const waveBuf = new Float32Array(96);
    let raf = 0;

    const size = (): void => {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      const wr = wave.getBoundingClientRect();
      wave.width = Math.max(1, Math.round(wr.width * dpr));
      wave.height = Math.max(1, Math.round(wr.height * dpr));
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(canvas);
    ro.observe(wave);

    const draw = (t: number): void => {
      raf = window.requestAnimationFrame(draw);
      const phase = phaseRef.current;
      const pal = PALETTE[phase];

      // who has the floor: the mic while listening, the speaker while speaking, nothing
      // otherwise (-1 = procedural, the breathing states)
      const raw = phase === "listening"
        ? dictation.level()
        : phase === "speaking" ? Math.max(0, playbackLevel()) : -1;
      // visual smoothing on top of the audio smoothing: fast attack, slow release, so the
      // orb snaps to a syllable and settles like something breathing
      const target = raw < 0 ? -1 : raw;
      levelRef.current = target < 0
        ? levelRef.current * 0.9
        : target > levelRef.current
          ? levelRef.current + (target - levelRef.current) * 0.45
          : levelRef.current * 0.88 + target * 0.12;
      const lv = Math.min(1, levelRef.current);

      // breathing: the states with no audio at all still move (~3.6 s cycle)
      const breath = 1 + 0.05 * Math.sin(t / 1150);
      const energy = raw < 0 ? 0.22 + 0.1 * Math.sin(t / 1150) : 0.2 + 0.8 * lv;

      const W = canvas.width / dpr, H = canvas.height / dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const cx = W / 2, cy = H / 2;
      const base = Math.min(W, H) * 0.33;

      // organic wobble: two slow terms at different frequencies (a perfect circle reads as
      // a spinner; two incommensurate sines read as something alive)
      const wobX = Math.sin(t / 900) * (3 + 14 * energy);
      const wobY = Math.cos(t / 1410) * (2 + 10 * energy);
      const wobR = 1 + 0.05 * Math.sin(t / 770) * (0.4 + energy);
      const core = base * (0.86 + 0.34 * energy) * breath * wobR;
      const rgb = `${pal.core[0]},${pal.core[1]},${pal.core[2]}`;

      // expanding rings: born on level peaks while there IS audio, on a slow cadence while
      // thinking (the "still working" signal)
      const rings = ringsRef.current;
      const now = t;
      const spawn = raw >= 0
        ? (lv > 0.4 && now - lastPeakRef.current > 380)
        : (now - lastPeakRef.current > 1300);
      if (spawn && phase !== "connecting") {
        lastPeakRef.current = now;
        rings.push({ born: now, strength: raw >= 0 ? 0.6 + 0.4 * lv : 0.4 });
        if (rings.length > 6) rings.shift();
      }

      ctx.globalCompositeOperation = "lighter";

      // 1. ambient haze: three slow blobs around the core (the wide, very soft light)
      for (let i = 0; i < 3; i++) {
        const ang = t / (2100 + i * 900) + (i * Math.PI * 2) / 3;
        const dist = core * (0.1 + 0.11 * i) * (0.8 + 0.5 * energy);
        const gx = cx + Math.cos(ang) * dist + wobX * 0.8;
        const gy = cy + Math.sin(ang) * dist + wobY * 0.8;
        // stay INSIDE the canvas: a blob that runs past the edge gets clipped into a visible
        // rectangular seam around the ball (the wide light comes from the CSS tint instead)
        const gr = core * Math.min(1.22 + 0.16 * i, 0.98 * (Math.min(W, H) / 2) / core) * (0.95 + 0.2 * energy);
        const grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
        grad.addColorStop(0, `rgba(${rgb},0.20)`);
        grad.addColorStop(0.45, `rgba(${rgb},0.09)`);
        grad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(gx, gy, gr, 0, Math.PI * 2);
        ctx.fill();
      }

      // 2. bloom band: light concentrated just OUTSIDE the core — the thing that makes a ball
      //    read as luminous rather than as a blurry dot
      const bloom = ctx.createRadialGradient(cx + wobX, cy + wobY, core * 0.82, cx + wobX, cy + wobY, core * 1.42);
      bloom.addColorStop(0, `rgba(${rgb},0)`);
      bloom.addColorStop(0.22, `rgba(${rgb},${0.42 - 0.16 * energy})`);
      bloom.addColorStop(0.6, `rgba(${rgb},${0.14 - 0.06 * energy})`);
      bloom.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = bloom;
      ctx.beginPath();
      ctx.arc(cx + wobX, cy + wobY, core * 1.42, 0, Math.PI * 2);
      ctx.fill();

      // 3. rings, behind the core so they read as ripples coming off it
      for (let i = rings.length - 1; i >= 0; i--) {
        const age = (now - rings[i].born) / (reduced ? 2600 : 1400);
        if (age >= 1) { rings.splice(i, 1); continue; }
        const rr = core * (1.0 + age * 1.05) * breath;
        ctx.beginPath();
        ctx.arc(cx + wobX * 0.3, cy + wobY * 0.3, rr, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${rgb},${(1 - age) * 0.5 * rings[i].strength})`;
        ctx.lineWidth = 1.2 + 2.4 * (1 - age);
        ctx.stroke();
      }

      // 4. the core: a lit sphere, not a wash — hot centre, saturated edge
      const cxo = cx + wobX * 0.7, cyo = cy + wobY * 0.7;
      const g2 = ctx.createRadialGradient(cxo - core * 0.18, cyo - core * 0.18, core * 0.05, cxo, cyo, core);
      g2.addColorStop(0, `rgba(255,255,255,${0.92 - 0.18 * energy})`);
      g2.addColorStop(0.3, `rgba(${rgb},0.92)`);
      g2.addColorStop(0.66, `rgba(${rgb},0.62)`);
      g2.addColorStop(0.88, `rgba(${rgb},0.28)`);
      g2.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g2;
      ctx.beginPath();
      ctx.arc(cxo, cyo, core, 0, Math.PI * 2);
      ctx.fill();

      // 5. rim + specular: a thin bright edge sells "sphere", a highlight sells "glass"
      ctx.globalCompositeOperation = "source-over";
      ctx.beginPath();
      ctx.arc(cxo, cyo, core * 0.97, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,255,255,0.10)`;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cxo, cyo, core * 0.985, -2.5, -0.35);      // the side the light comes from
      ctx.strokeStyle = `rgba(255,255,255,${0.42 - 0.12 * energy})`;
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.stroke();
      const spec = ctx.createRadialGradient(
        cx - core * 0.34, cy - core * 0.42, 0, cx - core * 0.34, cy - core * 0.42, core * 0.55,
      );
      spec.addColorStop(0, "rgba(255,255,255,0.40)");
      spec.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = spec;
      ctx.beginPath();
      ctx.arc(cx - core * 0.34, cy - core * 0.42, core * 0.55, 0, Math.PI * 2);
      ctx.fill();

      if (!reduced) {
        // three orbiters INSIDE the halo with their own light: at the old distance they read
        // as dust specks on the glass
        ctx.globalCompositeOperation = "lighter";
        for (let i = 0; i < 3; i++) {
          const ang = t / (1150 + i * 520) + i * 2.1;
          const rr = core * (1.08 + 0.11 * i);
          const ox = cx + Math.cos(ang) * rr;
          const oy = cy + Math.sin(ang) * rr * 0.95;
          const halo = ctx.createRadialGradient(ox, oy, 0, ox, oy, 9);
          halo.addColorStop(0, `rgba(255,255,255,${0.5 + 0.4 * energy})`);
          halo.addColorStop(0.35, `rgba(${rgb},${0.4 + 0.3 * energy})`);
          halo.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = halo;
          ctx.beginPath();
          ctx.arc(ox, oy, 9, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalCompositeOperation = "source-over";

      // ---- input / output waveform (two colours, one strip: whose voice is this) ---------
      const WW = wave.width / dpr, WH = wave.height / dpr;
      wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      wctx.clearRect(0, 0, WW, WH);
      let have = false;
      if (phase === "listening") {
        const src = dictation.wave();
        const step = Math.max(1, Math.floor(src.length / waveBuf.length));
        for (let j = 0, i = 0; j < waveBuf.length; j++, i += step) waveBuf[j] = src[i] ?? 0;
        have = true;
      } else if (phase === "speaking") {
        have = playbackWave(waveBuf);
      }
      if (have) {
        const pt = (j: number): { x: number; y: number } => ({
          x: (j / (waveBuf.length - 1)) * WW,
          y: WH / 2 - waveBuf[j] * WH * 1.35,
        });
        // a soft lit body under the trace: a bare 1px squiggle reads as a glitch, a filled
        // shape reads as sound
        wctx.beginPath();
        for (let j = 0; j < waveBuf.length; j++) { const p = pt(j); j ? wctx.lineTo(p.x, p.y) : wctx.moveTo(p.x, p.y); }
        for (let j = waveBuf.length - 1; j >= 0; j--) { const p = pt(j); wctx.lineTo(p.x, WH / 2 - (p.y - WH / 2) * 0.35); }
        wctx.closePath();
        const fill = wctx.createLinearGradient(0, 0, 0, WH);
        fill.addColorStop(0, `rgba(${pal.core[0]},${pal.core[1]},${pal.core[2]},0.05)`);
        fill.addColorStop(0.5, `rgba(${pal.core[0]},${pal.core[1]},${pal.core[2]},0.30)`);
        fill.addColorStop(1, `rgba(${pal.core[0]},${pal.core[1]},${pal.core[2]},0.05)`);
        wctx.fillStyle = fill;
        wctx.fill();
        wctx.beginPath();
        for (let j = 0; j < waveBuf.length; j++) { const p = pt(j); j ? wctx.lineTo(p.x, p.y) : wctx.moveTo(p.x, p.y); }
        wctx.strokeStyle = `rgba(255,255,255,${0.55 + 0.3 * lv})`;
        wctx.lineWidth = 1.7;
        wctx.lineJoin = "round";
        wctx.lineCap = "round";
        wctx.stroke();
      } else {
        // no analyser (browser voice, or a quiet moment): a flat line, never a fake waveform
        wctx.beginPath();
        wctx.moveTo(0, WH / 2);
        wctx.lineTo(WW, WH / 2);
        wctx.strokeStyle = "rgba(255,255,255,0.07)";
        wctx.lineWidth = 1;
        wctx.stroke();
      }
    };
    raf = window.requestAnimationFrame(draw);
    return () => { window.cancelAnimationFrame(raf); ro.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  const hint = phase === "listening"
    ? (heard ? "点一下直接发送，或说完停一下" : muted ? "麦克风已静音" : "说点什么…")
    : phase === "speaking" ? "点一下打断，自己说" : phase === "thinking" ? "点一下停止它" : "";

  return createPortal(
    <div className="call-mode" data-phase={phase} role="dialog" aria-modal="true" aria-label="语音通话">
      <div className="call-head">
        <span className="call-title">{PHASE_LABEL[phase]}</span>
        <span className="call-sub">{muted ? "麦克风已静音" : "免提 · 语音通话"}</span>
      </div>

      <button
        type="button"
        className="call-orb"
        onClick={() => void tapOrb()}
        aria-label={`${PHASE_LABEL[phase]} — ${hint || "点击切换"}`}
        title={hint}
      >
        <canvas ref={canvasRef} className="call-orb-canvas" />
      </button>

      <div className="call-lines">
        {heard ? <p className="call-heard">{heard}</p> : null}
        {reply ? <p className="call-reply">{reply}</p> : null}
        {err ? <p className="call-err">{err}</p> : null}
        {!heard && !reply && !err ? <p className="call-hint">{hint}</p> : null}
      </div>

      <canvas ref={waveRef} className="call-wave" aria-hidden="true" />

      <div className="call-controls">
        <button
          type="button"
          className={`call-btn ${muted ? "on" : ""}`}
          onClick={() => void toggleMute()}
          aria-pressed={muted}
          title={muted ? "打开麦克风" : "静音麦克风"}
        >
          {muted ? <IconMicOff size={18} /> : <IconMic size={18} />}
        </button>
        <button type="button" className="call-btn hangup" onClick={hangUp} title="挂断" aria-label="挂断">
          <IconPhoneDown size={20} />
        </button>
        <button type="button" className="call-btn" onClick={onKeyboard} title="改用键盘" aria-label="改用键盘">
          <IconKeyboard size={18} />
        </button>
      </div>

      {/* the state is announced, not just drawn: a screen reader gets the whole call */}
      <p className="sr-only" aria-live="polite">{PHASE_LABEL[phase]}</p>
    </div>,
    document.body,
  );
}
