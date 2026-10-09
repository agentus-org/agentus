// Mock ACP agent for offline development & browser QA.
// Implements just enough of the ACP agent surface (initialize/newSession/prompt/
// cancel/setSessionMode + permission flow) with fake streaming, so the whole
// Agentus pipeline can be exercised without a real LLM.
//
// Env switches to simulate edge cases (append `=N` to env vars when spawning):
//   MOCK_TOOL=1        -> prompt triggers a tool_call + requestPermission
//   MOCK_THINK=1       -> emits agent_thought_chunk before the answer
//   MOCK_SLOW_MS=n     -> delay between chunks (default 60)
//   MOCK_SINK=1        -> exit the process mid-turn (crash path for AC5/QA)
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { AgentSideConnection, RequestError, ndJsonStream } from "@agentclientprotocol/sdk";
import { Readable, Transform, Writable } from "node:stream";

const SLOW = Number(process.env.MOCK_SLOW_MS || 60);

// The file a `[tool-diff]` turn pretends to edit: hermes hands the cockpit the whole file
// before and after, so the approval surface has a path and a real change to show.
const MOCK_EDIT = {
  path: "/tmp/mock-approval/demo-edit.txt",
  oldText: "const greeting = \"hello\";\nconsole.log(greeting);\n",
  newText: "const greeting = \"你好\";\nconsole.log(greeting, Date.now());\n",
};
/** A file long enough that reprinting it twice is exactly the "diff 太多了" complaint: 40 lines
 *  of unchanged preamble, three changed ones, 40 unchanged lines after. Hermes' real edit
 *  approval sends the whole file both ways, so the cockpit has to reduce this on its own. */
const MOCK_HERMES_EDIT = await (async () => {
  const preamble = Array.from({ length: 40 }, (_, i) => `// filler line ${i + 1}: unchanged context the operator never needs to read`);
  const tail = Array.from({ length: 40 }, (_, i) => `// tail line ${i + 1}: also unchanged`);
  const head = [...preamble, 'const greeting = "hello";', "console.log(greeting);", ""].join("\n");
  return {
    path: "/tmp/mock-approval/hermes-real-shape.txt",
    oldText: head + tail.join("\n"),
    newText: head.split("\n").map((l) => (l === 'const greeting = "hello";' ? 'const greeting = "你好";' : l))
      .join("\n") + tail.join("\n"),
  };
})();
let seq = 0;
const sessions = new Map();

/**
 * QA hook for the cockpit's plan tool (design-plan-service.md §6-B).
 *
 * The tool is INJECTED through the handshake, and the process that would actually spawn it is the
 * AGENT — hermes does, this mock never does. So an end-to-end test of the write path needs that
 * token from somewhere, and the obvious place (a mock reply) is a transcript row: a credential in
 * the operator's UI. Opt-in instead: name a file in MOCK_PLAN_TOKEN_FILE and it lands there, 0600.
 */
