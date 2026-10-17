// Shipping the cockpit's skill (issue #15, follow-up): the corpus, the installer, and the two ways an
// agent can find it.
//
// The point of these checks is the second install: an installer that rewrites the file every spawn is
// an installer that makes every agent re-read it, and one that never rewrites it is an installer that
// ships a stale manual. Both failure modes are invisible without a byte-and-mtime assertion.
//
//   node scripts/qa/cockpit-skill-install.mts   (from the repo root)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { BACKENDS } from "../../packages/server/src/acp/backends.js";
import { rowToSpec } from "../../packages/server/src/acp/registry.js";
import { SKILLS_ROOT, bundledSkills, installSkills, resolveSkillsDir } from "../../packages/server/src/skills/install.js";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
let pass = 0, fail = 0;
const check = (name: string, ok: unknown, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

// ---- the corpus that ships ----
check("SKILLS_ROOT points at the package's skills/ dir", SKILLS_ROOT === path.join(REPO, "skills"), SKILLS_ROOT);
const skills = bundledSkills();
check("the cockpit CLI skill is in the corpus", skills.some((s) => s.name === "cockpit-cli"), JSON.stringify(skills.map((s) => s.name)));
const doc = fs.readFileSync(path.join(SKILLS_ROOT, "cockpit-cli/SKILL.md"), "utf8");
check("…with the frontmatter Hermes needs to index it", /^---\nname: agentus-cockpit\ndescription: "/.test(doc), doc.slice(0, 40).replace(/\n/g, "\\n"));
check("…and the parts an agent actually needs (commands, codes, the delivered≠read rule)",
  ["capabilities", "messages", "--tail", "sends_disabled", "target_busy", "delivered"].every((k) => doc.includes(k)) &&
    /delivered.{0,12}not.{0,12}read/s.test(doc), "");

// the npm package must carry it: `files` is what npm packs
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
check("package.json ships skills/ (npm pack includes it)", (pkg.files ?? []).includes("skills/"), JSON.stringify(pkg.files));
// --ignore-scripts: `prepack` runs the web build, whose banner goes to stdout and would corrupt the
// JSON. The file list does not depend on a fresh build — we are asking what would be HANDPACKED.
const packed = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: REPO, encoding: "utf8" });
const files = (JSON.parse(packed)[0]?.files ?? []).map((f: { path: string }) => f.path);
check("…verified against npm's own file list (skills/cockpit-cli/SKILL.md is packed)",
  files.includes("skills/cockpit-cli/SKILL.md"), `${files.length} files packed`);
check("…and the CLI binary that serves the doc is packed too", files.includes("bin/agentus-cockpit.mjs"), "");

// ---- the installer ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-skills-"));
const dir = path.join(tmp, "skills");
// a skill the agent already had, which is NOT ours: it must survive untouched
fs.mkdirSync(path.join(dir, "agent-owned"), { recursive: true });
fs.writeFileSync(path.join(dir, "agent-owned/SKILL.md"), "---\nname: agent-owned\n---\nmine\n");

const first = installSkills(dir);
const target = path.join(dir, "cockpit-cli/SKILL.md");
check("first install writes the skill", first.installed.includes("cockpit-cli") && fs.readFileSync(target, "utf8") === doc,
  JSON.stringify(first));
const mtime1 = fs.statSync(target).mtimeMs;
const second = installSkills(dir);
check("second install is a no-op (no rewrite, no mtime churn)", second.unchanged.includes("cockpit-cli") &&
  !second.installed.length && !second.updated.length && fs.statSync(target).mtimeMs === mtime1,
  JSON.stringify(second));

fs.writeFileSync(target, "stale text from an older release\n");
const third = installSkills(dir);
check("a stale skill from an older release is REFRESHED", third.updated.includes("cockpit-cli") &&
  fs.readFileSync(target, "utf8") === doc, JSON.stringify(third));
check("…and the agent's own skills are never touched", fs.readFileSync(path.join(dir, "agent-owned/SKILL.md"), "utf8") ===
  "---\nname: agent-owned\n---\nmine\n", "");
check("the installer never deletes: an unrelated file next to ours survives",
  (fs.writeFileSync(path.join(dir, "cockpit-cli/NOTES.txt"), "keep me"), installSkills(dir),
  fs.existsSync(path.join(dir, "cockpit-cli/NOTES.txt"))), "");
const empty = installSkills(path.join(tmp, "empty-corpus"), path.join(tmp, "nowhere"));
check("a package with no skills is a silent no-op, not an error", empty.installed.length === 0 && empty.unchanged.length === 0,
  JSON.stringify(empty));

// ---- the per-backend wiring ----
check("Hermes declares a native skills dir under its own home",
  BACKENDS.hermes.skillsDir === "{home}/skills", String(BACKENDS.hermes.skillsDir));
check("…which resolves inside the home the child is given, not the cockpit's own",
  resolveSkillsDir(BACKENDS.hermes.skillsDir!, "/tmp/fake-home") === "/tmp/fake-home/skills", "");
check("Qoder declares none (no native skill folder — it gets the prompt line instead)",
  !BACKENDS.qoder.skillsDir, String(BACKENDS.qoder.skillsDir));

// A REAL spawn does not read BACKENDS — it reads the stored backend ROW (`#spawnShape` prefers it),
// folded through rowToSpec. The first version of this feature set skillsDir only on the builtin, so
// every row that had ever been seeded silently skipped the install. This is that regression.
const row = {
  id: "hermes", kind: "hermes" as const, nativePlanSource: "none" as const, label: "Hermes",
  cmd: "hermes", args: ["acp"], env: {}, profile: null, home: "/tmp/stored-home",
};
check("a STORED backend row inherits the skills dir from its builtin (the bug that skipped every real row)",
  rowToSpec(row as never).skillsDir === "{home}/skills", String(rowToSpec(row as never).skillsDir));
check("…and a row of a kind with no native dir gets none",
  rowToSpec({ ...row, id: "qoder", kind: "qoder" as const, label: "Qoder", cmd: "qodercli", args: ["--acp"] } as never).skillsDir ===
    undefined, "");

// ---- and the CLI can hand out the same document with no cockpit, no token ----
const cliPath = execFileSync(process.execPath, [path.join(REPO, "bin/agentus-cockpit.mjs"), "skill"], {
  cwd: "/tmp", encoding: "utf8", env: { ...process.env, AGENTUS_COCKPIT_BIN: "", AGENTUS_COCKPIT_TOKEN: "", AGENTUS_COCKPIT_SESSION: "" },
});
check("`agentus-cockpit skill` prints the document with NO identity in the environment", cliPath === doc,
  `${cliPath.length} bytes vs ${doc.length}`);
const cliFile = execFileSync(process.execPath, [path.join(REPO, "bin/agentus-cockpit.mjs"), "skill", "--path"], {
  cwd: "/tmp", encoding: "utf8",
});
check("`skill --path` prints the installed path, so an agent can read it with its own file tools",
  cliFile.trim().endsWith("skills/cockpit-cli/SKILL.md") && fs.existsSync(cliFile.trim()), cliFile.trim());

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
