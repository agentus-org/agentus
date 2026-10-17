/**
 * Ship the cockpit's own skills to the agents it spawns.
 *
 * WHY A SKILL AND NOT A PROMPT
 * The cockpit CLI can only be used if the agent knows it exists, and the two ways of telling it are
 * not equal. Pasting the manual into every first prompt costs tokens forever and goes stale the
 * moment a command changes; a file the agent reads WHEN it matters costs nothing until then. Which
 * of the two is even possible depends on the backend — the ACP protocol has no skill object at all,
 * so each product invents one (see `docs/refs/aionui-acp-rules.md`; AionCore keys it off a per-agent
 * `native_skills_dirs`, symlinking skills into the workspace and falling back to a prompt-injected
 * index). That is exactly the split here:
 *
 *  · `BackendSpec.skillsDir` — the agent discovers `<dir>/<name>/SKILL.md` natively (Hermes reads
 *    `$HERMES_HOME/skills`). We install into that dir at spawn.
 *  · no `skillsDir` — nothing native exists (Qoder ships `--plugin-dir`/`AGENTS.md`, not skill
 *    folders). The agent gets one line in the plan reminder and pulls the document from the CLI
 *    itself (`agentus cockpit skill`), which is the same bytes with no prompt cost at all.
 *
 * WHAT THIS IS NOT
 * Not a package manager and not a syncer. It writes the cockpit's OWN skill directories, compares
 * bytes so a second call is a no-op, and never deletes or rewrites anything it did not put there —
 * the agent's home belongs to the operator.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** `<pkg>/skills`. Resolved from this file, so a global install, an `npx` checkout and a source
 *  worktree all find the same corpus (`packages/server/src/skills/` → up four). */
export const SKILLS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../skills");

export interface BundledSkill {
  /** directory name == the skill's `name:` in its frontmatter */
  name: string;
  /** absolute path of its SKILL.md */
  file: string;
}

export interface InstallResult {
  /** the skills dir we wrote into */
  dir: string;
  installed: string[];
  updated: string[];
  unchanged: string[];
}

/** The skills this package carries. A directory counts only if it holds a `SKILL.md` — an empty or
 *  half-written folder must not become an empty skill in someone's home. */
export function bundledSkills(root: string = SKILLS_ROOT): BundledSkill[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, file: path.join(root, name, "SKILL.md") }))
    .filter((s) => fs.existsSync(s.file))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Install (or refresh) this package's skills into `dir`, which is the agent's own skills directory.
 *
 * Idempotent by CONTENT, not by presence: a skill whose text changed in a release is rewritten, one
 * that did not is left untouched — so calling this on every spawn costs one `readFileSync` per skill
 * and produces no disk churn, no mtime churn, and nothing for the agent to re-index.
 *
 * Throws only on an unusable `dir`. Callers treat a failure as a warning: a session whose skill
 * could not be installed still WORKS, it just has to discover the CLI from the prompt line.
 */
export function installSkills(dir: string, root: string = SKILLS_ROOT): InstallResult {
  const skills = bundledSkills(root);
  const result: InstallResult = { dir, installed: [], updated: [], unchanged: [] };
  if (!skills.length) return result;

  fs.mkdirSync(dir, { recursive: true });
  for (const skill of skills) {
    const target = path.join(dir, skill.name, "SKILL.md");
    const wanted = fs.readFileSync(skill.file, "utf8");
    let current: string | null = null;
    try {
      current = fs.readFileSync(target, "utf8");
    } catch {
      current = null;
    }
    if (current === wanted) {
      result.unchanged.push(skill.name);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, wanted);
    (current === null ? result.installed : result.updated).push(skill.name);
  }
  return result;
}

/** `"{home}/skills"` → the real path. Kept tiny and separate so a spec's template cannot be
 *  half-interpreted in one call site and not another. */
export function resolveSkillsDir(template: string, home: string): string {
  return template.replaceAll("{home}", home);
}
