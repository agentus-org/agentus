// Notify contract v0.1 — the wire types shared by the AgentSlot server and the
// Android companion app. See docs/android-notify-contract.md at the workspace root
// (tasks/20261001-agentslot/android-notify-contract.md) for the rationale.
//
// Rule of the contract: this file only ever GROWS. Adding a field is compatible;
// changing the meaning of an existing one is not. A device that does not know a
// field ignores it, and the server decides what to send from `capabilities`,
// never from a version number.

export type NotifyPlatform = "android" | "ios" | "web";

/** Device -> server handshake, sent once at pairing. */
export interface DeviceCapabilities {
  platform: NotifyPlatform;
  /** Android API level (36+ = Live Updates are possible). */
  sdkInt: number;
  appVersion: string;
  /** Highest contract schema the app understands. */
  schema: number;
  /** Feature switches: live_update | progress | actions | remote_input | icon_url | channels | deeplink */
  capabilities: string[];
}

export interface NotifyDevice extends DeviceCapabilities {
  deviceId: string;
  name: string;
  /** Device bearer token (issued at pairing; stored in the app's Keystore). */
  token: string;
  createdAt: number;
  lastSeenAt: number | null;
  /** Highest activity seq this device has acknowledged (replay anchor). */
  cursor: number;
  /**
   * The device reporting on itself — last report wins. Contains the app version, the ROM's
   * focus-protocol generation, the exact island payload it would attach and whether it holds the
   * microphone. Written by POST /api/notify/diag: the phone writes the answer down where the server
   * can read it, which is the only way to diagnose a device that cannot be plugged into anything.
   */
  diag?: { at: number; text: string } | null;
}

/** Server -> device, one notification. `ref` never leaves the server. */
export interface NotifyRef {
  /** Handler family: "permission" | "open" | "stop" | ... — the server's switch. */
  type: string;
  [key: string]: unknown;
}

export type NotifyOp = "upsert" | "dismiss" | "clear_all" | "probe";

export type ActionStyle = "primary" | "danger" | "default";

export interface ActivityAction {
  id: string;
  label: string;
  style?: ActionStyle;
}

export interface ActivityProgressSegment {
  length: number;
  color?: string;
}

export interface ActivityProgressPoint {
  position: number;
  color?: string;
}

/** Progress. `segments`/`points` feed Android 16 Notification.ProgressStyle;
 *  a device without `progress` support falls back to a plain notification. */
export interface ActivityProgress {
  value?: number | null;
  indeterminate?: boolean;
  styledByProgress?: boolean;
  segments?: ActivityProgressSegment[];
  points?: ActivityProgressPoint[];
  /** Android drawable name already bundled in the app ("icon:name" convention). */
  trackerIcon?: string;
  startIcon?: string;
  endIcon?: string;
}

/** The server defines channels, the app creates them on demand — that way
 *  importance/sound/vibration are server-controlled and never need a new APK. */
export interface ChannelSpec {
  id: string;
  name: string;
  importance?: "min" | "low" | "default" | "high";
  sound?: boolean;
  vibration?: boolean;
  /** The server took the sound away for a reason of its own (today: a voice call is live, so a tone
   *  would be recorded by the agent's own microphone). Behavioural, not cosmetic: an Android channel's
   *  sound/importance cannot be changed after creation, so a muted frame must be routed to a quiet
   *  channel rather than an updated one. */
  muted?: boolean;
}

export interface ActivityInput {
  enabled: boolean;
  placeholder?: string;
}

