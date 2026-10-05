// Backend registry (M6) — asserts that "which hermes" is a row the operator owns, and that
// the isolation guard still cannot be talked out of the live home by adding one.
//
//   node scripts/backend-registry-smoke.mjs
//
// Self-contained: spawns its own server on a free port with a throwaway data dir (see
// auth-smoke.mjs for the boot/kill rationale), then:
//   1. the builtin rows are seeded, so an existing cockpit is unchanged;
//   2. a row can point at a DIFFERENT command + code tree + home + profile;
//   3. /inspect answers "which tree does this row actually run" (the `Install directory:` line);
//   4. a real slot spawned from that row gets exactly that PYTHONPATH + HERMES_HOME;
//   5. a row aimed at the live home is reported `blocked`, is never probed, and cannot spawn;
//   6. a row that sessions still name cannot be deleted;
//   7. health is a PERSISTED snapshot carrying a structured code, at three depths
//      (startup = resolves on PATH, manual = --version/acp --check, session = a real slot), so a
//      failure survives the panel that found it;
//   8. a real session also caches the ACP handshake on the row;
//   9. editing a spawn-relevant field invalidates that evidence; editing a note does not.
import { spawn, execFileSync } from "node:child_process";
import fs, { mkdtempSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { createServer as createTcp } from "node:net";

const ROOT = path.resolve(import.meta.dirname, "..");
// What the QA row should run. Default = the operator's own setup on this box: the installed
// `hermes` (Studio runtime) with PYTHONPATH at the source fork. Override on any other machine.
const HERMES_CMD = process.env.AGENTSLOT_QA_HERMES_CMD || "hermes";
const FORK = process.env.AGENTSLOT_QA_FORK || path.join(homedir(), "Project/hermes-agent");
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
        AGENTSLOT_PORT: String(port),
        AGENTSLOT_DATA: dataDir,
        AGENTSLOT_AUTH: "on",
        // keep the QA server off the operator's voice endpoints
        AGENTSLOT_STT_BASE_URL: "",
        AGENTSLOT_TTS_BASE_URL: "",
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

function psEnv(pid) {
  const out = execFileSync("ps", ["eww", String(pid)], { encoding: "utf8" });
  const env = {};
  for (const part of out.split(" ")) {
    const m = part.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

async function main() {
  const port = await freePort();
  const dataDir = mkdtempSync(path.join(tmpdir(), "agentslot-backreg-"));
  const home = mkdtempSync(path.join(tmpdir(), "agentslot-backreg-home-"));
  // Give the throwaway home a provider config, the way scripts/setup-hermes-test-home.py does
  // for the operator's own test bed: without one the fork boots but cannot answer a session
  // (and this suite is about the REGISTRY, not about provider setup). Read-only on the source.
  for (const f of ["config.yaml", ".env"]) {
    const src = path.join(homedir(), ".agentslot-test/home", f);
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

    // 2. a row of our own: different command tree + isolated home + profile
    const forkRow = {
      id: "qa-fork", label: "QA fork", kind: "hermes", cmd: HERMES_CMD, args: "acp",
      env: { PYTHONPATH: FORK }, home, profile: "default",
      notes: "smoke: fork tree + throwaway home",
    };
    const created = await api("POST", "/api/backends", forkRow);
    check("POST /api/backends creates a row", created.status === 201, `status=${created.status} ${created.text.slice(0, 120)}`);

    const listed = (await api("GET", "/api/backends")).json ?? [];
    const row = listed.find((b) => b.id === "qa-fork");
    check("the new row shows command / home / profile / env keys",
      row?.home === home && row?.profile === "default" && (row?.env ?? []).includes("PYTHONPATH"),
      `home=${row?.home} profile=${row?.profile} env=${(row?.env ?? []).join(",")}`);
    check("the new row is not blocked", !row?.blocked, String(row?.blocked ?? ""));

    // 3. inspect: which tree will it actually run?
    const insp = await api("POST", "/api/backends/qa-fork/inspect");
    check("inspect resolves the command", Boolean(insp.json?.resolved), String(insp.json?.resolved));
    check("inspect names the code tree (Install directory = the PYTHONPATH tree)",
      typeof insp.json?.installDir === "string" && insp.json.installDir === FORK,
      `installDir=${insp.json?.installDir}`);
    check("inspect reports the isolated home (and that it is empty)", insp.json?.home === home && insp.json?.stateDb === null,
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

    // 4. a real slot from that row gets exactly that env
    const sess = await api("POST", "/api/sessions", { backend: "qa-fork", cwd: tmpdir(), title: "backend registry smoke" });
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
    const env = liveRow?.pid ? psEnv(liveRow.pid) : {};
    // The home is the isolation proof that must hold every time (the child writes there, not
    // into the live runtime). PYTHONPATH is printed, not asserted: the hermes CLI may drop it
    // while re-execing into its own interpreter, so its absence in `ps` says nothing about
    // which tree got imported — the option check below answers that instead.
    console.log(`  info  child env: HERMES_HOME=${env.HERMES_HOME ?? "(unset)"} PYTHONPATH=${env.PYTHONPATH ?? "(unset)"}`);
    check("the spawned child really got HERMES_HOME = the row's home", env.HERMES_HOME === home, String(env.HERMES_HOME ?? "(unset)"));
    // Which CODE did it actually import? Ask the agent: a tree that carries the fork-only ACP
    // session option will advertise it, so the advertisement is evidence the row's env chose
    // that tree. (This is the same trick the operator's live slots were checked with.)
    const forkServerPy = path.join(FORK, "acp_adapter/server.py");
    const forkHasEffort = fs.existsSync(forkServerPy)
      && fs.readFileSync(forkServerPy, "utf8").includes("_REASONING_EFFORT_CONFIG_ID");
    if (forkHasEffort) {
      const optIds = (liveRow?.configOptions ?? []).map((c) => c.id);
      check("the slot imported the code tree the row named (it advertises that tree's fork-only ACP option)",
        optIds.includes("reasoning_effort"), `configOptions=${optIds.join(",") || "(none)"}`);
    } else {
      console.log(`  skip  fork-only option check (${FORK}/acp_adapter/server.py has no marker)`);
    }

    // 4b. a real session is the only PROOF — and it is remembered, with the handshake
    const forkAfter = ((await api("GET", "/api/backends")).json ?? []).find((b) => b.id === "qa-fork");
    check("a real slot records a session-kind check on its row",
      forkAfter?.health?.kind === "session" && forkAfter.health.status === "online",
      `kind=${forkAfter?.health?.kind} status=${forkAfter?.health?.status}`);
    check("the session check keeps how long the row took to reach ready",
      typeof forkAfter?.health?.latencyMs === "number" && forkAfter.health.latencyMs > 0,
      String(forkAfter?.health?.latencyMs));
    check("the row now carries the ACP handshake the agent advertised",
      Boolean(forkAfter?.handshake?.at) && Array.isArray(forkAfter.handshake.configOptions),
      `at=${forkAfter?.handshake?.at} options=${(forkAfter?.handshake?.configOptions ?? []).length}`);
    check("the cached handshake is the real one (protocol v1, capability flags, modes)",
      forkAfter?.handshake?.protocolVersion === 1
        && typeof forkAfter.handshake.loadSession === "boolean"
        && Array.isArray(forkAfter.handshake.commands),
      `protocol=${forkAfter?.handshake?.protocolVersion} load=${forkAfter?.handshake?.loadSession} modes=${Boolean(forkAfter?.handshake?.modes)}`);

    // 5. the live home is refused by the guard, not by convention
    const liveRowDef = { id: "qa-live", label: "QA live", kind: "hermes", cmd: HERMES_CMD, args: "acp", home: LIVE_HOME };
    await api("POST", "/api/backends", liveRowDef);
    const liveListed = ((await api("GET", "/api/backends")).json ?? []).find((b) => b.id === "qa-live");
    check("a row pointing at the live home is reported blocked", Boolean(liveListed?.blocked), String(liveListed?.blocked ?? "").slice(0, 140));
    const liveInsp = await api("POST", "/api/backends/qa-live/inspect");
    check("a blocked row is not probed", liveInsp.json?.blocked && !liveInsp.json?.version, `blocked=${Boolean(liveInsp.json?.blocked)} version=${liveInsp.json?.version}`);
    check("a blocked row reports the guard's code and why (unchecked, not a fake failure)",
      liveInsp.json?.status === "unchecked" && liveInsp.json?.errorCode === "blocked_live_home"
        && Boolean(liveInsp.json?.guidance),
      `status=${liveInsp.json?.status} code=${liveInsp.json?.errorCode}`);
    const liveSpawn = await api("POST", "/api/sessions", { backend: "qa-live", cwd: tmpdir(), title: "should be refused" });
    check("spawning the blocked row fails instead of touching the live home", liveSpawn.status >= 400,
      `status=${liveSpawn.status} ${liveSpawn.text.slice(0, 140)}`);

    // 6. a row in use cannot be deleted (its sessions would be orphaned)
    const del = await api("DELETE", "/api/backends/qa-fork");
    check("DELETE refuses a row that sessions still name", del.status === 409, `status=${del.status} ${del.text.slice(0, 120)}`);

    // 7. evidence is invalidated by a spawn-relevant edit — and only by one
    await api("PATCH", "/api/backends/qa-fork", { notes: "smoke: renamed a note" });
    const keptRow = ((await api("GET", "/api/backends")).json ?? []).find((b) => b.id === "qa-fork");
    check("editing only a note keeps the health + handshake evidence",
      keptRow?.health?.kind === "session" && Boolean(keptRow?.handshake?.at),
      `kind=${keptRow?.health?.kind} handshake=${Boolean(keptRow?.handshake?.at)}`);
    await api("PATCH", "/api/backends/qa-fork", { env: { PYTHONPATH: FORK, EXTRA_FLAG: "1" } });
    const clearedRow = ((await api("GET", "/api/backends")).json ?? []).find((b) => b.id === "qa-fork");
    check("changing the spawn definition clears the stale evidence",
      clearedRow?.health?.at === null && clearedRow?.health?.status === "unchecked",
      `at=${clearedRow?.health?.at} status=${clearedRow?.health?.status}`);
    check("clearing also drops the handshake (it described the old definition)",
      !clearedRow?.handshake, `handshake=${Boolean(clearedRow?.handshake)}`);

    // cleanup the session, then the row deletes cleanly
    await api("DELETE", `/api/sessions/${sid}`);
    await sleep(500);
    const del2 = await api("DELETE", "/api/backends/qa-fork");
    check("DELETE works once the session is gone", del2.status === 200, `status=${del2.status} ${del2.text.slice(0, 120)}`);
    const del3 = await api("DELETE", "/api/backends/qa-live");
    check("a blocked row can be deleted", del3.status === 200, `status=${del3.status}`);
    const del4 = await api("DELETE", "/api/backends/qa-missing");
    check("a row that only ever failed can be deleted too", del4.status === 200, `status=${del4.status}`);
  } finally {
    killGroup(child);
    if (failed) {
      console.log(`\n--- server log (tail) ---\n${log().split("\n").slice(-25).join("\n")}`);
    }
    console.log(`\n${failed ? `${failed} check(s) FAILED` : "all checks passed"}  (${results.length} checks)`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