function notePlanTool(mcpServers) {
  const file = process.env.MOCK_PLAN_TOKEN_FILE;
  if (!file || !Array.isArray(mcpServers)) return;
  const tool = mcpServers.find((m) => m?.name === "agentus-plan");
  if (!tool) return;
  const env = Object.fromEntries((tool.env ?? []).map((e) => [e.name, e.value]));
  try {
    fs.writeFileSync(file, JSON.stringify({ ...env, command: tool.command, args: tool.args ?? [] }), { mode: 0o600 });
  } catch (e) {
    process.stderr.write(`[mock-agent] could not write ${file}: ${e.message}\n`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = async (conn, sid, update) => {
  await conn.sessionUpdate({ sessionId: sid, update });
};

// Exercises every branch of the renderer the operators care about.
const MOCK_MARKDOWN = [
  "",
  "### mock markdown sample",
  "",
  "A list, a table and a fence:",
  "",
  "1. first — with `inline code`",
  "2. second — **bold**, *italic*, and a [link](https://example.com/docs)",
  "   - nested bullet",
  "",
  "| knob | effect |",
  "| --- | --- |",
  "| mode | what needs approval |",
  "| depth | how long it thinks |",
  "",
  "> a blockquote, as agents write when they cite something",
  "",
  // A soft break: one newline in the source, one <br> on screen (breaks: true). The
  // cockpit's markdown container must not ALSO preserve the newline character — that is
  // the difference between one line and two, and it is worth a permanent test fixture.
  "A single newline here \u2192",
  "and the next line follows it.",
  "",
  "```ts",
  "// highlighting is only visible if this is colourful",
  "const slot = (x: number) => x * 2;",
  "export type Slot = ReturnType<typeof slot>;",
  "```",
  "",
  "```bash",
  "$ npm run workspace-smoke",
  "```",
  "",
  "<img src=x onerror=\"alert('xss')\" />  <- must stay literal text",
  "<script>alert('xss')</script>  <- likewise",
  "",
].join("\n");

const MODES = [
  { id: "default", name: "Default", description: "Ask before edits" },
  { id: "accept_edits", name: "Accept Edits", description: "Auto-approve file edits" },
  { id: "dont_ask", name: "Yolo", description: "Never ask" },
];

// One shape for "what this session currently runs with", shared by newSession and
// loadSession so a resume re-announces the session's OWN config instead of a default.
const configOptionsFor = (config) => [
  // `category` is ACP's placement hint (the cockpit uses it to give a knob its own
  // button). Real backends may omit it — the UI falls back to the id — but the mock
  // advertises it so the placement path is exercised offline.
  { id: "reasoning_effort", name: "Reasoning Effort", type: "select", category: "thought_level",
    currentValue: config.reasoning_effort || "medium",
    options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }] },
  // The second typed option a real Hermes session advertises (acp_adapter/server.py): the window
  // Hermes budgets its compression against. The cockpit renders it generically in chat settings,
  // and the usage popover points at it instead of pretending its own number configures the model.
  // `_meta.freeform` + a `_`-prefixed category mirror the real adapter: the presets are shortcuts,
  // and a hand-typed window comes back as its own option so `currentValue` stays in the list.
  { id: "context_budget", name: "Context budget", type: "select", category: "_context_window",
    currentValue: config.context_budget || "auto",
    _meta: { freeform: true, unit: "tokens", min: 16384, step: 1024, scope: "model",
      presets: [262144, 524288, 786432, 1048576] },
    options: [{ value: "auto", name: "Auto (model window)" }, { value: "262144", name: "256K" },
      { value: "524288", name: "512K" }, { value: "786432", name: "768K" }, { value: "1048576", name: "1M" }] },
];

// ACP carries the session's model list as `models` on newSession/loadSession (the field
// the cockpit renders as its model button). MOCK_MODELS=1 keeps the list small.
const MODELS = [
  { modelId: "mock:fast", name: "Mock Fast", description: "low latency, shallow" },
  { modelId: "mock:deep", name: "Mock Deep", description: "slow, thorough" },
  { modelId: "mock:vision", name: "Mock Vision", description: "accepts images" },
  // A real agent's list is WIDER than the set it will actually accept — hermes lists every
  // provider/model it knows (live listing ∪ curated ∪ models.dev) and then validates a switch
  // against a narrower pair of sources, so "it is in the picker" does not mean "it can be
  // selected" (track §61: 33 of 503 entries on the live slot were like this, and the refusal
  // was reported as the four words "Invalid params"). `mock:gone` is that fixture, and it is
  // what the cockpit's refusal path (reason shown in place, picker stays open) is tested on.
  { modelId: "mock:gone", name: "Mock Gone", description: "listed, but this agent refuses it" },
];
const REJECTED = new Set(["mock:gone"]);
// The sentence hermes puts in the JSON-RPC error's `data.details` for a refused switch
// (acp_adapter/server.py: RequestError.invalid_params({"details": str(exc)})). Copied verbatim
// so the cockpit is tested against the real shape, not a friendlier one.
const rejectDetails = (modelId) =>
  `Model \`${modelId}\` was not found in this provider's model listing.\n` +
  "  Similar models: `mock:fast`, `mock:deep`";
const modelsFor = (config) => ({
  currentModelId: config.model || "mock:fast",
  availableModels: MODELS,
});

const agent = () => ({
  async initialize() {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        // `fork` was implemented below but never advertised, so a conformant client could
        // not use it. The cockpit's "regenerate the session name from the conversation"
        // feature is such a client — it forks the session, asks the fork to summarise, and
        // throws the fork away. Advertising it makes that path testable offline.
        sessionCapabilities: { list: {}, cancel: {}, fork: {} },
      },
      authMethods: [{ id: "mock", name: "Mock auth (no-op)" }],
    };
  },

  async newSession({ cwd, mcpServers }) {
    const sessionId = `mock-${++seq}`;
    sessions.set(sessionId, { cwd, cancelled: false, currentModeId: "default", config: {}, used: 0, history: [], mcp: mcpServers ?? [] });
    notePlanTool(mcpServers);
    // Announce slash commands the way a real agent does (available_commands_update),
    // so the cockpit's palette path is exercised without a real backend.
    setTimeout(() => {
      void send(agent._conn, sessionId, {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "help", description: "List available commands" },
          // The two context commands Hermes advertises (probed 2026-10-03): the cockpit
          // offers them next to the gauge, and they must be testable without a real agent.
          { name: "context", description: "Show conversation message counts by role" },
          { name: "compress", description: "Compress conversation context" },
          { name: "mock", description: "Mock-only no-op command" },
          { name: "slow", description: "Stream slowly for reconnect drills" },
        ],
      }).catch(() => {});
    }, 30);
    return {
      sessionId,
      modes: { currentModeId: "default", availableModes: MODES },
      configOptions: configOptionsFor({}),
      models: modelsFor({}),
    };
  },

  // A real agent restores its own session state on load (hermes re-reads the persisted
  // reasoning_config). Keep the mock faithful: re-announce the SAME session instead of
  // minting a fresh one, so a resume doesn't silently reset modes/config.
  async loadSession({ sessionId, cwd, mcpServers }) {
    // MOCK_FORGET=1 answers like a REAL agent that has never seen this session: hermes returns an
    // EMPTY load result for an unknown id, and `refusal` on every prompt after (measured with
    // scripts/probe-load-missing.mjs). Without it, the mock's job is the friendly case — "a cold
    // resume works" — so it restores anything. With it, the cockpit's refusal path (a slot that can
    // never come back → 409 → the operator is told, and offered the delete) is testable in CI
    // without a real agent installed.
    if (process.env.MOCK_FORGET === "1" && !sessions.has(sessionId)) return {};
    // A resumed/forked session arrives in a FRESH process whose in-memory map is empty.
    // A real agent reads the transcript from its store, so the id it is asked for is the
    // id it ends up serving — the mock has to do the same, or every later call on that
    // session ("no such session: mock-2") fails for reasons that have nothing to do with
    // the cockpit. Register the id as the parent's stand-in instead of inventing a new one.
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { cwd, cancelled: false, currentModeId: "default", config: {}, used: 0, restored: true, history: [], mcp: mcpServers ?? [] });
      process.stderr.write(`[mock-agent] loadSession ${sessionId} -> restored (not in memory)\n`);
    }
    if (sessions.has(sessionId)) {
      const s = sessions.get(sessionId);
      s.mcp = mcpServers ?? s.mcp ?? [];
      notePlanTool(mcpServers);
      // ── MOCK_REPLAY=1: the REAL replay shape ────────────────────────────────────────────────
      // Hermes re-sends its whole transcript on `session/load`: complete blocks (not chunks), and
      // the reasoning ones carry NO messageId — so the cockpit cannot fold them by identity, and a
      // store that appends them grows a row per block and stamps them all with the resume's clock.
      // That is the shape measured on live on 2026-10-08 (1240 rows from one restart, every session
      // pushed to 「刚刚」), so the mock has to be able to produce it for the rule to be testable.
      if (process.env.MOCK_REPLAY === "1") {
        const n = Math.max(1, Number(process.env.MOCK_REPLAY_BLOCKS || 4) || 4);
        // Say it out loud: "the replay never ran" and "the replay was dropped" look identical from
        // the outside, and only one of them is a passing test.
        process.stderr.write(`[mock-agent] replaying ${n} blocks onto ${sessionId} (session/load)\n`);
        for (let i = 0; i < n; i++) {
          await send(agent._conn, sessionId, {
            sessionUpdate: "agent_thought_chunk",
            content: {
              type: "text",
              text: `replayed thought ${i}: `
                + "the agent restating its own reasoning at full length on a re-attach, with no id "
                + "to fold it by. ".repeat(3),
            },
          });
          await send(agent._conn, sessionId, {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `replayed answer ${i}: ` + "the agent restating its own answer at full length. ".repeat(4),
            },
          });
        }
      }
      return {
        sessionId,
        modes: { currentModeId: s.currentModeId || "default", availableModes: MODES },
        configOptions: configOptionsFor(s.config || {}),
        models: modelsFor(s.config || {}),
      };
    }
    return this.newSession({ cwd });
  },

  /** ACP's model switch: `session/set_model` (the SDK in use does not type it, the wire
   *  still routes it here). */
  async setSessionModel({ sessionId, modelId }) {
    const s = sessions.get(sessionId);
    if (!s) throw new Error("no such session");
    if (REJECTED.has(modelId)) throw RequestError.invalidParams({ details: rejectDetails(modelId) });
    if (!MODELS.some((m) => m.modelId === modelId)) throw new Error(`unknown model: ${modelId}`);
    s.config = { ...(s.config || {}), model: modelId };
    return { models: modelsFor(s.config) };
  },

  async setSessionMode({ sessionId, modeId }) {
    if (!sessions.has(sessionId)) throw new Error("no such session");
    const s = sessions.get(sessionId);
    s.currentModeId = modeId;
    return {};
  },

  async setSessionConfigOption({ sessionId, configId, value }) {
    if (!sessions.has(sessionId)) throw new Error("no such session");
    const s = sessions.get(sessionId);
    // Shape for shape with the real adapter: the response carries the session's WHOLE rebuilt
    // option list (not just the one that changed), and a value the option does not offer comes
    // back with the OLD currentValue instead of being snapped to something else. The cockpit
    // reads that list back as the truth, so a partial reply here would erase the surface.
    const options = configOptionsFor(s.config || {});
    const target = options.find((o) => o.id === configId);
    const supported = (target?.options || []).map((o) => o.value);
    // Free-form options (`_meta.freeform`) accept anything inside their floor; for the rest an
    // unlisted value comes back with the old currentValue, shape for shape with the real adapter.
    const freeform = target?._meta?.freeform === true;
    if (freeform) {
      const n = Number(String(value).replace(/[^0-9]/g, ""));
      if (!(n > 0) || (typeof target._meta.min === "number" && n < target._meta.min)) {
        return { configOptions: options };
      }
    } else if (supported.length && !supported.includes(String(value))) {
      return { configOptions: options };
    }
    s.config = { ...(s.config || {}), [configId]: value };
    // A hand-typed window must show up as an option, or the returned list contradicts itself.
    const rebuilt = configOptionsFor(s.config || {});
    const opt = rebuilt.find((o) => o.id === configId);
    if (freeform && opt && !opt.options.some((o) => o.value === String(opt.currentValue))) {
      opt.options = [...opt.options, { value: String(opt.currentValue), name: `${opt.currentValue} (custom)` }];
    }
    return { configOptions: rebuilt };
  },

  async cancel({ sessionId }) {
    const s = sessions.get(sessionId);
    if (s) s.cancelled = true;
  },

  async prompt({ sessionId, prompt }) {
    const s = sessions.get(sessionId);
    if (!s) throw new Error("no such session");
    s.cancelled = false;
    const text = prompt.map((p) => p.text || "").join(" ");

    // QA: report the SHAPE of what arrived, not just its text. A client may attach STRUCTURED
    // blocks — the cockpit hands a resumed agent the session's plan as an ACP `resource` — and the
    // difference between "the operator typed this" and "the client attached this" is exactly what a
    // test needs to see. `text` above only reads `.text`, so a resource block is otherwise invisible
    // to this mock (measured 2026-10-08: the plan hand-over could not be verified at all).
    if (process.env.MOCK_BLOCKS === "1" || /\[blocks\]/.test(text)) {
      const shape = prompt.map((p) => ({
        type: p.type ?? "?",
        resourceUri: p.resource?.uri ?? null,
        // the attached text itself, so a test can assert WHICH plan was handed over
        body: (p.resource?.text || p.text || "").slice(0, 600),
        meta: p._meta ?? null,
      }));
      await send(agent._conn, sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "BLOCKS " + JSON.stringify(shape) },
      });
      return { stopReason: "end_turn" };
    }

    // QA: what did the HANDSHAKE carry? The plan tool is injected per session, and its whole
    // promise (§4) is that it exists HERE and nowhere else — so the declaration's shape is what a
    // test asserts. Deliberately no env VALUES: that is where the per-session token lives.
    if (/\[mcp\]/.test(text)) {
      const shape = (s.mcp ?? []).map((m) => ({
        name: m.name ?? null,
        command: String(m.command ?? "").split("/").pop() ?? null,
        args: (m.args ?? []).map((a) => String(a).split("/").pop()),
        envNames: (m.env ?? []).map((e) => e.name),
      }));
      await send(agent._conn, sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "MCP " + JSON.stringify(shape) },
      });
      return { stopReason: "end_turn" };
    }

    // A title request (the cockpit's 重新生成) is answered from what this session already
    // knows. On a FORK that is the parent's copied transcript, so the count is the proof the
    // copy arrived; a session with no parent cannot be a title fork at all.
    const inherited = (s.history || []).length;
    s.history = [...(s.history || []), text];
    if (/会话标题/.test(text)) {
      // A real model needs a moment; the delay is deliberate so a client's "working…" state
      // is observable in a test instead of flashing past.
      await sleep(Number(process.env.MOCK_TITLE_MS || 1200));
      const answer = s.parent
        ? `继承 ${inherited} 轮上下文的标题`
        : `没有父会话可继承的标题`;
      await send(agent._conn, sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: answer },
      });
      return { stopReason: "end_turn" };
    }

    // QA triggers: prompt text flips behaviors per turn (env sets global defaults).
    // Declared up front — used by the blocks below (a hoisting mistake here shows
    // up as an opaque "-32603 Internal error" over ACP, QA#11).
    const wantTool = process.env.MOCK_TOOL === "1" || /\[tool\]/.test(text) || /\[tool-diff\]/.test(text) || /\[tool-hermes\]/.test(text);
    // A file EDIT, shaped like the real one: hermes' edit approval carries the whole file
    // before and after as a `diff` content item (`acp.tool_diff_content`), and the cockpit's
    // approval surface must be able to say WHICH file and WHAT changes from that alone.
    const wantDiff = process.env.MOCK_DIFF === "1" || /\[tool-diff\]/.test(text);
    // Hermes' REAL edit approval, shape for shape: two options only (`allow_once` "Allow edit"
    // and `deny` "Deny"), toolCall title `Approve edit: <path>`, and the whole file before and
    // after as one `diff` item — which is why the cockpit must collapse it (read off
    // acp_adapter/edit_approval.py, 2026-10-06).
    const wantHermes = process.env.MOCK_HERMES_APPROVAL === "1" || /\[tool-hermes\]/.test(text);
    const wantThink = process.env.MOCK_THINK === "1" || /\[think(:\d+)?\]/.test(text);
    const willSink = process.env.MOCK_SINK === "1" || /\[sink\]/.test(text);
    const wantPlan = process.env.MOCK_PLAN === "1" || /\[plan\]/.test(text);
    // per-turn slow mode: long stream so QA can drop the socket mid-turn (AC6)
    const slow = /\[slow\]/.test(text) ? Math.max(SLOW, 900) : SLOW;

    // `[table]` — a table fixture for the sorting / full-screen sweep (scripts/qa/table-sweep.mjs).
    // Numeric AND text cells, deliberately NOT in any sorted order, and a local file link plus a
    // relative image, so "clicking a header reorders the rows" and "a relative path resolves" are
    // measurable claims instead of a screenshot someone has to squint at. The directory is
    // overridable because the sweep creates its own fixtures.
    if (/\[table\]/.test(text)) {
      const dir = process.env.MOCK_TABLE_DIR || "/tmp/agentus-qa-files";
      const rows = [
        ["zeta", "10", "1.2 MB"],
        ["alpha", "9", "900 kB"],
        ["mu", "100", "12 MB"],
        ["beta", "2", "3 kB"],
        ["kappa", "33", "44 kB"],
        ["gamma", "7", "8 kB"],
      ];
      const reply = [
        "### table fixture",
        "",
        "| name | count | size |",
        "| --- | --- | --- |",
        ...rows.map((r) => `| ${r.join(" | ")} |`),
        "",
        `a local file: [note.md](file://${dir}/note.md#L2) and a bare ${dir}/app.py:2`,
        "",
        "![shot](shot.png)",
        "",
      ].join("\n");
      await send(agent._conn, sessionId, {
        sessionUpdate: "agent_message_chunk",
        messageId: randomUUID(),
        content: { type: "text", text: reply },
      });
      return { stopReason: "end_turn" };
    }

    if (wantThink) {
      // ONE `messageId` per burst, like the real adapter sends: ACP gives every chunk of one
      // thought block the same id, and the cockpit/server coalesce on it (`block_key`). A mock
      // that omits it makes each chunk its own row — a transcript shape that only exists in QA
      // (measured 2026-10-06: 1336 rows in the DB for a 10-burst turn).
      const thinkId = `th-${sessionId}-${Date.now()}`;
      // `[think:N]` streams N words instead of the default sentence: the long-thinking case (the
      // operator's 「思考卡住不动、然后突然全刷出来」) needs a stream long enough that the reader can
      // SEE whether it arrives progressively or in one lump.
      const asked = /\[think:(\d+)\]/.exec(text);
      const words = asked
        ? Array.from({ length: Number(asked[1]) }, (_, i) => `思考片段${i}`)
        : "pondering the user's request very deeply".split(" ");
      for (const w of words) {
        await send(agent._conn, sessionId, {
          sessionUpdate: "agent_thought_chunk",
          messageId: thinkId,
          content: { type: "text", text: w + " " },
        });
        await sleep(SLOW);
      }
    }

    // A turn that does real work: N tool calls with a reasoning burst before each — the
    // transcript-flood case (ten calls + ten bursts). `[tools:10]` drives it with no permission
    // prompts: the point is the SHAPE of the transcript, not the approval.
    const many = /\[tools:(\d+)\]/.exec(text);
    if (many) {
      const n = Math.min(20, Math.max(1, Number(many[1]) || 1));
      for (let i = 1; i <= n; i++) {
        const burst = (`step ${i}: reading the file, checking the surrounding code, then writing `
          + "the change back. This sentence is deliberately long so the reasoning block is taller "
          + "than the small window the cockpit draws for it, which is what makes the scrolling "
          + "behaviour measurable at all. ").repeat(3);
        const thinkId = `th-${sessionId}-multi-${i}`;
        for (const word of burst.split(" ")) {
          await send(agent._conn, sessionId, {
            sessionUpdate: "agent_thought_chunk",
            messageId: thinkId,
            content: { type: "text", text: word + " " },
          });
          await sleep(10);
        }
        const id = `tc-${sessionId}-multi-${i}`;
        await send(agent._conn, sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: id,
          title: i % 3 === 0 ? `bash: run the suite (step ${i})` : i % 2 === 0 ? `read_file src/app-${i}.ts` : `grep -n TODO src/ (step ${i})`,
          kind: i % 3 === 0 ? "execute" : "read",
          status: "in_progress",
          rawInput: { step: i },
        });
        await sleep(25);
        await send(agent._conn, sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          status: "completed",
          rawOutput: `step ${i} done (${i * 7} bytes)`,
        });
      }
    }

    if (wantTool) {
      const toolCallId = `tc-${sessionId}-${Date.now()}`;
      const edit = wantHermes ? MOCK_HERMES_EDIT : MOCK_EDIT;
      const withDiff = wantDiff || wantHermes;
      const diffContent = withDiff
        ? [{
            type: "diff", path: edit.path, oldText: edit.oldText, newText: edit.newText,
          }]
        : undefined;
      await send(agent._conn, sessionId, {
        sessionUpdate: "tool_call", toolCallId,
        title: withDiff ? `Edit file: ${edit.path}` : `Write file: ./demo-${Math.floor(Math.random() * 1e4)}.txt`,
        kind: "edit", status: "pending",
        // shaped like a real agent: input args on the call, output on the update
        ...(diffContent ? { content: diffContent } : {}),
        rawInput: withDiff
          ? { tool: "patch", arguments: { path: edit.path } }
          : { path: "./demo.txt", content: "hello from the mock agent" },
      });
      const mode = s.currentModeId || "default";
      if (mode !== "dont_ask" && mode !== "accept_edits") {
        const resp = await agent._conn.requestPermission({
          sessionId,
          toolCall: {
            toolCallId,
            title: wantHermes ? `Approve edit: ${edit.path}` : withDiff ? `Approve edit: ${edit.path}` : "Write file",
            kind: "edit",
            ...(diffContent ? { content: diffContent } : {}),
          },
          options: wantHermes
            ? [
                { optionId: "allow_once", name: "Allow edit", kind: "allow_once" },
                { optionId: "deny", name: "Deny", kind: "reject_once" },
              ]
            : [
                { optionId: "allow", name: "Allow", kind: "allow_once" },
                { optionId: "allow_always", name: "Always Allow", kind: "allow_always" },
                { optionId: "reject", name: "Reject", kind: "reject_once" },
              ],
        });
        const chosen = resp?.outcome?.optionId;
        await send(agent._conn, sessionId, {
          sessionUpdate: "tool_call_update", toolCallId,
          status: chosen === "reject" || chosen === "deny" ? "failed" : "completed",
          // the output half of the card (AionUi F-DISPLAY-03 wants it viewable)
          rawOutput: chosen === "reject" || chosen === "deny"
            ? "rejected by the operator — nothing written"
            : `wrote 24 bytes to ./demo.txt (chosen option: ${chosen})`,
        });
      }
    }

    if (wantPlan) {
      // ACP requires content+priority+status on every PlanEntry: @agentclientprotocol/sdk
      // silently DROPS entries that fail validation (spec-conformant, but hostile — the
      // operator would just see a shorter plan). Always send all three.
      await send(agent._conn, sessionId, {
        sessionUpdate: "plan",
        entries: [
          { content: "read the failing test", status: "completed", priority: "medium" },
          { content: "patch the flaky timing assert", status: "in_progress", priority: "high" },
          { content: "run full suite", status: "pending", priority: "medium" },
        ],
      });
    }
    if (process.env.MOCK_PLAN_V2 === "1" || /\[planv2\]/.test(text)) {
      // ACP v2's `plan_update` (draft): one level deeper than v1, plus the `planId` the v2 schema
      // adds. NOTE: v2 documents an extra `cancelled` status, but THIS SDK revision's
      // PlanEntryStatus is still pending|in_progress|completed and its validator silently DROPS an
      // entry that fails it (the same trap the v1 block above warns about) — so a status the schema
      // does not know cannot be put on this wire from here. The ingest's tolerance of unknown
      // statuses is covered where it can be: scripts/qa/plan-v2-sweep.mts, at the unit level.
      await send(agent._conn, sessionId, {
        sessionUpdate: "plan_update",
        plan: {
          planId: "main",
          type: "items",
          entries: [
            { content: "v2 read the failing test", status: "completed", priority: "medium" },
            { content: "v2 patch the flaky timing assert", status: "pending", priority: "high" },
            { content: "v2 run full suite", status: "in_progress", priority: "medium" },
          ],
        },
      });
    }
    const effort = s.config?.reasoning_effort || "medium";
    // One id per logical message, exactly like the real backend: the cockpit (and the store) fold the
    // chunks of a message by this id, so a mock that omits it would test a path nobody runs.
    const messageId = randomUUID();
    const words = `Mock echo (${effort} effort) to: "${text}". `.repeat(2).split(" ");
    for (const w of words) {
      if (s.cancelled) return { stopReason: "cancelled" };
      if (willSink && w.length > 15) process.exit(7);
      await send(agent._conn, sessionId, {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text: w + " " },
      });
      await sleep(slow);
    }
    // A markdown sample: the cockpit renders replies as markdown (headings, lists,
    // tables, quotes, code with highlighting), so the mock emits all of it — offline QA
    // of the renderer needs no real model.
    await send(agent._conn, sessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId,
      content: { type: "text", text: MOCK_MARKDOWN },
    });
    // Context gauge data, shaped like a real agent's usage_update (AionUi F-DISPLAY-07).
    // `/compress` is the agent's own command for this: honour it by actually lowering the
    // reported context, so "the button did something" is a measurable claim.
    const compress = /^\/compress\b/.test(text.trim());
    s.used = compress ? Math.ceil((s.used || 4000) / 5) : (s.used || 0) + text.length + 120;
    // The reported window follows a picked context_budget, like the real adapter (whose
    // `usage_update.size` IS the window it compresses against) — otherwise a cockpit that
    // switches its window would look like nothing happened.
    const picked = Number((s.config || {}).context_budget);
    await send(agent._conn, sessionId, {
      sessionUpdate: "usage_update",
      used: s.used,
      size: picked > 0 ? picked : Number(process.env.MOCK_USAGE_SIZE || 200_000),
    });
    return { stopReason: "end_turn" };
  },
});