export interface ActivityObject {
  schema: 1;
  op: NotifyOp;
  /** Stable id: one id = one notification slot. */
  activityId: string;
  /** Monotonic per activity; a device drops anything older than what it holds. */
  revision: number;
  /** Semantic label ("agent_running" | "approval" | "agent_done" | "error"). */
  kind?: string;
  priority?: "high" | "default" | "low";
  /** Ongoing is a precondition for a promoted Live Update. */
  ongoing?: boolean;
  /** The server's wish; the app promotes only if the device/user allows it. */
  promotable?: boolean;
  /** Which promotion path this frame must take, for testing the two island APIs apart:
   *  absent/"" = the app's order (vendor island first, AOSP Live Update after),
   *  "xiaomi" = the vendor island only, "aosp" = Android 16's own Live Update only.
   *  Behavioural, not cosmetic: it is how "does HyperOS 3 render Android's own chip at all"
   *  becomes a button instead of another APK. */
  path?: string;
  title: string;
  subtitle?: string | null;
  body?: string | null;
  progress?: ActivityProgress | null;
  /** Large icon, fetched by the app (server-controlled visuals). */
  iconUrl?: string | null;
  /** Small (status bar) icon — must be a drawable already inside the APK. */
  smallIcon?: string | null;
  channel?: ChannelSpec | null;
  visibility?: "public" | "private" | "secret";
  actions?: ActivityAction[];
  input?: ActivityInput | null;
  /** Where tapping the notification goes (web UI path).
   *  @deprecated superseded by `open` — still emitted so an app built before the `open` contract keeps
   *  a working tap. Remove once no such app is in the field. */
  deeplink?: string | null;
  /** Where a tap goes, in the abstract: a URL plus how strongly the sender wants it opened in an app.
   *
   *  The split is deliberate. The SENDER knows the destination; only the RECEIVER knows what is
   *  installed and which origins it trusts, so `prefer` is a hint and the device keeps the policy
   *  (see docs/android-notify-contract.md §5.2). This is also what lets a third party push a
   *  notification through the same contract: a sender that knows nothing about AgentSlot sends
   *  `{ url, prefer: "web" }` and gets a plain link, while our own server asks for its cockpit. */
  open?: OpenTarget | null;
  staleAt?: number;
  expiresAt?: number;
}

/** How to open an activity when it is tapped. */
export interface OpenTarget {
  /** Absolute, or relative to the server the activity arrived from (a self-hosted server may not know
   *  its own public address — it sits behind a tunnel — so the receiver resolves the rest). */
  url: string;
  /** `app` = the sender asserts an app on this device handles the URL (our cockpit); `web` = always
   *  hand it to the platform's web handler; `auto` (default) = the receiver's own rule, which is
   *  "in-app if the origin is one of my servers, otherwise the browser". A receiver must never
   *  navigate its own authenticated UI to a foreign origin on a payload's say-so. */
  prefer?: "app" | "web" | "auto";
}

/** Device -> server: the operator pressed something on a notification. */
export interface ActionCallback {
  deviceId: string;
  activityId: string;
  revision: number;
  actionId: string;
  input?: string | null;
  ts: number;
  nonce?: string;
}

/** Server -> device WS frames. */
export type NotifyFrame =
  | { t: "hello"; deviceId: string; serverTime: number; cursor: number; live: boolean }
  | { t: "activity"; seq: number; activity: ActivityObject }
  | { t: "bye"; reason: string };

/** Server-side record: what was published + how to interpret its actions. */
export interface ActivityRecord {
  seq: number;
  activity: ActivityObject;
  /** Per-action handler refs, keyed by action id. Never sent to a device. */
  actionRefs: Record<string, NotifyRef>;
  publishedAt: number;
}

/**
 * What the phone is allowed to be told. These are the operator's switches, not the app's:
 * the app is a generic renderer, so "do I want a notification for this" is a server-side
 * decision that must be changeable without shipping a new APK.
 */
export interface NotifyRules {
  /** A turn started (the ongoing "running" card). */
  turnStart: boolean;
  /** The agent is waiting for an approval — the one you answer from the lock screen. */
  approval: boolean;
  /** A turn ended (done / failed). */
  completion: boolean;
  /** Do not push while the operator is looking at that very session in the cockpit. */
  quietWhenWatching: boolean;
}

export const DEFAULT_NOTIFY_RULES: NotifyRules = {
  turnStart: true,
  approval: true,
  completion: true,
  quietWhenWatching: true,
};

/** Which session the cockpit is showing right now (in-memory only — presence is ephemeral). */
export interface Presence {
  sessionId: string | null;
  visible: boolean;
  /** The operator is on a VOICE CALL with `sessionId` right now (page-reported, same TTL). A call is
   *  strictly more than "watching": the call is already reading the replies aloud, and its capture is a
   *  plain AudioRecord with no echo cancellation — so any notification tone lands in the agent's own
   *  microphone. While a call is live nothing may make a sound (see the center's `onCall`). */
  call?: boolean;
  at: number;
}