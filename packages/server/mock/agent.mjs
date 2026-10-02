// Mock ACP agent for offline development & browser QA.
// Implements just enough of the ACP agent surface (initialize/newSession/prompt/
// cancel/setSessionMode + permission flow) with fake streaming, so the whole
// AgentSlot pipeline can be exercised without a real LLM.
//
// Env switches to simulate edge cases (append `=N` to env vars when spawning):
//   MOCK_TOOL=1        -> prompt triggers a tool_call + requestPermission
//   MOCK_THINK=1       -> emits agent_thought_chunk before the answer
//   MOCK_SLOW_MS=n     -> delay between chunks (default 60)
//   MOCK_SINK=1        -> exit the process mid-turn (crash path for AC5/QA)
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { Readable, Transform, Writable } from "node:stream";

const SLOW = Number(process.env.MOCK_SLOW_MS || 60);
let seq = 0;
const sessions = new Map();

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
];

// ACP carries the session's model list as `models` on newSession/loadSession (the field
// the cockpit renders as its model button). MOCK_MODELS=1 keeps the list small.
const MODELS = [
  { modelId: "mock:fast", name: "Mock Fast", description: "low latency, shallow" },
  { modelId: "mock:deep", name: "Mock Deep", description: "slow, thorough" },
  { modelId: "mock:vision", name: "Mock Vision", description: "accepts images" },
];
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
        sessionCapabilities: { list: {}, cancel: {} },
      },
      authMethods: [{ id: "mock", name: "Mock auth (no-op)" }],
    };
  },

  async newSession({ cwd }) {
    const sessionId = `mock-${++seq}`;
    sessions.set(sessionId, { cwd, cancelled: false, currentModeId: "default", config: {}, used: 0 });
    // Announce slash commands the way a real agent does (available_commands_update),
    // so the cockpit's palette path is exercised without a real backend.
    setTimeout(() => {
      void send(agent._conn, sessionId, {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "help", description: "List available commands" },
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
  async loadSession({ sessionId, cwd }) {
    if (sessions.has(sessionId)) {
      const s = sessions.get(sessionId);
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
    s.config = { ...(s.config || {}), [configId]: value };
    return { configOptions: [{ id: configId, type: "select", currentValue: value }] };
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

    // QA triggers: prompt text flips behaviors per turn (env sets global defaults).
    // Declared up front — used by the blocks below (a hoisting mistake here shows
    // up as an opaque "-32603 Internal error" over ACP, QA#11).
    const wantTool = process.env.MOCK_TOOL === "1" || /\[tool\]/.test(text);
    const wantThink = process.env.MOCK_THINK === "1" || /\[think\]/.test(text);
    const willSink = process.env.MOCK_SINK === "1" || /\[sink\]/.test(text);
    const wantPlan = process.env.MOCK_PLAN === "1" || /\[plan\]/.test(text);
    // per-turn slow mode: long stream so QA can drop the socket mid-turn (AC6)
    const slow = /\[slow\]/.test(text) ? Math.max(SLOW, 900) : SLOW;

    if (wantThink) {
      for (const w of "pondering the user's request very deeply".split(" ")) {
        await send(agent._conn, sessionId, {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: w + " " },
        });
        await sleep(SLOW);
      }
    }

    if (wantTool) {
      const toolCallId = `tc-${sessionId}-${Date.now()}`;
      await send(agent._conn, sessionId, {
        sessionUpdate: "tool_call", toolCallId,
        title: `Write file: ./demo-${Math.floor(Math.random() * 1e4)}.txt`,
        kind: "edit", status: "pending",
        // shaped like a real agent: input args on the call, output on the update
        rawInput: { path: "./demo.txt", content: "hello from the mock agent" },
      });
      const mode = s.currentModeId || "default";
      if (mode !== "dont_ask" && mode !== "accept_edits") {
        const resp = await agent._conn.requestPermission({
          sessionId,
          toolCall: { toolCallId, title: "Write file", kind: "edit" },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "allow_always", name: "Always Allow", kind: "allow_always" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        });
        const chosen = resp?.outcome?.optionId;
        await send(agent._conn, sessionId, {
          sessionUpdate: "tool_call_update", toolCallId,
          status: chosen === "reject" ? "failed" : "completed",
          // the output half of the card (AionUi F-DISPLAY-03 wants it viewable)
          rawOutput: chosen === "reject"
            ? "rejected by the operator — nothing written"
            : `wrote 24 bytes to ./demo.txt (via ${chosen === "allow_always" ? "always-allow" : "one-shot allow"})`,
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
    const effort = s.config?.reasoning_effort || "medium";
    const words = `Mock echo (${effort} effort) to: "${text}". `.repeat(2).split(" ");
    for (const w of words) {
      if (s.cancelled) return { stopReason: "cancelled" };
      if (willSink && w.length > 15) process.exit(7);
      await send(agent._conn, sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: w + " " },
      });
      await sleep(slow);
    }
    // A markdown sample: the cockpit renders replies as markdown (headings, lists,
    // tables, quotes, code with highlighting), so the mock emits all of it — offline QA
    // of the renderer needs no real model.
    await send(agent._conn, sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: MOCK_MARKDOWN },
    });
    // Context gauge data, shaped like a real agent's usage_update (AionUi F-DISPLAY-07).
    s.used = (s.used || 0) + text.length + 120;
    await send(agent._conn, sessionId, {
      sessionUpdate: "usage_update",
      used: s.used,
      size: Number(process.env.MOCK_USAGE_SIZE || 200_000),
    });
    return { stopReason: "end_turn" };
  },
});

// The TS SDK in use routes a fixed method list and does NOT know `session/set_model`
// (ACP's model switch — the Python SDK hermes uses does). The cockpit sends that method
// anyway, so the mock answers it itself: watch for it on stdin, reply, and swallow the
// line instead of handing it to a router that would answer "method not found".
const STDIN_INTERCEPTED = new Set(["session/set_model"]);
const stdinFilter = new Transform({
  transform(chunk, _enc, cb) {
    const out = [];
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { out.push(line); continue; }
      if (msg?.method && STDIN_INTERCEPTED.has(msg.method)) {
        const params = msg.params ?? {};
        const target = sessions.get(params.sessionId);
        const ok = Boolean(target) && MODELS.some((m) => m.modelId === params.modelId);
        if (ok) target.config = { ...(target.config || {}), model: params.modelId };
        const reply = ok
          ? { jsonrpc: "2.0", id: msg.id, result: { models: modelsFor(target.config) } }
          : { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown model: ${params.modelId}` } };
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
