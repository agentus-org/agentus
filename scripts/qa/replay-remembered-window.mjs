// QA for #116: a NEW session auto-applying a remembered context window must send the option's
// RAW wire value (e.g. "524288"), not the UI display string ("512K"). And a rejected write must
// not leave the usage row painting the value as applied.
//
//   node scripts/qa/replay-remembered-window.mjs
// BASE / HERMES_STUDIO_DATA overridable. Uses the mock agent's MOCK_CONFIG_LOG to observe the
// EXACT wire value the cockpit sent to setSessionConfigOption (shape-for-shape with the real ACP).
import path from "node:path";
import fs from "node:fs";
import { authHeaders } from "../lib/auth.mjs";

const BASE = process.env.BASE ?? "http://127.0.0.1:8901";
const ROOT = path.resolve(import.meta.dirname, "../..");
const H = { ...authHeaders() };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = path.join(process.env.TMPDIR || "/tmp", "hs116-config.log");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const j = (r) => r.json().catch(() => ({}));

const BACKEND = {
  id: "qa-remember-window", label: "QA remembered window", kind: "mock",
  cmd: process.execPath, args: path.join(ROOT, "packages/server/mock/agent.mjs"),
  env: { MOCK_CONFIG_LOG: LOG }, home: "", profile: "",
  notes: "smoke: new session auto-applies remembered window with raw wire value",
};

try { fs.unlinkSync(LOG); } catch { /* fresh */ }

const put = (body) => fetch(`${BASE}/api/backends/${BACKEND.id}`, {
  method: "PATCH", headers: { "content-type": "application/json", ...H }, body: JSON.stringify(body),
});
const created = await fetch(`${BASE}/api/backends`, {
  method: "POST", headers: { "content-type": "application/json", ...H }, body: JSON.stringify(BACKEND),
});
if (created.status === 409) await put(BACKEND);

const newSession = async (title) => j(await fetch(`${BASE}/api/sessions`, {
  method: "POST", headers: { "content-type": "application/json", ...H },
  body: JSON.stringify({ backend: BACKEND.id, cwd: "/tmp", title }),
}));
const statusOf = async (sid) => {
  const d = await j(await fetch(`${BASE}/api/sessions`, { headers: H }));
  return [...(d.live ?? []), ...(d.archived ?? [])].find((s) => s.id === sid)?.status ?? "?";
};
const infoOf = async (sid) => {
  const d = await j(await fetch(`${BASE}/api/sessions`, { headers: H }));
  return [...(d.live ?? []), ...(d.archived ?? [])].find((s) => s.id === sid) ?? null;
};
const waitReady = async (sid, tries = 160) => {
  for (let i = 0; i < tries; i++) {
    const st = await statusOf(sid);
    if (st === "ready" || st === "running") return st;
    await sleep(250);
  }
  return statusOf(sid);
};

// ---- 1. remember 524288 for the model the mock advertises (mock:fast) --------------------------
const seed = await newSession("seed remembered window");
await waitReady(seed.id);
const remembered = await fetch(`${BASE}/api/sessions/${seed.id}/context-limit`, {
  method: "POST", headers: { "content-type": "application/json", ...H },
  body: JSON.stringify({ limit: 524288, remember: true }),
});
check("seed: remembered 524288", remembered.status === 200, `HTTP ${remembered.status}`);

// Clear the config log so the next session's auto-apply is the only thing we read.
try { fs.unlinkSync(LOG); } catch { /* none */ }

// ---- 2. a NEW session of the same model auto-applies the remembered window ---------------------
const fresh = await newSession("fresh auto-apply");
await waitReady(fresh.id);
await sleep(1200); // let the handshake's #applyRememberedContext settle

const written = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf-8") : "";
const lines = written.split("\n").filter(Boolean);
const budgetLines = lines.filter((l) => l.startsWith("context_budget="));

check("new session sent context_budget to the agent", budgetLines.length > 0,
  `log: ${JSON.stringify(lines)}`);
check("wire value is the RAW number 524288, not the UI string 512K",
  budgetLines.some((l) => l === "context_budget=524288") && !budgetLines.some((l) => l === "context_budget=512K"),
  `context_budget lines: ${JSON.stringify(budgetLines)}`);

const info = await infoOf(fresh.id);
const winOpt = (info?.configOptions ?? []).find((o) => o.id === "context_budget");
check("session's context_budget currentValue reads 524288 (applied, not faked)",
  String(winOpt?.currentValue) === "524288", `currentValue=${String(winOpt?.currentValue)}`);

// ---- 3. a rejected write must NOT paint the value as applied (issue #116 判据 3) ----------------
// Remember 100 (< the agent's freeform min 16384): the auto-apply is refused by the agent, which
// returns the OLD currentValue ("auto"). The cockpit must show that real value, not a fake "100K".
await fetch(`${BASE}/api/sessions/${seed.id}/context-limit`, {
  method: "POST", headers: { "content-type": "application/json", ...H },
  body: JSON.stringify({ limit: 100, remember: true }),
});
const rejected = await newSession("rejected auto-apply");
await waitReady(rejected.id);
await sleep(1200);
const rejInfo = await infoOf(rejected.id);
const rejOpt = (rejInfo?.configOptions ?? []).find((o) => o.id === "context_budget");
check("a refused auto-apply does not paint a fake applied value",
  String(rejOpt?.currentValue) !== "100K" && String(rejOpt?.currentValue) !== "100",
  `currentValue=${String(rejOpt?.currentValue)} (agent's real value should survive)`);

// ---- cleanup -----------------------------------------------------------------------------------
await fetch(`${BASE}/api/sessions/${seed.id}`, { method: "DELETE", headers: H }).catch(() => {});
await fetch(`${BASE}/api/sessions/${fresh.id}`, { method: "DELETE", headers: H }).catch(() => {});
await fetch(`${BASE}/api/sessions/${rejected.id}`, { method: "DELETE", headers: H }).catch(() => {});
await fetch(`${BASE}/api/backends/${BACKEND.id}`, { method: "DELETE", headers: H }).catch(() => {});
try { fs.unlinkSync(LOG); } catch { /* done */ }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
