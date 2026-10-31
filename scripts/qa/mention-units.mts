// @ 跨工作空间转交 —— 选择器与标签的纯逻辑检查（packages/web/src/mention.ts）。
//
// 为什么是单测而不是浏览器 sweep：这里全是"哪一行排第一、过滤后还剩谁、退格带走多少"的判断，
// 与像素无关。浏览器那边只该验证一件事 —— 这些东西被画出来并且真的发出去了（mention-sweep.mjs）。
//
// Run: npm run mention-units   (tsx; no browser, no server)
import { bridgeTitle, buildBridgeEnvelope } from "../../packages/server/src/bridge.ts";
import {
  backspaceToken, caretInsideToken, insertToken, lastOf, mentionChoices, mentionWorkspaces,
  stripToken, tokenIntact, tokenText,
  type MentionSession,
} from "../../packages/web/src/mention.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const s = (id: string, workspace: string, title: string, lastAt: number): MentionSession =>
  ({ id, cwd: workspace, workspace, title, lastAt, createdAt: lastAt - 1000 });

// Fixture shaped like the operator's real rail: three workspaces, the middle one is where he is now.
const ALL: MentionSession[] = [
  s("aaa11111", "/Users/liang/Workspace/agent-dev-workspace", "TTS 流式返工", 5_000),
  s("bbb22222", "/Users/liang/Workspace/agent-dev-workspace", "审批卡回音", 3_000),
  s("ccc33333", "/Users/liang/Workspace/stock-workspace", "持仓复盘", 9_000),
  s("ddd44444", "/Users/liang/Workspace/stock-workspace", "网格参数", 7_000),
  s("eee55555", "/Users/liang/Workspace/voice-chat", "语音随手聊", 1_000),
];
const HERE = "/Users/liang/Workspace/agent-dev-workspace/";   // trailing slash on purpose

// 1. 当前空间钉第一 —— 哪怕它不是最近说话的那个（stock 是 9000，比这里新）。
{
  const ws = mentionWorkspaces(ALL, HERE);
  check("the workspace you are standing in comes first even when it is not the newest",
    ws[0].path === "/Users/liang/Workspace/agent-dev-workspace" && ws[0].current === true,
    ws.map((w) => `${w.label}${w.current ? "*" : ""}`).join(","));
  check("trailing slash on the current path still matches", ws[0].current === true);
}

// 2. 其余按组内最新对话时间倒序（stock 9000 → voice 1000）。
{
  const ws = mentionWorkspaces(ALL, HERE);
  check("the rest are ordered by their newest session",
    ws.slice(1).map((w) => w.label).join(",") === "stock-workspace,voice-chat",
    ws.map((w) => w.label).join(","));
}

// 3. 组内会话倒序 + 组内 lastAt 取最大。
{
  const ws = mentionWorkspaces(ALL, HERE);
  const here = ws[0];
  check("sessions inside a group are newest-first", here.sessions.map((x) => x.id).join(",") === "aaa11111,bbb22222",
    here.sessions.map((x) => x.id).join(","));
  check("a group's time is its newest session's time", here.lastAt === 5_000, String(here.lastAt));
}

// 4. 第二段：第一行永远是新会话。
{
  const ws = mentionWorkspaces(ALL, HERE)[1];   // stock-workspace
  const rows = mentionChoices(ws, "");
  check("the first row is always 新会话", rows[0].kind === "new" && rows[0].workspace === ws.path, JSON.stringify(rows[0]));
  check("then that workspace's sessions, newest first",
    rows.slice(1).map((r) => r.id).join(",") === "ccc33333,ddd44444", rows.map((r) => r.label).join(","));
}

// 5. 打字过滤：命中就只剩命中，且「新会话」让位（打了字还钉着它，要多按一次 ↓）。
{
  const ws = mentionWorkspaces(ALL, HERE)[1];
  const rows = mentionChoices(ws, "网格");
  check("typing filters to the match and drops the 新会话 row",
    rows.length === 1 && rows[0].id === "ddd44444", rows.map((r) => r.label).join(","));
  const byId = mentionChoices(ws, "ccc3");
  check("an id prefix finds a session too", byId.length === 1 && byId[0].id === "ccc33333", JSON.stringify(byId.map((r) => r.id)));
  const none = mentionChoices(ws, "zzz");
  check("no match → an empty list (the palette says so rather than showing 新会话)", none.length === 0, JSON.stringify(none));
}

