// Backend registry (M6) — asserts that "which hermes" is a row the operator owns, and that a row
// naming its own home gets exactly that home while a row with none falls back to the default (the
// operator's real ~/.hermes). The early-dev isolation guard — the `blocked` state, the row's
// `allowLiveHome` tick and AGENTUS_ALLOW_LIVE_HOME — is gone.
//
//   node scripts/backend-registry-smoke.mjs
//
// Self-contained: spawns its own server on a free port with a throwaway data dir (see
// auth-smoke.mjs for the boot/kill rationale), then:
//   1. the builtin rows are seeded, so an existing cockpit is unchanged;
//   2. a row can point at a DIFFERENT command + code tree + home + profile;
//   3. /inspect answers "which tree does this row actually run" (the `Install directory:` line);
//   4. a real slot spawned from that row gets exactly that PYTHONPATH + HERMES_HOME;
//   5. a row aimed at the operator's real home is ALLOWED and spawns (no guard, no switch);
//   6. a row that sessions still name cannot be deleted;
//   7. health is a PERSISTED snapshot carrying a structured code, at three depths
//      (startup = resolves on PATH, manual = --version/acp --check, session = a real slot), so a
//      failure survives the panel that found it;
//   8. a real session also caches the ACP handshake on the row;
//   9. editing a spawn-relevant field invalidates that evidence; editing a note does not.
//
// Runs anywhere: the checks that need the operator's `hermes` (or their source fork) are shipped
// only where those exist and are announced as `skip`; everything else — including the session-kind
// health and the handshake, via the in-repo mock agent — is covered on a bare CI runner too.
import { spawn, execFileSync } from "node:child_process";
import fs, { mkdtempSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { createServer as createTcp } from "node:net";

const ROOT = path.resolve(import.meta.dirname, "..");
// What the QA row should run. Default = the operator's own setup on this box: the installed
// `hermes` (Studio runtime) with PYTHONPATH at the source fork. Override on any other machine.
const HERMES_CMD = process.env.AGENTUS_QA_HERMES_CMD || "hermes";
const FORK = process.env.AGENTUS_QA_FORK || path.join(homedir(), "Project/hermes-agent");
const LIVE_HOME = path.join(homedir(), ".hermes");

const killGroup = (target) => {
  const pid = typeof target === "number" ? target : target?.pid;
  if (!pid) return;
  try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
};

const results = [];
let failed = 0;
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((res, rej) => {
    const s = createTcp();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

const CHILDREN = new Set();
process.on("exit", () => { for (const c of CHILDREN) killGroup(c); });

async function boot(port, dataDir) {
  const child = spawn(
    path.join(ROOT, "node_modules/.bin/tsx"),
    ["packages/server/src/index.ts"],
    {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_ENV: "development",
        AGENTUS_PORT: String(port),
        AGENTUS_DATA: dataDir,
        AGENTUS_AUTH: "on",
        // keep the QA server off the operator's voice endpoints
        AGENTUS_STT_BASE_URL: "",
        AGENTUS_TTS_BASE_URL: "",
      },
    },
  );
  CHILDREN.add(child);
  let log = "";
  child.stdout.on("data", (b) => { log += b.toString(); });
  child.stderr.on("data", (b) => { log += b.toString(); });
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return { child, log: () => log };
    } catch { /* not up yet */ }
  }
  throw new Error(`server did not come up on :${port}\n${log}`);
}

/** A child's environment. Linux: `/proc/<pid>/environ` is exact (NUL-separated) — procps' `ps eww`
 *  does NOT dump the environment, which is why the BSD-only call below cannot be the only path.
 *  macOS: `ps eww`. Either may lose the process to a race; both then return {}. */
function psEnv(pid) {
  const env = {};
  const absorb = (text) => {
    for (const part of text.split(text.includes("\0") ? "\0" : " ")) {
      const m = part.match(/^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/);
      if (m) env[m[1]] = m[2];
    }
  };
  try {
    absorb(fs.readFileSync(`/proc/${pid}/environ`, "utf8"));
    if (Object.keys(env).length) return env;
  } catch { /* not Linux, or gone */ }
  try {
    absorb(execFileSync("ps", ["eww", String(pid)], { encoding: "utf8" }));
  } catch { /* gone */ }
  return env;
}

