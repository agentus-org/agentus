// What to print for a model, and which provider it belongs to.
//
// Both helpers started life inside App.tsx's chat composer and are now shared: the new-session
// dialog shows the same model list as the chat (see ModelList.tsx), so the labels have to be
// identical in both places — an operator who learned "qwen3.8-flash" on the chat page should not
// meet "openai/gpt-6-astra-pro" in the dialog.

/** What to print on the model button: the model, not its provider.
 *  Agents name models "Provider · model" (Hermes) or "provider:model" (wire ids), and the
 *  toolbar only has room for the interesting half. */
export function shortModelName(name: string, modelId?: string): string {
  const source = (name || modelId || "").trim();
  if (!source) return "";
  const afterDot = source.includes("·") ? source.split("·").pop()!.trim() : source;
  const afterColon = afterDot.includes(":") ? afterDot.split(":").pop()!.trim() : afterDot;
  return afterColon || afterDot || source;
}

/** Which provider a model came from: the id prefix ("openrouter:anthropic/…", "openai/gpt-6") or
 *  the description agents attach ("Provider: OpenRouter"). Used to group the list.
 *  The slash rule is what the new-session dialog needs: there the ids come straight from the
 *  handshake with no descriptions, and 439 rows under one "other" heading is not a grouping. */
export function modelProvider(m: { modelId: string; name?: string | null; description?: string | null }): string {
  const clean = (raw: string): string => raw
    // agents mark the active entry in the description ("Provider: X · current"): that is
    // a state, not a provider, and keeping it split one provider into two groups.
    .replace(/[•·|,-]?\s*\b(current|active|selected|default)\b\s*$/i, "")
    .replace(/[•·|,\s-]+$/g, "")
    .trim();
  const fromDesc = /^\s*provider:\s*(.+)$/i.exec(m.description ?? "");
  if (fromDesc) {
    const name = clean(fromDesc[1]);
    if (name) return name;
  }
  const prefix = m.modelId.includes(":") ? m.modelId.split(":")[0]
    : m.modelId.includes("/") ? m.modelId.split("/")[0]
      : "";
  return clean(prefix) || "other";
}

/** The row label inside a provider group: the group heading already says "openai", so the row
 *  should not repeat it ("gpt-6-astra-pro", not "openai/gpt-6-astra-pro"). */
export function rowModelName(m: { modelId: string; name?: string | null }, provider: string): string {
  const label = shortModelName(m.name ?? "", m.modelId);
  const prefix = `${provider}/`;
  return label.startsWith(prefix) ? label.slice(prefix.length) : label;
}
