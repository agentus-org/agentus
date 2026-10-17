// The rail must never draw one session twice (issue #13).
//
// The bug (operator, 2026-10-17): waking/creating an ACP session made the same row appear 2~3 times
// in the left rail, every copy highlighted, then vanish on the next full snapshot. The rail renders
// two client buckets by concatenation (`sessions` = has a process, `cold` = on disk only) and relies
// on "one session lives in one bucket". The server keeps that invariant, but the SINGLE-ROW
// `t:"session"` frame — a storm of which is exactly what an ACP spawn produces (starting→ready, then
// modes/configOptions/usage) — only ever pushed into `sessions` and never removed the cold copy.
//
// This drives the real store (`apply`, the same entry point the WebSocket calls) with the exact frame
// sequence, plus the merge function the rail now renders through. Offline: no server, no browser.
//
// Run: npx tsx scripts/qa/rail-dup.mts
import { railRows } from "../../packages/web/src/rail.ts";

// The store touches localStorage only to remember the active session.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { cockpit } = await import("../../packages/web/src/state.ts");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  ok ? (pass += 1) : (fail += 1);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  — ${detail}` : ""}`);
};

/** the fields the rail actually reads; the store only stamps `info`, it does not validate */
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, backend: "mock", acpSessionId: null, cwd: "/tmp", status: "ready", pid: null,
  title: id, createdAt: 1_000, modes: null, configOptions: [], commands: [],
  ...over,
});

const A = "sess_dup_probe";
const ids = (list: { id: string }[]): string[] => list.map((s) => s.id);
const counts = (): { sessions: number; cold: number; rows: number } => ({
  sessions: ids(cockpit.sessions).filter((x) => x === A).length,
  cold: ids(cockpit.cold).filter((x) => x === A).length,
  rows: railRows(cockpit.sessions, cockpit.cold).filter(({ s }) => s.id === A).length,
});

// ---- 1. the shape the operator saw: a cold row, then a live copy arriving as a SINGLE frame ----
cockpit.apply({ t: "sessions", sessions: [], cold: [row(A, { cold: true, status: "closed" })], archived: [] } as never);
check("a cold row reaches the cold bucket", counts().cold === 1 && counts().sessions === 0, JSON.stringify(counts()));

// the spawn storm: three single-row frames, exactly like starting→ready + configOptions
for (const status of ["starting", "starting", "ready"]) {
  cockpit.apply({ t: "session", session: row(A, { cold: false, status }) } as never);
  const c = counts();
  check(`a live \`session\` frame (status=${status}) leaves ONE row`, c.rows === 1 && c.cold === 0 && c.sessions === 1,
    JSON.stringify(c));
}

// ---- 2. the other producer: a cold frame (rename / auto-title of a resting slot) ----
cockpit.apply({ t: "session", session: row(A, { cold: true, status: "closed", title: "改过名字的行" }) } as never);
const afterCold = counts();
check("a `cold:true` frame moves the row out of the live bucket", afterCold.rows === 1 && afterCold.sessions === 0 && afterCold.cold === 1,
  JSON.stringify(afterCold));
check("…and carries the new title",
  cockpit.cold.find((s) => s.id === A)?.title === "改过名字的行", String(cockpit.cold.find((s) => s.id === A)?.title));

// ---- 3. the belt: dedupe where the two lists MEET, whatever a producer does ----
const merged = railRows([row(A, { cold: false, title: "live" })], [row(A, { cold: true, title: "dead" })]);
check("two buckets holding one id still render ONE row", merged.filter(({ s }) => s.id === A).length === 1,
  `${merged.filter(({ s }) => s.id === A).length} rows`);
check("…and the LIVE copy is the one kept", merged.find(({ s }) => s.id === A)?.s.title === "live",
  String(merged.find(({ s }) => s.id === A)?.s.title));
check("…marked as not cold", merged.find(({ s }) => s.id === A)?.cold === false);

// a normal two-session rail is untouched by the merge (no lost rows, order kept for the sort)
const two = railRows([row("live-1")], [row("cold-1", { cold: true })]);
check("distinct sessions both survive the merge", two.length === 2 && two.some(({ s }) => s.id === "live-1") && two.some(({ s }) => s.id === "cold-1"),
  JSON.stringify(two.map(({ s }) => s.id)));

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