/** Is a command runnable on THIS machine? A bare CI runner has neither the operator's `hermes`
 *  nor their source fork, so checks that need one are shipped only where they exist — and
 *  everything provable without an external CLI (registry CRUD, the home rule, session-kind
 *  health + the handshake via the in-repo mock agent) runs everywhere. Skips are announced. */
function commandResolves(cmd) {
  const bin = cmd.split(" ")[0];
  if (bin.includes("/")) return fs.existsSync(bin);
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, bin))) return true;
  }
  return false;
}

const LOCAL = {
  hermes: commandResolves(HERMES_CMD),
  fork: fs.existsSync(path.join(FORK, "acp_adapter/server.py")),
};
let skipped = 0;
function skip(name, why) {
  skipped++;
  console.log(`  skip  ${name} — ${why}`);
}

async function main() {
  const port = await freePort();
  const dataDir = mkdtempSync(path.join(tmpdir(), "agentus-backreg-"));
  const home = mkdtempSync(path.join(tmpdir(), "agentus-backreg-home-"));
  // Give the throwaway home a provider config the way the operator's own home has one: without it
  // the fork boots but cannot answer a session (and this suite is about the REGISTRY, not about
  // provider setup). Read-only on the source.
  for (const f of ["config.yaml", ".env"]) {
    const src = path.join(LIVE_HOME, f);
    if (fs.existsSync(src)) {
      try { fs.copyFileSync(src, path.join(home, f)); } catch { /* best effort */ }
    }
  }
  const { child, log } = await boot(port, dataDir);
  const base = `http://127.0.0.1:${port}`;
  const token = fs.readFileSync(path.join(dataDir, "auth.token"), "utf8").trim();
  const H = { Authorization: `Bearer ${token}`, "content-type": "application/json" };

  const api = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text };
  };

  try {
    // 1. seeded rows
    const list0 = await api("GET", "/api/backends");
    const ids = (list0.json ?? []).map((b) => b.id);
    check("builtin rows are seeded (hermes/qoder/mock present, cockpit unchanged)",
      ["hermes", "qoder", "mock"].every((x) => ids.includes(x)), ids.join(","));
    const hermes0 = (list0.json ?? []).find((b) => b.id === "hermes");
    check("a row carries cmd + home + kind + plan fields",
      Boolean(hermes0?.cmd && hermes0?.home && hermes0?.kind) && Array.isArray(hermes0?.warnings),
      `cmd=${hermes0?.cmd} home=${hermes0?.home}`);

    // 1b. health snapshot: the boot sweep is cheap evidence, so rows are never all "unchecked"
    let swept = null;
    for (let i = 0; i < 20 && !swept; i++) {
      const rows = (await api("GET", "/api/backends")).json ?? [];
      swept = rows.find((b) => b.health?.kind === "startup") ?? null;
      if (!swept) await sleep(500);
    }
    check("the boot sweep records a startup-kind health snapshot",
      Boolean(swept?.health?.at) && swept.health.kind === "startup",
      `row=${swept?.id} kind=${swept?.health?.kind}`);
    const hermesSwept = ((await api("GET", "/api/backends")).json ?? []).find((b) => b.id === "hermes");
    check("the sweep claims only what it measured (resolution on PATH, not a session)",
      hermesSwept?.health?.kind === "startup"
        && ["online", "missing"].includes(hermesSwept.health.status)
        && (hermesSwept.health.status !== "online" || String(hermesSwept.health.message ?? "").includes("/")),
      `status=${hermesSwept?.health?.status} msg=${hermesSwept?.health?.message}`);

    // 2. a row of our own: different command tree + its own home + profile
    const forkRow = {
      id: "qa-fork", label: "QA fork", kind: "hermes", cmd: HERMES_CMD, args: "acp",
      env: { PYTHONPATH: FORK }, home, profile: "default",
      // the row's default permission mode: asserted against the real adapter in 4c
      defaultMode: "dont_ask",
      notes: "smoke: fork tree + throwaway home",
    };
    const created = await api("POST", "/api/backends", forkRow);
    check("POST /api/backends creates a row", created.status === 201, `status=${created.status} ${created.text.slice(0, 120)}`);

    const listed = (await api("GET", "/api/backends")).json ?? [];
    const row = listed.find((b) => b.id === "qa-fork");
    check("the new row shows command / home / profile / env keys",
      row?.home === home && row?.profile === "default" && (row?.env ?? []).includes("PYTHONPATH"),
      `home=${row?.home} profile=${row?.profile} env=${(row?.env ?? []).join(",")}`);
    check("the new row is spawnable (nothing gated it)", !row?.blocked, String(row?.blocked ?? ""));

    // 3. inspect: which tree will it actually run? (needs the operator's hermes to exist)
    if (LOCAL.hermes && LOCAL.fork) {
      const insp = await api("POST", "/api/backends/qa-fork/inspect");
      check("inspect resolves the command", Boolean(insp.json?.resolved), String(insp.json?.resolved));
      check("inspect names the code tree (Install directory = the PYTHONPATH tree)",
        typeof insp.json?.installDir === "string" && insp.json.installDir === FORK,
        `installDir=${insp.json?.installDir}`);
      check("inspect reports the home the row named (and that it is empty)", insp.json?.home === home && insp.json?.stateDb === null,
        `home=${insp.json?.home} stateDb=${insp.json?.stateDb ? "present" : "none"}`);
      check("inspect ran acp --check", insp.json?.acpCheck?.ok === true, String(insp.json?.acpCheck?.output ?? "").slice(0, 120));

      // 3b. the verdict is PERSISTED, with a code the UI can act on
      const afterInsp = ((await api("GET", "/api/backends")).json ?? []).find((b) => b.id === "qa-fork");
      check("a manual probe is written back onto the row (kind=manual)",
        afterInsp?.health?.kind === "manual" && Boolean(afterInsp.health.at),
        `kind=${afterInsp?.health?.kind} at=${afterInsp?.health?.at}`);
      check("a healthy probe reads online with no error code",
        afterInsp?.health?.status === "online" && !afterInsp.health.errorCode,
        `status=${afterInsp?.health?.status} code=${afterInsp?.health?.errorCode}`);
      check("the probe records how long it took",
        typeof afterInsp?.health?.latencyMs === "number" && afterInsp.health.latencyMs >= 0,
        String(afterInsp?.health?.latencyMs));
      check("the inspect report carries the same structured verdict",
        insp.json?.status === "online" && insp.json?.errorCode === null && typeof insp.json?.latencyMs === "number",
        `status=${insp.json?.status} code=${insp.json?.errorCode} ms=${insp.json?.latencyMs}`);
    } else {
      skip("manual probe of a hermes row",
        `no ${HERMES_CMD}${LOCAL.fork ? "" : ` and no source tree at ${FORK}`} on this machine`);
    }

    // 3c. a missing command is a CODE plus advice, not a sentence to parse
    await api("POST", "/api/backends", {
      id: "qa-missing", label: "QA missing", kind: "hermes",
      cmd: "definitely-not-a-real-binary-9f3a", args: "acp",
    });
    const missInsp = await api("POST", "/api/backends/qa-missing/inspect");
    check("a command that does not resolve is reported missing/command_not_found",
      missInsp.json?.status === "missing" && missInsp.json?.errorCode === "command_not_found",
      `status=${missInsp.json?.status} code=${missInsp.json?.errorCode}`);
    check("a failure ships with guidance the operator can act on",
      Boolean(missInsp.json?.guidance), String(missInsp.json?.guidance ?? "").slice(0, 50));
    const missRow = ((await api("GET", "/api/backends")).json ?? []).find((b) => b.id === "qa-missing");
    check("the failure is persisted, so it outlives the panel that found it",
      missRow?.health?.status === "missing" && missRow.health.errorCode === "command_not_found"
        && Boolean(missRow.health.lastFailureAt),
      `status=${missRow?.health?.status} lastFailureAt=${missRow?.health?.lastFailureAt}`);

    // 4. a real slot, with no external CLI involved: the in-repo mock agent speaks ACP, so the
    //    whole spawn → ready → session-kind health → handshake path is covered on any machine.
    await api("POST", "/api/backends", {
      id: "qa-mock", label: "QA mock", kind: "mock", cmd: process.execPath,
      args: [path.join(ROOT, "packages/server/mock/agent.mjs")],
      notes: "smoke: in-repo ACP mock (no external CLI needed)",
    });
    const sess = await api("POST", "/api/sessions", { backend: "qa-mock", cwd: tmpdir(), title: "backend registry smoke" });
    check("POST /api/sessions accepts a registry row id", sess.status === 201, `status=${sess.status} ${sess.text.slice(0, 160)}`);
    const sid = sess.json?.id;
    let liveRow = null;
    for (let i = 0; i < 90 && !liveRow; i++) {
      await sleep(1000);
      const live = (await api("GET", "/api/sessions")).json?.live ?? [];
      liveRow = live.find((s) => s.id === sid) ?? null;
      if (liveRow && liveRow.status !== "starting") break;
    }
    check("the slot reached a non-starting state", Boolean(liveRow) && liveRow.status !== "starting",
      `status=${liveRow?.status} ${liveRow?.lastError ?? ""}`);

    // 4b. session-kind health + handshake, recorded on the ROW (not on the session)
    const mockAfter = ((await api("GET", "/api/backends")).json ?? []).find((b) => b.id === "qa-mock");
    check("a real slot records a session-kind check on its row",
      mockAfter?.health?.kind === "session" && mockAfter.health.status === "online",
      `kind=${mockAfter?.health?.kind} status=${mockAfter?.health?.status}`);
    check("the session check keeps how long the row took to reach ready",
      typeof mockAfter?.health?.latencyMs === "number" && mockAfter.health.latencyMs > 0,
      String(mockAfter?.health?.latencyMs));
    check("the row now carries the ACP handshake the agent advertised",
      Boolean(mockAfter?.handshake?.at) && Array.isArray(mockAfter.handshake.configOptions),
      `at=${mockAfter?.handshake?.at} options=${(mockAfter?.handshake?.configOptions ?? []).length}`);
    check("the cached handshake is the real one (protocol v1, capability flags, modes)",
      mockAfter?.handshake?.protocolVersion === 1
        && typeof mockAfter.handshake.loadSession === "boolean"
        && Array.isArray(mockAfter.handshake.commands),
      `protocol=${mockAfter?.handshake?.protocolVersion} load=${mockAfter?.handshake?.loadSession} modes=${Boolean(mockAfter?.handshake?.modes)}`);

    // 4b. the row's DEFAULT permission mode — 「在智能体设置中设置默认选中权限」. The mock advertises
    //     three modes (default / accept_edits / dont_ask) and implements setSessionMode, so the whole
    //     create-time path is provable here with no token and no real agent. What matters is not that
    //     the mode can be set (the session popover does that) but WHERE it applies: a NEW session
    //     only, never over a conversation's own pick.
    check("a row that names no default sends nothing (the agent's own mode survives)",
      mockAfter?.defaultMode === null || mockAfter?.defaultMode === undefined,
      `defaultMode=${JSON.stringify(mockAfter?.defaultMode)}`);
    check("the cached handshake carries mode NAMES too (the settings picker offers these)",
      typeof mockAfter?.handshake?.modes?.names?.dont_ask === "string",
      JSON.stringify(mockAfter?.handshake?.modes?.names ?? null));

    const mkSession = async (backend, title) => {
      const r = await api("POST", "/api/sessions", { backend, cwd: tmpdir(), title });
      if (r.status !== 201) return { r, live: null };
      const id = r.json?.id;
      let live = null;
      for (let i = 0; i < 90 && !live; i++) {
        await sleep(1000);
        live = ((await api("GET", "/api/sessions")).json?.live ?? []).find((s) => s.id === id) ?? null;
        if (live && live.status !== "starting") break;
      }
      return { r, live };
    };

    const created2 = await api("POST", "/api/backends", {
      id: "qa-mode", label: "QA default mode", kind: "mock", cmd: process.execPath,
      args: [path.join(ROOT, "packages/server/mock/agent.mjs")],
      defaultMode: "dont_ask", notes: "smoke: default permission mode",
    });
    check("a row can be created with a default permission mode", created2.status === 201,
      `status=${created2.status} ${created2.text.slice(0, 120)}`);
    const modeRow = ((await api("GET", "/api/backends")).json ?? []).find((b) => b.id === "qa-mode");
    check("...and it round-trips through GET /api/backends", modeRow?.defaultMode === "dont_ask",
      `defaultMode=${modeRow?.defaultMode}`);

    const s1 = await mkSession("qa-mode", "default mode smoke");
    check("a NEW session comes up in the row's default permission mode",
      s1.live?.modes?.currentModeId === "dont_ask" && s1.r.json?.modes?.currentModeId === "dont_ask",
      `live=${s1.live?.modes?.currentModeId} create=${s1.r.json?.modes?.currentModeId} ${s1.live?.lastError ?? ""}`);

    // The per-session pick wins, and resuming must NOT re-apply the row default over it — the failure
    // this checks for is a default that silently overwrites what a conversation was already using.
    const pick = await api("POST", `/api/sessions/${s1.live?.id}/mode`, { modeId: "accept_edits" });
    check("the session's own permission pick still wins", pick.status === 200,
      `status=${pick.status} ${pick.text.slice(0, 100)}`);
    await api("DELETE", `/api/sessions/${s1.live?.id}`);
    await sleep(800);
    const rs = await api("POST", `/api/sessions/${s1.live?.id}/resume`);
    check("the archived slot resumes", rs.status === 200, `status=${rs.status} ${rs.text.slice(0, 120)}`);
    let rLive = null;
    for (let i = 0; i < 90 && !rLive; i++) {
      await sleep(1000);
      rLive = ((await api("GET", "/api/sessions")).json?.live ?? []).find((s) => s.id === s1.live?.id) ?? null;
      if (rLive && rLive.status !== "starting") break;
    }
    check("a resumed session keeps ITS pick (the row default is not re-applied)",
      rLive?.modes?.currentModeId === "accept_edits",
      `mode=${rLive?.modes?.currentModeId} status=${rLive?.status} ${rLive?.lastError ?? ""}`);
    await api("DELETE", `/api/sessions/${s1.live?.id}`);

    // A pick this agent never advertised must not be sent (that would be a refusal nobody can see) —
    // and the row has to SAY so, which is the whole difference between "inert" and "silently broken".
    await api("PATCH", "/api/backends/qa-mode", { defaultMode: "no_such_mode" });
    const warned = ((await api("GET", "/api/backends")).json ?? []).find((b) => b.id === "qa-mode");
    check("a default the agent never advertised is called out on the row",
      (warned?.warnings ?? []).some((w) => String(w).includes("no_such_mode")),
      JSON.stringify(warned?.warnings ?? []));
    check("editing the default mode keeps the row's handshake (it is not a spawn-relevant field)",
      Boolean(warned?.handshake?.at), `handshake=${Boolean(warned?.handshake?.at)}`);
    const s2 = await mkSession("qa-mode", "unadvertised default mode");
    check("...and it is NOT sent (the session comes up in the agent's own mode)",
      s2.live?.modes?.currentModeId === "default",
      `mode=${s2.live?.modes?.currentModeId} status=${s2.live?.status} ${s2.live?.lastError ?? ""}`);
    await api("DELETE", `/api/sessions/${s2.live?.id}`);
    await sleep(500);
    const delMode = await api("DELETE", "/api/backends/qa-mode");
    check("the default-mode row deletes once its sessions are gone", delMode.status === 200,
      `status=${delMode.status} ${delMode.text.slice(0, 100)}`);

    // 4c. a row that really spawns the operator's tree (only where that tree exists)
    if (LOCAL.hermes) {
      const hs = await api("POST", "/api/sessions", { backend: "qa-fork", cwd: tmpdir(), title: "hermes row smoke" });
      check("a hermes row spawns too", hs.status === 201, `status=${hs.status} ${hs.text.slice(0, 140)}`);
      const hid = hs.json?.id;
      let hLive = null;
      for (let i = 0; i < 90 && !hLive; i++) {
        await sleep(1000);
        hLive = ((await api("GET", "/api/sessions")).json?.live ?? []).find((s) => s.id === hid) ?? null;
        if (hLive && hLive.status !== "starting") break;
      }
      check("the hermes slot reached a non-starting state", Boolean(hLive) && hLive.status !== "starting",
        `status=${hLive?.status} ${hLive?.lastError ?? ""}`);
      // The REAL adapter contract for the round's feature: a hermes session created from a row that
      // names a default permission mode comes up in it. Judgeable only against what THIS hermes
      // advertises (an older runtime may offer no modes at all), so it is asserted, not assumed.
      const forkModes = ((await api("GET", "/api/backends")).json ?? []).find((b) => b.id === "qa-fork")?.handshake?.modes;
      if (forkModes?.available?.includes("dont_ask")) {
        check("a real hermes session comes up in the row's default permission mode",
          hLive?.modes?.currentModeId === "dont_ask", `mode=${hLive?.modes?.currentModeId}`);
        check("...and the row keeps it across the create (the setting is not consumed)",
          ((await api("GET", "/api/backends")).json ?? []).find((b) => b.id === "qa-fork")?.defaultMode === "dont_ask",
          "qa-fork.defaultMode");
      } else {
        skip("the hermes default-permission-mode check",
          `this hermes advertises modes: ${JSON.stringify(forkModes?.available ?? null)}`);
      }
      const env = hLive?.pid ? psEnv(hLive.pid) : {};
      // The home is the isolation proof that must hold every time (the child writes there, not into
      // the live runtime). PYTHONPATH is printed, not asserted: the hermes CLI may drop it while
      // re-execing into its own interpreter, so "which tree" is answered by the option check below.
      console.log(`  info  hermes child env: HERMES_HOME=${env.HERMES_HOME ?? "(unset)"} PYTHONPATH=${env.PYTHONPATH ?? "(unset)"}`);
      check("the spawned child really got HERMES_HOME = the row's home", env.HERMES_HOME === home, String(env.HERMES_HOME ?? "(unset)"));
      const forkHasEffort = LOCAL.fork
        && fs.readFileSync(path.join(FORK, "acp_adapter/server.py"), "utf8").includes("_REASONING_EFFORT_CONFIG_ID");
      if (forkHasEffort) {
        const optIds = (hLive?.configOptions ?? []).map((c) => c.id);
        check("the slot imported the code tree the row named (it advertises that tree's fork-only ACP option)",
          optIds.includes("reasoning_effort"), `configOptions=${optIds.join(",") || "(none)"}`);
      } else {
        skip("fork-only option check", `${FORK}/acp_adapter/server.py has no marker`);
      }
      // closed before the delete-rule checks below, which use the mock row
      await api("DELETE", `/api/sessions/${hid}`);
    } else {
      skip("spawning a hermes row", `no ${HERMES_CMD} on this machine`);
    }

    // 5. a row aimed at the operator's REAL home is normal now — the early-dev isolation guard
    //    (and its AGENTUS_ALLOW_LIVE_HOME / `allowLiveHome` escape hatches) is gone. Proven
    //    without touching the real state.db: the row runs the in-repo mock agent under
    //    HERMES_HOME=~/.hermes, and the mock never opens a database, so this asserts "it is no
    //    longer refused" and "the home still reaches the child" — and nothing more.
    await api("POST", "/api/backends", {
      id: "qa-live", label: "QA live", kind: "hermes", cmd: process.execPath,
      args: [path.join(ROOT, "packages/server/mock/agent.mjs")], home: LIVE_HOME,
      notes: "smoke: the operator's real home is an ordinary choice now",
    });
    const liveListed = ((await api("GET", "/api/backends")).json ?? []).find((b) => b.id === "qa-live");
    check("a row aimed at the operator's real home is no longer refused",
      liveListed !== undefined && !liveListed.blocked,
      `blocked=${String(liveListed?.blocked ?? "(field is gone)")}`);
    check("...and the row keeps the home it named", liveListed?.home === LIVE_HOME, String(liveListed?.home));
    const liveSpawn = await api("POST", "/api/sessions", { backend: "qa-live", cwd: tmpdir(), title: "real home row" });
    check("...and it spawns like any other row", liveSpawn.status === 201,
      `status=${liveSpawn.status} ${liveSpawn.text.slice(0, 140)}`);
    if (liveSpawn.status === 201) {
      const lsid = liveSpawn.json?.id;
      let lLive = null;
      for (let i = 0; i < 60 && !lLive; i++) {
        await sleep(1000);
        lLive = ((await api("GET", "/api/sessions")).json?.live ?? []).find((s) => s.id === lsid) ?? null;
        if (lLive && lLive.status !== "starting") break;
      }
      const lenv = lLive?.pid ? psEnv(lLive.pid) : {};
      check("...with HERMES_HOME still set explicitly to that home",
        lenv.HERMES_HOME === LIVE_HOME, String(lenv.HERMES_HOME ?? "(unset)"));
      await api("DELETE", `/api/sessions/${lsid}`);
    } else {
      skip("spawning a row aimed at the operator's real home", `POST /api/sessions returned ${liveSpawn.status}`);
    }

    // 5b. a command that does not exist must fail FAST and cleanly. `spawn` reports ENOENT through
    //     an 'error' event (not a throw) and leaves no pid, so without the guard this is an uncaught
    //     exception and a caller waiting on a handshake that can never arrive.
    const badSpawn = await api("POST", "/api/sessions", { backend: "qa-missing", cwd: tmpdir(), title: "bad command" });
    check("spawning a row whose command is missing fails cleanly",
      badSpawn.status >= 400 && /failed to spawn|ENOENT/.test(badSpawn.text),
      `status=${badSpawn.status} ${badSpawn.text.slice(0, 120)}`);
    const badRow = ((await api("GET", "/api/backends")).json ?? []).find((b) => b.id === "qa-missing");
    check("...and the row records it as spawn_failed (session-kind)",
      badRow?.health?.errorCode === "spawn_failed" && badRow.health.kind === "session",
      `code=${badRow?.health?.errorCode} kind=${badRow?.health?.kind}`);

    // 6. a row in use cannot be deleted (its sessions would be orphaned)
    const del = await api("DELETE", "/api/backends/qa-mock");
    check("DELETE refuses a row that sessions still name", del.status === 409, `status=${del.status} ${del.text.slice(0, 120)}`);

    // 7. evidence is invalidated by a spawn-relevant edit — and only by one
    await api("PATCH", "/api/backends/qa-mock", { notes: "smoke: renamed a note" });
    const keptRow = ((await api("GET", "/api/backends")).json ?? []).find((b) => b.id === "qa-mock");
    check("editing only a note keeps the health + handshake evidence",
      keptRow?.health?.kind === "session" && Boolean(keptRow?.handshake?.at),
      `kind=${keptRow?.health?.kind} handshake=${Boolean(keptRow?.handshake?.at)}`);
    await api("PATCH", "/api/backends/qa-mock", { args: [path.join(ROOT, "packages/server/mock/agent.mjs")] });
    const clearedRow = ((await api("GET", "/api/backends")).json ?? []).find((b) => b.id === "qa-mock");
    check("changing the spawn definition clears the stale evidence",
      clearedRow?.health?.at === null && clearedRow?.health?.status === "unchecked",
      `at=${clearedRow?.health?.at} status=${clearedRow?.health?.status}`);
    check("clearing also drops the handshake (it described the old definition)",
      !clearedRow?.handshake, `handshake=${Boolean(clearedRow?.handshake)}`);

    // cleanup the session, then the rows delete cleanly
    await api("DELETE", `/api/sessions/${sid}`);
    await sleep(500);
    const del2 = await api("DELETE", "/api/backends/qa-mock");
    check("DELETE works once the session is gone", del2.status === 200, `status=${del2.status} ${del2.text.slice(0, 120)}`);
    const del3 = await api("DELETE", "/api/backends/qa-live");
    check("the real-home row deletes once its session is gone", del3.status === 200, `status=${del3.status}`);
    const del4 = await api("DELETE", "/api/backends/qa-missing");
    check("a row that only ever failed can be deleted too", del4.status === 200, `status=${del4.status}`);
    const del5 = await api("DELETE", "/api/backends/qa-fork");
    check("the hermes row deletes once nothing runs on it", del5.status === 200, `status=${del5.status} ${del5.text.slice(0, 100)}`);
  } finally {
    killGroup(child);
    if (failed) {
      console.log(`\n--- server log (tail) ---\n${log().split("\n").slice(-25).join("\n")}`);
    }
    console.log(`\n${failed ? `${failed} check(s) FAILED` : "all checks passed"}  (${results.length} checks${skipped ? `, ${skipped} skipped — needs the operator's CLI/source tree` : ""})`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
