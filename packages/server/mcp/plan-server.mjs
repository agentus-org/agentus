#!/usr/bin/env node
/**
 * `agentus-plan` — the cockpit's plan tool, as a stdio MCP server.
 *
 * WHY THIS EXISTS
 * The cockpit owns a session's plan (design-plan-service.md §2-3) and an agent's own todo list
 * dies with its process. So the plan the card renders is the cockpit's OBJECT, and this tool is
 * how the agent keeps it current: every backend is handed it at handshake time (a row can still
 * opt back into rendering its own ACP frames — `nativePlanSource: "acp"`). An agent needs **zero
 * adapter code**: it just has to speak MCP.
 *
 * HOW IT IS REACHED (and why that is safe)
 * Nothing registers this server in an agent's own config. The cockpit only ever hands it over as
 * part of the ACP handshake (`session/new` / `session/load` / `session/resume` → `mcpServers`),
 * which is a per-session parameter, so an agent started any other way (CLI, cron, Studio) does
 * not have it — see design-plan-service.md §4. The same handshake carries the three variables
 * below, including a token minted for THAT ONE session: even someone who copies the command out
 * of `ps` can only write the plan of the session the token was minted for.
 *
 * PROTOCOL NOTES
 * Transport is newline-delimited JSON-RPC 2.0 (what the MCP stdio transport mandates). stdout
 * carries protocol frames ONLY — anything printed there that is not a JSON-RPC message breaks the
 * client, so all diagnostics go to stderr.
 */

const ENDPOINT = (process.env.AGENTUS_PLAN_ENDPOINT ?? "").replace(/\/+$/, "");
const TOKEN = process.env.AGENTUS_PLAN_TOKEN ?? "";
const SESSION = process.env.AGENTUS_PLAN_SESSION ?? "";

/** MCP revision this server implements. Cheap to keep current: we only use tools/*. */
const PROTOCOL_VERSION = "2024-11-05";

const STATUSES = ["pending", "in_progress", "completed", "cancelled"];

const TOOLS = [
  {
    name: "update_plan",
    description:
      "Publish this session's plan — the step list the operator watches in the Agentus cockpit, one " +
      "progress dot per step. PREFER THIS over any checklist/todo tool of your own: this list is the " +
      "one the cockpit DISPLAYS, and it survives your restarts, while a built-in task list dies with " +
      "your process (the cockpit does not read it and will not show it). Call it when you START a " +
      "multi-step task, and again each time a step's status changes — a plan that is not updated is a " +
      "plan that lies. `items` is the WHOLE list as it stands now (a snapshot, not a delta): include " +
      "every step, finished or not, in order. Statuses: pending, in_progress (at most one at a time), " +
      "completed, cancelled.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "The full plan, in order. Replaces the previous list.",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "What the step is, in the operator's language." },
              status: { type: "string", enum: STATUSES, description: "Where this step stands now." },
              priority: { type: "string", enum: ["high", "medium", "low"], description: "Optional." },
            },
            required: ["content", "status"],
          },
        },
        explanation: {
          type: "string",
          description:
            "Optional one-line remark shown under the list: why the plan changed, or how far the " +
            "scope reaches. Max 1000 characters.",
        },
      },
      required: ["items"],
    },
  },
  {
    name: "read_plan",
    description:
      "Read the plan the cockpit currently holds for this session. Use it after a restart, or when " +
      "the operator asks what is still outstanding, instead of trusting your own memory of it.",
    inputSchema: { type: "object", properties: {} },
  },
];

/** POST one operation to the cockpit, which owns the plan object. */
async function callCockpit(op, payload) {
  if (!ENDPOINT || !TOKEN) {
    throw new Error(
      "this plan tool was started without AGENTUS_PLAN_ENDPOINT/AGENTUS_PLAN_TOKEN — it only works " +
        "inside an Agentus session; keep your own todo list instead",
    );
  }
  const res = await fetch(`${ENDPOINT}/api/plan/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agentus-plan-token": TOKEN },
    body: JSON.stringify({ session: SESSION, op, ...payload }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `the cockpit answered HTTP ${res.status}`);
  return body;
}

/** Render the plan for the agent: compact, and honest about what is not there. */
function renderPlan(plan) {
  if (!plan || !Array.isArray(plan.items) || plan.items.length === 0) {
    return "This session has no plan yet. Publish one with update_plan when the work has steps.";
  }
  const lines = plan.items.map((i) => `- [${i.status}] ${i.content}`);
  const head = `Plan (revision ${plan.revision ?? 0}${plan.source ? `, source ${plan.source}` : ""}${plan.terminal ? `, ${plan.terminal}` : ""}):`;
  return [head, ...lines, plan.explanation ? `\nRemark: ${plan.explanation}` : ""].filter(Boolean).join("\n");
}

async function callTool(name, args) {
  if (name === "read_plan") {
    const body = await callCockpit("read", {});
    return renderPlan(body?.plan);
  }
  if (name === "update_plan") {
    const items = Array.isArray(args?.items) ? args.items : null;
    if (!items) throw new Error("`items` must be an array of steps");
    const body = await callCockpit("update", {
      items,
      ...(args?.explanation !== undefined ? { explanation: args.explanation } : {}),
    });
    const plan = body?.plan;
    const done = plan?.items?.filter((i) => i.status === "completed").length ?? 0;
    const total = plan?.items?.length ?? 0;
    // Say something the model can act on, including the case where the cockpit IGNORED the write:
    // a session already fed by native ACP frames has one writer, and this tool is not it. Silently
    // succeeding there would leave the model believing it owns a list it does not.
    if (body?.accepted === false) {
      return `${body.reason ?? "ignored: this session's plan comes from the agent's own frames"}. The plan on screen is unchanged (${done}/${total} done).`;
    }
    return `Plan saved (${done}/${total} done${plan?.explanation ? `; remark kept` : ""}). It survives your restarts.`;
  }
  throw new Error(`unknown tool: ${name}`);
}

// ---- the stdio loop -----------------------------------------------------------------------

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  // Notifications carry no id and must never be answered.
  const isNotification = id === undefined || id === null;
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "agentus-plan", version: "1.0.0" },
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = String(params?.name ?? "");
      try {
        const text = await callTool(name, params?.arguments ?? {});
        reply(id, { content: [{ type: "text", text }] });
      } catch (e) {
        // isError (not a JSON-RPC error): the model should see the failure as tool output and
        // react — retrying a transport failure as if it were a protocol error helps nobody.
        reply(id, {
          content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
          isError: true,
        });
      }
      return;
    }
    default:
      if (!isNotification) replyError(id, -32601, `method not found: ${String(method)}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const nl = buffer.indexOf("\n");
    if (nl < 0) break;
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stderr.write(`agentus-plan: ignoring a line that is not JSON\n`);
      continue;
    }
    handle(msg).catch((e) => {
      process.stderr.write(`agentus-plan: ${e instanceof Error ? e.message : String(e)}\n`);
      if (msg?.id !== undefined && msg?.id !== null) replyError(msg.id, -32603, "internal error");
    });
  }
});
process.stdin.on("end", () => process.exit(0));
process.stderr.write(
  `agentus-plan ready (session ${SESSION || "?"}, endpoint ${ENDPOINT || "unset"})\n`,
);
