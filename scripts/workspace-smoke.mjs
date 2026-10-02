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
import { WebSocket } from "ws";

const ROOT = path.resolve(import.meta.dirname, "..");
// A random-ish scratch port: a leaked server from an earlier run must not fail the
// suite (auth-smoke uses fixed ports and this bit us once locally).
const PORT = 8900 + Math.floor(Math.random() * 90);
const results = [];
let failed = 0;

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(port, dataDir) {
  const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: "development", AGENTSLOT_PORT: String(port), AGENTSLOT_DATA: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (d) => { log += String(d); });
  proc.stderr.on("data", (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return { proc, base, log: () => log };
    } catch { /* not up yet */ }
    await sleep(250);
  }
  proc.kill("SIGKILL");
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

const dataDir = mkdtempSync(path.join(tmpdir(), "agentslot-ws-"));
const { proc, base, log } = await boot(PORT, dataDir);
const token = tokenFor(dataDir);
const H = { authorization: `Bearer ${token}` };
const j = (r) => r.json();

try {
  // ---- fixture tree -------------------------------------------------------------
  const root = mkdtempSync(path.join(tmpdir(), "agentslot-fs-"));
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
  check("the mock advertises its models", created.models?.availableModels?.length === 3,
    JSON.stringify(created.models?.currentModelId));
  const switched = await j(await fetch(`${base}/api/sessions/${created.id}/model`, {
    method: "POST", headers: { "content-type": "application/json", ...H },
    body: JSON.stringify({ modelId: "mock:deep" }),
  }));
  check("set-model switches the session's model", switched.models?.currentModelId === "mock:deep", String(switched.models?.currentModelId));
  check("set-model rejects an unknown model", (await fetch(`${base}/api/sessions/${created.id}/model`, {
    method: "POST", headers: { "content-type": "application/json", ...H },
    body: JSON.stringify({ modelId: "mock:nope" }),
  })).status === 400);
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
  proc.kill("SIGKILL");
}

console.log(failed ? `\n${failed} FAILED of ${results.length}` : `\nALL ${results.length} CHECKS PASS`);
if (failed) console.log(`\nserver log tail:\n${log().slice(-2000)}`);
process.exit(failed ? 1 : 0);
