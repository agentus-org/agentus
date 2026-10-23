// 语音通话模式（issue #48）：通话里 agent 的输出是要被 TTS 念出来的。
//
// The cockpit already told the agent *what* to answer; it never told it that the answer would be
// SPOKEN. So a question that naturally wants a table produced a table, and the operator heard
// 「竖线 横线 竖线」. This file owns the two things that fix it, and nothing else:
//
//   · the three-state lifecycle (enter → constraint every turn → exit) as a pure decision, so the
//     trickiest part — WHICH block is owed on THIS prompt — is testable without an agent;
//   · the emotion tag (`[emo:x]`): the face on the call screen can only follow the agent if the
//     agent knows the channel exists. The vocabulary lives in shared/ so the prompt and the parser
//     can never disagree about which words are real;
//   · the thinking-depth lookup, because a call is full-duplex and a 20-second first token is
//     indistinguishable from a hang-up.
//
// The block rides the same channel as the plan reminder (`_meta`-tagged resource block), so the
// transcript keeps the operator's own words and nothing else.

/** The `_meta` key that marks a block as OURS — never the operator's words. */
export const VOICE_META_KEY = "agentus/voice-mode";

import { emoTagHint } from "../../../shared/src/index.js";

export type VoiceBoundary = "enter" | "exit";

/** What the store remembers about one session's call state. */
export interface VoiceState {
  inCall: boolean;
  /** A boundary that has not been delivered yet: it rides the NEXT prompt, then clears. */
  boundary: VoiceBoundary | null;
  /** How many prompts were spoken inside this call — the exit block quotes it. */
  turns: number;
}

/** 进入通话：边界 + 约束合一（一次说完，别让模型只记住半句）。 */
export const VOICE_ENTER_TEXT = [
  "现在开始语音通话：你接下来的回复会被 TTS 朗读出来，用户是用耳朵听的。",
  "请用口语化的短句回答（几句话以内），不要表格、代码块、列表符号、链接和 Markdown 标记；",
  "需要列举时用「第一/第二」这样的口语说法。数字、专有名词、路径要念得出来。",
  emoTagHint(),
].join("");

/** 通话中每一轮都带：单轮指令会被后续对话冲淡，也会被压缩摘要吃掉。 */
export const VOICE_STEADY_TEXT =
  "（仍在语音通话中：继续用口语短句回答，不要表格、代码块、列表符号。）" + emoTagHint();

/** 退出通话：不只说「结束了」，还要解释刚才那段的性质 —— 否则模型会接着用通话腔回文字提问。 */
export function voiceExitText(turns: number): string {
  const n = Math.max(0, Math.floor(turns));
  return [
    `语音通话已结束（上面${n > 0 ? ` ${n} 轮` : "的对话"}是通话内容：你的回复被朗读出来，用户的话经语音识别转写，`,
    "可能有识别噪声、断句和口语碎片，不必逐字当真）。",
    "现在恢复文字对话：正常输出格式（表格、代码块、列表都可以用），按文字场景回答。",
  ].join("");
}

/**
 * The block owed on THIS prompt, or null when nothing is owed.
 *
 * Three cases, exactly as the issue specifies:
 *   enter boundary        → enter text + steady text (合一)
 *   in call, no boundary   → steady text only (每轮)
 *   exit boundary          → exit text (一次性)
 */
export function voiceModeBlock(sessionId: string, st: VoiceState): unknown | null {
  const lines: string[] = [];
  if (st.boundary === "enter") {
    lines.push(VOICE_ENTER_TEXT);
    if (st.inCall) lines.push(VOICE_STEADY_TEXT);
  } else if (st.inCall) {
    lines.push(VOICE_STEADY_TEXT);
  } else if (st.boundary === "exit") {
    lines.push(voiceExitText(st.turns));
  }
  if (!lines.length) return null;
  return {
    type: "resource",
    resource: {
      uri: `agentus://voice/${sessionId}`,
      mimeType: "text/plain",
      text: lines.join("\n"),
    },
    _meta: { [VOICE_META_KEY]: true },
  };
}

/**
 * Does this prompt get the call treatment at all?
 *
 * Only an OPERATOR prompt does. A background-completion wake rides the same `prompt()` with an
 * `origin`, and it is a synthetic turn nobody reads: letting it carry the block burned the pending
 * exit boundary into it (so the operator's next real message never learned the call had ended) and
 * inflated the turn count that the exit block quotes.
 */
export function voiceAppliesToPrompt(opts: { origin?: unknown }): boolean {
  return !opts.origin;
}

export interface ThinkingChoice {
  id: string;
  /** The operator's (or the session's) current value. */
  current: string;
  /** The cheapest/fastest value the backend offers — what a call switches to. */
  lowest: string;
}

/**
 * Find the session's thinking-depth knob in the options the AGENT advertised.
 *
 * There is no schema for this: ACP options are free-form, and every backend names its own. The two
 * signals that survive across backends (Hermes, the mock, and the adapters we have seen) are the
 * semantic `category: "thought_level"` and an id/name containing think/reason/effort. If neither is
 * present the session simply has no such knob and call mode must not invent one.
 *
 * The LOWEST level must also be recognised. ACP puts no ordering on the value list, so falling back
 * to `options[0]` is a coin flip that can pick "3 档" or `true` — i.e. a call could make the agent
 * SLOWER, which is the exact failure mode call mode exists to remove (review M3). If no value looks
 * cheapest, report no knob: worse to press an unknown dial than to leave it alone.
 */
export function thinkingOptionOf(options: unknown): ThinkingChoice | null {
  if (!Array.isArray(options)) return null;
  const list = options as { id?: unknown; name?: unknown; category?: unknown; currentValue?: unknown; options?: unknown }[];
  const found = list.find((o) => {
    if (!o || typeof o.id !== "string") return false;
    if (o.category === "thought_level") return true;
    const hay = `${o.id} ${typeof o.name === "string" ? o.name : ""}`;
    return /think|reason|effort/i.test(hay) && Array.isArray(o.options) && o.options.length > 1;
  });
  if (!found) return null;
  const values = (Array.isArray(found.options) ? found.options : [])
    .map((o) => {
      const v = o as { value?: unknown; name?: unknown };
      return {
        value: typeof v.value === "string" ? v.value : typeof v.value === "number" ? String(v.value) : "",
        name: typeof v.name === "string" ? v.name : "",
      };
    })
    .filter((o) => o.value);
  if (values.length < 2) return null;
  const lowValue = /^(off|none|disabled|min|minimal|low|lowest|quick|fast|1)$/i;
  const lowName = /^(off|none|disabled|low|lowest|quick|fast|最低|低|关闭|关|快速|最快|1\s*档?)$/i;
  const pick = values.find((v) => lowValue.test(v.value.trim()) || lowName.test(v.name.trim()));
  if (!pick) return null;
  const currentRaw = found.currentValue;
  return {
    id: found.id as string,
    current: typeof currentRaw === "string"
      ? currentRaw
      : typeof currentRaw === "number" || typeof currentRaw === "boolean" ? String(currentRaw) : "",
    lowest: pick.value,
  };
}
