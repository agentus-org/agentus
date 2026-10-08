// NotifyCenter — the server side of the notify contract (docs/android-notify-contract.md).
//
// Responsibilities, and nothing else:
//   1. pair devices (short code or the operator's machine token) and hand out device tokens
//   2. publish activities and fan them out over a WebSocket, with a monotonic cursor so a
//      device that was asleep/asleep-behind-NAT can replay what it missed
//   3. route the button presses that come back (POST /api/notify/actions or a WS frame)
//      to the host's handler — that is the whole "add an interaction = add a handler" trick
//
// It owns no agent logic: the ACP event -> activity mapping lives in the clearly marked
// section at the bottom, and everything it produces goes through the same publish().
import fs from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { PermissionRequestView, ServerEvent } from "../../../shared/src/index.js";
import { DEFAULT_NOTIFY_RULES } from "./types.js";
import type {
  ActionCallback,
  ActivityObject,
  ActivityRecord,
  DeviceCapabilities,
  NotifyDevice,
  NotifyFrame,
  NotifyRef,
  NotifyRules,
  Presence,
  OpenTarget,
} from "./types.js";

export interface NotifyCenterOptions {
  /** `notify/` (state + event log) is created under here. */
  dataDir: string;
  /** Operator gate for the control routes. Absent = those routes are open (test bed only). */
  operator?: (req: IncomingMessage, url: URL) => boolean;
  /** Username+password pairing: the HOST owns the credential check and its rate limit. */
  credentials?: (username: string, password: string, ip: string) => { ok: boolean; reason?: string };
  /** Session title lookup, for activity subtitles. */
  sessionTitle?: (sessionId: string) => string | null;
  /** The companion APK, so the web panel can report its size (optional). */
  apkPath?: string;
  log?: (line: string) => void;
}

export interface ActionEvent {
  action: ActionCallback;
  activity: ActivityObject;
  ref: NotifyRef | null;
  device: NotifyDevice;
}

/** What a publisher may attach to an activity: how to read its buttons later. */
export interface PublishOptions {
  actionRefs?: Record<string, NotifyRef>;
  /** Skip the WS fan-out (used by replay tests). */
  silent?: boolean;
}

const REPLAY_LIMIT = 200; // how many activities stay replayable
const PAIR_ATTEMPTS = 10;
const PAIR_WINDOW_MS = 10 * 60_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1

/** The same frame with its sound taken away — see `publish` (a live call has to stay quiet).
 *  `muted` is set too: the app cannot turn an existing Android channel quiet, so it has to route this
 *  frame to its own quiet channel instead (see Notifier.apply). */
function silentChannel(a: ActivityObject): ActivityObject {
  if (!a.channel) return a;
  return { ...a, channel: { ...a.channel, importance: "low", sound: false, vibration: false, muted: true } };
}

interface NotifyState {
  code: string;
  seq: number;
  devices: NotifyDevice[];
  /** The operator's switches. Absent in a state file written before this existed. */
  rules?: NotifyRules;
}

/** The tap target, in the contract's terms.
 *
 *  `deeplink` is what an app built before the `open` object understands; `open` is the abstract form
 *  (a URL + how strongly the sender wants it in an app). Both are emitted from one place so they can
 *  never disagree, and the receiver keeps the final say (see OpenTarget).
 */
function tapTarget(url: string, prefer: OpenTarget["prefer"] = "app"): Pick<ActivityObject, "deeplink" | "open"> {
  return { deeplink: url, open: { url, prefer: prefer ?? "auto" } };
}

/** How a finished turn reads on a lock screen: 「用时 1m12s」.
 *
 *  The protocol's own answer (`stopReason: end_turn`) is a fact about the wire, not about the
 *  operator's wait — the ecosystem's version of this line is agent-notify's "Done in 12s" / AionUi's
 *  「已完成本轮回复」. Empty string when the duration is unknown, and then the card simply says less. */