// The TS SDK in use routes a fixed method list and does NOT know `session/set_model`
// (ACP's model switch — the Python SDK hermes uses does). The cockpit sends that method
// anyway, so the mock answers it itself: watch for it on stdin, reply, and swallow the
// line instead of handing it to a router that would answer "method not found".
const STDIN_INTERCEPTED = new Set(["session/set_model", "session/fork"]);
const stdinFilter = new Transform({
  transform(chunk, _enc, cb) {
    const out = [];
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { out.push(line); continue; }
      if (msg?.method === "session/fork") {
        // ACP fork: a new session seeded with the parent's transcript (the deep copy a
        // real agent does server-side; the mock only needs the observable shape).
        const params = msg.params ?? {};
        const parent = sessions.get(params.sessionId);
        if (!parent) {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `no such session: ${params.sessionId}` } }) + "\n");
          continue;
        }
        const forkId = `mock-${++seq}`;
        sessions.set(forkId, { ...parent, parent: params.sessionId, currentModeId: parent.currentModeId, config: { ...(parent.config || {}) } });
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
          sessionId: forkId,
          modes: { currentModeId: parent.currentModeId || "default", availableModes: MODES },
          configOptions: configOptionsFor(parent.config || {}),
          models: modelsFor(parent.config || {}),
        } }) + "\n");
        process.stderr.write(`[mock-agent] session/fork ${params.sessionId} -> ${forkId}\n`);
        continue; // never forwarded: this SDK version does not route the method
      }
      if (msg?.method && STDIN_INTERCEPTED.has(msg.method)) {
        const params = msg.params ?? {};
        const target = sessions.get(params.sessionId);
        const gone = REJECTED.has(params.modelId);
        const ok = Boolean(target) && !gone && MODELS.some((m) => m.modelId === params.modelId);
        if (ok) target.config = { ...(target.config || {}), model: params.modelId };
        // A refusal carries the reason in `data.details`, exactly like hermes does — the
        // cockpit must be able to show the sentence, not just the protocol title.
        const reply = ok
          ? { jsonrpc: "2.0", id: msg.id, result: { models: modelsFor(target.config) } }
          : {
              jsonrpc: "2.0", id: msg.id,
              error: {
                code: -32602, message: "Invalid params",
                data: { details: gone ? rejectDetails(params.modelId) : `unknown model: ${params.modelId}` },
              },
            };
        process.stdout.write(JSON.stringify(reply) + "\n");
        process.stderr.write(`[mock-agent] ${msg.method} -> ${ok ? "ok" : "rejected"} (${params.modelId})\n`);
        continue; // never forwarded: the SDK would 404 it
      }
      out.push(line);
    }
    cb(null, out.length ? out.join("\n") + "\n" : "");
  },
});

const conn = new AgentSideConnection((c) => {
  const a = agent();
  a._conn = c;
  agent._conn = c;
  return a;
}, ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin.pipe(stdinFilter))));
void conn;
process.stderr.write("[mock-agent] ready on stdio\n");
