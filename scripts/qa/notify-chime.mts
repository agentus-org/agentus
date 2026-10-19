// The browser notification SOUND, asserted instead of listened to (issues #27 / #28).
//
// #28 — every reminder is at least two notes, and the kinds are told apart by the SHAPE of the figure
//        rather than by how many notes it has: 「完成」 falls (calm, nothing asked of you),
//        「等你处理」 rises (a human is the blocker), 「出错」 rises then falls in three.
// #27 — a preference object written before the chime default existed carries `sound: "default"` as a
//        LEFTOVER, not as a decision. It is repaired once and stamped; from then on "default" is
//        respected.
//
// Imported for real (the module is loaded with a stub localStorage), because the migration runs inside
// module state — a copy of the logic here would test nothing.
//
//   npx tsx scripts/qa/notify-chime.mts
const KEY = "agentus.webnotify";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

/** A localStorage good enough for the module, reset per scenario. */
function stubStore(initial: Record<string, string> = {}) {
  const data: Record<string, string> = { ...initial };
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => { data[k] = v; },
    removeItem: (k: string) => { delete data[k]; },
    key: (i: number) => Object.keys(data)[i] ?? null,
    get length() { return Object.keys(data).length; },
    clear: () => { for (const k of Object.keys(data)) delete data[k]; },
  } as Storage;
  return data;
}

/** Load a FRESH copy of the module (its singleton reads prefs at import time). */
async function load() {
  const url = new URL("../../packages/web/src/webNotify.ts", import.meta.url).href;
  return import(`${url}?t=${Math.random()}`) as Promise<typeof import("../../packages/web/src/webNotify.ts")>;
}

// ---- #28: the figures ---------------------------------------------------------------------------
stubStore();
const m = await load();

const done = m.chimePattern("agent_done");
const approval = m.chimePattern("approval");
const error = m.chimePattern("error");

check("完成 gets at least two notes (a 0.16s blip is not a reminder)", done.length >= 2, `${done.length} notes`);
check("完成 falls (ding-dong, calm)", done[1].freq < done[0].freq, `${done[0].freq} → ${done[1].freq}`);
check("等你处理 rises (come here)", approval[1].freq > approval[0].freq, `${approval[0].freq} → ${approval[1].freq}`);
check("等你处理 is the higher figure overall", approval[1].freq > done[1].freq, `${approval[1].freq} vs ${done[1].freq}`);
check("出错 gets three notes (cannot be mistaken for 完成)", error.length === 3, `${error.length} notes`);
check("the three kinds are pairwise different",
  JSON.stringify(done) !== JSON.stringify(approval) && JSON.stringify(done) !== JSON.stringify(error) && JSON.stringify(approval) !== JSON.stringify(error));
for (const [kind, notes] of [["agent_done", done], ["approval", approval], ["error", error]] as const) {
  const last = notes[notes.length - 1];
  check(`${kind}: the figure is long enough to notice (≥0.4s)`, last.at + last.dur >= 0.4, `${(last.at + last.dur).toFixed(2)}s`);
  check(`${kind}: notes are ordered and do not overlap`, notes.every((n, i) => i === 0 || n.at > notes[i - 1].at + 0.05));
  check(`${kind}: every note is audible-range and not shrill`, notes.every((n) => n.freq >= 200 && n.freq <= 2000 && n.dur > 0.05));
}

// The gate itself is unchanged: a "still running" card must not make a sound.
const gate = { enabled: true, hidden: true };
check("a running-status card stays silent", !m.shouldChime({ on: true, sound: "chime", volume: 0.6 }, "agent_running", gate, false));
check("done / approval / error do chime", ["agent_done", "approval", "error"].every((k) =>
  m.shouldChime({ on: true, sound: "chime", volume: 0.6 }, k as "agent_done", gate, false)));
check("a live call is silent", !m.shouldChime({ on: true, sound: "chime", volume: 0.6 }, "agent_done", gate, true));

// ---- #27: the one-time repair -------------------------------------------------------------------
{
  // A v1 object: no stamp, the old default. This is what every existing install carries.
  const data = stubStore({ [KEY]: JSON.stringify({ on: true, sound: "default", volume: 0.6 }) });
  const mod = await load();
  const prefs = mod.webNotify.getSnapshot().prefs;
  check("a v1 「default」 is repaired to the chime (it was a leftover, not a choice)", prefs.sound === "chime", prefs.sound);
  const stored = JSON.parse(data[KEY] ?? "{}");
  check("…and the repair is persisted with a schema stamp", stored.v === 2 && stored.sound === "chime", JSON.stringify(stored));
}
{
  // The same value under the current schema is a DECISION and must survive.
  const data = stubStore({ [KEY]: JSON.stringify({ on: true, sound: "default", volume: 0.6, v: 2 }) });
  const mod = await load();
  check("an explicit 「default」 under the current schema is respected", mod.webNotify.getSnapshot().prefs.sound === "default",
    mod.webNotify.getSnapshot().prefs.sound);
  check("…and is left untouched on disk", JSON.parse(data[KEY] ?? "{}").sound === "default");
}
{
  // Picking "default" TODAY must stick across a reload (the stamp is what makes it permanent).
  const data = stubStore();
  const mod = await load();
  mod.webNotify.setPrefs({ sound: "default" });
  check("choosing 「default」 now writes the schema stamp", JSON.parse(data[KEY] ?? "{}").v === 2, data[KEY]);
  const again = await load();
  check("…so a reload keeps it (no repair loop)", again.webNotify.getSnapshot().prefs.sound === "default");
}
{
  const data = stubStore({ [KEY]: "{not json" });
  const mod = await load();
  check("a corrupt preference blob falls back to the current defaults",
    mod.webNotify.getSnapshot().prefs.sound === "chime" && mod.webNotify.getSnapshot().prefs.on === true);
  check("…and does not throw", data[KEY] === "{not json");
}
{
  stubStore({ [KEY]: JSON.stringify({ on: false, volume: 9 }) });
  const mod = await load();
  const prefs = mod.webNotify.getSnapshot().prefs;
  check("a missing sound field takes today's default", prefs.sound === "chime", prefs.sound);
  check("volume is still clamped", prefs.volume === 1, String(prefs.volume));
  check("the operator's own switch is preserved", prefs.on === false);
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
