// Session titles.
//
// Two sources, in this order of authority:
//   1. the AGENT — ACP's own `session_info_update` carries `title` ("Agents send this
//      notification to update session information like title… This allows clients to
//      display dynamic session names"). Zero cost, no model call in our layer, and it is
//      the only source that can be right about a conversation we never parse. If an agent
//      ever uses it, it wins.
//   2. US — a deterministic derivation, so a new session stops being "Hermes @ tmp" the
//      moment the operator asks something. hermes-studio/AionUi lineage (AionUi's
//      `buildAutoTitleFromContent`): first non-empty line of the first user prompt, markdown
//      furniture stripped, ≤50 chars. No model, instant, works offline.
//
// The operator's own rename always outranks both (the store keeps `title` = what is
// displayed and `auto_title` = the generated name, so a rename is reversible and a
// generated name never stomps a hand-written one).
import type { StoredMessage } from "@agentus/shared";

/** Hard cap for a single-line row, in characters (AionUi uses 50). */
export const TITLE_MAX = 50;

/**
 * Deterministic title from one blob of text (AionUi's rules, reimplemented):
 * drop thinking blocks, take the first line that carries words, strip the markdown
 * furniture that would otherwise lead (`#`, `>`, `-`, `1.`), collapse runs of spaces,
 * and cap the length. Returns null when nothing usable is left.
 */
export function deriveTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const withoutThink = raw
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, " ")
    .replace(/<think(?:ing)?>[\s\S]*$/i, " ");
  const lines = withoutThink
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l !== "```" && !/^```/.test(l));
  const first = lines[0] ?? "";
  const normalized = first
    .replace(/^[#>*\-\d.\s]+/u, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TITLE_MAX)
    .trim();
  return normalized || null;
}

/** Title from the FIRST user prompt we stored for a session (the AionUi trigger point). */
export function titleFromFirstPrompt(msgs: StoredMessage[]): string | null {
  for (const m of msgs) {
    if (m.kind !== "user") continue;
    const t = deriveTitle(userText(m));
    if (t) return t;
  }
  return null;
}

/** Title from the LATEST user prompt — the cheap reading of "regenerate from the context":
 *  what the operator is working on NOW, rather than what they said first. */
export function titleFromLatestPrompt(msgs: StoredMessage[]): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.kind !== "user") continue;
    const t = deriveTitle(userText(m));
    if (t) return t;
  }
  return null;
}

/** user rows store `{ text }`; accept a `{content:{text}}` shape too so this keeps working
 *  whichever way the ingest writes them (export.ts learned that lesson already). */
function userText(m: StoredMessage): string {
  const p = (m.payload ?? {}) as {
    text?: unknown;
    content?: { text?: unknown } | null;
  };
  if (typeof p.text === "string") return p.text;
  if (p.content && typeof p.content.text === "string") return p.content.text;
  return "";
}

/**
 * The prompt for the agent-driven path. Short on purpose: the answer is one line we paste
 * into a row, and every extra word is an extra second of latency.
 */
export const TITLE_INSTRUCTION =
  "请为这段对话生成一个会话标题：不超过 12 个字或 6 个英文单词，直接输出标题本身，" +
  "不要引号、不要句号、不要任何解释或前缀。";

/** Clean whatever the agent answered into a single-line title. Models like to answer with
 *  quotes, a bullet, "标题：" or a whole sentence; none of that belongs in a rail row. */
export function cleanAgentTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let t = raw.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, " ");
  const line = t
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .find((l) => !/^```/.test(l)) ?? "";
  t = line
    .replace(/^[#>*\-\d.、\s]+/u, "")
    .replace(/^(会话标题|标题|title)\s*[:：]\s*/i, "")
    .replace(/^["'“”‘’《【\[]+|["'“”‘’》】\]]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  return t.slice(0, TITLE_MAX).trim() || null;
}
