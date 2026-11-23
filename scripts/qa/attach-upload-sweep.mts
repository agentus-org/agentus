// Issue #113: >256kB non-image attachments currently have nowhere to go. This sweep drives the
// REAL HTTP endpoint with the browser's own multipart shape (FormData) and checks the escape hatch
// exists: bytes land on disk under a session-scoped directory, the response is a path reference,
// the existing /api auth gate covers it, oversize is rejected, and file.name is never used as a path.
//
//   npx tsx scripts/qa/attach-upload-sweep.mts
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { diskFileName, maxUploadBytes, safeUploadName, uploadDir } from "../../packages/server/src/upload.ts";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

async function start(port, extraEnv = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), `attach-upload-${port}-`));
  const env = { ...process.env, HERMES_STUDIO_PORT: String(port), HERMES_STUDIO_DATA: data, HERMES_STUDIO_DEV: "1" };
  delete env.HERMES_STUDIO_BASE; delete env.HERMES_STUDIO_TITLE;
  Object.assign(env, extraEnv);
  const child = spawn(process.execPath, ["--import", "tsx", "packages/server/src/index.ts"], {
    cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (b) => { log += String(b); });
  child.stderr.on("data", (b) => { log += String(b); });
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`server ${port} exited: ${log.slice(-800)}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch { /* not up */ }
    await sleep(200);
  }
  const token = fs.readFileSync(path.join(data, "auth.token"), "utf8").trim();
  return { child, data, token, port, log: () => log };
}
const stop = async (s) => {
  s.child.kill("SIGTERM");
  for (let i = 0; i < 60 && s.child.exitCode === null; i++) await sleep(100);
  if (s.child.exitCode === null) s.child.kill("SIGKILL");
  fs.rmSync(s.data, { recursive: true, force: true });
};

const postFile = async (s, filename, bytes, { token = s.token, sessionId } = {}) => {
  const fd = new FormData();
  fd.append("file", new Blob([bytes], { type: "text/csv" }), filename);
  const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const r = await fetch(`http://127.0.0.1:${s.port}/api/upload${q}`, { method: "POST", headers, body: fd });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};

const CSV = ("col1,col2\n" + "x,y\n".repeat(80_000)).slice(0, 300 * 1024); // 300kB exactly, real text
check("fixture is really >256kB (the threshold under test)", CSV.length === 300 * 1024, `bytes=${CSV.length}`);
check("safeUploadName keeps a basename only", safeUploadName("../../evil.csv") === "evil.csv", safeUploadName("../../evil.csv"));
check("diskFileName never contains a path separator", !/[\\/]/.test(diskFileName("../../evil.csv")), diskFileName("../../evil.csv"));
check("uploadDir sanitises a hostile sessionId", uploadDir("/data", "../../etc").startsWith(`${path.join("/data", "uploads")}/`), uploadDir("/data", "../../etc"));
check("HERMES_MAX_UPLOAD_SIZE accepts MB shorthand", maxUploadBytes({ HERMES_MAX_UPLOAD_SIZE: "50mb" } as NodeJS.ProcessEnv) === 50 * 1024 * 1024);
const DEFAULT_PORT = 8931, LIMIT_PORT = 8932;
const normal = await start(DEFAULT_PORT);
const limited = await start(LIMIT_PORT, { HERMES_MAX_UPLOAD_SIZE: "1024" });
try {
  // ── the core tracer bullet: a 300kB CSV gets a real path back, bytes intact ──────────────
  const up = await postFile(normal, "big.csv", CSV, { sessionId: "sess-113" });
  check("300kB CSV uploads (not a 256kB dead end)", up.status === 200,
    `status=${up.status} body=${JSON.stringify(up.body).slice(0, 160)}`);
  const saved = up.body?.path;
  check("response carries a path reference, not inline bytes", typeof saved === "string" && path.isAbsolute(saved),
    `path=${String(saved)}`);
  check("saved bytes are exactly the uploaded bytes", typeof saved === "string" && fs.existsSync(saved)
    && fs.readFileSync(saved, "utf8") === CSV,
    typeof saved === "string" && fs.existsSync(saved) ? `size=${fs.statSync(saved).size}` : "missing");
  check("path is scoped to the session", typeof saved === "string" && saved.includes("sess-113"),
    `path=${String(saved)}`);
  check("transcript shape is a name (no 300kB body echoed back)", up.body?.name === "big.csv"
    && !JSON.stringify(up.body).includes(CSV.slice(0, 200)), `name=${String(up.body?.name)}`);

  // ── the endpoint is behind the same auth gate as every other /api route ──────────────────
  const anon = await postFile(normal, "anon.csv", CSV, { token: "" });
  check("unauthenticated upload is refused (401)", anon.status === 401, `status=${anon.status}`);

  // ── file.name must never become a path ───────────────────────────────────────────────────
  const evil = await postFile(normal, "../../evil.csv", CSV, { sessionId: "sess-113" });
  check("a traversal filename is accepted only as a safe basename", evil.status === 200
    && typeof evil.body?.name === "string" && !evil.body.name.includes("/") && !evil.body.name.includes("\\"),
    `status=${evil.status} name=${String(evil.body?.name)}`);
  const escaped = path.join(normal.data, "evil.csv");
  check("…and nothing was written outside the uploads dir", !fs.existsSync(escaped),
    escaped);

  // ── configurable cap (50MB default, HERMES_MAX_UPLOAD_SIZE override) ─────────────────────
  const tooBig = await postFile(limited, "small-cap.csv", CSV);
  check("oversize upload is rejected with 413 (HERMES_MAX_UPLOAD_SIZE)", tooBig.status === 413,
    `status=${tooBig.status} body=${JSON.stringify(tooBig.body).slice(0, 120)}`);
} finally {
  await stop(normal);
  await stop(limited);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
