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
//   · tapping during `thinking` cancels the turn (that is what people expect from a "stop");
//   · the four thresholds the loop runs on (barge level/duration, silence, minimum length)
//     are OPERATOR settings, not constants — a phone on a table and a headset in a quiet
//     room need different numbers, and only the person in the room knows which. The panel
//     is on the call (the ⚙ in the corner); callSettings.ts holds the values.
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { cockpit, type MsgView } from "./state";
import { dictation, micEchoCancelled, micInfo, playbackLevel, playbackRms, playbackWave, setCallActive, speaker, useSpeaker, useVoicePrefs } from "./voice";
import { MiniMarkdown } from "./MiniMarkdown";
import { splitSentences } from "./speech";
import { TusFace } from "./TusFace";
import { activityOf, deriveEmotion, readEmoTags, stripEmoTags, substateOf, type TusMood, type ToolSubstate } from "./tusMood";
import { vadStep, newVad, type VadState } from "./vad";
import { silero } from "./silero";
import {
  IconChevronDown, IconClose, IconHistory, IconKeyboard, IconMic, IconMicOff, IconPhoneDown, IconRefresh, IconSend,
  IconSettings, IconStop, IconSubtitles,
} from "./Icons";
import {
  BARGE_COOLDOWN_MS, BARGE_GRACE_MS, bargeFloorRms, CALL_DEFAULT, CALL_KNOBS, CALL_RANGE, INTERRUPT_MODES,
  matchesWakePhrase, normalizeWakePhrase, wakeArmed, WAKE_FRESH_MS,
  isBargeEvidence, patchCallSettings, useCallSettings,
  type CallSettings,
} from "./callSettings";

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

/** Speech threshold for "the operator is talking", in real microphone RMS (0..1). Not a knob:
 *  this only answers "was there a voice at all", and both the utterance end and the minimum length
 *  are operator-tunable on top of it. Room noise sits around 0.002–0.006, normal speech 0.02–0.10;
 *  0.010 therefore separates a voice from a fan without demanding a raised one. */
const VOICE_RMS = 0.010;
/** How often the loop samples the mic. The knobs are quantised by this, so it is a
 *  120 ms tick rather than a lazy 250 ms one — "说完停顿 1.2 秒" has to mean 1.2 s. */
const LOOP_MS = 120;

/** The agent's OWN words when it REFUSES to start a turn (its cross-process turn lease is held, or
 *  a stale hard-interrupt is pending — see `bargeIn`): "Stopped waiting for another Hermes process
 *  on this session. Your message was not processed."
 *
 *  That is a protocol notice, not an answer, and in a call it must not be READ OUT as one. Matched
 *  verbatim and anchored on purpose: the turn still reports `end_turn`, so there is no field to
 *  read, and a loose matcher would swallow a real answer that merely quotes the sentence. */
const NON_ANSWER_RE = /^(?:Stopped waiting for another Hermes process on this session\. Your message was not processed\.|⏳? ?Another Hermes process kept this session busy too long[\s\S]*not processed[\s\S]*)$/;

/** Code points, not UTF-16 units: "最少字数" must not count an emoji as two. */
function charCount(text: string): number {
  return [...text].length;
}

/** How many sentences ahead of the one playing the reader asks for. ONE, not two: the provider
 *  accepts three clips at once (measured), so two sentences of speculation can hold every slot and
 *  make the clip the reader needs wait for a speculative one to land — the same stall, wearing a
 *  different hat. The next sentence is also the only one that matters: it is the boundary the
 *  operator hears. */
const PREFETCH_SENTENCES = 1;
/** How long the call may sit in `thinking`/`speaking` with an empty queue, nothing playing and no
 *  turn in flight before it declares itself starved and hands the floor back. The state is checked,
 *  not the cause: every known way to go mute mid-call (#44) lands in exactly this state. */
const STARVE_MS = 4000;
/** …and the OTHER way a call goes quiet: the speaker says it is speaking and no sound has come out
 *  for this long. A synthesis request that never answers, a `<audio>` element stuck on a dead
 *  stream, a browser voice that silently refuses — all of them hang `speak()` forever, which the
 *  starve check above cannot see (the queue is non-empty and the speaker is "busy"). Measured
 *  ordinary sentences are seconds long, so 15 s of silence inside one sentence is already a fault. */
const MUTE_MS = 15000;
/** The same idea for a sentence we cannot meter at all (the browser voice and the `<audio>` fallback
 *  expose no level — `playbackRms()` is -1 there). Without an analyser there is no honest way to tell
 *  「在出声」 from 「卡住了」, so this is deliberately generous: one glued sentence is ~20–27 s of
 *  speech, and skipping a sentence the operator was hearing is worse than a late recovery. */
const STUCK_MS = 45000;
/** How long after dialling a late-arriving transcript still counts as history (see bootLockedRef). */
const BOOT_GRACE_MS = 3000;

/** Where the captions toggle is remembered. Local, not server-side: the two instances of a call
 *  (a phone in the car, a desktop at the desk) have no reason to share a reading preference. */
const CAPTION_KEY = "agentus.call.caption";
/** #53：语音打断默认不摆在那一排上。它是最吵、最容易误触的一档，出问题也最难看懂（抢话判定、
 *  回声、灵敏度都参与）。代码、阈值、判定一条没删 —— 通话设置里那个勾选框把它放回来。 */
const VOICE_MODE_KEY = "agentus.call.voiceMode";

/** One line of history in the call's window.
 *  Memoised: the reply streams in chunks, the window re-renders on every one of them, and the rows
 *  that did not change must not re-render with it. */
const HistRow = memo(function HistRow({ kind, who, text, current }: { kind: string; who: string; text: string; current: boolean }): JSX.Element | null {
  if (!text.trim()) return null;
  return (
    <div className={`call-hm ${kind}${current ? " current" : ""}`}>
      {who ? <span className="call-hm-who">{who}</span> : null}
      {kind === "agent" || kind === "user" ? <MiniMarkdown text={text} /> : <span>{text}</span>}
    </div>
  );
});

/** One compact line per message: what the operator needs to RECOGNISE a turn (their own words, the
 *  answer, a notice) without the chat's full row furniture. A tool shows its title, so "something ran
 *  in there" is visible instead of a silent gap; thoughts and plans collapse to one dim line. */
function histLine(m: MsgView): { kind: "user" | "agent" | "meta" | "tool"; who: string; text: string } {
  switch (m.kind) {
    case "user": return { kind: "user", who: m.from ? `来自「${m.from.title}」` : "你", text: m.text };
    case "agent": return { kind: "agent", who: "它", text: m.text };
    case "meta": return { kind: "meta", who: "", text: m.text };
    case "tool": return { kind: "tool", who: "", text: `${m.title || m.kind2 || "工具"}${m.status ? ` · ${m.status}` : ""}` };
    case "plan": return { kind: "tool", who: "", text: `计划：${m.items.map((i) => i.content).join("；")}` };
    case "thought": return { kind: "tool", who: "", text: m.text };
    // 状态行（回忆了几条记忆 / 压缩过 / 警告）：在语音通话的历史里当一行低调的提示。
    case "note": return { kind: "meta", who: "", text: m.text };
    // 审批卡：通话里只剩一句「批了什么」——声音场景不需要按钮。
    case "approval": return {
      kind: "meta", who: "",
      text: `审批：${m.title}${m.decision ? (m.decision.outcome === "selected" ? "（已答）" : "（已取消）") : ""}`,
    };
    case "project-skills": return { kind: "meta", who: "", text: m.text };
  }
}

