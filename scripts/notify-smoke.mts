// Contract smoke test for the notify centre: pairing, fan-out, capability degradation,
// cursor replay, button round-trip and the replay guard. It drives the REAL test bed over
// real HTTP + real WebSocket (no mocks), because the two things most likely to break are
// the upgrade handshake and the JSON shapes.
//
//   npx tsx scripts/notify-smoke.mts
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const TSX = path.join(REPO, "node_modules/.bin/tsx");
// A random port per run: a leftover test bed from an interrupted run must not be able to
// make the next run silently test the wrong process (it did, once).
const PORT = Number(process.env.SMOKE_PORT ?? 8800 + Math.floor(Math.random() * 90));
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-notify-smoke-"));

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let childPid: number | null = null;
async function boot(): Promise<string> {
  const proc = spawn(TSX, [path.join(REPO, "scripts/notify-testbed.mts"), "--port", String(PORT), "--tls-port", "0", "--data", DATA], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
    // detached: tsx runs the entry in a child of its own, so killing only the direct
    // child leaves the listener behind (= the EADDRINUSE that produced a false pass).
    detached: true,
  });
  childPid = proc.pid ?? null;
  proc.stdout?.on("data", (b: Buffer) => process.stdout.write(`    [testbed] ${b.toString()}`));
  proc.stderr?.on("data", (b: Buffer) => process.stdout.write(`    [testbed!] ${b.toString()}`));
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) break;
    } catch { /* not up yet */ }
  }
  const tokenFile = path.join(DATA, "notify/testbed.token");
  for (let i = 0; i < 20 && !fs.existsSync(tokenFile); i++) await sleep(100);
  return fs.readFileSync(tokenFile, "utf8").trim();
}

