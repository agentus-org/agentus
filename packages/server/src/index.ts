// Agentus server entry: HTTP (REST + static web build) + WebSocket relay.
// The browser never talks to CLI subprocesses directly (design.md §1).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import { Store, textOf } from "./store/store.js";
import { routeForModel, type SpeechRoute } from "./speech/route.js";
import { exportFilename, renderJson, renderMarkdown, type ExportSessionHeader } from "./store/export.js";
import { IMAGE_UNSUPPORTED, SessionManager, SessionUnavailable } from "./acp/session-manager.js";
import { describeAcpError } from "./acp/errors.js";
import { BACKENDS } from "./acp/backends.js";
import { HERMES_DEFAULT_HOME, classifyError, checkedHealth, coerceRow, inspectRow, planFor, rowWarnings, seedRows, startupCheck } from "./acp/registry.js";
import { ChangedOnDiskError, FsError, listDirs, readTextFile, statFile, writeTextFile } from "./fs.js";
import { acquireInstanceLock, humanAge } from "./instance-lock.js";
import { createFrameGate } from "./ws-order.js";
import * as ide from "./ide/proxy.js";
import { terms } from "./term.js";
import { VoiceError, listVoiceModels, setHotwordSource, synthesize, transcribe, voiceCapabilities } from "./voice.js";
import { dictationContext, hotwordsFor, vocabularyOf } from "./hotwords.js";
import { DashscopeTtsConnection, openDashscopeStream, summarizeForSpeech } from "./dashscope.js";
import {
  SUMMARY_CHARS_RANGE, SUMMARY_MODEL_DEFAULT, SUMMARY_PROMPT_DEFAULT,
  SUMMARY_MAX_INPUT_CHARS, SUMMARY_THINKING_BUDGET,
  agentSettings, getSettings, initSettings, observerSettings, planHintSettings, publicSettings,
  saveAgent, saveCall, saveObserver, savePrefs, saveSettings, saveSummary, saveTheme, summarySettings,
  modelUsage,
} from "./settings.js";
import { ObserverHub } from "./observer/hub.js";
import {
  SPEAK_INTERVAL_MAX, allSessionSpeak, clearSessionSpeak, initSessionSpeak, resolveSpeak, setSessionSpeak,
} from "./session-speak.js";
import * as auth from "./auth.js";
import { NotifyCenter } from "./notify/center.js";
import type { BackendId, ClientCommand, PermissionDecision, PromptAttachment, ServerEvent, SessionInfo } from "../../shared/src/index.js";
import {
  COCKPIT_ERRORS, COCKPIT_SCHEMA_VERSION, MESSAGES_TAIL_DEFAULT, MESSAGE_ROLES, capabilities, isMessageRole,
  listSessions, parseSince, sendAllowed, sessionRow, tailMessages, type ListQuery,
} from "./cockpit/api.js";

const PORT = Number(process.env.AGENTUS_PORT ?? 8788);

// The INSTANCE's own name (issue #19). One person runs several cockpits — live, a pre-release box,
// the one at home — and every tab plus every home-screen icon said "Agentus", so the only way to
// tell them apart was the domain. The name is not a build input: the HTML is already served
// no-store and names the hashed bundle, so renaming it here costs nothing and needs no rebuild.
// Unset keeps "Agentus" byte for byte, so an install that never set it is unchanged.
const TITLE = (process.env.AGENTUS_TITLE ?? "").trim() || "Agentus";
// Data + web build resolve against THIS FILE, not the shell's cwd: `scripts/start.sh`
// launches from the repo root while the dev server runs from packages/server, and a
// cwd-relative path would silently open a second database (the operator's slots would
// "disappear"). Both entry points must land on the same store.
const HERE = path.dirname(fileURLToPath(import.meta.url)); // …/packages/server/src
// WHERE STATE LIVES — sqlite, credentials.json, auth.token, settings.json.
//   1. `AGENTUS_DATA` when it is set. Every launcher and dev/QA instance pins it, so the
//      rules below can never move a running install's data out from under it.
//   2. `~/.agentus` once it holds something, or when there is no repo-side data yet.
//   3. the in-repo `<repo>/packages/server/.data`, if it exists and ~/.agentus does not —
//      an existing checkout keeps its sessions instead of silently starting empty (that
//      failure mode looks exactly like "all my sessions vanished"; the boot log says which
//      directory won and how to move).
// NOTHING may write inside node_modules: for an installed package
// `<pkg>/packages/server/.data` is deleted by the next `npm i -g agentus`, taking the
// transcript and the login with it.
const DEFAULT_DATA_DIR = path.join(homedir(), ".agentus");
const REPO_DATA_DIR = path.resolve(HERE, "../.data");
const hasData = (dir: string): boolean => {
  try { return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length > 0; } catch { return false; }
};
// An empty AGENTUS_DATA counts as unset (a launcher that clears a variable writes
// `AGENTUS_DATA=`), otherwise it would resolve to the shell's cwd.
const ENV_DATA_DIR = process.env.AGENTUS_DATA?.trim() || null;
const DATA_DIR = ENV_DATA_DIR
  ?? (hasData(DEFAULT_DATA_DIR) || !hasData(REPO_DATA_DIR) ? DEFAULT_DATA_DIR : REPO_DATA_DIR);
const DATA_DIR_SOURCE = ENV_DATA_DIR
  ? "from AGENTUS_DATA"
  : DATA_DIR === REPO_DATA_DIR
    ? "in-repo packages/server/.data"
    : hasData(DEFAULT_DATA_DIR) ? "existing ~/.agentus" : "default ~/.agentus (created on this boot)";
// WHICH CODE THIS PROCESS IS RUNNING — resolved once, at boot, on purpose.
//
// The live server has no watcher, so the only thing that decides "is this release live?" is what
// this process loaded. A promote used to compare the live tree's previous checkout with the new
// tip, which stops being true the moment anything moves the tree first (an earlier promote that
// died after checkout, a manual `git checkout`, a re-run): every later promote then saw a zero
// diff, printed "no server-side change" and left the old process serving — the release looked
// green while the code was a commit behind. This is that fact, from the process itself: promote
// asks the server what it booted, and restarts because the answer is not the target commit.
const BOOT_COMMIT = (() => {
  try {
    const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: path.resolve(HERE, "../.."), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch { return null; } // a published install has no .git — nothing to name
})();
const WEB_DIST = process.env.AGENTUS_WEB_DIST ?? path.resolve(HERE, "../../web/dist");
// The Android companion artifact (/notify links to it, /agentus-companion.apk streams it).
// First candidate is relative to THIS FILE (src → packages/server → packages → repo root,
// i.e. a checkout that built the APK); a published install has no android/ tree, so the
// data dir is the place to drop a downloaded artifact. Missing file is not fatal — the
// routes answer 404 and the panel says 尚未构建.
const APK_FILE = process.env.AGENTUS_APK
  ?? [
    path.resolve(HERE, "../../../android/artifacts/agentus-companion.apk"),
    path.join(DATA_DIR, "agentus-companion.apk"),
  ].find((p) => fs.existsSync(p))
  ?? path.resolve(HERE, "../../../android/artifacts/agentus-companion.apk");
// The root CA this instance's HTTPS is signed by, served to logged-in operators so a phone can
// trust the tunnel's self-signed cert once instead of tapping through a warning forever. Same
// reasoning as the APK: an artifact you install on a device belongs behind the operator login, and
// a page that invites you to install a TRUST ANCHOR especially so. Public half only — `ca.key` is
// never read here, and the file this points at holds the certificate alone.
// Candidates: an explicit pin (a Caddy/safe-nat root lives outside any checkout), then the data
// dir for a self-contained install, then the Caddy default. Absent is not fatal: the card says so.
const CA_FILE = process.env.AGENTUS_CA_FILE
  ?? [
    path.join(DATA_DIR, "tls", "ca.pem"),
    path.join(homedir(), ".config", "caddy", "tls", "ca.pem"),
  ].find((p) => fs.existsSync(p))
  ?? path.join(DATA_DIR, "tls", "ca.pem");
// `agentus --where` (bin/agentus.mjs) asks the ONE place that decides these paths to say
// what it decided, then exits — before any listener, store or subprocess exists. Print and
// exit here rather than re-deriving the same rules in the CLI: "where is my data" must not
// have two answers.
if (process.env.AGENTUS_PRINT_PATHS) {
  const has = (p: string) => (fs.existsSync(p) ? "present" : "MISSING");
  console.log(`[agentus] node          ${process.versions.node}`);
  console.log(`[agentus] data dir      ${DATA_DIR}  (${DATA_DIR_SOURCE})`);
  console.log(`[agentus] web bundle    ${WEB_DIST}  (${has(path.join(WEB_DIST, "index.html"))})`);
  console.log(`[agentus] companion apk ${APK_FILE}  (${has(APK_FILE)})`);
  console.log(`[agentus] http port     ${PORT}`);
  console.log(`[agentus] instance name ${TITLE}`);
  process.exit(0);
}

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }); // 0700: credentials live here

// ---- one data directory, ONE server (incident 2026-10-22, incident-20261022-orphan-reclaim.md §7) ----
// Claimed BEFORE the store is opened and long before anything reclaims or listens. The reclaim below
// kills the agent processes this database remembers, so a second instance on the same data dir is not
// a "port conflict" — it is the destruction of a running cockpit. Refuse, and touch nothing.
// A dead owner (crash, SIGKILL, reboot) is replaced, so a stale claim never bricks an install.
const instanceLock = acquireInstanceLock(DATA_DIR, { port: PORT });
if (!instanceLock.ok) {
  const h = instanceLock.holder;
  console.error(`[agentus] refusing to start: this data directory already has an owner`);
  console.error(`[agentus]   data dir: ${DATA_DIR}  (${DATA_DIR_SOURCE})`);
  if (h) {
    console.error(`[agentus]   owner:    pid ${h.pid}${h.port ? ` on port ${h.port}` : ""}, up ${humanAge(Date.now() - h.startedAt)}`);
  }
  console.error(`[agentus]   reason:   ${instanceLock.why}`);
  console.error(`[agentus]   two servers on one data dir reclaim each other's agents — stop that instance first,`);
  console.error(`[agentus]   or give this one its own directory:  AGENTUS_DATA=/some/other/dir`);
  process.exit(1);
}
if (instanceLock.tookOver) {
  const prev = instanceLock.tookOver;
  console.log(
    `[agentus] instance lock: took over ${DATA_DIR} from pid ${prev.pid}`
    + ` (gone or recycled; up ${humanAge(Date.now() - (prev.startedAt || Date.now()))})`,
  );
}

const store = new Store(path.join(DATA_DIR, "agentus.sqlite"));
// M6: an existing cockpit must behave exactly as before, so the registry starts as a copy of
// the builtin (env-driven) rows and the operator edits from there. Seeding is one-shot: an
// empty registry means "first boot", a non-empty one means the operator owns those rows.
{
  const seeded = store.seedBackendsIfEmpty(seedRows());
  if (seeded) console.log(`[agentus] backend registry seeded with ${seeded} row(s)`);
}
// Boot sweep (M6.1): one cheap, side-effect-free pass (does the command resolve?) behind the
// first tick, so the list never opens with every row "unchecked". It deliberately does NOT
// spawn anything: a real check belongs to 探测 (kind=manual) and, for proof, to a session
// (kind=session). One bad row must not take the cockpit down, hence the per-row catch.
setTimeout(() => {
  for (const row of store.listBackends()) {
    try {
      store.recordBackendCheck(row.id, startupCheck(row));
    } catch (e) {
      console.warn(`[agentus] startup check failed for ${row.id}: ${e instanceof Error ? e.message : e}`);
    }
  }
}, 1200);

// Auth key material next to the store: a restart must NOT log the operator out,
// and the machine token has to stay stable for scripts/CI.
const authStatus = auth.initAuth(DATA_DIR);

function clientIp(req: IncomingMessage): string {
  const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return fwd || req.socket.remoteAddress || "unknown";
}

/** Addresses the plan MCP tool will answer to. It has its own per-session token (see the route),
 *  so this is the second lock, not the only one: a token that leaked out of `ps` still has to be
 *  used from this machine. */
const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

// ---- event fan-out to all WS clients + per-client replay tracking ----
const clients = new Map<string, { ws: WebSocket; lastSeen: Map<string, number> }>();

/** `~/x` and relative paths from the UI land on absolute ones, same as the picker. */
function expandUserPath(input: string): string {
  const raw = input.trim();
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return path.join(homedir(), raw.slice(2));
  return path.resolve(raw);
}

/** The directory a slot's panels (files, terminal) start from: the workspace the
 *  operator picked, falling back to the cwd the slot was spawned in. */
function sessionRoot(sessionId: string): { path: string; workspace: string | null } | null {
  const live = mgr.list().find((s) => s.id === sessionId);
  const row = live ?? store.getSession(sessionId);
  if (!row) return null;
  return { path: row.workspace || row.cwd, workspace: row.workspace ?? null };
}

function emit(evt: ServerEvent): void {
  // Older builds below get the plain fan-out. The hub reads the SAME frames the page reads, and may
  // emit a `speak` of its own — which lands back here one level deep and is then broadcast normally.
  if (evt.t !== "speak") hub?.onEvent(evt);
  const wire = JSON.stringify(evt);
  for (const { ws } of clients.values()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(wire);
  }
  // The same event stream that feeds the browser feeds the notify channel: turn-start/end,
  // permission requests and errors become activities. One source of truth, no second
  // observation path that could drift from what the operator sees.
  notify.observe(evt);
}

// The data dir and this run's instance id travel into the manager: they are what lets a reclaim tell
// "an agent of THIS directory from a previous run" from "some pid the database still remembers".
const mgr = new SessionManager(store, emit, {
  dataDir: DATA_DIR,
  instanceId: instanceLock.holder.instanceId,
});

/** 工作播报 (issue #16). Constructed AFTER the manager so it can spawn observers through it, and
 *  wired into `emit` above through this mutable handle — the hub itself is not in the broadcast
 *  path, it only OBSERVES the same event stream the browser sees (one source of truth). */
let hub: ObserverHub | null = null;

/** The session list every client stays current with: the rows PLUS what is already waiting for
 *  an answer. Pending approvals are STATE, not just an event — a page that connects or refreshes
 *  after the request was raised still has to be able to show it.
 *
 *  Three buckets, because the rail has three answers to 「这个会话在哪」 and one field cannot carry
 *  them: `sessions` = live (a process is attached), `cold` = on disk with no process and NOT
 *  archived (they belong in 工作空间 too — a crashed slot must not look archived), `archived` = the
 *  operator put it away. Each row also carries `cold`/`archivedAt`, so a client never has to infer
 *  state from which list a row arrived in (that inference is exactly what merged 已归档 with 死了). */
const sessionsEvent = (): ServerEvent => ({
  t: "sessions",
  sessions: mgr.list(),
  cold: mgr.cold(),
  archived: mgr.archived(),
  pending: mgr.pendingPermissions(),
  // Background snapshots (issue #22) ride this frame for the same reason pending approvals do: they are
  // STATE, and a page that connects or refreshes after the agent last spoke still has to be current.
  background: mgr.backgroundSnapshots(),
});

