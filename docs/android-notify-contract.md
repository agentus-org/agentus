# Notify channel contract (v0.2, as built)

The interface between an Agentus server and a phone app, designed so that **adding a
notification or an interaction never requires a new APK**.

| Piece | Where |
|---|---|
| Server side (pairing, fan-out, cursors, callbacks, ACP→activity mapping) | `packages/server/src/notify/{types,center}.ts` |
| Standalone test bed (same code, own ports) | `scripts/notify-testbed.mts` |
| Contract smoke test (real HTTP + real WS) | `scripts/notify-smoke.mts` → `npm run notify-smoke` |
| Android client | `android/` (see `android/README.md`) |

Design record and the decision trail: workspace `tasks/20261001-agentus/track.md` §34 and
`android-notify-contract.md` (v0.1 draft).

---

## 1. Shape: the contract is server ↔ app, not page ↔ app

- **Server = the only source of truth.** Activities are derived from the *same* `ServerEvent`
  stream the browser already receives (`emit()` in `index.ts`), so "what is happening" has one
  definition.
- **App = a generic renderer.** It draws `title/progress/actions/input/deeplink` and interprets
  nothing.
- **Phone behind NAT ⇒ the phone opens the socket.** The server can only push back over a
  connection the phone itself keeps open. One websocket, held by a foreground service.
- **A page cannot notify.** It cannot outlive its own tab, and a WebView has neither
  `Notification` nor `PushManager`. The web UI's job is to *configure* and *preview*; the path
  is always page → server → phone.

## 2. Contract A — pairing

```http
POST /api/notify/pair          # no operator session needed: this is how a phone gets one
{ "code": "L84JRD5W",          # rotating 8-char code (or null + operator credential)
  "deviceName": "Xiaomi 15", "platform": "android", "sdkInt": 36,
  "appVersion": "0.1.0", "schema": 1,
  "capabilities": ["progress","actions","remote_input","channels","deeplink","live_update"] }

200 { "deviceId": "dev_7f3a…", "deviceToken": "…", "baseUrl": "https://host:port",
      "wsUrl": "wss://host:port/api/notify/ws", "serverTime": 1791110000 }
```

- The code is accepted only from `GET /api/notify/pair-code` (operator credential) and is
  brute-force limited (10 tries / 10 min / IP). Re-pairing with the same device name replaces
  the old row.
- `capabilities` is **the only version switch**. The server never compares `appVersion`.
- Device tokens are per device, revocable (`POST /api/notify/devices/revoke`).

## 3. Contract B — ActivityObject (server → app, over the socket)

```json
{ "schema": 1, "op": "upsert", "activityId": "perm:req_9", "revision": 1,
  "kind": "approval", "priority": "high", "ongoing": true, "promotable": true,
  "title": "待你确认：写文件", "body": "会话名 · /etc/hosts",
  "progress": { "value": 0.6, "segments": [ { "length": 6, "color": "#4f8" } ] },
  "channel": { "id": "agent_approval", "name": "权限请求", "importance": "high", "sound": true },
  "actions": [ { "id": "allow_once", "label": "仅此次", "style": "primary" } ],
  "input": { "enabled": true, "placeholder": "或直接回一句" },
  "visibility": "private", "smallIcon": "agentus",
  "open": { "url": "/?session=…", "prefer": "app" },   // §5.2; `deeplink` stays as its old alias
  "deeplink": "/?session=…" }
```

Rules that make the "no new APK" promise hold:

- `op` ∈ `upsert | dismiss | clear_all`; every op is idempotent on `activityId + revision`.
- A **dismissal carries no title** — the route validates accordingly.
- **The server defines channels** (`channel.id/name/importance/sound/vibration`); the app creates
  them on demand. Changing importance or sound is therefore a server-side change.
- Unknown fields/actions/ops must be ignored by the app, never fatal.
- `revision` guards ordering; the app drops anything at or below the cursor it already applied.
- **`title` says what happened; `body` carries `<会话名> · <detail>`; `subtitle` stays unused.**
  Android draws `contentText` (our `body`) on the **collapsed** row and `subText` (our `subtitle`) only
  on the **expanded** card, so a name parked in subtitle is a name the operator never sees when they
  glance at the shade — measured, §11.1.7. One shape for every kind: 运行中 / 已完成 / 执行失败 /
  待你确认：<工具>.
- **No protocol tokens on a card.** The completion line is 「用时 1m12s」 (the real turn duration,
  `turn-end.durationMs`), never `stopReason: end_turn` — a card is read by a human, not a debugger.
  An approval splits the agent's own tool title (`Approve edit: /var/…` → title `待你确认：Approve edit`,
  body `… · /var/…`) so neither the state line nor the target has to be guessed at.
- Frames carry a monotonic `seq`; the app acks with `{t:"ack",cursor:N}` and reconnects with
  `?since=N`, so a lock screen that missed an hour still learns the outcome.

## 4. Contract C — the button callback (app → server)

```http
POST /api/notify/actions            # device token (Bearer)
{ "activityId": "perm:req_9", "revision": 1, "actionId": "allow_once",
  "input": null, "ts": 1791110000 }
200 { "ok": true, "note": "received" }
```

- 200 means *received*: the result comes back later as a new ActivityObject (`permission-resolved`
  ⇒ the app dismisses the card).
- **Replay guard:** the same `(activityId, actionId)` fires once; a second attempt is `409`.
  Re-publishing the activity re-arms its buttons. (This replaced the nonce idea from v0.1 —
  idempotency at the server is easier to get right than a nonce the app must store.)
- Unknown activity or unknown action ⇒ `409`; bad token ⇒ `401`.
- Server side, an interaction is one row: `actionRefs[actionId] = { type, … }` handed to
  `NotifyCenter.onAction`. In the cockpit that handler is `notify.onAction(...)` in `index.ts`
  (`ref.type === "permission"` → `mgr.respondPermission(sessionId, requestId, {outcome:"selected",
  optionId})`; `"open"` → nothing to do, the app already navigated). **The lock screen can answer an
  agent's permission prompt** — and that is verified live, not just in theory (§11).

## 5. Contract D — the page-side half (built, without a native bridge)

The web cockpit is a first-class participant, and it needed no JS bridge at all — it talks to the
same HTTP surface the app does:

| The cockpit does | Endpoint | Why it is not a "bridge" |
|---|---|---|
| shows the pairing string, device list, APK size | `GET /api/notify/settings` | read-only projection of server state |
| edits the push rules | `POST /api/notify/settings` | server-side state, so a rule change needs **no APK rebuild** |
| says which session is on screen (30s keep-alive) | `POST /api/notify/presence` | drives the "quiet while I am watching" rule |
| pushes the current session to the phone | `POST /api/notify/push` | one activity through the same `publish()` |
| sends one island-shaped frame down one promotion path | `POST /api/notify/push` with `{kind:"island", path:"aosp"｜"xiaomi"}` | the same route; `path` is a contract field (§6), not a test hook |

