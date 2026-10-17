// The call's thresholds, as operator settings.
//
// Why these are settings at all: every number in the conversation loop is
// environment-dependent. A phone lying on a table leaks its own loudspeaker straight back
// into its own microphone, so "loud enough to interrupt" is a completely different number
// there than it is on a headset, and a quiet room and a cafe disagree about how short a
// sentence may be before it is just noise. The defaults are the shipped compromise; the
// panel exists because only the person in the room can pick.
//
// Storage: the SERVER is the source of truth (shared with the settings page and across
// devices), mirrored into localStorage so the first frame of a call has real numbers
// instead of the defaults — the same dance theme.ts does.
import { useSyncExternalStore } from "react";

export type InterruptMode = "voice" | "button";

export interface CallSettings {
  /** WHO gets to interrupt the agent. This one is a SWITCH ON THE CALL, not a knob in the panel:
   *  it changes with the room (a phone on a table hears itself), so it has to be one tap away
   *  WHILE the call is misbehaving — digging into a sheet to flip a mode is the wrong gesture.
   *  The orb tap works in both modes; it is the one control that always means "the floor is mine". */
  interruptMode: InterruptMode;
  /** HOW EASY it is to talk over the reply, 0..100 (high = easy). The panel is a sensitivity
   *  because that is what an operator can reason about; the mic level it maps to is
   *  `bargeLevelOf` below. The first version stored the raw level, which made "灵敏度 80%"
   *  mean "you have to shout" — a control that says the opposite of what it does. */
  bargeSensitivity: number;
  /** how long that level must hold before the floor changes hands (ms) */
  bargeMs: number;
  /** silence that ends the operator's sentence (ms) */
  silenceMs: number;
  /** an automatic send shorter than this many characters is dropped (1 = no limit) */
  minChars: number;
}

export const CALL_DEFAULT: CallSettings = {
  interruptMode: "voice", bargeSensitivity: 60, bargeMs: 300, silenceMs: 1500, minChars: 3,
};

/** The switch's two ends, in the operator's words. */
export const INTERRUPT_MODES: { id: InterruptMode; label: string; hint: string }[] = [
  { id: "voice", label: "语音打断", hint: "说一句就能打断它（灵敏度、持续时间在设置里调）" },
  { id: "button", label: "按键打断", hint: "只有点圆球才打断——外放串音、环境吵的时候用它" },
];

/** The NUMERIC knobs (slider ends live here). `interruptMode` is a two-way choice, not a slider. */
export type CallKnobKey = Exclude<keyof CallSettings, "interruptMode">;

/** The slider ends. The server validates against the same ranges (settings.ts CALL_RANGE). */
export const CALL_RANGE: Record<CallKnobKey, [number, number]> = {
  bargeSensitivity: [0, 100],
  bargeMs: [100, 1000],
  silenceMs: [400, 4000],
  minChars: [1, 20],
};

/** One row per knob: the panel renders straight off this, so a new knob is one entry. */
export interface CallKnob {
  key: CallKnobKey;
  label: string;
  /** how to read the number back to the operator */
  show: (v: number) => string;
  /** the slider's two ends, in the operator's words (left → right) */
  ends: [string, string];
  hint: string;
}

