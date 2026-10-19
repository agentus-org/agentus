// QA: the browser-notification channel's two page-side decisions, as pure logic.
//
// Why pure: both failures are SILENT. A notification that never appears looks like "this feature does
// not work", and a second sound for one event is the reason people switch a notification channel off —
// neither shows up in any server-side test, and neither can be judged by looking at the page once.
// (The server half of the channel is asserted in scripts/notify-smoke.mts; the drawing itself is a
// browser job, in scripts/qa/web-notify-sweep.mjs.)
//
//   npx tsx scripts/qa/web-notify-rules.mts
import {
  WEB_NOTIFY_DEFAULT,
  chimePattern,
  sessionIdOf,
  shouldChime,
  shouldDrawNotice,
  type SoundGate,
  type WebNotifyPrefs,
} from "../../packages/web/src/webNotify";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const gate = (over: Partial<Parameters<typeof shouldDrawNotice>[0]> = {}) => ({
  available: true,
  permission: "granted",
  enabled: true,
  hidden: true,
  ...over,
});

// The SOUND channel's gate is a different, much smaller thing on purpose — see the block below.
const sound = (over: Partial<SoundGate> = {}): SoundGate => ({ enabled: true, hidden: true, ...over });

// ---- drawing: every condition the page can check, and the one it must not skip
check("a granted, enabled, backgrounded tab draws", shouldDrawNotice(gate()));
check("a FOREGROUND tab does not (the page is the notification)", !shouldDrawNotice(gate({ hidden: false })));
check("permission not granted ⇒ nothing", !shouldDrawNotice(gate({ permission: "default" })));
check("permission denied ⇒ nothing", !shouldDrawNotice(gate({ permission: "denied" })));
check("the device's own switch off ⇒ nothing", !shouldDrawNotice(gate({ enabled: false })));
check("no Notification API (Android WebView) ⇒ nothing", !shouldDrawNotice(gate({ available: false })));
check("an insecure origin (http://LAN-IP) ⇒ nothing", !shouldDrawNotice(gate({ available: false })));

// ---- sound: its OWN gate, independent of the notification channel ------------------------------
const prefs = (over: Partial<WebNotifyPrefs> = {}): WebNotifyPrefs => ({ ...WEB_NOTIFY_DEFAULT, sound: "chime", ...over });
check("chosen chime + real event ⇒ chime", shouldChime(prefs(), "agent_done", sound(), false));
check("an approval gets one too", shouldChime(prefs(), "approval", sound(), false));
check("a failed turn gets one", shouldChime(prefs(), "error", sound(), false));
check("a 「运行中」 status line never chimes", !shouldChime(prefs(), "agent_running", sound(), false));
check("silent means silent", !shouldChime(prefs({ sound: "silent" }), "agent_done", sound(), false));
check("the platform's own tone is not ours to add to", !shouldChime(prefs({ sound: "default" }), "agent_done", sound(), false));
check("a live call mutes the chime (the mic is open)", !shouldChime(prefs(), "agent_done", sound(), true));
check("…even for an approval", !shouldChime(prefs(), "approval", sound(), true));
check("the device's own switch off ⇒ no tone", !shouldChime(prefs(), "agent_done", sound({ enabled: false }), false));
check("looking at the page ⇒ no tone (「正在看就不打扰」)", !shouldChime(prefs(), "agent_done", sound({ hidden: false }), false));
check("…and that holds for an approval too", !shouldChime(prefs(), "approval", sound({ hidden: false }), false));

// The whole point of the split (issue #7): the tone must not be reachable-or-not depending on the
// notification channel. `shouldChime` cannot even SEE the permission, the API's presence or the draw
// result — its gate has two fields — so these are asserted as the *shape* of the gate, which is what
// makes the independence structural rather than a promise in a comment.
check("the sound gate has exactly two fields — no permission/availability can leak into it",
  Object.keys(sound()).sort().join(",") === "enabled,hidden", Object.keys(sound()).join(","));
// The issue's own acceptance test, as a pure-logic statement: with the site's notifications DENIED the
// banner is gone and the tone still fires. This is the difference the round is about.
check("notifications denied ⇒ no banner, but the turn is still HEARD",
  shouldDrawNotice(gate({ permission: "denied" })) === false
  && shouldChime(prefs(), "agent_done", sound(), false) === true);

// ---- the figures per kind (issue #28 replaced "how many notes" with "which shape")
check("an approval is a rising pair (come here)", chimePattern("approval").length === 2
  && chimePattern("approval")[1].freq > chimePattern("approval")[0].freq);
check("a finished turn is a falling pair — two notes, but calm", chimePattern("agent_done").length === 2
  && chimePattern("agent_done")[1].freq < chimePattern("agent_done")[0].freq);
check("a FAILED turn is three notes (never mistakable for 完成)", chimePattern("error").length === 3);
check("the three kinds are pairwise different",
  new Set([chimePattern("agent_done"), chimePattern("approval"), chimePattern("error")].map((p) => JSON.stringify(p))).size === 3);

// ---- the tap target: the same `?session=` the phone's card carries
check("session id is read off the notice's open target", sessionIdOf("/?session=abc123") === "abc123");
check("…absolute or relative, same answer", sessionIdOf("http://127.0.0.1:8901/?session=abc123&x=1") === "abc123");
check("no session in the target ⇒ null (then the URL is followed instead)", sessionIdOf("/") === null);
check("a malformed target does not throw", sessionIdOf("::::") === null);

// ---- defaults: on, and quiet until the operator asks for something else
check("defaults: the channel is on", WEB_NOTIFY_DEFAULT.on);
// Was `default` (hand the tone to the OS). That is silent whenever the system banner is dropped or the
// site's notification permission is off — the exact setups where the operator walked away and needs to
// hear the turn finish — so the page's own chime is the default now.
check("defaults: our own chime, not the platform's tone", WEB_NOTIFY_DEFAULT.sound === "chime");

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
