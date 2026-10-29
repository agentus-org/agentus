// 工作播报「响了之后播什么 / 凭什么播」(issue #76) —— 四条都是可机器判的纪律。
//
//   A  观察员契约里的每一条命令都必须**原样跑得通**（这是本单最便宜的修法：一个字符串常量），
//      而且不许再教它 `--help` / `session list`；
//   B  `messages --role/--user` 先过滤再截尾，meta 三件事分开报（asked / returned / filtered），
//      空结果是空集合而不是错误；
//   C  心跳触发语是两态（有新进展 / 没有新输出），并且「同一句话说第二遍」不出声、不占配额、
//      在诊断里记成 duplicate —— 时间闸和数量闸都挡不住换个说法；
//   D  观察员会话要能被运行时认出来是旁观者（AGENTUS_SESSION_ROLE），才有机会关掉记忆召回与后台评审。
//
//   node_modules/.bin/tsx scripts/qa/observer-scope.mts
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ObserverHub } from "../../packages/server/src/observer/hub.js";
import { OBSERVER_PROMPT_DEFAULT, OBSERVER_PROMPT_MAX } from "../../packages/server/src/settings.js";
import { MESSAGES_TAIL_MAX, MESSAGE_ROLES, tailMessages } from "../../packages/server/src/cockpit/api.js";
import type { ServerEvent, StoredMessage } from "../../packages/shared/src/index.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}${detail ? "  — " + detail : ""}`); }
}

// ───────────────────────────────────────────────────────────── A. 契约里的命令是真的
{
  const cli = fs.readFileSync(path.join(REPO, "bin/cli.mjs"), "utf8");
  // The real verbs, read out of the dispatcher rather than restated here.
  const verbs = new Set([...cli.matchAll(/verb === "([a-z-]+)"/g)].map((m) => m[1]));
  const flags = new Set([...cli.matchAll(/args\.includes\("(--[a-z-]+)"\)|args\.indexOf\("(--[a-z-]+)"\)/g)]
    .flatMap((m) => [m[1], m[2]]).filter(Boolean));

  const commandLines = OBSERVER_PROMPT_DEFAULT.split("\n").filter((l) => l.includes("agentus session "));
  check("A the contract really carries commands", commandLines.length >= 3, `${commandLines.length}`);
  check("A the contract fits the byte budget", OBSERVER_PROMPT_DEFAULT.length <= OBSERVER_PROMPT_MAX,
    `${OBSERVER_PROMPT_DEFAULT.length}/${OBSERVER_PROMPT_MAX}`);

  for (const line of commandLines) {
    const call = line.slice(line.indexOf("agentus session ")).replace(/[。；].*$/, "").trim();
    const [, , verb] = call.split(/\s+/);
    check(`A "session ${verb}" is a real verb`, verbs.has(verb), `known: ${[...verbs].sort().join(",")}`);
    const used = [...call.matchAll(/(--[a-z-]+)/g)].map((m) => m[1]);
    for (const f of used) check(`A "${f}" is accepted by the CLI`, flags.has(f), `known: ${[...flags].sort().join(",")}`);
  }
  check("A the contract no longer says --help", !OBSERVER_PROMPT_DEFAULT.includes("--help") ||
    /不要跑 --help/.test(OBSERVER_PROMPT_DEFAULT));
  check("A the contract no longer asks for a panorama",
    !/session list/.test(OBSERVER_PROMPT_DEFAULT) || /不要跑 session list/.test(OBSERVER_PROMPT_DEFAULT));
  check("A the contract asks the user's own words first", /--user --tail/.test(OBSERVER_PROMPT_DEFAULT));
  check("A the contract carries the no-repeat rule", /换个说法/.test(OBSERVER_PROMPT_DEFAULT));
}

// ───────────────────────────────────────────────────────────── B. 先过滤，再截尾
{
  const rows: StoredMessage[] = [];
  let seq = 1;
  const push = (kind: StoredMessage["kind"], text: string): void => {
    rows.push({ seq: seq++, sessionId: "s", kind, payload: { content: { text } }, createdAt: seq } as StoredMessage);
  };
  push("user", "把登录页改一下");
  push("agent", "好");
  for (let i = 0; i < 40; i += 1) push(i % 2 ? "tool" : "thought", `row ${i}`);

  const all = tailMessages(rows, 10);
  check("B without a role, the default answer is the tail (unchanged behaviour)", all.rows.length === 10 &&
    all.rows.every((r) => r.kind !== "user"), all.rows.map((r) => r.kind).join(","));

  const users = tailMessages(rows, 3, "user");
  check("B --user --tail 3 finds the user message behind 40 tool rows",
    users.rows.length === 1 && users.rows[0].kind === "user" && users.rows[0].text === "把登录页改一下",
    JSON.stringify(users.rows.map((r) => r.text)));
  check("B meta separates asked / returned / filtered / available",
    users.meta.asked === 3 && users.meta.returned === 1 && users.meta.filtered === 1 && users.meta.available === 42,
    JSON.stringify(users.meta));
  check("B meta names the role it applied", users.meta.role === "user", String(users.meta.role));

  const none = tailMessages(rows, 3, "plan");
  check("B no match is an empty set, not an error", none.rows.length === 0 && none.meta.filtered === 0);

  const cap = tailMessages(rows, 500, "thought");
  check("B the tail is still clamped when a role is given", cap.rows.length === Math.min(20, MESSAGES_TAIL_MAX) &&
    cap.meta.capped === true, `${cap.rows.length}/${MESSAGES_TAIL_MAX}`);
  check("B the role list is the documented one", MESSAGE_ROLES.join(",") === "user,agent,tool,thought,plan",
    MESSAGE_ROLES.join(","));
}

