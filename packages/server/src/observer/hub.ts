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
// and reused; the idle reaper may put it to sleep like any slot, and `ensure()` wakes it.
import fs from "node:fs";
import path from "node:path";
import type { BackendId, ServerEvent } from "../../../shared/src/index.js";
import type { ObserverSettings } from "../settings.js";
import { OBSERVER_PROMPT_DEFAULT } from "../settings.js";

/** Spoken lines are short on purpose: they are heard once, in the middle of other work. */
export const BRIEF_MAX = 120;

export interface ObserverDeps {
  /** Live settings, read per event — the switch must work without a restart. */
  settings(): ObserverSettings;
  /** Whether the operator's speaker is in 工作播报 mode. False = do not even try. */
  speakEnabled(): boolean;
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
  /** When the last MODEL-backed brief went out (for the throttle). */
  lastBriefAt: number;
  /** The trigger is owed: an event arrived while a brief was still being produced. */
  queued: boolean;
  /** Text of the observer's current turn, accumulated from `message` frames. */
  answer: string;
  /** True while the observer is producing a brief. */
  busy: boolean;
  /** Plan step keys already announced, so an unchanged plan is not read out twice. */
  announcedSteps: Set<string>;
}

const NOTHING = "（没有可播报的进展）";

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

export class ObserverHub {
  #deps: ObserverDeps;
  #watch = new Map<string, Watch>();
  /** Observer ids, so their own frames are never mistaken for the operator's sessions. */
  #observers = new Set<string>();
  #now: () => number;

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

  /** Forget everything about a session (it was closed, archived or purged). The observer process is
   *  the idle reaper's business; we only stop treating this pair as current. */
  forget(sessionId: string): void {
    const w = this.#watch.get(sessionId);
    this.#watch.delete(sessionId);
    if (w?.observerId) this.#observers.delete(w.observerId);
  }

  /** Every ServerEvent in the process passes through here (index.ts wires it in front of the
   *  broadcast). Cheap by construction: a few kind checks per frame. */
  onEvent(evt: ServerEvent): void {
    if (evt.t === "message") {
      // The observer's own answer, being assembled.
      const sid = evt.message.sessionId;
      // `message` frames for an observer carry the OBSERVER's id, while the watch entry is keyed by
      // the OBSERVED session — so this is a lookup by observer id, not by key.
      for (const watch of this.#watch.values()) {
        if (watch.observerId !== sid) continue;
        if (evt.message.kind === "agent") watch.answer += textOfPayload(evt.message.payload);
      }
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
      void this.#maybeBrief(evt.sessionId, evt.error);
      return;
    }

    if (evt.t === "permission") {
      // A request waiting for an answer is the one thing never worth a model call: the fact is
      // right here, and the operator may be away from the screen for a while.
      if (!this.#speaking()) return;
      const sid = evt.request.sessionId;
      const title = evt.request.toolCallTitle?.trim();
      this.#speak(sid, title ? `有请求等你确认：${title}` : "有个请求等你确认", "approval", 2);
      return;
    }

    if (evt.t === "plan") {
      if (!this.#speaking()) return;
      const w = this.#watchFor(evt.sessionId);
      const plan = evt.plan;
      if (!plan) return;
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

  /** A turn ended on a session the operator owns: is it worth a brief? */
  async #maybeBrief(sessionId: string, error?: string): Promise<void> {
    if (!this.#speaking()) return;
    if (this.#observers.has(sessionId)) return;
    const w = this.#watchFor(sessionId);
    const settings = this.#deps.settings();
    if (!settings.enabled) {
      // Degrade to the zero-cost line (#11's plan title) — the observer is off, but the operator
      // still asked to be told what happened.
      const title = this.#deps.titleOf(sessionId);
      const planTitle = this.#deps.planTitleOf?.(sessionId) ?? null;
      if (error) this.#speak(sessionId, `${title ?? "会话"} 出错了：${oneLine(error, 60)}`, "fallback", 1);
      else if (planTitle) this.#speak(sessionId, `${title ?? "会话"} · ${planTitle}`, "fallback", 1);
      return;
    }
    if (w.busy) {
      // A brief is in flight: remember that another one is owed and let the current one finish,
      // rather than interleaving two turns into one voice.
      w.queued = true;
      return;
    }
    const gap = settings.throttleSec * 1000;
    if (gap > 0 && this.#now() - w.lastBriefAt < gap) return;

    let observerId = w.observerId;
    if (!observerId) {
      if (w.spawning) {
        w.queued = true;
        return;
      }
      w.spawning = true;
      // Busy from here: the observer's FIRST turn (persona + look) is itself a brief, and a second
      // event arriving during the spawn must queue instead of starting a rival turn.
      w.busy = true;
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
    // The ONE thing an event passes the observer: that something happened. Everything else is read.
    const why = error ? "这一轮报了错。" : "这一轮结束了。";
    try {
      await this.#deps.prompt(observerId, `${why}看一眼进展，按你的契约给一句播报。`);
    } catch (e) {
      w.busy = false;
      this.#speak(sessionId, `播报失败：${oneLine(String((e as Error)?.message ?? e), 50)}`, "fallback", 1);
    }
  }

  /** The observer answered: turn its text into the spoken line. */
  #finishBrief(w: Watch): void {
    const text = oneLine(w.answer);
    w.answer = "";
    w.busy = false;
    if (text && text !== NOTHING) this.#speak(w.observedId, text, "brief", 1);
    if (w.queued) {
      w.queued = false;
      void this.#maybeBrief(w.observedId);
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
    const system = `${wording}\n\n你负责的会话 id 是 ${observedId}（名字：${title}）。`;
    // ACP has no "system prompt" call: the persona rides as the observer's first turn, and its own
    // transcript keeps it. Everything after that is a one-line trigger.
    await this.#deps.prompt(id, `${system}\n\n现在先看一眼这个会话的现状，给一句播报。`);
    return id;
  }

  #watchFor(sessionId: string): Watch {
    let w = this.#watch.get(sessionId);
    if (!w) {
      w = { observedId: sessionId, observerId: null, spawning: false, lastBriefAt: 0, queued: false, answer: "", busy: false, announcedSteps: new Set() };
      this.#watch.set(sessionId, w);
    }
    return w;
  }

  #speaking(): boolean {
    if (!this.#deps.speakEnabled()) return false;
    return true;
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