function durationText(durationMs?: number): string {
  if (!durationMs || !Number.isFinite(durationMs) || durationMs < 0) return "";
  const total = Math.round(durationMs / 1000);
  if (total < 60) return `用时 ${Math.max(1, total)}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return total % 60 ? `用时 ${m}m ${total % 60}s` : `用时 ${m}m`;
  return `用时 ${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The session name rides FIRST IN THE BODY — never in `subtitle`.
 *
 *  Android draws `contentText` (our body) on the COLLAPSED row and `subText` (our subtitle) only on
 *  the expanded card, so a name parked in subtitle is a name nobody sees when they glance at the
 *  shade. Measured on the emulator: `android.title=跑完了` / `android.subText=hello` while the one
 *  visible line read `stopReason: end_turn`. AionUi solved the same problem the same way (conversation
 *  name at the front of the body). So every kind shares one shape: title = what happened,
 *  body = `<会话名> · <detail>`. */
function nameAndDetail(name: string, ...detail: Array<string | undefined | null>): string {
  return [name, ...detail.filter((d): d is string => Boolean(d && d.trim()))].join(" · ");
}

/** The agent's own tool title, split at its first ": ".
 *
 *  The head goes on the state line (short — the Xiaomi island clips a title at 20 chars), and the
 *  long half is nearly always the target (`Approve edit: /var/folders/…`), which belongs beside the
 *  session name on the body line. Nothing is invented here: both halves are the agent's own words. */
function splitToolTitle(raw: string | undefined): { head: string; target: string } {
  const text = (raw ?? "").trim();
  const at = text.indexOf(": ");
  if (at > 0 && at <= 24) return { head: text.slice(0, at), target: text.slice(at + 2).trim() };
  return { head: text, target: "" };
}

export class NotifyCenter {
  readonly dir: string;
  private readonly stateFile: string;
  private readonly eventsFile: string;
  private readonly log: (line: string) => void;
  private readonly operator: ((req: IncomingMessage, url: URL) => boolean) | null;
  private readonly credentials: ((username: string, password: string, ip: string) => { ok: boolean; reason?: string }) | null;
  private readonly sessionTitle: ((sessionId: string) => string | null) | null;
  /** The APK the phone installs (optional): the web panel reports its size from here. */
  private readonly apkPath: string | null = null;

  private state: NotifyState;
  private events: ActivityRecord[] = [];
  /** deviceId -> live socket */
  private readonly sockets = new Map<string, WebSocket>();
  private readonly pairAttempts = new Map<string, { count: number; until: number }>();
  /** actionKey -> when it was consumed, so a button can only fire once. */
  private readonly consumed = new Map<string, number>();
  private onActionCb: ((e: ActionEvent) => void) | null = null;
  private timers: NodeJS.Timeout[] = [];
  private wss: WebSocketServer | null = null;
  /** Which session the cockpit is showing, and whether its tab is visible. Deliberately in
   *  memory: presence is a fact about right now, not something to restore after a restart. */
  private presence: Presence = { sessionId: null, visible: false, at: 0 };
  /** How long a presence report stays believable without a refresh (the SPA re-reports every
   *  30s, so anything older than this means the tab was closed / the machine went to sleep). */
  private static readonly WATCH_TTL_MS = 90_000;

  /** The operator's switches, always complete (a state file may predate them). */
  rules(): NotifyRules {
    return { ...DEFAULT_NOTIFY_RULES, ...(this.state.rules ?? {}) };
  }

  setRules(patch: Partial<NotifyRules>): NotifyRules {
    const next: NotifyRules = { ...this.rules(), ...patch };
    this.state.rules = next;
    this.save();
    this.log(`[notify] rules turnStart=${next.turnStart} approval=${next.approval} completion=${next.completion} quietWhenWatching=${next.quietWhenWatching}`);
    return next;
  }

  /** The cockpit says which session it is looking at; null/visible=false means "nobody is". */
  setPresence(sessionId: string | null, visible: boolean, call = false): Presence {
    this.presence = {
      sessionId: sessionId || null,
      visible: Boolean(visible),
      call: Boolean(call),
      at: Date.now(),
    };
    return this.presence;
  }

  presenceNow(): Presence {
    return { ...this.presence };
  }

  /**
   * Is the operator on a VOICE CALL right now (any session)? Page-reported, same TTL as presence.
   *
   * Strictly stronger than "watching", which is why it is its own thing: on a call the replies are
   * already being read aloud by that very call, AND the call's own capture is a plain AudioRecord with
   * no echo cancellation — so a notification tone goes straight into the agent's microphone. Both
   * reasons point the same way: while a call is live, nothing may make a sound.
   */
  private onCall(): boolean {
    return Boolean(this.presence.call) && Date.now() - this.presence.at < NotifyCenter.WATCH_TTL_MS;
  }

  /** True when a notification for this session would interrupt the operator looking at it. */
  private watching(sessionId: string): boolean {
    if (!this.rules().quietWhenWatching) return false;
    if (this.presence.sessionId !== sessionId) return false;
    if (Date.now() - this.presence.at >= NotifyCenter.WATCH_TTL_MS) return false;
    // A call counts even when nobody has touched the screen for minutes: on a call the hands are free
    // and the page cannot know the difference between "listening" and "gone". The page's own idle
    // heuristic would switch presence off mid-conversation — which is how a "跑完了" card with sound
    // landed in the middle of a call.
    return this.presence.visible || Boolean(this.presence.call);
  }

  constructor(opts: NotifyCenterOptions) {
    this.dir = path.join(opts.dataDir, "notify");
    fs.mkdirSync(this.dir, { recursive: true });
    this.stateFile = path.join(this.dir, "state.json");
    this.eventsFile = path.join(this.dir, "events.json");
    this.log = opts.log ?? ((line: string) => console.log(line));
    this.operator = opts.operator ?? null;
    this.credentials = opts.credentials ?? null;
    this.sessionTitle = opts.sessionTitle ?? null;
    this.apkPath = opts.apkPath ?? null;
    this.state = this.loadState();
    this.events = this.loadEvents();
  }

  // ---- persistence ---------------------------------------------------------

  private loadState(): NotifyState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as Partial<NotifyState>;
      if (typeof raw.code === "string" && raw.code.length >= 6) {
        return {
          code: raw.code,
          seq: Number(raw.seq) || 0,
          devices: Array.isArray(raw.devices) ? raw.devices as NotifyDevice[] : [],
          // a state file from before rules existed means "all on" — the old behaviour
          rules: { ...DEFAULT_NOTIFY_RULES, ...(raw.rules ?? {}) },
        };
      }
    } catch { /* first boot */ }
    return { code: this.mintCode(), seq: 0, devices: [], rules: { ...DEFAULT_NOTIFY_RULES } };
  }

  private loadEvents(): ActivityRecord[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.eventsFile, "utf8")) as ActivityRecord[];
      return Array.isArray(raw) ? raw.slice(-REPLAY_LIMIT) : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    this.write(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  private saveEvents(): void {
    this.write(this.eventsFile, JSON.stringify(this.events.slice(-REPLAY_LIMIT), null, 2));
  }

  private write(file: string, body: string): void {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  private mintCode(): string {
    const bytes = randomBytes(8);
    let out = "";
    for (let i = 0; i < 8; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return out;
  }

  // ---- pairing -------------------------------------------------------------

  get code(): string {
    return this.state.code;
  }

  rotateCode(): string {
    this.state.code = this.mintCode();
    this.save();
    return this.state.code;
  }

  devices(): NotifyDevice[] {
    return this.state.devices.map((d) => ({ ...d, token: d.token }));
  }

  revoke(deviceId: string): boolean {
    const before = this.state.devices.length;
    this.state.devices = this.state.devices.filter((d) => d.deviceId !== deviceId);
    if (this.state.devices.length === before) return false;
    const sock = this.sockets.get(deviceId);
    if (sock) {
      this.finish(sock, "revoked");
      this.sockets.delete(deviceId);
    }
    this.save();
    return true;
  }

  /** Pairing: either the rotating short code (typed/pasted by the operator) or the
   *  machine token (scripts). A re-pair from the same device name replaces the old row. */
  pair(body: Record<string, unknown>, opts: { ip: string; machineTokenOk: boolean }): { device: NotifyDevice } | { error: string } {
    const code = String(body.code ?? "").trim().toUpperCase();
    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");

    // Three ways in, in descending order of what a phone can actually do: the operator's own
    // credential (scripts), the rotating short code (paste), or the operator's login
    // (username+password typed in the app) — the last one is what a phone in a hotel uses.
    let admitted = opts.machineTokenOk;
    if (!admitted && code) admitted = code === this.state.code;
    if (!admitted && username && password && this.credentials) {
      const check = this.credentials(username, password, opts.ip);
      if (!check.ok) return { error: check.reason ?? "bad username or password" };
      admitted = true;
    }

    if (!admitted) {
      // Code guessing is rate-limited per IP here; a wrong password is already accounted for
      // by the host's own login limiter, so it must not consume this budget too.
      const now = Date.now();
      const gate = this.pairAttempts.get(opts.ip);
      if (gate && gate.until > now && gate.count >= PAIR_ATTEMPTS) {
        return { error: "too many attempts, try later" };
      }
      if (code || !username) {
        const next = gate && gate.until > now ? gate : { count: 0, until: now + PAIR_WINDOW_MS };
        next.count += 1;
        this.pairAttempts.set(opts.ip, next);
        return { error: "bad pairing code" };
      }
      return { error: "wrong username or password" };
    }
    const caps = (body.capabilities ?? []) as string[];
    const name = String(body.deviceName ?? "device").slice(0, 60);
    const prior = this.state.devices.find((d) => d.name === name);
    if (prior) this.revoke(prior.deviceId);
    const device: NotifyDevice = {
      deviceId: `dev_${randomBytes(4).toString("hex")}`,
      token: randomBytes(24).toString("hex"),
      name,
      platform: (body.platform as NotifyDevice["platform"]) ?? "android",
      sdkInt: Number(body.sdkInt) || 0,
      appVersion: String(body.appVersion ?? "0.0.0"),
      schema: Number(body.schema) || 1,
      capabilities: Array.isArray(caps) ? caps.map(String) : [],
      createdAt: Date.now(),
      lastSeenAt: null,
      cursor: 0,
    };
    this.state.devices.push(device);
    this.save();
    this.log(`[notify] paired ${device.name} (${device.deviceId}) sdk=${device.sdkInt} caps=[${device.capabilities.join(",")}]`);
    return { device };
  }

  private deviceByToken(token: string | undefined | null): NotifyDevice | null {
    if (!token) return null;
    const want = Buffer.from(String(token));
    for (const d of this.state.devices) {
      const have = Buffer.from(d.token);
      if (have.length === want.length && timingSafeEqual(have, want)) return d;
    }
    return null;
  }

  private deviceById(deviceId: string): NotifyDevice | null {
    return this.state.devices.find((d) => d.deviceId === deviceId) ?? null;
  }

  // ---- publishing ----------------------------------------------------------

  /** Publish one activity. Returns the assigned seq (the cursor). */
  publish(activity: ActivityObject, opts: PublishOptions = {}): number {
    if (activity.op === "dismiss") {
      const seq = ++this.state.seq;
      this.remember({ seq, activity, actionRefs: {}, publishedAt: Date.now() });
      if (!opts.silent) this.fanout(seq, activity);
      return seq;
    }
    if (activity.op === "clear_all") {
      const seq = ++this.state.seq;
      this.events = [];
      this.state.seq = seq;
      this.remember({ seq, activity, actionRefs: {}, publishedAt: Date.now() });
      if (!opts.silent) this.fanout(seq, activity);
      return seq;
    }
    const seq = ++this.state.seq;
    // While a call is live the frame still goes out — the operator must be able to SEE it and act on it —
    // but silently. Not a style choice: the call's capture is a plain AudioRecord (no echo cancellation),
    // so the notification tone is recorded by the very microphone the agent is listening on.
    const wire = this.onCall() ? silentChannel(activity) : activity;
    // re-publishing an activity clears its replay guard: the buttons work again
    for (const key of [...this.consumed.keys()]) if (key.startsWith(`${activity.activityId}:`)) this.consumed.delete(key);
    this.remember({ seq, activity: wire, actionRefs: opts.actionRefs ?? {}, publishedAt: Date.now() });
    if (!opts.silent) this.fanout(seq, wire);
    return seq;
  }

  dismiss(activityId: string): number {
    return this.publish({ schema: 1, op: "dismiss", activityId, revision: this.nextRevision(activityId), title: "" });
  }

  private nextRevision(activityId: string): number {
    const prior = [...this.events].reverse().find((e) => e.activity.activityId === activityId);
    return (prior?.activity.revision ?? 0) + 1;
  }

  private remember(rec: ActivityRecord): void {
    this.events.push(rec);
    if (this.events.length > REPLAY_LIMIT) this.events = this.events.slice(-REPLAY_LIMIT);
    this.save();
    this.saveEvents();
  }

  private fanout(seq: number, activity: ActivityObject): void {
    for (const [deviceId, ws] of this.sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      // capability gate: a device that cannot render progress/actions gets the plain shape
      const device = this.deviceById(deviceId);
      this.send(ws, { t: "activity", seq, activity: device ? this.degrade(activity, device) : activity });
    }
  }

  /** Trim what a device cannot use. The server never branches on app version — only
   *  on the capabilities the device reported at pairing. */
  private degrade(activity: ActivityObject, device: NotifyDevice): ActivityObject {
    const caps = new Set(device.capabilities);
    const out: ActivityObject = { ...activity };
    if (!caps.has("progress")) out.progress = null;
    if (!caps.has("actions")) out.actions = [];
    if (!caps.has("remote_input")) out.input = null;
    if (!caps.has("icon_url")) out.iconUrl = null;
    if (!caps.has("channels")) out.channel = null;
    if (!caps.has("deeplink")) {
      // one capability covers both spellings: `deeplink` is the old alias of `open`
      out.deeplink = null;
      out.open = null;
    }
    if (!caps.has("live_update")) out.promotable = false;
    return out;
  }

  replaySince(cursor: number): ActivityRecord[] {
    return this.events.filter((e) => e.seq > cursor && e.activity.op !== "clear_all");
  }

  // ---- actions -------------------------------------------------------------

  onAction(cb: (e: ActionEvent) => void): void {
    this.onActionCb = cb;
  }

  /** Returns null when accepted, else the reason it was refused. */
  private accept(cb: ActionCallback, device: NotifyDevice): string | null {
    const rec = [...this.events].reverse().find((e) => e.activity.activityId === cb.activityId && e.activity.op !== "dismiss");
    if (!rec) return "unknown activity";
    const ref = rec.actionRefs[cb.actionId];
    if (!ref && !(rec.activity.actions ?? []).some((a) => a.id === cb.actionId)) return "unknown action";
    const key = `${cb.activityId}:${cb.actionId}`;
    if (this.consumed.has(key)) return "already handled";
    this.consumed.set(key, Date.now());
    this.onActionCb?.({
      action: { ...cb, deviceId: device.deviceId },
      activity: rec.activity,
      ref: ref ?? null,
      device,
    });
    return null;
  }

  // ---- HTTP ----------------------------------------------------------------

  /** Returns true when the request belonged to the notify centre. */
  async handleHttp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    if (!p.startsWith("/api/notify")) return false;
    const json = (code: number, body: unknown): true => {
      const wire = JSON.stringify(body);
      res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(wire);
      return true;
    };
    const readBody = async (): Promise<Record<string, unknown>> => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      if (!chunks.length) return {};
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        return {};
      }
    };
    const isOperator = (): boolean => (this.operator ? this.operator(req, url) : true);

    if (p === "/api/notify/settings") {
      if (!isOperator()) return json(401, { error: "operator auth required" }) && true;
      const scheme = this.isTls(req) ? "https" : "http";
      const base = `${scheme}://${String(req.headers.host ?? "localhost")}`;
      if (req.method === "POST") {
        const body = await readBody();
        const rules = this.setRules((body.rules ?? {}) as Partial<NotifyRules>);
        return json(200, { ok: true, rules }) && true;
      }
      const presence = this.presenceNow();
      return json(200, {
        rules: this.rules(),
        presence,
        watching: Boolean(presence.sessionId && this.watching(presence.sessionId)),
        code: this.state.code,
        pairUri: `agentus://pair?u=${encodeURIComponent(base)}&c=${this.state.code}`,
        apkUrl: "/agentus-companion.apk",
        apkBytes: this.apkPath && fs.existsSync(this.apkPath) ? fs.statSync(this.apkPath).size : null,
        devices: this.state.devices.map((d) => ({
          deviceId: d.deviceId, name: d.name, platform: d.platform, sdkInt: d.sdkInt,
          appVersion: d.appVersion, capabilities: d.capabilities, createdAt: d.createdAt,
          lastSeenAt: d.lastSeenAt, cursor: d.cursor, online: this.sockets.has(d.deviceId),
        })),
      }) && true;
    }

    if (p === "/api/notify/presence" && req.method === "POST") {
      // The cockpit telling us what it is showing. Operator-authenticated (the SPA has the
      // cookie); a missing report just means presence goes stale and quiet-when-watching stops
      // applying, which is the safe direction.
      if (!isOperator()) return json(401, { error: "operator auth required" }) && true;
      const body = await readBody();
      const presence = this.setPresence(
        body.sessionId == null ? null : String(body.sessionId),
        body.visible !== false,
        body.call === true,
      );
      return json(200, {
        ok: true, presence,
        watching: Boolean(presence.sessionId && this.watching(presence.sessionId)),
      }) && true;
    }

    if (p === "/api/notify/push" && req.method === "POST") {
      if (!isOperator()) return json(401, { error: "operator auth required" }) && true;
      const body = await readBody();
      // A third-party sender may ask for a plain web link; `open.prefer` is the contract's way to say
      // that (docs/android-notify-contract.md §5.2). Anything else keeps the cockpit default.
      const prefer = (body.open as { prefer?: unknown } | undefined)?.prefer;
      const seq = this.pushNow({
        sessionId: body.sessionId ? String(body.sessionId) : null,
        title: String(body.title ?? "来自驾驶舱的推送"),
        body: body.body ? String(body.body) : undefined,
        kind: body.kind === "approval" ? "approval" : body.kind === "island" ? "island" : "note",
        path: body.path === "aosp" || body.path === "xiaomi" ? String(body.path) : undefined,
        openPrefer: prefer === "web" || prefer === "auto" || prefer === "app" ? prefer : undefined,
      });
      return json(200, { ok: true, seq }) && true;
    }

    if (p === "/api/notify/health") {
      return json(200, { ok: true, code: isOperator() ? this.state.code : null, devices: this.state.devices.length, seq: this.state.seq }) && true;
    }

    if (p === "/api/notify/pair" && req.method === "POST") {
      const body = await readBody();
      // Two ways in: the rotating short code (what a human pastes into the app), or the
      // operator's own credential (scripts/CI — whoever can already drive the server).
      const machineTokenOk = isOperator();
      const out = this.pair(body, { ip: this.ip(req), machineTokenOk });
      if ("error" in out) return json(403, out) && true;
      const scheme = this.isTls(req) ? "https" : "http";
      const host = String(req.headers.host ?? "localhost");
      const base = `${scheme}://${host}`;
      return json(200, {
        deviceId: out.device.deviceId,
        deviceToken: out.device.token,
        baseUrl: base,
        wsUrl: `${scheme === "https" ? "wss" : "ws"}://${host}/api/notify/ws`,
        serverTime: Date.now(),
      }) && true;
    }

    if (p === "/api/notify/pair-code" && req.method === "GET") {
      if (!isOperator()) return json(401, { error: "operator auth required" }) && true;
      const scheme = this.isTls(req) ? "https" : "http";
      const host = String(req.headers.host ?? "localhost");
      const base = `${scheme}://${host}`;
      return json(200, {
        code: this.state.code,
        pairUri: `agentus://pair?u=${encodeURIComponent(base)}&c=${this.state.code}`,
        baseUrl: base,
        wsUrl: `${scheme === "https" ? "wss" : "ws"}://${host}/api/notify/ws`,
      }) && true;
    }

    if (p === "/api/notify/pair-code/rotate" && req.method === "POST") {
      if (!isOperator()) return json(401, { error: "operator auth required" }) && true;
      return json(200, { code: this.rotateCode() }) && true;
    }

    if (p === "/api/notify/devices" && req.method === "GET") {
      if (!isOperator()) return json(401, { error: "operator auth required" }) && true;
      return json(200, {
        devices: this.state.devices.map((d) => ({
          deviceId: d.deviceId, name: d.name, platform: d.platform, sdkInt: d.sdkInt,
          appVersion: d.appVersion, capabilities: d.capabilities, createdAt: d.createdAt,
          lastSeenAt: d.lastSeenAt, cursor: d.cursor, online: this.sockets.has(d.deviceId),
          diag: d.diag ?? null,
        })),
      }) && true;
    }

    if (p === "/api/notify/devices/revoke" && req.method === "POST") {
      if (!isOperator()) return json(401, { error: "operator auth required" }) && true;
      const body = await readBody();
      return json(200, { ok: this.revoke(String(body.deviceId ?? "")) }) && true;
    }

    if (p === "/api/notify/activities" && req.method === "POST") {
      if (!isOperator()) return json(401, { error: "operator auth required" }) && true;
      const body = await readBody();
      const input = body.activity as Partial<ActivityObject> | undefined;
      // A dismissal legitimately carries no title; an upsert must have one, or nothing renders.
      const needsTitle = input?.op !== "dismiss";
      if (!input?.activityId || (needsTitle && !input.title)) {
        return json(400, { error: "activityId required (and title, unless op=dismiss)" }) && true;
      }
      const activity = { ...input, schema: 1 as const, op: input.op ?? "upsert", revision: input.revision ?? 1 } as ActivityObject;
      const seq = this.publish(activity);
      return json(200, { ok: true, seq }) && true;
    }

    if (p === "/api/notify/probe" && req.method === "POST") {
      // Operator OR a paired device: the probe sends a canned sequence and is how the
      // phone's own "test notification" button works without shipping the operator token.
      const asDevice = this.deviceByToken(this.tokenOf(req, url)) !== null;
      if (!isOperator() && !asDevice) return json(401, { error: "operator or device auth required" }) && true;
      return json(200, { ok: true, queued: this.probe() }) && true;
    }

    if (p === "/api/notify/events" && req.method === "GET") {
      if (!isOperator()) return json(401, { error: "operator auth required" }) && true;
      const since = Number(url.searchParams.get("since") ?? 0);
      return json(200, { seq: this.state.seq, events: this.replaySince(since) }) && true;
    }

    if (p === "/api/notify/diag" && req.method === "POST") {
      // The device reporting on itself. Device-authenticated, and deliberately dumb: it stores the
      // text and the version, nothing else. "上岛没反应" or "语音报错" then has a cause in the state
      // file instead of a guess over chat.
      const device = this.deviceByToken(this.tokenOf(req, url));
      if (!device) return json(401, { error: "device token required" }) && true;
      const body = await readBody();
      const text = String(body.text ?? "").trim().slice(0, 4000);
      if (!text) return json(400, { error: "text required" }) && true;
      device.diag = { at: Date.now(), text };
      if (body.appVersion) device.appVersion = String(body.appVersion).slice(0, 24);
      device.lastSeenAt = Date.now();
      this.save();
      this.log(`[notify] diag from ${device.name} v${device.appVersion}: ${text.split("\n").find((l) => l.trim()) ?? ""}`);
      return json(200, { ok: true }) && true;
    }

    if (p === "/api/notify/actions" && req.method === "POST") {
      const device = this.deviceByToken(this.tokenOf(req, url));
      if (!device) return json(401, { error: "device token required" }) && true;
      const body = await readBody() as unknown as ActionCallback;
      if (!body?.activityId || !body?.actionId) return json(400, { error: "activityId and actionId required" }) && true;
      const refused = this.accept({ ...body, deviceId: device.deviceId, ts: body.ts ?? Date.now() }, device);
      if (refused) return json(409, { ok: false, error: refused }) && true;
      return json(200, { ok: true, note: "received" }) && true;
    }

    return false;
  }

  private ip(req: IncomingMessage): string {
    const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
    return fwd || req.socket.remoteAddress || "unknown";
  }

  private isTls(req: IncomingMessage): boolean {
    return Boolean((req.socket as { encrypted?: boolean }).encrypted) ||
      String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
  }

  private tokenOf(req: IncomingMessage, url: URL): string | null {
    const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
    return bearer ?? url.searchParams.get("token");
  }

  // ---- WebSocket -----------------------------------------------------------

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/api/notify/ws") return false;
    const device = this.deviceByToken(this.tokenOf(req, url));
    if (!device) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
      socket.destroy();
      return true;
    }
    // The running build reports itself on every connect: the version stored at pairing time goes
    // stale the moment the operator sideloads a new APK, and "which build is on the phone" is
    // otherwise unanswerable from here.
    const v = url.searchParams.get("v");
    if (v) {
      const clean = v.slice(0, 24).replace(/[^\w.+-]/g, "");
      if (clean && clean !== device.appVersion) {
        device.appVersion = clean;
        this.save();
      }
    }
    this.wss ??= new WebSocketServer({ noServer: true });
    this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, device, Number(url.searchParams.get("since") ?? -1)));
    return true;
  }

  private attach(ws: WebSocket, device: NotifyDevice, since: number): void {
    const prior = this.sockets.get(device.deviceId);
    if (prior && prior !== ws) this.finish(prior, "replaced");
    this.sockets.set(device.deviceId, ws);
    const row = this.deviceById(device.deviceId) ?? device;
    row.lastSeenAt = Date.now();
    this.save();

    // The device's own cursor wins over the server's memory of it: a device that reinstalled
    // passes since=0 and must get everything, one that already saw seq N passes N.
    const cursor = since >= 0 ? Math.max(since, row.cursor) : row.cursor;
    this.send(ws, { t: "hello", deviceId: row.deviceId, serverTime: Date.now(), cursor, live: since < 0 });
    for (const rec of this.replaySince(cursor)) {
      this.send(ws, { t: "activity", seq: rec.seq, activity: this.degrade(rec.activity, row) });
    }
    this.log(`[notify] ${row.name} connected (cursor ${cursor} -> replay ${this.replaySince(cursor).length})`);

    ws.on("message", (data: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.t === "ack") {
        const n = Number(msg.cursor);
        if (Number.isFinite(n)) {
          row.cursor = Math.max(row.cursor, n);
          this.save();
        }
        return;
      }
      if (msg.t === "action") {
        const refused = this.accept({ ...(msg as unknown as ActionCallback), deviceId: row.deviceId, ts: Date.now() }, row);
        this.send(ws, { t: "bye", reason: refused ? `refused: ${refused}` : "action-ok" });
        if (!refused) row.cursor = Math.max(row.cursor, this.state.seq);
        this.save();
      }
    });
    ws.on("close", () => {
      if (this.sockets.get(row.deviceId) === ws) this.sockets.delete(row.deviceId);
    });
    ws.on("error", () => { /* close follows */ });
  }

  private send(ws: WebSocket, frame: NotifyFrame): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }

  private finish(ws: WebSocket, reason: string): void {
    try {
      this.send(ws, { t: "bye", reason });
      ws.close();
    } catch { /* already gone */ }
  }

  // ---- test scaffolding ----------------------------------------------------

  /**
   * The cockpit's "推到手机" button: one activity, right now, through the same publish() as
   * everything else. Deliberately NOT filtered by the rules — pressing the button IS the
   * intent, and a button that silently does nothing because a rule said so would be a lie.
   */
  pushNow(opts: {
    sessionId: string | null;
    title: string;
    body?: string;
    kind?: "note" | "approval" | "island";
    /** Promotion path for the device: "" = the app's own order (vendor first), "aosp" = Android 16's
     *  own Live Update only, "xiaomi" = the vendor island only. */
    path?: string;
    /** The sender's strength of preference for opening in an app (a third-party push can ask for a
     *  plain web link with "web"). Defaults to "app": the cockpit is where this is meant to land. */
    openPrefer?: OpenTarget["prefer"];
  }): number {
    const approval = opts.kind === "approval";
    // "island": an ongoing promotable card, i.e. the shape that CAN be promoted at all — the one the
    // operator's island question is about. A finished notification is never an island on either path.
    const island = opts.kind === "island";
    /** The session name (or 「驾驶舱」 for a session-less push). It goes FIRST IN THE BODY so the
     *  collapsed row always says which conversation this is — see `nameAndDetail`. */
    const name = opts.sessionId
      ? (this.sessionTitle?.(opts.sessionId) ?? opts.sessionId.slice(0, 8))
      : "驾驶舱";
    const deeplink = opts.sessionId ? `/?session=${encodeURIComponent(opts.sessionId)}` : "/";
    const activity: ActivityObject = {
      schema: 1, op: "upsert", activityId: `push:${Date.now()}`, revision: 1,
      kind: approval ? "approval" : island ? "agent_running" : "agent_done",
      priority: island ? "low" : "high",
      ongoing: island, promotable: island,
      title: opts.title.slice(0, 80),
      body: nameAndDetail(name, opts.body),
      channel: island
        ? { id: "agent_running", name: "任务运行中", importance: "low", sound: false }
        : {
            id: approval ? "agent_approval" : "agent_done",
            name: approval ? "权限请求" : "任务完成",
            importance: "high", sound: true, vibration: true,
          },
      ...(island
        ? { progress: { value: 0.4, segments: [{ length: 4, color: "#2f6f4f" }, { length: 6, color: "#e2e2dd" }] } }
        : {}),
      actions: [{ id: "open", label: "打开", style: "primary" }],
      smallIcon: "agentus", ...tapTarget(deeplink, opts.openPrefer),
      visibility: island ? "public" : "private",
    };
    if (opts.path) activity.path = opts.path;
    return this.publish(activity, {
      actionRefs: { open: opts.sessionId ? { type: "open", sessionId: opts.sessionId } : { type: "probe" } },
    });
  }

  /** A canned sequence that exercises every field the contract can carry:
   *  running (promoted) -> progress update -> approval with buttons + reply -> done. */
  probe(): { steps: number } {
    const link = "/";
    const steps: ActivityObject[] = [
      {
        schema: 1, op: "upsert", activityId: "probe:running", revision: 1, kind: "agent_running",
        priority: "low", ongoing: true, promotable: true,
        title: "Agentus · 运行中", body: "探针会话 · 第 1 步：读取代码",
        progress: { indeterminate: true },
        channel: { id: "agent_running", name: "任务运行中", importance: "low", sound: false },
        smallIcon: "agentus", ...tapTarget(link), visibility: "public",
      },
      {
        schema: 1, op: "upsert", activityId: "probe:running", revision: 2, kind: "agent_running",
        priority: "low", ongoing: true, promotable: true,
        title: "Agentus · 运行中", body: "探针会话 · 第 2 步：运行测试（进度 60%）",
        progress: { value: 0.6, segments: [{ length: 6, color: "#4f8" }, { length: 4, color: "#556" }] },
        channel: { id: "agent_running", name: "任务运行中", importance: "low", sound: false },
        smallIcon: "agentus", ...tapTarget(link), visibility: "public",
      },
      {
        schema: 1, op: "upsert", activityId: "probe:approval", revision: 1, kind: "approval",
        priority: "high", ongoing: true, promotable: true,
        title: "待你确认：写文件", body: "探针会话 · edit /etc/hosts — 允许这次操作？",
        channel: { id: "agent_approval", name: "权限请求", importance: "high", sound: true, vibration: true },
        actions: [
          { id: "allow_once", label: "仅此次", style: "primary" },
          { id: "allow_always", label: "总是允许", style: "default" },
          { id: "reject_once", label: "拒绝", style: "danger" },
        ],
        input: { enabled: true, placeholder: "或直接回一句" },
        smallIcon: "agentus", ...tapTarget(link), visibility: "private",
      },
      // A canned frame cannot know how long a real turn took, so this one carries no 「用时」: the
      // duration is measured in the real `turn-end` path (see durationText).
      {
        schema: 1, op: "upsert", activityId: "probe:done", revision: 1, kind: "agent_done",
        priority: "high", ongoing: false, promotable: false,
        title: "已完成", body: "探针会话 · 探针序列结束",
        channel: { id: "agent_done", name: "任务完成", importance: "high", sound: true },
        actions: [{ id: "open", label: "查看", style: "primary" }],
        smallIcon: "agentus", ...tapTarget(link), visibility: "private",
      },
    ];
    const [running, progress, approval, done] = steps;
    const actionRefs: Record<string, NotifyRef> = {
      allow_once: { type: "probe" }, allow_always: { type: "probe" }, reject_once: { type: "probe" }, open: { type: "probe" },
    };
    this.publish(running);
    this.timers.push(setTimeout(() => this.publish(progress), 3000));
    this.timers.push(setTimeout(() => {
      this.dismiss("probe:running");
      this.publish(approval, { actionRefs });
      this.publish(done, { actionRefs: { open: { type: "probe" } } });
    }, 6000));
    return { steps: steps.length };
  }

  close(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    for (const ws of this.sockets.values()) this.finish(ws, "server shutting down");
    this.sockets.clear();
  }

  // ---- ACP event -> activity ----------------------------------------------
  // The only place that knows what an Agentus event MEANS. Everything it emits
  // goes back through publish(), so the contract stays the single wire format.

  /** Called for every ServerEvent the session manager emits. */
  observe(evt: ServerEvent): void {
    const title = (sessionId: string): string => this.sessionTitle?.(sessionId) ?? sessionId.slice(0, 8);
    const link = (sessionId: string): string => `/?session=${encodeURIComponent(sessionId)}`;
    switch (evt.t) {
      case "turn-start":
        // The rules gate BEFORE anything else: an event that is switched off must not even be
        // evaluated against presence (and a suppressed event must not be mistaken for a bug).
        if (!this.rules().turnStart || this.watching(evt.sessionId)) return;
        this.publish({
          schema: 1, op: "upsert", activityId: `turn:${evt.sessionId}`, revision: this.nextRevision(`turn:${evt.sessionId}`),
          kind: "agent_running", priority: "low", ongoing: true, promotable: true,
          title: "Agentus · 运行中",
          body: nameAndDetail(title(evt.sessionId), evt.trace?.model, evt.trace?.effort),
          progress: { indeterminate: true },
          channel: { id: "agent_running", name: "任务运行中", importance: "low", sound: false },
          smallIcon: "agentus", ...tapTarget(link(evt.sessionId)), visibility: "public",
        });
        return;
      case "permission":
        // Never suppressed by presence: this is a decision waiting on a human, and the whole
        // point of the phone being in the loop is answering it while away from the desk.
        if (!this.rules().approval) return;
        this.publishApproval(evt.request, title(evt.request.sessionId), link(evt.request.sessionId));
        return;
      case "permission-resolved":
        // Always clear the card, even if the request itself was never published — a stale
        // "waiting for you" on the phone is worse than no notification at all.
        this.dismiss(`perm:${evt.requestId}`);
        return;
      case "turn-end": {
        // The running card goes away unconditionally — a zombie "still running" on the phone is worse
        // than no card at all, even when the frame that started it was suppressed.
        this.dismiss(`turn:${evt.sessionId}`);
        // Both gates belong here and both were missing: `completion` was stored but never read, and
        // presence was only consulted for turn-start — so the completion card fired while the operator was watching
        // the very session (and, mid-call, with a sound: the reported bug).
        if (!this.rules().completion || this.watching(evt.sessionId)) return;
        const failed = Boolean(evt.error);
        this.publish({
          schema: 1, op: "upsert", activityId: `done:${evt.sessionId}:${Date.now()}`, revision: 1,
          kind: failed ? "error" : "agent_done", priority: "high", ongoing: false, promotable: false,
          title: failed ? "执行失败" : "已完成",
          body: nameAndDetail(title(evt.sessionId),
            failed ? String(evt.error).slice(0, 140) : durationText(evt.durationMs)),
          channel: {
            id: failed ? "agent_error" : "agent_done",
            name: failed ? "任务出错" : "任务完成",
            importance: "high", sound: true,
          },
          actions: [{ id: "open", label: "查看", style: "primary" }],
          smallIcon: "agentus", ...tapTarget(link(evt.sessionId)), visibility: "private",
        }, { actionRefs: { open: { type: "open", sessionId: evt.sessionId } } });
        return;
      }
      case "error":
        this.publish({
          schema: 1, op: "upsert", activityId: `error:${Date.now()}`, revision: 1, kind: "error",
          priority: "high", ongoing: false, promotable: false, title: "Agentus 报错",
          body: String(evt.error).slice(0, 160),
          channel: { id: "agent_error", name: "任务出错", importance: "high", sound: true },
          smallIcon: "agentus", visibility: "private",
        });
        return;
      default:
        return;
    }
  }

  private publishApproval(request: PermissionRequestView, sessionTitle: string, link: string): void {
    const actions = request.options.slice(0, 3).map((o) => ({
      id: o.optionId,
      label: o.name.slice(0, 24),
      style: (/^(allow|accept|approve|yes)/i.test(o.kind) ? "primary" : /reject|deny|no/i.test(o.kind) ? "danger" : "default") as
        "primary" | "danger" | "default",
    }));
    const actionRefs: Record<string, NotifyRef> = {};
    for (const o of request.options) {
      actionRefs[o.optionId] = {
        type: "permission", sessionId: request.sessionId, requestId: request.requestId,
        optionId: o.optionId, optionKind: o.kind, signature: `${o.kind}:${request.toolCallTitle}`,
      };
    }
    const tool = splitToolTitle(request.toolCallTitle);
    this.publish({
      schema: 1, op: "upsert", activityId: `perm:${request.requestId}`, revision: 1, kind: "approval",
      priority: "high", ongoing: true, promotable: true,
      title: tool.head ? `待你确认：${tool.head.slice(0, 60)}` : "待你确认",
      body: nameAndDetail(sessionTitle, tool.target || request.kind),
      channel: { id: "agent_approval", name: "权限请求", importance: "high", sound: true, vibration: true },
      actions: actions.length ? actions : [{ id: "open", label: "查看", style: "primary" }],
      input: { enabled: true, placeholder: "或直接回一句" },
      smallIcon: "agentus", ...tapTarget(link), visibility: "private",
    }, { actionRefs });
  }
}