// ───────────────────────────────────────────────────────────── C. 两态触发语 + 同句丢弃
{
  let now = 1_700_000_000_000;
  const events: ServerEvent[] = [];
  const prompts: { id: string; text: string }[] = [];
  let spawned = 0;
  const hub = new ObserverHub({
    home: mkdtempSync(path.join(tmpdir(), "observer-scope-")),
    settings: () => ({ enabled: true, backend: "hermes", systemPrompt: "", throttleSec: 0, intervalSec: 30 }) as never,
    speakOf: () => ({ mode: "brief", intervalSec: 30 }),
    createSession: async () => { spawned += 1; return `obs-${spawned}`; },
    prompt: async (id, text) => { prompts.push({ id, text }); },
    waitReady: async () => {},
    titleOf: () => "会话 A",
    backendOf: () => "hermes" as never,
    onSession: () => true,
    alive: () => true,
    emit: (e) => { events.push(e); },
    now: () => now,
  });
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));
  // Each beat is one interval later: `intervalSec` is the gate the ticker reads, and a frozen clock
  // would mean the second beat is never due.
  const beat = async (): Promise<void> => { now += 30_000; hub.tick(); await settle(); };
  const say = async (text: string): Promise<void> => {
    await hub.onEvent({ t: "message", message: { sessionId: "obs-1", kind: "agent", payload: { content: { text } } } } as never);
    hub.onEvent({ t: "turn-end", sessionId: "obs-1" } as never);
  };
  const spoken = (): string[] => events.filter((e) => e.t === "speak" && (e as { kind?: string }).kind === "brief")
    .map((e) => String((e as { text?: string }).text ?? ""));

  hub.onEvent({ t: "turn-start", sessionId: "A" } as never);
  await beat();                                   // the beat is what spawns the observer and asks
  await say("登录页改到第三步了");
  check("C the first brief goes out", spoken().length === 1, JSON.stringify(spoken()));

  await beat();                                   // the next beat is the one that heartbeats
  const heartbeat = prompts.filter((p) => /已经跑了/.test(p.text)).at(-1)?.text ?? "";
  if (!heartbeat) console.log("    prompts so far:", JSON.stringify(prompts.map((x) => x.text.slice(0, 40))));
  check("C the heartbeat offers the two states", /有新进展就播/.test(heartbeat) && /暂时没有新输出/.test(heartbeat), heartbeat);
  check("C the heartbeat no longer forbids the quiet answer", !/不要回「（没有可播报的进展）」/.test(heartbeat));

  await beat();
  await say("登录页还在跑，暂时没有新输出");
  const twice = spoken().length;
  await beat();
  await say("登录页还在跑，暂时没有新输出。");     // same line, one comma more
  const briefsBeforeDup = hub.debug()[0]?.briefs ?? -1;
  check("C the same sentence is not spoken twice", spoken().length === twice, JSON.stringify(spoken()));
  check("C the duplicate is attributed in the diagnostic", hub.debug()[0]?.skip === "duplicate", String(hub.debug()[0]?.skip));
  check("C a dropped duplicate spends no quota", hub.debug()[0]?.briefs === briefsBeforeDup,
    `briefs=${hub.debug()[0]?.briefs} before=${briefsBeforeDup}`);

  await beat();
  await say("登录页改完，开始跑测试");             // genuinely new
  check("C real news still speaks", spoken().length === twice + 1, JSON.stringify(spoken()));
  check("C and a different STEP is not mistaken for a duplicate",
    (await (async () => { await beat(); await say("测试跑到第四步了"); return spoken().length; })()) === twice + 2,
    JSON.stringify(spoken()));

  await beat();
  await say("登录页还在跑，暂时没有新输出");        // the template again — but the last line was news
  check("C the template after real news is not a duplicate",
    spoken().at(-1)?.includes("暂时没有新输出") === true, JSON.stringify(spoken()));
}

// ───────────────────────────────────────────────────────────── D. 观察员身份是「进程级」的，建与重建都要带
{
  const mgr = fs.readFileSync(path.join(REPO, "packages/server/src/acp/session-manager.ts"), "utf8");
  check("D a system session's child is told it is an observer",
    /if \(opts\.system\) plan\.env = \{ \.\.\.plan\.env, AGENTUS_SESSION_ROLE: "observer" \}/.test(mgr));
  check("D a RESUMED observer is still an observer",
    /if \(row\.system\) plan\.env = \{ \.\.\.plan\.env, AGENTUS_SESSION_ROLE: "observer" \}/.test(mgr));
  check("D the observer session is the one created with system:true",
    /createSession: async \(backend, cwd, title\) =>[\s\S]{0,140}system: true/.test(
      fs.readFileSync(path.join(REPO, "packages/server/src/index.ts"), "utf8")),
  );
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
