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

export type InterruptMode = "voice" | "button" | "keyword";

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
  /** 关键词打断 (opt-in, `interruptMode: "keyword"`): the utterance that has to be HEARD before the
   *  floor changes hands — e.g. 「小灵」. Empty means the mode is inert, which is deliberate: no
   *  default wake word, so switching the mode without typing one changes nothing (#42's comment). */
  wakePhrase: string;
}

export const CALL_DEFAULT: CallSettings = {
  interruptMode: "voice", bargeSensitivity: 60, bargeMs: 300, silenceMs: 1500, minChars: 3,
  wakePhrase: "",
};

/** The switch's ends, in the operator's words. */
export const INTERRUPT_MODES: { id: InterruptMode; label: string; hint: string }[] = [
  { id: "voice", label: "语音打断", hint: "说一句就能打断它（灵敏度、持续时间在设置里调）" },
  { id: "keyword", label: "关键词打断", hint: "要先说出你设的那句话才算打断（设置里填），比语音打断稳、不用碰屏幕" },
  { id: "button", label: "按键打断", hint: "只认按钮：它说话的时候麦克风关着，不识别、不抢话——外放串音、环境吵的时候用它" },
];

/** The NUMERIC knobs (slider ends live here). `interruptMode` is a three-way choice and
 *  `wakePhrase` is text, so neither is a slider. */
export type CallKnobKey = Exclude<keyof CallSettings, "interruptMode" | "wakePhrase">;

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
    hint: "静音这么久就算你说完了，自动把话发出去；怕被提前截断就用「按住说话」",
  },
  {
    key: "minChars",
    label: "最少字数",
    show: (v) => (v <= 1 ? "不限制" : `${v} 字`),
    ends: ["1", "20"],
    hint: "自动发送时少于这个字数不发送（1 = 不限制）；点一下圆球是明确指令，照发。默认 3 字，挡掉语气词和噪音",
  },
];

/** The panel's sensitivity → the quietest microphone RMS that can count as speech at all.
 *  It is a FLOOR (is anybody there), never the whole test: whether a voice is allowed to take the
 *  floor from a talking agent is decided by comparing it to what we are playing (`isBargeEvidence`).
 *  0 % → 0.030 (a raised voice), 100 % → 0.006 (a murmur). Deliberately linear: a control, not an
 *  instrument. */
export function bargeFloorRms(sensitivity: number): number {
  const s = Math.min(100, Math.max(0, Number(sensitivity)));
  // 0 % → 0.083 RMS (a raised voice), 60 % → ≈0.033 (speech aimed at the device),
  // 100 % → 0.008 (a murmur). Curved rather than linear because the ear is: the top of the
  // slider has to reach room-level speech, the bottom has to keep out a passing conversation.
  return 0.008 + 0.075 * Math.pow(1 - s / 100, 1.2);
}

/** How loud our own loudspeaker can be in the microphone, as a MULTIPLE of the playback RMS.
 *
 *  Both sides of this ratio are now measured in their own units (`levelRms` / `playbackRms`), so
 *  the numbers mean what they say — which they did not before: the old pair were ×6 and ×4 boosted
 *  and clamped at 1, so a loud reply pinned BOTH meters to 1.0 and the gate's bar (0.45 × 1.0)
 *  could never be cleared by a human voice. That is why 语音打断 "never fired" on a real call
 *  while the QA sweep, which drives a level straight through the seam, always passed.
 *
 *   · `raw` (no echo cancellation): the speaker is louder in the microphone than it is in the mix,
 *     so the operator has to be audibly above the reply — 1.4×.
 *   · `aec` (cancellation on): most of the echo is gone; what is left is residual + the room. */
export const ECHO = { aec: 0.55, raw: 1.4 } as const;

/** …and the primary proof: a voice is a STEP over the echo's own level.
 *
 *  Echo is steady — it is a copy of what we are playing — while a person speaking over it adds on
 *  top, so the microphone jumps well above the level the echo alone was producing. `baseRms` is
 *  that level, learned by the call while the gate is closed (see the loop in CallMode). This is
 *  the double-talk test, done with the reference signal we already have, and it is the ONLY proof
 *  that survives an echo canceller that reports success without cancelling anything (a vendor
 *  WebView does exactly that — and there the "louder than the reply" comparison is a lie). */
