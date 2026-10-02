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
import { Readable, Writable } from "node:stream";

const SLOW = Number(process.env.MOCK_SLOW_MS || 60);
let seq = 0;
const sessions = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = async (conn, sid, update) => {
  await conn.sessionUpdate({ sessionId: sid, update });
};

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
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default", description: "Ask before edits" },
          { id: "accept_edits", name: "Accept Edits", description: "Auto-approve file edits" },
          { id: "dont_ask", name: "Yolo", description: "Never ask" },
        ],
      },
      configOptions: [
        { id: "reasoning_effort", name: "Reasoning Effort", type: "select",
          currentValue: "medium",
          options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }] },
      ],
    };
  },

  async loadSession(params) { return this.newSession(params); },

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
        });
      }
    }

    if (wantPlan) {
      await send(agent._conn, sessionId, {
        sessionUpdate: "plan",
        entries: [
          { content: "read the failing test", status: "completed" },
          { content: "patch the flaky timing assert", status: "in_progress", priority: "high" },
          { content: "run full suite", status: "pending" },
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
    // A code block to stress markdown rendering.
    await send(agent._conn, sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "\n```ts\nconst slot = (x: number) => x * 2;\n```\n" },
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

const conn = new AgentSideConnection((c) => {
  const a = agent();
  a._conn = c;
  agent._conn = c;
  return a;
}, ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
void conn;
process.stderr.write("[mock-agent] ready on stdio\n");
