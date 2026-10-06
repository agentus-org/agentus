// Pinned-clock checks for packages/web/src/time.ts — the two shapes the operator asked for
// (「每条消息的时间」 and the rail's 「当天显示时间、几天前显示日期」).
//
//   npx tsx scripts/qa/time-sweep.mjs
//
// Why a unit sweep next to the page sweeps: these functions have boundary cases nobody can
// trigger by hand (44s vs 45s, 23:59 yesterday, a foreign year) and a page sweep can only ever
// see "whatever the clock said while it ran" — the bug that hides in "刚刚" is exactly the one
// you cannot wait for. `now` is a parameter here, so the cases are pinned instead of waited on.
import { clockHM, messageTime, relTime, stamp } from "../../packages/web/src/time.ts";

let pass = 0;
let fail = 0;
function check(name, got, want) {
  const ok = got === want;
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} — got ${JSON.stringify(got)}${ok ? "" : ` want ${JSON.stringify(want)}`}`);
}

// A fixed "now": 2026-10-06 15:00 local. Everything below is relative to it.
const now = new Date(2026, 9, 6, 15, 0, 0).getTime();
const at = (y, mo, d, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi, 0).getTime();

console.log("== a message's own time (never vaguer than the minute)");
check("today", messageTime(at(2026, 10, 6, 14, 32), now), "14:32");
check("a minute ago today", messageTime(now - 60_000, now), "14:59");
check("yesterday says so", messageTime(at(2026, 10, 5, 9, 5), now), "昨天 09:05");
check("this year but older names the day", messageTime(at(2026, 10, 3, 23, 5), now), "10月3日 23:05");
check("another year is absolute", messageTime(at(2025, 12, 31, 8, 0), now), "2025-12-31 08:00");
check("midnight is 00:00, not 24:00", messageTime(at(2026, 10, 6, 0, 0), now), "00:00");
check("just after midnight is yesterday", messageTime(at(2026, 10, 5, 23, 59), new Date(2026, 9, 6, 0, 1).getTime()), "昨天 23:59");

console.log("== the rail's 'how long ago' (coarser on purpose)");
check("seconds", relTime(now - 5_000, now), "刚刚");
check("44s is still 刚刚", relTime(now - 44_000, now), "刚刚");
check("45s becomes a minute", relTime(now - 45_000, now), "1 分钟前");
check("1 min never says '0 分钟前'", relTime(now - 60_000, now), "1 分钟前");
check("minutes", relTime(now - 12 * 60_000, now), "12 分钟前");
check("59 min", relTime(now - 59 * 60_000, now), "59 分钟前");
check("an hour+ today falls back to the clock", relTime(now - 61 * 60_000, now), "13:59");
check("today morning", relTime(at(2026, 10, 6, 9, 0), now), "09:00");
check("yesterday (calendar, not 24h)", relTime(at(2026, 10, 5, 23, 0), new Date(2026, 9, 6, 0, 30).getTime()), "昨天");
check("2-6 days ago is a weekday", relTime(at(2026, 10, 3, 10, 0), now), "周六");
check("a week+ names the date", relTime(at(2026, 9, 20, 10, 0), now), "9月20日");
check("another year is absolute", relTime(at(2025, 12, 31, 10, 0), now), "2025-12-31");
check("clock skew never reads as the future", relTime(now + 60_000, now), clockHM(now + 60_000));

console.log("== the absolute stamp (rides every title=)");
check("stamp", stamp(at(2026, 10, 6, 14, 32), now), "2026-10-06 14:32");
check("stamp pads", stamp(at(2026, 1, 2, 3, 4), now), "2026-01-02 03:04");
check("clockHM", clockHM(at(2026, 10, 6, 0, 0), now), "00:00");

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
