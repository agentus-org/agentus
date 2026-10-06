// MEASURE (not a test): what does an ACP agent actually answer when asked to load a session it
// does not have? The cockpit's whole "can this cold slot come back?" decision hangs on it.
//   node scripts/probe-load-missing.mjs
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

const target = process.argv[2] ?? "hermes";

const spec =
  target === "mock"
    ? { cmd: process.execPath, args: ["packages/server/mock/agent.mjs"], env: {} }
    : {
        cmd: "/Users/liang/.local/bin/hermes-acp",
        args: [],
        env: { HERMES_HOME: "/Users/liang/.hermes" },
      };

const child = spawn(spec.cmd, spec.args, {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, ...spec.env },
});
child.stderr.on("data", (d) => process.stderr.write(`  [child] ${d}`));

const conn = new ClientSideConnection(
  () => ({ sessionUpdate: () => {}, requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) }),
  ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
);

const init = await conn.initialize({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
console.log(`  capabilities.loadSession = ${init?.agentCapabilities?.loadSession}`);

for (const sid of ["definitely-not-a-real-session-id"]) {
  try {
    const res = await conn.loadSession({ sessionId: sid, cwd: "/tmp", mcpServers: [] });
    console.log(`  loadSession(${sid}) -> no throw; typeof=${typeof res} value=${JSON.stringify(res)} keys=${res && typeof res === "object" ? JSON.stringify(Object.keys(res)) : "-"}`);
  } catch (e) {
    console.log(`  loadSession(${sid}) -> THREW ${e?.constructor?.name}: ${e?.message}`);
  }
}

// and what a prompt on that unknown session answers
try {
  const res = await conn.prompt({ sessionId: "definitely-not-a-real-session-id", prompt: [{ type: "text", text: "hi" }] });
  console.log(`  prompt(unknown) -> no throw; ${JSON.stringify(res)}`);
} catch (e) {
  console.log(`  prompt(unknown) -> THREW ${e?.constructor?.name}: ${e?.message}`);
}

child.kill("SIGKILL");
process.exit(0);