/** The full-screen call. Mount it and it takes over; unmounting (hang up) ends the call. */
export function CallMode({ sessionId, onClose, onKeyboard, renderTranscript, tus = false, pending = 0 }: {
  sessionId: string;
  onClose: () => void;
  onKeyboard: () => void;
  /** Tus 模式（操作者 2026-10-23 口述）：通话按钮**长按**进来的另一种电话页面。
   *
   *  它不是第二种通话实现 —— 相位机、看门狗、打断、TTS 队列、转录全部是同一份代码，只有两处不同：
   *    · 表情区：orb 换成一整块会动的脸（`TusFace`），竖屏在上、横屏在左；
   *    · 对话区：始终展开的会话页（`renderTranscript`），字号收小。
   *  打断方式固定为关键词（不进三态开关，也不改写持久设置 —— 见下面的 `effCfg`）。 */
  tus?: boolean;
  /** 等答复的授权请求条数（`App` 的 `v.perms.length`）。脸靠它切到「asking」：在通话里被一张
   *  授权卡挡住时，它一个字都不输出，没有这张脸就等于死了。 */
  pending?: number;
  /** The CHAT PAGE's own transcript renderer, handed down by `App`.
   *
   *  Why a prop and not an import: `App` already imports this file, so importing `Bubble`/`WorkRun`
   *  from it back would close a cycle between the two modules. Passing the function keeps ONE
   *  implementation of the rows — the operator's requirement was literally 「那一套UI不要变」:
   *  the agent's mark and name, YOU, collapsible thinking, tool cards, plan cards, streaming
   *  markdown — and the call gets all of it without a second renderer drifting away from it. */
  renderTranscript?: (p: { msgs: MsgView[]; sid: string; backend: string; busy: boolean; base: string; speaking?: boolean }) => JSX.Element | null;
}): JSX.Element {
  const [prefs] = useVoicePrefs();
  // Why the voice changed: the speaker records a note when the server voice fails for a sentence and
  // the browser reads it instead. It used to be rendered only in the composer, i.e. never while a call
  // was up — so the operator heard the voice change with no explanation anywhere.
  const spoken = useSpeaker();
  const [phase, setPhase] = useState<CallPhase>("connecting");
  const [muted, setMuted] = useState(false);
  const [err, setErr] = useState("");
  const [heard, setHeard] = useState("");     // what the recogniser has so far
  /** When the wake phrase was last HEARD — the call has to answer 「我听见了」 or a working wake
   *  word is indistinguishable from a dead one (that was the operator's report). */
  const [wakeHit, setWakeHit] = useState(0);
  const [holding, setHolding] = useState(false);   // push-to-talk is down (the label follows it)
  const [reply, setReply] = useState("");     // what the agent is saying right now
  // The tunables (callSettings.ts) live in the call, not in a settings page: a threshold
  // only means anything while you are on the call that is misbehaving.
  const [cfg] = useCallSettings();
  const [showCfg, setShowCfg] = useState(false);
  // The history window: collapsed to a bar by default (a call is for talking), open on demand so the
  // operator can read back what was said without leaving the call.
  const [histOpen, setHistOpen] = useState(false);
  const [histAtBottom, setHistAtBottom] = useState(true);
  const histRef = useRef<HTMLDivElement | null>(null);
  // 字幕 (captions) — the transcript view. The orb is the default face of a call (that is what the
  // operator's eye expects when it rings), and this is the ONE toggle that turns the page into a
  // readable conversation: the ball drops behind a frosted panel and the transcript takes the
  // layout. Modelled on Gemini Live's captions button (top-right corner, sticky setting) and on
  // ChatGPT's move to voice-inside-the-chat — both keep the immersive shape as an option and let
  // the words take over on request. Persisted locally: it is a personal reading preference, not a
  // server-side threshold, and a phone call and a desktop call need not agree.
  const [caption, setCaption] = useState<boolean>(() => {
    try { return localStorage.getItem(CAPTION_KEY) === "1"; } catch { return false; }
  });
  const captionRef = useRef(caption);
  captionRef.current = caption;
  /** 语音打断这一档要不要摆在打电话那一排上（默认不摆，见 VOICE_MODE_KEY）。 */
  const [voiceMode, setVoiceMode] = useState<boolean>(() => {
    try { return localStorage.getItem(VOICE_MODE_KEY) === "1"; } catch { return false; }
  });
  const toggleVoiceMode = (): void => {
    const next = !voiceMode;
    setVoiceMode(next);
    try { localStorage.setItem(VOICE_MODE_KEY, next ? "1" : "0"); } catch { /* private mode */ }
  };
  const [ccAtBottom, setCcAtBottom] = useState(true);
  const ccRef = useRef<HTMLDivElement | null>(null);
  const [cfgErr, setCfgErr] = useState("");
  /** The wake-phrase box edits a DRAFT, not the setting. Writing through on every keystroke both ate
   *  the space in 「hey agent」 (normalisation trims, and the controlled input follows the stored value
   *  back) and fired one PUT per character whose out-of-order replies could roll the text back by a
   *  keystroke. Commit on blur / Enter — that is when the operator has finished a phrase. */
  const [wakeDraft, setWakeDraft] = useState<string | null>(null);
  /** Tus 模式下**只在这一次通话里**把打断方式当成关键词：不写 localStorage、不写服务端设置，
   *  退出后原来的三态开关还是原样（操作者要求「不要侵入现在的语音打断和关键词打断」）。 */
  const effCfg = tus ? { ...cfg, interruptMode: "keyword" as const } : cfg;
  const cfgRef = useRef(effCfg);
  cfgRef.current = effCfg;
  const applyCfg = (patch: Partial<CallSettings>): void => {
    void patchCallSettings(patch).then(setCfgErr);
  };

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const waveRef = useRef<HTMLCanvasElement | null>(null);
  const phaseRef = useRef<CallPhase>("connecting");
  phaseRef.current = phase;

  // ---- refs the animation loop owns (never React state: it runs at 60 fps) --------------
  const levelRef = useRef(0);          // displayed level (smoothed twice: audio + visual)
  const ringsRef = useRef<{ born: number; strength: number }[]>([]);
  const lastPeakRef = useRef(0);
  const voiceAtRef = useRef(0);        // last moment the operator was audible
  /** The room's own noise floor, measured instead of configured (see vad.ts). `VOICE_RMS` was the
   *  old absolute bar; it is only the fallback for the very first frames now. */
  const vadRef = useRef<VadState>(newVad());
  const bargeRef = useRef(0);          // how long we have been above the barge threshold
  /** When the sentence now being read was handed to the speaker, and when our own output was
   *  last seen to rise from silence. Both arm the grace window in the loop: the first frames of
   *  a clip are its attack transient plus the echo canceller converging, and counting those as
   *  "the operator is talking" is how a call interrupts itself. */
  const clipAtRef = useRef(0);
  const playAtRef = useRef(0);
  const quietRef = useRef(0);          // last tick's playback level, to notice the rise
  /** Last moment the loudspeaker was actually producing sound. The mute watchdog compares against
   *  it: "speaking" is a claim, this is the evidence. */
  const audibleRef = useRef(0);
  /** The clip the speaker is on right now, verbatim — 关键词 needs it to answer 「这句话是它自己念的
   *  吗」, and the mute watchdog needs to know a clip is in flight. */
  const spokenTextRef = useRef("");
  /** How to abandon THAT clip from the outside. `speak()` settles on its own normally; when it does
   *  not (a synthesis request that never answers, an `<audio>` element on a dead stream) the loop
   *  must be able to skip the sentence instead of awaiting forever — and skipping is not hanging up. */
  const abandonRef = useRef<null | (() => void)>(null);
  /** Last playback level we could measure; -1 means 「不可测」 (see STUCK_MS), never 「静音」. */
  const playRmsRef = useRef(-1);
  /** When the wake phrase was last HEARD to change in the transcript (see WAKE_FRESH_MS). */
  const saidAtRef = useRef(0);
  const lastSaidRef = useRef("");
  /** When the floor last changed hands by voice — the cooldown that keeps the tail of an
   *  interruption (and the recogniser catching up with it) from firing a second one. */
  const lastBargeRef = useRef(0);
  /** The echo's OWN level: a slow average of the microphone while our reply is playing and the
   *  operator is still silent. A voice is then a STEP over this line, which is the second (and on
   *  a device without echo cancellation, the only reliable) proof of a barge-in. */
  const echoBaseRef = useRef(0);
  /** Push-to-talk: while true nothing auto-sends. The operator is holding the button and decides
   *  when the sentence is finished — the silence timer is exactly what cut him off mid-sentence
   *  (「我这句话还没说完，他就显示录入完成了」). */
  const pttRef = useRef(false);
  /** 点按式收音（按键打断页左键，操作员口述 2026-10-23）：点「开始说话」/「打断」之后，这句话什么时候
   *  结束由人再点一次「结束」决定 —— 和 PTT 同一条契约（不存在"停顿多久自动发出去"），区别只在手势是
   *  点一下而不是按住。`manual` 是它的渲染态，ref 是循环里读的那份。 */
  const manualRef = useRef(false);
  const [manual, setManual] = useState(false);
  const sentRef = useRef(false);       // a turn is in flight (do not send twice)
  const queueRef = useRef<string[]>([]);
  const queueRunRef = useRef(false);
  const queuedRef = useRef(0);         // sentences of the current reply already queued
  const replyKeyRef = useRef("");      // which agent message we are reading
  /** The reply that was playing when the operator took the floor. Its key must never reach the
   *  speaker again — without this, loosening the gate off the phase (so a typed prompt gets read)
   *  would also re-read the tail of the answer we just interrupted: 「打断它以后它又自己念了一遍」. */
  const cutKeyRef = useRef("");
  /** The same fact as `cutKeyRef`, expressed in TIME. The key alone is not enough: when the floor is
   *  taken during `thinking`, `rawAgentKeyRef` still points at the PREVIOUS answer, and the cancelled
   *  turn can still flush a brand-new block afterwards — new key, not the baseline, not the cut key,
   *  so it would be read out as 「the reply to this turn」. Anything stamped before this moment is
   *  what the operator interrupted. */
  const cutAtRef = useRef(0);
  /** The reply that was ALREADY in the transcript when this turn began — usually the answer to
   *  the previous question. The transcript is not synchronous with our own send: for a moment
   *  after `prompt`, the last agent message is still the old answer (the user message has not
   *  been broadcast yet), and reading it out is precisely the reported bug. Anything carrying
   *  this key is history and is never spoken. */
  const baselineKeyRef = useRef("");
  /** Decided once per call: was the baseline known at boot, or is it history arriving later? */
  const bootLockedRef = useRef(false);
  /** Did we dial INTO a turn that was already running? Then that in-flight message IS this turn's
   *  reply and must be read from its start — the boot-history guard below must not swallow it. */
  const joinedRef = useRef(false);
  const bootAtRef = useRef(Date.now());
  /** The transcript's last agent message, unfiltered — what the baseline is taken from. */
  const rawAgentKeyRef = useRef("");
  /** The call is over the moment it closes. The sentence queue is an async loop that outlives
   *  the component unless it is told to stop — hanging up mid-reply used to hand the next
   *  sentence to the speaker and the call kept talking after it was gone. */
  const aliveRef = useRef(true);
  /** Read inside the loop (whose closure is fixed for the life of the call): muting has to
   *  stop the auto-send, not just the recogniser. */
  const mutedRef = useRef(false);
  mutedRef.current = muted;

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
    setCallActive(true);            // the call owns the voice while it is open (see voice.ts)
    // …and tell the server immediately, not "within 30 s at the next presence tick": from the second
    // the call is up, nothing may make a sound (a notification tone goes into this call's own
    // microphone — the native capture has no echo cancellation), and this session's turn-end card is a
    // duplicate of what the call is already saying out loud.
    const reportCall = (active: boolean): void => {
      void fetch("/api/notify/presence", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: active ? sessionId : null, visible: active, call: active }),
      }).catch(() => { /* presence is a hint, never a requirement */ });
    };
    reportCall(true);
    const boot = async (): Promise<void> => {
      try {
        const snap = cockpit.getSnapshot();
        const live = snap.active?.info.id === sessionId ? snap.active : undefined;
        // 从接通开始，这段听写就归通话。上一个页面的残留一律丢掉：`stop()` 会把它留给
        // “输入框”消费，而通话结束后那个输入框正是聊天页的 composer。
        dictation.cancel();
        if (live?.busy) {
          if (dead) return;
          sentRef.current = true;             // a turn is already in flight
          joinedRef.current = true;           // …and it is the reply we want to hear
          replyKeyRef.current = "";
          // …and that in-flight message IS this turn's reply, so it gets read from its start
          // (baseline stays empty). A session that is merely idle is the opposite case: the
          // reply sitting in the transcript is history.
          setPhase("thinking");
          return;
        }
        const lastAgent = [...(live?.msgs ?? [])].reverse().find((m) => m.kind === "agent");
        baselineKeyRef.current = (lastAgent as { key?: string } | undefined)?.key ?? "";
        // 按键模式 (#51)：接了电话先不开麦 —— 麦克风在他按住圆球时才打开，页面顶上的录音指示才不会
        // 从接通那一刻一直亮到挂断。VAD 也是听帧的，没有麦克风就没有可喂的帧，一起跳过。
        if (cfgRef.current.interruptMode !== "button") {
          const ok = await dictation.start(prefs, sessionId);
          if (dead) return;
          if (!ok) throw new Error(dictation.getSnapshot().error || "无法打开麦克风");
          setPhase("listening");
          // The speech detector: Silero in the page, on this microphone's own 16 kHz frames. Lazy and
          // non-blocking — the call is already listening above, and every path below falls back to the
          // measured-floor gate (`vadStep`) while the model is loading or if it never loads at all.
          void silero.load("/vad/silero_vad.onnx").then((ok) => {
            if (dead || !ok) return;
            silero.reset();
            dictation.setVadTap((s) => silero.push(s));
          });
        } else {
          setPhase("listening");
        }
      } catch (e) {
        if (dead) return;
        setErr(String((e as Error)?.message ?? e));
        setPhase("error");
      }
    };
    void boot();
    return () => {
      dead = true;
      dictation.setVadTap(null);
      silero.reset();
      aliveRef.current = false;     // covers 改用键盘 and the parent closing the call
      speaker.stop();
      // DISCARD, not stop(): `stop()` keeps what was heard so the composer can take it. The
      // composer behind this call then becomes the chat prompt — which is exactly how the tail of
      // the agent's own reply ("keyword mode keeps the recogniser on while we speak") ended up
      // typed into the operator's input after 挂断 / 改用键盘.
      dictation.cancel();
      setCallActive(false);
      // Hang up = nobody watching. Reporting "not watching" is the safe direction: for up to one tick
      // the phone may still notify while the operator is in fact back at the screen, which is a missed
      // suppression, never a lost notification.
      reportCall(false);
    };
    // prefs/sessionId are fixed for the lifetime of a call on purpose
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The wake confirmation is a FLASH, not a new permanent state: left standing it would answer every
  // later question with 「听到「小灵」了」 and hide the ordinary guidance.
  useEffect(() => {
    if (!wakeHit) return;
    const t = window.setTimeout(() => setWakeHit(0), 2600);
    return () => window.clearTimeout(t);
  }, [wakeHit]);

  // ---- the conversation loop ------------------------------------------------------------
  // listening → (silence after speech) → thinking → speaking → listening …
  useEffect(() => {
    const iv = window.setInterval(() => {
      const c = cfgRef.current;
      const st = dictation.getSnapshot();
      // TWO SCALES, both in real amplitude (0..1 RMS): the microphone and our own output. The
      // gate must never compare boosted/clamped display values — that is exactly what made
      // 语音打断 unable to fire on a real call (see `ECHO` in callSettings.ts).
      const mic = dictation.levelRms();
      // OUR OWN OUTPUT, sampled every tick. This is the reference signal of the barge gate: echo
      // scales with it, a human voice does not (see `isBargeEvidence`). -1 = not measurable
      // (<audio> fallback / the browser voice cannot be tapped): no echo model, so the gate falls
      // back to the echo baseline it learns from the microphone itself.
      const play = playbackRms();
      playRmsRef.current = play;
      if (play > 0.004 && quietRef.current <= 0.004) playAtRef.current = Date.now();
      if (play > 0.004) audibleRef.current = Date.now();
      quietRef.current = play;
      // When what we HEAR last changed. 关键词 compares freshly heard words, not the whole accumulated
      // transcript: the recogniser only appends during a relay, so one stale hit used to stay armed.
      const heardNow = `${st.text || ""} ${st.interim || ""}`.trim();
      if (heardNow !== lastSaidRef.current) { lastSaidRef.current = heardNow; saidAtRef.current = Date.now(); }
      // A relay that could not be replaced AT ALL is a real failure, and the call is the one surface
      // where the transcript's own error line is invisible (it renders in the composer, behind the
      // full-screen call). Say it on the call instead of sitting in `listening` with a microphone
      // nothing is listening to — the orb then takes the operator back (tapOrb: error → listening).
      if (st.error && phaseRef.current === "listening") {
        setErr(st.error);
        setPhase("error");
        return;
      }
      // 按键打断 means NOBODY is listening while it speaks — not for the barge, not for the
      // transcript, not for the level. The operator's rule, verbatim: 「打断的时候就不要去用
      // 语音识别这个打断情况了，只有语音打断的时候才需要去识别我的语音是否打断了」. So the
      // microphone is closed for the whole turn (it is reopened by whatever takes the floor back:
      // the 打断 button, 按住说话, or the end of the reply). Closing it is stronger than ignoring
      // its numbers: a recogniser that keeps running during playback hears our own TTS, and the
      // stale sentence would then be waiting in `heard` the moment listening resumes.
      if (c.interruptMode === "button" && (phaseRef.current === "speaking" || phaseRef.current === "thinking")) {
        if (st.status !== "idle" && !mutedRef.current) dictation.stop();
        bargeRef.current = 0;
        echoBaseRef.current = 0;
        return;
      }
      // 关键词打断: the floor changes hands on a WORD, not on a level. Two consequences:
      //  · the recogniser keeps running while the reply plays (the same relay the listening phase
      //    uses) — the phrase has to be *heard*, and nothing else is listening;
      //  · the confirmation is `matchesWakePhrase` over what was heard, so a colleague talking at
      //    normal volume cannot take the floor by being loud. Level plays no part at all here.
      //  An empty phrase makes the mode inert on purpose: switching the mode without typing one
      //  changes nothing, so this cannot turn into an accidental always-on wake word.
      if (c.interruptMode === "keyword" && (phaseRef.current === "speaking" || phaseRef.current === "thinking")) {
        if (!mutedRef.current) dictation.setRelay(true);
        bargeRef.current = 0;
        const now = Date.now();
        const said = heardNow;
        // Our own loudspeaker plays into this microphone (no echo cancellation on this path), so the
        // transcript can contain the wake phrase simply because the AGENT said it. Two defences:
        //  · we never barge on words that are part of the sentence we are reading right now;
        //  · the phrase must have been heard in the last couple of seconds — the recogniser only
        //    appends, so a hit from earlier in the reply would otherwise stay armed for its whole tail.
        // Same two timing guards the voice barge uses: the attack transient + echo convergence at the
        // start of a clip, and the cooldown after an interruption. A 120 ms pop must not take the floor.
        const armed = Math.max(clipAtRef.current, playAtRef.current);
        const open = now - armed > BARGE_GRACE_MS && now - lastBargeRef.current > BARGE_COOLDOWN_MS;
        const voice = isBargeEvidence(mic, play, echoBaseRef.current, c.bargeSensitivity, micEchoCancelled());
        const want = wakeArmed({
          heard: said,
          own: spokenTextRef.current,
          heardAgoMs: now - saidAtRef.current,
          phrase: c.wakePhrase,
          graceOpen: open,
          evidence: voice,
          playRms: play,
          muted: mutedRef.current,
        });
        if (want) {
          lastBargeRef.current = now;
          dictation.resetText();   // a hit that stays in the transcript would re-fire on the next gap
          void bargeIn();
          return;
        }
        // Learn the echo while the gate is shut — same rule as the voice branch: feeding it the
        // operator's own voice would teach it to ignore them. A tick that MATCHED is never learned.
        if (play > 0.002 && !voice && !want) echoBaseRef.current = echoBaseRef.current * 0.88 + mic * 0.12;
        return;
      }
      // 「他在说话吗」 is now a step over the MEASURED room floor with a hangover, not an absolute
      // 0.010: a quiet voice used to fall under it (「我说完了它还等着」) and a phone's own speaker
      // used to sit over it (the call interrupting itself). See vad.ts.
      // Silero when it is loaded, the measured-floor gate otherwise (see vad.ts / silero.ts).
      const speechNow = phaseRef.current === "listening"
        ? (silero.ready ? silero.st.speech : vadStep(vadRef.current, mic, Date.now()))
        : false;
      if (phaseRef.current === "listening" && (speechNow || mic > VOICE_RMS)) voiceAtRef.current = Date.now();
      if (phaseRef.current === "listening") {
        setHeard((st.text + (st.interim ? ` ${st.interim}` : "")).trim());
        const text = (st.text || st.interim).trim();
        // 唤醒词在「听」的时候也必须被回应。以前关键词闸只在 speaking/thinking 张开，操作者对着
        // 已经说完的它连喊「小灵」毫无反应 —— 既没有打断，也没有任何「我听见了」的回音，读起来
        // 就是功能坏了。听见了就清空并且亮一下，同时这一句不再当成问题发出去。
        if (c.interruptMode === "keyword" && !mutedRef.current && text && matchesWakePhrase(text, c.wakePhrase)) {
          dictation.resetText();
          setWakeHit(Date.now());
          voiceAtRef.current = 0;
          return;
        }
        const quietFor = Date.now() - voiceAtRef.current;
        // `minChars` gates the AUTOMATIC send only: a tap on the orb is an explicit
        // "send this" and refusing it would read as a broken button.
        // 点按式收音期间一律不自动发（`manualRef`）：这条路径上"说完"是一个动作，不是一次停顿。
        if (text && !mutedRef.current && !pttRef.current && !manualRef.current && charCount(text) >= c.minChars
          && quietFor > c.silenceMs && !sentRef.current) {
          sentRef.current = true;
          setPhase("thinking");
          setHeard(text);
          setErr("");                  // a new question clears the previous failure
          baselineKeyRef.current = rawAgentKeyRef.current;   // the old answer is not the answer
          // stop feeding our own audio to the recogniser while the turn runs
          dictation.setRelay(false);
          // `interrupt`: if the agent is somehow still finishing the previous turn (the
          // cancel we send below is async), the server cancels it and queues this utterance
          // instead of refusing it. Without this the operator got "turn already running" for
          // doing exactly what a call invites.
          cockpit.send({ t: "prompt", sessionId, text, interrupt: true });
          // The recogniser is cleared the moment the words leave: it keeps its committed text
          // until told otherwise, and in 关键词 mode the next tick would read that leftover as
          // "the operator just said the wake phrase" and cancel the turn it just started.
          dictation.resetText();
        }
      } else if (phaseRef.current === "speaking") {
        // barge-in: the operator talking over the reply takes the floor back. Two things have
        // to happen — stop reading aloud (our own output goes quiet) AND cancel the agent's
        // turn. Stopping only the speaker left the turn running, so the sentence the operator
        // said next was refused with "turn already running": barge-in that doesn't hand the
        // floor over isn't barge-in.
        // The voice barge exists only in 语音打断 mode. In 按键打断 the floor changes hands on a
        // deliberate press and nothing else — that is the whole point of the mode.
        //
        // EVIDENCE, not just level: the microphone is compared against what WE are playing this
        // instant (see `isBargeEvidence`). An absolute bar was crossed by the call's own
        // loudspeaker on a phone lying on a table, and the call interrupted ITSELF mid-answer —
        // the operator's report was 「它刚输出一段话就自己打断自己，我都没说话」. Two timing
        // guards sit on top: nothing counts for the first `BARGE_GRACE_MS` of a clip (attack
        // transient + the echo canceller converging), and nothing counts for
        // `BARGE_COOLDOWN_MS` after a barge lands (its own tail).
        const now = Date.now();
        const armed = Math.max(clipAtRef.current, playAtRef.current);
        const open = now - armed > BARGE_GRACE_MS && now - lastBargeRef.current > BARGE_COOLDOWN_MS;
        // The echo's own level: a slow average of what the room (i.e. our own speaker) sends back
        // while the reply plays and nobody has spoken yet. It is only learned while the gate is
        // closed — feeding it the operator's voice would teach it to ignore them.
        const over = c.interruptMode === "voice" && !mutedRef.current && open
          && isBargeEvidence(mic, play, echoBaseRef.current, c.bargeSensitivity, micEchoCancelled());
        if (open && !over) echoBaseRef.current = echoBaseRef.current * 0.88 + mic * 0.12;
        bargeRef.current = over ? bargeRef.current + LOOP_MS : 0;
        if (bargeRef.current >= c.bargeMs) {
          bargeRef.current = 0;
          lastBargeRef.current = now;
          void bargeIn();
        }
      } else {
        bargeRef.current = 0;
      }
    }, LOOP_MS);
    return () => window.clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // ---- what the agent is saying: queue it sentence by sentence --------------------------
  const active = view.active?.info.id === sessionId ? view.active : undefined;
  const msgs = active?.msgs ?? [];
  // WHAT TO READ: the reply to the CURRENT prompt — the last agent message that comes AFTER
  // the last user message. The transcript's last agent message is NOT the same thing: while a
  // new turn is starting it is still the PREVIOUS answer, and reading that out is exactly what
  // the operator heard ("回复的时候把上一个问题的回复也念了一遍"). Joining a turn in flight is
  // still supported (then the in-flight message IS this turn's reply, read from its start),
  // but history is never spoken — a call is not a podcast of the session.
  const kinds = msgs.map((m) => m.kind);
  const lastUserIdx = kinds.lastIndexOf("user");
  const lastAgentIdx = kinds.lastIndexOf("agent");
  rawAgentKeyRef.current = lastAgentIdx >= 0 ? (msgs[lastAgentIdx] as { key?: string }).key ?? "" : "";
  const replyMsg = lastAgentIdx > lastUserIdx ? msgs[lastAgentIdx] : undefined;
  const agentText = replyMsg?.kind === "agent" ? replyMsg.text : "";
  const agentAt = replyMsg ? (replyMsg as { at?: number }).at ?? 0 : 0;
  const agentKey = replyMsg?.key ?? "";
  // A turn that ends without text (tool-only, or failed) must not leave the call stuck in
  // "thinking" with no explanation: the newest meta line after the prompt is the server's own
  // words about what happened.
  const lastMetaIdx = kinds.lastIndexOf("meta");
  const failureText = lastMetaIdx > lastUserIdx && msgs[lastMetaIdx]?.kind === "meta"
    ? (msgs[lastMetaIdx] as { text: string }).text
    : "";
  const busy = Boolean(active?.busy);

  // ---- the face (Tus 模式) ---------------------------------------------------------------
  // 三层来源按操作者拍板叠加：相位层（永远在，见 TusFace 的帧循环）→ 本地派生（无标签时的
  // 兜底）→ agent 写的 [emo:x] 标签（最高保真）。标签最终由 `stripEmoTags` 从**被念出来的文本**
  // 里剥掉，所以它只影响表情，不影响你听到的和读到的。
  /** 工具帧计数：一变，脸就点一下头（"手上有活"）。只数是本轮之后的行。 */
  const toolTicks = msgs.reduce((n, m) => n + (m.kind === "tool" ? 1 : 0), 0);
  const newest = msgs.length ? msgs[msgs.length - 1] : undefined;
  /** 最后一个工具行（哪怕后面已经跟了文本）：它 status 的终态变化是"完成/失败"的唯一事件源。 */
  const lastTool = ((): Extract<MsgView, { kind: "tool" }> | undefined => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.kind === "tool") return m;
    }
    return undefined;
  })();
  /** 比相位更细的活动：工具在跑 / 在等授权 / 在想。这正是"没有标准输出"的那些分钟。 */
  const faceActivity = activityOf({
    busy: busy || phase === "thinking",
    pending,
    newestKind: newest?.kind,
  });
  /** 工具子状态：读/跑/写/等/完成/失败。判据全部是行上已有的字段（title/kind2/status/pending），
   *  没有新增不可观测的来源。只有"最新一行是工具"时才成立 —— 后面已经出了文本，说明工具循环
   *  走完了，脸该回到想/说，而不是一直停在"完成"上。 */
  const newestTool = newest?.kind === "tool" ? newest : undefined;
  const faceSubstate: ToolSubstate = substateOf({
    busy: busy || phase === "thinking",
    pending,
    newestKind: newest?.kind,
    newestToolStatus: newestTool?.status,
    newestToolTitle: newestTool?.title,
    newestToolKind: newestTool?.kind2,
  });
  /** 脸此刻到底是哪一张（解析后的 mood）。只作为**观测钩子**：canvas 像素能证明在动，
   *  证明不了动的是哪张脸 —— sweep 和操作者都需要一个能读的答案。mood 变了才 setState，
   *  不是每帧（帧循环 30 fps，每帧 setState 会把整页会话一起重渲染）。 */
  const [faceMood, setFaceMood] = useState<TusMood | null>(null);
  const faceEmotion: TusMood | null = (() => {
    const tagged = readEmoTags(agentText);
    if (tagged.length) return tagged[tagged.length - 1];
    return deriveEmotion(stripEmoTags(agentText));
  })();
  /** 每帧向调用方要一次电平：说话时是播放，其余是麦克风。走 ref 不进 state（60 fps）。 */
  const faceLevel = (): number => {
    const v = phaseRef.current === "speaking" ? playbackLevel() : dictation.level();
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
  };

  /** Warm the clips of the sentences waiting in the queue.
   *  Called when a sentence ARRIVES as well as at the top of every turn: the reply streams in, so
   *  the sentence after the current one usually lands while the current one is already playing —
   *  a prefetch issued only when its turn comes could miss exactly that one. */
  const warmQueue = (): void => {
    for (const s of queueRef.current.slice(0, PREFETCH_SENTENCES)) speaker.prefetch(s, prefs);
  };

  useEffect(() => {
    // A reply is read whenever one ARRIVES — not only while the call happens to be in
    // thinking/speaking. A prompt typed into the composer while a call is up starts a turn while the
    // call still sits in `listening` (the auto-send that would flip it only exists in 语音打断 mode),
    // so a phase gate here left that reply silent forever: text rendered, no voice, and every
    // following turn in the same call stayed mute (#44).
    const p = phaseRef.current;
    if (p === "connecting" || p === "error") return;
    // Nothing to read yet, or the only agent message in play is the PREVIOUS answer: wait for a
    // message this turn actually produced.
    if (!agentKey || agentKey === baselineKeyRef.current) return;
    // The reply we interrupted: its message keeps streaming after the cancel, so the store still
    // hands us new text for it. Speaking that is the call talking to itself.
    if (agentKey && agentKey === cutKeyRef.current) return;
    // …and the same thing in time, for the block the cancelled turn flushed after the interruption
    // (its key is new, so the check above cannot see it).
    if (cutAtRef.current && agentAt && agentAt <= cutAtRef.current) return;
    // A call dialled onto a session whose transcript had not landed yet (cold start, deep link,
    // switching session then tapping the phone): boot saw no agent message, so the baseline stayed
    // empty and the first history page to arrive looked like a fresh reply. Whatever was already
    // there in the first seconds after dialling is history.
    if (!bootLockedRef.current) {
      bootLockedRef.current = true;
      if (!baselineKeyRef.current && !joinedRef.current && !sentRef.current
        && agentKey && Date.now() - bootAtRef.current < BOOT_GRACE_MS) {
        baselineKeyRef.current = agentKey;
        return;
      }
    }
    if (NON_ANSWER_RE.test(agentText.trim())) {      // a refusal, not an answer: never speak it
      setErr("刚才那句没被处理（这个会话正被另一个 Hermes 进程占用），再说一次即可。");
      void backToListening(false);
      return;
    }
    if (agentKey !== replyKeyRef.current) {          // a new reply started
      replyKeyRef.current = agentKey;
      queuedRef.current = 0;
      queueRef.current = [];
    }
    // [emo:x] 是给脸看的，不是给人念的。`splitForSpeech` 不剥方括号，所以必须在**进队列之前**剥。
    const { done, tail } = splitSentences(stripEmoTags(agentText));
    const fresh = done.slice(queuedRef.current);
    if (fresh.length) {
      queuedRef.current = done.length;
      queueRef.current.push(...fresh);
      setReply((r) => `${r}${r ? " " : ""}${fresh.join(" ")}`);
      if (phaseRef.current !== "speaking") setPhase("speaking");
      warmQueue();                                   // ask for it the moment it exists
    }
    if (!busy && tail) {                             // turn over: flush the last fragment
      if (queuedRef.current >= done.length) {
        queuedRef.current = done.length + 1;
        queueRef.current.push(tail);
        setReply((r) => `${r}${r ? " " : ""}${tail}`);
      }
    }
    if (!busy && phaseRef.current === "thinking" && !queueRef.current.length && done.length === 0 && !tail) {
      // a turn with no text at all: do not sit in "thinking" forever, and say why if the
      // server said anything (turn failed, permission denied, …)
      if (failureText) setErr(failureText);
      void backToListening(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentText, agentKey, busy, failureText]);

  // the speaker: one sentence at a time, in order
  useEffect(() => {
    if (phaseRef.current !== "speaking" || queueRunRef.current) return;
    queueRunRef.current = true;
    void (async () => {
      // try/finally, because `queueRunRef` is the only lock this loop has: a rejection that escapes
      // would leave it `true` for the rest of the call and no sentence would ever be handed to the
      // speaker again — a mute call with no error anywhere (#44's 「打着打着突然不播放了」).
      try {
        while (aliveRef.current && queueRef.current.length && phaseRef.current !== "error") {
          const sentence = queueRef.current.shift() as string;
          // Generate the NEXT sentences while this one plays. Sequentially, the call went silent
          // between sentences for as long as the next one took to synthesise and arrive
          // (0.5–1.5 s measured) — the operator hears that as "播报很慢".
          warmQueue();
          clipAtRef.current = Date.now();       // arms the grace window for THIS clip
          echoBaseRef.current = 0;              // this clip's echo is not the last one's
          spokenTextRef.current = sentence;
          try {
            // Race, because `speak()` has TWO ways to never settle: a synthesis request that stops
            // answering, and an `<audio>` element on a stream that went dead. Awaiting it plainly is
            // what made the call go permanently silent (#44) — and now the watchdog needs a way to
            // say 「skip this one」 without hanging up.
            await new Promise<void>((resolve, reject) => {
              abandonRef.current = () => reject(new Error("clip abandoned"));
              void speaker.speak(sentence, "call", prefs).then(resolve, reject);
            });
          } catch {
            /* this clip failed or was abandoned; the sentences behind it still get their turn */
          } finally {
            abandonRef.current = null;
            spokenTextRef.current = "";
          }
          // barged in, hung up, or the call is gone: never hand another sentence to the speaker
          if (!aliveRef.current || phaseRef.current !== "speaking") break;
        }
      } catch {
        /* speak() reports its own failures; a throw here must not kill the loop's lock */
      } finally {
        queueRunRef.current = false;
        if (aliveRef.current && phaseRef.current === "speaking" && !queueRef.current.length && !busy) {
          void backToListening(false);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, reply, busy]);

  // ---- watchdog: the call is never left mute ---------------------------------------------
  // 「打着打着，他突然不播放了」 has no single cause — a reply that reached the queue through a path
  // the gate did not cover, a speaker run that ended between sentences, a TTS that failed every
  // sentence. All of them end in the SAME observable state: phase speaking/thinking, nothing queued,
  // nothing playing, no turn in flight. So the state is what gets checked, not the cause, and the
  // call hands the floor back instead of sitting silent until it is hung up and reopened.
  const busyRef = useRef(false);
  busyRef.current = busy;
  const spokenRef = useRef(spoken);
  spokenRef.current = spoken;
  const starveRef = useRef(0);
  useEffect(() => {
    const iv = window.setInterval(() => {
      const p = phaseRef.current;
      if (p !== "speaking" && p !== "thinking") { starveRef.current = 0; return; }
      // Claimed-speech-that-is-silent. Two budgets, because the honest evidence differs:
      //  · metered playback (server TTS + an analyser): 「speaking」 with no audible output for
      //    MUTE_MS is a fault — nothing that is really playing is silent for 15 s;
      //  · unmetered playback (browser voice / `<audio>`): there is NO level to read, so the only
      //    fact available is 「this clip has been in flight for absurdly long」 → STUCK_MS.
      // Either way the recovery is 「skip this clip」, never 「hand the floor back」: dropping the rest
      // of the reply is the very symptom being fixed, and re-reading the turn from the top is worse.
      if (phaseRef.current === "speaking" && spokenRef.current.speaking) {
        const metered = playRmsRef.current >= 0;
        const silentFor = Date.now() - Math.max(audibleRef.current, clipAtRef.current);
        const stuck = metered ? silentFor > MUTE_MS : silentFor > STUCK_MS;
        if (stuck) {
          starveRef.current = 0;
          setErr(spokenRef.current.error
            || (metered ? "这一句卡住了（合成或播放没有响应），已跳过它继续往下念。" : "这一句卡住了，已跳过它继续往下念。"));
          abandonRef.current?.();
          speaker.stop();
          return;
        }
      }
      const idle = !queueRunRef.current && !queueRef.current.length
        && !spokenRef.current.speaking && !busyRef.current;
      if (!idle) { starveRef.current = 0; return; }
      if (!starveRef.current) { starveRef.current = Date.now(); return; }
      if (Date.now() - starveRef.current < STARVE_MS) return;
      starveRef.current = 0;
      // Say it when the speaker knows why: a recovery the operator can see is worth more than a
      // silent one, and 「为什么它不说话了」 needs an answer on the call itself.
      if (spokenRef.current.error) setErr(spokenRef.current.error);
      void backToListening(false);
    }, 1000);
    return () => window.clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  /** Talking over the agent: drop our playback, cancel ITS turn, listen again.
   *
   *  The cancel goes out ONLY when a turn is actually in flight. The call stays in its `speaking`
   *  phase for as long as the reply is being read out, and the agent's turn usually ends well before
   *  that — so "speaking" is not evidence of a running turn. A cancel on an IDLE session is not a
   *  no-op on the agent side: it leaves a hard interrupt pending, and the NEXT turn then dies at its
   *  turn-lease admission with the refusal notice above (the server refuses the same cancel too, as
   *  a second line of defence). */
  const bargeIn = async (): Promise<void> => {
    takeFloor();     // 停播 + 取消回合 + 清队列：这一句回答到此为止
    await backToListening(false);
  };

  /** 抢过话筒的那三步（停播、取消在跑的回合、清掉没念的队列）——三处入口共用：打断按钮、
   *  按住说话、点按式收音。抄三份的话，改一处就会漏两处。 */
  const takeFloor = (): void => {
    cutKeyRef.current = rawAgentKeyRef.current || replyKeyRef.current;   // this reply is over
    cutAtRef.current = Date.now();
    speaker.stop();
    const running = cockpit.getSnapshot().sessions.find((s) => s.id === sessionId)?.status === "running";
    if (running) cockpit.send({ t: "cancel", sessionId });
    queueRef.current = [];
    queuedRef.current = 0;
    queueRunRef.current = false;
    sentRef.current = false;
    audibleRef.current = Date.now();     // the floor changed hands: no clip is owed a sound
    // 关键词模式在回答期间一直开着 relay（它得听见唤醒词），所以那个识别任务里装的是
    // 我们自己念出来的回答。换手时把任务换掉：只 resetText() 清的是本地文本，服务端
    // 还会把剩下的句子按 asr-final 送回来 —— 挂断后它就变成输入框里「模型的最后几句话」。
    dictation.setRelay(false);
    dictation.resetText();
  };

  /** Back to the operator's turn: fresh transcript, mic relaying again. */
  const backToListening = async (interrupted: boolean): Promise<void> => {
    if (!aliveRef.current) return;      // the call is closed: no state, no microphone
    if (interrupted) speaker.stop();
    manualRef.current = false;          // 轮到别人的时候，点按式收音不该还挂着
    setManual(false);
    queueRef.current = [];
    queuedRef.current = 0;
    queueRunRef.current = false;
    sentRef.current = false;
    audibleRef.current = Date.now();     // the floor changed hands: no clip is owed a sound
    setPhase("listening");
    setReply("");
    setHeard("");
    voiceAtRef.current = Date.now();
    // 回到「听」之前先把上一段识别任务扔掉：回答期间（关键词模式）它听到的是我们自己的
    // TTS，不换任务的话剩余句子会接着作为「他刚才说的」冒出来。关掉再开 = 新会话，
    // 采集图不动，所以麦克风不会闪一下。
    dictation.setRelay(false);
    dictation.resetText();
    // 按键模式：回答结束「轮到你了」，但轮到你还不需要开麦 —— 他想说话时会按住圆球。以前这里无条件
    // 续上听写，于是每轮结束都自己把麦克风打开，页面顶上的录音指示一直亮着，他也分不清到底在不在听
    // （#51）。听写保持关闭，`pttStart` 会自己打开。
    if (cfgRef.current.interruptMode === "button") return;
    try {
      const st = dictation.getSnapshot();
      if (st.status === "transcribing") dictation.cancel();
      if (st.status === "idle" || st.status === "error" || st.status === "transcribing") {
        const ok = await dictation.start(prefs, sessionId);
        if (!ok) throw new Error(dictation.getSnapshot().error || "无法打开麦克风");
        dictation.setRelay(true);
      } else {
        dictation.setRelay(true);
      }
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
      setPhase("error");
    }
  };

  const hangUp = (): void => {
    // the call ends HERE: anything queued or in flight must not leave the speaker after the
    // screen is gone ("挂断的时候它有时候还在说话")
    aliveRef.current = false;
    speaker.stop();
    dictation.cancel();   // the call's transcript is the call's; never hand it to the chat composer
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
    // 按键打断模式：圆球和左键是同一套语义 —— 一次点击开始听（它正在说就先打断），再点一次结束并发出去。
    // 这里不能走下面的"有文本就发"分支：那种分支只在 voice/keyword 的持续听写下才有意义。
    if (cfgRef.current.interruptMode === "button") {
      if (manualRef.current) manualStop();
      else await manualStart();
      return;
    }
    if (p === "listening") {
      const st = dictation.getSnapshot();
      const text = (st.text || st.interim).trim();
      if (text) {
        sentRef.current = true;
        setPhase("thinking");
        setErr("");
        baselineKeyRef.current = rawAgentKeyRef.current;     // the old answer is not the answer
        dictation.setRelay(false);
        cockpit.send({ t: "prompt", sessionId, text, interrupt: true });
        dictation.resetText();   // see the auto-send branch: 关键词 must not re-hear this utterance
      }
      return;
    }
    if (p === "speaking") { await bargeIn(); return; }
    if (p === "thinking") { await bargeIn(); return; }   // stop the turn, take the floor back
    if (p === "error") await backToListening(false);
  };

  /** PUSH-TO-TALK: hold to talk, release to send.
   *
   *  Why it exists (the operator's words): 「有的时候打断他，我这句话还没说完，他就显示录入完成了」。
   *  The automatic end-of-utterance is a guess — it listens for a pause — and a caller who stops to
   *  think, or whose recogniser finalises a segment early, gets cut off mid-sentence. Holding a
   *  button replaces the guess with a decision: while it is down nothing auto-sends (the loop checks
   *  `pttRef`), and letting go sends exactly what was said.
   *
   *  It also takes the floor: playback stops and a running turn is cancelled, so "hold to answer"
   *  works while the agent is still talking. That is the same contract as `bargeIn`. */
  const pttStart = async (): Promise<void> => {
    if (pttRef.current || !aliveRef.current) return;
    pttRef.current = true;
    setHolding(true);
    manualRef.current = false;          // 按住说话与点按式收音互斥，谁先按下算谁
    setManual(false);
    takeFloor();
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
      }
      dictation.setRelay(true);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
      setPhase("error");
    }
  };

  /** "I have said what I wanted" — the ONE thing both endings need: PTT release, and the
   *  说完了 button while dictating in voice mode. Sending is the same act either way: stop feeding
   *  our own audio to the recogniser, take what it has, and hand it over as the turn. */
  const sendHeard = (): void => {
    const st = dictation.getSnapshot();
    const text = (st.text || st.interim).trim();
    if (!text) return;
    sentRef.current = true;
    setPhase("thinking");
    setHeard(text);
    setErr("");
    manualRef.current = false;     // 这句话已经发出，点按式收音随之结束
    setManual(false);
    baselineKeyRef.current = rawAgentKeyRef.current;
    // 麦克风归还：按键模式没有"连续听"这回事，这句话交出去之后采集图就该断（#53 的遗留半口子）。
    // 只有 `setRelay(false)` 是不够的 —— 它关的只是转写 socket，采集图是特意留着喂 levels/barge-in 的，
    // 于是麦克风一直开着，Chromium 的录音灯在 agent 回答的整段时间里都亮着，直到下一轮结束才被顺手关掉。
    // voice/keyword 模式必须留着采集图：它们的打断靠电平与 VAD，不是靠人点。
    if (cfgRef.current.interruptMode === "button") dictation.cancel();
    else dictation.setRelay(false);
    cockpit.send({ t: "prompt", sessionId, text, interrupt: true });
    dictation.resetText();     // same reason as the other two send paths
  };

  const pttEnd = (): void => {
    if (!pttRef.current) return;
    pttRef.current = false;
    setHolding(false);
    const st = dictation.getSnapshot();
    const text = (st.text || st.interim).trim();
    if (!text) {
      // Nothing was said: hand the floor back rather than leaving a dead mic. In button mode there is
      // no continuous listening to hand it back TO — the mic goes away with the attempt.
      dictation.resetText();
      if (cfgRef.current.interruptMode === "button") {
        dictation.cancel();
        void backToListening(false);
        return;
      }
      dictation.setRelay(true);
      setPhase("listening");
      return;
    }
    sendHeard();
  };

  /** 点按式收音 · 开始：点「开始说话」（或在大模型输出时点「打断」）—— 停播/取消回合，然后开麦，
   *  文案变「结束」。之后不再有任何自动判断：`manualRef` 让主循环的自动发送分支整段跳过。 */
  const manualStart = async (): Promise<void> => {
    if (!aliveRef.current) return;
    pttRef.current = false;
    setHolding(false);
    takeFloor();
    manualRef.current = true;
    setManual(true);
    setPhase("listening");
    setReply("");
    setHeard("");
    setErr("");
    voiceAtRef.current = Date.now();
    try {
      dictation.cancel();          // 上一句的残留文本/连接必须先断，再开新的
      const ok = await dictation.start(prefs, sessionId);
      if (!ok) throw new Error(dictation.getSnapshot().error || "无法打开麦克风");
      dictation.setRelay(true);
    } catch (e) {
      manualRef.current = false;
      setManual(false);
      setErr(String((e as Error)?.message ?? e));
      setPhase("error");
    }
  };

  /** 点按式收音 · 结束：他说完了，这才是发送动作。一个字都没有 = 取消（同 pttEnd 的空文本分支）。 */
  const manualStop = (): void => {
    manualRef.current = false;
    setManual(false);
    const st = dictation.getSnapshot();
    const text = (st.text || st.interim).trim();
    if (!text) {
      dictation.cancel();
      void backToListening(false);
      return;
    }
    sendHeard();
  };

  // ---- 空格：按住说话，轻点打断 ----------------------------------------------------------
  // 手放在键盘上的时候，圆球离手指很远。按住空格是打电话的人最熟的手势，而「轻点一下」在通话里
  // 只有一个意思：轮到我说了 / 你别说了。两个动作占用同一个键，用按住时长区分（<150ms = 轻点）。
  // 正在往输入框里打字时不管 —— 那里空格就是个空格（#51）。
  const spaceRef = useRef<{ at: number } | null>(null);
  const keyActsRef = useRef({ pttStart, pttEnd, backToListening });
  keyActsRef.current = { pttStart, pttEnd, backToListening };
  useEffect(() => {
    const typing = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      if (!el || !el.tagName) return false;
      return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
    };
    const down = (e: KeyboardEvent): void => {
      if (e.code !== "Space" || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!aliveRef.current || typing(e.target)) return;
      e.preventDefault();            // 空格默认会滚动页面 / 按到当前聚焦的按钮
      // 点按式收音进行中，空格完全不参与：否则误触一下，keydown 会走 pttStart（清掉 manual、抢话筒），
      // keyup 的轻点分支再 cancel + backToListening —— 半句话就没了。这条路径的两个动作都在左键上。
      if (cfgRef.current.interruptMode === "button" && manualRef.current) return;
      if (spaceRef.current) return;
      spaceRef.current = { at: Date.now() };
      void keyActsRef.current.pttStart();
    };
    const up = (e: KeyboardEvent): void => {
      if (e.code !== "Space" || !spaceRef.current) return;
      const held = Date.now() - spaceRef.current.at;
      spaceRef.current = null;
      e.preventDefault();
      if (held < 150) {
        // 刚按下就松开 = 没说任何话。打断这件事 pttStart 已经做了（停播 + 取消回合），所以这里**不再**
        // 走 tapOrb：在已经空闲的会话上再发一次 cancel 会留下一个待生效的硬打断，下一个回合会死在
        // turn-lease 准入上（见文件顶部那条注释）。只把「轮到你说」摆回来。
        pttRef.current = false;
        setHolding(false);
        dictation.cancel();
        void keyActsRef.current.backToListening(false);
        return;
      }
      keyActsRef.current.pttEnd();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // ---- the animation -------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    const wave = waveRef.current;
    if (!canvas || !wave) return;
    const ctx = canvas.getContext("2d");
    const wctx = wave.getContext("2d");
    if (!ctx || !wctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    /** The transcript view paints this same canvas full-bleed, blurred, behind a frosted panel —
     *  out-of-focus pixels do not need the same density, and a full-screen canvas at dpr 2 is the
     *  one thing in this file that could cost a phone frames. */
    const px = (): number => (captionRef.current ? 1.25 : dpr);
    const waveBuf = new Float32Array(96);
    let raf = 0;
    let frame = 0;

    const size = (): void => {
      const d = px();
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(r.width * d));
      canvas.height = Math.max(1, Math.round(r.height * d));
      const wr = wave.getBoundingClientRect();
      wave.width = Math.max(1, Math.round(wr.width * d));
      wave.height = Math.max(1, Math.round(wr.height * d));
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(canvas);
    ro.observe(wave);

    const draw = (t: number): void => {
      raf = window.requestAnimationFrame(draw);
      // In the transcript view the ball is blurred light behind glass: 30 fps is indistinguishable
      // there and halves the phone's work, while the stage view keeps every frame.
      if (captionRef.current && (frame++ & 1)) return;
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

      const s = px();
      const W = canvas.width / s, H = canvas.height / s;
      ctx.setTransform(s, 0, 0, s, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const cx = W / 2, cy = H / 2;
      /* Full-bleed behind the transcript the ball wants to be a light SOURCE, larger than the
         screen so the blur has no visible edge; in the stage view it is an object on the page. */
      const base = Math.min(W, H) * (captionRef.current ? 0.52 : 0.33);

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
      const WW = wave.width / s, WH = wave.height / s;
      wctx.setTransform(s, 0, 0, s, 0, 0);
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

  // Follow the newest line ONLY while the operator is at the bottom: scrolling back to read something
  // must not be yanked away by the next streamed chunk (the same rule the transcript uses).
  const histLast = msgs.length ? histLine(msgs[msgs.length - 1]).text : "";
  useEffect(() => {
    if (!histOpen || !histAtBottom) return;
    const el = histRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [histOpen, histAtBottom, msgs.length, histLast]);

  const onHistScroll = (): void => {
    const el = histRef.current;
    if (!el) return;
    setHistAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  };
  const toLatest = (): void => {
    const el = histRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setHistAtBottom(true);
  };
  const toggleHist = (): void => {
    if (!histOpen) setHistAtBottom(true);      // opening lands on the newest line
    setHistOpen(!histOpen);
  };

  // ---- captions (the transcript view) ------------------------------------------------------
  const toggleCaption = (): void => {
    const next = !caption;
    setCaption(next);
    if (next) setCcAtBottom(true);             // opening lands on the newest line
    try {
      localStorage.setItem(CAPTION_KEY, next ? "1" : "0");
    } catch {
      /* private mode: the choice just does not survive a reload */
    }
  };
  const onCcScroll = (): void => {
    const el = ccRef.current;
    if (!el) return;
    setCcAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 28);
  };
  const toLatestCc = (): void => {
    const el = ccRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setCcAtBottom(true);
  };
  // Follow the newest line ONLY while the operator is at the bottom — the same rule as the
  // transcript and the history window: scrolling back to read must not be yanked away by the next
  // streamed chunk.
  useEffect(() => {
    if (!caption || !ccAtBottom) return;
    const el = ccRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [caption, ccAtBottom, msgs.length, heard, reply, phase]);

  // Saying something short and having nothing happen is the worst kind of silence: the hint
  // names the reason instead of leaving the operator to guess (the minChars knob).
  const heardCount = charCount(heard);
  // …and it stays on screen: the reason a short utterance was not sent has to be visible
  // while the words themselves are, or the silence is unexplained.
  const tooShort = phase === "listening" && heardCount > 0 && heardCount < cfg.minChars;
  // 关键词模式要有回音：设了唤醒词却什么都没发生时，操作者无法区分「没听见」和「听见了但不匹配」。
  // 所以这不只是提示文案，是这条链路唯一的观测点 —— 听见什么、唤醒词是什么，都摆在屏幕上。
  const kwHint = cfg.interruptMode === "keyword"
    ? `唤醒词「${cfg.wakePhrase || "未设置"}」${heard ? ` · 听到：${heard.slice(-18)}` : ""}`
    : "";
  const hint = (phase === "listening" && wakeHit)
    ? `听到「${cfg.wakePhrase}」了`
    : phase === "listening"
    ? (heard
      ? (heardCount < cfg.minChars
        ? `太短了（少于 ${cfg.minChars} 字，不会自动发送）——继续说，或点一下圆球直接发送`
        : "点一下直接发送，或说完停一下")
      // 按键模式平时不开麦（#51），提示就得说清楚麦是怎么开的，否则「说点什么…」是句空话。
      : muted ? "麦克风已静音"
        : cfg.interruptMode === "button"
          ? manual ? "正在听你说，说完点「结束」" : "点「开始说话」，或按住圆球/空格说话"
          : (kwHint || "说点什么…"))
    : phase === "speaking" ? (cfg.interruptMode === "voice" ? "说一句就能打断它，点圆球也可以"
      : cfg.interruptMode === "keyword" ? `${kwHint} · 说唤醒词打断`
        : "点「打断」就开口，说完再点「结束」")
      : phase === "thinking" ? (cfg.interruptMode === "keyword" ? `${kwHint} · 说唤醒词打断`
        : cfg.interruptMode === "button" ? "点「打断」就开口，说完再点「结束」" : "点一下停止它") : "";

  /** The transcript view's two floor controls.
   *
   *  In that view the orb is behind the frosted panel (`pointer-events: none`) — the operator's
   *  words were 「这个按键打断都没地方摁啊」, and then 「有的时候打断他，我这句话还没说完，他就显示
   *  录入完成了……能不能改成按住说话那种？两个按钮，左边打断，右边按住说话」.
   *
   *  So there are two of them, and they answer the two different questions a call asks:
   *   · 打断  — stop it now, the floor is mine (enabled only while there IS something to stop);
   *   · 按住说话 — nobody guesses when my sentence ends: I let go when it ends. */
  const canTake = phase === "speaking" || phase === "thinking";
  /** WHO holds the floor decides what the row says — one question, three answers:
   *   · the AGENT is talking  → 打断 | 按住说话      (two ways to take it back)
   *   · I am dictating        → 说完了               (one button, and its only job is to end it)
   *   · nobody is talking yet → 按住说话             (the only useful thing here)
   *  The operator's words: 「为什么一直显示打断啊，不是应该根据状态变吗」 and 「识别到正在说话时是不是
   *  两个按钮合二为一成一个按钮吧，文案和功能变成结束」. A dead 打断 next to a live row was the whole
   *  complaint, so when there is nothing to interrupt it is not rendered at all.
   *  NOT collapsed while PTT is held: replacing a button mid-press would drop the pointer and lose
   *  the hold — the held button keeps its own label (松开发送) instead. */
  const dictating = phase === "listening" && !holding && heard.trim().length > 0;
  /** One definition, two states: the same DOM node must survive a press (see above). */
  const pttButton = (
    <button
      type="button"
      className={`call-floor is-ptt${holding ? " on" : ""}`}
      onPointerDown={(e) => { e.preventDefault(); try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not supported */ } void pttStart(); }}
      onPointerUp={(e) => { e.preventDefault(); pttEnd(); }}
      onPointerCancel={() => pttEnd()}
      onLostPointerCapture={() => pttEnd()}
      onContextMenu={(e) => e.preventDefault()}
      aria-pressed={holding}
      title="按住说话，松开就发出去；按住的时候不会自动发送"
      aria-label={holding ? "松开发送" : "按住说话"}
    >
      <IconMic size={17} />
      <span>{holding ? "松开发送" : "按住说话"}</span>
    </button>
  );

  /* WHO interrupts: a two-ended switch on the call, not a knob in the settings sheet. It belongs
     on the call because it is the one setting that changes with the ROOM (a phone on a table, a
     headset, a noisy cafe) — flipping it has to be one tap while the call is misbehaving, and both
     ends stay visible so the current mode is never a guess.
     ONE definition, two homes: the call's header in the stage view, the transcript panel's toolbar
     in the captions view. Neither view is allowed to make it a sheet-only option. */
  const shownModes = INTERRUPT_MODES.filter((m) => m.id !== "voice" || voiceMode || cfg.interruptMode === "voice");

  const modesSwitch = (
    <div className="call-modes" role="group" aria-label="打断方式" data-mode={cfg.interruptMode}>
      {shownModes.map((m) => (
        <button
          key={m.id}
          type="button"
          className={`call-mode-btn ${cfg.interruptMode === m.id ? "on" : ""}`}
          aria-pressed={cfg.interruptMode === m.id}
          title={m.hint}
          onClick={() => applyCfg({ interruptMode: m.id })}
        >
          {m.label}
        </button>
      ))}
    </div>
  );

  return createPortal(
    <div className="call-mode" data-phase={phase} data-mood={tus ? faceEmotion : undefined} data-face={tus ? faceMood ?? undefined : undefined} data-substate={tus ? faceSubstate : undefined} data-caption={caption} data-tus={tus ? "true" : "false"} role="dialog" aria-modal="true" aria-label={tus ? "Tus 模式通话" : "语音通话"}>
      <button
        type="button"
        className="call-gear"
        onClick={() => setShowCfg(true)}
        aria-label="通话设置"
        title="通话设置"
      >
        <IconSettings size={18} />
      </button>

      {/* 字幕 — the transcript toggle. Top-right, next to the gear: Gemini Live puts its captions
          button in the same corner, and this one has to be reachable without opening a sheet
          (turning the words on is a reaction to "what did it just say?", not a preference). */}
      <button
        type="button"
        className={`call-cc-btn${caption ? " on" : ""}`}
        onClick={toggleCaption}
        aria-pressed={caption}
        aria-label={caption ? "收起聊天记录" : "显示聊天记录"}
        title={caption ? "收起聊天记录" : "显示聊天记录"}
      >
        <IconSubtitles size={18} />
      </button>

      {/* The stage header exists only in the stage view: the transcript view's toolbar carries the
          same switch, and drawing both would say the phase twice and cost the record 44px. */}
      {!caption && !tus ? (
        <div className="call-head">
          <span className="call-title">{PHASE_LABEL[phase]}</span>
          <span className="call-sub">{muted ? "麦克风已静音" : "免提 · 语音通话"}</span>
          {modesSwitch}
        </div>
      ) : null}

      <button
        type="button"
        className="call-orb"
        onClick={() => void tapOrb()}
        aria-label={`${PHASE_LABEL[phase]} — ${hint || "点击切换"}`}
        title={hint}
      >
        <canvas ref={canvasRef} className="call-orb-canvas" />
      </button>

      {/* 表情区：竖屏在上、横屏在左（CSS 分区，见 theme.css 里的 data-tus 段）。它不是装饰——
          通话里最长的那段时间（跑工具、等你授权）它一个字都不输出，屏幕上唯一的活物就是这张脸。 */}
      {tus ? (
        <div className="call-tus-face" data-substate={faceSubstate}>
          <TusFace
            phase={phase}
            activity={faceActivity}
            substate={faceSubstate}
            emotion={faceEmotion}
            ticks={toolTicks}
            toolStatus={lastTool?.status ?? ""}
            getLevel={faceLevel}
            onMood={setFaceMood}
          />
          <div className="tus-face-foot">
            <span className="tus-face-state">{PHASE_LABEL[phase]}</span>
            {tus && !cfg.wakePhrase ? (
              <span className="tus-face-warn" title="Tus 模式固定用关键词打断；没设唤醒词时只有点圆球/按住说话能抢话筒">
                Tus 模式用关键词打断 · 还没设唤醒词
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {caption || tus ? (
        /* The transcript view: the page is the words. The ball is still there (the canvas is
           untouched, `.call-orb` is just moved behind the frosted panel by CSS), so the phases keep
           their colour and the reply keeps pulsing — it is the LIGHT behind the text, not a
           decoration competing with it. */
        <div className="call-cc">
          <div className="call-cc-head">
            {/* The phase chip is the floor control in this view: the orb itself is behind glass
                and out of reach, so "take the floor back / send what I said" has to keep a home. */}
            <button
              type="button"
              className="call-cc-state"
              onClick={() => void tapOrb()}
              title={hint || "点击切换"}
              aria-label={`${PHASE_LABEL[phase]} — ${hint || "点击切换"}`}
            >
              <span className="call-cc-dot" aria-hidden="true" />
              {PHASE_LABEL[phase]}
            </button>
            {modesSwitch}
            <span className="call-cc-n">{msgs.length} 条</span>
          </div>
          <div className="call-cc-list" ref={ccRef} onScroll={onCcScroll} role="log" aria-live="polite">
            {/* THE CHAT PAGE'S ROWS, not a summary of them. The operator's instruction was
                「就用我们现在的这个聊天页面……UI 不要变」: same agent mark and name, same YOU,
                same collapsible thinking, tool cards and plan cards, same streaming markdown.
                `renderTranscript` is `App`'s own renderer (see the prop's comment) so there is
                exactly one implementation of these rows in the app. */}
            <div className="call-cc-inner">
              {renderTranscript && active
                ? renderTranscript({
                  msgs,
                  sid: sessionId,
                  backend: active.info.backend,
                  busy: Boolean(active.busy),
                  base: active.info.workspace || active.info.cwd,
                  // 耳朵里已经在念这句话了，转录里就不该再标「思考中…」——两个相反的信号。
                  speaking: phase === "speaking",
                })
                : null}
              {/* What the recogniser has so far is not a message yet (it has not been sent), but in
                  this view it is the row the operator is watching — so it takes the user's shape,
                  down to the same YOU label. */}
              {phase === "listening" && heard ? (
                <div className="msg user live">
                  <div className="role">YOU</div>
                  <div className="bubble">{heard}</div>
                </div>
              ) : null}
              {err ? <p className="call-err">{err}</p> : null}
              {/* The speaker's own failure, which used to be visible only in the composer — i.e.
                  never during a call. A call that stops talking must say why. */}
              {!err && spoken.error ? <p className="call-err">{spoken.error}</p> : null}
              {!err && spoken.note ? <p className="call-note">{spoken.note}</p> : null}
              {(!heard && !msgs.length) || tooShort ? <p className="call-hint">{hint}</p> : null}
            </div>
          </div>
          {/* Floating, not in the toolbar: it only exists while the operator is reading back, and
              the toolbar already carries phase + interrupt mode + the count. */}
          {!ccAtBottom ? (
            <button type="button" className="call-cc-latest" onClick={toLatestCc}>回到最新 ↓</button>
          ) : null}
          {/* TWO BUTTONS, not one: 打断 on the left (stop it, the floor is mine) and 按住说话 on the
              right (hold to talk, release to send — my sentence ends when I say it does, not when a
              silence timer guesses). Both are thumb-sized (48px) and both say what they do without
              an icon to decode. Pressing either one takes the floor from a talking agent.
              按键打断模式下左键常驻、文案随状态走（操作员 2026-10-23：「它输出的时候显示打断，
              空闲显示开始说话，点完变成结束」）：点一下开始说，说完再点一下才发出去 —— 这条路径上
              没有任何自动判断，麦克风的开关和这句话的结束都由人两次点击决定。 */}
          <div className={`call-floor-row${canTake || cfg.interruptMode === "button" ? "" : " single"}`}>
            {cfg.interruptMode === "button" ? (
              <>
                <button
                  type="button"
                  className={`call-floor is-take${manual ? " on" : ""}`}
                  onClick={() => { if (manual) manualStop(); else void manualStart(); }}
                  title={canTake
                    ? "停下它，接着说你的"
                    : manual
                      ? "说完了，再点一下就发出去"
                      : "点一下开始说，说完再点一下发送；不会自己发出去"}
                  aria-label={canTake ? "打断" : manual ? "结束" : "开始说话"}
                  aria-pressed={manual}
                >
                  {canTake ? <IconStop size={17} /> : manual ? <IconSend size={17} /> : <IconMic size={17} />}
                  <span>{canTake ? "打断" : manual ? "结束" : "开始说话"}</span>
                </button>
                {pttButton}
              </>
            ) : !canTake ? (
              dictating ? (
                <button
                  type="button"
                  className="call-floor is-done"
                  onClick={() => sendHeard()}
                  title="说完了就把这句发出去，不用等它判断停顿"
                  aria-label="说完了"
                >
                  <IconSend size={17} />
                  <span>说完了</span>
                </button>
              ) : (
                pttButton
              )
            ) : (
              <>
                <button
                  type="button"
                  className="call-floor is-take"
                  onClick={() => void bargeIn()}
                  title="停下它，接着说你的"
                  aria-label="打断"
                >
                  <IconStop size={17} />
                  <span>打断</span>
                </button>
                {pttButton}
              </>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="call-lines">
            {heard ? <p className="call-heard">{heard}</p> : null}
            {reply ? <p className="call-reply">{reply}</p> : null}
            {err ? <p className="call-err">{err}</p> : null}
            {!err && spoken.error ? <p className="call-err">{spoken.error}</p> : null}
            {!err && spoken.note ? <p className="call-note">{spoken.note}</p> : null}
            {(!heard && !reply && !err) || tooShort ? <p className="call-hint">{hint}</p> : null}
          </div>

          {/* Browsing what was already said, without leaving the call. Collapsed it is one bar (44px, a
              thumb target); open it scrolls — overscroll stays inside it, so the call page never moves. */}
          <div className="call-hist" data-open={histOpen}>
            <button
              type="button"
              className="call-hist-bar"
              onClick={toggleHist}
              aria-expanded={histOpen}
              aria-label={histOpen ? "收起历史聊天记录" : "翻阅历史聊天记录"}
              title={histOpen ? "收起" : "翻阅历史聊天记录"}
            >
              <IconHistory size={15} />
              <span className="call-hist-title">历史记录</span>
              <span className="call-hist-n">{msgs.length} 条</span>
              {!histOpen && histLast ? <span className="call-hist-peek">{histLast.slice(0, 60)}</span> : null}
              <span className="call-hist-chev" aria-hidden="true"><IconChevronDown size={14} /></span>
            </button>
            {histOpen ? (
              <>
                <div className="call-hist-list" ref={histRef} onScroll={onHistScroll}>
                  {msgs.map((m, i) => {
                    const l = histLine(m);
                    return <HistRow key={m.key} kind={l.kind} who={l.who} text={l.text} current={i === msgs.length - 1 && phase === "speaking"} />;
                  })}
                </div>
                {!histAtBottom ? (
                  <button type="button" className="call-hist-back" onClick={toLatest}>回到最新 ↓</button>
                ) : null}
              </>
            ) : null}
          </div>
        </>
      )}

      {/* Kept mounted in BOTH views. The animation loop owns this canvas together with the orb's,
          and a call that STARTED with captions on would otherwise find no wave node and animate
          nothing at all (that effect runs once, on mount). The transcript view hides it in CSS. */}
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

      {showCfg ? (
        <div className="call-sheet" role="dialog" aria-label="通话设置">
          <div className="call-sheet-card">
            <div className="call-sheet-head">
              <span>通话设置</span>
              <button type="button" className="call-sheet-x" onClick={() => setShowCfg(false)} aria-label="关闭设置">
                <IconClose size={16} />
              </button>
            </div>
            <p className="call-sheet-note">
              {cfgErr ? `保存失败：${cfgErr}（已在本机生效）` : "调整立即生效，并保存到服务器（换设备也一样）"}
            </p>
            {/* In 按键打断 the two barge knobs have no effect at all — showing them as live
                controls would be a control that lies. They stay visible (so the numbers survive a
                flip back) but they are visibly off and the reason is written next to them. */}
            {cfg.interruptMode === "button" ? (
              <p className="call-sheet-warn">
                现在是「按键打断」：它说话的时候麦克风是关的 —— 不识别、不抢话，只在你说完之后才重新打开。
                所以灵敏度和持续时间这会儿不起作用（切回「语音打断」就恢复）。
              </p>
            ) : null}
            {cfg.interruptMode === "keyword" ? (
              <label className="call-knob">
                <span className="call-knob-top">
                  <span className="call-knob-name">唤醒词</span>
                  <span className="call-knob-val">{(wakeDraft ?? cfg.wakePhrase) || "未设置"}</span>
                </span>
                <input
                  type="text"
                  value={wakeDraft ?? cfg.wakePhrase}
                  placeholder="例如：小灵 / hey agent"
                  onChange={(e) => setWakeDraft(e.target.value)}
                  onBlur={() => {
                    if (wakeDraft === null) return;
                    applyCfg({ wakePhrase: normalizeWakePhrase(wakeDraft) });
                    setWakeDraft(null);
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                  aria-label="唤醒词"
                />
                <span className="call-knob-hint">
                  只有听到这句话才抢话（关键词打断）。空着 = 这个模式不生效，不会误触发。
                  灵敏度在这一档仍然有用：它决定「多大声才算压过外放的回声」；持续时间不起作用。
                </span>
              </label>
            ) : null}
            {/* What the capture ACTUALLY turned on — read from the live track, not from the
                constraint we asked for. When echo cancellation is not running, the reply leaves the
                loudspeaker and comes straight back into the microphone, which is how a call ends up
                interrupting itself; the operator was tuning 抢话灵敏度 against that. Saying it out
                loud is cheaper than a bug report nobody can reproduce. */}
            <p className={`call-sheet-echo ${micInfo().echoCancellation === false ? "bad" : ""}`}>
              {micInfo().echoCancellation === false
                ? "回声消除没生效：这台设备只给了原始麦克风。外放时它容易把自己当成你——用「按键打断」，或者戴耳机"
                : micInfo().echoCancellation === true
                  ? "回声消除：已生效（抢话要盖过你听到的那个声音，不会自己打断自己）"
                  : "回声消除：这台设备没报告（浏览器语音路径）——抢话按「比回复更响」判断"}
            </p>
            {/* 语音打断默认不摆在通话页那一排（#53）。放回来的入口在这里：一个勾选框，状态跟着
                这台设备的本地偏好走（和字幕开关同一个理由 —— 手机和桌面不需要共享）。 */}
            <label className="call-check">
              <input type="checkbox" checked={voiceMode} onChange={toggleVoiceMode} aria-label="在通话页显示语音打断" />
              <span>
                <span className="call-check-name">在通话页显示「语音打断」</span>
                <span className="call-check-hint">
                  默认收起：它说一句就能打断，外放、嘈杂的房间里也最容易自己打断自己。
                  勾上之后它回到通话页那一排，阈值和判定跟以前一样。
                </span>
              </span>
            </label>
            {CALL_KNOBS.map((k) => (
              // Which knob is actually read, per mode: 按键打断 reads neither (the mic is closed),
              // 关键词打断 reads the sensitivity (it is the echo floor for `isBargeEvidence`) but not
              // the hold time — the wake word IS the proof, so there is nothing to hold. The panel says
              // exactly that next to the wake-phrase box.
              <label
                className={`call-knob ${k.key === "bargeMs"
                  ? (cfg.interruptMode !== "voice" ? "off" : "")
                  : (cfg.interruptMode === "button" ? "off" : "")}`}
                key={k.key}
              >
                <span className="call-knob-top">
                  <span className="call-knob-name">{k.label}</span>
                  <span className="call-knob-val">{k.show(cfg[k.key])}</span>
                </span>
                <input
                  type="range"
                  min={CALL_RANGE[k.key][0]}
                  max={CALL_RANGE[k.key][1]}
                  step={k.key === "bargeSensitivity" ? 5 : k.key === "silenceMs" ? 100 : k.key === "minChars" ? 1 : 50}
                  value={cfg[k.key]}
                  onChange={(e) => applyCfg({ [k.key]: Number(e.target.value) } as Partial<CallSettings>)}
                  aria-label={k.label}
                  disabled={cfg.interruptMode !== "voice" && k.key.startsWith("barge")}
                />
                <span className="call-knob-ends"><span>{k.ends[0]}</span><span>{k.ends[1]}</span></span>
                <span className="call-knob-hint">{k.hint}</span>
              </label>
            ))}
            <div className="call-sheet-foot">
              <button type="button" className="call-sheet-btn" onClick={() => applyCfg(CALL_DEFAULT)}>恢复默认</button>
              <button type="button" className="call-sheet-btn primary" onClick={() => setShowCfg(false)}>完成</button>
            </div>
          </div>
        </div>
      ) : null}

      {/* the state is announced, not just drawn: a screen reader gets the whole call */}
      <p className="sr-only" aria-live="polite">{PHASE_LABEL[phase]}</p>
    </div>,
    document.body,
  );
}
