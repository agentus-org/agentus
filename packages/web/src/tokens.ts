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
