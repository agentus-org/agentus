// Per-turn token bills and how they read on screen (issue #70).
//
// Why a unit guard and not only a browser sweep: the numbers on this row are ARITHMETIC over a
// protocol contract — ACP reports usage CUMULATIVELY ("Total … across all turns"), so every
// per-turn figure is a subtraction, and the cache-hit denominator is the full prompt (input +
// cache read + cache write), which is the one place a plausible-looking wrong answer exists. A
// page sweep can prove a line appeared; it cannot tell a correct diff from a cumulative total.
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

// ---- cache hit rate: cached reads over the FULL prompt -----------------------------------------
{
  const b = turnUsageOf(
    usage({ totalTokens: 2100, inputTokens: 200, outputTokens: 100, cachedReadTokens: 1500, cachedWriteTokens: 300 }),
    null, 2000,
  );
  // prompt = 200 + 1500 + 300 = 2000; hit = 1500 / 2000 = 75%
  check("hit rate is cacheRead / (input + cacheRead + cacheWrite), as webui defines it",
    b?.bill.cacheHitPercent === 75, String(b?.bill.cacheHitPercent));
  const nocache = turnUsageOf(usage({ totalTokens: 300, inputTokens: 200, outputTokens: 100 }), null, 1000);
  check("an agent that reports no cache buckets gets null, NOT a 0% hit rate",
    nocache?.bill.cacheHitPercent === null, String(nocache?.bill.cacheHitPercent));
  const zero = turnUsageOf(
    usage({ totalTokens: 300, inputTokens: 200, outputTokens: 100, cachedReadTokens: 0, cachedWriteTokens: 0 }),
    null, 1000,
  );
  check("…but a REPORTED zero is a real 0%", zero?.bill.cacheHitPercent === 0);
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
  check("hit rate and the AVERAGE speed are both labelled",
    /命中 71%/.test(full) && /50\.0 t\/s 平均/.test(full), full);
  check("duration closes the line", /12s$/.test(full), full);

  const noCache = turnUsageText({
    available: true, input: 200, output: 100, thought: 0, cacheRead: 0, cacheWrite: 0,
    total: 300, durationMs: 1000, cacheHitPercent: null, tps: 100,
  });
  check("unreported buckets are omitted, not printed as zeros",
    !/思考/.test(noCache) && !/缓存/.test(noCache) && !/命中/.test(noCache), noCache);
  check("100+ t/s drops the decimal", /100 t\/s 平均/.test(noCache), noCache);

  const na = turnUsageText({
    available: false, input: 0, output: 0, thought: 0, cacheRead: 0, cacheWrite: 0, total: 0,
  });
  check("an agent that reports nothing says 未上报 instead of a row of zeros",
    na === "agent 未上报用量", na);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