// 6. 标签：插入到光标处、原地完好、正文干净、整块退格。
{
  const ins = insertToken("修复一下这个 bug", 0, "stock-workspace › 新会话");
  check("the token lands at the caret and the caret moves behind it",
    ins.text === `${tokenText("stock-workspace › 新会话")}修复一下这个 bug` && ins.caret === ins.token.len,
    JSON.stringify({ text: ins.text, caret: ins.caret }));
  check("the token is intact right after insertion", tokenIntact(ins.text, ins.token));
  check("the body sent to the target has no token in it",
    stripToken(ins.text, ins.token) === "修复一下这个 bug", stripToken(ins.text, ins.token));

  const mid = insertToken("先看这里，再说别的", 3, "voice-chat › 语音随手聊");
  check("a token can sit mid-text and the body keeps both halves",
    stripToken(mid.text, mid.token) === "先看这里，再说别的", mid.text);

  const bs = backspaceToken(ins.text, ins.token.len, ins.token);
  check("backspace right after the token removes the whole block",
    bs !== null && bs.text === "修复一下这个 bug" && bs.caret === 0, JSON.stringify(bs));
  check("backspace elsewhere is a normal one", backspaceToken(ins.text, ins.token.len + 2, ins.token) === null);
}

// 7. 标签被编辑过就作废：宁可退回普通文字，也不要按旧下标去切错地方。
{
  const ins = insertToken("abc", 0, "stock-workspace › 新会话");
  const broken = ins.text.replace("stock-workspace", "stoc");
  check("an edited token is no longer intact", tokenIntact(broken, ins.token) === false);
  check("stripToken on a broken token returns the text untouched",
    stripToken(broken, ins.token) === broken.trim());
  check("a caret inside the token is reported as inside",
    caretInsideToken(ins.token.start + 2, ins.token) === true && caretInsideToken(0, ins.token) === false);
}

// 8. lastOf: 没说过话的会话用 createdAt（与 rail 同一规则 —— 否则新会话会沉到底部）。
{
  check("a session that never spoke is ordered by its creation time",
    lastOf({ id: "x", cwd: "/a", title: "t", createdAt: 42 }) === 42);
}

// 9. 转交新建的会话叫什么 —— 不给名字的话标题会变成信封的第一段（rail 上一条说明书）。
{
  check("a transferred session is named after where it came from", bridgeTitle("排查问题", "aaaaaaaa") === "← 排查问题",
    bridgeTitle("排查问题", "aaaaaaaa"));
  check("no title yet → fall back to the id, not to an empty arrow", bridgeTitle(null, "aaaaaaaa") === "← aaaaaaaa");
  check("a very long title is cut, so the rail row stays a row", bridgeTitle("x".repeat(80), "aaaaaaaa").length === 42,
    String(bridgeTitle("x".repeat(80), "aaaaaaaa").length));
}

// 10. 信封里的示例只读**最后一条 agent 回复**，并且把"要更多自己按需取"写清楚。
//     60 条那版是错的：目标会话还没开口就先被塞进几十条原文，上下文一下就见底了。
{
  const env = buildBridgeEnvelope({ from: "abc12345", fromTitle: "排查问题", fromCwd: "/w/a", userText: "修一下" });
  check("the example asks for the agent's LAST reply, not a window of history",
    env.includes("--role agent --tail 1"), env.split("\n")[3]);
  check("no bulk count anywhere in the envelope",
    !/--tail\s+(?!1\b)\d+/.test(env), (env.match(/--tail\s*\d+/g) ?? []).join(","));
  check("it says: fetch more only if you actually need it",
    /按需/.test(env) && /调大/.test(env));
  check("the operator's own words are still the last thing in it", env.trim().endsWith("修一下"));
}

console.log(`\nmention-units: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

