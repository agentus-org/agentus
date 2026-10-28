// Per-turn token bills and how they read on screen (issues #70, #71).
//
// Why a unit guard and not only a browser sweep: the numbers on this row are ARITHMETIC over a
// protocol contract — ACP reports usage CUMULATIVELY ("Total … across all turns"), so every
// per-turn figure is a subtraction, and the cache-hit denominator is the full prompt. Issue #71:
// ACP's `inputTokens` ALREADY IS that full prompt (hermes fills it from `prompt_tokens`, itself
// defined as fresh + cache read + cache write), so the denominator is `input` and nothing else.
// The old code added the cache buckets back for a second count and pinned every cache-heavy turn
// at cacheRead/(input+cacheRead) ≈ 50% while the truth was 91–100%. A page sweep can prove a line
// appeared; it cannot tell a correct ratio from a plausible-looking wrong one — hence this file.
//
// Run: npx tsx scripts/qa/turn-usage.mts
import { turnUsageOf } from "../../packages/server/src/acp/session-manager.ts";
import { turnUsageText } from "../../packages/web/src/tokens.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const usage = (o: Partial<Record<"totalTokens" | "inputTokens" | "outputTokens" | "thoughtTokens" | "cachedReadTokens" | "cachedWriteTokens", number>>) => o;

// ---- the diff: ACP's cumulative counters become one turn's bill --------------------------------
{
  const first = turnUsageOf(usage({ totalTokens: 1000, inputTokens: 800, outputTokens: 200 }), null, 4000);
  check("first turn with no baseline reports the cumulative values as its own bill",
    first?.bill.input === 800 && first?.bill.output === 200 && first?.bill.total === 1000);
  check("…and the baseline it hands back is the cumulative total",
    first?.totals.input === 800 && first?.totals.output === 200);

  const second = turnUsageOf(
    usage({ totalTokens: 3000, inputTokens: 2400, outputTokens: 600 }), first!.totals, 4000,
  );
  check("second turn reports ONLY the growth (1600 in / 400 out / 2000 total)",
    second?.bill.input === 1600 && second?.bill.output === 400 && second?.bill.total === 2000,
    JSON.stringify(second?.bill));
  check("the returned baseline moves to the new cumulative total", second?.totals.total === 3000);
}

// ---- counters that reset (a resumed agent) must not produce a negative bill --------------------
{
  const prev = { total: 50_000, input: 40_000, output: 10_000, thought: 0, cacheRead: 0, cacheWrite: 0 };
  const b = turnUsageOf(usage({ totalTokens: 1200, inputTokens: 1000, outputTokens: 200 }), prev, 2000);
  check("a shrunken cumulative total is read as this turn's own number, not as a negative",
    b?.bill.input === 1000 && b?.bill.output === 200 && b?.bill.total === 1200,
    JSON.stringify(b?.bill));
}

// ---- cache hit rate: cached reads over the prompt total, which IS `input` (issue #71) ----------
{
  // hermes' shape: inputTokens = 2000 is the prompt total, of which 1500 was cached-read and
  // 300 cached-written (fresh = 200). Correct hit rate = 1500/2000 = 75%.
  const b = turnUsageOf(
    usage({ totalTokens: 2200, inputTokens: 2000, outputTokens: 100, cachedReadTokens: 1500, cachedWriteTokens: 300 }),
    null, 2000,
  );
  check("hit rate is cacheRead / input — the cache buckets are INSIDE input, never added again",
    b?.bill.cacheHitPercent === 75, String(b?.bill.cacheHitPercent));
  // The #71 regression itself: a cache-heavy turn (read ≈ input) must read near 100%, NOT ~50%.
  const heavy = turnUsageOf(
    usage({ totalTokens: 3_317_000, inputTokens: 3_317_000, outputTokens: 11_400, cachedReadTokens: 3_304_000 }),
    null, 211_000,
  );
  check("a cache-heavy turn reads 99–100%, not the old constant 50% (#71)",
    (heavy?.bill.cacheHitPercent ?? 0) >= 99, String(heavy?.bill.cacheHitPercent));
  // …and the listed #71 rows, verbatim: in 3.317m / read 3.304m displayed 50%, truth 100%.
  const row10 = turnUsageOf(
    usage({ totalTokens: 3_328_400, inputTokens: 3_317_000, outputTokens: 11_400, cachedReadTokens: 3_304_000, cachedWriteTokens: 12_700 }),
    null, 211_000,
  );
  check("#71 row 10 (in 3.317m, read 3.304m) now displays 100%",
    row10?.bill.cacheHitPercent === 100, String(row10?.bill.cacheHitPercent));
  check("…and its 写 is REPORTED here (12700), so it survives into the bill",
    row10?.bill.cacheWrite === 12_700, String(row10?.bill.cacheWrite));
  const nocache = turnUsageOf(usage({ totalTokens: 300, inputTokens: 200, outputTokens: 100 }), null, 1000);
  check("an agent that reports no cache buckets gets null, NOT a 0% hit rate",
    nocache?.bill.cacheHitPercent === null, String(nocache?.bill.cacheHitPercent));
  const zero = turnUsageOf(
    usage({ totalTokens: 300, inputTokens: 200, outputTokens: 100, cachedReadTokens: 0, cachedWriteTokens: 0 }),
    null, 1000,
  );
  check("…but a REPORTED zero is a real 0%", zero?.bill.cacheHitPercent === 0);
}