// 工作播报 (issue #16): one long-lived observer per watched session, in its own scratch home under
// `~/.hermes/agentus/observers/<sid>` — never the observed session's cwd (an observer that can write
// into the project is an observer that changes what it is watching, and the rail groups by cwd: the
// ghost row next to the real one is issue #13 all over again).
hub = new ObserverHub({
  home: path.join(homedir(), ".hermes", "agentus"),
  settings: observerSettings,
  // 工作播报 is the operator's third speaker position; in the other two the cockpit says nothing, so
  // no observer is spawned and no tokens are spent.
  //
  // Per SESSION since #68: the horn belongs to the conversation it was switched on in, and the
  // global `prefs.speakMode` is only the DEFAULT for sessions that were never given their own value.
  // Resolved in one place (`resolveSpeak`) so the horn, the hub and the diagnostic endpoint can
  // never disagree about what a session is set to.
  speakOf: (id) => resolveSpeak(id, {
    mode: getSettings().prefs.speakMode,
    intervalSec: getSettings().observer.intervalSec,
  }),
  createSession: async (backend, cwd, title) => (await mgr.create(backend, cwd, title, { system: true })).id,
  prompt: (id, text) => mgr.prompt(id, text, []),
  waitReady: (id, ms) => mgr.awaitReady(id, ms).then(() => undefined),
  titleOf: (id) => store.getSession(id)?.title ?? null,
  backendOf: (id) => store.getSession(id)?.backend ?? null,
  planTitleOf: (id) => store.getPlan(id)?.title?.trim() || null,
  // Read-only is a SECOND line of defence behind the scratch directory: a runtime that offers a
  // read-only (or plan) mode should not be able to accept a write from an observer at all. Modes
  // arrive with the handshake, so this is a bounded poll; if the backend offers nothing matching,
  // the observer simply runs in its default mode — inside a directory that holds nothing.
  preferReadonly: (id) => {
    const started = Date.now();
    const pick = (): void => {
      const modes = mgr.modesOf(id);
      const options = modes?.availableModes ?? [];
      if (!options.length && Date.now() - started < 20_000) {
        setTimeout(pick, 500).unref?.();
        return;
      }
      const wanted = options.find((m) => /read[-_ ]?only|readonly|plan/i.test(m.id) || /只读|规划/.test(m.name));
      if (wanted) {
        void mgr.setMode(id, wanted.id).catch((e: unknown) =>
          console.warn(`[agentus] observer ${id}: could not switch to the read-only mode "${wanted.id}": ${String((e as Error)?.message ?? e)}`),
        );
        return;
      }
      // Say it out loud when the fallback does not exist (#76 E). A silent promise is worse than no
      // promise: the observer then runs in whatever mode the runtime defaults to — on an ACP backend
      // that is `accept_edits` with the full tool set — and 「只读兜底」 reads as done in the code
      // while being a no-op in production.
      console.warn(
        `[agentus] observer ${id}: this runtime offers no read-only/plan mode ` +
        `(${options.map((m) => m.id).join(", ") || "none advertised"}); the observer keeps its default mode. ` +
        "Its only containment is the scratch directory it runs in.",
      );
    };
    pick();
  },
  // 工作播报 的作用域与生命周期 (issues #23/#24, 2026-10-18).
  // `watching` is the SAME presence the notification rules use: 「他在看哪个会话」 has one answer in
  // this process, and a second, quieter definition of it is how a feature starts talking about the
  // wrong session. `notify` is a `const` declared below — this closure only ever runs from an event
  // handler, never during construction.
  watching: (id) => notify.operatorWatching(id),
  // 播报的「他在看这个会话」是另一件事 (issue #69 §5): broadcasting exists so he can look AWAY, so it
  // asks only whether this is the session he is on, not whether he touched the keyboard recently.
  onSession: (id) => notify.operatorOnSession(id),
  // The reaped-observer fix: a `system` session the idle reaper took no longer accepts prompts, and
  // trusting its id forever is what made the brief say 「播报失败：no such session」 until a restart.
  // `hasSession` (not `list()`) on purpose: `list()` is the RAIL's view and excludes system sessions,
  // so asking it about an observer answers 「no」 every single time — which would re-spawn a fresh
  // observer on every turn and throw away the context continuity the whole design is for.
  alive: (id) => mgr.hasSession(id),
  // 切走即关 / 关掉收听即关: closing the PROCESS is the point — an idle observer is a whole ACP
  // runtime, and the reaper's five minutes are five minutes of paying for nothing.
  disposeSession: (id) => mgr.closeSession(id),
  emit,
});

// ---- notify channel (docs/android-notify-contract.md) ----------------------------
// Owns pairing, the device websocket, the activity lifecycle and the button callbacks.
// It holds no agent logic: what an event MEANS is decided in notify/center.ts §ACP mapping,
// and everything it sends goes through one wire format.
const notify = new NotifyCenter({
  dataDir: DATA_DIR,
  log: (line: string) => console.log(line),
  sessionTitle: (id: string) => mgr.list().find((s) => s.id === id)?.title ?? store.getSession(id)?.title ?? null,
  // The completion card's task line (#11). Read straight from the plan OBJECT — the same row the
  // card renders — so the notification and the screen can never disagree about what finished.
  sessionPlan: (id: string) => store.getPlan(id),
  // Operator credential = whatever already unlocks the cockpit (session cookie or machine token).
  operator: (req, url) => Boolean(auth.authenticate(req.headers, url)),
  // The companion artifact, so the phone panel in 设置 can show its size without a second request.
  apkPath: APK_FILE,
  // The page reporting which session it is showing is also the idle reaper's clock: opening a slot
  // (and staying in it) counts as USED, so switching away gives it a full threshold instead of
  // reaping it on the next tick because its last MESSAGE was days ago.
  // ...and it is also the 工作播报 scope switch (issue #23): the observer follows the session on
  // screen, and the previous one is CLOSED rather than left warming. Two consumers, one fact.
  onFocus: (sessionId: string) => {
    mgr.touch(sessionId);
    hub?.focusChanged(sessionId);
  },
  // Username+password pairing: the phone types the same login the browser uses. The check and
  // its rate limit stay here, in auth.ts, so a phone cannot have a laxer door than the UI.
  credentials: (username, password, ip) => {
    const gate = auth.loginAllowed(ip);
    if (!gate.allowed) {
      return { ok: false, reason: `too many attempts, retry in ${Math.ceil(gate.retryAfterMs / 1000)}s` };
    }
    if (!auth.verifyCredentials(username, password)) {
      auth.recordLoginFailure(ip);
      return { ok: false, reason: "wrong username or password" };
    }
    auth.recordLoginSuccess(ip);
    return { ok: true };
  },
});

// The beat starts here, and not at construction: `tick()` reads `notify`'s presence, and a timer
// started before that `const` exists would be the one thing in this file able to throw a TDZ error
// at runtime. 15s is finer than the smallest beat the menu offers (1 minute).
hub?.start();

// One row per interaction. A notification button carries an opaque actionId plus the ref the
// publisher attached; the cockpit is the only place that knows what it means. Adding a new
// interaction is therefore a case here (or a new ref.type), never an app rebuild.
notify.onAction(({ ref, action, activity, device }) => {
  console.log(`[notify] action device=${device.name} activity=${activity.activityId} action=${action.actionId} type=${ref?.type ?? "none"}`);
  if (!ref) return; // the button existed but nobody claimed it: log and drop, never guess
  switch (ref.type) {
    case "permission": {
      // The lock screen answering an agent's permission prompt — the whole point of the channel.
      const applied = mgr.respondPermission(String(ref.sessionId), String(ref.requestId), {
        outcome: "selected",
        optionId: String(ref.optionId),
      }, {
        optionKind: typeof ref.optionKind === "string" ? ref.optionKind : undefined,
        signature: typeof ref.signature === "string" ? ref.signature : undefined,
      });
      // The request is gone (our timeout, the agent gave up, its process died). Take the card off
      // the phone instead of leaving a 「待你确认」 that no longer has a request behind it — the
      // browser gets `permission-expired` for the same click, and a phone that keeps a dead button
      // is the same defect one device over.
      if (!applied) {
        console.log(`[notify] permission answer dropped for ${ref.requestId}: card dismissed`);
        notify.dismiss(`perm:${ref.requestId}`);
      }
      return;
    }
    case "open":
      return; // the app already opened the deeplink; nothing to do server-side
    default:
      console.log(`[notify] no handler for ref.type=${ref.type}`);
  }
});

// The page channel of the same decision: one `notify` frame to every cockpit websocket.
//
// No cursor, no replay, and no per-client state — deliberately unlike the device socket above. The
// phone replays because it was PAIRED and may have been asleep in a pocket; a browser tab that missed
// frames has a transcript to catch up in, and a wall of stale cards after a reload is worse than none.
// Every gate that matters (which kinds, whether the channel is on) was applied in the notify centre.
notify.onNotice((notice) => {
  const wire = JSON.stringify({ t: "notify", notice });
  for (const { ws } of clients.values()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(wire);
  }
});

// Operator settings (voice, theme, call knobs, talk-to-agent prefs) live in the store's
// `settings` table: the UI owns them and env only bootstraps them (settings.ts). Read
// before anything asks.
initSettings(DATA_DIR, store);
// 会话级喇叭档位 (issue #68) rides the same settings table under its own key.
initSessionSpeak(store);
// Dynamic hotwords are mined from the transcript — the store's business, not voice.ts's,
// so the lookup is injected rather than imported.
setHotwordSource((sessionId) => hotwordsFor(store, sessionId).map((h) => h.word));

// ---- idle reclaim (AionUi parity: 设置 → 系统 → 「Agent 空闲超时（分钟）」) ---------------------
// The operator's standing answer to 「一个 ready 了好几个小时的槽位还挂着 agent 进程」. It STOPS the
// process and nothing else: the row stays in 工作空间 wearing `reaped`, one click brings it back, and
// its transcript is untouched — reaping is not archiving (that is the operator's own decision now).
//
// The threshold is read on every tick, so changing it in 设置 applies immediately (no restart — a
// restart would kill exactly the slots this feature exists to keep alive cheaply). Two env knobs for
// QA: AGENTUS_IDLE_KILL_MIN accepts a FRACTION of a minute, which is how the reclaim path is
// exercised in seconds instead of in five minutes (AionUi made its own timeouts env-configurable for
// the same reason), and AGENTUS_IDLE_SWEEP_MS moves the tick.
{
  // ABSENT must mean "follow 设置", not 0 — `Number("")` is 0, which would silently disable the
  // reaper on every instance that never sets the env (measured: the startup line said 「0 min」 on an
  // instance whose setting was 5). Only a real, non-empty value is an override.
  const envNum = (raw: string | undefined): number | null => {
    const s = String(raw ?? "").trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const envIdle = envNum(process.env.AGENTUS_IDLE_KILL_MIN);
  const envIdleMs = envIdle != null ? envIdle * 60_000 : null;
  // 热备 (warm slots): same ABSENT≠0 discipline as above. The TTL takes a FRACTION of a minute so the
  // warm-EXPIRY path can be exercised in seconds rather than by waiting out a day.
  const envWarm = envNum(process.env.AGENTUS_WARM_SLOTS);
  const envWarmTtlMin = envNum(process.env.AGENTUS_WARM_TTL_MIN);
  const envWarmTtlMs = envWarmTtlMin != null ? envWarmTtlMin * 60_000 : null;
  const envSweep = envNum(process.env.AGENTUS_IDLE_SWEEP_MS);
  const sweepMs = envSweep != null && envSweep >= 1000 ? envSweep : 30_000;
  const source = envIdleMs != null ? "AGENTUS_IDLE_KILL_MIN" : "settings.agent.idleKillMin";
  console.log(
    `[agentus] idle reclaim: ${
      envIdleMs != null ? envIdle : agentSettings().idleKillMin
    } min (${source}), sweep ${Math.round(sweepMs / 1000)}s, 0 = off`,
  );
  // The warm set is the other half of the same decision (which slots survive being quiet) and it is
  // NEVER inferred from the idle value: 「最近 N 个即使空闲也保留」 and 「其余空闲多久收」 are two
  // answers. Printing both with their sources is what turns 「为什么它被收了」 into one glance.
  console.log(
    `[agentus] warm slots: ${envWarm ?? agentSettings().warmSlots} kept up to ${
      envWarmTtlMs != null ? envWarmTtlMs / 3_600_000 : agentSettings().warmTtlHours
    } h untouched (${envWarm != null || envWarmTtlMs != null ? "AGENTUS_WARM_*" : "settings.agent"}), 0 = off / never`,
  );
  // The plan-tool hint: read per prompt, so the 设置 switch applies to the next turn with nothing
  // to restart (the session's own plan card is what it fills).
  mgr.setPlanHintSource(planHintSettings);
  // Issue #22: a finished background process may open a turn by itself. Default on (the CLI/gateway
  // behaviour); the switch exists because a synthetic turn spends tokens the operator may not want
  // spent at 3am — and it is read live, so flipping it applies to the next completion.
  mgr.setCompletionWakeSource(() => agentSettings().completionWake);
  // 语音通话（issue #48）: 「在打电话」 has exactly one authority in this process (the notify centre's
  // presence, which the page already reports every 30 s), so the voice-mode block and the thinking
  // dial derive from it instead of adding a second client→server state channel. The presence
  // listener turns each report into the transitions the manager records.
  mgr.setCallLiveSource(() => notify.callLiveSession());
  notify.onPresenceChange(() => { void mgr.syncCallState(); });
  mgr.startIdleReaper({
    idleMs: () => envIdleMs ?? agentSettings().idleKillMin * 60_000,
    warmSlots: () => envWarm ?? agentSettings().warmSlots,
    warmTtlMs: () => envWarmTtlMs ?? agentSettings().warmTtlHours * 3_600_000,
    watched: (id) => notify.operatorWatching(id),
    intervalMs: sweepMs,
  });
}

/**
 * Single prompt entry point (REST + WS both use it).
 * A failed turn must never be silent: the UI used to show a bare
 * "-32603 Internal error" with nothing in the server log, and it also never
 * emitted turn-end, so the bubble stayed "running" forever (QA#11).
 */
function runPrompt(
  sessionId: string,
  text: string,
  attachments: PromptAttachment[] = [],
  interrupt = false,
  pid?: string,
): void {
  void mgr.prompt(sessionId, text, attachments, { interrupt, pid }).catch((e: unknown) => {
    const msg = describeAcpError(e);
    const tail = mgr.stderrTail(sessionId);
    console.error(`[agentus] prompt failed for ${sessionId}: ${msg}${tail ? `\n  agent stderr tail:\n  ${tail}` : ""}`);
    // `rejectedPrompt` is the operator's own sentence, handed back with the refusal so the client can
    // put it back in line instead of losing it with the red bubble (see state.ts, case "message").
    // Only for the refusals that mean 「你的话我还没收到，不是它失败了」: a busy agent, and an agent that
    // cannot take the picture the operator just attached (issue #17) — there the sentence is still
    // worth keeping, it is the image that has to go.
    const lost = msg === "turn already running" || msg === IMAGE_UNSUPPORTED;
    emit({ t: "message", message: {
      seq: -1, sessionId, kind: "meta",
      // `pid` rides along (issue #26) so the page can pair this refusal with the prompt it is still
      // waiting to acknowledge: without it the refusal and the ack timeout both put the same sentence
      // back in line, and the operator sees his message twice.
      payload: { text: `turn failed: ${msg}`, ...(lost ? { rejectedPrompt: text } : {}), ...(pid ? { pid } : {}) },
      createdAt: Date.now(),
    } });
    // `turn-end` is the frame that says A TURN IS OVER. For the two "nothing left the client" refusals
    // there was no turn to end: the busy case still has the operator's ORIGINAL turn running (its own
    // turn-end will come), and a refused image never started one. Emitting one anyway flipped the page
    // to idle mid-turn — the stop button vanished while the agent was still working (measured 2026-10-17
    // in `attachment-capability`, on the busy branch).
    if (!lost) emit({ t: "turn-end", sessionId, error: msg });
  });
}

// A single bad request must never take the cockpit down: one unhandled
// rejection used to exit the process and silently drop every live session
// (QA#19). Installed only AFTER we own the port — a startup failure
// (EADDRINUSE etc.) must still crash loudly instead of lingering as a
// zombie with no listener (QA#22).
function installSafetyNet(): void {
  process.on("unhandledRejection", (reason) => {
    console.error("[agentus] unhandled rejection (kept alive):", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[agentus] uncaught exception (kept alive):", err);
  });
}

// AC5: reclaim orphans from a previous run — only reachable once the instance lock above proved this
// process is the single owner of DATA_DIR, and only killing agents that receipt proves are ours
// (incident 2026-10-22: a second instance used to execute the live cockpit's slots here, every 10 s).
const killed = mgr.reclaimOrphans();
if (killed) console.log(`[agentus] reclaimed ${killed} orphan agent process(es)`);

// ---- REST ----
/** Raw body for uploads (audio for /api/stt). Capped: a dictation clip is small,
 *  and an uncapped reader is a memory DoS on a public tunnel. */
async function readBody(req: IncomingMessage, maxBytes = 25 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) throw new Error(`body too large (> ${Math.round(maxBytes / 1048576)}MB)`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Escape the one instance name that reaches HTML — an operator's `AGENTUS_TITLE` is not markup. */
function htmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Put the instance name in the tab title. A body without a `<title>` is left alone rather than
 *  guessed at: a release that changes index.html will fail the sweep, not silently ship a title. */
function withTitle(html: string): string {
  if (TITLE === "Agentus") return html; // never set → the built file is the answer, byte for byte
  return html.replace(/<title>[^<]*<\/title>/i, `<title>${htmlEscape(TITLE)}</title>`);
}

/** Put the instance name on the home screen. `name` is the install dialog and the launcher label in
 *  most launchers; `short_name` is what actually fits under the icon, and Android truncates it
 *  itself — inventing our own abbreviation produced names nobody chose. */
function withManifestName(text: string): string {
  if (TITLE === "Agentus") return text;
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    j.name = TITLE;
    j.short_name = TITLE;
    return JSON.stringify(j, null, 2);
  } catch {
    return text; // an unparseable manifest is not worth failing a page load over
  }
}

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  // SPA fallback for web build; only GET
  if (!fs.existsSync(WEB_DIST)) {
    res.writeHead(404);
    res.end("web build not found (run `npm run build -w @agentus/web`)");
    return;
  }
  const url = new URL(req.url ?? "/", "http://x");
  let file = path.join(WEB_DIST, url.pathname === "/" ? "index.html" : url.pathname);
  if (!file.startsWith(WEB_DIST)) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB_DIST, "index.html");
  const ext = path.extname(file);
  const types: Record<string, string> = {
    ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
    ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json",
    ".json": "application/json", ".ico": "image/x-icon",
  };
  // The two bodies this server EDITS on the way out are the two that carry the instance's name
  // (issue #19): the tab title lives in index.html, the home-screen label in the manifest. Every
  // other file is streamed untouched — the hashed assets are immutable and must stay byte-exact.
  if (ext === ".html" || ext === ".webmanifest") {
    let body: string;
    try {
      body = fs.readFileSync(file, "utf8");
    } catch {
      res.writeHead(500); res.end("web build unreadable"); return;
    }
    if (ext === ".html") body = withTitle(body);
    else body = withManifestName(body);
    res.writeHead(200, {
      "content-type": types[ext] ?? "text/plain",
      // Same rule as below: the HTML names the hashed bundle, so it must never be cached. The
      // manifest carries the instance name, which an operator changes by restarting with a new
      // AGENTUS_TITLE — a cached copy would keep the old label on the home screen for a year.
      "cache-control": "no-cache, must-revalidate",
      "content-length": String(Buffer.byteLength(body)),
    });
    res.end(body);
    return;
  }
  res.writeHead(200, {
    "content-type": types[ext] ?? "application/octet-stream",
    // The HTML must never be cached: it names the hashed bundle, so a cached index.html keeps serving
    // the OLD app after a rebuild — which is how a shipped fix fails to reach the phone (the WebView
    // keeps the page for days otherwise). The hashed assets themselves are immutable and cacheable.
    "cache-control": ext === ".html" ? "no-cache, must-revalidate" : "public, max-age=31536000, immutable",
  });
  fs.createReadStream(file).pipe(res);
}