Notifications still need **no** JS bridge, and that has not changed. The one bridge the app does inject is
for the microphone: `window.AgentusMic` (`available()` / `start(rate)` / `stop()`), which the page uses
**instead of** `getUserMedia` when the WebView's own capture refuses to start (see §11.1.5). It is gated:
the app only allows it while the loaded page is one of the operator's saved servers, so a page that ends
up in the WebView cannot quietly record. A `window.AgentusNative.publish()` bridge for foreground-only
niceties stays reserved and unused; nothing depends on it, and the app still decides nothing on the
page's behalf.

### 5.1 The rules, and the one deliberate asymmetry

| Rule | Off ⇒ | While the operator is watching that session | While a VOICE CALL is up on that session |
|---|---|---|---|
| `turnStart` | no "running" card at all | suppressed (a card for the page in front of me is noise) | suppressed (same) |
| `completion` | no done/failed notification | suppressed | suppressed — the call is already reading that reply out loud |
| `approval` | no approval notification | **never suppressed** — a decision waiting on a human is the whole reason the phone is in the loop | **never suppressed** either, but delivered **silently** |
| `quietWhenWatching` | presence is ignored entirely | — | — (a call implies watching) |

Two details that are easy to get wrong and are therefore explicit here:

- the `dismiss` of the running card on turn-end is **unconditional**, even when that turn-start was
  suppressed — otherwise the phone keeps a zombie "still running" card forever;
- presence is **in-memory with a 90s TTL**, never persisted: "who is looking" is a fact about right
  now, and a stale one that survived a restart would silently silence the phone.

#### 5.1.1 A call is not "watching" — it is stricter, and it is reported as such

The operator reported this from a real call: the turn ended, the call read the answer out loud, and the
phone **dinged** with a 「跑完了」 card. Two independent causes, both fixed server-side:

1. `completion` was persisted but **never read** — the 完成 switch did nothing, and presence was only
   consulted for `turnStart`, so the done card fired even while the operator watched that very session.
2. **A call is not "watching".** "Watching" needs an interaction within 120s (`presence.ts`), and on a
   call the hands are free — presence went stale mid-conversation and the phone started notifying again.

So presence carries an explicit `call: boolean` (page-reported, written the moment `CallMode` mounts and
cleared when it hangs up, not on the next 30s tick). The server then:

- counts a call as watching for that session (no duplicate cards), and
- **sends everything else silently**: the frame is never dropped (the operator must be able to see and
  act on it), but its channel loses sound and vibration and drops to low importance.

Silence is not cosmetic here. The call's capture is the **native bridge** (`AudioRecord`, §11.1.5) with no
echo cancellation, so a notification tone played on the phone's speaker is recorded by the very
microphone the agent is listening on — the workaround for one bug would otherwise feed the other.

"What I am watching" is deliberately **not** just "the tab is visible" (`packages/web/src/presence.ts`):
it also requires an interaction (pointer/key/wheel/touch) within 120s, because a laptop left open with
the cockpit on screen is nobody watching — and calling that "watching" would swallow exactly the
notifications the phone is there for. The page reports every 30s while alive; the "I am leaving" write
on navigate-away is best-effort (a cross-origin unload drops it), which is fine precisely because the
90s TTL, not that write, is what guarantees a stale presence cannot keep the phone silent.

### 5.2 The tap target, in the abstract (`open`): the sender names the destination, the device keeps the policy

The operator caught the first version of this: 「消息提醒打开后为什么是浏览器呀？应该打开我们应用，然后对应的会话」.
It was right, and it was a contract bug, not an Android bug: the activity carried a bare `deeplink`, the app
turned it into an implicit `ACTION_VIEW` on an `https://` URL, and the system handed it to whatever browser
claims http(s). Nothing in that chain ever said "this belongs to *our* app, and to *this* session".

**The sender must not decide where a tap lands, and the receiver must not have to guess.** So the activity
carries a target object:

```jsonc
"open": {
  "url": "https://host:port/?session=57f078d2",   // absolute, or relative to the server it came from
  "prefer": "app"                                  // "app" | "web" | "auto" (default)
}
```

- `url` may be **relative** (`/?session=<id>`): a self-hosted server that sits behind a tunnel does not
  know its own public address, and the one party that *does* is the app holding the connection. A receiver
  resolves a relative url against the server the activity arrived from, and uses an absolute one as-is.
- `prefer` is a **hint about the sender's intent**, never a command:
  - `app` — the sender asserts an app on this device handles this URL (our cockpit);
  - `web` — always hand it to the platform's web handler (a third-party sender pushing a plain link);
  - `auto` (default) — the receiver's own rule, spelled out below.

**The receiver's policy** (the only party that knows what is installed and which origins it trusts):

| `prefer` | url origin is one of MY saved servers | url origin is foreign |
|---|---|---|
| `app` | explicit intent into this app, which then opens the page and the session | **not** this app — hand it to the platform (chooser) |
| `web` | the platform's web handler (the app deliberately declines) | the platform's web handler |
| `auto` | same as `app` | the platform's web handler |
| *(no `open`, no `deeplink`)* | tapping only brings the app to the front | — |

The allow-list is the security boundary, and it is why "the sender decides" alone would be wrong: this app's
WebView holds an **authenticated** cockpit session. If a payload could name an arbitrary target for in-app
navigation, any sender — today our own server, tomorrow somebody's webhook — would gain a navigation
primitive inside the operator's session. A foreign origin is therefore never rendered inside the app; it
goes to the platform, where the user (not the payload) chooses. Implementation:
`Notifier.openFor()` / `ownOrigin()` (Android), with the cockpit-side half being `?session=<id>` on the
web app (`packages/web/src/state.ts#openTarget`), read once and then dropped from the URL so a later
reconnect cannot override the operator's own choice of session.

`deeplink` remains emitted as an alias (`openFor()` in `center.ts` writes both from one place so they can
never disagree) purely so an app built before `open` keeps a working tap; one capability (`deeplink`) gates
both spellings. It goes away once no such app is in the field.

**Where this is going for third parties** (the reason this is worth abstracting now): the same activity
object, pushed by anyone. Today the sender is our own server; the missing pieces for a webhook sender are
(a) a per-sender token + a `source` label so several systems can push into the same app without sharing the
operator's credentials, and (b) the reverse direction — Agentus POSTing its own events out to a URL. With
`open` in place, (a) needs no change to the renderer or the tap policy: a sender that has never heard of
Agentus sends `{title, body, open: {url, prefer: "web"}}` and gets exactly the behaviour it expects.