export const CALL_KNOBS: CallKnob[] = [
  {
    /** voice mode only: with the interrupt on the button there is no threshold to tune */
    key: "bargeSensitivity",
    label: "抢话灵敏度",
    show: (v) => `${Math.round(v)}%`,
    ends: ["迟钝", "灵敏"],
    hint: "越高越容易打断它（100% 最灵敏）。手机外放容易串音，串音频繁就调低一点",
  },
  {
    key: "bargeMs",
    label: "抢话持续时间",
    show: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} 秒` : `${v} 毫秒`),
    ends: ["快", "稳"],
    hint: "要连续这么大声才算抢话",
  },
  {
    key: "silenceMs",
    label: "说完停顿",
    show: (v) => `${(v / 1000).toFixed(1)} 秒`,
    ends: ["快", "慢"],
    hint: "静音这么久就算你说完了，自动把话发出去",
  },
  {
    key: "minChars",
    label: "最少字数",
    show: (v) => (v <= 1 ? "不限制" : `${v} 字`),
    ends: ["1", "20"],
    hint: "自动发送时少于这个字数不发送（1 = 不限制）；点一下圆球是明确指令，照发。默认 3 字，挡掉语气词和噪音",
  },
];

/** The panel's sensitivity → the mic level the loop compares against. 0 % = you have to
 *  raise your voice over the reply (0.5); 100 % = a normal voice takes the floor (0.05).
 *  Deliberately linear: it is a control, not an instrument. */
export function bargeLevelOf(sensitivity: number): number {
  const s = Math.min(100, Math.max(0, Number(sensitivity)));
  return 0.5 - 0.45 * (s / 100);
}

/** How our own loudspeaker shows up in the microphone, in mic-level units.
 *
 *  Both numbers are LEVELS from `voice.ts`, and they are NOT on the same scale: the microphone
 *  level is `rms × 6`, the playback level is `rms × 4`, both clamped at 1. So a byte-for-byte echo
 *  — raw capture, speaker at the same rms — reads **1.5× louder** on the microphone side.
 *
 *   · `raw` is therefore just above that 1.5: with the cancellation off, the operator has to be
 *     audibly louder than the reply for the floor to change hands (and if the reply is loud enough
 *     to clamp the meter, the voice barge simply cannot fire — that is the honest answer, and the
 *     reason the call now says "回声消除没生效，用按键打断或戴耳机" instead of pretending).
 *   · `aec` is a small fraction, because the canceller has already removed most of it; what is
 *     left is the residual plus the room. The sensitivity floor dominates here, which is exactly
 *     what a working echo canceller should give you: a normal voice takes the floor back. */
export const ECHO = { aec: 0.45, raw: 1.55 } as const;

/** One frame of evidence for "the operator is talking over the reply".
 *
 *  The first version compared the microphone to an ABSOLUTE level, and on a phone lying on a table
 *  that made the call interrupt itself: its own loudspeaker goes straight back into its own
 *  microphone, so the echo's level follows the reply's level and any fixed bar is crossed by the
 *  reply. The operator heard it as 「它刚输出一段话就自己打断自己，我都没说话」.
 *
 *  The gate is therefore RELATIVE to what we are playing at this instant: echo scales with the
 *  playback, a human voice does not. That is the double-talk test every voice stack runs
 *  (AEC + reference signal); ours is one line, because the reference — our own output level — is
 *  already in the page.
 *
 *  `playback < 0` means "cannot measure" (the browser voice is not tappable): no echo model, so
 *  fall back to the plain absolute bar — the sentence-start grace and the hold time still apply. */
export function isBargeEvidence(mic: number, playback: number, sensitivity: number, aecOn: boolean): boolean {
  const floor = bargeLevelOf(sensitivity);
  if (playback < 0) return mic > floor;
  return mic > Math.max(floor, playback * (aecOn ? ECHO.aec : ECHO.raw));
}

/** Ignore the microphone for this long after a sentence STARTS. Two things live here: the attack
 *  transient of the clip itself (a click through the speaker reads as a spike) and, on devices
 *  whose echo canceller needs a moment to converge, the first frames of its own reference. */
export const BARGE_GRACE_MS = 600;

/** …and for this long after a barge lands, so the tail of the interruption (and the recogniser
 *  catching up) cannot fire a second one. */
export const BARGE_COOLDOWN_MS = 900;

const KEY = "agentus.call";
/** numeric knobs only — clamping `interruptMode` as a number would erase the choice */
const NUMERIC = Object.keys(CALL_RANGE) as CallKnobKey[];

function clamp(key: CallKnobKey, v: unknown): number {
  const [lo, hi] = CALL_RANGE[key];
  const n = Number(v);
  if (!Number.isFinite(n)) return CALL_DEFAULT[key];
  return Math.min(hi, Math.max(lo, n));
}

/** A settings object we can trust: unknown keys dropped, numbers clamped into range. */
export function normalizeCall(raw: unknown): CallSettings {
  const out = { ...CALL_DEFAULT };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  if (INTERRUPT_MODES.some((m) => m.id === r.interruptMode)) out.interruptMode = r.interruptMode as InterruptMode;
  for (const k of NUMERIC) if (k in r) out[k] = clamp(k, r[k]);
  return out;
}

function loadLocal(): CallSettings {
  try {
    return normalizeCall(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch {
    return { ...CALL_DEFAULT };
  }
}

let current: CallSettings = loadLocal();
const listeners = new Set<() => void>();

function setCurrent(next: CallSettings): void {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* private mode: the choice just does not survive a reload */
  }
  for (const fn of listeners) fn();
}

export function getCallSettings(): CallSettings {
  return current;
}

/** Apply now, persist to the server, report a failure as a string (never throw: the knobs
 *  are live in the running call, and a failed round trip must not freeze the panel). */
export async function patchCallSettings(patch: Partial<CallSettings>): Promise<string> {
  const next = normalizeCall({ ...current, ...patch });
  setCurrent(next);
  try {
    const res = await fetch("/api/settings", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ call: next }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return data.error ?? `save failed (${res.status})`;
    }
    adoptServerCall(((await res.json()) as { call?: unknown }).call);
    return "";
  } catch (e) {
    return String((e as Error)?.message ?? e);
  }
}

/** Adopt what the server says without pushing it back (used at boot / after login). */
export function adoptServerCall(raw: unknown): void {
  const next = normalizeCall(raw);
  if (Object.keys(CALL_DEFAULT).every((k) => next[k as keyof CallSettings] === current[k as keyof CallSettings])) return;
  setCurrent(next);
}

/** Ask the server for the saved thresholds and adopt them. */
export async function loadServerCallSettings(): Promise<void> {
  try {
    const res = await fetch("/api/settings", { credentials: "same-origin" });
    if (!res.ok) return;
    adoptServerCall(((await res.json()) as { call?: unknown }).call);
  } catch {
    /* offline / not logged in: the cached numbers stand */
  }
}

export function useCallSettings(): [CallSettings, (patch: Partial<CallSettings>) => void] {
  const value = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
  );
  return [value, (patch) => void patchCallSettings(patch)];
}
