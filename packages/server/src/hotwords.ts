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
  const counts = new Map<string, { n: number; sample: string }>();
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
      const prev = counts.get(raw);
      if (prev) prev.n += 1;
      else counts.set(raw, { n: 1, sample: raw });
    }
  }
  const ranked = [...counts.entries()]
    .filter(([, v]) => v.n >= 2)
    .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
    .slice(0, limit);
  return ranked.map(([word, v]) => ({
    word,
    weight: v.n >= 5 ? 5 : 4,
    origin: "dynamic" as const,
  }));
}

/** Recent transcript text to mine hotwords from: the given session first (its messages
 *  are the conversation the operator is dictating INTO), then the other sessions so a
 *  term used across the cockpit today also surfaces. */
export function contextTexts(store: Store, sessionId?: string, budgetChars = 24_000): string[] {
  const out: string[] = [];
  let used = 0;
  const take = (rows: { kind: string; payload: unknown }[], cap: number): void => {
    let n = 0;
    for (const r of rows) {
      if (n >= cap || used > budgetChars) break;
      const p = r.payload as { text?: string; title?: string; content?: string };
      const t = String(p?.text ?? p?.title ?? p?.content ?? "");
      if (t.length > 1 && t.length < 4000) {
        out.push(t);
        used += t.length;
        n += 1;
      }
    }
  };
  if (sessionId) take(store.messagesTail(sessionId, 60).messages, 40);
  for (const s of store.listSessions(false)) {
    if (s.id === sessionId) continue;
    take(store.messagesTail(s.id, 12).messages, 8);
  }
  return out;
}

/** The full list an ASR request should carry: fixed first (they may use =50), dynamic
 *  filling the rest up to the configured limit. */
export function hotwordsFor(store: Store, sessionId?: string): Hotword[] {
  const v = getSettings().voice;
  const fixed = v.hotwords.map(parseHotword).filter((h): h is Hotword => Boolean(h));
  const seen = new Set(fixed.map((h) => h.word));
  const limit = Math.max(0, Math.min(200, v.hotwordLimit));
  const out: Hotword[] = fixed.slice(0, limit);
  if (v.dynamicHotwords) {
    const dyn = extractDynamicHotwords(contextTexts(store, sessionId), Math.max(0, limit - out.length));
    for (const h of dyn) {
      if (seen.has(h.word)) continue;
      seen.add(h.word);
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
