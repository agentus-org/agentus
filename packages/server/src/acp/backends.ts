// Backend registry — the entire multi-backend support surface (D5).
// Adding a backend = adding one row here; NEVER touch the protocol layer.
//
// Isolation rule (learned the hard way, 2026-10-02): a spawned agent CLI inherits
// our env, so an unset HERMES_HOME makes it fall back to the *user's live*
// ~/.hermes — same state.db, same cron/kanban DBs, same Hindsight daemon as the
// real runtime. Two openers on one WAL SQLite (3.50.4 has the WAL-reset bug)
// corrupted the user's state.db. So: every backend that owns a home directory
// MUST get an explicit, isolated home, and pointing it at the live home is a
// hard error unless AGENTSLOT_ALLOW_LIVE_HOME=1 is set deliberately.
import fs from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface HomeIsolation {
  /** env var naming the agent's home (state.db + friends live under it) */
  homeVar: string;
  /** where the home goes when no explicit override is present */
  homeDefault: string;
  /** the live home of the user's real runtime — sharing it is fatal */
  liveHome: string;
  /** escape hatch env var; "1" allows the live home on purpose */
  allowEnv: string;
}

export interface BackendSpec {
  label: string;
  cmd: string;
  args: string[];
  check: string[] | null; // args for a quick `--check` self test
  needsLoginHint?: string;
  isolation?: HomeIsolation;
}

const liveHermesHome = path.join(homedir(), ".hermes");
const testHermesHome =
  process.env.AGENTSLOT_HERMES_HOME || path.join(homedir(), ".agentslot-test/home");

export const BACKENDS: Record<string, BackendSpec> = {
  hermes: {
    label: "Hermes",
    cmd: process.env.AGENTSLOT_HERMES_CMD || "hermes",
    args: ["acp"],
    check: ["acp", "--check"],
    isolation: {
      homeVar: "HERMES_HOME",
      homeDefault: testHermesHome,
      liveHome: liveHermesHome,
      allowEnv: "AGENTSLOT_ALLOW_LIVE_HOME",
    },
  },
  qoder: {
    label: "Qoder",
    cmd:
      process.env.AGENTSLOT_QODER_CMD ||
      path.join(homedir(), ".local/bin/qodercli"),
    args: ["--acp"],
    check: null,
    needsLoginHint: "qodercli login",
    // qodercli keeps its own state under ~/.qoder; no home env to pin yet.
  },
  mock: {
    label: "Mock Agent",
    cmd: process.env.AGENTSLOT_MOCK_CMD || "node",
    // resolve mock relative to this file, not process.cwd() (start.sh launches from the
    // repo root, the dev server from packages/server); fileURLToPath so a clone inside a
    // path with spaces ("~/My Projects/…") doesn't arrive percent-encoded
    args: [
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../mock/agent.mjs",
      ),
    ],
    check: null,
  },
};

export type BackendId = keyof typeof BACKENDS;

export function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(homedir(), p.slice(1)) : p;
}

export interface SpawnPlan {
  env: NodeJS.ProcessEnv;
  /** resolved home we handed the child (null when the backend has none) */
  home: string | null;
  /** non-fatal isolation concerns worth surfacing in the UI */
  warnings: string[];
}

/**
 * Build the child env for a backend, enforcing home isolation.
 * Throws (fail-closed) when a backend would share the live runtime home.
 */
export function buildSpawnEnv(spec: BackendSpec): SpawnPlan {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const warnings: string[] = [];
  if (!spec.isolation) return { env, home: null, warnings };

  const { homeVar, homeDefault, liveHome, allowEnv } = spec.isolation;
  // The parent env is untrusted here: a Hermes-launched terminal hands its own
  // HERMES_HOME (the live one) down to us, and inheriting that is exactly the
  // bug we are guarding against. Only the explicit AGENTSLOT_* knob chooses the
  // child's home; an ambient HERMES_HOME is reported, never obeyed.
  const ambient = env[homeVar] ? expandHome(env[homeVar]!) : null;
  const home = path.resolve(expandHome(homeDefault));
  const live = path.resolve(liveHome);

  if (ambient && path.resolve(ambient) !== home) {
    warnings.push(
      `ignored inherited ${homeVar}=${ambient} (parent env, not authoritative); ` +
        `child gets ${home}. Set AGENTSLOT_HERMES_HOME to choose a different home.`,
    );
  }

  if (home === live && env[allowEnv] !== "1") {
    throw new Error(
      `isolation refused: ${spec.label} would run against the live home ${live} ` +
        `(its state.db is the running runtime's). Spawn with ${homeVar} set to an ` +
        `isolated directory (default ${homeDefault}) or set ${allowEnv}=1 if you ` +
        `really mean to drive the live runtime.`,
    );
  }
  if (home === live) {
    warnings.push(`${homeVar} points at the live home ${live} (${allowEnv}=1).`);
  }
  env[homeVar] = home;

  // Hindsight's embedded Postgres instance is keyed off the *agent* config
  // (~/.pg0/instances/hindsight-embed-<profile>, profile from that home's
  // hindsight/config.json, default "hermes"). A fresh home that keeps the
  // default name would attach to the production daemon — warn loudly.
  if (home !== live) {
    try {
      const cfgPath = path.join(home, "hindsight", "config.json");
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as {
          profile?: string;
        };
        const name = cfg.profile || "hermes";
        if (name === "hermes") {
          warnings.push(
            `Hindsight instance name is the shared default "hermes" — this home ` +
              `would reuse the live memory daemon (${path.join(homedir(), ".pg0/instances/hindsight-embed-hermes")}). ` +
              `Set {"profile":"agentslot-test"} in ${cfgPath} or disable memory.`,
          );
        }
      }
    } catch {
      /* config unreadable → not worth failing the spawn over */
    }
  }
  return { env, home, warnings };
}