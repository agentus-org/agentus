// Workspace + voice surface — asserts the parts no other script covers: the per-slot
// workspace field, the read-only file API, the PTY shell, attachments on a prompt and
// the voice endpoints' guards.
//
//   node scripts/workspace-smoke.mjs
//
// Self-contained like auth-smoke: spawns its own server on a free port with a throwaway
// data dir, so it is safe in CI and against a live dev server alike.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createTcp } from "node:net";
import { WebSocket } from "ws";

const ROOT = path.resolve(import.meta.dirname, "..");

/** Killing the `tsx` WRAPPER is not killing the server: tsx runs the app as its own child, and
 *  a bare SIGKILL to the wrapper leaves that child listening on a random port for good. That is
 *  exactly how a couple of hundred dead servers piled up on the dev machine. `detached: true`
 *  makes the child a process-group leader, so one negative-pid signal takes the whole tree. */
const killGroup = (target) => {
  const pid = typeof target === "number" ? target : target?.pid;
  if (!pid) return;
  try { process.kill(-pid, "SIGKILL"); } catch { try { killGroup(pid); } catch { /* already gone */ } }
};

// A random-ish scratch port: a leaked server from an earlier run must not fail the
// suite (auth-smoke uses fixed ports and this bit us once locally).
const PORT = await freePort();   // never a guessed port: see freePort() above
const results = [];
let failed = 0;

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ask the OS for a port that is actually free. A guessed/fixed range collides with a server
 *  leaked by an earlier crashed run: the stale listener answers /healthz instantly, so the
 *  suite silently talks to the WRONG process and dies with something cryptic ("no machine
 *  token"). We also kill every child on exit, so we never become the leaker ourselves. */
async function freePort() {
  return new Promise((res, rej) => {
    const s = createTcp();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}
async function freePorts(n) { const out = new Set(); while (out.size < n) out.add(await freePort()); return [...out]; }
function portInUse(port) {
  return new Promise((res) => {
    const s = createTcp();
    s.once("error", () => res(true));
    s.once("listening", () => s.close(() => res(false)));
    s.listen(port, "127.0.0.1");
  });
}
const CHILDREN = new Set();
process.on("exit", () => { for (const c of CHILDREN) { try { killGroup(c); } catch { /* already gone */ } } });


/** An empty HOME: the server's settings bootstrap also reads `~/.hermes/.env`, so a suite
 *  that inherits the operator's home is not testing an unconfigured install (this bit us:
 *  the voice guards below returned 200 with real audio instead of 501). */
const EMPTY_HOME = mkdtempSync(path.join(tmpdir(), "agentus-home-"));

async function boot(port, dataDir) {
  if (await portInUse(port)) {
    throw new Error(`port ${port} is already in use — a leaked server from an earlier run? `
      + `(lsof -nP -iTCP:${port} -sTCP:LISTEN)`);
  }
  const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
    detached: true,
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: "development", AGENTUS_PORT: String(port), AGENTUS_DATA: dataDir, HOME: EMPTY_HOME },
    stdio: ["ignore", "pipe", "pipe"],
  });
  CHILDREN.add(proc);
  let log = "";
  proc.stdout.on("data", (d) => { log += String(d); });
  proc.stderr.on("data", (d) => { log += String(d); });
  // Wait for THIS child to own the port (its own boot line). Probing the port instead is
  // what made the leaked-server collision look like a credential bug: a stale listener
  // answers /healthz, and the suite then reads its own empty data dir.
  for (let i = 0; i < 80 && !log.includes(`0.0.0.0:${port}`); i++) {
    if (proc.exitCode !== null) throw new Error(`server exited (${proc.exitCode}) before listening on ${port}:\n${log}`);
    await sleep(150);
  }
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return { proc, base, log: () => log };
    } catch { /* not up yet */ }
    await sleep(250);
  }
  killGroup(proc);
  throw new Error(`server never came up on ${port}:\n${log}`);
}

/** The machine token the server writes next to its store (0600) — same credential the
 *  other scripts use, and the one a browser-free test needs. */
function tokenFor(dataDir) {
  const file = path.join(dataDir, "auth.token");
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(file)) {
      const tok = fs.readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).pop();
      if (tok) return tok;
    }
    // synchronous wait is fine: this only runs while the server is booting
    const until = Date.now() + 200;
    while (Date.now() < until) { /* spin */ }
  }
  throw new Error("no machine token was written");
}

