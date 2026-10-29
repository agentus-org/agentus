// 工作播报 (issue #16): ONE long-lived observer agent per watched session, driven by the cockpit.
//
// WHY AN AGENT AND NOT A TEMPLATE
// The cockpit could say 「回合结束了」 by itself — that is exactly what #11's plan title does, and it
// stays as the fallback. What it cannot do is NOTICE: 「第三步失败了，它在重试同一条命令」 is a
// judgement about a transcript, and a string template that tries to make that judgement is a
// summariser nobody can debug. So the cockpit hires a reader: a normal ACP session with its own
// transcript, spawned once, kept alive, and asked one line per event (「看看进展」). Because it is
// long-lived its context carries over — the second brief costs a line, not the whole story — and
// because its facts come from the cockpit CLI (`$AGENTUS_COCKPIT_BIN`, issue #15) the trigger line
// never has to carry data that could be wrong.
//
// WHAT THIS MODULE IS ALLOWED TO KNOW
// Nothing about agents' internals. It reads ServerEvents off the same emitter the browser reads,
// decides "is this worth a voice", and (for two event kinds) formats the line ITSELF with no model
// call at all: an approval waiting and a plan step closing are facts, and paying a model to restate a
// fact is how a cockpit becomes expensive and vague.
//
// THE OBSERVER IS A SYSTEM SESSION
// Its working directory is a scratch directory of its own (`<home>/observers/<sid>`), never the
// observed session's cwd: an observer runs a full agent runtime with file and shell tools, and it
// should no more be able to write into the project than a log shipper should. `system: true` keeps it
// out of the rail and out of the cockpit CLI's scope (see SessionManager.list). It is spawned ONCE
// and reused; the idle reaper may put it to sleep like any slot, and `#ensure()` below wakes it.
//
// THREE THINGS THIS FILE LEARNED THE HARD WAY (issues #23 / #24, 2026-10-18)
//  1. **The scope is the session on screen.** 「替你看所有会话」 is not the feature — the rail already
//     does that, and four busy sessions used to grow four observer processes all talking over each
//     other. Every trigger now asks `watching()` (the notify centre's presence, the same fact the
//     quiet-when-watching rule uses), and a focus change CLOSES the previous observer, so the number
//     of observer processes is bounded by one.
//  2. **A reaped observer must not be a dead end.** `observerId` used to be trusted forever: once the
//     idle reaper took the process, every later brief said 「播报失败：no such session」 until the
//     server restarted. `#ensure()` is the fix the old header comment had already promised.
//  3. **A turn that never ends produces no `turn-end`.** Event-driven only means a 20-minute turn is
//     20 minutes of silence — the exact complaint that opened #24. The ticker now speaks on a beat,
//     but ONLY while a turn is in flight (see `intervalSec`): the timer covers the blind spot, it
//     does not become a metronome for an idle cockpit.
import fs from "node:fs";
import path from "node:path";
import type { BackendId, ServerEvent } from "../../../shared/src/index.js";
import type { ObserverSettings } from "../settings.js";
import type { SpeakMode } from "../session-speak.js";
import { OBSERVER_PROMPT_DEFAULT } from "../settings.js";

/** Spoken lines are short on purpose: they are heard once, in the middle of other work. */
export const BRIEF_MAX = 120;

/** How many model-backed briefs one turn may cost, heartbeat included (issue #24).
 *
 *  The ticker is already bounded by `intervalSec`; this is the second wall. A turn that runs two
 *  hours at a 1-minute beat would otherwise buy 120 paragraphs, and the operator would have learned
 *  to ignore all of them long before the last one arrived. */
export const MAX_BRIEFS_PER_TURN = 8;

/** How often the ticker looks. Cheap (a few comparisons), and finer than the smallest beat offered
 *  (1 minute), so a 1-minute interval is not silently rounded up to two. */
const TICK_MS = 15_000;

