// Images are the one prompt part an agent can refuse by CAPABILITY (issue #17).
//
// Two servers are started from this tree on spare ports — one whose mock agent does NOT advertise
// `promptCapabilities.image` (the honest default: most models cannot see), one whose mock does. The
// check is what the operator experiences: on the first, a picture is refused where they can still
// read why and their sentence comes back; on the second the same picture goes through.
//
// The gate has to be BEFORE the floor-taking logic, so a refusal cannot cancel a running turn — that
// is asserted with the `[slow]` fixture, not assumed.
//
//   node --import tsx scripts/qa/attachment-capability.mts      (or: npx tsx …)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

// A 1×1 png — real bytes, so this is not a shape-only test.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const IMAGE = [{ kind: "image", name: "shot.png", mimeType: "image/png", data: PNG }];
const TEXTFILE = [{ kind: "text", name: "notes.md", mimeType: "text/markdown", text: "# hi\n附件正文" }];

async function start(port, extraEnv = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), `attach-sweep-${port}-`));
  const env = { ...process.env, AGENTUS_PORT: String(port), AGENTUS_DATA: data, AGENTUS_DEV: "1" };
  delete env.AGENTUS_BASE; delete env.AGENTUS_TITLE;
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
  const api = async (p, init = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
    const text = await r.text();
    try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; }
  };
  return { child, data, api, token, log: () => log, port };
}
const stop = async (s) => {
  s.child.kill("SIGTERM");
  for (let i = 0; i < 60 && s.child.exitCode === null; i++) await sleep(100);
  if (s.child.exitCode === null) s.child.kill("SIGKILL");
  fs.rmSync(s.data, { recursive: true, force: true });
};