## 6. Degradation: the server gates on capabilities, the app tries and falls back

| Reported capability missing | The server sends | The app does |
|---|---|---|
| `progress` | `progress: null` | plain ongoing notification, no bar |
| `actions` | `actions: []` | tappable card only (deeplink) |
| `remote_input` | `input: null` | no inline reply |
| `channels` | `channel: null` | the default Agentus channel |
| `icon_url` | `iconUrl: null` | (v0.1 does not claim it: no download implemented) |
| `live_update` | `promotable: false` | — |
| `xiaomi_focus` | `promotable: false` | — (Xiaomi's own island, see below) |

Independently, on the device: API < 36, or the user switched Live Updates off, or the promotion
is refused ⇒ **silently** the same notification is posted as a normal ongoing one.

The two island paths are probed on the device, never assumed, and **the vendor one is asked first**:

| Order | Path | When | Guard |
|---|---|---|---|
| 1 | Xiaomi HyperOS 焦点通知/超级岛 (`notification.extras["miui.focus.param"]`) | any HyperOS/MIUI; **the payload depends on the ROM's generation** — OS2 (protocol 2) takes `ticker`/`aodTitle`/`baseInfo`/`hintInfo`, OS3 (protocol 3) adds the island node `param_island` (`islandProperty` + `smallIslandArea` + `bigIslandArea{imageTextInfoLeft, imageTextInfoRight{textInfo}}`) | `content://miui.statusbar.notification.public` → `canShowFocus`; generation from `Settings.System["notification_focus_protocol"]` (0/1/2/3) and `persist.sys.feature.island` |
| 2 | AOSP promoted (`POST_PROMOTED_NOTIFICATIONS`, `ProgressStyle`, `setRequestPromotedOngoing`) | `sdkInt >= 36` **and path 1 declined** | `LiveUpdate.available()` + the user's system switch |

Two traps cost a round each, and both fail **silently** (no exception, no log on the system side, just
"nothing happens"):

1. **Sending one generation's template to the other.** The island node only exists from OS3 on; OS2's
   SystemUI has no template for it. Pick the template from the ROM's reported protocol, not from
   `Build.VERSION`.
2. **A field name that looked like the docs.** The 大岛 slot's text node is `textInfo`; an earlier build
   wrote `miui.focus.paramtextInfo`, which is what the published guide renders when `miui.focus.param`
   (the extras key) sits immediately before `textInfo` in a table cell. Cross-checked against a
   community SDK that actually runs on the OS (`HyperNotification`'s Kotlin models).

Why the order is part of the logic, not a detail: on a Xiaomi phone the island *is* the vendor
feature. Asking AOSP first (as v0.3.2 did) handed HyperOS a promoted notification it does not render
as an island — the notification looked fine and simply never appeared at the top. One path owns the
notification, and the app's log says which one.

**`path` overrides the order, and that is how the unanswerable question gets answered.** The order above
cannot tell whether HyperOS 3 renders Android 16's *own* Live Update — it never asks. So an activity may
carry `path: "aosp"` (vendor call skipped) or `path: "xiaomi"` (AOSP call skipped); anything else keeps
the order. It is a plain field on the activity object, so the cockpit can send one frame down each path
from 设置 → 手机通知 → 试上岛 (自动通道 / 原生实时动态 / 小米岛) and the app's 「原生实时动态」 button does
the same locally without a server. The point of putting it in the contract rather than in a test build:
"does this phone show the island" is now a button, not an APK.

### 6.1 Xiaomi's island is whitelist-only, and the app says so instead of pretending

焦点通知/超级岛 is **not a permission an app can request**. Xiaomi grants it per app on review
(apply by mail — app name/package/appid, channel, scenario description; the enterprise route also
wants a company entity), and the OS enables it platform-side. Until then `canShowFocus` answers
false and the island never appears — while the ordinary notification keeps working
(`param_v2.filterWhenNoPermission` defaults to false, i.e. nothing is filtered). Consequences:

- The app never guesses: `XiaomiFocus.canShowFocus` gates the param blob, and `xiaomi_focus` is
  reported as a capability **only when true** (same for `live_update`: it now requires
  `canPostPromotedNotifications()`, not merely `sdkInt >= 36`).
- 「上岛自检」 posts a real ongoing/promotable notification through the real renderer, prints the
  full device diagnosis (model, Android release, HyperOS version, `canShowFocus`, a probe of the
  SystemUI methods, AOSP availability) into the app log, ticks for 12 s and cleans up.
- Where the honest fallback is: an ordinary ongoing notification with progress still shows in the
  shade, lock screen and AOD. To force an island on a phone Xiaomi has not granted, the only route is
  a rooted device with an island module (e.g. the `io.github.hyperisland` LSPosed module, which
  re-renders any app's notifications as 超级岛).

As built, the app reports: `progress, actions, remote_input, channels, deeplink`
(+ `live_update` when API ≥ 36 *and* the platform would promote; + `xiaomi_focus` when HyperOS
grants focus permission).

## 7. Version policy

1. This file only grows: add fields, never repurpose them.
2. Clients ignore what they do not know.
3. New behaviour ⇒ new capability string, not a version comparison.
4. Every op idempotent; nothing assumes messages arrive (replay by cursor instead).
5. An APK rebuild is needed only for (a) a new Android platform API, (b) a capability that
   only native code can provide (widgets, shortcuts), or (c) a defect **in the native renderer** —
   copy, wording and field mapping are server-side and must never require a rebuild, but a renderer
   bug ships as a new APK (§11.1.7 is the worked example: an action with a `RemoteInput` needs a
   mutable `PendingIntent`, and the card it dropped was the approval one).

## 8. What the native side has to own

| # | Native surface | As built (v0.1) |
|---|---|---|
| 1 | Background connection (WS + cursor + backoff + FGS) | ✅ `NotifyService`, `specialUse` FGS, network callback, 2s→60s backoff |
| 2 | Notification renderer (channels on demand, icons, idempotent upsert) | ✅ `Notifier` + `LiveUpdate` (API 36 promotion) |
| 3 | Action callback (receiver + WorkManager-class durability) | ✅ `ActionReceiver` via `goAsync()` + inline reply |
| 4 | Open the cockpit | ✅ deeplink → browser (`ACTION_VIEW`) |
| 5 | Permission guidance (notifications, Live Updates, battery) | ⚠️ notifications + the Live Update settings intent; battery-optimisation prompt still missing |
| 6 | Device registration + token storage | ⚠️ pairing done (code, machine token, or username+password); token in app-private prefs, not the Keystore |
| 7 | Saved servers (multiple, switchable, password kept) | ✅ `Profiles` + `SecretBox` (AES-256/GCM, Android Keystore) — switching is one tap and re-pairs itself if the token was revoked |
| 8 | Vendor island (Xiaomi HyperOS 焦点通知/超级岛) | ✅ `XiaomiFocus` — `miui.focus.param` + `canShowFocus` probe; capability reported only when the OS grants it |
| 9 | Foldable layout (fold/unfold without losing the form) | ✅ `resizeableActivity` + continuity meta-data + `onSaveInstanceState`; two panes at ≥ 720dp, one below |
| 10 | The cockpit itself, in the app | ✅ a plain `WebView` on the active server, and the app **opens there**; the server list + notification settings sit behind the toolbar's 服务器 button |
| 11 | An answer to "can this phone show the island at all" | ✅ 「上岛自检」: posts a real ongoing/promotable notification through the real renderer, logs the full device diagnosis, ticks 12 s, cleans up |
| 12 | Keyboard must shrink the page, not sit on top of it | ✅ ime() inset folded into the root padding (see P13) |
| 13 | The page's microphone (dictation / call mode) | ✅ two gates, both closed — `PermissionRequest` granted in `onPermissionRequest` **and** the app's own `RECORD_AUDIO` runtime grant (the held request is granted once the system dialog is allowed), plus a warning when the address is http, where `getUserMedia` does not exist at all |

## 9. Android constraints this design answers

| # | Constraint | Handling |
|---|---|---|
| P1 | Android 15 caps `dataSync` FGS at 6h/24h | `specialUse` + `FOREGROUND_SERVICE_SPECIAL_USE`, with the reason declared in `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` |
| P2 | `POST_NOTIFICATIONS` is runtime; Live Updates are a user switch | app asks on first run, and offers a button straight to `MANAGE_APP_PROMOTED_NOTIFICATIONS` |
| P3 | Aggressive OEM background kills | exponential backoff + cursor replay (so being killed only delays, never loses) |
| P4 | Android 7+ ignores user-installed CAs; the server cert is a self-signed DDNS leaf | `res/raw/agentus_ca.pem` + a composite trust manager (system ∪ our root) and a waived hostname **for that root** |
| P5 | Cleartext is blocked since Android 9 | `network_security_config`: cleartext only for LAN test addresses, everything else https/wss |
| P6 | Locked screen loses events | monotonic `seq` + `?since=` + ack (verified in the smoke test) |
| P7 | The cockpit had no notification concept | activity centre derives activities from the existing event stream |
| P8 | A notification button is a remote execution path | device token per device + single-use action + `visibility: private` + `VISIBILITY_PRIVATE`; the LAN/pin design keeps the transport from leaking a bearer token in clear |
| P9 | Streaming agents update constantly | the server throttles/decides; `revision` + `setOnlyAlertOnce` keep updates from re-alerting |
| P10 | Distribution | one static URL (`/agentus-companion.apk` on the cockpit, `/dl/…` on the test bed), **behind the operator login** — a phone-pairing page and an installable APK are not public material; schema compatibility keeps rebuilds rare |
| P11 | Xiaomi HyperOS ignores an app's `configChanges` and force-relaunches the activity on fold/unfold | do not fight it: declare `resizeableActivity` + continuity meta-data, accept the recreate, restore the half-typed form from `onSaveInstanceState`, and derive the layout from the current `screenWidthDp` |
| P12 | The vendor island is gated by a HyperOS-side permission that has no runtime API | probe `canShowFocus`; attach `miui.focus.param` only when it says yes; report the outcome as a capability and in the UI instead of silently doing nothing (Xiaomi grants it per app on review — see §6.1) |
| P13 | Since Android 15 / targetSdk 35, `windowSoftInputMode="adjustResize"` no longer resizes the window when the keyboard appears | handle `WindowInsets.Type.ime()` in the same listener that handles the system bars and pad the root by `max(bars, ime)` — padding the root is what makes a WebView (and any form) genuinely shrink, instead of the keyboard covering the page (verified: WebView 1688 px → 848 px → 1688 px around the IME on the emulator) |
| P14 | A page in a WebView needs TWO microphone gates, and denying the page to ask the system guarantees the first press fails | grant the `PermissionRequest` **and** hold the app's own `RECORD_AUDIO`; never `deny()` first — hold the request and grant that same object once the system dialog is allowed (`NotReadableError: Could not start audio source` is what a missing app-side grant looks like, not a "permission denied") |
| P15 | `getUserMedia` only exists in a secure context | an `http://<LAN-IP>` address has no `navigator.mediaDevices` at all (measured in the WebView: the page reports none), so voice needs the https address or `localhost`; the app states this in its own status panel instead of letting the page fail cryptically |
| P16 | The WebView's own capture can refuse to start even when every gate is green (secure origin, `RECORD_AUDIO` granted, 18/18 page requests granted) | this is Chromium's pipeline, not the app's permissions. Two answers, in order: declare `MODIFY_AUDIO_SETTINGS` (Chromium's audio input switches the AudioManager mode before it opens the source, and several reports of this exact error name that permission as the fix), and give the page a native `AudioRecord` bridge to fall back on — the app can record where the WebView cannot (see §11.1.5) |
| P17 | A `@JavascriptInterface` method runs on the JavaBridge thread, and any WebView call from there throws | never touch the `WebView` inside the bridge: compute what it needs on the UI thread (`onPageStarted` / `onPageFinished`) and only read a `volatile` flag there. Also wrap the whole method body — an escaping `RuntimeException` reaches the page as the useless `Java exception was raised during method invocation`, and wrap every frame-posting loop in a log, or "0 frames arrived" has no cause anywhere |
| P18 | `View.post()` on a DETACHED view queues the runnable until the view is attached | the app shows its config screen by detaching the WebView on purpose (so going back does not reload the cockpit), which silently starved the microphone bridge: `送出帧=60 · 收到帧=0`. Post to `new Handler(Looper.getMainLooper())` instead, and keep **two** counters ("sent" and "received") — they are different bugs |
| P19 | A notification channel's sound and importance are **immutable after creation** (Android 8+), and the app deliberately returns early for an existing channel id | "send the same channel with `sound:false`" is a silent no-op: the phone keeps dinging. A muted frame therefore carries `channel.muted: true` and the app routes it to **one** dedicated quiet channel (`agentus-quiet`, 通话中（静音）, importance low, no sound) — one extra channel beats a channel-setting mutation dance that would also clear the notifications already in it |
| P21 | An implicit `ACTION_VIEW` on an `https://` URL is the **browser's** notification to handle, not yours — the operator tapped a message reminder and got Chrome | the tap intent must be **explicit** (`Intent(ctx, MainActivity.class)`) whenever the target is one of the operator's own servers, and the rest of the time it must go to the platform on purpose (`open.prefer`, §5.2). "Open the URL" is not a behaviour a notification can own; "open it here, or hand it over" is |
| P20 | Presence that requires "an interaction within 120s" is wrong during a call: the hands are free | report `call` explicitly and write it the moment the call mounts / hangs up (not on the 30s tick), treat a call as watching for that session, and silence everything else. Verified on the emulator: the same push lands in `agent_done` (importance 4, system sound) with no call and in `agentus-quiet` (importance 2, `mSound=null`, `SILENT`) during one |
| P22 | An action that carries a `RemoteInput` must be posted with a **mutable** `PendingIntent` on Android 12+ (`FLAG_IMMUTABLE` there makes SystemUI drop the WHOLE notification, not just the action) | the inline-reply action gets `FLAG_MUTABLE` (`Build.VERSION.SDK_INT >= 31` guard; minSdk is 26), every other action stays immutable. How it fails when wrong, measured: logcat `Not posted. PendingIntents attached to actions with remote inputs must be mutable`, `dumpsys notification \| grep -c channel=agent_approval` ⇒ `0`, while the running/done cards post normally — a card that never appears and never errors in our own code (§11.1.7) |

## 10. Endpoints as built

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/notify/health` | none | liveness; echoes the code only to an operator |
| GET | `/api/notify/pair-code` | operator | the code + a ready-to-paste `agentus://pair?u=…&c=…` |
| POST | `/api/notify/pair-code/rotate` | operator | mint a new code |
| POST | `/api/notify/pair` | code *or* operator | register a device, get its token |
| GET | `/api/notify/devices` | operator | list (with `online`) |
| POST | `/api/notify/devices/revoke` | operator | drop a device and close its socket |
| POST | `/api/notify/activities` | operator | publish any payload (the preview/debug hook) |
| GET | `/api/notify/settings` | operator | rules + pairing string + presence + device list in one call (what 设置 → 手机通知 renders) |
| POST | `/api/notify/settings` | operator | change the rules (`{rules:{turnStart,approval,completion,quietWhenWatching}}`), persisted |
| POST | `/api/notify/presence` | operator | which session the cockpit is showing (`{sessionId, visible}`), in-memory + 90s TTL. `{call:true}` adds "and I am on a voice call with it": the server then suppresses that session's turn cards and sends every other frame **silently** (`channel.muted`) — a notification tone would be recorded by the call's own microphone |
| POST | `/api/notify/push` | operator | "push this session to my phone": one activity through the normal `publish()`. Options: `kind: "note"｜"approval"｜"island"` (`island` = an ongoing promotable card, the only shape either path can promote), `path: "aosp"｜"xiaomi"` to force one island API, and `open: {prefer}` to say how a tap should land (§5.2 — `prefer:"web"` is what a third-party sender wants) |
| POST | `/api/notify/probe` | operator *or* device | canned sequence: running → progress → approval → done |
| GET | `/api/notify/events?since=N` | operator | replay log as JSON |
| POST | `/api/notify/actions` | device | a button or a reply |
| POST | `/api/notify/diag` | device | the device's own report (version, ROM probes, the payload it would attach, mic state); stored on the device record and readable via `/api/notify/devices` — the only way to diagnose a phone that cannot be plugged in |
| WS | `/api/notify/ws?token=…&since=…&v=<appVersion>` | device | `hello` → replay → live `activity` frames; `v` refreshes the recorded build on every connect |

In the cockpit these run **ahead of the operator gate** (a phone has no session cookie); the
operator-only routes inside re-check their own credential.

## 11. Verification

- `npm run notify-smoke` — **37/37**, over real HTTP + real websocket: wrong code refused, both
  pairing paths, socket auth, fan-out, revision/dismiss frames, capability degradation (keeps
  what it reported, nulls what it did not), cursor replay (`since=0` replays, a later cursor
  skips), button accepted once then `409`, unknown action refused, bad token `401`, re-publish
  re-arms.
- `npx tsx scripts/qa/notify-cockpit-e2e.mts` — **15/15 against the LIVE cockpit** (manual, needs a
  running server + a real agent): pairs a simulated device, creates a real session, sends a prompt.
  The agent's `turn-start` arrived as an ongoing, promotable activity whose deeplink points at that
  session; its **permission request arrived as an approval activity whose buttons are the real ACP
  options** (`allow_once` / `deny`, title `Approve edit: …`); pressing `allow_once` over the device
  token made the cockpit resolve the permission and the agent continue (the card was dismissed by
  `permission-resolved`); `turn-end` arrived as a **non-ongoing** completion activity. The scratch
  session is closed at the end.
  Note: the trigger matters — a prompt that makes the agent use the write tool asks; asking it to `rm`
  something outside the workspace did not.
- `auth-smoke` PASS and `workspace-smoke` 66/66 — the routing change (`/api/notify/*` ahead of the
  operator gate) did not disturb the existing server.
- `npm run typecheck -w @agentus/server` clean.
- APK (v0.3.0): `assembleRelease` OK; `aapt dump badging` shows `versionCode 3` / `targetSdk 36` + all
  permissions; `apksigner verify` OK (v2, debug key); `dexdump` confirms the shipped bytecode calls
  `Notification$Builder.setRequestPromotedOngoing(Z)` and `Notification$ProgressStyle`; the CA is
  packaged as `raw/agentus_ca` → `res/9n.pem`; `strings` on `classes.dex` finds the Xiaomi island
  keys (`miui.focus.param`, `canShowFocus`) and both `resizeableActivity` flags survive into the
  merged manifest.
- Artifact delivery: `GET /agentus-companion.apk` answers **302 → `/` without a login** and **200
  with the operator token**, streaming bytes byte-identical to `android/artifacts/agentus-companion.apk`
  (sha256 `defc3a48…`, 1048446 bytes) — compared by hashing the served stream, not by trusting the 200.
  `/notify` (the onboarding page with the pairing string + device table) is behind the same login.
- Username+password pairing: wrong password → `403 wrong username or password`, right one → `200` with a
  device token, neither code nor login → `403`.
- **A3 (the operator's switches, 57 checks in `notify-smoke`)**: rules read/write/persist; a rule switched
  off publishes nothing; presence suppresses that session's `turn-start` and the very same event arrives
  once presence is cleared; **an approval is never suppressed**; the one-tap push reaches a real socket;
  and all three new routes answer `401` without the operator credential. The test bed grew a
  `/test/observe` route for this — it feeds synthetic events into the *real* `observe()` (the cockpit has
  no such route), so the rules are exercised end to end instead of unit-mocked.
- **The cockpit panel itself, driven in a real browser**: 设置 → 手机通知 renders the pairing string, the
  device list (with a live online dot) and the four switches; flipping 任务开始 in the UI turned the
  server's stored rule into `turnStart:false`; clicking 把当前会话推到手机 made the server publish
  `push:…` with `deeplink=/?session=<id>`; and selecting a session flipped presence to
  `{sessionId, visible:true}, watching:true` with the panel showing 「你正看着 …」.
  Driving an authenticated SPA without a password: CDP `Network.setExtraHTTPHeaders` with
  `Authorization: Bearer <machine token>` (a session cookie minted by a *separate* process is refused —
  the session registry lives in the running server's memory).
- **Device side, on a real Android 16 emulator**: see §11.1.
- **Still unverified**: whether *HyperOS* grants this app 焦点通知 (the operator's own MIX Fold 4 is the
  only place that can answer); the code path is gated on `canShowFocus` and reports the answer in the UI.

### 11.1 Android 16 emulator run (API 36, arm64)

The earlier "1.4 GB is not worth ~7 hours at 56 KB/s" verdict was wrong — `dl.google.com` serves at
**1.89 MB/s direct** and the proxy only adds ~15% (2.22 MB/s), so the 1.87 GB image landed in ~20
minutes and the app was verified on a real device instead of by inspection. Measured on the emulator
(API 36, `sdk_gphone64_arm64`):

| Check | Method | Result |
|---|---|---|
| installs and launches | `adb install -r` + `am start` | ✅ v0.3.2 up, nothing in `logcat -b crash` |
| a notification really appears | paired to the test bed (`10.0.2.2:8790`), posted the canned sequence | ✅ shade shows `跑完了 / 探针序列结束（end_turn）` with a 「查看」 action; the FGS notification `Agentus · 已连接 · 10.0.2.2:8790` is there too |
| promotion (AOSP path) | `NotificationManager.canPostPromotedNotifications()` | ⚠️ false on this image (the system has it off), and the app says so: 「实时动态: 被系统/用户关闭」。A real Android 16 phone is still the judge |
| foldable one-pane / two-pane | `adb shell wm size 1080x2520` (cover, 411dp) vs `2224x2488` | ✅ 「单栏（折叠态）」 vs 「双栏（展开态）」, servers left / form + status right |
| fold/unfold keeps the form | typed `https://fold4.test:8443`, unfolded, folded back | ✅ the activity was recreated and the typed text **survived** — `onSaveInstanceState` genuinely works |
| capability handshake | the app's real pair request | ✅ server recorded `[progress,actions,remote_input,channels,deeplink,live_update]` |
| password sealing | in-app status line | ✅ 「密码存储: Keystore 加密」 (falls back to plaintext *and says so* without a Keystore) |
| service self-heals | `force-stop`, then open the app only | ✅ device goes offline → online without pressing anything |

Two real defects the emulator caught (both looked fine in code and in a screenshot):

1. **The four form inputs were never `addView`ed** (the bug predates this round; the rewrite copied
   it). The screen "looked plausible" while there was no way to type an address, a username or a
   password — i.e. the whole saved-servers feature had no entry point. Caught by counting widgets in
   the accessibility tree (`uiautomator dump` → `EditText: 0`), not by looking at a screenshot.
2. **The service never came back on its own**: after `force-stop`, opening the app left the channel
   dead until the operator pressed something. Fixed by starting it from `MainActivity.onCreate` when
   the active profile has a token (`onStartCommand` is idempotent — it only connects with no socket).

#### 11.1.1 Rounds 2–3: v0.4.1 → v0.5.1 (the app IS the cockpit, the toolbar, the keyboard, the self-test)

| Check | Method | Result |
|---|---|---|
| The app opens on the cockpit | launch with a saved server | ✅ toolbar + WebView, and the page really renders (the Agentus login screen — so the SPA's JS runs, it is not a white box); 服务器 → settings, 进驾驶舱 → back to the cockpit **without reloading** |
| Toolbar no longer under the status bar | `uiautomator dump`, the 服务器 node's `y` | ✅ y≈10 (under the bar, taps eaten by SystemUI) → y≈116 |
| Toolbar buttons were oversized | screenshot | ✅ replaced the platform `Button` (48dp minimum height, wide padding, raised gradient) with small rounded pills |
| Keyboard shrinks the page | tap the page's 用户名 field; `dumpsys input_method` + the WebView's bounds | ✅ IME `mInputShown=true`, WebView **1688 px → 848 px**, and back to **1688 px** after `keyevent 4` (which dismisses the IME only — the app stayed in the foreground) |
| 上岛自检 | tap it; read `logcat -s AgentusNotify` | ✅ first the device diagnosis (model / Android / HyperOS version / `canShowFocus` / SystemUI probe / AOSP availability), then 8 frames of a real ongoing notification (same id updated in place, 12.5% → 100%), auto-cleaned after 12 s. On the emulator (not Xiaomi, no promotion) the log says exactly that instead of pretending |

**Evidence from the real phone** (in the cockpit's own device table / `notify/state.json`): the
operator's MIX Fold 4 (`24072PX77C`, `sdkInt` 36, appVersion 0.3.2) paired with
`capabilities=[…, live_update, xiaomi_focus]` — and `xiaomi_focus` is only reported when
`canShowFocus` is true, i.e. **that phone already grants this app focus notifications**. v0.3.2 asked
AOSP first, so the island parameters never got attached; v0.5.1 reverses the order. That is the most
likely reason the island was never seen, and the app's own 「上岛自检」 is what settles it.

#### 11.1.2 Rounds 4–5: v0.5.2 / v0.5.3 (the island template per generation, the microphone)

| Check | Method | Result |
|---|---|---|
| the island payload matches OS3 | `adb shell settings put system notification_focus_protocol 3`, then 上岛自检 and read the log | ✅ the log's 「会发出的焦点通知参数（岛模板=true）」 prints exactly `param_v2{…, islandFirstFloat, param_island{islandProperty, islandTimeout, smallIslandArea{picInfo}, bigIslandArea{imageTextInfoLeft{picInfo}, imageTextInfoRight{type:2, textInfo}}}}` — the OS3 template, chosen from the ROM's protocol rather than from `Build.VERSION` |
| the diagnostic is readable on the phone | same run | ✅ 协议版本 3 / 超级岛特性（`persist.sys.feature.island`）/ canShowFocus / SystemUI probe / platform path — so the next "上岛没反应" is answered from the device, not from a doc |
| the page's mic request reaches the app | `WebView` on `http://localhost:8787` (a secure origin) calling `getUserMedia` | ✅ app log: 「页面要麦克风：系统权限没有，弹系统授权（请求先挂住）」 |
| the OS dialog appears and the grant lands | tap the dialog | ✅ 「Allow Agentus to record audio?」 → `RECORD_AUDIO: granted=true` (flags `USER_SET`) |
| an http LAN origin cannot do media at all | the same probe page over `http://10.0.2.2:8787` | ✅ the page itself reports no `navigator.mediaDevices` → hence the app's own warning line (P15) |
| ⚠️ not provable on the emulator | the page's promise after the grant | the emulator has no usable audio device, so the `getUserMedia` promise never settles there; "and then the page really gets the microphone" needs the real phone |

The emulator was reached over CDP for this (`adb forward` → the WebView's devtools socket → `Runtime.evaluate`),
which is also how the http-vs-localhost difference was measured without touching the app's UI.

#### 11.1.3 Round 6: the device reports on itself (v0.5.4)

Repeated "still not working" from a phone nobody can plug in is a signal to **stop changing behaviour and
build the observation path first**. `POST /api/notify/diag` (device token) stores the app's own account of
itself on the device record, and the WS handshake now carries `v=<appVersion>` because the version written
at pairing time goes stale after the first sideload — the operator could not even tell which build was
being tested.

Verified end to end on the emulator (tap 上岛自检 → upload → read `notify/state.json`):

```
App 0.5.4（code 12） 服务器: http://10.0.2.2:8787
设备: Google sdk_gphone64_arm64  系统: Android 16（API 36）
isXiaomi: 否  canShowFocus: 关  焦点通知协议版本: 3  超级岛特性: 无
这条要不要按岛模板发: 否（没权限）  麦克风: 已授权
会发出的焦点通知参数（岛模板=true）: {"param_v2":{… "param_island":{…}}}
```

and the device table's `appVersion` flipped `0.4.0` → `0.5.4` on the next connect ✓. The app also offers
「复制诊断」 (clipboard, when the server is unreachable) and 「系统设置」 (the place a denied 录音 gets fixed).

#### 11.1.4 The real phone answers (v0.5.4 diagnosis from the MIX Fold 4)

The diagnostic pipe paid for itself on the first try. The phone's own report:

```
App 0.5.4（code 12） 服务器: https://i207f47592.wicp.vip:38787
设备: Xiaomi 24072PX77C  系统: Android 16（API 36）  小米系统版本: V816（code 816）
isXiaomi: 是  canShowFocus（焦点通知开关）: 开
焦点通知协议版本: 3   超级岛特性: 有（persist.sys.feature.island）
这条要不要按岛模板发: 是（OS3 岛模板）
实时动态（Android 16 原生提升）: 可用
麦克风: 已授权
```

Reading: the ROM is an island-capable OS3, the app holds the focus switch, the template choice is the OS3
one and the payload matches the community SDK's OS3 example field for field. **Nothing left to change in
this codebase** — the remaining gate is Xiaomi's platform-side per-app grant (§6.1). Note also
`canPostPromotedNotifications()` is true there, so both island paths are live on that device and the
vendor path wins by design (§6).

For the microphone the same report narrows it to "granted + secure origin, still refuses", so the app
grew a 「语音自检」 that splits the question in half: a native `AudioRecord` open (can this app record at
all, WebView out of the picture?) and an injected `getUserMedia` (what does the page actually get?).
Both halves are part of the uploaded diagnosis. Verified on the emulator over an **http** LAN origin,
where it reproduces the insecure-context judgement exactly:

```
语音自检: 原生 AudioRecord=可以录（读到 512 帧） / 页面 getUserMedia={"secure":false,"md":false,
          "perm":"prompt","err":"TypeError :: Cannot read properties of undefined (reading 'getUserMedia')"}
```

Implementation trap worth remembering: `WebView.evaluateJavascript` does **not** await promises — an
async IIFE comes back as `{}`, which looks exactly like "the probe returned an empty object". Park the
result on `window` and read it back with a second injection.

#### 11.1.5 v0.5.7: the native microphone bridge and the two island paths (emulator, API 36)

The phone's v0.5.5 self-test settled the question — `原生 AudioRecord=可以录（读到 640 帧）` against
`页面 getUserMedia=NotReadableError :: Could not start audio source`, `secure:true, md:true` — and its
v0.5.6 counters added the last piece: **页面请求过 18 次（放行 18 / 挂起 0）**, i.e. every page request was
granted and Chromium still could not start the source. So the failure is inside Chromium's capture
pipeline, not in the app's permission plumbing. v0.5.6 also showed the probe stalling: the read-back said
`（跑着…）` because a `getUserMedia` that neither resolves nor rejects was never given a deadline.

v0.5.7 answers with three things and this run verifies each on the emulator:

| Change | Evidence |
|---|---|
| `MODIFY_AUDIO_SETTINGS` declared (the fix several reports name for exactly this error: Chromium's audio input switches the AudioManager mode before it opens the source) | `改动音频设置权限=有` in the diagnosis |
| The probe writes its state **after every step** and every step has a timeout | `{"step":"done", …}` instead of「跑着…」; each variant then reports its own `a_default` / `b_noProc` / `c_16k` outcome |
| A native microphone bridge (`window.AgentusMic`, `AudioRecord` 16 kHz mono s16le → base64 → `window.__asMic`), used by the page **instead of** `getUserMedia`, and probed as its own stage | `语音自检（原生桥）: ok · 收到帧=51` and `原生桥=有 · 送出帧=51` — the two numbers agree, so frames really cross the bridge |
| The page's real dictation path (设置 → 语音 → 开麦说一句) picking the bridge | `原生麦克风：已开始` → `已送出 100 帧` in ~6 s, status `listening`, engine `stream` |
| `path` on the activity object, and a 「原生实时动态」 button that forces the AOSP path | `自检：通道=aosp` → `路径：aosp → 小米=跳过 · 原生实时动态=没用` |

Two traps this run cost a build each, both about the bridge being called from the wrong thread:

- **`View.post()` on a DETACHED view parks the runnable in the view's run queue.** The app shows its
  config screen by detaching the WebView (it must not be destroyed, or going back reloads the cockpit),
  so every frame posted from that screen waited for a re-attach: `送出帧=60 · 收到帧=0`. Use a
  `Handler(Looper.getMainLooper())` instead — it runs whether or not the view is attached.
- **A `@JavascriptInterface` method must never touch the WebView.** `webView.getUrl()` from the
  JavaBridge thread throws *"All WebView methods must be called on the same thread"*, and the page sees
  it as `Java exception was raised during method invocation` with no clue what happened. The saved-host
  check is therefore computed on the UI thread (`onPageStarted` / `onPageFinished`) and only *read* by
  the bridge.

Caveat on this evidence: the emulator's dictation run ends with `the streaming socket failed — is the
server up?`. That is an artifact of driving the WebView headless with `Authorization: Bearer` (CDP
`Network.setExtraHTTPHeaders`): the Bearer header authenticates the page's `fetch` calls, but the
`/ws/asr` **WebSocket upgrade carries no header** and needs the session cookie, which this drive never
has. On the phone the page is logged in normally, so the socket has its cookie.

#### 11.1.6 v0.5.8: a call must be silent (server + app, verified on the emulator)

Reported from a real call: the turn ended, the call read the reply out loud, and the phone **dinged** with
a 「跑完了」 card. Fixed in three places, each verified:

| Fix | Where | Evidence |
|---|---|---|
| `completion` is actually read now, and the done card honours presence | `center.ts` `observe()` | smoke `rules: completion off ⇒ no done card (the switch used to be stored and never read)`, `presence: watching ⇒ the completion card is suppressed too` |
| presence carries `call`, written the instant `CallMode` mounts / hangs up | `CallMode.tsx`, `App.tsx`, `types.ts`, `center.ts` | smoke `presence: a call is reported as such`; `call: the called session gets neither the running card nor the completion card` |
| every other frame is sent **silently** while a call is live | `center.ts` `publish()` → `silentChannel`, `ChannelSpec.muted`, `Notifier.apply` (quiet channel) | smoke `call: another session's completion still arrives (never dropped)` + `…but silently`; `call: an approval still arrives`; `call over ⇒ the completion is loud again` |
| the app routes muted frames to one quiet channel | `Notifier.java` | `adb shell dumpsys notification --noredact` on API 36: during a call the same push lands in `mId='agentus-quiet'`, `mImportance=2`, `mSound=null`, `flags=…|SILENT`; with no call it lands in `mId='agent_done'`, `mImportance=4`, `mSound=content://settings/system/notification_sound` |

`notify-smoke` went 57 → **65 checks** (all green) with the call cases; `typecheck` clean.

#### 11.1.7 v0.5.10: 一张从来没发出过的审批卡，和让会话名出现在收起那一行

两件事，同一轮里发现并修完（服务端文案 + 一个 App 侧的平台约束）。

**（1）审批卡在 Android 12+ 从来没投递成功过。** 发探针时 logcat 里出现
`Not posted. PendingIntents attached to actions with remote inputs must be mutable`：带 `RemoteInput`
（那个「或直接回一句」输入框）的 action，其 `PendingIntent` 必须是 **mutable**，而代码写的是
`FLAG_IMMUTABLE`。SystemUI 因此**整条通知都不投递**（不是砍掉按钮），我们的代码里不抛异常、不返回非 0。

| 证据 | 数值 |
|---|---|
| `dumpsys notification \| grep -c channel=agent_approval`（修前，连发两次探针） | **0** |
| 同一句（修后，同一条通知 id `83539`） | **1**，`actions=3`，`ONGOING_EVENT` |
| 运行中 / 完成两张卡（修前修后） | 都正常出现 —— 所以"其它通知都在"完全不能说明这张也在 |

修法：那个 action 用 `Build.VERSION.SDK_INT >= 31 ? FLAG_MUTABLE : 0`（minSdk 26），其它 action 保持
immutable（没有人往里写东西）。顺带把 `NotifyService` 里"解析 JSON 失败"和"应用一帧失败"拆成两句话——
原来共用「无法解析帧」，把一次平台拒收写成了 JSON 问题，正是它把这轮排查带偏过。

**（2）会话名从 `subtitle` 挪到 `body` 的最前面。** Android 的 `setContentText`（我们的 `body`）画在
**收起**的那一行，`setSubText`（我们的 `subtitle`）只在**展开**才画。改前实测 `android.title=跑完了` /
`android.subText=hello`，唯一可见的那行是 `stopReason: end_turn`——既没有会话名，也是给调试器看的字符串。

| kind | 标题 | 正文 |
|---|---|---|
| 运行中 | `Agentus · 运行中` | `<会话名> · <模型> · <思考深度>` |
| 完成 | `已完成` | `<会话名> · 用时 10s`（`turn-end.durationMs` 真量出来的） |
| 失败 | `执行失败` | `<会话名> · <错误摘要>` |
| 审批 | `待你确认：<工具短名>` | `<会话名> · <工具目标>` |

审批那一行来自 agent 自己的 `toolCallTitle`，只在它自己的第一个 `": "` 处切成两半
（`Approve edit: /var/…` → 标题 `待你确认：Approve edit`、正文 `… · /var/…`）：不翻译、不补全语义。

真机实测（模拟器 API 36）：分组收起形态里三行**每一行都带会话名**——
`已完成 在的 #2 · 用时 10s` / `已完成 探针会话 · 探针序列结束` / `待你确认：写文件 探针会话 · edit /etc/hosts —…`，
审批那条下方是「仅此次 / 总是允许 / 拒绝」。断言落在 `scripts/notify-smoke.mts`（5 条，包括"三张卡都不再有
`subtitle`"和"卡上不出现 `stopReason`"）。

## 12. Run it

```bash
# 1. server half, without touching the running cockpit
npm run notify-testbed            # http :8790, https :8791 (test bed state is its own dir)

# 2. the phone app
npm run apk                       # -> android/artifacts/agentus-companion.apk

# 3. on the phone: open the test bed page, copy the pairing string, paste it into the app
#    http://<mac-lan-ip>:8790/     (or https://<mac-lan-ip>:8791/ and accept the cert once)
# 4. press "发一条探针通知" (or POST /api/notify/probe) and watch the phone
# 5. 设置 → 上岛自检      # 10 s, no server: does THIS phone show the island, and via which path
```

The test bed serves its own state (`packages/server/.data-notify-testbed`) precisely so it can run
while the cockpit is up. Once the cockpit is restarted it owns the channel itself
(`/api/notify/*`, `/agentus-companion.apk`) and has its own pairing code.

## 13. What is left

| Item | Note |
|---|---|
| A2 island polish | Segments/points are passed through and drawn; tuning the tracker icon and testing the actual chip needs the phone |
| 上岛的真机结论 | Runs on the phone: 设置 → 上岛自检 — it now prints the exact payload plus the device's protocol generation. The vendor path is whitelist-only (§6.1) and the island has its own package whitelist beyond `canShowFocus`: if Xiaomi has not granted this app, no code change produces an island — the honest fallbacks are the ordinary ongoing notification, or a rooted device with an LSPosed island module |
| Token storage | Device token still in app-private prefs (the *passwords* are already Keystore-sealed via `SecretBox`) |
| Battery optimisation | The "don't kill my service" prompt/whitelist flow is still missing (`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, sideload only) |
| `icon_url` | Bitmap download + cache, then claim the capability |
| Per-session mute | The rules are global today; "quiet for this session only" would be the next switch |
| iOS | Deliberately out of scope for now (APNs + ActivityKit + a widget extension) |