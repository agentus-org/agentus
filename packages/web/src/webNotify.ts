// 网页通知 — the browser channel of the notify feature.
//
// The server decides WHAT happened and WHEN to say it (one mapping, two renderers: the phone's cards
// and these). This file owns the three questions only the page can answer:
//
//   1. MAY this device show it?      `Notification` exists, the origin is a secure context, the
//                                    operator granted permission, and this device's own switch is on.
//   2. SHOULD it show it right now?  `document.hidden` — the page's own answer to 「我正在看就不弹」,
//                                    made where the fact lives. This is why the web channel needs no
//                                    presence logic: the server cannot see one tab in front of
//                                    another, and the tab knows already.
//   3. HOW does it look/sound here?  A custom chime (this device's own choice), which is also why the
//                                    card asks for the OS tone to be silenced: two sounds for one
//                                    event is the thing people switch the feature off over.
//
// Settings are split like the rest of this app splits them: WHAT to notify about is server-side
// (shared with the phone, changeable without shipping a bundle), while whether THIS device shows
// anything and what it sounds like is local — the same reason 听写引擎 and 朗读声音 are local, and
// the reason `localStorage` is a mirror and not a source of truth everywhere else.
import { useSyncExternalStore } from "react";
import type { WebNotice } from "../../shared/src";
import { isCallActive } from "./voice";

export type NoticeSound = "default" | "chime" | "silent";

/** This device's choices. `sound` is about THIS machine's speakers, so it never travels. */
export interface WebNotifyPrefs {
  /** The local switch: permission granted is not the same as "I want them on the laptop". */
  on: boolean;
  /** `default` = let the platform play its own notification tone; `chime` = we play ours (and mute the
   *  platform's, so one event makes one sound); `silent` = draw it, say nothing. */
  sound: NoticeSound;
  /** Chime volume 0..1 (only meaningful for `chime`). */
  volume: number;
}

export const WEB_NOTIFY_KEY = "agentus.webnotify";
export const WEB_NOTIFY_DEFAULT: WebNotifyPrefs = { on: true, sound: "default", volume: 0.6 };

export type Availability = "ok" | "no-api" | "insecure";
export type PermissionState = NotificationPermission | "unavailable";

export interface WebNotifyState {
  availability: Availability;
  permission: PermissionState;
  prefs: WebNotifyPrefs;
  /** The last card this tab drew (or tried to) — the settings card shows it, because a browser can
   *  drop a notification without telling anyone and "什么也没发生" is otherwise unanswerable. */
  last: { title: string; at: number; drawn: boolean } | null;
}

// ----------------------------------------------------------------- pure gates
//
// Kept out of the class (and of the DOM) so the two decisions can be asserted in CI, the way
// presence.ts's `watchingNow` is: the failure modes here are silent (a notification that never
// appears, a second sound nobody asked for), so they need an assertion rather than a look.

export interface NoticeGate {
  /** `Notification` exists AND the origin is secure (https, or localhost). */
  available: boolean;
  permission: string;
  /** This device's own switch. */
  enabled: boolean;
  /** The tab is in the background. */
  hidden: boolean;
}

export function shouldDrawNotice(g: NoticeGate): boolean {
  return g.available && g.permission === "granted" && g.enabled && g.hidden;
}

/**
 * Should the page make its own sound?
 *
 * Three rules, all deliberate: the operator asked for `chime`; a voice call is not live (the call's
 * capture is a plain microphone with no echo cancellation, so a tone goes straight into the very
 * audio the agent is listening to — the same reason the phone channel goes quiet, on this machine);
 * and the event is one worth hearing. A "still running" card is a status line, and a status line that
 * dings is noise.
 */
export function shouldChime(prefs: WebNotifyPrefs, kind: WebNotice["kind"], callLive: boolean): boolean {
  if (prefs.sound !== "chime" || callLive) return false;
  return kind === "approval" || kind === "agent_done" || kind === "error";
}

/** Which of the two chimes a kind gets: a decision waiting on a human is worth two tones, a finished
 *  turn one. (The same asymmetry the phone channel has between 权限请求 and 任务完成.) */
export function chimeIsDouble(kind: WebNotice["kind"]): boolean {
  return kind === "approval";
}

