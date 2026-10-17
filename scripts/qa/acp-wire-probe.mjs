// Does the agent's STATUS line actually reach us? Probe the ACP wire itself.
//
// Issue #18's carrier is an empty `agent_thought_chunk` whose sentence rides in `_meta.hermes`
// (hermes `acp_adapter/events.py:make_status_cb`). The cockpit half of that contract is only as good
// as the wire: if `_meta` is dropped on the way out (SDK serialisation) the frame arrives as a plain
// empty thought, which the server then persists — the operator sees 「思考 0 字」 and the Hindsight
// recall line never appears. So this probe talks raw JSON-RPC to `hermes acp`, prints every
// `session/update` thought frame verbatim, and says whether `_meta.hermes` survived.
//
//   node scripts/qa/acp-wire-probe.mjs            # one tiny turn against the real agent
//   ACP_PROBE_PROMPT='你好' node scripts/qa/acp-wire-probe.mjs
import { spawn } from "node:child_process";
import readline from "node:readline";

const PROMPT = process.env.ACP_PROBE_PROMPT ?? "你好";
const AGENT = process.env.ACP_PROBE_AGENT ?? "hermes";
const ARGS = (process.env.ACP_PROBE_ARGS ?? "acp").split(/\s+/).filter(Boolean);

const child = spawn(AGENT, ARGS, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
const rl = readline.createInterface({ input: child.stdout });
let nextId = 1;
const pending = new Map();
const thoughts = [];
const statuses = [];
let stderr = "";
child.stderr.on("data", (b) => { stderr += String(b); });

const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });

rl.on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id != null && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    return;
  }
  // a request FROM the agent (permissions, fs): answer with a refusal-shaped default so the turn
  // keeps going without touching anything
  if (m.method && m.id != null) {
    const refused = m.method === "session/request_permission"
      ? { outcome: { outcome: "cancelled" } }
      : { content: [] };
    send({ jsonrpc: "2.0", id: m.id, result: refused });
    return;
  }
  if (m.method === "session/update") {
    const u = m.params?.update ?? {};
    if (u.sessionUpdate === "agent_thought_chunk") {
      const text = u.content?.text ?? "";
      const meta = u._meta ?? null;
      thoughts.push({ text, meta });
      if (text === "" && !meta) {
        console.log(`  EMPTY thought, NO _meta  ${JSON.stringify(u)}`);
      } else if (meta?.hermes) {
        statuses.push(meta.hermes);
        console.log(`  status via _meta  kind=${meta.hermes.statusKind} text=${JSON.stringify(meta.hermes.text)}`);
      } else if (text) {
        console.log(`  thinking (${text.length} chars) ${JSON.stringify(text.slice(0, 60))}`);
      }
    }
  }
});

const main = async () => {
  const init = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  });
  console.log(`agent: ${init?.agentInfo?.name ?? "?"} ${init?.agentInfo?.version ?? ""}`);
  const session = await request("session/new", { cwd: process.cwd(), mcpServers: [] });
  const sid = session?.sessionId;
  console.log(`session ${sid}\n--- prompt: ${PROMPT} ---`);
  const res = await request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: PROMPT }] });
  console.log(`turn done: ${JSON.stringify(res)}`);

  const empty = thoughts.filter((t) => !t.text);
  const withMeta = thoughts.filter((t) => t.meta?.hermes);
  console.log(`\n${thoughts.length} thought frames · ${empty.length} empty · ${withMeta.length} carrying _meta.hermes`);
  const verdict = withMeta.length > 0
    ? "OK — the status carrier survives the wire; a status line must show in the cockpit"
    : empty.length > 0
      ? "BROKEN — empty thought frames are arriving with NO _meta: the sentence is being lost before us"
      : "no empty frames this turn (nothing to judge; try a prompt that triggers recall)";
  console.log(`VERDICT: ${verdict}`);
  if (stderr.trim()) console.log(`\n--- agent stderr (tail) ---\n${stderr.trim().split("\n").slice(-8).join("\n")}`);
  child.kill("SIGTERM");
  process.exit(withMeta.length > 0 ? 0 : 2);
};

main().catch((e) => {
  console.error("probe failed:", e.message);
  if (stderr.trim()) console.error(stderr.trim().split("\n").slice(-12).join("\n"));
  child.kill("SIGKILL");
  process.exit(1);
});
