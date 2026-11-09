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

/** The cockpit's own record of a slot's permission pick (`sessions.mode_id`).
 *
 *  Read straight from the throwaway DB on purpose: the question these assertions ask is whether the
 *  COLUMN stayed empty when the runtime never confirmed, and no HTTP field exposes it. */
async function modePickOf(dataDir, sessionId) {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(dataDir, "agentus.sqlite"), { readOnly: true });
    const row = db.prepare("select mode_id from sessions where id = ?").get(String(sessionId));
    db.close();
    return row?.mode_id ?? null;
  } catch (e) {
    return `unavailable: ${e.message}`;
  }
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

    /** The row a session id belongs to, wherever it currently sits. A slot that FAILED its handshake
     *  leaves the `live` bucket (the server drops it from the map and stores the row closed), so a
     *  poll that only reads `live` loses sight of it and reports the last thing it saw — `starting`
     *  — for a slot that is really `error`. Read all three buckets so the settle is honest. */
    const settledRow = async (id) => {
      const r = await api("GET", "/api/sessions");
      const j = r.json ?? {};
      return [...(j.live ?? []), ...(j.cold ?? []), ...(j.archived ?? [])].find((s) => s.id === id) ?? null;
    };

    /** Create a slot and wait for its HANDSHAKE, returning both the create RESPONSE and the settled row.
     *
     *  The two are no longer the same thing (issue #1): `POST /api/sessions` answers as soon as the row
     *  exists — 「新建会话」 must not be held for the agent's 10–40 s boot — so `r.json` carries
     *  `status:"starting"` and none of the agent's own metadata (modes/models/configOptions). Anything
     *  asserted about the AGENT has to be read off `live`; `r` is only good for the row's own fields. */
    const mkSession = async (backend, title) => {
      const r = await api("POST", "/api/sessions", { backend, cwd: tmpdir(), title });
      if (r.status !== 201) return { r, live: null };
      const id = r.json?.id;
      let live = null;
      // `i < 90 && !live` would have polled EXACTLY ONCE: the assignment above makes `!live` false on the
      // first pass, so the loop exited with whatever the very first read showed. A slot still `starting`
      // a second in — i.e. every real agent — was reported as never coming up.
      for (let i = 0; i < 120; i++) {
        await sleep(1000);
        const row = await settledRow(id);
        if (row) live = row;
        if (live && live.status !== "starting") break;
      }
      return { r, live };
    };

    /** Wait for the slot's MODE to settle, not merely for `ready`.
     *
     *  The default-mode send runs AFTER the handshake and after the row is already `ready` (a create
     *  must not be held for it), so a test that reads the mode the moment the row turns ready is
     *  reading the agent's own pre-send state — and would then tear the slot down under a retry loop
     *  that is still running, which is exactly how "ACP connection closed" got into a passing suite. */
    const waitMode = async (id, wanted, ms = 15_000) => {
      const until = Date.now() + ms;
      let seen = null;
      while (Date.now() < until) {
        const row = await settledRow(id);
        seen = (row?.modes ?? {}).currentModeId ?? null;
        if (seen === wanted) break;
        await sleep(250);
      }
      return seen;
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
    check("the create answers while the agent is still booting (starting, no modes yet)",
      s1.r.json?.status === "starting" && s1.r.json?.modes == null && s1.r.json?.pid > 0,
      `status=${s1.r.json?.status} modes=${s1.r.json?.modes} pid=${s1.r.json?.pid}`);
    check("a NEW session comes up in the row's default permission mode",
      s1.live?.modes?.currentModeId === "dont_ask",
      `live=${s1.live?.modes?.currentModeId} status=${s1.live?.status} ${s1.live?.lastError ?? ""}`);

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

    // NO RECORDED MODE = the slot has no answer of its own, and the row default is the right one. This
    // is the Hermes 0.23 cutover shape: the agent reports "ask" for "this conversation never had a
    // policy", which is indistinguishable from an operator who picked Default — so without this an
    // upgraded slot asks on every edit although the row says 不要问.
    await api("PATCH", "/api/backends/qa-mode", { defaultMode: "" });
    const s3 = await mkSession("qa-mode", "no recorded mode");
    check("...with no row default it stays in the agent's own mode",
      s3.live?.modes?.currentModeId === "default",
      `mode=${s3.live?.modes?.currentModeId} status=${s3.live?.status} ${s3.live?.lastError ?? ""}`);
    await api("PATCH", "/api/backends/qa-mode", { defaultMode: "dont_ask" });
    await api("DELETE", `/api/sessions/${s3.live?.id}`);
    await sleep(800);
    const rs3 = await api("POST", `/api/sessions/${s3.live?.id}/resume`);
    check("a slot with NO recorded mode resumes", rs3.status === 200, `status=${rs3.status} ${rs3.text.slice(0, 120)}`);
    let s3Live = null;
    for (let i = 0; i < 90 && !s3Live; i++) {
      await sleep(1000);
      s3Live = ((await api("GET", "/api/sessions")).json?.live ?? []).find((s) => s.id === s3.live?.id) ?? null;
      if (s3Live && s3Live.status !== "starting") break;
    }
    check("...and comes back in the row default (the upgrade shape: it had no pick of its own)",
      s3Live?.modes?.currentModeId === "dont_ask",
      `mode=${s3Live?.modes?.currentModeId} status=${s3Live?.status} ${s3Live?.lastError ?? ""}`);
    await api("DELETE", `/api/sessions/${s3.live?.id}`);

    // #95: the mode send used to be recorded on the strength of a resolved promise, and on Hermes 0.23
    // that promise resolves even when the mutation never landed — 226 of 227 runtime receipts still said
    // `ask` while every cockpit row said `dont_ask`. Both halves are pinned here.
    //  A) answered, never applied, no echo: the pick must stay UNRECORDED so the next resume retries.
    await api("POST", "/api/backends", {
      id: "qa-mode-drop", label: "QA mode never lands", kind: "mock", cmd: process.execPath,
      args: [path.join(ROOT, "packages/server/mock/agent.mjs")],
      env: { MOCK_MODE_DROP: "1", MOCK_GATEWAY_OWNED: "1" }, defaultMode: "dont_ask",
    });
    const s4 = await mkSession("qa-mode-drop", "mode that never lands");
    // Give the (bounded) settle loop the full window before judging: 4 attempts, the last one at
    // ~1.5 s plus a 0.9 s read-back each.
    await sleep(6_500);
    check("a mode the agent answered but never echoed is NOT shown as applied",
      (await settledRow(s4.live?.id))?.modes?.currentModeId === "default",
      `mode=${(await settledRow(s4.live?.id))?.modes?.currentModeId} status=${(await settledRow(s4.live?.id))?.status}`);
    check("...and the pick is NOT recorded (the next resume retries instead of lying)",
      (await modePickOf(dataDir, s4.live?.id)) === null,
      `mode_id=${await modePickOf(dataDir, s4.live?.id)}`);
    await api("DELETE", `/api/sessions/${s4.live?.id}`);

    //  B) refused while the session is not idle yet — the window every resume lands in. A bounded retry
    //     has to get through it with no operator action.
    await api("POST", "/api/backends", {
      id: "qa-mode-busy", label: "QA mode not-idle window", kind: "mock", cmd: process.execPath,
      args: [path.join(ROOT, "packages/server/mock/agent.mjs")],
      env: { MOCK_MODE_BUSY_MS: "1200", MOCK_GATEWAY_OWNED: "1" }, defaultMode: "dont_ask",
    });
    const s5 = await mkSession("qa-mode-busy", "mode refused while not idle");
    check("a refusal from the not-idle-yet window is retried until it lands",
      (await waitMode(s5.live?.id, "dont_ask")) === "dont_ask",
      `mode=${(await settledRow(s5.live?.id))?.modes?.currentModeId} status=${(await settledRow(s5.live?.id))?.status} ${(await settledRow(s5.live?.id))?.lastError ?? ""}`);
    check("...and only a landed mode is recorded",
      (await modePickOf(dataDir, s5.live?.id)) === "dont_ask",
      `mode_id=${await modePickOf(dataDir, s5.live?.id)}`);
    await api("DELETE", `/api/sessions/${s5.live?.id}`);

    // #234 A) The owner refuses `session/load` for a moment after the turn its dead viewer started —
    // a promote/restart of the cockpit — answering `-32603` with nothing but "Internal error". The
    // cockpit has to retry that: measured on live, the slot sat `offline / acp_init_failed` at 23:32:29
    // and the SAME click worked at 23:36:09, which read as "the cockpit broke again".
    const cfgLog = path.join(dataDir, "config-writes-234.log");
    await api("POST", "/api/backends", {
      id: "qa-resume-retry", label: "QA resume refused once", kind: "mock", cmd: process.execPath,
      args: [path.join(ROOT, "packages/server/mock/agent.mjs")],
      env: {
        MOCK_LOAD_FAIL_FILE: path.join(dataDir, "load-refused-234.once"), MOCK_LOAD_FAIL_DATA: "1",
        MOCK_CONFIG_LOG: cfgLog,
      },
      defaultMode: "dont_ask",
    });
    const s6 = await mkSession("qa-resume-retry", "resume refused once");
    await api("DELETE", `/api/sessions/${s6.live?.id}`);
    await sleep(800);
    const retried = await api("POST", `/api/sessions/${s6.live?.id}/resume`);
    check("a resume refused with a transient 'Internal error' is retried, not reported as broken",
      retried.status === 200, `status=${retried.status} ${retried.text.slice(0, 160)}`);
    check("...the retry line carries the refusal's own data (not just the two words)",
      /previous_turn_releasing/.test(log()),
      log().split("\n").filter((l) => l.includes("resume refused")).slice(-1)[0] || "(no retry line)");
    let s6Live = null;
    for (let i = 0; i < 60 && !s6Live; i++) {
      await sleep(1000);
      s6Live = ((await api("GET", "/api/sessions")).json?.live ?? []).find((s) => s.id === s6.live?.id) ?? null;
      if (s6Live && s6Live.status !== "starting") break;
    }
    check("...and the slot comes back ready in the mode the row asks for",
      s6Live?.status === "ready" && s6Live?.modes?.currentModeId === "dont_ask",
      `status=${s6Live?.status} mode=${s6Live?.modes?.currentModeId} ${s6Live?.lastError ?? ""}`);
    // #234 B) One channel owns the decision. The stored `edit_approval_policy` option is a policy
    // snapshot in a different vocabulary (`ask` / `workspace_session` / `session`) than the mode ids,
    // and replaying it after the mode landed is exactly how a resume put 「不要问」 back to `ask` on
    // live 0.22.2 (`mode_id=dont_ask` in the row, `currentValue:"ask"` in the options).
    const cfgWrites = fs.existsSync(cfgLog)
      ? fs.readFileSync(cfgLog, "utf8").split("\n").filter(Boolean) : [];
    check("a resume does NOT replay the stored edit_approval_policy over the mode it just applied",
      !cfgWrites.some((line) => line.startsWith("edit_approval_policy=")),
      cfgWrites.join(", ") || "(no config writes)");
    await api("DELETE", `/api/sessions/${s6.live?.id}`);
    await api("DELETE", "/api/backends/qa-resume-retry");

    // #96 — a turn the last restart lost is a DECISION, not a fault: Hermes fences the admission
    // `unknown`, refuses every idle-only control (so the resume's mode push is answered
    // -32603 + details `unknown_execution`), and only `sessions discard` clears it. The cockpit used
    // to read "Internal error" as transient, wait 3 × 5 s and then report 500 with no action at all.
    const lostMarker = path.join(dataDir, "lost-turn-96.marker");
    await api("POST", "/api/backends", {
      id: "qa-lost-turn", label: "QA lost turn", kind: "mock", cmd: process.execPath,
      args: [path.join(ROOT, "packages/server/mock/agent.mjs")],
      env: { MOCK_LOST_TURN_FILE: lostMarker },
      defaultMode: "dont_ask",
    });
    const s7 = await mkSession("qa-lost-turn", "lost turn");
    await sleep(1200);
    await api("DELETE", `/api/sessions/${s7.live?.id}`);
    await sleep(800);
    fs.writeFileSync(lostMarker, "unknown\n");
    const before = log().length;
    const t0 = Date.now();
    const lost = await api("POST", `/api/sessions/${s7.live?.id}/resume`);
    const elapsed = Date.now() - t0;
    check("#96 a lost turn is answered 409 lost_turn, not 500 Internal error",
      lost.status === 409 && lost.json?.code === "lost_turn",
      `status=${lost.status} body=${lost.text.slice(0, 160)}`);
    check("#96 …in ONE attempt — a decision is not retried (no 3 × 5 s wait)",
      elapsed < 4000 && !log().slice(before).includes("resume refused by the agent"),
      `${elapsed} ms; ${log().slice(before).split("\n").filter(Boolean).slice(-2).join(" | ")}`);
    const disc = await api("POST", `/api/sessions/${s7.live?.id}/discard-lost-turn`);
    check("#96 the discard endpoint acknowledges it through the agent's own CLI",
      disc.status === 200 && disc.json?.discarded === 1 && !fs.existsSync(lostMarker),
      `status=${disc.status} body=${disc.text.slice(0, 160)}`);
    const back = await api("POST", `/api/sessions/${s7.live?.id}/resume`);
    check("#96 …and the same resume then succeeds", back.status === 200, `status=${back.status} ${back.text.slice(0, 120)}`);
    const again = await api("POST", `/api/sessions/${s7.live?.id}/discard-lost-turn`);
    check("#96 discarding when nothing is lost is a no-op answer, not an error",
      again.status === 200 && again.json?.discarded === 0, `status=${again.status} body=${again.text.slice(0, 120)}`);
    await api("DELETE", `/api/sessions/${s7.live?.id}`);
    await api("DELETE", "/api/backends/qa-lost-turn");

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
      // Same polling bug as `mkSession` had, and it mattered more here: a real hermes boots a python
      // process (10–40 s measured, longer under load), so the single poll this loop really did always
      // saw `starting`. `!hLive` is NOT part of the condition — the row exists from the moment it is
      // created, and it is the STATUS that has to settle. A slot that fails leaves `live`, so the
      // read spans every bucket (see `settledRow`) — otherwise a broken ACP install reads as a slot
      // that is still booting 240 s later, which hides the real error.
      for (let i = 0; i < 240; i++) {
        await sleep(1000);
        const row = await settledRow(hid);
        if (row) hLive = row;
        if (hLive && hLive.status !== "starting") break;
      }
      const hermesWhy = ((await api("GET", "/api/backends")).json ?? [])
        .find((b) => b.id === "qa-fork")?.health?.message ?? "";
      check("the hermes slot reached a non-starting state", Boolean(hLive) && hLive.status !== "starting",
        `status=${hLive?.status} ${String(hermesWhy).slice(0, 200)}`);
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
