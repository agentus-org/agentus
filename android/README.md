# Android companion (notify channel client)

The phone half of the notify contract. It holds **one websocket** to your Agentus server and
renders whatever arrives as a notification; on Android 16 that can be a **Live Update** (the
status-bar chip / lock-screen card people call "the island").

It contains no agent logic and no UI beyond pairing: add a notification or a button on the
server, and this app renders it without a rebuild. See
[`docs/android-notify-contract.md`](../docs/android-notify-contract.md).

```
android/
  app/src/main/java/app/agentus/companion/
    MainActivity.java    one screen: paste the pairing string, watch the socket
    NotifyService.java   foreground service + websocket + reconnect/cursor
    Notifier.java        ActivityObject -> notification (the generic renderer)
    LiveUpdate.java      API-36 promotion (ProgressStyle + requestPromotedOngoing)
    ActionReceiver.java  notification button / inline reply -> POST /api/notify/actions
    Http.java            OkHttp with the bundled CA pinned (self-signed friendly)
    BootReceiver.java    come back after a reboot
    Prefs.java           pairing state
  app/src/main/res/raw/agentus_ca.pem   the server's root CA, copied at build time
```

## Build

```bash
bash scripts/build-apk.sh          # from the repo root
# -> android/artifacts/agentus-companion.apk
```

The script pins `JAVA_HOME` to Android Studio's JBR because this machine's `java` is 8 and AGP
8.13 needs 17+. Facts that cost a build attempt each:

| Thing | Value | Why |
|---|---|---|
| AGP | 8.13.0 | first release supporting API 36.1 |
| Gradle | 8.13 | AGP 8.13's minimum (downloaded on first run) |
| `compileSdk` | `36` **+ `compileSdkMinor 1`** | only `platforms/android-36.1` is installed; plain `compileSdk 36` looks for `android-36` and fails |
| `buildToolsVersion` | `36.1.0` | AGP defaults to 35.0.0, which is not installed here |
| deps | OkHttp only | no AndroidX at all → no AAR-metadata constraints |
| signing | `signingConfigs.debug` | sideloaded personal app; rebuilds must update in place |

## Install and pair

1. On the phone, download the APK from the server (`/agentus-companion.apk`) or the test bed,
   then allow "install unknown apps" for the browser once.
2. Open the app and paste the pairing string from the server page:
   `agentus://pair?u=https://<host>:<port>&c=<CODE>`
3. Grant notifications. On Android 16 also check the system switch it points at
   («实时动态» / Live Updates) — the server cannot turn that on for you.

After that, tapping a notification button hits `POST /api/notify/actions` straight from the
lock screen, and an inline reply sends text back as the prompt.

## Known limits (deliberate, tracked in the contract §9)

- No WebView: tapping a notification opens the cockpit in the browser. A shell can come later.
- The device token lives in app-private `SharedPreferences`, not the Keystore yet.
- `iconUrl` is not implemented, so the app does **not** claim the `icon_url` capability.
- The promoted path is best-effort: a device or user that forbids Live Updates silently gets a
  normal ongoing notification instead (same payload).