const dataDir = mkdtempSync(path.join(tmpdir(), "agentus-ws-"));
const { proc, base, log } = await boot(PORT, dataDir);
const token = tokenFor(dataDir);
const H = { authorization: `Bearer ${token}` };
const j = (r) => r.json();

try {
  // ---- fixture tree -------------------------------------------------------------
  const root = mkdtempSync(path.join(tmpdir(), "agentus-fs-"));
  fs.mkdirSync(path.join(root, "alpha"));
  fs.mkdirSync(path.join(root, ".hidden"));
  fs.writeFileSync(path.join(root, "notes.txt"), "hello workspace\n");
  fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00]));
  fs.writeFileSync(path.join(root, "big.log"), "x".repeat(5000));

  // ---- file API ------------------------------------------------------------------
  const dirs = await fetch(`${base}/api/fs/dirs?files=1&path=${encodeURIComponent(root)}`, { headers: H });
  const listing = await j(dirs);
  check("fs/dirs lists files with sizes when asked", listing.entries.some((e) => e.kind === "file" && e.name === "notes.txt" && e.size === 16),
    JSON.stringify(listing.entries.map((e) => e.name)));
  check("fs/dirs keeps directories first", listing.entries[0].kind === "dir", listing.entries[0]?.name);
  check("fs/dirs skips hidden entries", !listing.entries.some((e) => e.name.startsWith(".")));
  const dirsOnly = await j(await fetch(`${base}/api/fs/dirs?path=${encodeURIComponent(root)}`, { headers: H }));
  check("fs/dirs is directories-only by default (the picker must not offer a file)", dirsOnly.entries.every((e) => e.kind === "dir"));

  const txt = await j(await fetch(`${base}/api/fs/file?path=${encodeURIComponent(path.join(root, "notes.txt"))}`, { headers: H }));
  check("fs/file returns text content", txt.content === "hello workspace\n" && txt.truncated === false && txt.binary === false);
  const big = await j(await fetch(`${base}/api/fs/file?path=${encodeURIComponent(path.join(root, "big.log"))}&maxBytes=1024`, { headers: H }));
  check("fs/file truncates at maxBytes and says so", big.content.length === 1024 && big.truncated === true, `len=${big.content.length}`);
  const bin = await j(await fetch(`${base}/api/fs/file?path=${encodeURIComponent(path.join(root, "blob.bin"))}`, { headers: H }));
  check("fs/file flags binary instead of returning mojibake", bin.binary === true && bin.content === "");
  check("fs/file 404s a missing file", (await fetch(`${base}/api/fs/file?path=${encodeURIComponent(path.join(root, "nope"))}`, { headers: H })).status === 404);
  check("fs/file 400s a directory", (await fetch(`${base}/api/fs/file?path=${encodeURIComponent(root)}`, { headers: H })).status === 400);
  check("fs/file 400s a missing path param", (await fetch(`${base}/api/fs/file`, { headers: H })).status === 400);
  check("fs/* refuses an anonymous caller", (await fetch(`${base}/api/fs/file?path=${encodeURIComponent(root)}`)).status === 401);

  // ---- the slot's workspace ------------------------------------------------------
  const created = await j(await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...H },
    body: JSON.stringify({ backend: "mock", cwd: ROOT }),
  }));
  check("created a session with no workspace override", created.workspace === null || created.workspace === undefined, String(created.workspace));
  const setWs = await j(await fetch(`${base}/api/sessions/${created.id}/workspace`, {
    method: "POST",
    headers: { "content-type": "application/json", ...H },
    body: JSON.stringify({ path: root }),
  }));
  check("workspace can be pointed at another directory", setWs.workspace === root, String(setWs.workspace));
  check("the running session keeps its spawn cwd", setWs.cwd === ROOT, `${setWs.cwd} vs ${ROOT}`);

  // ---- rename: display state, reversible, never the agent's business ----------------
  const auto = created.title;
  const renamed = await j(await fetch(`${base}/api/sessions/${created.id}/rename`, {
    method: "POST", headers: { "content-type": "application/json", ...H },
    body: JSON.stringify({ title: "  重构 · 会话列表  " }),
  }));
  check("rename trims and takes the operator's name", renamed.title === "重构 · 会话列表", String(renamed.title));
  const listAfter = await j(await fetch(`${base}/api/sessions`, { headers: H }));
  // a freshly created mock session is LIVE, a restarted one lands in `archived` — check both
  const afterRename = [...listAfter.live, ...listAfter.archived].find((x) => x.id === created.id);
  check("the new name is persisted, not just echoed", afterRename?.title === "重构 · 会话列表", String(afterRename?.title));
  const clearedTitle = await j(await fetch(`${base}/api/sessions/${created.id}/rename`, {
    method: "POST", headers: { "content-type": "application/json", ...H }, body: JSON.stringify({ title: "   " }),
  }));
  check("clearing a rename falls back to the generated name", clearedTitle.title === auto, `${clearedTitle.title} (auto was ${auto})`);
  const ctrl = await j(await fetch(`${base}/api/sessions/${created.id}/rename`, {
    method: "POST", headers: { "content-type": "application/json", ...H }, body: JSON.stringify({ title: "a\nb\tc" }),
  }));
  check("control characters fold to spaces (the rail is one line)", ctrl.title === "a b c", JSON.stringify(ctrl.title));
  const long = await j(await fetch(`${base}/api/sessions/${created.id}/rename`, {
    method: "POST", headers: { "content-type": "application/json", ...H }, body: JSON.stringify({ title: "x".repeat(300) }),
  }));
  check("an absurd name is capped", long.title.length === 120, `len=${long.title.length}`);
  await fetch(`${base}/api/sessions/${created.id}/rename`, {
    method: "POST", headers: { "content-type": "application/json", ...H }, body: JSON.stringify({ title: null }),
  });
  check("rename refuses an unknown session", (await fetch(`${base}/api/sessions/nope-rename/rename`, {
    method: "POST", headers: { "content-type": "application/json", ...H }, body: JSON.stringify({ title: "x" }),
  })).status === 404);
  check("rename needs credentials", (await fetch(`${base}/api/sessions/${created.id}/rename`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x" }),
  })).status === 401);
  const rooted = await j(await fetch(`${base}/api/fs/dirs?sessionId=${created.id}`, { headers: H }));
  check("fs/dirs?sessionId= resolves the session workspace", rooted.path === root, rooted.path);
  check("the workspace survives a re-read of the session list",
    (await j(await fetch(`${base}/api/sessions`, { headers: H }))).live.some((s) => s.workspace === root));
  check("workspace rejects a path that is not a directory",
    (await fetch(`${base}/api/sessions/${created.id}/workspace`, {
      method: "POST", headers: { "content-type": "application/json", ...H },
      body: JSON.stringify({ path: path.join(root, "notes.txt") }),
    })).status === 400);
  check("workspace rejects an unknown session",
    (await fetch(`${base}/api/sessions/nope/workspace`, {
      method: "POST", headers: { "content-type": "application/json", ...H },
      body: JSON.stringify({ path: root }),
    })).status === 404);

  // ---- fork (ACP session/fork) ---------------------------------------------------
  const forkRes = await fetch(`${base}/api/sessions/${created.id}/fork`, { method: "POST", headers: H });
  const forked = await forkRes.json();
  check("fork returns a new live session", forkRes.status === 200 && forked.id && forked.id !== created.id, `${forkRes.status} ${forked.id ?? forked.error}`);
  check("the fork gets its own agent-side session id", forked.acpSessionId && forked.acpSessionId !== created.acpSessionId,
    `${forked.acpSessionId} vs ${created.acpSessionId}`);
  check("the fork keeps the parent's workspace", (forked.workspace ?? null) === (created.workspace ?? null), String(forked.workspace));
  check("the fork's title says where it came from", /\bfork\b/.test(String(forked.title)), String(forked.title));
  check("the fork shows up in the session list", (await j(await fetch(`${base}/api/sessions`, { headers: H }))).live.some((s) => s.id === forked.id));
  check("forking an unknown session is a 404", (await fetch(`${base}/api/sessions/nope/fork`, { method: "POST", headers: H })).status === 404);
  await fetch(`${base}/api/sessions/${forked.id}`, { method: "DELETE", headers: H });

  // ---- models (ACP session model state + session/set_model) ----------------------
  // Contract, not a count: the fixtures the cockpit's model paths are tested against (a
  // switchable pair plus the listed-but-refused `mock:gone`) must be in the advertisement.
  const advertised = (created.models?.availableModels ?? []).map((m) => m.modelId);
  check("the mock advertises its models",
    ["mock:fast", "mock:deep", "mock:gone"].every((id) => advertised.includes(id)),
    JSON.stringify(advertised));
  const switched = await j(await fetch(`${base}/api/sessions/${created.id}/model`, {
    method: "POST", headers: { "content-type": "application/json", ...H },
    body: JSON.stringify({ modelId: "mock:deep" }),
  }));
  check("set-model switches the session's model", switched.models?.currentModelId === "mock:deep", String(switched.models?.currentModelId));
  check("set-model rejects an unknown model", (await fetch(`${base}/api/sessions/${created.id}/model`, {
    method: "POST", headers: { "content-type": "application/json", ...H },
    body: JSON.stringify({ modelId: "mock:nope" }),
  })).status === 400);
  // A refused switch must report WHY (the agent's `data.details`), not the JSON-RPC title
  // "Invalid params" — the whole point of §61: a listed model can still be unswitchable.
  const refusedSwitch = await fetch(`${base}/api/sessions/${created.id}/model`, {
    method: "POST", headers: { "content-type": "application/json", ...H },
    body: JSON.stringify({ modelId: "mock:gone" }),
  });
  const refusedSwitchBody = await j(refusedSwitch);
  check("a refused switch is a 400 that carries the agent's reason",
    refusedSwitch.status === 400 && /was not found in this provider's model listing/.test(String(refusedSwitchBody.error))
    && /Similar models/.test(String(refusedSwitchBody.error)),
    `${refusedSwitch.status} ${JSON.stringify(refusedSwitchBody)}`);
  check("set-model needs a modelId", (await fetch(`${base}/api/sessions/${created.id}/model`, {
    method: "POST", headers: { "content-type": "application/json", ...H }, body: JSON.stringify({}),
  })).status === 400);

  // ---- the operator's context window --------------------------------------------
  const withLimit = await j(await fetch(`${base}/api/sessions/${created.id}/context-limit`, {
    method: "POST", headers: { "content-type": "application/json", ...H },
    body: JSON.stringify({ limit: 64000 }),
  }));
  check("context-limit is stored on the session", withLimit.contextLimit === 64000, String(withLimit.contextLimit));
  check("context-limit survives a re-read",
    (await j(await fetch(`${base}/api/sessions`, { headers: H }))).live.some((s) => s.id === created.id && s.contextLimit === 64000));
  check("context-limit rejects a non-positive number", (await fetch(`${base}/api/sessions/${created.id}/context-limit`, {
    method: "POST", headers: { "content-type": "application/json", ...H }, body: JSON.stringify({ limit: 0 }),
  })).status === 400);
  const cleared = await j(await fetch(`${base}/api/sessions/${created.id}/context-limit`, {
    method: "POST", headers: { "content-type": "application/json", ...H }, body: JSON.stringify({ limit: null }),
  }));
  check("context-limit can be cleared (back to what the agent reports)", cleared.contextLimit === null, String(cleared.contextLimit));

  // ---- the window remembered PER MODEL (studio keeps one per provider+model) -------
  const model = withLimit.models?.currentModelId ?? "";
  check("the session advertises a current model to key the memory on", Boolean(model), String(model));
  const remembered = await j(await fetch(`${base}/api/sessions/${created.id}/context-limit`, {
    method: "POST", headers: { "content-type": "application/json", ...H },
    body: JSON.stringify({ limit: 128000, remember: true }),
  }));
  check("a declared window can be remembered for the model", remembered.contextLimit === 128000 && remembered.modelContextLimit === 128000,
    JSON.stringify({ session: remembered.contextLimit, model: remembered.modelContextLimit }));
  check("the remembered map is readable", (await j(await fetch(`${base}/api/context-limits`, { headers: H })))
    .limits.some((l) => l.modelId === model && l.limit === 128000));
  const sessionOnly = await j(await fetch(`${base}/api/sessions/${created.id}/context-limit`, {
    method: "POST", headers: { "content-type": "application/json", ...H }, body: JSON.stringify({ limit: null }),
  }));
  check("resetting the session keeps the model's memory", sessionOnly.contextLimit === null && sessionOnly.modelContextLimit === 128000,
    JSON.stringify({ session: sessionOnly.contextLimit, model: sessionOnly.modelContextLimit }));
  const other = (remembered.models?.availableModels ?? []).map((m) => m.modelId).find((m) => m !== model);
  if (other) {
    await fetch(`${base}/api/sessions/${created.id}/model`, {
      method: "POST", headers: { "content-type": "application/json", ...H }, body: JSON.stringify({ modelId: other }),
    });
    const switched = await j(await fetch(`${base}/api/sessions/${created.id}/context-limit`, {
      method: "POST", headers: { "content-type": "application/json", ...H },
      body: JSON.stringify({ limit: 32000, remember: true }),
    }));
    check("a second model keeps its own window", switched.modelContextLimit === 32000, String(switched.modelContextLimit));
    await fetch(`${base}/api/sessions/${created.id}/model`, {
      method: "POST", headers: { "content-type": "application/json", ...H }, body: JSON.stringify({ modelId: model }),
    });
    const back = await j(await fetch(`${base}/api/sessions/${created.id}/context-limit`, {
      method: "POST", headers: { "content-type": "application/json", ...H }, body: JSON.stringify({ limit: null, forgetModel: false }),
    }));
    check("switching back adopts that model's remembered window", back.modelContextLimit === 128000, String(back.modelContextLimit));
  }
  const forgot = await j(await fetch(`${base}/api/sessions/${created.id}/context-limit`, {
    method: "POST", headers: { "content-type": "application/json", ...H }, body: JSON.stringify({ limit: null, forgetModel: true }),
  }));
  check("forgetting drops only the current model's memory", forgot.modelContextLimit === null, String(forgot.modelContextLimit));
  check("the model window is a declaration, never sent to the agent", !JSON.stringify(forgot).includes("set_context"));

  // ---- terminal ------------------------------------------------------------------
  const term = new WebSocket(`ws://127.0.0.1:${PORT}/ws/term?sessionId=${created.id}&token=${token}`);
  const termOut = [];
  let termReady = null;
  const termDone = new Promise((resolve) => {
    term.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m.t === "term-ready") { termReady = m; term.send(JSON.stringify({ t: "term-input", data: "pwd; echo WORKSPACE_SMOKE_OK\n" })); }
      else if (m.t === "term-data") termOut.push(m.data);
      else if (m.t === "term-exit" || m.t === "term-error") resolve(m);
    });
  });
  await Promise.race([termDone, sleep(15_000)]);
  const joined = termOut.join("");
  check("terminal starts in the session workspace", termReady?.cwd === root, String(termReady?.cwd));
  check("terminal runs the command and streams the output", /WORKSPACE_SMOKE_OK/.test(joined), joined.slice(-120).replace(/\n/g, "\\n"));
  term.send(JSON.stringify({ t: "term-close" }));
  await sleep(600);
  const shells = await j(await fetch(`${base}/api/term`, { headers: H }));
  check("closing the socket kills the shell (no orphan)", shells.sessions.length === 0, JSON.stringify(shells.sessions));

  // ---- attachments on a prompt ---------------------------------------------------
  const live = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`);
  const seen = [];
  live.on("message", (d) => seen.push(JSON.parse(String(d))));
  await sleep(500);
  live.send(JSON.stringify({
    t: "prompt",
    sessionId: created.id,
    text: "attachment probe",
    attachments: [
      { kind: "text", name: "notes.txt", text: "hello workspace" },
      { kind: "image", mimeType: "image/png", data: "iVBORw0KGgo=", name: "pixel.png" },
    ],
  }));
  for (let i = 0; i < 40; i++) {
    if (seen.some((e) => e.t === "turn-end")) break;
    await sleep(300);
  }
  const userMsg = seen.filter((e) => e.t === "message" && e.message?.kind === "user").pop();
  check("the prompt carried its attachments", userMsg?.message?.payload?.attachments?.length === 2,
    JSON.stringify(userMsg?.message?.payload?.attachments));
  check("attachments are stored as names only (never the bytes)",
    !JSON.stringify(userMsg?.message?.payload ?? {}).includes("iVBORw0KGgo="));
  check("the turn completed", seen.some((e) => e.t === "turn-end"), seen.map((e) => e.t).join(","));
  live.close();
  await fetch(`${base}/api/sessions/${created.id}`, { method: "DELETE", headers: H });
  // ---- export: rendered from OUR rows (ACP has no export; AionUi does the same) ------
  // Runs AFTER the DELETE above on purpose: export reads our persisted rows, so it works
  // on an ARCHIVED session with no live agent to wake — that is the whole design point.
  const mdResp = await fetch(`${base}/api/sessions/${created.id}/export`, { headers: H });
  const mdText = await mdResp.text();
  check("export returns markdown as an attachment",
    mdResp.status === 200 && (mdResp.headers.get("content-type") || "").includes("text/markdown")
    && (mdResp.headers.get("content-disposition") || "").includes("attachment"),
    mdResp.headers.get("content-disposition"));
  check("the markdown export carries the header and both sides of the transcript",
    mdText.includes("# ") && mdText.includes("### User") && mdText.includes("attachment probe")
    && mdText.includes("### Agent"), mdText.slice(0, 80));
  check("the markdown export folds streamed agent chunks into ONE section (no 200-row dump)",
    (mdText.match(/### Agent/g) || []).length <= 3, String((mdText.match(/### Agent/g) || []).length));
  const jsonExport = await j(await fetch(`${base}/api/sessions/${created.id}/export?format=json`, { headers: H }));
  check("the json export is the lossless row dump",
    jsonExport.format === "agentus-session/1" && Array.isArray(jsonExport.messages)
    // One row per MESSAGE now (streamed chunks fold into the row they belong to), so this flow is
    // user + agent. The floor proves the dump carries the transcript; the invariants below are what
    // make it "lossless" — and they are asserted harder than the old row-count guess.
    && jsonExport.messages.length >= 2 && jsonExport.messages.every((m) => m.payload && m.seq > 0)
    && jsonExport.messages.every((m, i, a) => i === 0 || a[i - 1].seq < m.seq),
    `rows=${jsonExport.messages?.length}`);
  check("export refuses an unknown session",
    (await fetch(`${base}/api/sessions/nope-export/export`, { headers: H })).status === 404);
  check("export needs credentials",
    (await fetch(`${base}/api/sessions/${created.id}/export`)).status === 401);

  // ---- a cold slot the agent can no longer adopt ---------------------------------
  // Why this exists at all: resuming one used to LOOK like a success from the cockpit's side. ACP
  // has no loud "no" — hermes answers an unknown session with an EMPTY load result and `refusal` on
  // every prompt (measured: scripts/probe-load-missing.mjs) — so the slot came up "ready" and then
  // silently ate every message the operator sent. The server refuses up front now, names the two
  // agent homes, and the only useful action (delete it) is offered. These checks pin the refusal,
  // and that a healthy resume on the same row still works.
  const homeA = mkdtempSync(path.join(tmpdir(), "agentus-homeA-"));
  const homeB = mkdtempSync(path.join(tmpdir(), "agentus-homeB-"));
  const probeRow = {
    id: "qa-home", label: "QA home probe",
    // kind=hermes is what gives a row a HERMES_HOME; the mock ignores it, so the suite stays
    // hermetic (no real agent, no writes into anyone's home).
    kind: "hermes", cmd: process.execPath, args: path.join(ROOT, "packages/server/mock/agent.mjs"),
    env: {}, home: homeA, profile: "", notes: "smoke: which home a slot belongs to",
  };
  const patchRow = (body) => fetch(`${base}/api/backends/qa-home`, {
    method: "PATCH", headers: { "content-type": "application/json", ...H }, body: JSON.stringify(body),
  });
  const made = await fetch(`${base}/api/backends`, {
    method: "POST", headers: { "content-type": "application/json", ...H }, body: JSON.stringify(probeRow),
  });
  check("a row can name its own home (kind=hermes → it gets a HERMES_HOME)",
    made.status === 201, `${made.status} ${(await made.text()).slice(0, 120)}`);
  const probe = await j(await fetch(`${base}/api/sessions`, {
    method: "POST", headers: { "content-type": "application/json", ...H },
    body: JSON.stringify({ backend: "qa-home", cwd: ROOT }),
  }));
  check("a session on it starts", Boolean(probe.id) && probe.pid > 0, `${probe.id} pid=${probe.pid}`);
  check("closing it leaves a cold slot",
    (await fetch(`${base}/api/sessions/${probe.id}`, { method: "DELETE", headers: H })).status === 200);

  // move the row to another home: the slot's agent-side state is now out of reach
  check("the row's home can be changed", (await patchRow({ ...probeRow, home: homeB })).status === 200);
  const refusedRes = await fetch(`${base}/api/sessions/${probe.id}/resume`, { method: "POST", headers: H });
  const refused = await j(refusedRes);
  check("resuming a slot created under another home is REFUSED (409), not a silent \"ready\"",
    refusedRes.status === 409, `${refusedRes.status} ${JSON.stringify(refused).slice(0, 160)}`);
  check("the refusal names the reason and BOTH homes",
    refused.code === "home_mismatch" && refused.sessionHome === homeA && refused.rowHome === homeB,
    JSON.stringify(refused));
  const afterRefusal = await j(await fetch(`${base}/api/sessions`, { headers: H }));
  check("nothing was spawned for it (no live slot) and the cold slot is still there",
    !afterRefusal.live.some((s) => s.id === probe.id) && afterRefusal.archived.some((s) => s.id === probe.id),
    `live=${afterRefusal.live.length} archived=${afterRefusal.archived.length}`);
  check("a refusal is not recorded as a backend failure (the ROW is fine)",
    !(await j(await fetch(`${base}/api/backends`, { headers: H }))).find((b) => b.id === "qa-home")?.health?.errorCode,
    JSON.stringify((await j(await fetch(`${base}/api/backends`, { headers: H }))).find((b) => b.id === "qa-home")?.health));

  // put the home back: the SAME slot resumes — the refusal was about the mismatch, not the slot
  /** One real turn over the WebSocket path, waited out — what gives a slot a transcript (and, at
   *  the agent's end, what makes it persist the session at all). */
  const talkTo = async (sessionId, text) => {
    const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`);
    const seen = [];
    sock.on("message", (d) => seen.push(JSON.parse(String(d))));
    await sleep(400);
    sock.send(JSON.stringify({ t: "prompt", sessionId, text }));
    for (let i = 0; i < 40; i++) {
      if (seen.some((e) => e.t === "turn-end")) break;
      await sleep(300);
    }
    sock.close();
    return seen;
  };

  await patchRow({ ...probeRow, home: homeA });
  const okResume = await fetch(`${base}/api/sessions/${probe.id}/resume`, { method: "POST", headers: H });
  const okBody = await j(okResume);
  check("with its own home back, the same slot resumes", okResume.status === 200,
    `${okResume.status} ${JSON.stringify(okBody).slice(0, 160)}`);
  check("and it is the SAME agent session it had — a resume must not quietly re-mint one",
    okBody.acpSessionId === probe.acpSessionId, `${okBody.acpSessionId} vs ${probe.acpSessionId}`);

  // a real turn: from here the slot HAS a transcript, which is what makes losing it bad
  const spoke = await talkTo(probe.id, "say something");
  check("the resumed slot answers a prompt (it is genuinely working)", spoke.some((e) => e.t === "turn-end"),
    spoke.map((e) => e.t).join(","));
  await fetch(`${base}/api/sessions/${probe.id}`, { method: "DELETE", headers: H });

  // same home, but the agent has never seen this session (a home that was replaced, or a state.db
  // that went away): the other refusal — same shape, its own code, and the operator gets a way out.
  await patchRow({ ...probeRow, env: { MOCK_FORGET: "1" } });
  const forgotRes = await fetch(`${base}/api/sessions/${probe.id}/resume`, { method: "POST", headers: H });
  const forgotBody = await j(forgotRes);
  check("a session the agent no longer has is refused with its own code (not a 500)",
    forgotRes.status === 409 && forgotBody.code === "context_missing",
    `${forgotRes.status} ${JSON.stringify(forgotBody).slice(0, 160)}`);
  check("and that refusal is not a backend failure either",
    (await j(await fetch(`${base}/api/backends`, { headers: H }))).find((b) => b.id === "qa-home")?.health?.status !== "offline",
    JSON.stringify((await j(await fetch(`${base}/api/backends`, { headers: H }))).find((b) => b.id === "qa-home")?.health));
  check("the refused slot is still cold (resumable retry is not blocked by state)",
    (await j(await fetch(`${base}/api/sessions`, { headers: H }))).archived.some((s) => s.id === probe.id));
  check("the operator's only useful action works: deleting the refused slot",
    (await fetch(`${base}/api/sessions/${probe.id}`, { method: "DELETE", headers: H })).status === 200);
  check("and it is gone from the cold list",
    !(await j(await fetch(`${base}/api/sessions`, { headers: H }))).archived.some((s) => s.id === probe.id));

  // A slot closed BEFORE its first message has no state anywhere (the agent persists a session when
  // it starts working), and there is no conversation to lose: reopening it must give a working slot
  // rather than a dead end. Refusing here would be a rule with nothing behind it.
  await patchRow({ ...probeRow, env: { MOCK_FORGET: "1" } });
  const empty = await j(await fetch(`${base}/api/sessions`, {
    method: "POST", headers: { "content-type": "application/json", ...H },
    body: JSON.stringify({ backend: "qa-home", cwd: ROOT, title: "empty slot" }),
  }));
  await fetch(`${base}/api/sessions/${empty.id}`, { method: "DELETE", headers: H });
  const reopenedRes = await fetch(`${base}/api/sessions/${empty.id}/resume`, { method: "POST", headers: H });
  const reopened = await j(reopenedRes);
  check("an EMPTY slot the agent never saw is reopened (200), not refused",
    reopenedRes.status === 200 && Boolean(reopened.id) && reopened.pid > 0,
    `${reopenedRes.status} ${JSON.stringify(reopened).slice(0, 160)}`);
  const talked = await talkTo(empty.id, "still works?");
  check("…and the reopened slot actually works (a stale agent-side id would answer nothing)",
    talked.some((e) => e.t === "turn-end"), talked.map((e) => e.t).join(","));
  await fetch(`${base}/api/sessions/${empty.id}`, { method: "DELETE", headers: H });
  await fetch(`${base}/api/backends/qa-home`, { method: "DELETE", headers: H });

  // ---- voice endpoints -----------------------------------------------------------
  const caps = await j(await fetch(`${base}/api/voice`, { headers: H }));
  check("voice reports what is configured (nothing here)", caps?.tts?.server === false && caps?.stt?.server === false, JSON.stringify(caps));
  check("voice refuses an anonymous caller", (await fetch(`${base}/api/voice`)).status === 401);
  const ttsOff = await fetch(`${base}/api/tts`, { method: "POST", headers: { "content-type": "application/json", ...H }, body: JSON.stringify({ text: "hi" }) });
  check("tts says 501 (not 500) when no endpoint is configured", ttsOff.status === 501, await ttsOff.text());
  check("tts validates an empty text", (await fetch(`${base}/api/tts`, { method: "POST", headers: { "content-type": "application/json", ...H }, body: JSON.stringify({ text: "  " }) })).status === 400);
  check("tts validates an oversized text", (await fetch(`${base}/api/tts`, { method: "POST", headers: { "content-type": "application/json", ...H }, body: JSON.stringify({ text: "x".repeat(4001) }) })).status === 400);
  check("stt rejects an empty body", (await fetch(`${base}/api/stt`, { method: "POST", headers: { "content-type": "audio/webm", ...H } })).status === 400);
  check("stt says 501 when no endpoint is configured", (await fetch(`${base}/api/stt`, { method: "POST", headers: { "content-type": "audio/webm", ...H }, body: Buffer.from("not really audio") })).status === 501);
} catch (e) {
  check("suite ran to completion", false, String(e?.stack ?? e));
} finally {
  killGroup(proc);
}

console.log(failed ? `\n${failed} FAILED of ${results.length}` : `\nALL ${results.length} CHECKS PASS`);
if (failed) console.log(`\nserver log tail:\n${log().slice(-2000)}`);
process.exit(failed ? 1 : 0);
