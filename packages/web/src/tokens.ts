/** Token counts the operator reads, in the units the rest of the surface already uses.
 *
 *  BINARY units (1024), because every number this is shown beside is binary: the context
 *  picker's presets are 262144 / 524288 / 786432 / 1048576, labelled 256K / 512K / 768K / 1M.
 *  Dividing by 1000 rendered the 512K preset as "524k" — one window wearing two names, which
 *  is what the operator reported ("选 512k 显示 524k,是不是换算有问题").
 *
 *  Kept in its own module so the arithmetic can be asserted without a browser
 *  (scripts/qa/token-format.mts). */
export function fmtTokens(n: number): string {
  const v = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  if (v < 1024) return String(v);
  if (v < 1048576) return `${trim(v / 1024)}k`;
  return `${trim(v / 1048576)}m`;
}

function trim(x: number): string {
  return Number.isInteger(x) ? String(x) : x.toFixed(1);
}

/** One turn's token bill as a single line (issue #70).
 *
 *  The vocabulary is hermes-webui's (`N in · N out`), because that is what the operator already
 *  reads there. Three rules this function owns, all of them about not lying:
 *  · `available: false` prints 「未上报」 — a Qoder session has no usage, and a row of zeros would
 *    read as "this turn was free";
 *  · a bucket the agent never reports is OMITTED rather than shown as 0 (thinking / cache buckets
 *    only some backends fill);
 *  · speed says 「平均」: it is output tokens over the WHOLE turn, tool calls included, not an
 *    instantaneous reading — the live chip is a separate feature (issue #70 step 1). */
export interface TurnUsageLine {
  available: boolean;
  input: number; output: number; thought: number;
  /** null = the agent never reports this bucket (issue #71) — OMITTED, never printed as 0. */
  cacheRead: number | null; cacheWrite: number | null; total: number;
  durationMs?: number;
  cacheHitPercent?: number | null;
  tps?: number | null;
}

export function turnUsageText(u: TurnUsageLine): string {
  if (!u.available) return "agent 未上报用量";
  const parts = [`${fmtTokens(u.input)} in`, `${fmtTokens(u.output)} out`];
  if (u.thought > 0) parts.push(`思考 ${fmtTokens(u.thought)}`);
  if (u.cacheRead != null || u.cacheWrite != null) {
    // Issue #71: 「in」 here is the turn's billed prompt TOTAL across its API calls (it grows with
    // tool calls and can exceed the context window — the gauge up top is the occupancy), and a
    // bucket the agent never reported is dropped, not shown as 0.
    const seg = [`读 ${fmtTokens(u.cacheRead ?? 0)}`];
    if (u.cacheWrite != null) seg.push(`写 ${fmtTokens(u.cacheWrite)}`);
    parts.push(`缓存 ${seg.join(" / ")}`);
  }
  if (u.cacheHitPercent != null) parts.push(`命中 ${u.cacheHitPercent}%`);
  if (u.tps != null && u.tps > 0) {
    parts.push(`${u.tps >= 100 ? Math.round(u.tps) : u.tps.toFixed(1)} t/s 平均`);
  }
  if (u.durationMs != null && u.durationMs > 0) parts.push(shortDuration(u.durationMs));
  return parts.join(" · ");
}

function shortDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  return total % 60 ? `${m}m ${total % 60}s` : `${m}m`;
}
