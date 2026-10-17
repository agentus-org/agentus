// Where the cockpit's skill lives for an agent — and, more importantly, where it does NOT.
//
// Issue #15 shipped by copying `skills/agentus-cockpit/` into `<HERMES_HOME>/skills` at every spawn.
// Correct code, wrong place: that home is the operator's REAL one, shared with Studio, cron and every
// terminal `hermes`, so the skill appeared in sessions that have nothing to do with the cockpit (and
// went stale there between releases). Hermes has a per-process channel — `skills.external_dirs`'s
// env half — so the copy is gone and this sweep pins the replacement:
//
//   1. the child's OWN environment names the extra root (read with `ps`, i.e. what the agent sees)
//   2. nothing is written into the shared home — not on create, not on resume
//   3. the doc the agent would read is the package's current one (no stale twin by construction)
//
//   AGENTUS_BASE=http://127.0.0.1:8901 AGENTUS_DATA=/tmp/agentus-qa-account node scripts/qa/skills-env-spawn.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.AGENTUS_BASE ?? "http://127.0.0.1:8901";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const DATA = process.env.AGENTUS_DATA ?? "/tmp/agentus-qa-account";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const token = fs.readFileSync(path.join(DATA, "auth.token"), "utf8").trim();
const api = async (p, init = {}) => {
  const r = await fetch(`${BASE}${p}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; }
};

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const envOf = (pid) => {
  const text = execFileSync("ps", ["eww", "-p", String(pid)], { encoding: "utf8" });
  const found = {};
  for (const kv of text.split(/\s+/)) {
    const at = kv.indexOf("=");
    if (at > 0) found[kv.slice(0, at)] = kv.slice(at + 1);
  }
  return found;
};

// The operator's real home is whatever the slot was spawned with; on this box that is `~/.hermes`.
const sharedSkill = path.join(os.homedir(), ".hermes/skills/agentus-cockpit");
const pkgDoc = path.join(REPO, "skills/agentus-cockpit/SKILL.md");
const pkgBytes = fs.readFileSync(pkgDoc, "utf8");
// A leftover from the release that still copied. Removing it is the only way to tell "we no longer
// write here" from "we wrote the same bytes again" — and if it does not belong to us, leave it alone.
if (fs.existsSync(path.join(sharedSkill, "SKILL.md"))) {
  const current = fs.readFileSync(path.join(sharedSkill, "SKILL.md"), "utf8");
  if (current === pkgBytes) fs.rmSync(sharedSkill, { recursive: true, force: true });
}
check("no copy of our skill sits in the shared home before we start", !fs.existsSync(sharedSkill), sharedSkill);

const made = await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "hermes", cwd: "/tmp", title: "skills-env probe（自动删除）" }) });
const id = made.body?.id;
if (!id) {
  console.log(`FAIL  could not create a hermes slot: ${JSON.stringify(made.body)}`);
  process.exit(1);
}
let row;
for (let i = 0; i < 90; i++) {
  row = ((await api("/api/sessions")).body.live ?? []).find((s) => s.id === id);
  if (row?.status === "ready" || row?.status === "error" || row?.status === "dead") break;
  await sleep(500);
}
try {
  check("the hermes slot came up", row?.status === "ready" && Boolean(row?.pid), `${row?.status} pid=${row?.pid}`);

  const env = row?.pid ? envOf(row.pid) : {};
  check("the CHILD's environment carries the extra skill root",
    env.HERMES_EXTERNAL_SKILLS_DIRS === path.join(REPO, "skills"), String(env.HERMES_EXTERNAL_SKILLS_DIRS));
  check("…and it is still pointed at the operator's own home (we did not swap HERMES_HOME to get isolation)",
    env.HERMES_HOME === path.join(os.homedir(), ".hermes"), String(env.HERMES_HOME));

  // The whole point: that root is the package's, so the agent reads TODAY's document — no copy, no
  // twin, nothing to go stale and nothing for Studio's sessions to trip over.
  check("nothing was written into the shared home", !fs.existsSync(sharedSkill), sharedSkill);
  const rootDoc = env.HERMES_EXTERNAL_SKILLS_DIRS
    ? path.join(env.HERMES_EXTERNAL_SKILLS_DIRS, "agentus-cockpit/SKILL.md") : "";
  check("the root the agent was given holds the current document",
    Boolean(rootDoc) && fs.existsSync(rootDoc) && fs.readFileSync(rootDoc, "utf8") === pkgBytes,
    `${rootDoc} (${pkgBytes.length} bytes)`);

  // A resume is a NEW process: it must be handed the root again, and still not write.
  await api(`/api/sessions/${id}`, { method: "DELETE" });
  const resumed = await api(`/api/sessions/${id}/resume`, { method: "POST", body: JSON.stringify({}) });
  let again;
  for (let i = 0; i < 90; i++) {
    again = ((await api("/api/sessions")).body.live ?? []).find((s) => s.id === id);
    if (again?.status === "ready") break;
    await sleep(500);
  }
  const env2 = again?.pid ? envOf(again.pid) : {};
  check("a RESUMED slot is handed the same root (fresh process, fresh wiring)",
    env2.HERMES_EXTERNAL_SKILLS_DIRS === path.join(REPO, "skills"),
    `resume HTTP ${resumed.status} → ${env2.HERMES_EXTERNAL_SKILLS_DIRS}`);
  check("…and the resume did not write a copy either", !fs.existsSync(sharedSkill), sharedSkill);
} finally {
  await api(`/api/sessions/${id}`, { method: "DELETE" });
  await api(`/api/sessions/${id}`, { method: "DELETE" });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
