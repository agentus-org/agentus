// QA: the presence rule that decides whether the cockpit keeps the phone quiet.
//
// It exists as a script because the interesting case (a screen nobody has touched for two minutes)
// cannot be observed in a live browser session — the headless harness drops its connection well
// before the idle window expires. The wiring around it IS verified live (see the contract doc §11):
// this covers the branch itself.
//
//   npx tsx scripts/qa/presence-rule.mts
import { PRESENCE_IDLE_MS, PRESENCE_INTERVAL_MS, watchingNow } from "../../packages/web/src/presence.js";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const t0 = 1_700_000_000_000;

check("active tab + recent input ⇒ watching",
  watchingNow({ visible: true, lastInputAt: t0, now: t0 + 5_000 }) === true);
check("active tab, just inside the idle window ⇒ watching",
  watchingNow({ visible: true, lastInputAt: t0, now: t0 + PRESENCE_IDLE_MS - 1 }) === true);
check("active tab but untouched for the idle window ⇒ NOT watching (this is the whole point)",
  watchingNow({ visible: true, lastInputAt: t0, now: t0 + PRESENCE_IDLE_MS }) === false);
check("untouched for an hour ⇒ NOT watching",
  watchingNow({ visible: true, lastInputAt: t0, now: t0 + 3_600_000 }) === false);
check("hidden tab ⇒ NOT watching even with fresh input",
  watchingNow({ visible: false, lastInputAt: t0, now: t0 + 1_000 }) === false);
check("the idle window is longer than the reporting interval",
  PRESENCE_IDLE_MS > PRESENCE_INTERVAL_MS, `${PRESENCE_IDLE_MS} vs ${PRESENCE_INTERVAL_MS}`);
check("the reporting interval is well under the server's 90s TTL",
  PRESENCE_INTERVAL_MS * 3 <= 90_000, String(PRESENCE_INTERVAL_MS));

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
