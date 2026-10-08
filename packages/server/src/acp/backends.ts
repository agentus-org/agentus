// Backend registry — the entire multi-backend support surface (D5).
// Adding a backend = adding one row here; NEVER touch the protocol layer.
//
// Home rule: a backend that owns a home directory always gets an EXPLICIT HERMES_HOME — the
// row's own if it names one, otherwise the operator's real home (~/.hermes). An inherited
// HERMES_HOME must never decide where a slot writes, because a Hermes-launched terminal hands
// its own (the live one) down to us.
//
// The early-dev isolation guard — a hard error whenever a row pointed at the live home, plus
// the AGENTUS_ALLOW_LIVE_HOME escape hatch and the row's `allowLiveHome` tick — is GONE
// (2026-10-06): the cockpit is meant to drive the operator's real runtime. It existed because
// two openers on one WAL SQLite 3.50.4 (inside the WAL-reset range) corrupted the user's
// state.db; the runtime's interpreter now links SQLite 3.53.1, so the reason is gone. A row
// that wants its own data directory still simply names one.
import fs from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface HomeIsolation {
  /** env var naming the agent's home (state.db + friends live under it) */
  homeVar: string;
  /** where the home goes when the row does not name one — the operator's real home */
  homeDefault: string;
}

export interface BackendSpec {
  /** registry row id (M6); the builtin seeds carry theirs, spawn does not need it */
  id?: string;
  /** spawn family, so callers can reason about the arg shape without matching on the id */
  kind?: "hermes" | "qoder" | "mock";
  /**
   * Where this agent's PLAN comes from — a declaration, not per-agent code.
   *
   *  · `acp`  — the agent emits ACP `plan` frames itself (Hermes does; that is the whole point of
   *             the fork fix). The cockpit ingests them and must NOT hand the agent a second
   *             writable list, so no plan MCP server is injected into the handshake.
   *  · `none` — anything else. The cockpit injects the `agentus-plan` MCP server at handshake
   *             time, so a new agent gets plan cards without one line of its own code.
   *
   *  The choice is per SESSION (it rides the handshake), which is why it can never leak into the
   *  agent's own config — see design-plan-service.md §4.
   */
  nativePlanSource?: NativePlanSource;
  label: string;
  cmd: string;
  args: string[];
  check: string[] | null; // args for a quick `--check` self test
  needsLoginHint?: string;
  isolation?: HomeIsolation;
  /** Extra env for the child — e.g. `PYTHONPATH=<the operator's fork tree>` so a row can run
   *  a source checkout while the box's default `hermes` runs the installed runtime. Merged
   *  BEFORE the isolation home, so a row cannot smuggle `HERMES_HOME` in through here. */
  env?: Record<string, string>;
  /** hermes profile, composed into argv by registry.effectiveArgs (`hermes -p <profile> acp`) */
  profile?: string | null;
  /** free-form note shown next to the row in the UI */
  notes?: string;
}

/** The operator's real home — the DEFAULT for a hermes row, not a禁区. */
const liveHermesHome = path.join(homedir(), ".hermes");
const defaultHermesHome = process.env.AGENTUS_HERMES_HOME || liveHermesHome;

export const BACKENDS: Record<string, BackendSpec> = {
  hermes: {
    label: "Hermes",
    cmd: process.env.AGENTUS_HERMES_CMD || "hermes",
    args: ["acp"],
    check: ["acp", "--check"],
    // Hermes CAN emit ACP `plan` frames (acp_adapter/events.py), but the cockpit deliberately does
    // NOT use them for the card: an agent's own todo state dies with its process, so a restart used
    // to leave the card lying about work that no longer exists anywhere (design-plan-service.md §1).
    // Hermes is therefore MCP-driven like everything else, and its frames are ignored (§5 of the
    // same doc). `nativePlanSource: "acp"` survives only as a PER-ROW escape hatch.
    nativePlanSource: "none",
    isolation: {
      homeVar: "HERMES_HOME",
      homeDefault: defaultHermesHome,
    },
  },
  qoder: {
    label: "Qoder",
    cmd:
      process.env.AGENTUS_QODER_CMD ||
      path.join(homedir(), ".local/bin/qodercli"),
    args: ["--acp"],
    check: null,
    needsLoginHint: "qodercli login",
    // qodercli keeps its own state under ~/.qoder; no home env to pin yet.
    // Nothing known to emit plan frames → hand it the plan MCP tool instead (zero adapter code).
    nativePlanSource: "none",
  },
  mock: {
    label: "Mock Agent",
    cmd: process.env.AGENTUS_MOCK_CMD || "node",
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
    nativePlanSource: "none",
  },
};