export const ECHO_RISE = 1.6;

/** One frame of evidence for "the operator is talking over the reply".
 *
 *  `baseRms` = the echo's own level from earlier in THIS clip (0 = not learned yet). Until it is
 *  learned, the only available test is the absolute one against the playback; once it is, a rise
 *  over the echo is what counts, because that number is measured in this room, on this speaker,
 *  through this microphone — no assumption about an echo canceller at all. */
export function isBargeEvidence(
  micRms: number,
  playRms: number,
  baseRms: number,
  sensitivity: number,
  aecOn: boolean,
): boolean {
  if (!(micRms > bargeFloorRms(sensitivity))) return false;
  // Nothing of ours is playing: no echo can explain a voice, so the floor is the whole test.
  if (!(playRms > 0.002)) return true;
  if (baseRms > 0.002) return micRms > baseRms * ECHO_RISE;
  return micRms > playRms * (aecOn ? ECHO.aec : ECHO.raw);
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
  if ("wakePhrase" in r) out.wakePhrase = normalizeWakePhrase(r.wakePhrase);
  return out;
}

/** The wake phrase as it is stored: trimmed, single-spaced, at most 24 characters. Long enough for
 *  「hey agent」 or 「小灵同学」, short enough that it cannot become a sentence. */
export function normalizeWakePhrase(raw: unknown): string {
  // Code points, not UTF-16 units: `slice(0, 24)` counts an emoji as two and can cut one in half,
  // leaving a lone surrogate that SQLite stores as U+FFFD — a wake phrase silently corrupted.
  return [...String(raw ?? "").replace(/\s+/g, " ").trim()].slice(0, WAKE_MAX).join("");
}

/** Longest wake phrase, in code points. Enforced identically on both sides (server settings.ts). */
export const WAKE_MAX = 24;

/** Does `heard` contain the wake phrase? Compared on a **stripped** form on both sides — no spaces,
 *  no punctuation, no case — because a recogniser writes 「小 灵」, 「小灵，」 and 「小灵。」 for the
 *  same two syllables, and the operator should not have to guess which one it chose today. */
export function matchesWakePhrase(heard: string, phrase: string): boolean {
  const norm = (s: string): string => String(s ?? "").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  const needle = norm(phrase);
  if (!needle) return false;                     // no phrase set: the mode is inert, not "always on"
  return norm(heard).includes(needle);
}

/** How recently the wake phrase must have been HEARD. The recogniser only appends during a relay, so
 *  a hit from earlier in the reply would otherwise stay armed for its whole tail and fire on the next
 *  gap between sentences — 「它念到一半忽然自己停了」 with nothing said. */
export const WAKE_FRESH_MS = 2500;

/**
 * The 关键词 decision as one pure function — every leg kills a specific false positive, and none of
 * them can be checked without a microphone, so they are checked here instead:
 *  · `own`      — the sentence the speaker is reading right now. Our loudspeaker plays into this
 *                 microphone, so a phrase the AGENT said arrives as if the operator said it;
 *  · fresh      — see WAKE_FRESH_MS;
 *  · graceOpen  — attack transient + echo convergence at the start of a clip;
 *  · evidence   — where our output level is measurable, a real voice rises over the echo and a leak
 *                 does not. **Unmeasurable (-1) is not evidence**: it only means the browser voice
 *                 cannot be tapped, and then the guards above are what is left.
 */
export function wakeArmed(o: {
  heard: string;
  own: string;
  heardAgoMs: number;
  phrase: string;
  graceOpen: boolean;
  evidence: boolean;
  playRms: number;
  muted: boolean;
}): boolean {
  if (o.muted || !o.heard || !o.phrase) return false;
  if (!o.graceOpen) return false;
  if (!(o.heardAgoMs <= WAKE_FRESH_MS)) return false;
  if (o.own && matchesWakePhrase(o.own, o.phrase)) return false;
  if (!matchesWakePhrase(o.heard, o.phrase)) return false;
  if (o.playRms >= 0 && !o.evidence) return false;
  return true;
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
