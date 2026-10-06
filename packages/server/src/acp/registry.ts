// Operator-managed backend registry (M6).
//
// "which hermes" turned out to be THREE independent choices, not one:
//   1. which CODE   — the command (`hermes` vs `hermes-dev`) and/or PYTHONPATH (official
//                     runtime tree vs the operator's fork under ~/Project/hermes-agent);
//   2. which DATA   — HERMES_HOME (live ~/.hermes vs a disposable test home);
//   3. which PROFILE— `hermes -p <profile>` inside that home.
// Until now 1 and 2 were env vars fixed at server start (AGENTSLOT_HERMES_CMD /
// AGENTSLOT_HERMES_HOME) and 3 was impossible, so isolating a slot meant restarting the
// cockpit. Rows live in the store, are edited from the UI, and are resolved per spawn.
//
// backends.ts stays the isolation CORE (buildSpawnEnv + the fail-closed live-home rule) and
// the source of the builtin seed rows. Every row is converted into a BackendSpec and goes
// through that same guard, so adding a row can never bypass isolation.
import { execFile } from "node:child_process";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { BACKENDS, buildSpawnEnv, expandHome, type BackendSpec } from "./backends.js";

const run = promisify(execFile);

export type BackendKind = "hermes" | "qoder" | "mock";
export const BACKEND_KINDS: BackendKind[] = ["hermes", "qoder", "mock"];

/** The operator's real home. Not a禁区 any more: it is the DEFAULT home for a hermes row. */
export const HERMES_LIVE_HOME = path.join(homedir(), ".hermes");
/** Where a hermes row goes when it does not name a home itself: the operator's own home. */
export const HERMES_DEFAULT_HOME = process.env.AGENTSLOT_HERMES_HOME || HERMES_LIVE_HOME;

/** One registry row: the whole definition of "how to spawn this kind of agent". */
export interface BackendRow {
  id: string;
  label: string;
  /** spawn family — decides the arg shape and whether a home is injected */
  kind: BackendKind;
  cmd: string;
  /** args WITHOUT the profile flag (effectiveArgs() composes that) */
  args: string[];
  /** extra env handed to the child (e.g. PYTHONPATH=<fork tree>); the home always wins */
  env: Record<string, string>;
  /** HERMES_HOME for kind=hermes (null/empty = HERMES_DEFAULT_HOME, the operator's ~/.hermes) */
  home: string | null;
  /** hermes `-p <profile>` — a profile inside that home, i.e. a second isolation axis */
  profile: string | null;
  /** default working directory for new slots (null = the dialog asks) */
  cwd: string | null;
  notes: string;
  /** seeded row (the ones that used to be env-driven); editable, but flagged in the UI */
  builtin: boolean;
  /**
   * Last known health (system-managed, never accepted from a request body). Kept on the row so
   * the list can answer "is this usable, and since when" without re-running anything — the
   * point being that a failure stays visible after the tab is closed.
   */
  health: BackendHealth;
  /** What the agent advertised the last time a slot really started from this row. */
  handshake: BackendHandshake | null;
  createdAt: number;
  updatedAt: number;
}

export interface BackendPlan {
  home: string | null;
  warnings: string[];
}

// ---- health snapshot ---------------------------------------------------------------------
//
// A single boolean is not enough to be useful: "it failed" is only actionable together with
// WHAT failed (a structured code), WHEN it last worked, and HOW hard the check looked. Check
// depth matters because the three kinds are not equal evidence:
//   startup — command resolves on PATH (milliseconds, never spawns anything);
//   manual  — the 探测 button: `--version` (+ `acp --check` for hermes);
//   session — a real slot reached `ready`, or died in the handshake: the only proof.

export type CheckStatus = "online" | "offline" | "missing" | "unchecked";
export type CheckKind = "startup" | "manual" | "session";
export type CheckErrorCode =
  | "command_not_found"
  | "spawn_failed"
  | "version_failed"
  | "acp_check_failed"
  | "acp_init_failed"
  | "auth_required"
  | "timeout"
  | "unknown";

export interface BackendHealth {
  status: CheckStatus;
  kind: CheckKind | null;
  errorCode: CheckErrorCode | null;
  message: string | null;
  /** what the operator should DO about it (the code alone is a riddle) */
  guidance: string | null;
  latencyMs: number | null;
  at: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
}

export function emptyHealth(): BackendHealth {
  return {
    status: "unchecked", kind: null, errorCode: null, message: null, guidance: null,
    latencyMs: null, at: null, lastSuccessAt: null, lastFailureAt: null,
  };
}