// ---- null ≠ 0 for the cache buckets themselves (issue #71, 「写 0」) ------------------------------
{
  const partial = turnUsageOf(
    usage({ totalTokens: 2400, inputTokens: 2200, outputTokens: 200, cachedReadTokens: 1800 }),
    null, 2000,
  );
  check("a cache bucket the agent never reports stays NULL in the bill (not 0)",
    partial?.bill.cacheRead === 1800 && partial?.bill.cacheWrite === null,
    JSON.stringify(partial?.bill));
  check("…and the hit rate still counts the reported half (1800/2200 = 82%)",
    partial?.bill.cacheHitPercent === 82, String(partial?.bill.cacheHitPercent));
  const reported0 = turnUsageOf(
    usage({ totalTokens: 2400, inputTokens: 2200, outputTokens: 200, cachedReadTokens: 1800, cachedWriteTokens: 0 }),
    null, 2000,
  );
  check("…while a REPORTED 0 is 0 — the two states stay distinguishable",
    reported0?.bill.cacheWrite === 0, String(reported0?.bill.cacheWrite));
  // A baseline that never reported cache must not poison the next diff: the first reported value
  // is that turn's own, exactly like a first turn with no baseline.
  const firstReport = turnUsageOf(
    usage({ totalTokens: 2500, inputTokens: 2300, outputTokens: 200, cachedReadTokens: 1800, cachedWriteTokens: 40 }),
    { total: 2400, input: 2200, output: 200, thought: 0, cacheRead: null, cacheWrite: null },
    2000,
  );
  check("a null baseline + a first report = that turn's own value (not a negative or a wash-out)",
    firstReport?.bill.cacheRead === 1800 && firstReport?.bill.cacheWrite === 40,
    JSON.stringify(firstReport?.bill));
}

// ---- speed is the turn average ----------------------------------------------------------------
{
  const b = turnUsageOf(usage({ totalTokens: 3000, inputTokens: 1000, outputTokens: 600 }), null, 3000);
  check("tps = output / wall time (600 out over 3 s = 200)", b?.bill.tps === 200, String(b?.bill.tps));
  const slow = turnUsageOf(
    usage({ totalTokens: 3000, inputTokens: 1000, outputTokens: 600 }),
    { total: 0, input: 0, output: 0, thought: 0, cacheRead: 0, cacheWrite: 0 }, 60_000,
  );
  check("a long tool turn honestly reads slow (600 out over 60 s = 10 t/s)",
    slow?.bill.tps === 10, String(slow?.bill.tps));
  const noOut = turnUsageOf(usage({ totalTokens: 900, inputTokens: 900, outputTokens: 0 }), null, 2000);
  check("no output tokens → no speed, never a fake 0 t/s", noOut?.bill.tps === null);
}

// ---- nothing reported at all ------------------------------------------------------------------
{
  check("a backend that returns no usage at all yields null (Qoder)", turnUsageOf(null, null, 1000) === null);
  check("…same for an empty object", turnUsageOf({}, null, 1000) === null);
  check("non-numeric junk is ignored rather than coerced to 0",
    turnUsageOf({ totalTokens: "lots", inputTokens: null, outputTokens: undefined }, null, 1000) === null);
}

// ---- what the operator reads ------------------------------------------------------------------
{
  const full = turnUsageText({
    available: true, input: 2400, output: 600, thought: 300, cacheRead: 1500, cacheWrite: 300,
    total: 3000, durationMs: 12_000, cacheHitPercent: 71, tps: 50,
  });
  check("the row shows in / out", /\b2\.3k in\b/.test(full) && /\b600 out\b/.test(full), full);
  check("thinking and cache buckets appear when reported",
    /思考 300/.test(full) && /缓存 读 1\.5k \/ 写 300/.test(full), full);
  // Issue #71 「写 0」: a read-only report must NOT grow a 「/ 写 0」 tail. Read still shows, because
  // it was measured; write is omitted because it never was.
  const readOnly = turnUsageText({
    available: true, input: 2400, output: 600, thought: 0, cacheRead: 1500, cacheWrite: null,
    total: 3000, durationMs: 12_000, cacheHitPercent: 63, tps: 50,
  });
  check("a bucket the agent never reports is OMITTED — no fake 「写 0」 (issue #71)",
    /缓存 读 1\.5k/.test(readOnly) && !/写/.test(readOnly), readOnly);
  check("…the reported half and the hit rate still show", /命中 63%/.test(readOnly), readOnly);
  check("hit rate and the AVERAGE speed are both labelled",
    /命中 71%/.test(full) && /50\.0 t\/s 平均/.test(full), full);
  check("duration closes the line", /12s$/.test(full), full);

  const noCache = turnUsageText({
    available: true, input: 200, output: 100, thought: 0, cacheRead: null, cacheWrite: null,
    total: 300, durationMs: 1000, cacheHitPercent: null, tps: 100,
  });
  check("unreported buckets are omitted, not printed as zeros",
    !/思考/.test(noCache) && !/缓存/.test(noCache) && !/命中/.test(noCache), noCache);
  check("100+ t/s drops the decimal", /100 t\/s 平均/.test(noCache), noCache);

  const na = turnUsageText({
    available: false, input: 0, output: 0, thought: 0, cacheRead: null, cacheWrite: null, total: 0,
  });
  check("an agent that reports nothing says 未上报 instead of a row of zeros",
    na === "agent 未上报用量", na);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
