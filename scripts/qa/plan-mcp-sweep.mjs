// QA: the `agentus-plan` MCP channel (P1) — the way an agent that does NOT emit ACP plan frames
// gets plan cards without a line of its own code.
//
//   node scripts/qa/plan-mcp-sweep.mjs
//
// What it proves, and why each part is here:
//   1. the capability bit GATES injection. The mock row is `nativePlanSource: none`, so its handshake
//      carries `agentus-plan`; flipped to `acp`, a new session's handshake carries nothing. That gate
//      is the whole reason Hermes — which emits frames itself — never gets a second writable list.
//   2. the injected env works END TO END. The first half is a real `plan-server.mjs` child speaking
//      MCP over stdio (initialize → tools/list → tools/call), the second half is the cockpit's plan
//      object: an `update_plan` writes it, `read_plan` reads it back.
//   3. ONE WRITER. Once the session has seen a native frame, the tool is refused rather than merged
//      (two writers = two plans racing on one card).
//   4. an EMPTY list is not a clear — it is refused by name, and the plan on screen survives.
//   5. the child exits when its stdin closes, which is what stops a cockpit that opens and closes
//      slots all day from accumulating one orphaned MCP process per session.
//
// Only the mock backend is used: no tokens are spent. The mock writes the handshake's plan token to
// the file named by MOCK_PLAN_TOKEN_FILE (its own opt-in QA hook) because a token printed into a
// transcript would be a credential in the operator's UI.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.BASE ?? "http://127.0.0.1:8901";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Which data dir belongs to the instance under test? By EVIDENCE, not by env: an inherited
// AGENTUS_DATA (a shell that has pointed at another tree all along) must not hand this sweep the
// wrong cockpit's token — the symptom is a confusing wall of "unauthorized" (measured 2026-10-08).
const DATA = await (async () => {
  const candidates = [...new Set([process.env.AGENTUS_DATA, "/tmp/agentus-qa-account"].filter(Boolean))];
  for (const dir of candidates) {
    const file = path.join(dir, "auth.token");
    if (!fs.existsSync(file)) continue;
    const tok = fs.readFileSync(file, "utf8").trim();
    const r = await fetch(`${BASE}/api/sessions`, { headers: { authorization: `Bearer ${tok}` } }).catch(() => null);
    if (r?.ok) return dir;
  }
  throw new Error(`no data dir under test: tried ${candidates.join(", ")}`);
})();