/** One line per code, addressed to the operator, saying what to fix. */
export const ERROR_GUIDANCE: Record<CheckErrorCode, string> = {
  command_not_found:
    "命令不在 PATH 里，也不是可执行的绝对路径。先确认装了没有，或把命令写成绝对路径。",
  spawn_failed: "命令在，但进程起不来（缺解释器、没执行权限之类）。看下面原文。",
  version_failed:
    "`--version` 跑不通。多半是这行的环境变量（例如 PYTHONPATH）指向的代码树不完整，或该命令不支持 --version。",
  acp_check_failed:
    "`acp --check` 没过：这个 home 里的配置／凭据可能不对。注意：过了也不代表能起会话（--check 在适配器模块导入之前就返回了）。",
  acp_init_failed:
    "ACP 握手失败（initialize / newSession）。这才是真正的“能不能用”判据，看下面原文。",
  auth_required: "看着像没登录／凭据不对，先给这个后端做一次登录（例如 qodercli login），再探测。",
  timeout: "探测超时：命令可能卡住（等输入、等网络）。行本身没坏，重试或换个命令试试。",
  unknown: "没归类的错误，看下面原文。",
};

const AUTH_RE = /(401|403|unauthor|forbidden|api[_ -]?key|not logged in|please log ?in|invalid[_ -]?token|token .*(expired|invalid)|credential)/i;
const NOT_FOUND_RE = /(ENOENT|command not found|not found|no such file)/i;
const TIMEOUT_RE = /(timed out|timeout|ETIMEDOUT|killed)/i;

/** Map a raw failure (stderr, exception message…) onto the code the UI can act on. */
export function classifyMessage(text: string, fallback: CheckErrorCode = "unknown"): CheckErrorCode {
  if (AUTH_RE.test(text)) return "auth_required";
  if (TIMEOUT_RE.test(text)) return "timeout";
  if (NOT_FOUND_RE.test(text)) return "command_not_found";
  return fallback;
}

/** The classification of a spawn/handshake exception (session-kind checks). */
export function classifyError(e: unknown): CheckErrorCode {
  const text = e instanceof Error ? `${e.message}` : String(e);
  return classifyMessage(text, "acp_init_failed");
}

/**
 * Fold one check result into the row's snapshot: `at` always moves, success/failure stamps only
 * move for their own outcome, and a failure keeps its code + the guidance that goes with it.
 */
export function checkedHealth(
  prev: BackendHealth | null | undefined,
  result: {
    status: CheckStatus;
    kind: CheckKind;
    errorCode?: CheckErrorCode | null;
    message?: string | null;
    latencyMs?: number | null;
  },
  now = Date.now(),
): BackendHealth {
  const base = prev ?? emptyHealth();
  const failed = result.status === "offline" || result.status === "missing";
  return {
    status: result.status,
    kind: result.kind,
    errorCode: result.errorCode ?? null,
    message: result.message ?? null,
    guidance: result.errorCode ? ERROR_GUIDANCE[result.errorCode] : null,
    latencyMs: result.latencyMs ?? null,
    at: now,
    lastSuccessAt: result.status === "online" ? now : base.lastSuccessAt,
    // "unchecked" is not a failure — it is the absence of evidence (e.g. a blocked row).
    lastFailureAt: failed ? now : base.lastFailureAt,
  };
}

/**
 * What the agent said about itself when a slot last started from this row. Cached on the row
 * because it is a property of (command, env, home, profile) — not of one conversation — and
 * because "which controls may we draw" has to be answerable without a live session.
 */
export interface BackendHandshake {
  at: number;
  protocolVersion: number | null;
  /** agentCapabilities.loadSession */
  loadSession: boolean | null;
  /** agentCapabilities.sessionCapabilities.fork */
  fork: boolean | null;
  modes: { currentModeId: string | null; available: string[] } | null;
  configOptions: { id: string; name: string | null; currentValue: string | null }[];
  models: { currentModelId: string | null; available: string[] } | null;
  /** slash commands the agent announced (session/update or newSession) */
  commands: string[];
}

