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
import type { StoredMessage } from "../../shared/src/index.js";

/** Hard cap for a single-line row, in characters.
 *
 *  Deliberately EQUAL to the agent's own derived-title rule (`MAX_DERIVED_TITLE_CHARS = 48` in
 *  hermes' `agent/title_generator.py`, cut at a word boundary and marked with `…`). The two numbers
 *  are not independent: telling "a slice of the operator's own words" from "a name the model wrote"
 *  is done by REPRODUCING that slice here (see `isPromptSliceTitle`) — issue #105. They sat at 50 vs
 *  48 with different cut rules, so every prompt whose first line was longer than 48 characters made
 *  the two strings disagree, the agent's slice frame was ranked as a model title, and the session
 *  wore its own truncated opening words for the rest of its life. */
export const TITLE_MAX = 48;

/** Cut one normalized line down to `TITLE_MAX`, at a word boundary when there is one worth using,
 *  trailing punctuation dropped, and `…` marking the truncation — the agent's rule, mirrored. */
function capTitle(line: string): string {
  if (line.length <= TITLE_MAX) return line;
  const cut = line.slice(0, TITLE_MAX);
  const space = cut.lastIndexOf(" ");
  const head = (space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[ ,.;:—-]+$/u, "");
  return `${head}…`;
}

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
  const normalized = capTitle(
    first
      .replace(/^[#>*\-\d.\s]+/u, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
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

/** One line, markdown furniture stripped, whitespace collapsed — the shape both sides truncate.
 *  Kept separate from `deriveTitle` because it must NOT cap: the caller compares prefixes. */
function sliceLine(raw: string): string {
  const withoutThink = raw
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, " ")
    .replace(/<think(?:ing)?>[\s\S]*$/i, " ");
  const first = withoutThink
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && l !== "```" && !/^```/.test(l)) ?? "";
  return first.replace(/^[#>*\-\d.、\s]+/u, "").replace(/\s+/g, " ").trim();
}

/** A title shorter than this is never treated as "a slice of the prompt" by prefix alone — every
 *  short string is somebody's prefix, and a model title that happens to open the operator's message
 *  would be demoted a tier (harmless, but it would cost one extra rename on the next turn). Short
 *  slices are still recognised by exact equality against our own `deriveTitle`. */
const SLICE_MIN_PREFIX = 12;

/** Is `title` the operator's own words rather than a name the agent wrote?
 *
 *  Issue #89 established the mechanism: hermes announces TWO titles in the opening turn through the
 *  same `session_info_update` frame — a slice of the operator's message at turn start, the model's
 *  title a few seconds later — and the frame carries no provenance. We tell them apart by
 *  REPRODUCING the slice, because the slice is by definition the start of a prompt we have.
 *
 *  Issue #105 is why equality alone is not enough: the reproduction was ours (`deriveTitle`, 50
 *  chars, hard cut) and the producer's is the agent's (48, word boundary, `…`), so for any prompt
 *  whose first line runs past the cap the two strings NEVER match — the slice frame was ranked as a
 *  model title, and the real title arriving at the same rank was dropped. Hence the second test:
 *  after dropping the truncation marker, a slice of a prompt is a PREFIX of that prompt, no matter
 *  how either side chose to cut it. A model's title is not a prefix of the operator's message.
 *
 *  Both ends of the transcript are checked: the placeholder tier is written at the START of every
 *  turn, so a session resumed days later announces a slice of its LATEST prompt. */
export function isPromptSliceTitle(title: string, msgs: StoredMessage[]): boolean {
  const users: string[] = [];
  for (const m of msgs) if (m.kind === "user") users.push(userText(m));
  if (!users.length) return false;
  // The frame is one of the two the agent derives at turn boundaries; older prompts are not
  // candidates (a title that happens to quote the first message would otherwise be demoted forever).
  return isPromptSliceText(title, users.length > 1 ? [users[0], users[users.length - 1]] : [users[0]]);
}

/** The same test over prompt TEXTS, for callers that hold the first/latest prompt without a full
 *  `StoredMessage[]` (the title repair pass reads two rows, not a transcript). */
export function isPromptSliceText(title: string, prompts: Array<string | null | undefined>): boolean {
  const cand = title.replace(/\s+/g, " ").trim();
  if (!cand) return false;
  const body = cand.replace(/[…]+$/u, "").replace(/\.{2,}$/, "").trim();
  for (const raw of prompts) {
    if (!raw) continue;
    if (deriveTitle(raw) === cand) return true;
    const line = sliceLine(raw);
    if (!line) continue;
    if (body.length >= SLICE_MIN_PREFIX && line.startsWith(body)) return true;
  }
  return false;
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
