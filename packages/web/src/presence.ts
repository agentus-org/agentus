// The one decision behind 设置 → 手机通知 → 「我正在看这个会话时不推」, pulled out of the component
// so it can be reasoned about (and tested) without a browser.
//
// Why it is not simply `document.visibilityState === "visible"`: a laptop left open with the
// cockpit on screen is not somebody watching, and treating it as such would silently swallow every
// notification the phone should have received — the exact failure this feature must not have.

/** How long after the last interaction we still count as "a human is at this screen". */
export const PRESENCE_IDLE_MS = 120_000;

/** Reporting cadence. Must stay comfortably under the server's own 90s TTL. */
export const PRESENCE_INTERVAL_MS = 30_000;

export interface PresenceInput {
  /** Is the tab itself visible (not minimised, not in a background tab)? */
  visible: boolean;
  /** When the operator last touched this machine (pointer/key/wheel/touch). */
  lastInputAt: number;
  now: number;
  /** Override for tests. */
  idleMs?: number;
}

/** True when the cockpit should claim "I am watching the session on screen". */
export function watchingNow(input: PresenceInput): boolean {
  if (!input.visible) return false;
  const idle = input.idleMs ?? PRESENCE_IDLE_MS;
  return input.now - input.lastInputAt < idle;
}
