// The word pool and the dictation context (issue #21): two features that existed on paper and were
// dead in practice.
//
// The ASR request carries two enrichment channels — a dynamic `vocabulary` mined from the transcript,
// and `input.context` with the last few turns. Both read the message table with the wrong assumptions:
//
//   1. every kind fed the pool, so `tool` rows (whose `payload.title` IS the command —
//      `execute_code: import sqlite3 …`) contributed `input_mouse`, `emulation`, `https`, `n3.`;
//   2. `agent` rows keep their text at `payload.content.text`, and reading `payload.text` yielded
//      undefined — while `String(payload.content)` contributed the literal token `object`;
//   3. the context window was applied BEFORE the kind filter (`tail(8)` then skip non-user/agent), and
//      a dictated turn almost always follows a burst of 40+ tool/thought rows → context was empty.
//
// This drives the real Store and the real functions, with payloads copied from the shapes the live
// database actually holds.
//
//   npx tsx scripts/qa/hotwords-pool.mts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const { Store } = await import("../../packages/server/src/store/store.ts");
const { contextTexts, dictationContext, rowText, stripFencedCode, hotwordsFor } = await import("../../packages/server/src/hotwords.ts");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  — ${detail}` : ""}`);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-hotwords-"));
const store = new Store(path.join(dir, "agentus.sqlite"));
const SID = "sess-voice-probe";
const OTHER = "sess-voice-other";
for (const id of [SID, OTHER]) {
  store.upsertSession({
    id, backend: "mock", acpSessionId: "a", cwd: "/tmp", title: id, status: "idle",
    pid: null, createdAt: 1, closedAt: null, home: null,
  } as never);
}

let clock = 1_000;
const add = (kind: string, payload: unknown, sessionId = SID): void =>
  void store.appendMessage({ sessionId, kind: kind as never, payload, createdAt: (clock += 10) });

// ---- the transcript, in the shapes the live table uses ----
add("user", { text: "帮我看下 kasmvnc 的 betabox 转发卡在哪了", attachments: [] });
add("agent", { content: { type: "text", text: "betabox 的转发没问题，问题在 kasmvnc 的 WebSocket 握手" }, messageId: "m1", sessionUpdate: "agent_message_chunk" });
add("thought", { content: { type: "text", text: "先看看 kasmvnc 的地址 10.0.0.8" }, messageId: "t1", sessionUpdate: "agent_thought_chunk" });
add("tool", {
  toolCallId: "c1", kind: "execute",
  title: "execute_code: import sqlite3, json db=\"/tmp/x\" input_mouse emulation UDP https n1. n2. n3.",
  content: [{ content: { text: "```py\nimport urllib.parse\n```" }, type: "content" }],
  locations: [], sessionUpdate: "tool_call",
});
// a model pasting identifiers into a fenced block: prose matters, the snippet does not
add("agent", {
  content: { type: "text", text: "改这一段就行：\n```ts\nconst input_mouse = await page.emulation();\n```\n然后重试 kasmvnc" },
  messageId: "m2", sessionUpdate: "agent_message_chunk",
});
add("user", { text: "好，betabox 那边我再看一眼", attachments: [] }, OTHER);

// ---- 1. where a row's text lives ----
check("rowText: a user row reads payload.text", rowText({ kind: "user", payload: { text: "喂" } } as never) === "喂");
check("rowText: an agent row reads payload.content.text (not payload.text)",
  rowText({ kind: "agent", payload: { content: { type: "text", text: "正文" } } } as never) === "正文");
check("rowText: a tool row yields NOTHING — its title is a command, not speech",
  rowText({ kind: "tool", payload: { title: "execute_code: input_mouse" } } as never) === "");
check("stripFencedCode: drops the snippet, keeps the prose",
  stripFencedCode("改这一段：\n```ts\nconst x = 1;\n```\n然后重试") === "改这一段： 然后重试",
  stripFencedCode("改这一段：\n```ts\nconst x = 1;\n```\n然后重试"));

// ---- 2. the pool: natural language only ----
const texts = contextTexts(store, SID);
const joined = texts.join("\n");
check("the pool holds the operator's words", joined.includes("kasmvnc 的 betabox 转发"), `${texts.length} text(s)`);
check("…and the agent's own prose (the half that used to be missing)",
  joined.includes("问题在 kasmvnc 的 WebSocket 握手"), joined.slice(0, 80));
check("…but not the tool command line", !joined.includes("input_mouse") && !joined.includes("execute_code"), joined.slice(0, 80));
check("…and not the [object Object] artifact", !/object Object|^\s*object\s*$/m.test(joined));
check("…and fenced code is stripped from the agent's reply", !joined.includes("await page.emulation()"), joined.slice(0, 60));
check("a term from another session still surfaces", contextTexts(store, SID).some((t) => t.includes("betabox 那边")));

// ---- 3. the hotword list actually shipped ----
const words = hotwordsFor(store, SID).map((h) => h.word);
const noise = ["input_mouse", "emulation", "udp", "https", "n1.", "n2.", "n3.", "object", "execute_code"];
check("no tool/code token survives into vocabulary", !words.some((w) => noise.includes(w.toLowerCase())), words.join(","));
check("the real names are there to bias", words.some((w) => w.toLowerCase() === "kasmvnc") && words.some((w) => w.toLowerCase() === "betabox"),
  words.join(","));

// ---- 4. the context window: filter FIRST, then take the last 5 ----
const heavy = "sess-voice-heavy";
store.upsertSession({
  id: heavy, backend: "mock", acpSessionId: "a", cwd: "/tmp", title: heavy, status: "idle",
  pid: null, createdAt: 1, closedAt: null, home: null,
} as never);
// 60 rows of tool noise, i.e. a burst of work; then the turns a dictated sentence would follow
for (let i = 0; i < 30; i++) {
  add("thought", { content: { type: "text", text: `第 ${i} 步想一下` }, messageId: `h${i}`, sessionUpdate: "agent_thought_chunk" }, heavy);
  add("tool", { toolCallId: `hc${i}`, kind: "execute", title: `terminal: npm test -- ${i}`, content: [], sessionUpdate: "tool_call" }, heavy);
}
for (let i = 0; i < 6; i++) {
  add("user", { text: `第 ${i} 轮提问`, attachments: [] }, heavy);
  add("agent", { content: { type: "text", text: `第 ${i} 轮回答` }, messageId: `ha${i}`, sessionUpdate: "agent_message_chunk" }, heavy);
}
const ctx = dictationContext(store, heavy);
check("context is NOT empty after a tool-heavy burst (it always was)", ctx.length > 0, `${ctx.length} turn(s)`);
check("…capped at the API's 5", ctx.length === 5, `${ctx.length}`);
check("…in chronological order, newest last", ctx.at(-1)?.text.includes("第 5 轮") ?? false, JSON.stringify(ctx.at(-1)));
check("…roles alternate as user/assistant", ctx.some((c) => c.role === "user") && ctx.some((c) => c.role === "assistant"),
  ctx.map((c) => c.role).join(","));
check("…and the agent turns carry text, not [object Object]",
  ctx.filter((c) => c.role === "assistant").every((c) => c.text.includes("轮回答")), JSON.stringify(ctx));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
