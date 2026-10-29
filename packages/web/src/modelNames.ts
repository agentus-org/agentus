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

/** 新建会话对话框把哪个 id 当作"当前模型"。
 *
 *  两个来源都不可全信：`pick` 是操作者刚点的（可能点的是一份陈旧清单里的一行），`cached` 是后端
 *  **上一次真启动**时缓存的握手 current —— 换模型不会刷新它，老版本还可能存着一条幻影 id
 *  （`custom:<模型>`，它的 provider 是个类别名）。清单在手时只认清单里的 id；返回 "" 表示"按后端
 *  默认来"，这比显示、并且重放一个清单里没有的 id 诚实得多（#72）。
 *  清单为空也不猜：那说明该后端没跑过、或者没广告模型，同样返回 ""。 */
export function startModelValue(
  pick: string | null | undefined,
  cached: string | null | undefined,
  ids: readonly string[],
): string {
  const known = (id: string | null | undefined): id is string => Boolean(id) && ids.includes(id as string);
  return known(pick) ? pick : known(cached) ? cached : "";
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
  // ``custom:<entry>:<model>`` — the model list from a task lists every named endpoint this way,
  // and the entry IS the provider. Splitting at the first colon alone labelled all of them
  // "custom" (the billing class), so a box with `lab` and `qoder` entries showed one group called
  // "custom" holding both. Two-part ``custom:<model>`` keeps "custom": there the class really is
  // all the id says.
  const parts = m.modelId.split(":");
  const prefix = parts.length > 2 && parts[0].toLowerCase() === "custom" ? parts[1]
    : parts.length > 1 ? parts[0]
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
