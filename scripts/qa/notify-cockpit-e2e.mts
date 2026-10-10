// MANUAL end-to-end check against a LIVE cockpit (not for CI): it makes a real ACP session,
// sends a prompt that should need approval, and watches the notify channel all the way to
// "the operator pressed allow and the agent continued".
//
//   npx tsx scripts/qa/notify-cockpit-e2e.mts [--base http://127.0.0.1:8788] [--token <machine token>]
//
// It creates its own session in a scratch dir and deletes it at the end. Needs the cockpit to
// be running with the notify routes (i.e. a server started after the notify centre landed).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const BASE = arg("base", "http://127.0.0.1:8788").replace(/\/+$/, "");
const TOKEN = arg("token", fs.existsSync(path.join(REPO, "packages/server/.data/auth.token"))
  ? fs.readFileSync(path.join(REPO, "packages/server/.data/auth.token"), "utf8").trim()
  : "");
const CWD = arg("cwd", fs.mkdtempSync(path.join(os.tmpdir(), "agentus-notify-e2e-")));
const PROMPT = arg("prompt", "请在工作目录里创建文件 notify-e2e.txt（用 shell 命令 touch），然后告诉我就好。");
const WAIT_MS = Number(arg("wait", "90000"));

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const api = async (method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> => {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  try {
    return { status: r.status, json: JSON.parse(text) };
  } catch {
    return { status: r.status, json: text };
  }
};

if (!TOKEN) {
  console.log("no machine token (packages/server/.data/auth.token) — pass --token");
  process.exit(2);
}
fs.mkdirSync(CWD, { recursive: true });
console.log(`cockpit ${BASE} · cwd ${CWD}`);

// ---- pair a simulated device -------------------------------------------------
const codeRes = await api("GET", "/api/notify/pair-code");
check("cockpit exposes the notify routes", codeRes.status === 200 && Boolean(codeRes.json.code), JSON.stringify(codeRes).slice(0, 160));
const pairRes = await api("POST", "/api/notify/pair", {
  code: codeRes.json.code, deviceName: "sim-e2e", platform: "android", sdkInt: 36, appVersion: "0.0.0-sim", schema: 1,
  capabilities: ["live_update", "progress", "actions", "remote_input", "channels", "deeplink"],
});
check("device paired against the cockpit", pairRes.status === 200 && Boolean(pairRes.json.deviceToken), JSON.stringify(pairRes).slice(0, 160));
const deviceToken: string = pairRes.json.deviceToken;

const frames: any[] = [];
const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/notify/ws?token=${deviceToken}`);
ws.on("message", (d: Buffer) => {
  const f = JSON.parse(d.toString());
  frames.push(f);
  if (f.t === "activity") {
    const a = f.activity;
    console.log(`    <- seq ${f.seq} ${a.op} ${a.activityId} ${a.kind ?? ""} "${a.title}"` +
      `${a.actions?.length ? ` actions=[${a.actions.map((x: any) => x.id).join(",")}]` : ""}`);
  }
});
await new Promise((r) => ws.on("open", r));
await sleep(300);
const hello = frames.find((f) => f.t === "hello");
check("socket handshake (hello)", Boolean(hello), JSON.stringify(frames[0] ?? null));

// ---- a real agent turn -------------------------------------------------------
const created = await api("POST", "/api/sessions", { backend: "hermes", cwd: CWD, workspace: CWD });
const sessionId: string = created.json?.id;
check("a real session was created", Boolean(sessionId), JSON.stringify(created).slice(0, 200));
if (!sessionId) {
  ws.close();
  process.exit(1);
}
// The approval path only exists in a mode that ASKS. Modes are per session and the operator's
// last choice persists, so a fresh slot can silently be in accept_edits/dont_ask.
const live = await api("GET", "/api/sessions");
const info = (live.json?.live ?? []).find((s: any) => s.id === sessionId);
const modes = info?.modes?.availableModes ?? [];
console.log(`    modes: ${modes.map((m: any) => m.id).join(", ") || "(none advertised)"} · current ${info?.modes?.currentModeId}`);
const asking = modes.find((m: any) => /^default$|ask|normal|manual/i.test(m.id));
if (asking && asking.id !== info?.modes?.currentModeId) {
  const set = await api("POST", `/api/sessions/${sessionId}/mode`, { modeId: asking.id });
  check(`switched the slot into an asking mode (${asking.id})`, set.status === 200, JSON.stringify(set).slice(0, 120));
} else if (!asking) {
  console.log("    (no asking mode advertised — the approval branch will be reported as unexercised)");
}
// A device that reconnects REPLAYS everything it missed, so every assertion below has to be
// scoped to frames newer than the cursor at this moment — otherwise a stale card from an
// earlier run satisfies the predicate (that produced a bogus "already handled" 409 once).
// Take the baseline BEFORE the prompt: the turn's own events must count as new.
let baseline = 0;
for (const f of frames) if (f.t === "activity") baseline = Math.max(baseline, f.seq ?? 0);
console.log(`    baseline seq ${baseline}（只看这之后的事件）`);

const sent = await api("POST", `/api/sessions/${sessionId}/prompt`, { text: PROMPT });
check("prompt accepted", sent.status === 200 || sent.status === 202, JSON.stringify(sent).slice(0, 160));

const activities = () => frames
  .filter((f) => f.t === "activity" && (f.seq ?? 0) > baseline)
  .map((f) => f.activity);
const waitFor = async (pred: (a: any[]) => boolean, ms = WAIT_MS): Promise<boolean> => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred(activities())) return true;
    await sleep(300);
  }
  return false;
};

const sawRunning = await waitFor((all) => all.some((a) => a.kind === "agent_running" && a.ongoing));
check("turn-start became an ongoing (promotable) activity", sawRunning, `activities=${activities().map((a) => a.kind).join(",")}`);
const running = [...activities()].reverse().find((a) => a.kind === "agent_running");
  check("the running activity asks to be promoted", running?.promotable === true, JSON.stringify(running?.progress ?? null));
  check("the running activity points at the cockpit", String(running?.deeplink ?? "").includes(sessionId), String(running?.deeplink));

const sawApproval = await waitFor((all) => all.some((a) => a.kind === "approval" && (a.actions ?? []).length > 0));
check("a permission request became an approval activity with buttons", sawApproval,
  `activities=${activities().map((a) => a.kind).join(",")}`);

let resolvedViaButton = false;
if (sawApproval) {
  const approval = [...activities()].reverse().find((a) => a.kind === "approval");
  const allow = (approval.actions ?? []).find((a: any) => /allow|accept|approve|yes|once|proceed/i.test(a.id))
    ?? approval.actions[0];
  console.log(`    按：${allow.id} (${allow.label})`);
  const pressed = await fetch(`${BASE}/api/notify/actions`, {
    method: "POST",
    headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
    body: JSON.stringify({ activityId: approval.activityId, revision: approval.revision, actionId: allow.id, input: null, ts: Date.now() }),
  });
  check("button press accepted by the cockpit", pressed.status === 200, `status=${pressed.status} ${await pressed.text()}`);
  // the cockpit answers the permission -> emits permission-resolved -> our centre dismisses the card
  resolvedViaButton = await waitFor((all) => all.some((a) => a.op === "dismiss" && a.activityId === approval.activityId), 30000);
  check("the agent's pending permission was actually resolved by that press", resolvedViaButton,
    `frames=${frames.filter((f) => f.t === "activity").map((f) => `${f.activity.op}:${f.activity.activityId}`).join(" ")}`);
}

const sawDone = await waitFor((all) => all.some((a) => a.activityId?.startsWith("done:")), 120000);
check("turn-end became a completion activity", sawDone, `activities=${activities().map((a) => a.activityId).join(",")}`);
const done = activities().find((a) => a.activityId?.startsWith("done:"));
check("the completion activity is NOT pretending to be ongoing", done?.ongoing === false && done?.promotable !== true);

if (resolvedViaButton || sawDone) {
  const msgs = await api("GET", `/api/sessions/${sessionId}/messages?limit=50`);
  const text = JSON.stringify(msgs.json);
  check("the session kept going (the approval did not break the turn)", msgs.status === 200 && text.length > 50,
    `status=${msgs.status}`);
}

// ---- leave no trace ----------------------------------------------------------
const killed = await api("DELETE", `/api/sessions/${sessionId}`);
check("the scratch session was closed", killed.status === 200, JSON.stringify(killed).slice(0, 160));
ws.close();
await sleep(200);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} ok, ${fail} failed`);
console.log(`session ${sessionId} · cwd ${CWD} · frames ${frames.length}`);
process.exit(fail === 0 ? 0 : 1);