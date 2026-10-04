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

export interface CallSettings {
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

export const CALL_DEFAULT: CallSettings = { bargeSensitivity: 60, bargeMs: 300, silenceMs: 1200, minChars: 3 };

/** The slider ends. The server validates against the same ranges (settings.ts CALL_RANGE). */
export const CALL_RANGE: Record<keyof CallSettings, [number, number]> = {
  bargeSensitivity: [0, 100],
  bargeMs: [100, 1000],
  silenceMs: [400, 4000],
  minChars: [1, 20],
};

/** One row per knob: the panel renders straight off this, so a new knob is one entry. */
export interface CallKnob {
  key: keyof CallSettings;
  label: string;
  /** how to read the number back to the operator */
  show: (v: number) => string;
  /** the slider's two ends, in the operator's words (left → right) */
  ends: [string, string];
  hint: string;
}

export const CALL_KNOBS: CallKnob[] = [
  {
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

const KEY = "agentslot.call";
const FIELDS = Object.keys(CALL_DEFAULT) as (keyof CallSettings)[];

function clamp(key: keyof CallSettings, v: unknown): number {
  const [lo, hi] = CALL_RANGE[key];
  const n = Number(v);
  if (!Number.isFinite(n)) return CALL_DEFAULT[key];
  return Math.min(hi, Math.max(lo, n));
}

/** A settings object we can trust: unknown keys dropped, numbers clamped into range. */
export function normalizeCall(raw: unknown): CallSettings {
  const out = { ...CALL_DEFAULT };
  if (!raw || typeof raw !== "object") return out;
  for (const k of FIELDS) {
    if (k in (raw as Record<string, unknown>)) out[k] = clamp(k, (raw as Record<string, unknown>)[k]);
  }
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
  if (FIELDS.every((k) => next[k] === current[k])) return;
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
