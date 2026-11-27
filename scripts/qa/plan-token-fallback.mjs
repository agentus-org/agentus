import "../../packages/shared/src/env-alias.mjs";
// QA: the busy-fallback path for a legacy frozen plan MCP token (#107, review R3 F1).
// The mock refuses a CHANGED MCP list while MOCK_MCP_BUSY_FILE exists, exactly like the gateway's
// idle-only rebind under a foreign turn. We assert: busy slot still adopts; the old frozen token
// cannot write another plan; once the lease clears, the heal timer rebinds and writes work again.
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE ?? "http://127.0.0.1:8901";
const DATA = process.env.HERMES_STUDIO_DATA ?? "/tmp/agentus-qa-account";
const token = fs.readFileSync(path.join(DATA, "auth.token"), "utf8").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const statusOf = async (id) => {
  const { body } = await api("/api/sessions");
  return (body?.live ?? []).find((s) => s.id === id)?.status ?? "";
};
const idle = async (id, ms = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const st = await statusOf(id);
    if (st === "ready") return true;
    if (["error", "closed", "reaped"].includes(st)) return false;
    await sleep(250);
  }
  return false;
};
const planWrite = async (session, tokenValue) => api("/api/plan/mcp", {
  method: "POST",
  headers: { "x-studio-plan-token": tokenValue },
  body: JSON.stringify({ session, op: "update", items: [{ content: `fallback ${Date.now()}`, status: "pending" }] }),
});

const frozenFile = path.join(DATA, `fallback-frozen-${process.pid}.json`);
const busyFile = path.join(DATA, `fallback-busy-${process.pid}.flag`);
const tokenFile = path.join(DATA, `fallback-token-${process.pid}.json`);
for (const f of [frozenFile, busyFile, tokenFile]) { try { fs.unlinkSync(f); } catch {} }

const before = (await api("/api/backends/mock")).body;
const env = {
  ...(before?.env ?? {}), MOCK_FROZEN_MCP_FILE: frozenFile, MOCK_MCP_BUSY_FILE: busyFile,
  MOCK_PLAN_TOKEN_FILE: tokenFile, MOCK_LEGACY_PLAN_TOKEN: "legacy-token-from-old-build",
};
await api("/api/backends/mock", { method: "PATCH", body: JSON.stringify({ ...before, env }) });

let sid = "";
try {
  const created = await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "mock", cwd: "/tmp", title: `plan fallback ${process.pid}` }) });
  sid = created.body?.id ?? "";
  check("a mock session opened", Boolean(sid) && await idle(sid), JSON.stringify(created.body).slice(0, 120));
  const saved = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
  const legacyToken = saved.HERMES_STUDIO_PLAN_TOKEN;
  check("a legacy frozen token was recorded", legacyToken === "legacy-token-from-old-build",
    `session=${saved.HERMES_STUDIO_PLAN_SESSION}`);

  fs.writeFileSync(busyFile, "held\n");
  const restarted = await api(`/api/sessions/${sid}/restart`, { method: "POST" });
  check("a busy slot still adopts after a frozen-policy conflict", restarted.status === 200 && await idle(sid),
    `restart=${restarted.status} ${JSON.stringify(restarted.body).slice(0, 160)}`);

  const rogue = await planWrite(sid, "another-random-token");
  check("strict token auth survives the busy fallback", rogue.status === 403 && rogue.body?.error === "bad plan token",
    `${rogue.status} ${JSON.stringify(rogue.body)}`);
  const stale = await planWrite(sid, legacyToken);
  check("the old frozen token cannot write the plan either", stale.status === 403 && stale.body?.error === "bad plan token",
    `${stale.status} ${JSON.stringify(stale.body)}`);

  fs.unlinkSync(busyFile);
  let healed = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 35000) {
    const current = JSON.parse(fs.readFileSync(tokenFile, "utf8")).HERMES_STUDIO_PLAN_TOKEN;
    const r = await planWrite(sid, current);
    if (r.status === 200) { healed = r; break; }
    await sleep(1000);
  }
  check("once idle, the heal timer rebinds the frozen token and plan writes work again",
    healed?.body?.accepted === true, JSON.stringify(healed?.body ?? null).slice(0, 160));
} finally {
  await api("/api/backends/mock", { method: "PATCH", body: JSON.stringify({ ...before, env: before?.env ?? {} }) });
  if (sid) await api(`/api/sessions/${sid}`, { method: "DELETE" });
  for (const f of [frozenFile, busyFile, tokenFile]) { try { fs.unlinkSync(f); } catch {} }
}
console.log(`\nplan-token-fallback: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
