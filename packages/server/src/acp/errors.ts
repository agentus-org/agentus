/**
 * ACP errors put the actionable text in the JSON-RPC error's `data`, while `message` stays the
 * protocol title ("Invalid params" / "Internal error"). Hermes does exactly that for a rejected
 * model switch — `RequestError.invalid_params({"details": str(exc)})`, where `details` is the
 * sentence that says WHY (`was not found in this provider's model listing. Similar models: …`)
 * — and the SDK preserves it (`new RequestError(code, message, data)`, jsonrpc.js).
 *
 * Stringifying `.message` alone (what this server used to do) therefore threw the diagnosis away
 * and left the operator with four useless words: measured on the live cockpit, a model that could
 * not be switched reported `model switch failed: Invalid params` and nothing else (track §61).
 * Every boundary that reports an agent-side failure goes through here instead.
 *
 * When all `.message` holds is a protocol title, the details ARE the error and are returned
 * alone — "Invalid params: Model `x` was not found …" leads with noise the operator cannot act
 * on. A message with content of its own keeps the title out front so the two stay distinguishable.
 */
const PROTOCOL_TITLES = new Set([
  "parse error",
  "invalid request",
  "method not found",
  "invalid params",
  "internal error",
  "request cancelled",
  "authentication required",
  "resource not found",
]);

export function describeAcpError(e: unknown): string {
  const message = String((e as { message?: unknown })?.message ?? e);
  const details = acpErrorDetails((e as { data?: unknown })?.data);
  if (!details || details === message || message.includes(details)) return message;
  return PROTOCOL_TITLES.has(message.trim().toLowerCase()) ? details : `${message}: ${details}`;
}

/** The human sentence inside a JSON-RPC error `data` payload, or "" when there is none we trust
 *  to be short and readable (an arbitrary object would drown the banner in JSON). */
function acpErrorDetails(data: unknown): string {
  if (typeof data === "string") return data.trim();
  if (typeof data !== "object" || data === null) return "";
  const rec = data as Record<string, unknown>;
  for (const key of ["details", "detail", "error", "message"]) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}