/** The rows that reproduce the pre-M6 behaviour, seeded once on an empty registry. */
export function seedRows(now = Date.now()): BackendRow[] {
  const notes: Record<string, string> = {
    hermes: "Studio 自带的官方 runtime（默认，改源码不影响它）",
    qoder: "Qoder CLI（需 qodercli login）",
    mock: "本地 mock 代理，QA 用，不花 token",
  };
  return Object.entries(BACKENDS).map(([id, spec]) => {
    const kind: BackendKind = id === "hermes" ? "hermes" : id === "qoder" ? "qoder" : "mock";
    return {
      id,
      label: spec.label,
      kind,
      cmd: spec.cmd,
      args: [...spec.args],
      env: {},
      // null = "whatever the default home is" — today the operator's own ~/.hermes, so the row
      // follows the default instead of freezing a path that was only ever a dev-time choice.
      home: null,
      profile: null,
      cwd: null,
      notes: notes[id] ?? "",
      builtin: true,
      health: emptyHealth(),
      handshake: null,
      createdAt: now,
      updatedAt: now,
    };
  });
}

/** Registry row → spawn spec (what backends.ts/buildSpawnEnv expects). */
export function rowToSpec(row: BackendRow): BackendSpec {
  const spec: BackendSpec = {
    id: row.id,
    kind: row.kind,
    label: row.label,
    cmd: expandHome(row.cmd),
    args: [...row.args],
    check: row.kind === "hermes" ? ["acp", "--check"] : null,
    needsLoginHint: row.kind === "qoder" ? "qodercli login" : undefined,
    env: { ...(row.env ?? {}) },
    profile: row.profile,
  };
  if (row.kind === "hermes") {
    spec.isolation = {
      homeVar: "HERMES_HOME",
      homeDefault: row.home && row.home.trim() ? row.home : HERMES_DEFAULT_HOME,
    };
  }
  return spec;
}

/**
 * The argv actually handed to spawn. `hermes -p <profile> acp`: the profile flag is GLOBAL and
 * belongs before the subcommand (verified against the real CLI: `hermes -p default acp --check`
 * → "Hermes ACP check OK"; `hermes acp --profile …` does not parse).
 */
export function effectiveArgs(row: BackendRow): string[] {
  const args = [...row.args];
  if (row.profile && row.profile.trim() && row.kind === "hermes") {
    return ["-p", row.profile.trim(), ...args];
  }
  return args;
}

/** The home (and any warning about it) one row will spawn with — same code path as the spawn. */
export function planFor(row: BackendRow): BackendPlan {
  try {
    const plan = buildSpawnEnv(rowToSpec(row));
    return { home: plan.home, warnings: plan.warnings };
  } catch (e) {
    // Nothing here should throw any more (the guard is gone); keep the list alive if it ever does.
    return {
      home: row.home ? expandHome(row.home) : null,
      warnings: [e instanceof Error ? e.message : String(e)],
    };
  }
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,40}$/;