/** `/?session=<id>` (what the server sends) -> the id, or null when the target says nothing. */
export function sessionIdOf(open: string): string | null {
  try {
    const url = new URL(open, typeof location === "undefined" ? "http://localhost/" : location.href);
    return url.searchParams.get("session");
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------- the store

function readPrefs(): WebNotifyPrefs {
  try {
    const raw = localStorage.getItem(WEB_NOTIFY_KEY);
    if (!raw) return { ...WEB_NOTIFY_DEFAULT };
    const v = JSON.parse(raw) as Partial<WebNotifyPrefs>;
    // Whitelist, never spread: a value that no longer means what it meant (or was never ours) must not
    // ride into the live object.
    return {
      on: typeof v.on === "boolean" ? v.on : WEB_NOTIFY_DEFAULT.on,
      sound: v.sound === "chime" || v.sound === "silent" || v.sound === "default" ? v.sound : WEB_NOTIFY_DEFAULT.sound,
      volume: typeof v.volume === "number" && Number.isFinite(v.volume)
        ? Math.min(1, Math.max(0, v.volume))
        : WEB_NOTIFY_DEFAULT.volume,
    };
  } catch {
    return { ...WEB_NOTIFY_DEFAULT };
  }
}

/** The tab's notification API surface — one place decides "can this device do it at all". */
function availability(): Availability {
  if (typeof window === "undefined") return "no-api";
  if (!("Notification" in window)) return "no-api";
  return window.isSecureContext ? "ok" : "insecure";
}

// ----------------------------------------------------------------- sound

let audioCtx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) {
    try {
      audioCtx = new Ctor();
    } catch {
      return null;
    }
  }
  return audioCtx;
}

/** Make the context usable. Browsers only allow audio to start inside a real gesture — call this from
 *  the click that switches the feature on, and again before playing (the context can be suspended
 *  again after a long idle stretch). */
export function unlockChime(): void {
  const c = audioContext();
  if (c && c.state === "suspended") void c.resume();
}

function tone(c: AudioContext, freq: number, at: number, dur: number, volume: number): void {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.linearRampToValueAtTime(volume, at + 0.012); // 12ms attack: no click
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

/** The cockpit's own chime: a short two-note figure, synthesized (no asset to load, no file to ship,
 *  and the volume is the operator's). Exported so the settings card's 试听 uses the exact same sound
 *  the notification will. */
export function playChime(volume: number, double: boolean): void {
  const c = audioContext();
  if (!c) return;
  if (c.state === "suspended") void c.resume();
  const t0 = c.currentTime + 0.01;
  tone(c, 880, t0, 0.16, volume);
  if (double) tone(c, 1174.66, t0 + 0.19, 0.22, volume);
}

// ----------------------------------------------------------------- drawing

/** The live objects from the non-service-worker path (desktop only) — kept so a `dismiss` can close
 *  exactly the card the server just retired. */
const drawn = new Map<string, Notification>();
/** What the SW path needs to find a card again: `getNotifications({tag})`. */
let lastDrawnAt = 0;

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return (await navigator.serviceWorker.getRegistration()) ?? null;
  } catch {
    return null;
  }
}

/** Where a click lands. Asked of the live tab first (switching sessions in place beats reloading the
 *  cockpit — a reload throws away whatever the operator had half-typed), with the URL as the fallback
 *  the SPA already understands (`?session=`, the same target the phone's tap uses). */
let opener: ((sessionId: string) => void) | null = null;
export function setNoticeOpener(fn: (sessionId: string) => void): void {
  opener = fn;
}

function openNotice(open: string | null | undefined): void {
  if (!open) return;
  const id = sessionIdOf(open);
  if (id && opener) {
    opener(id);
    return;
  }
  location.assign(open);
}

const ICON = "/icons/icon-192.png";

/** `NotificationOptions` plus `renotify`, which is in the spec (and honoured by Chrome/Firefox) but
 *  missing from this TypeScript DOM lib. */
type NoticeOptions = NotificationOptions & { renotify?: boolean };

async function draw(notice: WebNotice, prefs: WebNotifyPrefs): Promise<boolean> {
  const options: NoticeOptions = {
    body: notice.body,
    // The page's slot IS the tag: same noticeId = the card is replaced, not stacked.
    tag: notice.noticeId,
    icon: ICON,
    badge: ICON,
    data: { open: notice.open ?? null, noticeId: notice.noticeId },
    // A replacement must still alert. Without this the second 「已完成」 for a session lands silently,
    // because the alert belonged to the card it replaced.
    renotify: true,
    // ...but only a decision waiting on a human is worth holding the screen for.
    requireInteraction: Boolean(notice.sticky),
    // Take the platform's tone away ONLY when we are the ones making noise (or when silence was
    // chosen). On `default` we say nothing and the platform plays whatever the OS is set to.
    silent: prefs.sound === "default" ? false : true,
  };
  const reg = await registration();
  if (reg && typeof reg.showNotification === "function") {
    try {
      await reg.showNotification(notice.title, options);
      lastDrawnAt = Date.now();
      return true;
    } catch {
      /* fall through to the constructor: an engine can refuse the SW path */
    }
  }
  // Desktop-only fallback. `new Notification()` throws a TypeError on nearly every mobile browser —
  // which is why the service-worker path is tried first, and why the whole channel is inert in the
  // companion app's WebView (it exposes neither API; measured).
  try {
    const n = new Notification(notice.title, options);
    n.onclick = () => {
      openNotice(notice.open);
      n.close();
    };
    drawn.set(notice.noticeId, n);
    lastDrawnAt = Date.now();
    return true;
  } catch {
    return false;
  }
}

/** Take a card off the screen. Never gated by the switches: a card whose question is already answered
 *  must come down even if the operator turned notifications off in the meantime. */