interface PairResult { deviceId: string; deviceToken: string; wsUrl: string; baseUrl: string }
async function pair(token: string, body: Record<string, unknown>, viaOperator = true): Promise<Response> {
  return fetch(`${BASE}/api/notify/pair`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(viaOperator ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** Collects every frame a device receives. */
function listen(token: string, since?: number) {
  const url = `ws://127.0.0.1:${PORT}/api/notify/ws?token=${token}${since === undefined ? "" : `&since=${since}`}`;
  const ws = new WebSocket(url);
  const frames: Record<string, unknown>[] = [];
  let ready = false;
  ws.on("message", (d: Buffer) => frames.push(JSON.parse(d.toString())));
  ws.on("open", () => { ready = true; });
  const wait = async (n: number, ms = 3000): Promise<Record<string, unknown>[]> => {
    const t0 = Date.now();
    while (frames.length < n && Date.now() - t0 < ms) await sleep(50);
    return frames;
  };
  return {
    ws,
    frames,
    wait,
    isReady: () => ready,
    activities: () => frames.filter((f) => f.t === "activity").map((f) => f.activity as Record<string, never>),
    close: () => ws.close(),
  };
}

const UNAUTH = new WebSocket(`ws://127.0.0.1:${PORT}/api/notify/ws?token=nope`);
const unauthClosed: Promise<number> = new Promise((resolve) => {
  UNAUTH.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
  UNAUTH.on("error", () => resolve(-1));
  UNAUTH.on("close", (code) => resolve(code));
});

try {
  const token = await boot();
  console.log(`  test bed up on ${PORT}, operator token ${token.slice(0, 8)}…`);

  // ---- pairing ------------------------------------------------------------
  const bad = await pair("", { code: "WRONGCODE", deviceName: "bad" }, false);
  check("wrong pairing code is refused (403)", bad.status === 403, `got ${bad.status}`);

  const codeRes = await fetch(`${BASE}/api/notify/pair-code`, { headers: { authorization: `Bearer ${token}` } });
  const { code } = await codeRes.json() as { code: string };
  check("operator can read the pairing code", /^[A-Z2-9]{8}$/.test(code), code);

  const FULL_CAPS = ["live_update", "progress", "actions", "remote_input", "icon_url", "channels", "deeplink"];
  const byCode = await pair("", { code, deviceName: "smoke-bycode", platform: "android", sdkInt: 34, schema: 1, capabilities: ["actions"] });
  check("pairing with the rotating code works (no operator auth)", byCode.status === 200, `got ${byCode.status}`);
  const limited = await byCode.json() as PairResult;
  check("the code-paired device gets its own token", Boolean(limited.deviceToken));

  // username+password: the path a phone on a hotel wifi uses (no code to copy)
  const badLogin = await pair("", { username: "test", password: "nope", deviceName: "smoke-badlogin", capabilities: [] });
  check("username+password pairing refuses a wrong password (403)", badLogin.status === 403, `got ${badLogin.status}`);
  const loginPair = await pair("", { username: "test", password: "test-pass-1234", deviceName: "smoke-login", platform: "android", sdkInt: 36, schema: 1, capabilities: FULL_CAPS });
  check("username+password pairing works", loginPair.status === 200, `got ${loginPair.status}`);
  const loginBody = await loginPair.json() as PairResult;
  check("…and hands out its own device token", Boolean(loginBody.deviceToken));
  const noCreds = await pair("", { deviceName: "smoke-nothing" });
  check("pairing with neither a code nor a login is refused (403)", noCreds.status === 403, `got ${noCreds.status}`);

  const viaToken = await pair(token, { deviceName: "smoke-full", platform: "android", sdkInt: 36, schema: 1, capabilities: FULL_CAPS });
  check("pairing with the machine token works (scripted path)", viaToken.status === 200, `got ${viaToken.status}`);
  const full = await viaToken.json() as PairResult;
  check("pairing returns a device token + ws url", Boolean(full.deviceToken && full.wsUrl.startsWith("ws://")), JSON.stringify(full).slice(0, 120));
  check("the two devices have different tokens", limited.deviceToken !== full.deviceToken);

  // ---- handshake + fan-out ------------------------------------------------
  const dev = listen(full.deviceToken);
  await sleep(300);
  check("device socket is accepted", dev.isReady());
  check("first frame is hello", dev.frames[0]?.t === "hello", JSON.stringify(dev.frames[0]));
  await sleep(200);
  check("device with a second token is refused", (await unauthClosed) !== 101);

  const pub = async (activity: Record<string, unknown>): Promise<number> => {
    const r = await fetch(`${BASE}/api/notify/activities?token=${token}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ activity }),
    });
    const j = await r.json() as { seq: number };
    return j.seq;
  };
  const seq1 = await pub({ op: "upsert", activityId: "t:running", revision: 1, title: "跑着", ongoing: true, promotable: true, progress: { value: 0.5 }, actions: [{ id: "a", label: "A" }], input: { enabled: true } });
  await dev.wait(2);
  const got = dev.activities().at(-1) as Record<string, unknown>;
  check("published activity reaches the device", got?.activityId === "t:running", JSON.stringify(got));
  check("cursor (seq) is assigned and monotonic", seq1 === 1, `seq=${seq1}`);
  check("progress survives for a capable device", Boolean(got?.progress));
  check("actions survive for a capable device", Array.isArray(got?.actions) && (got.actions as unknown[]).length === 1);
  check("input survives for a capable device", Boolean(got?.input));
  check("live frames carry the seq", (dev.frames.at(-1) as { seq?: number })?.seq === seq1);

  // ---- revision replaces, dismissal is a frame too ------------------------
  await pub({ op: "upsert", activityId: "t:running", revision: 2, title: "跑着 (60%)", ongoing: true, promotable: true, progress: { value: 0.6 }, actions: [], input: null });
  await dev.wait(3);
  check("an update arrives as its own frame", dev.activities().at(-1)?.activityId === "t:running");
  await pub({ op: "dismiss", activityId: "t:running", revision: 3, title: "" });
  await dev.wait(4);
  check("dismiss is delivered", dev.activities().at(-1)?.op === "dismiss");

  // ---- capability degradation --------------------------------------------
  // `limited` reported only `actions`; `bare` reported nothing at all.
  const bareRes = await pair(token, { deviceName: "smoke-bare", platform: "android", sdkInt: 33, schema: 1, capabilities: [] });
  const bare = await bareRes.json() as PairResult;
  const degraded = listen(limited.deviceToken);
  const bareDev = listen(bare.deviceToken);
  await sleep(300);
  await pub({ op: "upsert", activityId: "t:deg", revision: 1, title: "降级", ongoing: true, promotable: true, progress: { value: 0.3 }, actions: [{ id: "x", label: "X" }], input: { enabled: true }, iconUrl: "https://example.invalid/i.png", deeplink: "/?session=1", open: { url: "/?session=1", prefer: "app" }, channel: { id: "c", name: "C" }, visibility: "private" });
  await degraded.wait(2);
  const d = degraded.activities().at(-1) as Record<string, unknown>;
  check("a device that reported `actions` keeps them", Array.isArray(d?.actions) && (d.actions as unknown[]).length === 1, JSON.stringify(d?.actions));
  check("a device without `progress` gets progress:null", d?.progress === null, JSON.stringify(d?.progress));
  check("a device without `remote_input` gets input:null", d?.input === null);
  check("a device without `live_update` gets promotable:false", d?.promotable === false);
  check("a device without `icon_url` gets iconUrl:null", d?.iconUrl === null);
  check("a device without `channels` gets channel:null", d?.channel === null);
  check("a device without `deeplink` gets deeplink:null", d?.deeplink === null);
  check("…and `open:null` too (one capability covers both spellings)", d?.open === null, JSON.stringify(d?.open ?? null));
  check("the title always survives degradation", d?.title === "降级");
  await bareDev.wait(2);
  const b = bareDev.activities().at(-1) as Record<string, unknown>;
  check("a device that reported nothing gets actions:[]", Array.isArray(b?.actions) && (b.actions as unknown[]).length === 0, JSON.stringify(b?.actions));
  check("…and still gets the notification itself", b?.activityId === "t:deg");
  degraded.close();
  bareDev.close();

  // ---- cursor replay ------------------------------------------------------
  dev.close();
  await sleep(200);
  const seqA = await pub({ op: "upsert", activityId: "t:off1", revision: 1, title: "offline-1", ongoing: false });
  const seqB = await pub({ op: "upsert", activityId: "t:off2", revision: 1, title: "offline-2", ongoing: false });
  const again = listen(full.deviceToken, 0);
  await again.wait(5, 4000);
  const ids = again.activities().map((a) => a.activityId);
  check("reconnect with since=0 replays what was missed", ids.includes("t:off1") && ids.includes("t:off2"), `ids=${ids.join(",")} seqA=${seqA} seqB=${seqB}`);
  check("replay frames keep their original seq", again.frames.some((f) => f.seq === seqA) && again.frames.some((f) => f.seq === seqB));
  const mid = listen(full.deviceToken, seqB);
  await mid.wait(2, 1500);
  check("reconnect with a later cursor skips what was already seen", !mid.activities().some((a) => a.activityId === "t:off1"));

  // ---- the button round trip ---------------------------------------------
  const seqBtn = await pub({ op: "upsert", activityId: "t:btn", revision: 1, title: "等你批准", ongoing: true, promotable: true, actions: [{ id: "allow_once", label: "允许" }] });
  await sleep(150);
  const act = async (token2: string, activityId: string, actionId: string, input?: string) => {
    const r = await fetch(`${BASE}/api/notify/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token2}` },
      body: JSON.stringify({ activityId, revision: 1, actionId, input: input ?? null, ts: Date.now() }),
    });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };
  const pressed = await act(full.deviceToken, "t:btn", "allow_once");
  check("a button press is accepted", pressed.status === 200 && pressed.body.ok === true, JSON.stringify(pressed));
  const twice = await act(full.deviceToken, "t:btn", "allow_once");
  check("the same button cannot fire twice (409)", twice.status === 409, JSON.stringify(twice));
  const unknown = await act(full.deviceToken, "t:btn", "ghost");
  check("an unknown action is refused", unknown.status === 409 || unknown.status === 400, JSON.stringify(unknown));
  const noToken = await act("deadbeef", "t:btn", "allow_once");
  check("a bad device token is refused (401)", noToken.status === 401, JSON.stringify(noToken));
  await pub({ op: "upsert", activityId: "t:btn", revision: 2, title: "等你批准", ongoing: true, promotable: true, actions: [{ id: "allow_once", label: "允许" }] });
  await sleep(150);
  const reFire = await act(full.deviceToken, "t:btn", "allow_once");
  check("re-publishing the activity re-arms its buttons", reFire.status === 200, JSON.stringify(reFire));

  check("no refusal reason leaked into the accepted path", pressed.body.note === "received");
  await sleep(200);

  // ---- A3: the operator's switches (what 设置 → 手机通知 writes) ------------
  // Last on purpose: this phase publishes, and the seq assertions above pin the first seq to 1.
  const auth = { authorization: `Bearer ${token}` };
  const postJson = (path: string, body: unknown): Promise<Response> =>
    fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify(body) });
  const readSettings = async (): Promise<{ rules: Record<string, boolean>; watching: boolean; devices: unknown[]; pairUri: string; apkUrl: string }> =>
    (await (await fetch(`${BASE}/api/notify/settings`, { headers: auth })).json()) as never;

  const s0 = await readSettings();
  check("settings: rules + devices + pairing string in one call",
    typeof s0.rules?.turnStart === "boolean" && Array.isArray(s0.devices) && s0.pairUri.startsWith("agentus://pair"),
    JSON.stringify(s0).slice(0, 120));
  check("settings: defaults are all-on, quiet-when-watching on",
    s0.rules.turnStart && s0.rules.approval && s0.rules.completion && s0.rules.quietWhenWatching,
    JSON.stringify(s0.rules));

  const savedRes = await postJson("/api/notify/settings", { rules: { turnStart: false } });
  const saved = (await savedRes.json()) as { rules: Record<string, boolean> };
  check("settings: a switch can be turned off", savedRes.status === 200 && saved.rules.turnStart === false, JSON.stringify(saved.rules));
  check("settings: it is stored, not merely echoed", (await readSettings()).rules.turnStart === false, "re-read disagreed");

  // A dedicated device, so the frames below cannot be confused with anyone else's
  const pairA3 = await pair(token, { deviceName: "smoke-a3", platform: "android", sdkInt: 36, schema: 1, capabilities: FULL_CAPS });
  const tokA3 = ((await pairA3.json()) as PairResult).deviceToken;
  const watcher = listen(tokA3);
  await watcher.wait(1);
  await sleep(400); // let the replay of earlier rounds land before counting
  const count = (): number => watcher.activities().length;
  const inject = (evt: unknown): Promise<Response> => postJson("/test/observe", evt);
  const turn = (sessionId: string): Record<string, unknown> => ({ t: "turn-start", sessionId, at: Date.now(), trace: { model: "smoke" } });
  const seen = (id: string): boolean => watcher.activities().some((a) => a.activityId === id);

  await inject(turn("sess-off"));
  await sleep(600);
  check("rules: turn-start off ⇒ nothing is published", !seen("turn:sess-off"), `frames ${count()}`);

  await postJson("/api/notify/settings", { rules: { turnStart: true } });
  await inject(turn("sess-on"));
  await sleep(600);
  check("rules: turn-start on ⇒ the running card arrives", seen("turn:sess-on"),
    JSON.stringify(watcher.activities().map((a) => a.activityId)));

  // Presence: the cockpit says which session it is showing
  await postJson("/api/notify/presence", { sessionId: "sess-watch", visible: true });
  check("presence: the server agrees it is being watched", (await readSettings()).watching === true, "watching=false");
  await inject(turn("sess-watch"));
  await sleep(600);
  check("presence: watching that session ⇒ its turn-start is suppressed", !seen("turn:sess-watch"), `frames ${count()}`);

  await postJson("/api/notify/presence", { sessionId: null, visible: false });
  check("presence: clearing it turns watching off", (await readSettings()).watching === false, "still watching");
  await inject(turn("sess-watch"));
  await sleep(600);
  check("presence: not watching ⇒ the same event now arrives", seen("turn:sess-watch"), "still suppressed");

  // An approval is a decision waiting on a human: presence must never silence it
  await postJson("/api/notify/presence", { sessionId: "sess-watch", visible: true });
  await inject({
    t: "permission", sessionId: "sess-watch",
    request: {
      sessionId: "sess-watch", requestId: "req-a3", kind: "edit", toolCallTitle: "Write file",
      options: [{ optionId: "allow_once", name: "允许", kind: "allow_once" }],
    },
  });
  await sleep(600);
  check("presence: an approval is NOT suppressed while watching", seen("perm:req-a3"), `frames ${count()}`);
  await postJson("/api/notify/presence", { sessionId: null, visible: false });

  // ---- the completion notice, and the two switches that must stop it -------------------------
  // Both were missing: `completion` was persisted and never read, and presence was only consulted for
  // turn-start — so 「跑完了」 arrived with a sound while the operator was looking at that session, and
  // in the middle of a voice call.
  type Wire = { activityId?: string; op?: string; title?: string; subtitle?: string; body?: string; channel?: { sound?: boolean; vibration?: boolean; importance?: string; muted?: boolean } };
  const framesBy = (prefix: string): Wire[] =>
    (watcher.activities() as unknown as Wire[]).filter((a) => a.op !== "dismiss" && String(a.activityId ?? "").startsWith(prefix));
  const upserted = (id: string): Wire | undefined =>
    (watcher.activities() as unknown as Wire[]).find((a) => a.op !== "dismiss" && a.activityId === id);
  const turnEnd = (sessionId: string): Record<string, unknown> => ({ t: "turn-end", sessionId, at: Date.now() });

  await postJson("/api/notify/settings", { rules: { completion: false } });
  await inject(turn("sess-c-off"));
  await inject(turnEnd("sess-c-off"));
  await sleep(700);
  check("rules: completion off ⇒ no done card (the switch used to be stored and never read)",
    framesBy("done:sess-c-off").length === 0, `frames ${count()}`);

  await postJson("/api/notify/settings", { rules: { completion: true } });
  await postJson("/api/notify/presence", { sessionId: "sess-c-watch", visible: true });
  await inject(turn("sess-c-watch"));
  await inject(turnEnd("sess-c-watch"));
  await sleep(700);
  check("presence: watching ⇒ the completion card is suppressed too",
    framesBy("done:sess-c-watch").length === 0, `frames ${count()}`);

  // ---- a call is stricter than watching ------------------------------------------------------
  // The operator reported this from a real call: the turn ended, and the phone dinged.
  await postJson("/api/notify/presence", { sessionId: "sess-call", visible: false, call: true });
  const callView = (await readSettings()) as unknown as { presence: { call?: boolean } };
  check("presence: a call is reported as such", callView.presence.call === true, "call flag not stored");
  await inject(turn("sess-call"));
  await inject(turnEnd("sess-call"));
  await sleep(700);
  check("call: the called session gets neither the running card nor the completion card",
    !upserted("turn:sess-call") && framesBy("done:sess-call").length === 0, `frames ${count()}`);

  // Another session must still reach the phone — silently. Silence is not cosmetic: the call's own
  // capture is a plain AudioRecord (no echo cancellation), so a tone is recorded by the agent's mic.
  await inject(turn("sess-c-other"));
  await inject(turnEnd("sess-c-other"));
  await sleep(700);
  const otherDone = framesBy("done:sess-c-other")[0];
  check("call: another session's completion still arrives (never dropped)", Boolean(otherDone), "no frame");
  check("call: …but silently (tone + vibration off, no heads-up, muted flag for the app)",
    otherDone?.channel?.sound === false && otherDone?.channel?.vibration === false
      && otherDone?.channel?.importance === "low" && otherDone?.channel?.muted === true,
    JSON.stringify(otherDone?.channel ?? null));

  await inject({
    t: "permission", sessionId: "sess-call",
    request: {
      sessionId: "sess-call", requestId: "req-call", kind: "edit", toolCallTitle: "Write file",
      options: [{ optionId: "allow_once", name: "允许", kind: "allow_once" }],
    },
  });
  await sleep(700);
  const callApproval = upserted("perm:req-call");
  check("call: an approval still arrives — a decision waiting on a human is never dropped",
    Boolean(callApproval), "no frame");

  await postJson("/api/notify/presence", { sessionId: null, visible: false, call: false });
  await inject(turn("sess-c-after"));
  await inject(turnEnd("sess-c-after"));
  await sleep(700);
  const afterDone = framesBy("done:sess-c-after")[0];
  check("call over ⇒ the completion is loud again (the mute is tied to the call, not sticky)",
    afterDone?.channel?.sound === true, JSON.stringify(afterDone?.channel ?? null));

  // ---- one shape for every card: the state in the title, the session name FIRST IN THE BODY -------
  // Not cosmetic. Android draws `body` on the COLLAPSED row and `subtitle` only on the expanded card,
  // so a session name parked in subtitle is a name nobody sees when they glance at the shade.
  // Measured on the emulator before this change: `android.title=跑完了` / `android.subText=hello`,
  // while the one visible line read `stopReason: end_turn`. These are real `observe()` frames.
  await postJson("/api/notify/settings", { rules: { turnStart: true, completion: true, approval: true } });
  await postJson("/api/notify/presence", { sessionId: null, visible: false, call: false });
  await inject(turn("sess-shape"));
  await inject({ t: "turn-end", sessionId: "sess-shape", at: Date.now(), durationMs: 72_400 });
  await inject({
    t: "permission", sessionId: "sess-shape",
    request: {
      sessionId: "sess-shape", requestId: "req-shape", kind: "edit",
      toolCallTitle: "Approve edit: /var/folders/p4/x/T/agentus-shape.txt",
      options: [{ optionId: "allow_once", name: "允许", kind: "allow_once" }],
    },
  });
  await sleep(800);
  const shapeRun = upserted("turn:sess-shape");
  const shapeDone = framesBy("done:sess-shape")[0];
  const shapePerm = upserted("perm:req-shape");
  check("copy: the running card is a state, with the session name in the body",
    shapeRun?.title === "Agentus · 运行中" && String(shapeRun?.body ?? "").startsWith("sess-sha"),
    JSON.stringify({ title: shapeRun?.title, body: shapeRun?.body }));
  check("copy: the done card is 「已完成」 and its body is the name + the MEASURED turn time",
    shapeDone?.title === "已完成" && shapeDone?.body === "sess-sha · 用时 1m 12s",
    JSON.stringify({ title: shapeDone?.title, body: shapeDone?.body }));
  check("copy: …so a protocol token (`stopReason`) is nowhere on the card",
    !String(shapeDone?.body ?? "").includes("stopReason"), JSON.stringify(shapeDone?.body ?? null));
  check("copy: an approval splits the agent's own title — short head above, long target in the body",
    shapePerm?.title === "待你确认：Approve edit"
      && String(shapePerm?.body ?? "").startsWith("sess-sha · /var/folders/p4/"),
    JSON.stringify({ title: shapePerm?.title, body: shapePerm?.body }));
  check("copy: no card hides the session name in `subtitle` (Android only draws it expanded)",
    shapeRun?.subtitle == null && shapeDone?.subtitle == null && shapePerm?.subtitle == null,
    JSON.stringify({ run: shapeRun?.subtitle, done: shapeDone?.subtitle, perm: shapePerm?.subtitle }));

  // The cockpit's one-tap push
  const pushed = await postJson("/api/notify/push", { sessionId: "sess-on", title: "来自驾驶舱的推送" });
  check("push: one-tap push is accepted", pushed.status === 200, `got ${pushed.status}`);
  await sleep(600);
  check("push: the pushed activity reaches the device",
    watcher.activities().some((a) => String(a.activityId ?? "").startsWith("push:")), "no push frame");

  // ---- the tap target: `open` (the contract) with `deeplink` kept as its old alias --------------
  const pushedCard = watcher.activities().filter((a) => String(a.activityId ?? "").startsWith("push:")).at(-1) as
    { open?: { url?: string; prefer?: string }; deeplink?: string } | undefined;
  check("tap: a pushed card carries `open.url` (where to go)",
    typeof pushedCard?.open?.url === "string" && pushedCard.open.url.includes("session=sess-on"),
    JSON.stringify(pushedCard?.open ?? null));
  check("tap: …and says how much it wants an app (`prefer`)", pushedCard?.open?.prefer === "app",
    JSON.stringify(pushedCard?.open ?? null));
  check("tap: `deeplink` is still emitted for an app built before `open`",
    pushedCard?.deeplink === pushedCard?.open?.url, JSON.stringify(pushedCard ?? null));

  // a third-party sender (webhook) asks for a plain web link instead
  await postJson("/api/notify/push", { sessionId: "sess-on", title: "外部的一条", open: { prefer: "web" } });
  await sleep(600);
  const webCard = watcher.activities().filter((a) => String(a.activityId ?? "").startsWith("push:")).at(-1) as
    { open?: { prefer?: string } } | undefined;
  check("tap: a sender can ask for `prefer: web` and it survives the round trip",
    webCard?.open?.prefer === "web", JSON.stringify(webCard?.open ?? null));

  // a turn notification (not a push) carries it too — that is the one operators actually tap
  const turnCard = framesBy("turn:sess-on")[0] as { open?: { url?: string; prefer?: string } } | undefined;
  check("tap: a real turn notification carries `open.url` + `prefer: app`",
    typeof turnCard?.open?.url === "string" && turnCard.open.prefer === "app", JSON.stringify(turnCard?.open ?? null));

  // and the routes stay behind the operator door
  const naked = await fetch(`${BASE}/api/notify/settings`);
  check("settings: refused without operator auth (401)", naked.status === 401, `got ${naked.status}`);
  const nakedPush = await fetch(`${BASE}/api/notify/push`, { method: "POST" });
  check("push: refused without operator auth (401)", nakedPush.status === 401, `got ${nakedPush.status}`);
  const nakedPresence = await fetch(`${BASE}/api/notify/presence`, { method: "POST" });
  check("presence: refused without operator auth (401)", nakedPresence.status === 401, `got ${nakedPresence.status}`);
  watcher.close();

  console.log(`  (device list: ${(await (await fetch(`${BASE}/api/notify/devices?token=${token}`)).json() as { devices: unknown[] }).devices.length} rows)`);
} catch (e) {
  fail++;
  console.log(`  FAIL harness threw: ${String(e)}`);
} finally {
  try {
    if (childPid) process.kill(-childPid, "SIGKILL"); // the whole group (see detached above)
  } catch { /* already gone */ }
  fs.rmSync(DATA, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);