const token = fs.readFileSync(path.join(DATA, "auth.token"), "utf8").trim();
const api = async (p, init = {}) => {
  const r = await fetch(BASE + p, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

/** One MCP conversation over stdio with a real `plan-server.mjs` child. */
function mcpChild(env) {
  const child = spawn(process.execPath, ["packages/server/mcp/plan-server.mjs"], {
    cwd: new URL("../../", import.meta.url).pathname,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  let buf = "";
  let nextId = 1;
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const slot = pending.get(msg.id);
      if (slot) { pending.delete(msg.id); slot(msg); }
    }
  });
  const call = (method, params = {}, to = 8000) => new Promise((res, rej) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`TIMEOUT ${method}`)); }, to);
    pending.set(id, (m) => { clearTimeout(timer); res(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  return { child, call, notify: (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`) };
}

/** The tool's text answer, whatever the shape. */
const textOf = (msg) => msg?.result?.content?.[0]?.text ?? msg?.error?.message ?? "";

const freshSession = async (title) => (await api("/api/sessions", {
  method: "POST", body: JSON.stringify({ backend: "mock", cwd: "/tmp", title }),
})).body;

const statusOf = async (id) => {
  const { body } = await api("/api/sessions");
  return (body?.live ?? []).find((s) => s.id === id)?.status ?? "";
};
const idle = async (id, ms = 30000) => {
  const t0 = Date.now();
  for (;;) {
    const st = await statusOf(id);
    if (st !== "running" && st !== "starting") return st;
    if (Date.now() - t0 > ms) return st;
    await sleep(300);
  }
};
const say = async (id, text) => {
  await api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text }) });
  await idle(id, 60000);
  await sleep(300);
};
const lastReply = async (id) => {
  const { body } = await api(`/api/sessions/${id}/messages?tail=1`);
  const agents = (body?.messages ?? []).filter((m) => m.kind === "agent").map((m) => m.payload?.content?.text ?? "").filter(Boolean);
  return agents.at(-1) ?? "";
};
const planOf = async (id) => (await api(`/api/sessions/${id}/plan`)).body?.plan ?? null;

// --- the mock row: opt in to the token file (mock-only QA hook) ------------------------
const TOKEN_FILE = path.join(DATA, `plan-mcp-sweep-${process.pid}.json`);
const before = (await api("/api/backends/mock")).body;
check("the mock backend is declared as having NO native plan channel (so it must be injected one)",
  before?.nativePlanSource === "none", `nativePlanSource=${before?.nativePlanSource}`);
await api("/api/backends/mock", {
  method: "PATCH",
  body: JSON.stringify({ ...before, env: { ...(before?.env ?? {}), MOCK_PLAN_TOKEN_FILE: TOKEN_FILE } }),
});

// --- 1: the gate, both ways -----------------------------------------------------------
const s1 = await freshSession("plan mcp sweep (none)");
check("the sweep could open a mock session", Boolean(s1?.id), JSON.stringify(s1).slice(0, 160));
let sid = s1.id;
await say(sid, "[mcp] what did the handshake carry?");
const declared = JSON.parse((await lastReply(sid)).replace(/^MCP\s*/, "") || "[]");
check("a `none` backend is handed the plan tool at HANDSHAKE time (and nothing else)",
  declared.length === 1 && declared[0].name === "agentus-plan",
  JSON.stringify(declared));
check("…running this repo's own plan server, not some other binary",
  declared[0]?.command === "node" && declared[0]?.args?.[0] === "plan-server.mjs",
  JSON.stringify(declared[0]));
check("…with the endpoint, the session and a token — and no other env",
  JSON.stringify(declared[0]?.envNames) === JSON.stringify(["AGENTUS_PLAN_ENDPOINT", "AGENTUS_PLAN_TOKEN", "AGENTUS_PLAN_SESSION"]),
  JSON.stringify(declared[0]?.envNames));

// The other direction: flip the row and a NEW session must be handed nothing.
await api("/api/backends/mock", { method: "PATCH", body: JSON.stringify({ ...before, nativePlanSource: "acp" }) });
const s2 = await freshSession("plan mcp sweep (acp)");
await say(s2.id, "[mcp] what did the handshake carry?");
const declaredAcp = JSON.parse((await lastReply(s2.id)).replace(/^MCP\s*/, "") || "[]");
check("an `acp` backend is handed NOTHING (Hermes keeps one list, its own)",
  Array.isArray(declaredAcp) && declaredAcp.length === 0, JSON.stringify(declaredAcp));
// …and the session we already had keeps working: the choice is per session, not a global switch.
await api("/api/sessions/" + s2.id, { method: "DELETE" });
await api("/api/backends/mock", { method: "PATCH", body: JSON.stringify({ ...before, env: { ...(before?.env ?? {}), MOCK_PLAN_TOKEN_FILE: TOKEN_FILE } }) });

// --- 2: the injected env really works, through the real child --------------------------
check("the mock wrote the handshake's plan token out (QA hook, so no credential hits the UI)",
  fs.existsSync(TOKEN_FILE), TOKEN_FILE);
const env = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
check("…and it names THIS session and THIS cockpit",
  env.AGENTUS_PLAN_SESSION === sid && env.AGENTUS_PLAN_ENDPOINT === BASE,
  `session=${env.AGENTUS_PLAN_SESSION} endpoint=${env.AGENTUS_PLAN_ENDPOINT}`);

const mcp = mcpChild({
  AGENTUS_PLAN_ENDPOINT: env.AGENTUS_PLAN_ENDPOINT,
  AGENTUS_PLAN_TOKEN: env.AGENTUS_PLAN_TOKEN,
  AGENTUS_PLAN_SESSION: env.AGENTUS_PLAN_SESSION,
});
const init = await mcp.call("initialize", { protocolVersion: "1", capabilities: {}, clientInfo: { name: "sweep", version: "1" } });
check("the plan server speaks MCP (initialize)", init?.result?.serverInfo?.name === "agentus-plan",
  JSON.stringify(init?.result?.serverInfo));
mcp.notify("notifications/initialized");
const listed = await mcp.call("tools/list");
const toolNames = (listed?.result?.tools ?? []).map((t) => t.name);
check("…and offers exactly update_plan + read_plan",
  JSON.stringify(toolNames) === JSON.stringify(["update_plan", "read_plan"]), JSON.stringify(toolNames));

const written = await mcp.call("tools/call", {
  name: "update_plan",
  arguments: {
    items: [
      { content: "sweep: capture the handshake", status: "completed" },
      { content: "sweep: drive the tool", status: "in_progress" },
      { content: "sweep: check the card", status: "pending" },
    ],
    explanation: "written through the plan tool, not through frames",
  },
});
check("update_plan reports back in the model's terms (done/total)",
  /Plan saved \(1\/3 done/.test(textOf(written)), textOf(written).slice(0, 120));

const afterWrite = await planOf(sid);
check("the write landed in the SERVER's plan object",
  afterWrite?.source === "mcp" && afterWrite?.items?.length === 3,
  JSON.stringify({ source: afterWrite?.source, items: afterWrite?.items?.length }));
check("…carrying the tool's own remark",
  afterWrite?.explanation === "written through the plan tool, not through frames",
  String(afterWrite?.explanation));

const readBack = await mcp.call("tools/call", { name: "read_plan", arguments: {} });
check("read_plan round-trips what the cockpit holds",
  /capture the handshake/.test(textOf(readBack)) && /revision 1/.test(textOf(readBack)),
  textOf(readBack).split("\n")[0]);

// --- 3: a bad token can write nothing -------------------------------------------------
const rogue = mcpChild({
  AGENTUS_PLAN_ENDPOINT: env.AGENTUS_PLAN_ENDPOINT,
  AGENTUS_PLAN_TOKEN: "not-the-token",
  AGENTUS_PLAN_SESSION: env.AGENTUS_PLAN_SESSION,
});
await rogue.call("initialize", { protocolVersion: "1", capabilities: {}, clientInfo: { name: "sweep", version: "1" } });
const rogueOut = await rogue.call("tools/call", { name: "update_plan", arguments: { items: [{ content: "rogue", status: "pending" }] } });
check("the token is what scopes the tool (a wrong one is refused, as a tool error)",
  /bad plan token/.test(textOf(rogueOut)) && rogueOut?.result?.isError === true, textOf(rogueOut).slice(0, 120));
check("…and the plan on screen is untouched by that attempt",
  (await planOf(sid))?.items?.length === 3);
rogue.child.stdin.end();

// --- 4: an empty list is not a clear --------------------------------------------------
const emptied = await mcp.call("tools/call", { name: "update_plan", arguments: { items: [] } });
check("an empty list is refused by name (Hermes' own clear-todos frame must not wipe the card)",
  /empty list is not a plan/.test(textOf(emptied)), textOf(emptied).slice(0, 140));
check("…and the three steps are still there", (await planOf(sid))?.items?.length === 3);

// --- 5: one writer per session --------------------------------------------------------
await say(sid, "[plan] the agent's own frames");
const afterFrame = await planOf(sid);
check("a native frame takes the card over", afterFrame?.source === "acp" && afterFrame?.items?.length === 3,
  JSON.stringify({ source: afterFrame?.source, first: afterFrame?.items?.[0]?.content }));
const late = await mcp.call("tools/call", {
  name: "update_plan", arguments: { items: [{ content: "tool write after frames", status: "pending" }] },
});
check("…and a later tool write is REFUSED rather than merged (one writer, the frame's)",
  /ignored/i.test(textOf(late)) && /unchanged/.test(textOf(late)), textOf(late).slice(0, 200));
const stillFrames = await planOf(sid);
check("…so the object still holds the agent's plan, not the tool's",
  stillFrames?.source === "acp" && stillFrames?.items?.every((i) => !/tool write after frames/.test(i.content)),
  JSON.stringify({ source: stillFrames?.source, items: stillFrames?.items?.map((i) => i.content) }));

// --- 6: the child does not outlive its session ----------------------------------------
const dying = mcpChild({
  AGENTUS_PLAN_ENDPOINT: env.AGENTUS_PLAN_ENDPOINT,
  AGENTUS_PLAN_TOKEN: env.AGENTUS_PLAN_TOKEN,
  AGENTUS_PLAN_SESSION: env.AGENTUS_PLAN_SESSION,
});
await dying.call("initialize", { protocolVersion: "1", capabilities: {}, clientInfo: { name: "sweep", version: "1" } });
dying.child.stdin.end();
const exited = await new Promise((res) => {
  const timer = setTimeout(() => res(null), 4000);
  dying.child.on("exit", (code) => { clearTimeout(timer); res(code); });
});
check("the plan server exits when its stdin closes (an agent's child dies with the agent)",
  exited !== null, exited === null ? "still running after 4s" : `exit ${exited}`);
mcp.child.stdin.end();

// --- cleanup: leave the mock row as we found it ---------------------------------------
await api("/api/backends/mock", { method: "PATCH", body: JSON.stringify({ ...before }) });
await api(`/api/sessions/${sid}`, { method: "DELETE" });
try { fs.unlinkSync(TOKEN_FILE); } catch { /* already gone */ }

console.log(`\nplan-mcp-sweep: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