async function close(noticeId: string): Promise<void> {
  const local = drawn.get(noticeId);
  if (local) {
    local.close();
    drawn.delete(noticeId);
  }
  const reg = await registration();
  if (!reg || typeof reg.getNotifications !== "function") return;
  try {
    for (const n of await reg.getNotifications({ tag: noticeId })) n.close();
  } catch {
    /* an engine without getNotifications leaves the card to time out on its own */
  }
}

// ----------------------------------------------------------------- the controller

class WebNotify {
  #prefs: WebNotifyPrefs = WEB_NOTIFY_DEFAULT;
  #last: WebNotifyState["last"] = null;
  #listeners = new Set<() => void>();
  #snapshot: WebNotifyState;

  constructor() {
    this.#prefs = typeof localStorage === "undefined" ? { ...WEB_NOTIFY_DEFAULT } : readPrefs();
    this.#snapshot = this.#build();
  }

  #build(): WebNotifyState {
    const avail = availability();
    return {
      availability: avail,
      permission: avail === "ok" ? Notification.permission : "unavailable",
      prefs: this.#prefs,
      last: this.#last,
    };
  }

  #publish(): void {
    this.#snapshot = this.#build();
    for (const fn of this.#listeners) fn();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  };

  getSnapshot = (): WebNotifyState => this.#snapshot;

  setPrefs(patch: Partial<WebNotifyPrefs>): void {
    this.#prefs = { ...this.#prefs, ...patch };
    if (patch.volume !== undefined) {
      this.#prefs.volume = Math.min(1, Math.max(0, patch.volume));
    }
    try {
      localStorage.setItem(WEB_NOTIFY_KEY, JSON.stringify(this.#prefs));
    } catch {
      /* private mode: the choice just will not outlive the tab */
    }
    this.#publish();
  }

  /** Ask the OS for permission. Must be called from a real click — every browser requires a gesture,
   *  and Chrome will not even show the prompt without one. */
  async requestPermission(): Promise<PermissionState> {
    if (availability() !== "ok") return "unavailable";
    // Creating/resuming audio here doubles as the audio unlock: this click is the gesture that lets a
    // later chime play at all.
    unlockChime();
    try {
      const result = await Notification.requestPermission();
      this.#publish();
      void result;
      return this.#build().permission;
    } catch {
      return this.#build().permission;
    }
  }

  /** One notice from the server. */
  handle(notice: WebNotice): void {
    if (notice.op === "dismiss") {
      void close(notice.noticeId);
      return;
    }
    // Read the API's presence BEFORE touching `Notification.permission`: on an engine without the API
    // (Android WebView — the companion app's own page, which receives these frames too) that property
    // is a TypeError, and a renderer that cannot draw must fail silently, not loudly.
    const avail = availability();
    const gate: NoticeGate = {
      available: avail === "ok",
      permission: avail === "ok" ? Notification.permission : "unavailable",
      enabled: this.#prefs.on,
      hidden: typeof document === "undefined" ? false : document.hidden,
    };
    if (!shouldDrawNotice(gate)) return;
    void draw(notice, this.#prefs).then((ok) => {
      this.#last = { title: notice.title, at: Date.now(), drawn: ok };
      this.#publish();
    });
    if (shouldChime(this.#prefs, notice.kind, isCallActive())) {
      playChime(this.#prefs.volume, chimeIsDouble(notice.kind));
    }
  }

  /** 发一条测试通知: the same drawing path as a real one, minus the "is the tab hidden" gate — the
   *  operator pressed a button, so the answer is already yes, and a test that cannot be seen while
   *  looking at it would test nothing. */
  async test(): Promise<boolean> {
    if (availability() !== "ok") return false;
    unlockChime();
    const notice: WebNotice = {
      op: "upsert",
      noticeId: "test:manual",
      kind: "agent_done",
      title: "测试通知",
      body: "这条通知能弹出来，就说明这台设备没问题",
      open: null,
      at: Date.now(),
    };
    const ok = await draw(notice, this.#prefs);
    this.#last = { title: notice.title, at: Date.now(), drawn: ok };
    this.#publish();
    if (this.#prefs.sound === "chime" && !isCallActive()) playChime(this.#prefs.volume, false);
    return ok;
  }

  /** Retire every card this tab knows about (used when the operator switches the channel off, so no
   *  stale card outlives the decision). */
  async closeAll(ids: string[]): Promise<void> {
    for (const id of ids) await close(id);
  }

  /** When this tab last drew (or tried to draw) something — for the settings card's "有没有生效". */
  lastDrawnAt(): number {
    return lastDrawnAt;
  }
}

export const webNotify = new WebNotify();

/** Bring the SERVICE WORKER's click handlers into the page: the worker cannot select a session, so it
 *  asks the tab that has one. */
export function installNoticeBridge(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (ev: MessageEvent) => {
    const data = ev.data as { t?: string; open?: string | null } | null;
    if (data?.t === "agentus:notify-open") openNotice(data.open ?? null);
  });
}

export function useWebNotify(): WebNotifyState {
  return useSyncExternalStore(webNotify.subscribe, webNotify.getSnapshot);
}