/** Open the operator's own socket and collect frames, so a refusal is read off the wire the page reads. */
async function socket(s, sessionId) {
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws?token=${encodeURIComponent(s.token)}`);
  const frames = [];
  await new Promise((res, rej) => {
    ws.on("open", res); ws.on("error", rej);
    setTimeout(() => rej(new Error("ws open timeout")), 10_000);
  });
  ws.on("message", (raw) => { try { frames.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
  const send = (frame) => ws.send(JSON.stringify({ ...frame, sessionId }));
  return { ws, frames, send, close: () => ws.close() };
}
/** Wait for a frame matching `pred`, searching from `since` EVERY iteration.
 *
 *  It must not take a `frames.slice(since)` snapshot: that copy is frozen at call time, so a frame
 *  that arrives afterwards is invisible and the check fails on a working server (measured here —
 *  two checks were red for this reason alone while the gate itself was correct). */
const waitFor = async (frames, pred, ms = 8000, since = 0) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = frames.slice(since).find(pred);
    if (hit) return hit;
    await sleep(100);
  }
  return null;
};
const ready = async (s, title) => {
  const made = await s.api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "mock", cwd: "/tmp", title }) });
  const id = made.body?.id;
  for (let i = 0; i < 80; i++) {
    const rows = (await s.api("/api/sessions")).body.live ?? [];
    if (rows.some((r) => r.id === id && r.status === "ready")) return id;
    await sleep(200);
  }
  throw new Error(`session ${title} never became ready`);
};
const purge = async (s, id) => {
  await s.api(`/api/sessions/${id}`, { method: "DELETE" });
  await s.api(`/api/sessions/${id}`, { method: "DELETE" });
};

const NO_IMAGE = 8921, WITH_IMAGE = 8922;
const blind = await start(NO_IMAGE, { MOCK_IMAGE: "0" });
const sighted = await start(WITH_IMAGE, { MOCK_IMAGE: "1" });
try {
  // ══ the agent that says NO ══════════════════════════════════════════════════════════════════
  const a = await ready(blind, "附件能力-不支持图片（自动删除）");
  const sa = await socket(blind, a);
  try {
    sa.send({ t: "prompt", text: "看看这张图", attachments: IMAGE });
    const refusal = await waitFor(sa.frames, (f) => f.t === "message" && f.message?.kind === "meta"
      && String(f.message?.payload?.text ?? "").includes("turn failed"));
    const said = String(refusal?.message?.payload?.text ?? "");
    check("a picture on a non-vision agent is REFUSED (a turn failure the operator can read)",
      Boolean(refusal) && said.includes("不支持图片输入"), said.slice(0, 120));
    check("…the refusal says what to do (remove it, or pick a model that sees)",
      said.includes("去掉图片") && said.includes("模型"), said.slice(0, 160));
    check("…and the operator's own sentence comes back instead of vanishing",
      refusal?.message?.payload?.rejectedPrompt === "看看这张图", String(refusal?.message?.payload?.rejectedPrompt));
    check("…no turn was started for it (nothing half-sent to the agent)",
      !sa.frames.some((f) => f.t === "turn-start"), `${sa.frames.filter((f) => f.t === "turn-start").length} turn-start`);
    const rows = (await blind.api(`/api/sessions/${a}/messages`)).body.messages ?? [];
    const userRows = rows.filter((m) => m.kind === "user");
    check("…and no user row was written for a message that never left",
      userRows.length === 0, `${userRows.length} user rows`);

    // a TEXT attachment is not gated: it is inlined into the prompt and every agent can read it
    sa.send({ t: "prompt", text: "看看这个文件", attachments: TEXTFILE });
    const started = await waitFor(sa.frames, (f) => f.t === "turn-start");
    check("a text attachment still goes through on the same agent", Boolean(started));
    await waitFor(sa.frames, (f) => f.t === "turn-end", 20_000);
    const rows2 = (await blind.api(`/api/sessions/${a}/messages`)).body.messages ?? [];
    const withFiles = rows2.filter((m) => m.kind === "user" && Array.isArray(m.payload?.attachments) && m.payload.attachments.length);
    check("…and the transcript keeps its name (the badge has something to render)",
      withFiles.length === 1 && withFiles[0].payload.attachments[0].name === "notes.md",
      JSON.stringify(withFiles[0]?.payload?.attachments ?? null));

    // the gate must fire BEFORE taking the floor: a refused image may not cancel a running turn
    sa.send({ t: "prompt", text: "[slow] 我在跑一个长回合" });
    await waitFor(sa.frames, (f) => f.t === "turn-start", 10_000);
    await sleep(600);
    const before = sa.frames.length;
    sa.send({ t: "prompt", text: "插一张图", attachments: IMAGE });
    const errFrame = await waitFor(sa.frames, (f) => f.t === "message"
      && String(f.message?.payload?.text ?? "").includes("不支持图片输入"), 6000, before);
    check("a refused image does not take the floor from the running turn", Boolean(errFrame));
    // A refused prompt must not announce a turn END either: the frame that says "a turn is over" would
    // flip the page to idle while the long turn is still running.
    const bogusEnd = sa.frames.slice(before).find((f) => f.t === "turn-end" && String(f.error ?? "").includes("不支持图片输入")); // snapshot is fine: looked at once, after the wait
    check("…and the refusal does not announce a turn-end (that frame belongs to a turn)", !bogusEnd,
      bogusEnd ? String(bogusEnd.error) : "");
    const end = await waitFor(sa.frames, (f) => f.t === "turn-end", 40_000, before);
    check("…the long turn still ends on its own (it was never cancelled)",
      Boolean(end) && !end.error, end ? `error=${String(end.error ?? "")}` : "no turn-end");
  } finally { sa.close(); await purge(blind, a); }

  // ══ the agent that says YES ═════════════════════════════════════════════════════════════════
  const b = await ready(sighted, "附件能力-支持图片（自动删除）");
  const sb = await socket(sighted, b);
  try {
    sb.send({ t: "prompt", text: "看看这张图", attachments: IMAGE });
    const started = await waitFor(sb.frames, (f) => f.t === "turn-start");
    check("the same picture is ACCEPTED when the agent advertises promptCapabilities.image", Boolean(started));
    const failFrame = sb.frames.find((f) => String(f.message?.payload?.text ?? "").includes("不支持图片输入"));
    check("…and nothing in that transcript claims a refusal", !failFrame);
    await waitFor(sb.frames, (f) => f.t === "turn-end", 20_000);
    const rows = (await sighted.api(`/api/sessions/${b}/messages`)).body.messages ?? [];
    const rowsWithImage = rows.filter((m) => m.kind === "user"
      && (m.payload?.attachments ?? []).some((x) => x.kind === "image"));
    check("…and the image is in the transcript as an attachment (name + kind, no bytes)",
      rowsWithImage.length === 1 && rowsWithImage[0].payload.attachments[0].mimeType === "image/png",
      JSON.stringify(rowsWithImage[0]?.payload?.attachments ?? null));
  } finally { sb.close(); await purge(sighted, b); }
} finally {
  await stop(blind); await stop(sighted);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
