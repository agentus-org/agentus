// 工作播报的节拍 (issues #69 §3/§5/§6) — the hub's own arithmetic, with no server and no agent.
//
// What it pins:
//   §3  a beat the operator picked is honoured: `throttleSec` (120 s by default) must NOT stretch a
//       30 s beat to 2 minutes;
//   §5  the beat asks 「is this the session he is on」, not 「is the page visible and has he touched
//       the keyboard」;
//   §6  a sentinel answer （没有可播报的进展）does not spend the per-turn quota, and every declined
//       tick carries a reason code instead of being silent in every sense.
//
//   node_modules/.bin/tsx scripts/qa/observer-beat-sweep.mts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ObserverHub } from "../../packages/server/src/observer/hub.js";
import type { ServerEvent } from "../../packages/shared/src/index.js";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}${detail ? "  — " + detail : ""}`); }
}

const NOTHING = "（没有可播报的进展）";
let now = 1_700_000_000_000;

/** `tick()` starts a brief with `void this.#maybeBrief(...)`, so nothing it caused is visible on the
 *  next line — let the microtask queue (and the stubs' own promises) drain first. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));
async function tick(hub: ObserverHub): Promise<void> {
  hub.tick();
  await settle();
}

interface Cfg {
  mode: "off" | "reply" | "brief";
  beat: number;
  onSession: boolean;
  throttleSec: number;
}

function makeHub(cfg: Cfg) {
  const events: ServerEvent[] = [];
  const prompts: { id: string; text: string }[] = [];
  let spawned = 0;
  const hub = new ObserverHub({
    home: mkdtempSync(path.join(tmpdir(), "observer-beat-")),
    settings: () => ({ enabled: true, backend: "hermes", systemPrompt: "", throttleSec: cfg.throttleSec, intervalSec: cfg.beat }) as never,
    speakOf: () => ({ mode: cfg.mode, intervalSec: cfg.beat }),
    createSession: async () => { spawned += 1; return `obs-${spawned}`; },
    prompt: async (id, text) => { prompts.push({ id, text }); },
    waitReady: async () => {},
    titleOf: () => "会话 A",
    backendOf: () => "hermes" as never,
    onSession: () => cfg.onSession,
    alive: () => true,
    emit: (e) => { events.push(e); },
    now: () => now,
  });
  return { hub, events, prompts, spawns: () => spawned };
}

const turnStart = { t: "turn-start", sessionId: "A" } as unknown as ServerEvent;
const agentSays = (obsId: string, text: string): ServerEvent => ({
  t: "message",
  message: { sessionId: obsId, kind: "agent", payload: { content: { text } } },
} as unknown as ServerEvent);
const obsTurnEnd = (obsId: string): ServerEvent => ({ t: "turn-end", sessionId: obsId } as unknown as ServerEvent);

// ---- §3: a 30 s beat fires at 30 s even though throttleSec says 120 ---------------------------
{
  const { hub, prompts, spawns } = makeHub({ mode: "brief", beat: 30, onSession: true, throttleSec: 120 });
  hub.onEvent(turnStart);
  await tick(hub);                                   // spawns the observer, asks for the first brief
  await hub.onEvent(agentSays("obs-1", "现在在跑测试"));
  hub.onEvent(obsTurnEnd("obs-1"));             // that brief landed
  const afterFirst = prompts.length;
  now += 30_000;                                // exactly one beat later
  await tick(hub);
  check("§3 30s beat: fires at 30s despite throttleSec=120", prompts.length > afterFirst, `prompts ${prompts.length} vs ${afterFirst}`);
  check("§3 30s beat: still only one observer process", spawns() === 1, `spawns ${spawns()}`);

  now += 5_000;                                 // 35 s: the next beat is not due yet
  const before = prompts.length;
  await tick(hub);
  check("§3 30s beat: does not fire early", prompts.length === before);
}

// ---- §3b: 60 s beat does not fire at 30 s ----------------------------------------------------
{
  const { hub, prompts } = makeHub({ mode: "brief", beat: 60, onSession: true, throttleSec: 120 });
  hub.onEvent(turnStart);
  await tick(hub);
  await hub.onEvent(agentSays("obs-1", "x"));
  hub.onEvent(obsTurnEnd("obs-1"));
  const before = prompts.length;
  now += 30_000;
  await tick(hub);
  check("§3 60s beat: silent at 30s", prompts.length === before);
  now += 30_000;
  await tick(hub);
  check("§3 60s beat: fires at 60s", prompts.length > before);
}

// ---- §5: the beat does not need the page to be visible / recently clicked ---------------------
{
  const off = makeHub({ mode: "brief", beat: 30, onSession: false, throttleSec: 120 });
  off.hub.onEvent(turnStart);
  await tick(off.hub);
  check("§5 not the current session: no observer is spawned", off.spawns() === 0);
  check("§5 not the current session: the skip is attributed", off.hub.debug()[0]?.skip === "not-current", String(off.hub.debug()[0]?.skip));
}

// ---- §6: sentinel answers do not spend the per-turn quota ------------------------------------
{
  const { hub, events } = makeHub({ mode: "brief", beat: 30, onSession: true, throttleSec: 0 });
  hub.onEvent(turnStart);
  await tick(hub);
  for (let i = 0; i < 10; i += 1) {
    await hub.onEvent(agentSays("obs-1", NOTHING));
    hub.onEvent(obsTurnEnd("obs-1"));
    now += 30_000;
    await tick(hub);
    // the observer is already alive: each tick is a prompt it will answer with NOTHING again
  }
  const briefs = hub.debug()[0]?.briefs ?? -1;
  const spoken = events.filter((e) => e.t === "speak" && (e as { kind?: string }).kind === "brief").length;
  check("§6 sentinel answers spend no quota", briefs === 0, `briefs=${briefs}`);
  check("§6 sentinel answers say nothing", spoken === 0, `spoken=${spoken}`);

  // a REAL answer still goes out after all those sentinels (the quota was never touched)
  await hub.onEvent(agentSays("obs-1", "测试全绿了"));
  hub.onEvent(obsTurnEnd("obs-1"));
  const spokenAfter = events.filter((e) => e.t === "speak" && (e as { kind?: string }).kind === "brief").length;
  check("§6 a real brief still speaks after 10 sentinels", spokenAfter === 1, `spoken=${spokenAfter}`);
  check("§6 the real brief spends exactly one", hub.debug()[0]?.briefs === 1, `briefs=${hub.debug()[0]?.briefs}`);
}

// ---- §6b: every declined tick names a reason ------------------------------------------------
{
  const off = makeHub({ mode: "off", beat: 30, onSession: true, throttleSec: 0 });
  off.hub.onEvent(turnStart);
  await tick(off.hub);
  check("§6 speaker off is attributed", off.hub.debug()[0]?.skip === "speaker-off", String(off.hub.debug()[0]?.skip));

  const noBeat = makeHub({ mode: "brief", beat: 0, onSession: true, throttleSec: 0 });
  noBeat.hub.onEvent(turnStart);
  await tick(noBeat.hub);
  check("§6 missing beat is attributed", noBeat.hub.debug()[0]?.skip === "no-beat", String(noBeat.hub.debug()[0]?.skip));

  const idle = makeHub({ mode: "brief", beat: 30, onSession: true, throttleSec: 0 });
  idle.hub.onEvent(turnStart);
  idle.hub.onEvent({ t: "turn-end", sessionId: "A" } as unknown as ServerEvent);   // turn over
  await settle();
  // that turn-end bought its own brief; let the observer answer it (a sentinel = nothing spoken)
  const obsId = idle.hub.debug()[0]?.observerId ?? "obs-1";
  idle.hub.onEvent(agentSays(obsId, NOTHING));
  idle.hub.onEvent(obsTurnEnd(obsId));
  await settle();
  await tick(idle.hub);
  const skips = idle.hub.debug().map((d) => d.skip);
  check("§6 an idle session is attributed", skips.includes("not-inflight"), JSON.stringify(skips));
}

// ---- §68: the resolved position is what the diagnostic endpoint reports ----------------------
{
  const { hub } = makeHub({ mode: "brief", beat: 45, onSession: true, throttleSec: 0 });
  hub.onEvent(turnStart);
  const d = hub.debug()[0];
  check("#68 debug carries the session's own mode", d?.mode === "brief", String(d?.mode));
  check("#68 debug carries the session's own beat", d?.intervalSec === 45, String(d?.intervalSec));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
