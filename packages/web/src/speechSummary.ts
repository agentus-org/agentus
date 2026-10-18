// 语音总结 — 「把这一条消息念成一段能听的话」。
//
// 长按消息上的喇叭 → 菜单 → 语音播报总结。摘要由服务端做（`POST /api/sessions/:id/speech-summary`），
// 前端只负责：长按手势、把结果念出来、并且让操作者能看见它到底念了什么。
//
// 三条规矩：
//  1) **缓存**：同一条消息的同一个字数档只烧一次模型。第二次长按直接重播（summary 里带着上次的文本）。
//     键里带档位（`<key>#<maxChars>`）：先点 100 字再点 200 字是两个不同的请求，否则第二下会
//     回放那份 100 字的旧稿，看起来像「档位没用」。
//  2) **看得见**：生成后在消息下方留一行「播报稿 · N 字」，可展开全文 —— 语音最怕「它念了什么」说不清，
//     这一行同时也是判断提示词好不好用的唯一入口。
//  3) **不许假装**：失败就是失败，绝不把原文当成摘要念（那会让人以为模型总结过了）。

export interface SpeechSummary {
  /** the text to speak — a model paraphrase, or the message itself when it was already short */
  text: string;
  /** "model" = a paraphrase; "verbatim" = the message was short enough to read as-is */
  via: "model" | "verbatim";
  chars: number;
  /** how long the model took (0 for verbatim) */
  ms: number;
  /** the model name that answered, when one did */
  model?: string;
  /** Which account it was billed to: the session's own provider, or the voice endpoint as fallback.
   *  The note prints this — a summary that silently cost money on the OTHER vendor would be a lie
   *  about where the tokens went. */
  route?: "session" | "voice";
  provider?: string;
  /** where the endpoint came from (config.yaml / an env var), or why the fallback happened */
  routeNote?: string;
  /** the message was longer than the guard limit and only its head was sent */
  truncated?: boolean;
  /** which 字数档 produced this one (absent on server rows that predate the buckets) */
  maxChars?: number;
}

const cache = new Map<string, SpeechSummary>();
/** messageKey → the cache key of the bucket generated LAST for it. The note shows that one; a
 *  per-bucket cache without this would leave 「播报稿」 pointing at whichever was asked first. */
const latest = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

/** The cache key for one (message, 字数档) pair. No bucket = 「按设置」, which keeps the old key so a
 *  summary generated before this change still plays. */
export function summaryKey(messageKey: string, maxChars?: number): string {
  return maxChars === undefined || maxChars === null ? messageKey : `${messageKey}#${maxChars}`;
}

export function subscribeSummaries(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** useSyncExternalStore snapshot: a counter, so a replaced summary re-renders the note. */
export function summariesVersion(): number {
  return version;
}

export function getSummary(key: string): SpeechSummary | undefined {
  return cache.get(key);
}

/** The most recent summary for a message, whichever 字数档 produced it. */
export function getLatestSummary(messageKey: string): SpeechSummary | undefined {
  const k = latest.get(messageKey);
  return k ? cache.get(k) : cache.get(messageKey);
}

function remember(messageKey: string, key: string, s: SpeechSummary): void {
  cache.set(key, s);
  latest.set(messageKey, key);
  version++;
  for (const fn of listeners) fn();
}

/** Drop a cached summary (the ✕ in the note). Turns the next long press back into a real call.
 *  Takes either shape: a bucket key (`m1#150`) drops that bucket, a bare message key drops every
 *  bucket of that message — 「丢掉这份稿子」 must not leave a stale sibling behind. */
export function forgetSummary(key: string): void {
  const bare = key.includes("#") ? key.slice(0, key.lastIndexOf("#")) : key;
  let dropped = false;
  for (const k of [...cache.keys()]) {
    if (k !== key && k !== bare && !k.startsWith(`${bare}#`)) continue;
    cache.delete(k);
    dropped = true;
  }
  if (latest.get(bare) === key || !cache.has(latest.get(bare) ?? "")) latest.delete(bare);
  if (!dropped) return;
  version++;
  for (const fn of listeners) fn();
}

export class SummaryError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
  }
}

/**
 * Ask the server for a spoken version of ONE stored message.
 *
 * Only the message KEY travels: the body is read from the store server-side, so the browser cannot
 * decide what reaches the model (nor skip the length guard by claiming a shorter text).
 */
export async function summarizeMessage(sid: string, key: string, maxChars?: number): Promise<SpeechSummary> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/speech-summary`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    // `maxChars` is optional on purpose: absent = 「按设置」, and the server keeps using the
    // configured number (which is also what a page that predates the buckets sends).
    body: JSON.stringify(maxChars === undefined ? { key } : { key, maxChars }),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<SpeechSummary> & { error?: string; code?: string };
  if (!res.ok) {
    // The server distinguishes "nothing is configured" from "the endpoint refused" from "we gave
    // up waiting" — the operator's next move is different in each case, so say which one it is.
    const hint =
      data.code === "disabled"
        ? "到 设置 → 语音总结 打开开关"
        : data.code === "not_configured"
          ? "先到 设置 → 语音 配置 DashScope 端点与 API Key（ASR / TTS 用的就是它）"
          : data.code === "timeout"
            ? "模型超时了，可以重试；或把超时时间调大"
            : undefined;
    throw new SummaryError(data.error || `HTTP ${res.status}`, hint);
  }
  const out: SpeechSummary = {
    text: String(data.text ?? ""),
    via: data.via === "verbatim" ? "verbatim" : "model",
    chars: Number(data.chars ?? String(data.text ?? "").length),
    ms: Number(data.ms ?? 0),
    model: data.model,
    route: data.route === "session" ? "session" : data.route === "voice" ? "voice" : undefined,
    provider: data.provider,
    routeNote: data.routeNote,
    truncated: data.truncated === true,
    maxChars: data.maxChars === undefined ? maxChars : Number(data.maxChars),
  };
  remember(key, summaryKey(key, maxChars), out);
  return out;
}