/** Shape an arbitrary request body into a row. `base` = the row being edited (PATCH). */
export function coerceRow(body: Record<string, unknown>, base?: BackendRow): { row?: BackendRow; error?: string } {
  const now = Date.now();
  const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const id = s(body.id) || base?.id || "";
  if (!ID_RE.test(id)) return { error: `id must match ${ID_RE} (lowercase, no spaces)` };
  const kind = (s(body.kind) || base?.kind || "hermes") as BackendKind;
  if (!BACKEND_KINDS.includes(kind)) return { error: `unknown kind: ${kind}` };
  const cmd = s(body.cmd) || base?.cmd || "";
  if (!cmd) return { error: "cmd is required" };
  let args = base?.args ?? [];
  if (Array.isArray(body.args)) args = body.args.map((a) => String(a));
  else if (typeof body.args === "string" && body.args.trim()) {
    // accept a shell-ish string so the UI can offer one input box
    args = (body.args.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((a) => a.replace(/^["']|["']$/g, ""));
  }
  let env: Record<string, string> = base?.env ?? {};
  if (body.env && typeof body.env === "object" && !Array.isArray(body.env)) {
    env = {};
    for (const [k, v] of Object.entries(body.env as Record<string, unknown>)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) env[k] = String(v);
    }
  } else if (typeof body.env === "string") {
    env = {};
    for (const line of body.env.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
  }
  // Spawn-relevant edits only: renaming a row or writing a note does not invalidate the
  // evidence, but changing the command/args/env/home/profile/kind does (the row may no longer
  // be the thing that was measured).
  const edited = body.cmd !== undefined || body.args !== undefined || body.env !== undefined
    || body.home !== undefined || body.profile !== undefined || body.kind !== undefined;
  return {
    row: {
      id,
      label: s(body.label) || base?.label || id,
      kind,
      cmd,
      args,
      env,
      home: body.home === undefined ? (base?.home ?? null) : (s(body.home) || null),
      profile: body.profile === undefined ? (base?.profile ?? null) : (s(body.profile) || null),
      cwd: body.cwd === undefined ? (base?.cwd ?? null) : (s(body.cwd) || null),
      notes: body.notes === undefined ? (base?.notes ?? "") : s(body.notes),
      builtin: base?.builtin ?? false,
      // Health is evidence about the CURRENT spawn definition, so changing that definition
      // invalidates it — otherwise the list would keep showing "online" for a row that was
      // just edited into something else. Never taken from the body: only checks write it.
      health: edited ? emptyHealth() : (base?.health ?? emptyHealth()),
      handshake: edited ? null : (base?.handshake ?? null),
      createdAt: base?.createdAt ?? now,
      updatedAt: now,
    },
  };
}

// ---- inspection: "which tree does this row actually run?" --------------------------------
//
// This automates the reconnaissance that used to be done by hand on this box:
// `<cmd> --version` prints "Install directory: …", which names the tree the process will
// import its code from (an editable install reports the source checkout; a runtime venv
// reports its own bundled checkout). Combined with the resolved HERMES_HOME it answers the
// only two questions that matter: which code, and which data.
//
// NOTE for the UI copy: `acp --check` is NOT a gate. It returns OK before the adapter's
// server module is imported (measured: a deliberately syntax-broken acp_adapter/server.py
// still passed `--check`), so a passing check says "the pieces are installed", not "a
// session will start". The honest gate is to create a session and run one empty turn.

export interface BackendInspect {
  ok: boolean;
  id: string;
  cmd: string;
  resolved: string | null;
  args: string[];
  home: string | null;
  homeExists: boolean;
  homeEntries: number | null;
  stateDb: { path: string; bytes: number; mtime: number } | null;
  profile: string | null;
  envKeys: string[];
  version: string | null;
  installDir: string | null;
  acpCheck: { ok: boolean; output: string } | null;
  warnings: string[];
  error: string | null;
  /** structured verdict — what the UI stores, colour-codes and turns into advice */
  status: CheckStatus;
  errorCode: CheckErrorCode | null;
  guidance: string | null;
  latencyMs: number;
}

async function probe(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ ok: boolean; out: string; timedOut: boolean }> {
  try {
    const { stdout, stderr } = await run(cmd, args, { env, timeout: timeoutMs, maxBuffer: 4 << 20 });
    return { ok: true, out: `${stdout}${stderr}`.trim(), timedOut: false };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string; killed?: boolean; signal?: string };
    return {
      ok: false,
      out: `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || String(err.message ?? e),
      timedOut: Boolean(err.killed) || err.signal === "SIGTERM",
    };
  }
}

function resolveCmd(cmd: string): string | null {
  const expanded = expandHome(cmd);
  if (expanded.includes("/")) return fs.existsSync(expanded) ? expanded : null;
  for (const dir of (process.env.PATH || "").split(":")) {
    if (!dir) continue;
    const p = path.join(dir, expanded);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* keep looking */ }
  }
  return null;
}

function firstMatch(text: string, re: RegExp): string | null {
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

export async function inspectRow(row: BackendRow, timeoutMs = 30_000): Promise<BackendInspect> {
  const started = Date.now();
  const plan = planFor(row);
  const args = effectiveArgs(row);
  const result: BackendInspect = {
    ok: false,
    id: row.id,
    cmd: row.cmd,
    resolved: resolveCmd(row.cmd),
    args,
    home: plan.home,
    homeExists: false,
    homeEntries: null,
    stateDb: null,
    profile: row.profile,
    envKeys: Object.keys(row.env ?? {}),
    version: null,
    installDir: null,
    acpCheck: null,
    warnings: plan.warnings,
    error: null,
    status: "unchecked",
    errorCode: null,
    guidance: null,
    latencyMs: 0,
  };

  if (plan.home) {
    try {
      result.homeExists = fs.existsSync(plan.home) && fs.statSync(plan.home).isDirectory();
      if (result.homeExists) result.homeEntries = fs.readdirSync(plan.home).length;
      const db = path.join(plan.home, "state.db");
      if (fs.existsSync(db)) {
        const st = fs.statSync(db);
        result.stateDb = { path: db, bytes: st.size, mtime: st.mtimeMs };
      }
    } catch { /* a home we cannot stat is worth reporting as "not there" */ }
  }

  let env: NodeJS.ProcessEnv;
  try {
    env = buildSpawnEnv(rowToSpec(row)).env;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    result.status = "offline";
    result.errorCode = "spawn_failed";
    result.guidance = ERROR_GUIDANCE.spawn_failed;
    result.latencyMs = Date.now() - started;
    return result;
  }

  if (!result.resolved) {
    result.error = `command not found: ${row.cmd}`;
    result.status = "missing";
    result.errorCode = "command_not_found";
    result.guidance = ERROR_GUIDANCE.command_not_found;
    result.latencyMs = Date.now() - started;
    return result;
  }

  const v = await probe(result.resolved, ["--version"], env, timeoutMs);
  if (v.ok) {
    result.version = v.out.split("\n")[0] ?? null;
    result.installDir = firstMatch(v.out, /^Install directory:\s*(.+)$/m);
  } else {
    result.error = `--version failed: ${v.out.split("\n").slice(0, 3).join(" / ")}`;
    result.errorCode = v.timedOut ? "timeout" : classifyMessage(v.out, "version_failed");
  }

  if (row.kind === "hermes") {
    const c = await probe(result.resolved, [...args.slice(0, -1), "acp", "--check"], env, timeoutMs);
    result.acpCheck = { ok: c.ok && /ACP check OK/i.test(c.out), output: c.out.split("\n").slice(-3).join(" / ") };
    if (!result.acpCheck.ok && !result.errorCode) {
      result.error = result.error ?? `acp --check failed: ${result.acpCheck.output}`;
      result.errorCode = c.timedOut ? "timeout" : classifyMessage(c.out, "acp_check_failed");
    }
  }

  result.ok = Boolean(result.version) && (result.acpCheck?.ok ?? true);
  result.status = result.ok ? "online" : "offline";
  if (!result.ok && !result.errorCode) result.errorCode = "unknown";
  result.guidance = result.errorCode ? ERROR_GUIDANCE[result.errorCode] : null;
  result.latencyMs = Date.now() - started;
  return result;
}

/**
 * The cheap, side-effect-free half of inspectRow: does the command resolve at all? Used by the
 * boot sweep, which must never spawn anything (a real check belongs to the 探测 button and, for
 * proof, to a session).
 */
export function startupCheck(row: BackendRow): BackendHealth {
  const started = Date.now();
  const resolved = resolveCmd(row.cmd);
  if (!resolved) {
    return checkedHealth(row.health, {
      status: "missing", kind: "startup", errorCode: "command_not_found",
      message: `command not found: ${row.cmd}`, latencyMs: Date.now() - started,
    });
  }
  return checkedHealth(row.health, {
    status: "online", kind: "startup", message: resolved, latencyMs: Date.now() - started,
  });
}

/**
 * The handshake a live session observed, shaped for the row. `modes`/`configOptions`/`models`
 * are passed through defensively: the SDK types cover only part of what the wire carries.
 */
export function handshakeFrom(
  init: unknown,
  session: unknown,
  now = Date.now(),
): BackendHandshake {
  const i = (init ?? {}) as { protocolVersion?: number; agentCapabilities?: Record<string, unknown> };
  const caps = (i.agentCapabilities ?? {}) as {
    loadSession?: boolean;
    sessionCapabilities?: { fork?: unknown };
  };
  const s = (session ?? {}) as {
    modes?: { currentModeId?: string; availableModes?: { id: string }[] } | null;
    configOptions?: { id: string; name?: string; currentValue?: unknown }[] | null;
    models?: { currentModelId?: string; availableModels?: { modelId?: string; id?: string }[] } | null;
    availableCommands?: { name: string }[] | null;
  };
  const modes = s.modes
    ? {
        currentModeId: s.modes.currentModeId ?? null,
        available: (s.modes.availableModes ?? []).map((m) => m.id),
      }
    : null;
  const models = s.models
    ? {
        currentModelId: s.models.currentModelId ?? null,
        available: (s.models.availableModels ?? []).map((m) => m.modelId ?? m.id ?? "").filter(Boolean),
      }
    : null;
  return {
    at: now,
    protocolVersion: typeof i.protocolVersion === "number" ? i.protocolVersion : null,
    loadSession: typeof caps.loadSession === "boolean" ? caps.loadSession : null,
    fork: caps.sessionCapabilities ? Boolean(caps.sessionCapabilities.fork) : null,
    modes,
    configOptions: (s.configOptions ?? []).map((o) => ({
      id: o.id,
      name: o.name ?? null,
      currentValue: o.currentValue === undefined || o.currentValue === null ? null : String(o.currentValue),
    })),
    models,
    commands: (s.availableCommands ?? []).map((c) => c.name),
  };
}
