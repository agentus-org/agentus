// Hotwords: fixed + dynamic, both feeding the same place (the ASR request).
//
// DashScope gives two channels and we use them where each is strongest:
//  * instant `vocabulary` ({"词": 权重}) on the streaming WebSocket — decoded-side bias,
//    exactly the mechanism the operator named ("固定热词");
//  * a system-message word list on the OpenAI-compatible batch route — the docs'
//    "实体词表" context channel, because that surface has no vocabulary parameter.
//
// "根据上下文动态生成高频热词": the cockpit knows the real context — the session's own
// transcript (and the workspace names). We rank recent message text by term frequency
// with a cheap CJK+latin tokenizer, keep plausible terms (length, noise words, code
// identifiers), and merge them under the fixed list (fixed wins, and fixed entries may
// carry =weight, including DashScope's weight-50 super-hotwords).
import { getSettings } from "./settings.js";
import type { Store } from "./store/store.js";

export interface Hotword {
  word: string;
  weight: number;
  origin: "fixed" | "dynamic";
}

/** Words that are frequent but useless as hotwords: they bias toward text that is
 *  already the default output. */
const STOP = new Set([
  "的", "了", "是", "在", "我", "你", "他", "她", "它", "我们", "你们", "他们", "这", "那", "有", "没有",
  "一个", "可以", "什么", "怎么", "这个", "那个", "就是", "然后", "因为", "所以", "如果", "但是",
  "the", "and", "for", "with", "that", "this", "from", "have", "will", "your", "you", "are", "was",
  "not", "but", "all", "can", "get", "out", "its", "into", "then", "than", "also", "use", "used",
  "using", "useful", "here", "there", "when", "what", "which", "while", "please", "thanks",
]);

/** Parse "词" or "词=4" (weight 1..5, or the super-hotword 50). */
export function parseHotword(raw: string): Hotword | null {
  const t = raw.trim();
  if (!t) return null;
  const m = /^(.*?)(?:\s*=\s*(\d+))?$/s.exec(t);
  const word = (m?.[1] ?? t).trim();
  if (!word) return null;
  let weight = Number(m?.[2] ?? 4);
  if (!Number.isFinite(weight)) weight = 4;
  weight = weight >= 50 ? 50 : Math.min(5, Math.max(1, Math.round(weight)));
  return { word, weight, origin: "fixed" };
}

const WORD_RE = /[A-Za-z][A-Za-z0-9_+.-]{2,}|[一-龥]{2,8}/g;

/** Term-frequency over the operator's recent text, filtered and ranked. Returns at most
 *  `limit` terms; fixed hotwords always survive the cap separately. */
export function extractDynamicHotwords(texts: string[], limit = 20): Hotword[] {
  // One entry per WORD, not per spelling: `Release` / `release` are one word to a recogniser, so
  // counting them apart spends two of the operator's slots on one term and sends both as separate
  // vocabulary keys. Keyed lowercase; the emitted spelling is the one seen most often (ties keep
  // whichever appeared first — usually the sentence that introduced the term).
  const counts = new Map<string, { n: number; forms: Map<string, number> }>();
  for (const text of texts) {
    for (const m of text.matchAll(WORD_RE)) {
      const raw = m[0];
      const lower = raw.toLowerCase();
      if (STOP.has(lower) || STOP.has(raw)) continue;
      // ascii runs: require a bit of substance (a path segment, an identifier), not noise
      if (/^[A-Za-z]/.test(raw)) {
        if (raw.length > 24) continue;
        // skip obvious code-only tokens like "return", file suffixes
        if (/^[\w.-]*\.(ts|js|py|md|json|yaml|yml|sh|tsx|jsx)$/.test(lower)) continue;
      } else if (raw.length > 8) {
        continue;
      }
      // Base16 fragments (`a551e`, `9f2c1ab`) pass every length/letters test but are never spoken:
      // they are commit shas and ids the transcript cites. Require a digit so real hex-ish words
      // (`LITE`, `NVDA`, `ACP`) survive.
      if (/^(?=.*\d)[0-9a-f]{5,}$/i.test(raw)) continue;
      const prev = counts.get(lower);
      if (prev) {
        prev.n += 1;
        prev.forms.set(raw, (prev.forms.get(raw) ?? 0) + 1);
      } else {
        counts.set(lower, { n: 1, forms: new Map([[raw, 1]]) });
      }
    }
  }
  const spelled = (forms: Map<string, number>): string => {
    let best = "";
    let bestN = 0;
    for (const [form, n] of forms) if (n > bestN) { best = form; bestN = n; }
    return best;
  };
  const ranked = [...counts.entries()]
    .filter(([, v]) => v.n >= 2)
    .map(([lower, v]) => ({ lower, word: spelled(v.forms), n: v.n }))
    .sort((a, b) => b.n - a.n || a.lower.localeCompare(b.lower))
    .slice(0, limit);
  return ranked.map(({ word, n }) => ({
    word,
    weight: n >= 5 ? 5 : 4,
    origin: "dynamic" as const,
  }));
}