export interface ObserverDeps {
  /** Live settings, read per event — the switch must work without a restart. */
  settings(): ObserverSettings;
  /** The speaker position that applies to ONE session (issue #68): a session the operator set up
   *  itself wins, otherwise the global default. This replaced a single global `speakEnabled()`,
   *  which was why turning the horn on in one session made every other session start talking. */
  speakOf?(sessionId: string): { mode: SpeakMode; intervalSec: number };
  /** Legacy fallback for hosts and unit tests that only know the global switch. */
  speakEnabled?(): boolean;
  /** Spawn a SYSTEM session (out of the rail); returns our id for it. */
  createSession(backend: BackendId, cwd: string, title: string): Promise<string>;
  /** Send one line to a session. Never `interrupt`: an observer must not take the floor. */
  prompt(sessionId: string, text: string): Promise<void>;
  /** Resolve once a freshly spawned session can accept a prompt (its handshake finished). */
  waitReady(sessionId: string, timeoutMs?: number): Promise<void>;
  /** The title a session is known by (for the trigger line and the prompt header). */
  titleOf(sessionId: string): string | null;
  /** Which backend the observed session runs on (used when the observer follows it). */
  backendOf(sessionId: string): BackendId | null;
  /** #11's one-line task title for a session — the zero-cost fallback when no observer can speak. */
  planTitleOf?(sessionId: string): string | null;
  /** Close (or just forget) an observer whose observed session is gone. */
  disposeSession?(observerId: string): Promise<void>;
  /** Best-effort: move a session into a read-only mode if the backend offers one. */
  preferReadonly?(sessionId: string): void;
  /** Is the operator looking at THIS session right now — the NOTIFY centre's presence, which asks
   *  「is he in front of the screen」. Absent = every session counts. */
  watching?(sessionId: string): boolean;
  /** 播报的「这是他当前那个会话吗」(issue #69 §5): sessionId + TTL only, NO 「2 分钟内动过键鼠」.
   *  工作播报 exists precisely so the operator can look away — reusing the notification's
   *  screen-presence test for it made the beat require him to be watching, which defeats the feature.
   *  Absent = fall back to `watching`, so an old host keeps working. */
  onSession?(sessionId: string): boolean;
  /** Does this session still have a live ACP process? Absent = assume yes. This is the half of #23
   *  that turns a reaped observer into a recoverable one instead of a permanent 「播报失败」. */
  alive?(sessionId: string): boolean;
  /** Base directory for per-observer scratch dirs. */
  home: string;
  emit(evt: ServerEvent): void;
  now?(): number;
}

interface Watch {
  /** The session being watched (the watch map is keyed by it too; kept for the observer's side). */
  observedId: string;
  /** Our observer session id, once one exists. */
  observerId: string | null;
  /** A spawn is in flight — do not start a second one. */
  spawning: boolean;
  /** When the last MODEL-backed brief was ASKED for (feeds both the min-gap and the beat). */
  lastBriefAt: number;
  /** The trigger is owed: an event arrived while a brief was still being produced. */
  queued: boolean;
  /** WHICH trigger is owed — a heartbeat must not be replayed as a turn-end brief. */
  queuedKind: "turn-end" | "heartbeat";
  /** Text of the observer's current turn, accumulated from `message` frames. */
  answer: string;
  /** True while the observer is producing a brief. */
  busy: boolean;
  /** Plan step keys already announced, so an unchanged plan is not read out twice. */
  announcedSteps: Set<string>;
  /** A turn is IN FLIGHT (a `turn-start` arrived and its `turn-end` has not). The heartbeat's gate:
   *  no turn in flight, no beat — an idle session has nothing to report and must stay silent. */
  inflight: boolean;
  /** When a frame for this session was last seen. 「还有没有动静」 is measured from here. */
  lastActivityAt: number;
  /** When the current turn started (for 「已经跑了 N 分钟」). */
  startedAt: number;
  /** Model-backed briefs spent on the CURRENT turn (the MAX_BRIEFS_PER_TURN counter). */
  briefsThisTurn: number;
  /** The last line actually SPOKEN for this watch, normalised (#76 C). `MAX_BRIEFS_PER_TURN` and
   *  `throttleSec` are time/quantity gates; neither stops 「同一件事换个说法」 — and after a switch
   *  away and back the observer is rebuilt with `history = 0`, so it cannot remember its own last
   *  sentence. Remembering it HERE is the only place that survives a re-spawn. */
  lastSpoken: string;
  /** Why the last beat skipped this watch (issue #69 §6): the beat used to be silent in every sense —
   *  no sound, no log line, no field on the diagnostic endpoint, so 「它到底有没有在跑」 could only be
   *  guessed at. Kept per watch and cheap (one small object). */
  lastSkip: { reason: SkipReason; at: number } | null;
}