// One request handler, plain HTTP on PORT (LAN, loopback, curl/scripts).
// TLS is NOT terminated in-process: put a TLS-terminating reverse proxy (or a tunnel that
// does its own `public_tls`) in FRONT of this port. That keeps the LAN path warning-free
// and `curl`/scripts byte-identical, and keeps cert lifecycle out of the app.
const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    // The notify channel authenticates by itself — a rotating pairing code for /pair, the
    // device token for everything else — so it runs AHEAD of the operator gate. That is the
    // whole point: a phone tapping "allow" on the lock screen has no browser session.
    if (url.pathname.startsWith("/api/notify") && (await notify.handleHttp(req, res, url))) return undefined;

    // The plan MCP tool's door (design-plan-service.md §6-B). AHEAD of the operator gate, like
    // /api/notify, because its caller is a child process of an AGENT: it has no browser session, and
    // the outer HTTP Basic lock is not something we could hand it without putting operator
    // credentials into every agent's environment. It carries its own credential instead — a token
    // minted per agent process and delivered through the ACP handshake (§4) — plus a loopback-only
    // rule, so the token never crosses a network. The blast radius of a leaked token is one session's
    // plan, which is the object the operator is already looking at.
    // The cockpit CLI's data plane (issue #15). AHEAD of the operator gate for the same reason the
    // plan tool is: its caller is an AGENT CHILD process with no browser session, and handing it
    // operator credentials would put them in every agent's environment. It carries a token minted per
    // agent process (env, never argv) plus the same loopback rule, so the token cannot cross a network.
    if (url.pathname.startsWith("/api/cockpit/")) {
      const ip = clientIp(req);
      if (!LOOPBACK_IPS.has(ip)) return send(res, 403, { error: "the cockpit channel is loopback-only" });
      const caller = mgr.cockpitCaller(String(req.headers["x-agentus-cockpit-token"] ?? ""));
      // Operator mode: the machine token in <DATA>/auth.token is already the credential that lets
      // scripts act as the operator, so a human at a shell can use the same CLI. `caller` stays the
      // empty string — there is no agent to attribute to, so `self` is null and a rename this way
      // records no author (NULL title_by = the operator), which is exactly right.
      const isOperator = !caller && auth.verifyMachineToken(/^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""))?.[1] ?? undefined);
      if (!caller && !isOperator) return send(res, 403, { error: COCKPIT_ERRORS.badToken });
      // Scope: what the operator can see. 已归档 is out, on purpose — see `cockpitRows`.
      // The cold page is taken once so its `omitted` count can travel with the answer (#34).
      const cold = mgr.cockpitCold();
      const rows = [...mgr.list(), ...cold.rows];
      const rowOf = (id: string): SessionInfo | null => rows.find((s) => s.id === id) ?? null;
      const summarize = (s: SessionInfo) => sessionRow(s, {
        plan: store.getPlan(s.id),
        permissions: mgr.pendingFor(s.id).length,
      });
      const sendOk = sendAllowed(agentSettings().cockpitSend);

      if (url.pathname === "/api/cockpit/capabilities" && req.method === "GET") {
        return send(res, 200, capabilities(sendOk));
      }
      if (url.pathname === "/api/cockpit/context" && req.method === "GET") {
        const sp = url.searchParams;
        const self = caller ? rowOf(caller) : null; // operator mode: no session, so no `self`
        // `--all` is the ONE way archived rows enter this channel, and it is opt-in per call: the
        // product rule (an archive is a statement that the work is closed) still holds by default.
        const pool = sp.get("all") === "1" || sp.get("all") === "true"
          ? [...rows, ...mgr.archived()]
          : rows;
        // `--here`: the CALLER's own workspace, resolved here because only the server knows the
        // canonical path the rail groups by.
        const here = sp.get("here") === "1" || sp.get("here") === "true";
        const by = sp.get("by") ?? undefined;
        if (by && by !== "workspace") {
          return send(res, 400, { error: COCKPIT_ERRORS.badRequest, message: `--by wants workspace, got "${by}"` });
        }
        const query: ListQuery = {
          workspace: here ? (self ? self.workspace || self.cwd : undefined) : sp.get("workspace") ?? undefined,
          status: sp.get("status") ?? undefined,
          waiting: sp.get("waiting") === "1" || sp.get("waiting") === "true",
          since: sp.get("since") ?? undefined,
          createdSince: sp.get("created_since") ?? undefined,
          grep: sp.get("grep") ?? undefined,
          sort: (sp.get("sort") as ListQuery["sort"] | null) ?? undefined,
          limit: sp.get("limit") ? Number(sp.get("limit")) : undefined,
          all: sp.get("all") === "1" || sp.get("all") === "true",
          includeSelf: sp.get("include_self") === "1" || sp.get("include_self") === "true",
          by: by as ListQuery["by"],
          coldOmitted: cold.omitted,
        };
        if (query.sort && !["last", "created", "name"].includes(query.sort)) {
          return send(res, 400, { error: COCKPIT_ERRORS.badRequest, message: `--sort wants last|created|name, got "${query.sort}"` });
        }
        // A window that cannot be parsed is REFUSED. Silently ignoring it would answer a different
        // question than the one asked, and the caller would believe the empty list.
        for (const [field, raw] of [["since", query.since], ["created_since", query.createdSince]] as const) {
          if (!raw) continue;
          const parsed = parseSince(raw);
          if (!parsed.ok) return send(res, 400, { error: COCKPIT_ERRORS.badRequest, message: parsed.why });
        }
        // Mark the caller's own row: it stays visible (you are part of the cockpit) but it is never a
        // send target, and saying so in the data is cheaper than making every reader remember.
        const marked = pool.map((s) => ({ ...summarize(s), ...(s.id === caller ? { self: true } : {}) }));
        const listed = listSessions(marked, query);
        return send(res, 200, {
          schema_version: COCKPIT_SCHEMA_VERSION,
          self: self ? summarize(self) : null,
          sessions: listed.rows,
          ...(listed.groups ? { groups: listed.groups } : {}),
          meta: {
            ...listed.meta,
            scope: query.all ? "live+cold+archived (--all)" : "live+cold, archived excluded",
          },
        });
      }
      if (url.pathname === "/api/cockpit/rename" && req.method === "POST") {
        const body = await readJson(req);
        const id = String(body.id ?? "");
        if (!id) return send(res, 400, { error: COCKPIT_ERRORS.badRequest });
        if (!rowOf(id)) return send(res, 404, { error: COCKPIT_ERRORS.outOfScope });
        // Recorded as THIS session's doing (titleBy), so the operator can tell an agent-named
        // conversation from one they named. `auto` clears back to the generated title.
        const title = body.auto === true ? null : String(body.title ?? "").trim();
        if (body.auto !== true && !title) return send(res, 400, { error: COCKPIT_ERRORS.badRequest });
        try {
          const info = mgr.rename(id, title, caller);
          return send(res, 200, {
            schema_version: COCKPIT_SCHEMA_VERSION,
            renamed: true,
            id,
            name: info.title,
            titleBy: info.titleBy ?? null,
          });
        } catch (e) {
          return send(res, 404, { error: COCKPIT_ERRORS.outOfScope, message: String((e as Error)?.message ?? e) });
        }
      }
      if (url.pathname === "/api/cockpit/session" && req.method === "GET") {
        const id = url.searchParams.get("id") ?? "";
        const info = rowOf(id);
        if (!info) return send(res, 404, { error: COCKPIT_ERRORS.noSuchSession });
        const waiting = mgr.pendingFor(id).map((p) => ({
          requestId: p.requestId, title: p.toolCallTitle ?? p.kind ?? "请求",
          options: (p.options ?? []).map((o) => ({ id: o.optionId, name: o.name, kind: o.kind })),
        }));
        return send(res, 200, {
          schema_version: COCKPIT_SCHEMA_VERSION,
          session: summarize(info),
          plan: store.getPlan(id),
          pending: waiting,
          messages: tailMessages(mgr.messages(id, -1, 500), 0).meta,
        });
      }
      if (url.pathname === "/api/cockpit/messages" && req.method === "GET") {
        const id = url.searchParams.get("id") ?? "";
        if (!rowOf(id)) return send(res, 404, { error: COCKPIT_ERRORS.noSuchSession });
        const tail = Number(url.searchParams.get("tail") ?? MESSAGES_TAIL_DEFAULT);
        // `role`/`user` (issue #76): the reader asks for a KIND, not the last N rows of anything.
        const rawRole = url.searchParams.get("role") ?? (url.searchParams.get("user") === "1" ? "user" : "");
        if (rawRole && !isMessageRole(rawRole)) {
          return send(res, 400, { error: COCKPIT_ERRORS.badRequest, message: `unknown role "${rawRole}" (one of ${MESSAGE_ROLES.join(", ")})` });
        }
        const out = tailMessages(mgr.messages(id, -1, 2000), tail, rawRole && isMessageRole(rawRole) ? rawRole : undefined);
        return send(res, 200, { schema_version: COCKPIT_SCHEMA_VERSION, messages: out.rows, meta: out.meta });
      }
      if (url.pathname === "/api/cockpit/plan" && req.method === "GET") {
        const id = url.searchParams.get("id") ?? "";
        if (!rowOf(id)) return send(res, 404, { error: COCKPIT_ERRORS.noSuchSession });
        return send(res, 200, { schema_version: COCKPIT_SCHEMA_VERSION, plan: store.getPlan(id) });
      }
      if (url.pathname === "/api/cockpit/send" && req.method === "POST") {
        const body = await readJson(req);
        const to = String(body.to ?? "");
        const message = String(body.message ?? "").trim();
        if (!to || !message) return send(res, 400, { error: COCKPIT_ERRORS.badRequest });
        if (!sendOk) return send(res, 403, { error: COCKPIT_ERRORS.sendsDisabled });
        const target = rowOf(to);
        if (!target) return send(res, 404, { error: COCKPIT_ERRORS.outOfScope });
        // #41: a cold target used to end the conversation here. Waking is now EXPLICIT (`--wake`),
        // because it costs a process — but refusing every cold send made cross-session work
        // unusable, since the idle reaper keeps targets cold by design.
        const wantWake = body.wake === true;
        let woke = false;
        if (target.cold) {
          if (!wantWake) {
            return send(res, 409, {
              error: COCKPIT_ERRORS.targetCold,
              message: "the target has no running process; pass --wake (wake:true) to start it, then the message is delivered in the same call",
              wakeable: !target.archivedAt,
            });
          }
          try {
            await mgr.resume(to);
            woke = true;
          } catch (e) {
            return send(res, 409, { error: COCKPIT_ERRORS.wakeFailed, message: String((e as Error)?.message ?? e) });
          }
        }
        // NOT interrupt by DEFAULT: a cross-session message must never take the floor from a turn the
        // OPERATOR started — a busy target answers `target_busy` and the caller reports it as such.
        // #55: the caller may ASK for the floor (`--interrupt`), which reuses prompt()'s existing
        // cancel → wait-until-really-stopped → new-turn path. The抢话头 is therefore always explicit
        // and always visible in the command that did it; nothing on this channel interrupts silently.
        const wantInterrupt = body.interrupt === true;
        // #59：`replyOnDone` = 「它跑完回我一声」。这是一条**异步派活**：调用方不该被目标回合绑架
        // （普通 send 今天会一直等到回合结束才返回，几十秒到几十分钟），所以带这个标志时我们
        // 只等「消息进了目标的回合队列」，然后把回合结束那一刻的通知登记下来，立即回执。
        // 之后目标回合自然结束 → 服务端往调用方会话里投一条【完成回推】并把它唤醒（#39 的链子）。
        const wantReply = body.replyOnDone === true;
        if (wantReply && !caller) {
          return send(res, 400, {
            error: COCKPIT_ERRORS.badRequest,
            message: "reply-on-done 只能由另一个会话发起（要有一个可以回推的 origin）；操作者模式下没人接这条通知",
          });
        }
        // 忙的目标照旧拒收：带 --reply-on-done 不等于可以插队，抢话头仍然只有 --interrupt 一条路。
        if (wantReply && mgr.isBusy(to) && !wantInterrupt) {
          return send(res, 409, { error: COCKPIT_ERRORS.targetBusy });
        }
        if (wantReply && caller === to) {
          return send(res, 400, {
            error: COCKPIT_ERRORS.badRequest,
            message: "reply-on-done 不能发给自己：那是一次普通发言，回一条「你跑完了」只会变成乒乓",
          });
        }
        // 登记必须绑在**这一轮**上，而不是绑在会话上：先登记再 prompt，被 --interrupt 干掉的那一轮
        // 结束时会把后来的登记一起吞掉，调用方就永远收不到回执（review 实测的形状）。所以登记在
        // 「prompt 真的拿到话筒」那一刻发生，并带上它自己那一轮的编号。
        let turnStartedSeq: number | null = null;
        let onTurnStarted: ((seq: number) => void) | null = null;
        const turnStarted = new Promise<void>((resolve) => { onTurnStarted = (seq) => { turnStartedSeq = seq; resolve(); }; });
        let promptErr: unknown = null;
        try {
          // `origin` is not decoration: without it the target's page shows this as a message the
          // OPERATOR typed. With it the bubble says which session it came from.
          const turn = mgr.prompt(to, message, [], {
            interrupt: wantInterrupt,
            origin: caller ? { sessionId: caller, title: rows.find((s) => s.id === caller)?.title ?? null } : undefined,
            ...(wantReply ? { onTurnStarted: (seq: number) => onTurnStarted?.(seq) } : {}),
          });
          if (wantReply) {
            // 只等到「回合真的开始了」——那正是这个标志要消灭的那段长等待之外的全部代价。
            // 回合启动前的失败（没抢到话筒、目标进程死了、空 prompt）必须报失败，不能回 delivered。
            const started = await Promise.race([
              turnStarted.then(() => true),
              turn.then(() => false, (e) => { promptErr = e; return false; }),
            ]);
            if (!started) {
              const why = String((promptErr as Error)?.message ?? promptErr ?? "turn did not start");
              return send(res, 409, { error: why.includes("turn already running") ? COCKPIT_ERRORS.targetBusy : why });
            }
            const replyId = mgr.expectTurnReply(to, {
              origin: caller!,
              originTitle: rows.find((s) => s.id === caller)?.title ?? null,
              turnSeq: turnStartedSeq,
            });
            // 回合结束会由 #settleTurnReplies 投递。这里兜的是「回合开过之后 prompt 才抛错」——
            // 那条路径的 settle 可能早于本次登记（登记是微任务之后才落地的），所以不能靠它：
            // 明确投一条失败回推，否则调用方等一个永远不会来的回执。
            void turn.catch((e) => mgr.failTurnReply(to, replyId, String((e as Error)?.message ?? e)));
            return send(res, 200, {
              delivered: true, to, code: "delivered", reply_on_done: true,
              ...(woke ? { delivered_after_wake: true } : {}),
              ...(wantInterrupt ? { interrupted: true } : {}),
            });
          }
          await turn;
        } catch (e) {
          const why = String((e as Error)?.message ?? e);
          return send(res, 409, { error: why.includes("turn already running") ? COCKPIT_ERRORS.targetBusy : why });
        }
        return send(res, 200, {
          delivered: true, to, code: "delivered",
          ...(woke ? { delivered_after_wake: true } : {}),
          ...(wantInterrupt ? { interrupted: true } : {}),
        });
      }
      if (url.pathname === "/api/cockpit/create" && req.method === "POST") {
        const body = await readJson(req);
        if (!sendOk) return send(res, 403, { error: COCKPIT_ERRORS.sendsDisabled });
        const backendRaw = String(body.backend ?? "").trim();
        // Same resolution as the operator's own "+" (POST /api/sessions): a registry row wins, a
        // builtin id still resolves. An empty backend means "the one this cockpit would default to",
        // which is what a caller that does not care should get instead of an error.
        const beRow = backendRaw ? store.getBackend(backendRaw) : null;
        const backend = backendRaw
          ? (beRow || Object.prototype.hasOwnProperty.call(BACKENDS, backendRaw) ? (backendRaw as BackendId) : null)
          : (store.listBackends()[0]?.id as BackendId | undefined) ?? null;
        if (!backend) {
          return send(res, 400, {
            error: "unknown backend",
            message: `unknown backend: ${backendRaw}`,
            backends: store.listBackends().map((b) => b.id),
          });
        }
        let cwd = String(body.cwd ?? "").trim();
        if (!cwd || cwd === "~") cwd = homedir();
        else if (cwd.startsWith("~/")) cwd = path.join(homedir(), cwd.slice(2));
        if (!cwd) return send(res, 400, { error: "bad_request", message: "cwd is required: which directory should the new session work in?" });
        if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
          return send(res, 400, { error: "bad_cwd", message: `cwd not a directory: ${cwd}` });
        }
        try {
          const info = await mgr.create(backend, cwd, body.title ? String(body.title) : undefined);
          emit(sessionsEvent());
          // The same row shape `session show` answers with, so a caller can use the new id at once.
          return send(res, 201, { schema_version: COCKPIT_SCHEMA_VERSION, session: summarize(info) });
        } catch (e) {
          return send(res, 409, { error: "create_failed", message: String((e as Error)?.message ?? e) });
        }
      }
      if (url.pathname === "/api/cockpit/stop" && req.method === "POST") {
        const body = await readJson(req);
        const id = String(body.id ?? "");
        if (!id) return send(res, 400, { error: COCKPIT_ERRORS.badRequest });
        // Stopping is as costly as starting (it throws away a turn in flight), so it answers to the
        // same switch. `close` is the only command in this channel that ends a PROCESS; when the
        // target is already cold there is nothing to end and the answer says so rather than
        // pretending. Deliberately NOT DELETE /api/sessions/:id: for a cold row that route PURGES the
        // transcript, and no cross-session caller gets to delete the operator's history.
        if (!sendOk) return send(res, 403, { error: COCKPIT_ERRORS.sendsDisabled });
        const target = rowOf(id);
        if (!target) return send(res, 404, { error: COCKPIT_ERRORS.outOfScope });
        if (body.close === true) {
          if (target.cold) return send(res, 200, { schema_version: COCKPIT_SCHEMA_VERSION, id, closed: false, already_cold: true });
          await mgr.closeSession(id);
          emit(sessionsEvent());
          return send(res, 200, { schema_version: COCKPIT_SCHEMA_VERSION, id, closed: true });
        }
        const stopped = await mgr.cancel(id);
        return send(res, 200, {
          schema_version: COCKPIT_SCHEMA_VERSION,
          id,
          stopped,
          ...(stopped ? {} : { message: "no turn was running — nothing to interrupt" }),
        });
      }
      if (url.pathname === "/api/cockpit/wake" && req.method === "POST") {
        const body = await readJson(req);
        const id = String(body.id ?? "");
        if (!id) return send(res, 400, { error: COCKPIT_ERRORS.badRequest });
        // Same gate as send (#41): waking is what makes a send possible, so the two answers must
        // never disagree about whether an agent may pull another session's process up.
        if (!sendOk) return send(res, 403, { error: COCKPIT_ERRORS.sendsDisabled });
        const target = rowOf(id);
        if (!target) return send(res, 404, { error: COCKPIT_ERRORS.outOfScope });
        if (!target.cold) return send(res, 200, { schema_version: COCKPIT_SCHEMA_VERSION, woke: false, already_live: true, id });
        try {
          const info = await mgr.resume(id);
          return send(res, 200, { schema_version: COCKPIT_SCHEMA_VERSION, woke: true, id, status: info.status });
        } catch (e) {
          return send(res, 409, { error: COCKPIT_ERRORS.wakeFailed, message: String((e as Error)?.message ?? e) });
        }
      }
      return send(res, 404, { error: "unknown cockpit command" });
    }

    if (url.pathname === "/api/plan/mcp" && req.method === "POST") {
      const ip = clientIp(req);
      if (!LOOPBACK_IPS.has(ip)) return send(res, 403, { error: "the plan tool is loopback-only" });
      const body = await readJson(req);
      const token = String(req.headers["x-agentus-plan-token"] ?? "");
      const sessionId = String(body.session ?? "");
      if (body.op === "read") {
        const out = mgr.planForMcp(sessionId, token);
        return out.ok ? send(res, 200, { plan: out.plan }) : send(res, 403, { error: out.error });
      }
      if (body.op === "update") {
        const out = mgr.writePlanFromMcp(sessionId, token, {
          items: body.items, title: body.title, explanation: body.explanation,
        });
        if (!out.ok) return send(res, 403, { error: out.error });
        return send(res, 200, { accepted: out.accepted, reason: out.reason, plan: out.plan });
      }
      return send(res, 400, { error: "op must be 'read' or 'update'" });
    }

    // ---- outer lock: optional HTTP Basic, in front of EVERYTHING (static, /healthz,
    // /api, login page). This is the layer that a public tunnel needs, because a
    // tunnel's own "auth_pass" does not necessarily gate HTTP (see auth.ts).
    if (!auth.verifyBasic(req.headers.authorization)) {
      res.writeHead(401, auth.basicChallenge());
      return res.end("Agentus: authentication required\n");
    }

    // ---- the root CA, behind the operator login too -------------------------------------
    // `GET /api/tls`         what the cert is (subject, validity, SHA-256 fingerprint) so the
    //                        settings card can show it before you download anything;
    // `GET /api/tls/ca.crt`  the DER the phone/Mac installs. DER + `application/x-x509-ca-cert`
    //                        is what makes iOS/macOS open the *profile install* flow on a plain
    //                        tap — serve it as text/plain or octet-stream and iOS just shows text.
    // Nothing here reads a key: this is the certificate, which is public material by design.
    if (url.pathname === "/api/tls" || url.pathname === "/api/tls/ca.crt") {
      if (!auth.authenticate(req.headers, url)) return send(res, 401, { error: "login required" });
      if (!fs.existsSync(CA_FILE)) return send(res, 404, { error: "no ca configured", path: CA_FILE });
      let cert: X509Certificate;
      try { cert = new X509Certificate(fs.readFileSync(CA_FILE)); }
      catch (e) { return send(res, 500, { error: `ca is not a certificate: ${(e as Error).message}` }); }
      if (url.pathname === "/api/tls/ca.crt") {
        res.writeHead(200, {
          "content-type": "application/x-x509-ca-cert",
          "content-length": String(cert.raw.length),
          "content-disposition": 'attachment; filename="agentus-ca.crt"',
          "cache-control": "no-store",
        });
        return res.end(cert.raw);
      }
      return send(res, 200, {
        ok: true,
        hasCA: true,
        subject: cert.subject.replace(/\n/g, ", "),
        issuer: cert.issuer.replace(/\n/g, ", "),
        notBefore: cert.validFrom,
        notAfter: cert.validTo,
        fingerprint256: cert.fingerprint256,
        bytes: cert.raw.length,
        selfSigned: cert.subject === cert.issuer,
      });
    }

    // ---- 工作播报 diagnostics (issues #23/#24) ------------------------------------------
    // What the hub is watching and what it spawned. Operator-only, read-only, no secrets: this is
    // the answer to 「它有没有在看这个会话 / 观察员还活着吗」 that used to require reading logs.
    if (url.pathname === "/api/observer" && req.method === "GET") {
      if (!auth.authenticate(req.headers, url)) return send(res, 401, { error: "login required" });
      const o = getSettings().observer;
      return send(res, 200, {
        enabled: o.enabled,
        intervalSec: o.intervalSec,
        throttleSec: o.throttleSec,
        observers: hub?.observerIds() ?? [],
        watches: hub?.debug() ?? [],
        ticks: hub?.ticks() ?? 0,
      });
    }

    // ---- 会话级喇叭档位 (issue #68) -------------------------------------------------------
    // The horn in the corner belongs to the conversation it was switched on in: turning it on in one
    // session used to make EVERY session start reading aloud. The global `prefs.speakMode` is now the
    // DEFAULT layer — a session without its own row inherits it, which is the whole compatibility
    // story (nothing changes for anyone who never touched a horn).
    if (url.pathname === "/api/speak-modes" && req.method === "GET") {
      if (!auth.authenticate(req.headers, url)) return send(res, 401, { error: "login required" });
      const p = getSettings().prefs;
      const o = getSettings().observer;
      return send(res, 200, {
        sessions: allSessionSpeak(),
        defaults: { mode: p.speakMode, intervalSec: o.intervalSec },
        // The observer is an ACP process that spends tokens, so a beat on it cannot fire while that
        // section is off — the menu has to say so instead of showing a tickmark (#69 §1).
        observerEnabled: o.enabled,
      });
    }
    // 一个会话的档位：GET 解析，PUT 写会话行，DELETE 回到「跟全局默认走」。
    const speakRoute = /^\/api\/sessions\/([\w.-]+)\/speak$/.exec(url.pathname);
    if (speakRoute) {
      if (!auth.authenticate(req.headers, url)) return send(res, 401, { error: "login required" });
      const sid = speakRoute[1];
      if (req.method === "GET") {
        return send(res, 200, { speak: resolveSpeak(sid, { mode: getSettings().prefs.speakMode, intervalSec: getSettings().observer.intervalSec }) });
      }
      if (req.method === "PUT" || req.method === "POST") {
        const body = await readJson(req);
        const mode = String(body.mode ?? "");
        if (mode !== "off" && mode !== "reply" && mode !== "brief") {
          return send(res, 400, { error: `invalid mode: ${JSON.stringify(body.mode)}` });
        }
        const intervalSec = Number(body.intervalSec ?? 0);
        if (!Number.isFinite(intervalSec) || intervalSec < 0 || intervalSec > SPEAK_INTERVAL_MAX) {
          return send(res, 400, { error: `invalid intervalSec: ${JSON.stringify(body.intervalSec)}` });
        }
        const speak = setSessionSpeak(sid, mode, intervalSec);
        // 档位离开 brief 就是收尾 (#69 §2): the observer is a whole ACP process, and waiting for the
        // idle reaper would be five more minutes of paying for a feature that was just switched off.
        hub?.onPolicyChanged();
        return send(res, 200, {
          speak,
          resolved: resolveSpeak(sid, { mode: getSettings().prefs.speakMode, intervalSec: getSettings().observer.intervalSec }),
        });
      }
      if (req.method === "DELETE") {
        // 回到默认层。删掉这一行而不是写 off：写 off 会让它永远不再继承默认。
        clearSessionSpeak(sid);
        hub?.onPolicyChanged();
        return send(res, 200, {
          resolved: resolveSpeak(sid, { mode: getSettings().prefs.speakMode, intervalSec: getSettings().observer.intervalSec }),
        });
      }
      return send(res, 405, { error: "method not allowed" });
    }

    // ---- the phone's onboarding page + the APK, both behind the operator login ----------
    // The pairing code lives on this page, so it is NOT public: an unauthenticated visitor is
    // sent to the login screen (the SPA at /) and comes back with a session cookie.
    if (url.pathname === "/notify" || url.pathname === "/notify/" || url.pathname === "/agentus-companion.apk") {
      const who = auth.authenticate(req.headers, url);
      if (!who) {
        res.writeHead(302, { location: "/" });
        return res.end("login required\n");
      }
      if (url.pathname === "/agentus-companion.apk") {
        if (!fs.existsSync(APK_FILE)) return send(res, 404, { error: "no apk built yet" });
        res.writeHead(200, {
          "content-type": "application/vnd.android.package-archive",
          "content-length": String(fs.statSync(APK_FILE).size),
          "content-disposition": 'attachment; filename="agentus-companion.apk"',
          "cache-control": "no-store",
        });
        fs.createReadStream(APK_FILE).pipe(res);
        return undefined;
      }
      const secure = Boolean((req.socket as { encrypted?: boolean }).encrypted)
        || String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
      const host = String(req.headers.host ?? "localhost");
      const origin = `${secure ? "https" : "http"}://${host}`;
      const pairUri = `agentus://pair?u=${encodeURIComponent(origin)}&c=${notify.code}`;
      const apkPath = APK_FILE;
      const apkSize = fs.existsSync(apkPath) ? `${(fs.statSync(apkPath).size / 1048576).toFixed(1)} MB` : "尚未构建";
      const rows = notify.devices().map((d) =>
        `<tr><td>${d.name}</td><td>${d.platform} ${d.sdkInt}</td><td>${d.capabilities.join(" ")}</td>` +
        `<td>${d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "—"}</td></tr>`).join("");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agentus 手机通知</title>
<style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;margin:24px auto;max-width:40em;padding:0 16px}
code{background:#f2f2ef;padding:3px 7px;border-radius:5px;word-break:break-all;font-size:13px}
button{font:inherit;padding:7px 12px;margin:4px 6px 4px 0;border-radius:8px;border:1px solid #ccc;background:#fff}
td{padding:3px 12px 3px 0;font-size:12px;font-family:ui-monospace,monospace}
h1{font-size:20px} h3{font-size:15px;margin-top:28px} li{margin:6px 0}</style>
<h1>手机通知（Android 伴侣）</h1>
<ol>
<li>装 App：<a href="/agentus-companion.apk">agentus-companion.apk</a> (${apkSize})<br>
    <small>手机浏览器会提示"安装未知应用"，允许一次即可。${fs.existsSync(apkPath) ? `<br>sha256 <code>${createHash("sha256").update(fs.readFileSync(apkPath)).digest("hex")}</code>` : ""}</small></li>
<li>打开 App，把这一行粘进首屏（或直接填地址 ${origin} + 你的用户名密码）：<br>
    <code id="uri">${pairUri}</code>
    <button onclick="navigator.clipboard.writeText(document.getElementById('uri').textContent)">复制</button></li>
<li>授予通知权限。上岛（灵动岛）两条路：<b>Android 16</b> 打开 App 里那个「实时动态」系统开关；
    <b>小米/澎湃</b>点 App 里的「小米焦点通知权限」看是否放行（澎湃默认不给三方应用焦点通知，不放行就只有普通通知）。</li>
<li>折叠屏（MIX Fold 4 之类）：展开/合上都会自适应——外屏单栏、内屏双栏，正在填的表单不会丢。</li>
<li>手机用蜂窝网连不上：多半是 safe-nat 白名单没放行（表现是连接被重置，或运营商代理伪装成 502）。
    在 <code>http://i207f47592.wicp.vip:10086</code> 面板「白名单 → 当前访问者 → 加入白名单」把自己加上。</li>
</ol>
<p><button onclick="post('/api/notify/probe')">发一条探针通知到我的手机</button>
   <button onclick="post('/api/notify/pair-code/rotate').then(()=>location.reload())">换一个配对码</button></p>
<h3>已配对设备</h3>
<table>${rows || "<tr><td>（还没有设备配对）</td></tr>"}</table>
<p style="color:#888;font-size:12px">配对码 <b>${notify.code}</b> · 服务端 ${origin}</p>
<script>
async function post(path){const r=await fetch(path,{method:'POST'});alert(r.ok?'已发送':'失败 '+r.status)}
</script>`);
    }

    // ---- auth gate. Everything under /api except the login/me endpoints is
    // closed; the SPA shell, its assets and /healthz stay public so the login
    // page itself can load (the browser has no cookie yet at that point).
    if (auth.requiresAuth(url.pathname)) {
      const who = auth.authenticate(req.headers, url);
      if (!who) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "unauthorized", authRequired: true }));
      }
      (req as IncomingMessage & { principal?: auth.AuthPrincipal }).principal = who;
    }

    // Web IDE bridge (issue #77). Placed AFTER the gate on purpose — that is what makes the proxy
    // inherit the operator's cookie instead of needing an auth path of its own. When
    // AGENTUS_IDE_UPSTREAM is unset it costs one string compare and answers only /api/ide/status.
    if (await ide.handleHttp(req, res, url)) return;

    if (url.pathname === "/api/auth/me" && req.method === "GET") {
      const who = auth.authenticate(req.headers, url);
      const st = auth.status(); // live: the operator can change these while the app is up
      return send(res, 200, {
        authEnabled: st.enabled,
        authenticated: Boolean(who),
        kind: who?.kind ?? null,
        username: who?.username ?? null,
        // the account the cockpit would accept right now (what the settings page shows)
        configuredUsername: st.username,
        credentialSource: st.source,
        minPasswordLen: auth.MIN_PASSWORD_LEN,
        expiresAt: who?.expiresAt ?? null,
        usingDefaultPassword: st.usingDefaultPassword,
      });
    }
    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      const secure = auth.isSecureRequest(req.headers);
      const body = await readJson(req);
      const username = String(body.username ?? "");
      const password = String(body.password ?? "");
      const ip = clientIp(req);
      const gate = auth.loginAllowed(ip);
      if (!gate.allowed) {
        // 429 so the UI can say "slow down" rather than "wrong password"
        res.writeHead(429, { "content-type": "application/json", "retry-after": String(Math.ceil(gate.retryAfterMs / 1000)) });
        return res.end(JSON.stringify({ error: "too_many_attempts", retryAfterMs: gate.retryAfterMs }));
      }
      if (!auth.verifyCredentials(username, password)) {
        auth.recordLoginFailure(ip);
        const left = auth.loginLimits().maxFails;
        const after = auth.loginAllowed(ip);
        console.warn(`[agentus] failed login for "${username}" from ${ip}${after.allowed ? "" : " (locked out)"}`);
        return send(res, 401, { error: "bad_credentials", hint: `username/password rejected (limit ${left} tries per IP)` });
      }
      auth.recordLoginSuccess(ip);
      const st = auth.status();
      const { value, expiresAt } = auth.issueSession(st.username, Date.now(), { ip, ua: String(req.headers["user-agent"] ?? "") });
      console.log(`[agentus] login ok: ${st.username} from ${ip}`);
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": auth.sessionCookie(value, Math.floor(st.sessionTtlMs / 1000), secure),
      });
      return res.end(JSON.stringify({ username: st.username, expiresAt, usingDefaultPassword: st.usingDefaultPassword }));
    }
    if (url.pathname === "/api/auth/credentials" && req.method === "POST") {
      // Behind the same gate as the rest of /api (it is not in PUBLIC_API), so a caller
      // here already holds a session or the machine token — yet the change still demands
      // the current password: handing the cockpit over deserves a second proof.
      const body = await readJson(req);
      const out = auth.changeCredentials({
        currentPassword: String(body.currentPassword ?? ""),
        username: body.username === undefined ? undefined : String(body.username),
        newPassword: body.newPassword === undefined || body.newPassword === null ? undefined : String(body.newPassword),
      });
      if (!out.ok) return send(res, out.status, { error: out.error });
      console.log(`[agentus] credentials changed: user "${out.username}" (epoch ${out.epoch}) from ${clientIp(req)}`);
      // every older cookie is dead now (the epoch moved) — hand this caller a fresh one
      const st = auth.status();
      const { value, expiresAt } = auth.issueSession(st.username, Date.now(), { ip: clientIp(req), ua: String(req.headers["user-agent"] ?? "") });
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": auth.sessionCookie(value, Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)), auth.isSecureRequest(req.headers)),
      });
      return res.end(JSON.stringify({
        ok: true,
        username: st.username,
        credentialSource: st.source,
        usingDefaultPassword: st.usingDefaultPassword,
        expiresAt,
      }));
    }
    if (url.pathname === "/api/auth/sessions" && req.method === "GET") {
      const who = (req as IncomingMessage & { principal?: auth.AuthPrincipal }).principal;
      return send(res, 200, {
        sessions: auth.listSessions(who?.jti),
        ttlMs: auth.sessionTtlMs(),
      });
    }
    if (url.pathname === "/api/auth/sessions/revoke" && req.method === "POST") {
      const body = await readJson(req);
      const jti = String(body.jti ?? "");
      const who = (req as IncomingMessage & { principal?: auth.AuthPrincipal }).principal;
      if (jti && jti === who?.jti) {
        // revoking yourself is "log out", not "kick this device" — say so instead of
        // silently leaving the browser holding a dead cookie
        return send(res, 400, { error: "that is this session — use log out" });
      }
      if (!auth.revokeSessionById(jti)) return send(res, 404, { error: "no such session" });
      console.log(`[agentus] session revoked: ${jti} from ${clientIp(req)}`);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/auth/sessions/revoke-others" && req.method === "POST") {
      const who = (req as IncomingMessage & { principal?: auth.AuthPrincipal }).principal;
      const count = auth.revokeOtherSessions(who?.jti);
      console.log(`[agentus] logged out ${count} other session(s), asked by ${clientIp(req)}`);
      return send(res, 200, { ok: true, count });
    }
    if (url.pathname === "/api/auth/locked-ips" && req.method === "GET") {
      return send(res, 200, { locks: auth.listIpLocks(), maxFails: auth.loginLimits().maxFails, lockMs: auth.loginLimits().lockMs });
    }
    if (url.pathname === "/api/auth/locked-ips" && req.method === "DELETE") {
      const ip = String(url.searchParams.get("ip") ?? "").trim();
      if (ip) {
        const known = auth.unlockIp(ip);
        if (!known) return send(res, 404, { error: "that IP is not locked" });
        console.log(`[agentus] lock lifted for ${ip} (asked by ${clientIp(req)})`);
        return send(res, 200, { ok: true, ip });
      }
      const count = auth.unlockAllIps();
      console.log(`[agentus] all login locks lifted (${count}) by ${clientIp(req)}`);
      return send(res, 200, { ok: true, count });
    }
    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      // Revoke, don't just clear: see auth.revokeSession
      const cookie = auth.parseCookies(String(req.headers.cookie ?? ""))[auth.AUTH_COOKIE_NAME];
      const revoked = auth.revokeSession(cookie);
      console.log(`[agentus] logout from ${clientIp(req)}${revoked ? "" : " (no live session)"}`);
      res.writeHead(200, { "content-type": "application/json", "set-cookie": auth.clearedCookie(auth.isSecureRequest(req.headers)) });
      return res.end(JSON.stringify({ ok: true, revoked }));
    }
    if (url.pathname === "/healthz") {
      return send(res, 200, { ok: true, ts: Date.now(), backends: store.listBackends().map((r) => r.id) });
    }
    // ---- backend registry (M6) --------------------------------------------------------------
    // A row says which COMMAND, which HERMES_HOME and which profile a slot spawns with; `plan`
    // resolves the home the same way the spawn does, so the panel shows the real path (a row
    // with no home of its own runs against the operator's own ~/.hermes).
    if (url.pathname === "/api/backends" && req.method === "GET") {
      return send(
        res,
        200,
        store.listBackends().map((row) => {
          const plan = planFor(row);
          return {
            id: row.id, label: row.label, kind: row.kind, cmd: row.cmd, args: row.args,
            env: Object.keys(row.env ?? {}), home: plan.home, profile: row.profile,
            cwd: row.cwd, notes: row.notes, builtin: row.builtin,
            // Which channel carries this backend's plan (P1). Sent with the list because the
            // settings page shows it next to the row: it is the one declaration an operator may
            // want to flip when an agent gains (or loses) native plan support.
            nativePlanSource: row.nativePlanSource,
            // Which permission mode a NEW session from this row starts in (null = the agent's own
            // default); the settings page edits it next to the other row declarations.
            defaultMode: row.defaultMode,
            warnings: rowWarnings(row),
            health: row.health, handshake: row.handshake,
          };
        }),
      );
    }
    if (url.pathname === "/api/backends" && req.method === "POST") {
      const body = (await readJson(req)) as Record<string, unknown>;
      const { row, error } = coerceRow(body);
      if (!row) return send(res, 400, { error });
      if (store.getBackend(row.id)) return send(res, 409, { error: `backend ${row.id} already exists` });
      store.upsertBackend(row);
      const plan = planFor(row);
      return send(res, 201, { ok: true, id: row.id, warnings: rowWarnings(row) });
    }
    const beMatch = url.pathname.match(/^\/api\/backends\/([\w.-]+)(\/.*)?$/);
    if (beMatch) {
      const beId = beMatch[1];
      const beSub = beMatch[2] ?? "";
      const existing = store.getBackend(beId);
      if (!existing) return send(res, 404, { error: `unknown backend: ${beId}` });
      if (req.method === "GET" && beSub === "") {
        const plan = planFor(existing);
        return send(res, 200, { ...existing, home: plan.home, warnings: rowWarnings(existing) });
      }
      if ((req.method === "PATCH" || req.method === "PUT") && beSub === "") {
        const body = (await readJson(req)) as Record<string, unknown>;
        const { row, error } = coerceRow({ ...body, id: beId }, existing);
        if (!row) return send(res, 400, { error });
        store.upsertBackend(row);
        const plan = planFor(row);
        return send(res, 200, { ok: true, id: row.id, warnings: rowWarnings(row) });
      }
      if (req.method === "DELETE" && beSub === "") {
        // A row that OPEN sessions still name must stay: deleting it would leave them pointing
        // at nothing and still expected to resume. Closed (archived) sessions keep the id for
        // display only, so they do not block deletion.
        const used = store.countOpenSessionsForBackend(beId);
        if (used > 0) {
          return send(res, 409, { error: `backend ${beId} is used by ${used} open session(s) — close or delete them first` });
        }
        store.deleteBackend(beId);
        return send(res, 200, { ok: true, deleted: beId });
      }
      if (req.method === "POST" && beSub === "/inspect") {
        // "Which tree does this row actually run?" — resolved command + the `Install directory:`
        // line that names the code tree + the home it will write into. Blocked rows are NOT
        // probed (probing would run the command the guard just refused).
        //
        // The verdict is also written back onto the row (kind=manual) so it survives the tab:
        // the list can say "checked 3m ago, manual, 412ms" and a failure stays visible instead
        // of disappearing with the panel that produced it.
        try {
          const report = await inspectRow(existing);
          store.recordBackendCheck(
            beId,
            checkedHealth(existing.health, {
              status: report.status,
              kind: "manual",
              errorCode: report.errorCode,
              message: report.error ?? report.acpCheck?.output ?? null,
              latencyMs: report.latencyMs,
            }),
          );
          return send(res, 200, report);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          store.recordBackendCheck(
            beId,
            checkedHealth(existing.health, {
              status: "offline", kind: "manual", errorCode: classifyError(e), message,
            }),
          );
          return send(res, 500, { error: message });
        }
      }
    }
    if (url.pathname === "/api/sessions" && req.method === "GET") {
      // `pending` rides along because it is STATE, not an event: a page that loads or refreshes
      // after the request was raised never saw the event, and would otherwise show nothing.
      return send(res, 200, { live: mgr.list(), cold: mgr.cold(), archived: mgr.archived(), pending: mgr.pendingPermissions() });
    }
    // The session's plan object — what the cockpit's card renders. STATE too, and the one piece of
    // it that cannot be replayed: after the agent process died there are no frames left to read,
    // and this row is the only thing that still knows the plan (design-plan-service.md §1/§8).
    const planReq = /^\/api\/sessions\/([^/]+)\/plan$/.exec(url.pathname);
    if (planReq && req.method === "GET") {
      return send(res, 200, { plan: store.getPlan(decodeURIComponent(planReq[1])) });
    }
    // Directory browser for the new-slot workspace picker (dirs only, one level).
    if (url.pathname === "/api/fs/dirs" && req.method === "GET") {
      try {
        // `sessionId` resolves the slot's workspace; `path` wins when both are given
        // (clicking through the tree is not a workspace change).
        const sessionId = url.searchParams.get("sessionId");
        const explicit = url.searchParams.get("path");
        const root = sessionId ? sessionRoot(sessionId) : null;
        const listing = listDirs(explicit ?? root?.path ?? null, { includeFiles: url.searchParams.get("files") === "1" });
        return send(res, 200, { ...listing, root: root?.path ?? null, recent: store.recentCwds(8) });
      } catch (e) {
        if (e instanceof FsError) {
          return send(res, e.code === "not_found" ? 404 : 400, { error: e.message, code: e.code });
        }
        throw e;
      }
    }
    // Read-only file preview for the workspace panel (▤ → Files).
    if (url.pathname === "/api/fs/file" && req.method === "GET") {
      try {
        const req0 = url.searchParams.get("path");
        if (!req0) return send(res, 400, { error: "path is required", code: "bad_path" });
        const maxBytes = Number(url.searchParams.get("maxBytes") || 0) || undefined;
        return send(res, 200, readTextFile(req0, { maxBytes }));
      } catch (e) {
        if (e instanceof FsError) {
          return send(res, e.code === "not_found" ? 404 : 400, { error: e.message, code: e.code });
        }
        throw e;
      }
    }
    // What IS this file? The panel asks before reading: an image or a PDF should not be pulled
    // through the text endpoint to learn that it is not text, and `kind` decides which renderer
    // and whether an editor is offered. Cheap: a stat plus a hash, no bytes decoded.
    if (url.pathname === "/api/fs/stat" && req.method === "GET") {
      try {
        return send(res, 200, statFile(url.searchParams.get("path")));
      } catch (e) {
        if (e instanceof FsError) {
          return send(res, e.code === "not_found" ? 404 : 400, { error: e.message, code: e.code });
        }
        throw e;
      }
    }
    // The file's RAW BYTES, for the renderers that need the real thing: an <img> in a reply,
    // a PDF in the preview panel, an audio/video tag. Before this existed there was no way to
    // show a local image at all (the read endpoint decodes utf-8 text and calls binary files
    // "binary file"), so every `![shot](/Users/…/shot.png)` an agent wrote was a broken image.
    //
    // Same trust model as the endpoints above: any path the server process can read, because
    // the operator can already point an agent at any directory and browse it via /api/fs/dirs.
    // Behind the same auth gate. `inline` on purpose — a preview must not turn into a download.
    if (url.pathname === "/api/fs/raw" && req.method === "GET") {
      try {
        const req0 = url.searchParams.get("path");
        if (!req0) return send(res, 400, { error: "path is required", code: "bad_path" });
        const info = statFile(req0);
        res.writeHead(200, {
          "content-type": info.contentType,
          "content-length": String(info.size),
          "cache-control": "no-store",
          "content-disposition": "inline",
        });
        const stream = fs.createReadStream(info.path);
        stream.on("error", () => res.destroy());
        // The operator may close the panel mid-stream; an unhandled 'error' on the response
        // would crash the process for a click that is not an error.
        res.on("close", () => stream.destroy());
        return stream.pipe(res);
      } catch (e) {
        if (e instanceof FsError) {
          return send(res, e.code === "not_found" ? 404 : 400, { error: e.message, code: e.code });
        }
        throw e;
      }
    }
    // Save an edit made in the panel. 409 carries the CURRENT bytes when the file changed on
    // disk while the operator was typing, so the UI can offer to reload instead of choosing
    // silently whose work to lose (see writeTextFile).
    if (url.pathname === "/api/fs/file" && (req.method === "PUT" || req.method === "POST")) {
      const body = await readJson(req);
      try {
        const path0 = typeof body.path === "string" ? body.path : "";
        if (!path0) return send(res, 400, { error: "path is required", code: "bad_path" });
        const content = typeof body.content === "string" ? body.content : "";
        const ifHash = typeof body.ifHash === "string" ? body.ifHash : undefined;
        return send(res, 200, { ok: true, ...writeTextFile(path0, content, { ifHash }) });
      } catch (e) {
        if (e instanceof ChangedOnDiskError) {
          return send(res, 409, {
            error: "changed_on_disk",
            path: e.target,
            hash: e.currentHash,
            content: e.currentContent,
            truncated: e.truncated,
            hint: "the file changed on disk since you opened it",
          });
        }
        if (e instanceof FsError) {
          return send(res, e.code === "not_found" ? 404 : 400, { error: e.message, code: e.code });
        }
        throw e;
      }
    }
    // The windows remembered per model (the settings page and scripts read this).
    if (url.pathname === "/api/context-limits" && req.method === "GET") {
      return send(res, 200, { limits: store.listModelLimits() });
    }
    // Operator settings: the page reads and writes this. Secrets only ever leave
    // through a mask (publicSettings) — an unchanged mask round-trips as "keep".
    // #62-1: 模型使用计数。列表排序要跨会话、跨设备一致，所以它在 server 上；前端只读。
    if (url.pathname === "/api/model-usage" && req.method === "GET") {
      return send(res, 200, { usage: modelUsage() });
    }
    if (url.pathname === "/api/settings" && req.method === "GET") {
      return send(res, 200, publicSettings());
    }
    if (url.pathname === "/api/settings" && (req.method === "PUT" || req.method === "POST")) {
      const body = await readJson(req);
      try {
        if (body.voice && typeof body.voice === "object") saveSettings(body.voice as Record<string, unknown>);
        if (body.theme && typeof body.theme === "object") saveTheme(body.theme as Record<string, unknown>);
        if (body.call && typeof body.call === "object") saveCall(body.call as Record<string, unknown>);
        if (body.prefs && typeof body.prefs === "object") savePrefs(body.prefs as Record<string, unknown>);
        if (body.agent && typeof body.agent === "object") saveAgent(body.agent as Record<string, unknown>);
        if (body.observer && typeof body.observer === "object") saveObserver(body.observer as Record<string, unknown>);
        // Turning the speaker off (or the observer off) must stop the COST, not just the voice:
        // the observer is a whole ACP process, and waiting for the idle reaper to take it is five
        // minutes of paying for a feature the operator just switched off (issue #23 §3.2).
        if (body.prefs || body.observer) hub?.onPolicyChanged();
        if (body.summary && typeof body.summary === "object") saveSummary(body.summary as Record<string, unknown>);
        if (!body.voice && !body.theme && !body.call && !body.prefs && !body.agent && !body.observer && !body.summary) saveSettings(body);
        return send(res, 200, publicSettings());
      } catch (e) {
        // `field` rides along when the validator named one (#65): the page shows it under that input.
        const field = (e as { field?: unknown })?.field;
        return send(res, 400, {
          error: String((e as Error)?.message ?? e),
          ...(typeof field === "string" ? { field } : {}),
        });
      }
    }
    // The model ids the configured endpoint really serves, for the settings dropdowns
    // ("其它的也可选"): ask the endpoint instead of shipping a catalogue.
    if (url.pathname === "/api/voice/models" && req.method === "GET") {
      try {
        return send(res, 200, await listVoiceModels());
      } catch (e) {
        const code = e instanceof VoiceError && e.code === "not_configured" ? 501 : 502;
        return send(res, code, { error: String((e as Error)?.message ?? e) });
      }
    }
    // Which hotwords the next recognition would carry, and where each came from: the
    // settings page shows this instead of asking the operator to trust a textarea.
    if (url.pathname === "/api/voice/hotwords" && req.method === "GET") {
      const sid = url.searchParams.get("sessionId") || undefined;
      const words = hotwordsFor(store, sid);
      // contextTurns is the half of the request the settings page could not see: it is the
      // count of natural-language turns the next recognition would carry, and it used to be
      // 0 forever because the window was applied before the kind filter (issue #21).
      const context = dictationContext(store, sid);
      return send(res, 200, {
        words: words.map((h) => ({ word: h.word, weight: h.weight, origin: h.origin })),
        fixed: words.filter((h) => h.origin === "fixed").length,
        dynamic: words.filter((h) => h.origin === "dynamic").length,
        contextTurns: context.length,
        context: context.map((c) => ({ role: c.role, text: c.text.slice(0, 80) })),
      });
    }
    // What the browser should offer: it can always speak/read text itself, and the
    // server adds a configured provider (voice.ts) — 百炼 or any OpenAI-compatible one.
    if (url.pathname === "/api/voice" && req.method === "GET") {
      return send(res, 200, voiceCapabilities());
    }
    if (url.pathname === "/api/tts" && req.method === "POST") {
      const body = await readJson(req);
      const text = String(body.text ?? "").trim();
      if (!text) return send(res, 400, { error: "text is required" });
      if (text.length > 4000) return send(res, 400, { error: "text too long (4000 chars max)" });
      try {
        const { contentType, audio } = await synthesize(text, {
          voice: typeof body.voice === "string" ? body.voice : undefined,
          speed: typeof body.speed === "number" ? body.speed : undefined,
        });
        res.writeHead(200, { "content-type": contentType, "content-length": String(audio.length), "cache-control": "no-store" });
        return res.end(audio);
      } catch (e) {
        if (e instanceof VoiceError) {
          // Leave a trace, or the only symptom is a voice that changed mid-reply (the client falls
          // back to the browser voice for that sentence). Measured cause so far: 429
          // Throttling.RateQuota from 百炼 when more than three clips are asked for at once.
          console.error(`[agentus] tts failed: ${e.code} ${e.message.slice(0, 160)}`);
          return send(res, e.code === "not_configured" ? 501 : 502, { error: e.message, code: e.code });
        }
        throw e;
      }
    }
    if (url.pathname === "/api/stt" && req.method === "POST") {
      const audio = await readBody(req);
      if (!audio.length) return send(res, 400, { error: "empty audio body" });
      try {
        const text = await transcribe(audio, String(req.headers["content-type"] ?? "audio/webm"), {
          filename: typeof req.headers["x-agentus-filename"] === "string" ? req.headers["x-agentus-filename"] : undefined,
          language: url.searchParams.get("language") || undefined,
          // the session tells the recogniser what this conversation is about (hotwords)
          sessionId: url.searchParams.get("sessionId") || undefined,
        });
        return send(res, 200, { text });
      } catch (e) {
        if (e instanceof VoiceError) return send(res, e.code === "not_configured" ? 501 : 502, { error: e.message, code: e.code });
        throw e;
      }
    }
    // Terminal sessions for the workspace panel: list + kill (start/IO is the WS,
    // because a shell is a stream, not a request/response).
    if (url.pathname === "/api/term" && req.method === "GET") {
      return send(res, 200, { sessions: terms.list() });
    }
    if (url.pathname === "/api/sessions" && req.method === "POST") {
      const body = await readJson(req);
      const backendRaw = String(body.backend ?? "");
      const beRow = store.getBackend(backendRaw);
      const backend = beRow || Object.prototype.hasOwnProperty.call(BACKENDS, backendRaw)
        ? (backendRaw as BackendId)
        : null;
      if (!backend) return send(res, 400, { error: `unknown backend: ${backendRaw}` });
      let cwd = String(body.cwd ?? "").trim();
      // A row may carry a default working directory: that is where its kind of work belongs
      // (e.g. a "hermes fork, dev tree" row that should always start in the checkout).
      if (!cwd && beRow?.cwd) cwd = beRow.cwd;
      if (!cwd || cwd === "~") cwd = homedir();
      else if (cwd.startsWith("~/")) cwd = path.join(homedir(), cwd.slice(2));
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        return send(res, 400, { error: `cwd not a directory: ${cwd}` });
      }
      const info = await mgr.create(backend, cwd, body.title ? String(body.title) : undefined);
      emit(sessionsEvent());
      return send(res, 201, info);
    }
    const sessMatch = url.pathname.match(/^\/api\/sessions\/([\w-]+)(\/.*)?$/);
    if (sessMatch) {
      const id = sessMatch[1];
      const sub = sessMatch[2] ?? "";
      if (req.method === "DELETE" && sub === "") {
        // awaited on purpose: closeSession is async and a floating rejection
        // here used to kill the whole server (QA#19, unhandled rejection)
        if (mgr.hasSession(id)) {
          await mgr.closeSession(id);
          // 工作播报 (#23): a closed session's observer and its watch entry have no future. Before
          // this, `forget()` had zero call sites and the map only grew.
          hub?.forget(id);
          return send(res, 200, { closed: id });
        }
        // not live: either a cold slot the operator wants gone, or an unknown id.
        // Purging is what makes the rail's "on disk · N" list manageable (M4).
        if (store.deleteSession(id)) {
          hub?.forget(id);
          emit(sessionsEvent());
          return send(res, 200, { purged: id });
        }
        return send(res, 404, { error: `no such session: ${id}` });
      }
      if (req.method === "POST" && sub === "/archive") {
        // 归档: the operator's own storage decision (and it stops a live process — see
        // SessionManager.setArchived). Distinct from DELETE, which on a LIVE slot only closes it and
        // on a COLD one purges the record: 归档 is the middle statement, and before this route the UI
        // had no way to make it.
        try {
          const info = await mgr.setArchived(id, true);
          hub?.forget(id);
          emit(sessionsEvent());
          return send(res, 200, info);
        } catch (e) {
          return send(res, 404, { error: String((e as Error)?.message ?? e) });
        }
      }
      if (req.method === "POST" && sub === "/unarchive") {
        // 取消归档: moves the flag only. Waking the slot is a SEPARATE /resume, so a restore that
        // cannot load leaves a visible cold slot in 工作空间 instead of an error nobody asked for.
        try {
          const info = await mgr.setArchived(id, false);
          emit(sessionsEvent());
          return send(res, 200, info);
        } catch (e) {
          return send(res, 404, { error: String((e as Error)?.message ?? e) });
        }
      }
      if (req.method === "POST" && sub === "/resume") {
        // AC5's other half: bring a cold slot back to life (respawn + loadSession)
        try {
          const info = await mgr.resume(id);
          emit(sessionsEvent());
          return send(res, 200, info);
        } catch (e) {
          // A cold slot the agent can no longer adopt is NOT a server fault and NOT an outage:
          // 409 with the reason and BOTH homes, so the client can say why and offer the only
          // useful action (delete it). Before this the operator got a slot that said "ready" and
          // silently ate every message (measured 2026-10-06 — see SessionUnavailable).
          if (e instanceof SessionUnavailable) {
            emit(sessionsEvent());
            return send(res, 409, {
              error: e.message,
              code: e.code,
              sessionHome: e.sessionHome,
              rowHome: e.rowHome,
            });
          }
          throw e;
        }
      }
      if (req.method === "POST" && sub === "/restart") {
        // Swap the agent process under a LIVE slot — the operator's "make this slot run the code I
        // just changed" button. Same session, same picks, new pid. A cold slot has no process to
        // replace: that is /resume, and saying so beats a 500.
        if (!mgr.hasSession(id)) return send(res, 404, { error: `session ${id} has no running agent — resume it instead` });
        try {
          const info = await mgr.restart(id);
          emit(sessionsEvent());
          return send(res, 200, info);
        } catch (e) {
          // Same refusal shape as /resume: the agent could not adopt the session in this home, and
          // the only useful action is the same one (delete the dead slot).
          if (e instanceof SessionUnavailable) {
            emit(sessionsEvent());
            return send(res, 409, {
              error: e.message,
              code: e.code,
              sessionHome: e.sessionHome,
              rowHome: e.rowHome,
            });
          }
          throw e;
        }
      }
      if (req.method === "GET" && sub === "/messages") {
        // Paging contract (M4):
        //   no params / tail=1   -> NEWEST page, oldest-first, hasOlder says more exist above
        //   before=<seq>         -> the previous page above that seq
        //   after=<seq>          -> forward replay rows from a reconnect anchor (WS path)
        // Page size is env-tunable so the paging path is testable without 500+ messages.
        const pageSize = Number(process.env.AGENTUS_HISTORY_PAGE || 500);
        const before = url.searchParams.get("before");
        const after = url.searchParams.get("after");
        if (before != null) {
          const page = store.messagesBefore(id, Number(before), Math.min(pageSize, 200));
          return send(res, 200, { messages: page.messages, hasOlder: page.hasMore });
        }
        if (after != null && !url.searchParams.has("tail")) {
          const msgs = store.messagesAfter(id, Number(after), pageSize);
          return send(res, 200, { messages: msgs, hasOlder: false });
        }
        const page = store.messagesTail(id, pageSize);
        return send(res, 200, { messages: page.messages, hasOlder: page.hasOlder });
      }
      if (req.method === "POST" && sub === "/prompt") {
        const body = await readJson(req);
        const text = String(body.text ?? "").trim();
        const attachments = Array.isArray(body.attachments) ? (body.attachments as PromptAttachment[]) : [];
        if (!text && !attachments.length) return send(res, 400, { error: "empty prompt" });
        // fire & forget: stream arrives via WS; client watches turn-start/end
        void runPrompt(id, text, attachments, body.interrupt === true, typeof body.pid === "string" ? body.pid : undefined);
        return send(res, 202, { ok: true });
      }
      if (req.method === "POST" && sub === "/workspace") {
        const body = await readJson(req);
        const raw = String(body.path ?? "").trim();
        // Empty clears the override ("back to the cwd this slot was spawned in").
        let workspace: string | null = null;
        if (raw) {
          workspace = expandUserPath(raw);
          if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
            return send(res, 400, { error: `not a directory: ${workspace}` });
          }
        }
        const info = mgr.setWorkspace(id, workspace);
        emit(sessionsEvent());
        return send(res, 200, info);
      }
      if (req.method === "GET" && sub === "/export") {
        // ACP has no "export" (the protocol only carries the stream; AionUi does this over
        // its own storage too) — we render from OUR persisted rows. `?format=json` is the
        // lossless dump, markdown is the readable transcript. Works for cold sessions
        // without waking the agent: no live process needed, just the DB.
        const row = store.getSession(id);
        if (!row) return send(res, 404, { error: `no such session: ${id}` });
        const format = url.searchParams.get("format") === "json" ? "json" : "md";
        const header: ExportSessionHeader = {
          id: row.id, title: row.title, backend: row.backend, cwd: row.cwd,
          workspace: row.workspace ?? null, acpSessionId: row.acpSessionId,
          createdAt: row.createdAt,
        };
        const all = store.messagesTail(id, Number.MAX_SAFE_INTEGER).messages;
        const body = format === "json" ? renderJson(header, all) : renderMarkdown(header, all);
        res.writeHead(200, {
          "content-type": format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
          "content-disposition": `attachment; filename="${exportFilename(row.title, format === "json" ? "json" : "md").replace(/[^\x20-\x7e]/g, "_")}"`,
        });
        res.end(body);
        return undefined;
      }
      if (req.method === "POST" && sub === "/rename") {
        const body = await readJson(req);
        const raw = body.title;
        // absent/null or an all-blank string = clear back to the generated title
        const title = raw == null ? null : String(raw);
        try {
          const info = mgr.rename(id, title);
          emit(sessionsEvent());
          return send(res, 200, info);
        } catch (e) {
          const msg = String((e as Error)?.message ?? e);
          return send(res, /no such session/.test(msg) ? 404 : 400, { error: msg });
        }
      }
      if (req.method === "POST" && sub === "/title/regenerate") {
        try {
          // Ask the agent to name this conversation from its CURRENT content (via a throwaway
          // fork), falling back to the latest prompt when it cannot. The store's authority
          // rule decides whether the visible title moves; `via` says which producer answered.
          const info = await mgr.regenerateTitle(id);
          emit(sessionsEvent());
          return send(res, 200, { info, via: mgr.lastTitleVia });
        } catch (e) {
          const msg = describeAcpError(e);
          if (/no such session/.test(msg)) return send(res, 404, { error: msg });
          return send(res, 409, { error: msg });
        }
      }
      if (req.method === "POST" && sub === "/speech-summary") {
        /** The endpoint this session's OWN model lives on. Read per request: the operator can
         *  switch the model from the toolbar and the next long press must follow it. */
        const sessionRoute = (): { route: SpeechRoute | null; why: string } => {
          const row = store.getSession(id);
          if (!row) return { route: null, why: "会话不在库里" };
          const be = store.listBackends().find((b) => b.id === row.backend);
          // LIVE first, store second (#36). The ACP handshake reports the model, and the live
          // session object holds it — but `sessions.models` is flushed later (observed: JSON null
          // for every row on this box), so reading the store alone answered 「agent 未握手」 and
          // every summary silently fell back to the voice endpoint's qwen-flash.
          const live = mgr.list().find((s) => s.id === id);
          const modelId = live?.models?.currentModelId
            ?? ((row.models ?? {}) as { currentModelId?: string | null }).currentModelId
            ?? null;
          // The provider keys live in this box's agent home, which is a property of the runtime —
          // not of the vendor that happens to be driving this session. A backend that owns no home
          // (mock, qoder) therefore still resolves a `deepseek:…` model through the Hermes home.
          const home = (be ? planFor(be).home : null) ?? HERMES_DEFAULT_HOME;
          return routeForModel(modelId, home);
        };
        // 语音总结 (the message speaker's long press): ONE stored message, made listenable.
        //
        // No agent, no fork, no history: the text goes to the voice endpoint's chat surface, the
        // same one ASR already posts to. The BODY of the message is read from the store by key —
        // the browser does not get to say what reaches the model, and the server's copy is what the
        // operator actually saw on screen.
        const cfg = summarySettings();
        if (!cfg.enabled) return send(res, 409, { error: "语音总结已关闭（设置 → 语音总结）", code: "disabled" });
        const body = await readJson(req);
        const key = String(body.key ?? "").trim();
        if (!key) return send(res, 400, { error: "key is required" });
        const row = store.messageByKey(id, key);
        if (!row) return send(res, 404, { error: `no such message: ${key}` });
        // 字数档 (issue from the operator, 2026-10-18): the message speaker's long press offers
        // 100/150/200 字 next to 「按设置」. The count is the ONE thing that varies per call, and it
        // rides the prompt's existing `{maxChars}` placeholder — so this is the only place it has to
        // be honoured. Clamped to the same range the settings page validates, so a crafted body
        // cannot ask for a 10k-character invoice.
        const asked = Math.round(Number(body.maxChars));
        const [clo, chi] = SUMMARY_CHARS_RANGE;
        const maxChars = Number.isFinite(asked) && asked >= clo && asked <= chi ? asked : cfg.maxChars;
        // Judge "short enough to just read" on what would actually be SPOKEN: voice.ts drops code
        // blocks, and a 20-line diff must not count as a long message worth a model call.
        const spoken = textOf(row.payload).replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
        if (!spoken) return send(res, 409, { error: "这条消息没有可以念的文字", code: "empty" });
        if (spoken.length <= maxChars) {
          return send(res, 200, { ok: true, via: "verbatim", text: spoken, chars: spoken.length, ms: 0, maxChars });
        }
        // Over the ceiling we REFUSE, loudly (#36). The old behaviour summarised the head and said
        // so in a footnote — but a summary that drops the second half is worse than none, because
        // that is where the conclusion lives. 20k chars is far above any reply worth listening to
        // and still stops a pasted 200 KB log from becoming an invoice.
        if (spoken.length > SUMMARY_MAX_INPUT_CHARS) {
          return send(res, 409, {
            error: `这条消息 ${spoken.length} 字，超出语音总结上限 ${SUMMARY_MAX_INPUT_CHARS} 字 —— 直接朗读，或截取要听的那段`,
            code: "too_long",
            chars: spoken.length,
            limit: SUMMARY_MAX_INPUT_CHARS,
          });
        }
        try {
          // The operator's rule: bill this to the model he is already talking to. The voice
          // endpoint stays as the fallback (and is the whole route when followSession is off).
          const own = cfg.followSession ? sessionRoute() : { route: null, why: "" };
          const model = own.route?.model || cfg.model || SUMMARY_MODEL_DEFAULT;
          const r = await summarizeForSpeech({
            text: spoken,
            maxChars,
            prompt: cfg.prompt.trim() || SUMMARY_PROMPT_DEFAULT,
            model,
            timeoutSec: cfg.timeoutSec,
            // Thinking stays ON for qwen3 models, capped at 200 tokens (operator's call, #36):
            // a little reasoning reads the sentence better than none, and 200 keeps it from
            // wandering the way the default 4000 did (measured 235 output tokens on a 40-char ask).
            thinkingBudget: /^qwen3/i.test(model) ? SUMMARY_THINKING_BUDGET : undefined,
            endpoint: own.route ? { baseUrl: own.route.baseUrl, apiKey: own.route.apiKey } : undefined,
          });
          // Newlines are the one thing the model keeps ignoring: 「不要换行」 in the prompt is a
          // request, so the answer is normalised here — the note clamps to two lines and the TTS
          // chunker reads sentence by sentence, and a stray blank line costs both of them.
          const text = r.text.replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
          return send(res, 200, {
            ok: true, via: "model", text, chars: text.length,
            // echo the bucket: the note prints 「约 150 字」 and a summary that silently used the
            // configured number would make the menu look broken
            maxChars,
            ms: r.ms, model,
            // which account this call was billed to — the note prints it, and a fallback that
            // silently used the OTHER provider would be a lie about the cost
            route: own.route ? "session" : "voice",
            provider: own.route?.provider ?? "dashscope",
            routeNote: own.route ? own.route.source : own.why,
          });
        } catch (e) {
          // 409 = nothing is configured, 504 = we gave up waiting, 502 = the endpoint said no.
          // None of them may be papered over with the original text: a fallback that looks like a
          // summary is worse than an honest failure the UI can offer to retry.
          const err = e as { code?: string; message?: string };
          const status = err.code === "not_configured" ? 409 : err.code === "timeout" ? 504 : 502;
          return send(res, status, { error: String(err.message ?? e), code: err.code ?? "upstream" });
        }
      }
      if (req.method === "POST" && sub === "/fork") {
        try {
          // forking a cold session resumes it first (the call has to reach a live agent)
          const info = await mgr.fork(id);
          emit(sessionsEvent());
          return send(res, 200, info);
        } catch (e) {
          const msg = describeAcpError(e);
          if (/no such session|unknown session/.test(msg)) return send(res, 404, { error: msg });
          return send(res, /mid-turn|not ready/.test(msg) ? 409 : 400, { error: msg });
        }
      }
      if (req.method === "POST" && sub === "/model") {
        const body = await readJson(req);
        const modelId = String(body.modelId ?? "").trim();
        if (!modelId) return send(res, 400, { error: "modelId is required" });
        try {
          return send(res, 200, await mgr.setModel(id, modelId));
        } catch (e) {
          const msg = describeAcpError(e);
          // 409: the slot exists but has no live agent to switch (resume first)
          return send(res, /not ready|resume it first/.test(msg) ? 409 : 400, { error: msg });
        }
      }
      if (req.method === "POST" && sub === "/context-limit") {
        const body = await readJson(req);
        const raw = body.limit;
        const limit = raw === null || raw === "" || raw === undefined ? null : Number(raw);
        if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) {
          return send(res, 400, { error: "limit must be a positive number of tokens (or null to clear)" });
        }
        return send(res, 200, mgr.setContextLimit(id, limit, {
          remember: body.remember === true,
          forgetModel: body.forgetModel === true,
        }));
      }
      if (req.method === "POST" && sub === "/mode") {
        const body = await readJson(req);
        await mgr.setMode(id, String(body.modeId));
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && sub === "/cancel") {
        // REST twin of the WS "cancel" command (API symmetry: QA#21 found the
        // endpoint missing, so scripted checks could not stop a turn)
        if (!mgr.hasSession(id)) return send(res, 404, { error: `no such session: ${id}` });
        await mgr.cancel(id);
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && sub === "/permission") {
        const body = await readJson(req);
        const requestId = String(body.requestId ?? "");
        if (!requestId) return send(res, 400, { error: "requestId required" });
        const ok = mgr.respondPermission(id, requestId, (body.decision as PermissionDecision) ?? { outcome: "cancelled" }, {
          optionKind: typeof body.optionKind === "string" ? body.optionKind : undefined,
          signature: typeof body.signature === "string" ? body.signature : undefined,
        });
        if (!ok) return send(res, 404, { error: `no pending permission: ${requestId}` });
        return send(res, 200, { ok: true });
      }
    }
    if (url.pathname === "/api/version" && req.method === "GET") {
      // Which bundle the server is serving RIGHT NOW. A page compares this with the script it
      // actually loaded: a WebView (the Android app) or a tab left open across a deploy keeps
      // running the JS it loaded, and then "the fix isn't there" is indistinguishable from
      // "the fix is broken" — measured, and it cost a whole round.
      let asset: string | null = null;
      try {
        const html = fs.readFileSync(path.join(WEB_DIST, "index.html"), "utf8");
        asset = html.match(/\/assets\/index-([A-Za-z0-9_-]+)\.js/)?.[1] ?? null;
      } catch { /* no build on disk (dev server without dist) */ }
      // …and `dev`: WHICH INSTANCE this is. Only two things in the UI care, and both are about
      // keeping a QA backend out of the operator's way — the mock agent shows up in the new-session
      // form on a dev instance only. The marker is the dev runner's own environment (`DEV_TREE`,
      // written by scripts/dev.sh; also AGENTUS_DEV=1 for a launcher of one's own); the live
      // launcher sets neither, so live answers false. An instance-level fact, so it rides the
      // endpoint that already describes the instance rather than every backend row.
      const dev = Boolean(process.env.DEV_TREE) || process.env.AGENTUS_DEV === "1";
      // `commit`: the code THIS process booted from (see BOOT_COMMIT). It is the only honest answer
      // to "did the release actually land", because the tree can be moved under a running server.
      return send(res, 200, { asset, dev, commit: BOOT_COMMIT });
    }
    if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "not_found" });
    return serveStatic(req, res);
  } catch (err) {
    // "no such X" is a client error, not a server fault (QA#24)
    const msg = String((err as Error)?.message ?? err);
    const code = /no such session|no pending permission/.test(msg) ? 404 : 500;
    return send(res, code, { error: msg });
  }
};

const httpServer = createServer(handleRequest);

// ---- WebSocket ----
// noServer + a manual upgrade hook: the handshake must be authenticated *before*
// it becomes a socket. A browser cannot set headers on a WS handshake, so auth
// rides on the cookie (sent automatically, same-origin) — or ?token= for scripts.
const wss = new WebSocketServer({ noServer: true });
// Bound to the single HTTP listener; this handler reads the cookie / ?token=, never the scheme.
const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const url = new URL(req.url ?? "/", "http://x");
  // The companion's socket carries its own device token in the query — a phone cannot set
  // headers on a handshake any more than a browser can — so it is checked before the
  // operator's cookie/Basic gate.
  if (url.pathname === "/api/notify/ws") {
    notify.handleUpgrade(req, socket, head);
    return;
  }
  // The IDE's own sockets ride the same whitelist step (issue #77 rule 2): HTTP forwarded but upgrade
  // refused is an IDE whose editor never finishes loading, with nothing in the UI to say why.
  if (url.pathname !== "/ws" && url.pathname !== "/ws/term" && url.pathname !== "/ws/asr" && url.pathname !== "/ws/tts" && !ide.ownsPath(url.pathname)) {
    socket.destroy();
    return;
  }
  if (!auth.verifyBasic(req.headers.authorization)) {
    // Same outer lock as HTTP: browsers resend cached Basic credentials on the
    // handshake, so a logged-in browser passes; anything else gets nothing.
    socket.write("HTTP/1.1 401 Unauthorized\r\nwww-authenticate: Basic realm=\"Agentus\"\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!auth.authenticate(req.headers, url)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
    socket.destroy();
    return;
  }
  // Web IDE sockets (issue #77), after the same cookie check the cockpit's own sockets pass — an
  // unauthenticated upgrade gets the 401 above, never a pipe to the IDE.
  if (ide.handleUpgrade(req, socket, head, url)) return;
  if (url.pathname === "/ws/term") {
    termWss.handleUpgrade(req, socket, head, (ws) => termWss.emit("connection", ws, req, url));
    return;
  }
  if (url.pathname === "/ws/asr") {
    asrWss.handleUpgrade(req, socket, head, (ws) => asrWss.emit("connection", ws, req, url));
    return;
  }
  if (url.pathname === "/ws/tts") {
    ttsWss.handleUpgrade(req, socket, head, (ws) => ttsWss.emit("connection", ws, req, url));
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
};
httpServer.on("upgrade", handleUpgrade);
wss.on("connection", (ws) => {
  const clientId = randomUUID().slice(0, 8);
  // Any frame — including a pong — proves the peer is alive (see the heartbeat below).
  (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
  ws.on("pong", () => { (ws as WebSocket & { isAlive?: boolean }).isAlive = true; });
  clients.set(clientId, { ws, lastSeen: new Map() });
  const sendEvt = (e: ServerEvent) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(e));
  };
  sendEvt({ t: "hello", clientId, resumed: false });
  sendEvt(sessionsEvent());

  // One gate per connection: frames on a socket are FIFO, their dispatch is not (issue #74).
  const gate = createFrameGate();
  ws.on("message", async (data) => {
    let cmd: ClientCommand;
    try {
      cmd = JSON.parse(String(data)) as ClientCommand;
    } catch {
      return;
    }
    try {
      switch (cmd.t) {
        case "resume": {
          // AC6: replay missed messages per session after client's lastSeq.
          // `partial: true` tells the client to MERGE into what it already
          // rendered — a rebuild from this tail would drop the pre-drop prefix
          // (QA#17: 26 chars vanished after a mid-turn reconnect).
          //
          // The tail starts a few rows BEFORE the client's lastSeq, because that seq is the last row the
          // client HOLDS, not the last version of it: a streamed reply is folded into one row that keeps
          // its seq, and a tool call's output lands after the call row exists — both GROW after the client
          // last saw them. Re-sending a row the client already has is free (the client re-applies it by
          // identity), while missing the tail of a grown row leaves a bubble frozen mid-sentence.
          const RESUME_OVERLAP = 8;
          for (const [sid, seq] of Object.entries(cmd.lastSeq)) {
            const msgs = store.messagesAfter(sid, Math.max(0, seq - RESUME_OVERLAP) - 1);
            if (msgs.length) sendEvt({ t: "messages", sessionId: sid, messages: msgs, hasMore: false, partial: true });
          }
          sendEvt(sessionsEvent());
          break;
        }
        case "prompt": {
          // Deferred behind the control frames already in flight on this socket FOR THIS SESSION,
          // and not serialized behind other prompts: the agent owns turn order (issue #74).
          const held = gate.afterControl(cmd.sessionId, () => {
            void runPrompt(cmd.sessionId, cmd.text, cmd.attachments ?? [], cmd.interrupt === true, cmd.pid);
          });
          // Held, not lost: the page's ack budget (8s) would otherwise expire while a cold
          // `set_model` is still probing, and it would report a message that IS about to run as
          // "not delivered" — inviting a retry that sends it twice.
          if (held && cmd.pid) sendEvt({ t: "prompt-held", sessionId: cmd.sessionId, pid: cmd.pid });
          break;
        }
        case "cancel":
          await mgr.cancel(cmd.sessionId);
          break;
        case "set-mode":
          await gate.control(cmd.sessionId, () => mgr.setMode(cmd.sessionId, cmd.modeId));
          break;
        case "set-config":
          await gate.control(cmd.sessionId, () => mgr.setConfig(cmd.sessionId, cmd.configId, cmd.value));
          break;
        case "set-model":
          await gate.control(cmd.sessionId, () => mgr.setModel(cmd.sessionId, cmd.modelId, { fromReplay: cmd.fromReplay === true }));
          break;
        case "respond-permission": {
          const applied = mgr.respondPermission(cmd.sessionId, cmd.requestId, cmd.decision, {
            optionKind: cmd.optionKind,
            signature: cmd.signature,
          });
          // The answer reached nobody: the request is gone (our own timeout, or the agent gave
          // up first). Tell the page, so the click has a visible outcome either way.
          if (!applied) sendEvt({ t: "permission-expired", requestId: cmd.requestId, sessionId: cmd.sessionId });
          break;
        }
        default:
          break;
      }
    } catch (e) {
      sendEvt({ t: "error", error: describeAcpError(e) });
    }
  });
  ws.on("close", () => clients.delete(clientId));
});

// ---- liveness: the half-open socket ---------------------------------------------------------
// A TCP connection that dies without a FIN (Wi-Fi switch, laptop sleep, NAT timeout) stays OPEN in
// BOTH ends: the page's `send()` succeeds into the void, and this server keeps a client that will
// never read again. There is no traffic to fail on, so nothing above this line can notice — and the
// operator's message is written into a socket nobody owns, with no bubble and no error (issue #26,
// measured live 2026-10-11 with the network cut). Ping/pong is the only detector the protocol gives
// us: browsers answer `ping` automatically, so a missing pong means the peer is gone.
//
// 20s, not 60s: the window between "socket died" and "page knows" is exactly how long a prompt can
// vanish, and the ack timeout on the client (8s) covers what happens inside one beat. An idle
// cockpit costs 3 tiny frames a minute.
const HEARTBEAT_MS = Number(process.env.AGENTUS_WS_HEARTBEAT_MS ?? "") || 20_000;
const heartbeat = setInterval(() => {
  for (const [id, client] of clients) {
    const ws = client.ws as WebSocket & { isAlive?: boolean };
    if (ws.isAlive === false) {
      // No pong since the last beat: the peer is not there. `terminate()` (not `close()`) because a
      // half-open peer never answers the closing handshake either — this is the only way out.
      ws.terminate();
      clients.delete(id);
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* already gone; the next beat reaps it */ }
  }
}, HEARTBEAT_MS);
heartbeat.unref();


// ---- the workspace panel's terminal -----------------------------------------
// A shell is a stream, so it gets its own socket instead of riding the event bus:
// one socket = one shell, and closing the socket (or the tab) kills the shell.
const termWss = new WebSocketServer({ noServer: true });
termWss.on("connection", (ws: WebSocket, _req: IncomingMessage, url: URL) => {
  const sessionId = url.searchParams.get("sessionId") ?? "";
  const root = sessionRoot(sessionId);
  if (!root) {
    ws.send(JSON.stringify({ t: "term-error", error: `no such session: ${sessionId}` }));
    ws.close();
    return;
  }
  let term: ReturnType<typeof terms.start> | null = null;
  try {
    // The client sends its viewport size on the socket URL: the pty must be born at the right size
    // (the shell reads it when it paints the first prompt). Later changes arrive as term-resize.
    const cols = Number(url.searchParams.get("cols") || 0);
    const rows = Number(url.searchParams.get("rows") || 0);
    term = terms.start(root.path, cols && rows ? { cols, rows } : undefined);
  } catch (e) {
    ws.send(JSON.stringify({ t: "term-error", error: String((e as Error)?.message ?? e) }));
    ws.close();
    return;
  }
  const session = term;
  // ---- backpressure, half two: OUR OWN socket queue ---------------------------
  // The page's watermarks (see ToolPanel's TerminalTab) can only count bytes that REACH it;
  // everything still queued in this process is invisible from there. A slow page plus a fast
  // producer therefore grows node's send queue without bound — measured on a `yes` flood: ~340 MB
  // queued in seconds while the page only ever received ~106 frames/s. So the socket's own backlog
  // is an independent brake, OR-ed with the client's request into one pause state, and the chain it
  // walks back is the same one: stop reading the child -> the pty helper blocks in write(1) -> the
  // shell blocks in write(2).
  const NET_HIGH = 1 << 20; // 1 MiB queued -> stop draining the pty
  const NET_LOW = 256 * 1024;
  let clientPaused = false;
  let socketPaused = false;
  let paused = false;
  const applyPause = (): void => {
    const want = clientPaused || socketPaused;
    if (want === paused) return;
    paused = want;
    if (want) session.pause();
    else session.resume();
  };
  const send = (msg: unknown): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
    if (!socketPaused && ws.bufferedAmount >= NET_HIGH) {
      socketPaused = true;
      applyPause();
    }
  };
  // `ws` emits no drain event for its send queue, so the way back up is a cheap poll that only
  // runs while we are actually holding the pty back.
  const backlogTimer = setInterval(() => {
    if (socketPaused && ws.bufferedAmount <= NET_LOW) {
      socketPaused = false;
      applyPause();
    }
  }, 100);
  // The buffered tail goes out first, so a reconnect (or a second tab) lands on the scrollback the
  // way ttyd's RESUME does instead of a blank screen.
  if (session.buffer) send({ t: "term-data", id: session.id, data: session.buffer });
  send({ t: "term-ready", id: session.id, cwd: session.cwd, pid: session.pid, tty: session.tty });
  const onData = (chunk: string): void => send({ t: "term-data", id: session.id, data: chunk });
  session.subscribers.add(onData);
  session.child.on("exit", () => send({ t: "term-exit", id: session.id }));
  ws.on("message", (data) => {
    let cmd: { t?: string; data?: string; cols?: number; rows?: number };
    try {
      cmd = JSON.parse(String(data));
    } catch {
      return;
    }
    if (cmd.t === "term-input" && typeof cmd.data === "string") {
      try {
        session.child.stdin?.write(cmd.data);
      } catch (e) {
        send({ t: "term-error", error: `write failed: ${String((e as Error)?.message ?? e)}` });
      }
    } else if (cmd.t === "term-resize" && typeof cmd.cols === "number" && typeof cmd.rows === "number") {
      session.resize(cmd.cols, cmd.rows);
    } else if (cmd.t === "term-pause") {
      // The page's emulator fell behind: hold the pty so the backlog cannot grow there instead.
      clientPaused = true;
      applyPause();
    } else if (cmd.t === "term-resume") {
      clientPaused = false;
      applyPause();
    } else if (cmd.t === "term-close") {
      terms.kill(session.id);
      ws.close();
    }
  });
  const cleanup = (): void => {
    clearInterval(backlogTimer);
    session.subscribers.delete(onData);
    terms.kill(session.id);
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
});

// ---- dictation: the streaming ASR path ---------------------------------------
// DashScope's streaming recogniser is a WebSocket that authenticates with a header,
// which a browser cannot set on a handshake — and the key must not leave the server
// anyway. So the browser streams 16 kHz mono PCM to us and we own the upstream socket.
// One socket = one utterance; closing it finalises the task.
const asrWss = new WebSocketServer({ noServer: true });
asrWss.on("connection", (ws: WebSocket, _req: IncomingMessage, url: URL) => {
  const reply = (m: unknown): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };
  const caps = voiceCapabilities().stt as { server?: boolean; streaming?: boolean; model?: string | null };
  if (!caps.streaming) {
    reply({ t: "asr-error", error: "streaming ASR is off (settings: provider \u767e\u70bc + a streaming model)" });
    ws.close();
    return;
  }
  const sessionId = url.searchParams.get("sessionId") || undefined;
  const words = hotwordsFor(store, sessionId);
  let live: ReturnType<typeof openDashscopeStream>;
  try {
    live = openDashscopeStream({
      vocabulary: vocabularyOf(words),
      context: dictationContext(store, sessionId),
      onPartial: (text) => reply({ t: "asr-partial", text }),
      onFinal: (text) => reply({ t: "asr-final", text }),
      onError: (error) => reply({ t: "asr-error", error }),
      onClose: () => {
        reply({ t: "asr-done" });
        // one socket = one utterance: end it here so the browser's next dictation starts
        // from a clean run-task instead of reusing a finished task id.
        setTimeout(() => { try { ws.close(); } catch { /* already gone */ } }, 120);
      },
    });
  } catch (e) {
    reply({ t: "asr-error", error: String((e as Error)?.message ?? e) });
    ws.close();
    return;
  }
  const stream = live;
  void stream.started
    .then(() => reply({
      t: "asr-ready",
      model: caps.model ?? null,
      hotwords: words.slice(0, 12).map((h) => h.word),
      hotwordCount: words.length,
    }))
    .catch((e: unknown) => reply({ t: "asr-error", error: String((e as Error)?.message ?? e) }));
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      stream.sendAudio(Buffer.isBuffer(data) ? data : Buffer.from(data));
      return;
    }
    try {
      const cmd = JSON.parse(String(data)) as { t?: string };
      if (cmd.t === "asr-stop") stream.stop();
    } catch { /* malformed control frame: ignore */ }
  });
  const done = (): void => { try { stream.stop(); } catch { /* already closed */ } };
  ws.on("close", done);
  ws.on("error", done);
});

// ---- narration: the streaming TTS path ----------------------------------------
// The mirror image of dictation above, and it exists for the same reason: the synthesis
// WebSocket authenticates with a header a browser may not set, and the key must stay here.
// The browser sends {say|end|cancel} control frames and receives the audio as BINARY frames
// (s16le mono PCM at `sampleRate`), so it can schedule samples exactly instead of waiting for
// a whole clip and decoding it.
//
// One connection carries a whole reply: its sentences are fed as they arrive, and the browser
// can start playing the first one while the rest is still being generated. `cancel` abandons
// the task upstream (which stops the billing for what has not been generated yet) and leaves
// the connection usable for the next reply — the dial costs 200-650 ms, the task start ~50 ms.
const ttsWss = new WebSocketServer({ noServer: true });
ttsWss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
  const reply = (m: unknown): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };
  const tts = voiceCapabilities().tts as { server?: boolean; streaming?: boolean; sampleRate?: number | null };
  if (!tts.streaming) {
    reply({ t: "tts-error", error: "streaming TTS is off (settings: 百炼 + 流式合成)" });
    ws.close();
    return;
  }
  let conn: DashscopeTtsConnection | null = null;
  let task: ReturnType<DashscopeTtsConnection["runTask"]> | null = null;
  try {
    conn = new DashscopeTtsConnection({
      onClose: (why) => {
        reply({ t: "tts-closed", why });
        try { ws.close(); } catch { /* already gone */ }
      },
    });
  } catch (e) {
    reply({ t: "tts-error", error: String((e as Error)?.message ?? e) });
    ws.close();
    return;
  }
  const live = conn;
  const audio = (pcm: Buffer): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(pcm, { binary: true });
  };
  const handlers = {
    onReady: (format: "pcm", sampleRate: number) => reply({ t: "tts-ready", format, sampleRate }),
    onAudio: audio,
    onSentence: (index: number, text: string) => reply({ t: "tts-sentence", index, text: text.slice(0, 80) }),
    onDone: (characters: number) => reply({ t: "tts-done", characters }),
    // Terminal, not advisory: `#fail` has already closed the upstream socket, and the page only
    // settles a run on `tts-done` or a close. Reporting the error and leaving /ws/tts open left
    // speak() waiting forever — lamp on, no audio, and the documented HTTP fallback never ran.
    // `#fail` closes the connection itself and reports "failed"; closing here first would win the
    // race and leave `tts-closed` saying "closed by caller", which is the opposite of what happened.
    onError: (error: string) => {
      reply({ t: "tts-error", error });
      task = null;
    },
  };
  const start = (rate?: number): void => {
    try {
      task = live.runTask(handlers, { rate });
    } catch (e) {
      // Same invariant as a failed task: report it AND end the bridge. Leaving /ws/tts open after
      // a start we could not honour is the exact shape that stranded the page before.
      reply({ t: "tts-error", error: String((e as Error)?.message ?? e) });
      task = null;
      try { live.close(); } catch { /* already gone */ }
    }
  };
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) return;                        // the browser sends no audio here
    let cmd: { t?: string; text?: string; rate?: number };
    try { cmd = JSON.parse(String(data)) as typeof cmd; } catch { return; }
    if (cmd.t === "tts-start") { start(typeof cmd.rate === "number" ? cmd.rate : undefined); return; }
    if (!task) return;
    if (cmd.t === "tts-say") task.say(String(cmd.text ?? ""));
    else if (cmd.t === "tts-end") task.end();
    else if (cmd.t === "tts-cancel") { task.cancel(); task = null; }
  });
  const done = (): void => {
    try { task?.cancel(); } catch { /* already gone */ }
    task = null;
    try { live.close(); } catch { /* already gone */ }
  };
  ws.on("close", done);
  ws.on("error", done);
});

