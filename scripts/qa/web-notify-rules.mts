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
  chimeIsDouble,
  sessionIdOf,
  shouldChime,
  shouldDrawNotice,
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

// ---- drawing: every condition the page can check, and the one it must not skip
check("a granted, enabled, backgrounded tab draws", shouldDrawNotice(gate()));
check("a FOREGROUND tab does not (the page is the notification)", !shouldDrawNotice(gate({ hidden: false })));
check("permission not granted ⇒ nothing", !shouldDrawNotice(gate({ permission: "default" })));
check("permission denied ⇒ nothing", !shouldDrawNotice(gate({ permission: "denied" })));
check("the device's own switch off ⇒ nothing", !shouldDrawNotice(gate({ enabled: false })));
check("no Notification API (Android WebView) ⇒ nothing", !shouldDrawNotice(gate({ available: false })));
check("an insecure origin (http://LAN-IP) ⇒ nothing", !shouldDrawNotice(gate({ available: false })));

// ---- sound: three ways to decide not to make a noise, and one to decide to
const prefs = (over: Partial<WebNotifyPrefs> = {}): WebNotifyPrefs => ({ ...WEB_NOTIFY_DEFAULT, sound: "chime", ...over });
check("chosen chime + real event ⇒ chime", shouldChime(prefs(), "agent_done", false));
check("an approval gets one too", shouldChime(prefs(), "approval", false));
check("a failed turn gets one", shouldChime(prefs(), "error", false));
check("a 「运行中」 status line never chimes", !shouldChime(prefs(), "agent_running", false));
check("silent means silent", !shouldChime(prefs({ sound: "silent" }), "agent_done", false));
check("the platform's own tone is not ours to add to", !shouldChime(prefs({ sound: "default" }), "agent_done", false));
check("a live call mutes the chime (the mic is open)", !shouldChime(prefs(), "agent_done", true));
check("…even for an approval", !shouldChime(prefs(), "approval", true));

// ---- the two chimes: a decision waiting on a human is worth more than a finished turn
check("an approval is the two-tone chime", chimeIsDouble("approval"));
check("a finished turn is the single tone", !chimeIsDouble("agent_done"));

// ---- the tap target: the same `?session=` the phone's card carries
check("session id is read off the notice's open target", sessionIdOf("/?session=abc123") === "abc123");
check("…absolute or relative, same answer", sessionIdOf("http://127.0.0.1:8901/?session=abc123&x=1") === "abc123");
check("no session in the target ⇒ null (then the URL is followed instead)", sessionIdOf("/") === null);
check("a malformed target does not throw", sessionIdOf("::::") === null);

// ---- defaults: on, and quiet until the operator asks for something else
check("defaults: the channel is on", WEB_NOTIFY_DEFAULT.on);
check("defaults: the platform's own tone (nobody gets a surprise chime)", WEB_NOTIFY_DEFAULT.sound === "default");

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