/** The natural-language text of one stored message, wherever its kind puts it.
 *
 *  Each shape has already been read wrong once, so they are spelled out here instead of being
 *  re-guessed at every call site:
 *  * `user` rows carry `payload.text`;
 *  * ACP rows (`agent`, `thought`) carry the frame as `payload.content = { text }` — reading
 *    `payload.text` gives undefined, and `String(payload.content)` gives `"[object Object]"`
 *    (which is how `object` ended up in the word pool);
 *  * `tool` rows carry `payload.title`, and that title is the COMMAND (`execute_code: import
 *    sqlite3 …`). A tool command is not something the operator is about to say, so this
 *    returns "" for them — identifiers like `input_mouse`/`emulation`/`https` came in from here.
 *
 *  Callers still choose which kinds to feed (see `contextTexts`); this only answers "where is
 *  this row's text", never "is this row worth reading". */
export function rowText(row: { kind: string; payload: unknown }): string {
  const p = row.payload as { text?: unknown; content?: { text?: unknown } | unknown } | null;
  if (row.kind === "user") return typeof p?.text === "string" ? p.text : "";
  if (row.kind === "agent" || row.kind === "thought") {
    const c = p?.content as { text?: unknown } | undefined;
    return typeof c?.text === "string" ? c.text : "";
  }
  return "";
}

/** Drop fenced code blocks before mining: a model pasting `input_mouse` into a snippet is not
 *  the model about to SAY `input_mouse`. Inline `code spans` are deliberately kept — they are
 *  usually the very terms worth biasing (`kasmvnc`, `betabox`). */
export function stripFencedCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
}

/** Recent transcript text to mine hotwords from: the given session first (its messages
 *  are the conversation the operator is dictating INTO), then the other sessions so a
 *  term used across the cockpit today also surfaces. Only natural-language rows feed the
 *  pool (`user` + `agent`): tool calls and reasoning carry identifiers the operator will
 *  never pronounce, and they used to fill most of the dynamic slots. */
export function contextTexts(store: Store, sessionId?: string, budgetChars = 24_000): string[] {
  const out: string[] = [];
  let used = 0;
  const take = (rows: { kind: string; payload: unknown }[], cap: number): void => {
    let n = 0;
    for (const r of rows) {
      if (n >= cap || used > budgetChars) break;
      if (r.kind !== "user" && r.kind !== "agent") continue;
      const t = stripFencedCode(rowText(r));
      if (t.length > 1 && t.length < 4000) {
        out.push(t);
        used += t.length;
        n += 1;
      }
    }
  };
  // Ask the store for natural-language rows; a row window (`tail(60)`) is routinely all tool calls.
  if (sessionId) take(store.messagesLastKinds(sessionId, ["user", "agent"], 40), 40);
  for (const s of store.listSessions(false)) {
    if (s.id === sessionId) continue;
    take(store.messagesLastKinds(s.id, ["user", "agent"], 8), 8);
  }
  return out;
}

/** The tail of a session for DashScope's context enhancement ("根据上下文"): user/assistant turns
 *  only, capped at 5 by the API.
 *
 *  The window used to be measured on ROWS and then filtered by KIND (`tail(8)`, then skip everything
 *  that is not user/agent), which is empty almost always: dictation happens right after the agent
 *  finished a burst of work, and 40+ consecutive `tool`/`thought` rows are normal here (measured on a
 *  live session: zero natural-language rows in its last 40). So read a wide tail and take the last 5
 *  SURVIVORS. Lives next to the pool because both answer the same question with the same row shapes. */
export function dictationContext(store: Store, sessionId?: string, turns = 5): { role: "user" | "assistant"; text: string }[] {
  if (!sessionId) return [];
  // Read MORE than `turns` natural-language rows (a fenced-only reply can filter out) but never
  // by row count: 200 rows of a busy session is 0 sentences, which is how this returned `[]` for
  // a session with seven user turns in it.
  const out: { role: "user" | "assistant"; text: string }[] = [];
  for (const row of store.messagesLastKinds(sessionId, ["user", "agent"], turns + 5)) {
    const text = stripFencedCode(rowText(row)).slice(0, 200);
    if (text) out.push({ role: row.kind === "user" ? "user" : "assistant", text });
  }
  return out.slice(-turns);
}

/** The full list an ASR request should carry: fixed first (they may use =50), dynamic
 *  filling the rest up to the configured limit. */
export function hotwordsFor(store: Store, sessionId?: string): Hotword[] {
  const v = getSettings().voice;
  const fixed = v.hotwords.map(parseHotword).filter((h): h is Hotword => Boolean(h));
  // lowercase on purpose: a dynamic `hermes` must not ride along beside a fixed `Hermes` (same word to
  // the recogniser, two vocabulary keys and two slots for us)
  const seen = new Set(fixed.map((h) => h.word.toLowerCase()));
  const limit = Math.max(0, Math.min(200, v.hotwordLimit));
  const out: Hotword[] = fixed.slice(0, limit);
  if (v.dynamicHotwords) {
    const dyn = extractDynamicHotwords(contextTexts(store, sessionId), Math.max(0, limit - out.length));
    for (const h of dyn) {
      const key = h.word.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(h);
    }
  }
  return out;
}

/** DashScope's instant-hotword payload: {词: 权重}. */
export function vocabularyOf(words: Hotword[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of words) out[h.word] = h.weight;
  return out;
}