// ---- graceful exit: SIGTERM children before we die (design.md §8-1) ----
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.log(`[agentus] ${sig}: shutting down sessions`);
    await mgr.shutdown();
    const shells = terms.killAll();
    if (shells) console.log(`[agentus] killed ${shells} terminal shell(s)`);
    store.close();
    process.exit(0);
  });
}

httpServer.listen(PORT, "0.0.0.0", () => {
  installSafetyNet(); // we own the port: from here on, survive per-request errors
  console.log(`[agentus-server] http://0.0.0.0:${PORT} (web dist: ${WEB_DIST})`);
  // Which directory a boot actually opened is the one fact that must never be guessed:
  // a wrong answer here reads as "my sessions are gone" and every other log line is fine.
  console.log(`[agentus-server] data dir: ${DATA_DIR}  (${DATA_DIR_SOURCE})`
    + (DATA_DIR === REPO_DATA_DIR
      ? `\n[agentus-server]   this install defaults to ${DEFAULT_DATA_DIR}; AGENTUS_DATA=${DEFAULT_DATA_DIR} moves it (a new dir starts with an empty session list)`
      : ""));
  // Auth state belongs in the boot log: "is this thing locked, and with which
  // password?" is the first question anyone asks when it is on a LAN.
  if (!authStatus.enabled) {
    console.warn("[agentus-server] ⚠ AGENTUS_AUTH=off — every visitor can drive your agents. Local dev only.");
  } else if (authStatus.usingDefaultPassword) {
    console.warn(
      `[agentus-server] ⚠ auth ON with the DEFAULT password (${auth.AUTH_DEFAULT_USERNAME}/${auth.AUTH_DEFAULT_PASSWORD}). `
      + "Anyone on this network can spawn agents in any directory.\n"
      + "[agentus-server]   set AGENTUS_PASSWORD (or AGENTUS_PASSWORD_HASH) before exposing the port.",
    );
  } else {
    console.log(`[agentus-server] auth on: user "${authStatus.username}", ${Math.round(authStatus.sessionTtlMs / 86400000)}d sessions`);
  }
  if (authStatus.tokenFile) console.log(`[agentus-server] machine token: ${authStatus.tokenFile} (curl -H "Authorization: Bearer $(cat …)")`);
  const basic = auth.basicAuthConfig();
  console.log(basic
    ? `[agentus-server] HTTP Basic ON (user "${basic.user}") — every path, including /healthz and the WS upgrade`
    : "[agentus-server] HTTP Basic off (set AGENTUS_BASIC_AUTH=user:pass before exposing a tunnel)");
  // A wrong/absent dist used to fail silently: the browser's service worker served a stale
  // shell, every request looked fine, and the operator just saw a blank page (QA R36).
  // Say it out loud at boot instead.
  if (!fs.existsSync(path.join(WEB_DIST, "index.html"))) {
    console.error(
      `[agentus-server] ⚠ web build missing at ${WEB_DIST} — the UI will 404 (API still works).\n`
      + (fs.existsSync(path.resolve(HERE, "../../web/src"))
        ? `[agentus-server]   build it with:  NODE_ENV=development npm run build -w @agentus/web`
        : `[agentus-server]   this package looks damaged (no prebuilt bundle) — reinstall it:  npm i -g agentus@latest`),
    );
  }
});
httpServer.on("error", (err) => {
  console.error(`[agentus] cannot listen on ${PORT}: ${(err as Error).message}`);
  process.exit(1); // fail fast: never linger as a listener-less zombie
});