export type BackendId = keyof typeof BACKENDS;

/** Which channel carries a backend's plan. See BackendSpec.nativePlanSource.
 *
 *  `none` is the default AND the shipping configuration for every backend: the cockpit's plan
 *  object is the only plan that survives an agent restart, so the `agentus-plan` MCP tool is what
 *  writes (and what the agent is told to prefer). `acp` is a per-row escape hatch for an agent whose
 *  frames you have decided to trust more than the object — it is the ONLY case in which frames are
 *  rendered. */
export type NativePlanSource = "acp" | "none";

/** What a backend's plan channel is when its row does not say. One constant, so the registry's
 *  derivation, the built-in specs and the session manager cannot drift apart. */
export const DEFAULT_NATIVE_PLAN_SOURCE: NativePlanSource = "none";

/** The channel a spec resolves to, defaulting rather than throwing on an absent value. */
export function nativePlanSourceOf(spec: { nativePlanSource?: NativePlanSource }): NativePlanSource {
  return spec.nativePlanSource ?? DEFAULT_NATIVE_PLAN_SOURCE;
}

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
 * Build the child env for a backend. Always sets the home env var explicitly — the row's home,
 * or the operator's real home when the row does not name one. Nothing else is policed: driving
 * the operator's own runtime is the point of the cockpit.
 */
export function buildSpawnEnv(spec: BackendSpec): SpawnPlan {
  // A row's extra env (e.g. PYTHONPATH choosing the fork tree) is merged FIRST; the home
  // below overwrites `HERMES_HOME` unconditionally, so no row can smuggle a home in.
  const env: NodeJS.ProcessEnv = { ...process.env, ...(spec.env ?? {}) };
  const warnings: string[] = [];
  if (!spec.isolation) return { env, home: null, warnings };

  const { homeVar, homeDefault } = spec.isolation;
  // The parent env is untrusted here: a Hermes-launched terminal hands its own
  // HERMES_HOME (the live one) down to us, and inheriting that silently is how a slot ends up
  // writing somewhere nobody chose. Only the row — or the AGENTUS_HERMES_HOME seed behind its
  // default — decides; an ambient HERMES_HOME is reported, never obeyed.
  const ambient = process.env[homeVar] ? expandHome(process.env[homeVar]!) : null;
  const home = path.resolve(expandHome(homeDefault));
  if (ambient && path.resolve(ambient) !== home) {
    warnings.push(
      `ignored inherited ${homeVar}=${ambient} (parent env, not authoritative); ` +
        `child gets ${home}. Set a home on the backend row to choose a different one.`,
    );
  }
  env[homeVar] = home;

  // The operator's real home is the DEFAULT, so it says nothing. A DIFFERENT home is the case
  // worth a warning: Hindsight's embedded Postgres instance is keyed off the *agent* config
  // (~/.pg0/instances/hindsight-embed-<profile>, profile from that home's hindsight/config.json,
  // default "hermes"), so a separate home that keeps the default name would attach to the
  // production memory daemon.
  if (home !== path.resolve(liveHermesHome)) {
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
              `Set {"profile":"agentus"} in ${cfgPath} or disable memory.`,
          );
        }
      }
    } catch {
      /* config unreadable → not worth failing the spawn over */
    }
  }
  return { env, home, warnings };
}