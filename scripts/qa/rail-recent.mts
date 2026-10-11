// The rail's recent-N rule, on its own (no DOM, no server).
//
// One workspace holding twenty sessions is exactly what the rail is FOR, so a group shows its newest
// few and puts the rest behind a click. What that must NEVER hide: the conversation the operator is
// working in, and the matches of a search that claims to have found them.
//
// Run: npm run rail-recent
import { RAIL_RECENT, splitRecent } from "../../packages/web/src/rail.ts";

let ok = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { ok += 1; console.log(`  ok   ${name}`); }
  else { failed += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const items = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

// ---- the default: newest N, the rest counted ------------------------------------------------
{
  const { shown, hidden } = splitRecent(items(20));
  check("a long group shows only the newest few", shown.length === RAIL_RECENT, `${shown.length} shown`);
  check("…and reports how many are left", hidden === 20 - RAIL_RECENT, `${hidden} hidden`);
  check("…and they are the FIRST ones (the caller sorted newest-first)",
    shown.join(",") === "1,2,3,4,5", shown.join(","));
}
{
  const { shown, hidden } = splitRecent(items(5));
  check("a group that fits is untouched", shown.length === 5 && hidden === 0);
  const small = splitRecent(items(2));
  check("a small group is untouched too", small.shown.length === 2 && small.hidden === 0);
}
{
  const { shown } = splitRecent([]);
  check("an empty group stays empty (nothing to expand)", shown.length === 0);
}

// ---- the cases where everything is shown -----------------------------------------------------
// The group holding the ACTIVE session used to be one of them. It is NOT any more: a workspace with
// twelve sessions was the one place the rail refused to fold (operator, 2026-10-08: 「默认显示会话
// 数量是多少啊，能调整成5吗」). The active row is pinned INSIDE the limit instead.
{
  const list = items(20); // 1 = newest … 20 = oldest
  const { shown, hidden } = splitRecent(list, { isActive: (x) => x === 12 });
  check("an active group shows exactly the limit (no exemption any more)",
    shown.length === RAIL_RECENT && hidden === 15, `shown=${shown.length} hidden=${hidden}`);
  check("…and the conversation the operator is IN is on screen anyway (pinned)",
    shown.includes(12), JSON.stringify(shown));
  check("…in the slot of the OLDEST row that would have been shown (the count stays at the limit)",
    shown[shown.length - 1] === 12, JSON.stringify(shown));
  check("…and the newest ones are untouched", shown.slice(0, 4).join(",") === "1,2,3,4",
    JSON.stringify(shown));
}
{
  // an active row inside the newest few changes nothing
  const { shown } = splitRecent(items(20), { isActive: (x) => x === 3 });
  check("an active row already among the newest few needs no pinning",
    shown.join(",") === "1,2,3,4,5", JSON.stringify(shown));
}
{
  // a group where the active session is the FIRST row (the ordinary case: you are in the newest one)
  const { shown, hidden } = splitRecent(items(9), { isActive: (x) => x === 1 });
  check("the ordinary case (working in the newest session) folds to five",
    shown.length === 5 && hidden === 4 && shown[0] === 1, JSON.stringify({ shown, hidden }));
}
{
  const { shown } = splitRecent(items(20), { searching: true });
  check("a search shows every match (that view claims to have found them)", shown.length === 20);
}
{
  const { shown, hidden } = splitRecent(items(20), { expanded: true });
  check("an unrolled group shows everything (that is what the click bought)", shown.length === 20 && hidden === 0);
}
{
  // …and the rules combine: a search shows every match even while a session in it is active
  const { shown } = splitRecent(items(9), { searching: true, isActive: (x) => x === 8, expanded: false });
  check("the rules do not fight each other", shown.length === 9);
}

// ---- the limit itself ----------------------------------------------------------------------
{
  const { shown, hidden } = splitRecent(items(30), { limit: 3 });
  check("a caller can ask for a different limit", shown.length === 3 && hidden === 27, `${shown.length}/${hidden}`);
  check("…and it takes the head, not a slice from the middle", shown.join(",") === "1,2,3", shown.join(","));
  check("limit 0 falls back to a usable number instead of hiding everything",
    splitRecent(items(10), { limit: 0 }).shown.length === 1);
  check("a fractional limit is floored", splitRecent(items(10), { limit: 2.9 }).shown.length === 2);
}

// ---- a request waiting for an answer is never folded away ------------------------------------
// The rail is the ONLY place a waiting approval is announced for a session the operator is not in
// (`⚿ N` badge on the row), so a folded row is not a hidden list item — it is a hidden request. The
// dialog cannot cover for it: it draws the ACTIVE session's request only.
{
  const list = items(20);
  const { shown, hidden } = splitRecent(list, { mustShow: (x) => x === 9 });
  check("a row with a waiting approval stays on screen",
    shown.includes(9), JSON.stringify(shown));
  check("…in place of the oldest shown row (the count stays at the limit)",
    shown.length === RAIL_RECENT && hidden === 15 && shown[shown.length - 1] === 9,
    JSON.stringify({ shown, hidden }));
  check("…and the newest rows are untouched", shown.slice(0, 4).join(",") === "1,2,3,4", shown.join(","));
}
{
  // two requests, two rows pinned, still one newest-first column of `limit` rows
  const { shown, hidden } = splitRecent(items(20), { mustShow: (x) => x === 9 || x === 12 });
  check("two waiting approvals both stay on screen",
    shown.includes(9) && shown.includes(12), JSON.stringify(shown));
  check("…the fold still stops at the limit", shown.length === RAIL_RECENT && hidden === 15,
    JSON.stringify({ shown, hidden }));
  check("…ordered as one newest-first column",
    shown.join(",") === "1,2,3,9,12", shown.join(","));
}
{
  // the ordinary case: the request is in the conversation the operator is working in
  const { shown, hidden } = splitRecent(items(20), { isActive: (x) => x === 1, mustShow: (x) => x === 1 });
  check("a request inside the newest few changes nothing",
    shown.join(",") === "1,2,3,4,5" && hidden === 15, JSON.stringify({ shown, hidden }));
}
{
  // more requests than the limit: the limit yields — hiding one would hide a decision
  const { shown, hidden } = splitRecent(items(20), { limit: 3, mustShow: (x) => x >= 8 });
  check("the limit yields when more rows must stay than it can show",
    shown.slice(-13).join(",") === items(20).slice(7).join(","), JSON.stringify(shown));
  check("…and nothing a must-keep rule named is hidden", hidden === 20 - shown.length,
    JSON.stringify({ shown, hidden }));
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${ok} ok, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
