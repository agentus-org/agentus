// 语音总结 — 「把这一条消息念成一段能听的话」。
//
// 长按消息上的喇叭 → 菜单 → 语音播报总结。摘要由服务端做（`POST /api/sessions/:id/speech-summary`），
// 前端只负责：长按手势、把结果念出来、并且让操作者能看见它到底念了什么。
//
// 三条规矩：
//  1) **缓存**：同一条消息只烧一次模型。第二次长按直接重播（summary 里带着上次的文本）。
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
  /** the message was longer than the guard limit and only its head was sent */
  truncated?: boolean;
}

const cache = new Map<string, SpeechSummary>();
const listeners = new Set<() => void>();
let version = 0;

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

function remember(key: string, s: SpeechSummary): void {
  cache.set(key, s);
  version++;
  for (const fn of listeners) fn();
}

/** Drop a cached summary (the ✕ in the note). Turns the next long press back into a real call. */
export function forgetSummary(key: string): void {
  if (!cache.delete(key)) return;
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
export async function summarizeMessage(sid: string, key: string): Promise<SpeechSummary> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/speech-summary`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
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
    truncated: data.truncated === true,
  };
  remember(key, out);
  return out;
}