/** Every reason a beat can decline to speak. The names are the contract with `/api/observer`. */
export type SkipReason =
  | "disabled"        // the observer section itself is off
  | "speaker-off"     // this session's speaker is not in 工作播报
  | "no-beat"         // speaker is on 工作播报 but no interval was chosen
  | "busy"            // a brief is already being produced
  | "not-inflight"    // no turn running → nothing to report
  | "not-current"     // not the session the operator is on
  | "no-beat-yet"     // the interval has not elapsed
  | "per-turn-cap"    // MAX_BRIEFS_PER_TURN reached
  | "duplicate";      // said the same thing as the previous line (#76)

const NOTHING = "（没有可播报的进展）";

/** Normalise for the duplicate check: what a LISTENER would call the same sentence.
 *
 *  Punctuation, spacing and the speaker's own furniture (「还在跑」「暂时没有新输出」) carry no
 *  information when the line is read aloud, and a model asked to repeat a template reproduces it
 *  with different commas each time. Two lines that differ only in those are the same line. */
function sameLine(a: string, b: string): boolean {
  if (!a || !b) return false;
  const norm = (s: string): string => s.replace(/[\s，。、,.!！?？:：;；"'“”‘’（）()【】\[\]…—-]+/g, "");
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // Same sentence with one clause added or dropped ("X 还在跑" vs "X 还在跑，暂时没有新输出"): a
  // containment check catches it without pretending to be fuzzy matching. Anything looser starts
  // swallowing real news ("跑到第 3 步" vs "跑到第 4 步" must NOT be a duplicate).
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 6 && long.includes(short) && short.length / long.length >= 0.6;
}

/** Cut a model's answer down to one spoken line: first non-empty line, no Markdown furniture, no
 *  quotes, hard cap. A brief is read aloud, so anything resembling formatting is noise. */
export function oneLine(text: string, max = BRIEF_MAX): string {
  const first = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*#>\d.)\s]+)/, "").trim())
    .find((l) => l.length > 0) ?? "";
  const flat = first
    .replace(/[*_`]/g, "")
    .replace(/^["'「『]+|["'」』]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 「7 分钟」 / 「1 小时 12 分钟」 — the one fact a heartbeat has without a model call. */
export function minutesLabel(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  return min < 60 ? `${min} 分钟` : `${Math.floor(min / 60)} 小时 ${min % 60} 分钟`;
}

export class ObserverHub {
  #deps: ObserverDeps;
  #watch = new Map<string, Watch>();
  /** Observer ids, so their own frames are never mistaken for the operator's sessions. */
  #observers = new Set<string>();
  #now: () => number;
  #timer: ReturnType<typeof setInterval> | null = null;
  /** how many times the ticker has run — `GET /api/observer` prints it, and 「节拍没动静」 has to be
   *  distinguishable from 「timer 没起来」. */
  #ticks = 0;

  constructor(deps: ObserverDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  observerIds(): string[] {
    return [...this.#observers];
  }

  isObserver(sessionId: string): boolean {
    return this.#observers.has(sessionId);
  }

  /** Everything the hub currently holds, for `GET /api/observer` and the QA sweeps. Read-only and
   *  cheap: 工作播报's bookkeeping used to be invisible from outside, which is why 「它到底有没有在
   *  看这个会话」 could only be guessed at from the speak frames. */
  ticks(): number {
    return this.#ticks;
  }

  debug(): {
    watched: string; observerId: string | null; inflight: boolean; busy: boolean; briefs: number;
    watching: boolean; quietMs: number; mode: SpeakMode; intervalSec: number;
    skip: SkipReason | null; skipAgoMs: number | null;
  }[] {
    const now = this.#now();
    return [...this.#watch.values()].map((w) => ({
      watched: w.observedId,
      observerId: w.observerId,
      inflight: w.inflight,
      busy: w.busy,
      briefs: w.briefsThisTurn,
      watching: this.#watching(w.observedId),
      quietMs: now - w.lastActivityAt,
      mode: this.#mode(w.observedId),
      intervalSec: this.#beat(w.observedId),
      skip: w.lastSkip?.reason ?? null,
      skipAgoMs: w.lastSkip ? now - w.lastSkip.at : null,
    }));
  }

  /** Start the beat (issue #24). Called AFTER the notify centre exists, because the gate reads its
   *  presence — a ticker started earlier would be a timer reading an uninitialised `const`. */
  start(intervalMs = TICK_MS): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.tick(), intervalMs);
    // Never let a server keep a process alive just for this timer.
    (this.#timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Forget everything about a session (it was closed, archived or purged). The observer process is
   *  the idle reaper's business; we only stop treating this pair as current. */
  forget(sessionId: string): void {
    const w = this.#watch.get(sessionId);
    if (w?.observerId) this.#observers.delete(w.observerId);
    this.#watch.delete(sessionId);
  }

  /** The operator moved to another session: CLOSE the one we were reading (issue #23).
   *
   *  `next` is the session now on screen (null = nobody). 「切走即关」 is about switching SESSIONS,
   *  not about a tab going to the background: a hidden page keeps its observer, because a rebuild
   *  means re-reading the whole session and the first brief after a rebuild is the expensive one.
   *  A closed tab is the idle reaper's job — `#ensure()` is what makes that safe. */
  focusChanged(next: string | null): void {
    for (const [sid, w] of [...this.#watch]) {
      if (sid === next || !w.observerId) continue;
      void this.#dispose(w);
    }
  }

  /** The operator turned the speaker (or the observer) off: stop paying NOW, not at the next reap.
   *  Until #23 this was invisible — `speakEnabled()` only made the hub idle, while the observer
   *  process (a whole ACP runtime, ~137 MB) sat there for the reaper's five minutes. */
  onPolicyChanged(): void {
    const enabled = this.#deps.settings().enabled;
    for (const w of [...this.#watch.values()]) {
      // The section itself off, or THIS session no longer on 工作播报 (issue #69 §2: leaving the
      // 档位 must reap its observer instead of leaving an orphan behind for the idle reaper).
      if (!enabled || this.#mode(w.observedId) !== "brief") void this.#dispose(w);
    }
  }

  /** Every ServerEvent in the process passes through here (index.ts wires it in front of the
   *  broadcast). Cheap by construction: a few kind checks per frame. */
  onEvent(evt: ServerEvent): void {
    if (evt.t === "message") {
      const sid = evt.message.sessionId;
      // `message` frames for an observer carry the OBSERVER's id, while the watch entry is keyed by
      // the OBSERVED session — so this is a lookup by observer id, not by key.
      for (const watch of this.#watch.values()) {
        if (watch.observerId !== sid) continue;
        if (evt.message.kind === "agent") watch.answer += textOfPayload(evt.message.payload);
      }
      // ANY frame counts as 「有动静」: the beat only fires when nothing at all has happened since.
      const w = this.#watch.get(sid);
      if (w) w.lastActivityAt = this.#now();
      return;
    }

    if (evt.t === "turn-start") {
      if (this.#observers.has(evt.sessionId)) return;
      const w = this.#watchFor(evt.sessionId);
      w.inflight = true;
      w.startedAt = this.#now();
      w.lastActivityAt = w.startedAt;
      w.briefsThisTurn = 0;
      return;
    }

    if (evt.t === "turn-end") {
      // An observer's own turn-end IS the brief's arrival — resolved by observer id, because the
      // watch map is keyed by the OBSERVED session (looking the observer up in it finds nothing,
      // which is how the first version turned every observer turn into another trigger).
      if (this.#observers.has(evt.sessionId)) {
        for (const w of this.#watch.values()) if (w.observerId === evt.sessionId) this.#finishBrief(w);
        return;
      }
      const w = this.#watchFor(evt.sessionId);
      w.inflight = false;
      w.lastActivityAt = this.#now();
      void this.#maybeBrief(evt.sessionId, evt.error, "turn-end");
      return;
    }

    if (evt.t === "permission") {
      // A request waiting for an answer is never worth a model call: the fact is right here, and the
      // operator may be away from the screen. It is also the one blocking event in the product, so
      // it is the one place where silencing a background session is a real trade: the phone push
      // still delivers it (approvals are never suppressed by 「我在看」), so the voice follows the
      // same scope as everything else here. Flip this to `#speaking()` alone if 「后台审批也念出来」
      // turns out to be wanted.
      if (!this.#speaking(evt.request.sessionId)) return;
      if (!this.#watching(evt.request.sessionId)) return;
      const sid = evt.request.sessionId;
      const title = evt.request.toolCallTitle?.trim();
      this.#speak(sid, title ? `有请求等你确认：${title}` : "有个请求等你确认", "approval", 2);
      return;
    }

    if (evt.t === "plan") {
      if (!this.#speaking(evt.sessionId)) return;
      const plan = evt.plan;
      if (!plan) return;
      // Zero-cost, but still an announcement: the rail is where you read progress on a session you
      // are not looking at, so the voice follows the same scope as the model-backed brief.
      if (!this.#watching(evt.sessionId)) return;
      const w = this.#watchFor(evt.sessionId);
      for (const item of plan.items) {
        if (item.status !== "completed") continue;
        // PlanItem has no id: its content IS the identity (ACP replaces the whole list each frame).
        const key = item.content;
        if (w.announcedSteps.has(key)) continue;
        w.announcedSteps.add(key);
        // The FIRST completed step of a plan is worth a word; after that the rail is the place to
        // read progress, and a voice per step would be a metronome.
        if (w.announcedSteps.size === 1) {
          this.#speak(evt.sessionId, `完成一步：${oneLine(item.content, 60)}`, "plan-step", 1);
        }
      }
      return;
    }
  }

  /** One pass of the beat (issue #24). Written for many watches even though #23 keeps it at one:
   *  the ticker must never become the reason the scope rule matters. */
  tick(): void {
    this.#ticks++;
    const s = this.#deps.settings();
    if (!s.enabled) return;                                      // the observer section itself is off
    const now = this.#now();
    for (const w of [...this.#watch.values()]) {
      const mode = this.#mode(w.observedId);
      if (mode !== "brief") { this.#skip(w, "speaker-off"); continue; }
      const beat = this.#beat(w.observedId);
      if (beat <= 0) { this.#skip(w, "no-beat"); continue; }
      this.#ensure(w);                                           // a dead observer is not 「busy」
      if (w.busy || w.spawning) { this.#skip(w, "busy"); continue; }
      if (!w.inflight) { this.#skip(w, "not-inflight"); continue; }
      // #69 §5: the beat asks 「is this the session he is on」, NOT 「has he touched the keyboard in
      // the last two minutes」 — asking the operator to sit and watch is the opposite of the feature.
      if (!this.#onSession(w.observedId)) { this.#skip(w, "not-current"); continue; }
      if (now - w.lastBriefAt < beat * 1000) { this.#skip(w, "no-beat-yet"); continue; }
      // #69 §3: `throttleSec` is the de-duplicating gap for EVENT-driven briefs (see #maybeBrief).
      // Applying it here as well meant 「每 1 分钟」 could never fire faster than 2 minutes.
      if (w.briefsThisTurn >= MAX_BRIEFS_PER_TURN) { this.#skip(w, "per-turn-cap"); continue; }
      void this.#maybeBrief(w.observedId, undefined, "heartbeat");
    }
  }

  /** A turn ended (or a beat came due) on a session the operator owns: is it worth a brief? */
  async #maybeBrief(sessionId: string, error?: string, kind: "turn-end" | "heartbeat" = "turn-end"): Promise<void> {
    if (!this.#speaking(sessionId)) return;
    if (this.#observers.has(sessionId)) return;
    if (!this.#watching(sessionId)) return;
    const w = this.#watchFor(sessionId);
    const settings = this.#deps.settings();
    if (!settings.enabled) {
      // Degrade to a zero-cost line: the observer is off, but the operator still asked to be told
      // what happened. For a beat that is 「还在跑」 — which is the whole point of the beat.
      const title = this.#deps.titleOf(sessionId) ?? "会话";
      if (kind === "heartbeat") {
        const ran = this.#now() - (w.startedAt || w.lastActivityAt);
        this.#speak(sessionId, `${title} 已跑 ${minutesLabel(ran)}，还没结束`, "fallback", 1);
        return;
      }
      const planTitle = this.#deps.planTitleOf?.(sessionId) ?? null;
      if (error) this.#speak(sessionId, `${title} 出错了：${oneLine(error, 60)}`, "fallback", 1);
      else if (planTitle) this.#speak(sessionId, `${title} · ${planTitle}`, "fallback", 1);
      return;
    }
    // #23's other half, and it has to come BEFORE the busy check: a reaped observer never sends the
    // turn-end that clears `busy`, so 「观察员被回收」 used to leave the watch stuck at busy=true and
    // every later brief was queued into a session that no longer exists. `#ensure()` is the missing
    // piece the header comment had been promising.
    this.#ensure(w);
    if (w.busy) {
      // A brief is in flight: remember that another one is owed and let the current one finish,
      // rather than interleaving two turns into one voice.
      w.queued = true;
      w.queuedKind = kind;
      return;
    }
    // #69 §3: `throttleSec` de-duplicates EVENT-driven briefs (two turn-ends a second apart must not
    // buy two model calls). A beat the operator picked himself was already spaced by `intervalSec`
    // in tick(), and applying the gap a second time here is exactly what made 「每 1 分钟」 faster
    // than every 2 minutes on the wire — the gate passed, then this line shut it again.
    const gap = settings.throttleSec * 1000;
    if (kind !== "heartbeat" && gap > 0 && this.#now() - w.lastBriefAt < gap) return;

    let observerId = w.observerId;
    if (!observerId) {
      if (w.spawning) {
        w.queued = true;
        w.queuedKind = kind;
        return;
      }
      w.spawning = true;
      // Busy from here: the observer's FIRST turn (persona + look) is itself a brief, and a second
      // event arriving during the spawn must queue instead of starting a rival turn.
      w.busy = true;
      w.lastBriefAt = this.#now();
      try {
        observerId = await this.#spawnObserver(w);
      } catch (e) {
        w.spawning = false;
        w.busy = false;
        // Degrade rather than go silent: the operator asked for 工作播报 and a broken observer must
        // not turn the feature off without telling them.
        const planTitle = this.#deps.planTitleOf?.(sessionId) ?? null;
        const title = this.#deps.titleOf(sessionId) ?? "会话";
        this.#speak(
          sessionId,
          planTitle ? `${title} · ${planTitle}` : `${title} 的播报员没起来：${oneLine(String((e as Error)?.message ?? e), 50)}`,
          "fallback",
          1,
        );
        return;
      }
      w.spawning = false;
      // `#spawnObserver` already registered the id and marked the watch busy: the first brief is
      // produced by the prompt it sent, so there is nothing to send here.
      return;
    }

    w.busy = true;
    w.lastBriefAt = this.#now();
    // `briefsThisTurn` is charged in #finishBrief, and only for a line that really went out (#69 §6):
    // charging it here meant a sentinel answer （没有可播报的进展）or a degraded fallback still spent
    // one of the MAX_BRIEFS_PER_TURN, so eight quiet answers could mute the rest of a long turn.
    // The ONE thing an event passes the observer: that something happened. Everything else is read.
    const why =
      kind === "heartbeat"
        ? `这个会话已经跑了 ${minutesLabel(this.#now() - (w.startedAt || w.lastActivityAt))}还没结束。` +
          "对照你上一句播的内容：有新进展就播那一条新进展；没有新输出、新报错、新等待，" +
          "就只说「<在做的事>还在跑，暂时没有新输出」。"
        : error
          ? "这一轮报了错。看一眼进展，按你的契约给一句播报。"
          : "这一轮结束了。看一眼进展，按你的契约给一句播报。";
    try {
      await this.#deps.prompt(observerId, why);
    } catch (e) {
      w.busy = false;
      // The prompt itself failed — most likely the process is gone. Do not keep a dead id (that was
      // the permanent-failure bug): drop it and let the next event re-spawn.
      this.#observers.delete(observerId);
      w.observerId = null;
      this.#speak(sessionId, `播报失败：${oneLine(String((e as Error)?.message ?? e), 50)}`, "fallback", 1);
    }
  }

  /** The observer answered: turn its text into the spoken line. */
  #finishBrief(w: Watch): void {
    const text = oneLine(w.answer);
    w.answer = "";
    w.busy = false;
    if (text && text !== NOTHING) {
      if (sameLine(text, w.lastSpoken)) {
        // The time gate and the per-turn cap cannot see this: both briefs are legitimate, they just
        // say the same thing. Dropping it here is what actually stops 「重复播报」, and it does not
        // spend the per-turn quota — nothing was spoken (#76 C).
        w.lastSkip = { reason: "duplicate", at: this.#now() };
      } else {
        w.lastSpoken = text;
        this.#speak(w.observedId, text, "brief", 1);
        w.briefsThisTurn++;                     // spent by a line the operator actually heard
      }
    }
    if (w.queued) {
      const kind = w.queuedKind;
      w.queued = false;
      void this.#maybeBrief(w.observedId, undefined, kind);
    }
  }

  async #spawnObserver(w: Watch): Promise<string> {
    const observedId = w.observedId;
    const settings = this.#deps.settings();
    const backend = settings.backend ?? this.#deps.backendOf(observedId);
    if (!backend) throw new Error("不知道该用哪个后端");
    const dir = path.join(this.#deps.home, "observers", observedId);
    fs.mkdirSync(dir, { recursive: true });
    const title = this.#deps.titleOf(observedId) ?? observedId;
    const id = await this.#deps.createSession(backend, dir, `观察员 · ${title}`);
    // Registered BEFORE its first prompt: the turn it is about to run is a brief, and its frames must
    // already be attributable to this pair (see the turn-end branch in onEvent).
    w.observerId = id;
    this.#observers.add(id);
    // `create` returns before the handshake by design; an observer is spawned and prompted in the
    // same breath, so wait for the one fact only the agent can give us.
    await this.#deps.waitReady(id);
    this.#deps.preferReadonly?.(id);
    // The prompt is the operator's, plus the one fact the observer cannot read for itself: which
    // session it is watching. Everything else it looks up.
    const wording = settings.systemPrompt.trim() || OBSERVER_PROMPT_DEFAULT;
    // The name is usually the auto-generated summary of the session's FIRST sentence, so it goes
    // stale the moment the work moves on — and it is OUR prompt text for an observer spawned before
    // #76 (10 of 11 observers on the machine that filed it). Presented as a fact it is a trap; the
    // contract already tells the model to trust the user's own words over it.
    const system = `${wording}\n\n你负责的会话 id 是 ${observedId}（名字，可能是自动摘要，仅供参考：${title}）。`;
    // ACP has no "system prompt" call: the persona rides as the observer's first turn, and its own
    // transcript keeps it. Everything after that is a one-line trigger.
    await this.#deps.prompt(id, `${system}\n\n现在先看一眼这个会话的现状，给一句播报。`);
    return id;
  }

  /** Close an observer and drop its watch. Best effort: a failed close must not keep the bookkeeping
   *  alive, or the map becomes exactly the leak `forget()` was written to prevent. */
  async #dispose(w: Watch): Promise<void> {
    const id = w.observerId;
    w.observerId = null;
    w.busy = false;
    w.queued = false;
    if (id) {
      this.#observers.delete(id);
      try {
        await this.#deps.disposeSession?.(id);
      } catch {
        /* closing is best effort — the reaper is the backstop, our map is already clean */
      }
    }
    if (this.#watch.get(w.observedId) === w) this.#watch.delete(w.observedId);
  }

  #watchFor(sessionId: string): Watch {
    let w = this.#watch.get(sessionId);
    if (!w) {
      const now = this.#now();
      w = {
        observedId: sessionId, observerId: null, spawning: false, lastBriefAt: 0, queued: false,
        queuedKind: "turn-end", answer: "", busy: false, announcedSteps: new Set(),
        inflight: false, lastActivityAt: now, startedAt: now, briefsThisTurn: 0, lastSpoken: "", lastSkip: null,
      };
      this.#watch.set(sessionId, w);
    }
    return w;
  }

  /** Make the watch honest about its observer. A process that is gone is not 「busy」: without this,
   *  a reap (or a close) mid-brief left `busy` true forever and the session went permanently silent. */
  #ensure(w: Watch): void {
    if (!w.observerId) return;
    if (this.#alive(w.observerId)) return;
    this.#observers.delete(w.observerId);
    w.observerId = null;
    w.busy = false;
    w.spawning = false;
    w.answer = "";
  }

  /** 这个会话现在开着工作播报吗 (issue #68: per session, not one global switch). */
  #speaking(sessionId: string): boolean {
    return this.#mode(sessionId) === "brief";
  }

  /** The speaker position that applies to one session: the host resolves session row → global
   *  default. `speakEnabled` is the single-switch fallback for hosts and tests that predate #68. */
  #mode(sessionId: string): SpeakMode {
    const fn = this.#deps.speakOf;
    if (fn) return fn(sessionId).mode;
    return this.#deps.speakEnabled?.() ? "brief" : "off";
  }

  /** The beat for one session, in seconds (0 = the operator did not ask for a beat). */
  #beat(sessionId: string): number {
    const fn = this.#deps.speakOf;
    if (fn) return fn(sessionId).intervalSec;
    return this.#deps.settings().intervalSec;
  }

  /** Broadcasting asks a weaker question than notifying (issue #69 §5). */
  #onSession(sessionId: string): boolean {
    const fn = this.#deps.onSession;
    return fn ? fn(sessionId) : this.#watching(sessionId);
  }

  #skip(w: Watch, reason: SkipReason): void {
    w.lastSkip = { reason, at: this.#now() };
  }

  /** Is the operator on THIS session? The scope gate of #23; no dep = no scope (tests, old hosts). */
  #watching(sessionId: string): boolean {
    const fn = this.#deps.watching;
    return fn ? fn(sessionId) : true;
  }

  #alive(sessionId: string): boolean {
    const fn = this.#deps.alive;
    return fn ? fn(sessionId) : true;
  }

  #speak(sessionId: string, text: string, kind: "approval" | "plan-step" | "brief" | "fallback", priority: 1 | 2): void {
    const clean = oneLine(text);
    if (!clean) return;
    this.#deps.emit({
      t: "speak",
      id: `${sessionId}:${kind}:${this.#now()}`,
      sessionId,
      text: clean,
      kind,
      priority,
    });
  }
}

/** The streamed text inside an `agent`/`thought` payload (ACP: `content.text`). */
function textOfPayload(payload: unknown): string {
  const c = (payload as { content?: unknown } | null)?.content;
  if (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string") {
    return (c as { text: string }).text;
  }
  const t = (payload as { text?: unknown } | null)?.text;
  return typeof t === "string" ? t : "";
}
