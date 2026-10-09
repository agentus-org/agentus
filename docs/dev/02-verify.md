# Verifying a change

This doc answers: how do I prove a change to Agentus actually works, and which check is the
right size for which change?

## Pick the cheapest evidence that can fail

Not every change needs a browser. Reach for the smallest check that can actually go red:

| change | evidence |
|---|---|
| a pure formatter / decision function | a `*.mts` unit sweep (runs under `npx tsx`, needs no build, no browser) |
| server logic / a REST contract | a `node scripts/*.mjs` suite against a scratch server |
| rendered UI behaviour or geometry | a CDP page sweep (`scripts/qa/*.mjs`) |
| a release | the promote log + the served bundle (see [03-release.md](./03-release.md)) |
| a doc / config edit | it is done when it is written — no verification run |

A change with no runtime effect is finished when it is written; an unasked-for sweep just
spends the round.

## Unit suites and smoke suites

### `npm test`

`package.json` maps `test` to `npm run test -ws --if-present`, i.e. "run each workspace's
own `test` script if it has one". As of this writing **no workspace defines a `test`
script**, so `npm test` runs nothing. The runnable suites are the scripted ones below —
run them directly. `TODO(verify)`: this placeholder is expected to gain real suites.

### Server / API smoke suites (each boots its own scratch server on a random port `8900+`)

```bash
npm run typecheck                                        # 0 errors before any commit
npm run build                                            # web bundle + shared types
node scripts/auth-smoke.mjs                              # the lock, both credentials (~48 assertions)
node scripts/backend-registry-smoke.mjs                  # backend registry, spawn env, health (~42)
node scripts/workspace-smoke.mjs                         # workspace, file API, shell, attachments (~85)
node scripts/voice-smoke.mjs                             # settings/theme guards, voice router (~47)
npm run tls-smoke                                        # the TLS listener, real sockets + real certs
npm run package-smoke                                    # pack + install into a throwaway HOME + boot
node scripts/smoke.mjs mock "hello"                      # end-to-end against the mock agent
```

`backend-registry-smoke` is shaped as three layers so it passes on a machine without the
operator's CLI: always-on (registry CRUD, spawn env, session health via the in-repo mock),
local-only checks guarded by "does this command resolve / does that tree exist" and
announced as `skip`, and a summary line reporting the skip count. A suite that needs a
local binary must **skip**, never fail.

### `*.mts` unit sweeps (importable TS, no build, no browser)

```bash
npm run transcript-fold   # tsx scripts/qa/transcript-fold.mts
npm run store-fold        # tsx scripts/qa/store-fold.mts
npm run live-stream       # tsx scripts/qa/live-stream.mts   real server frames -> real store
npm run resume-tail
npm run rail-recent
npm run turn-pulse        # the silence->amber decision, with injected `now`
npm run sentence-units
```

Plus non-aliased ones run with `npx tsx scripts/qa/<name>.mts`: `accent-text.mts` (the
accent-as-text derivation, 61 checks), `presence-rule.mts` (`watchingNow`), `open-target.mts`,
`plan-v2-sweep.mts`, `asr-idle-wedge.mts`. These are the right home for a **time- or
boundary-driven decision**: extract it into a pure function with an injected `now` and
assert either side of the boundary (59s vs 60s, `2 < 10 < 100`), because a browser cannot
be made to wait for a 60-second window reliably.

## The CDP browser sweeps

`scripts/qa/*.mjs` drive a **real browser** over the Chrome DevTools Protocol and read
computed styles and geometry from the rendered page — never assert on internals. They run
by hand and are not in CI.

### Start the debug browser

Launch Edge or Chrome with remote debugging on `127.0.0.1:9222`:

```bash
open -a "Microsoft Edge" --args --remote-debugging-port=9222
# or: /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

### Run a sweep

```bash
cd worktrees/agentus-dev
PORT=8901 node scripts/qa/layout-sweep.mjs
PORT=8901 W=390 H=844 node scripts/qa/popover-sweep.mjs
```

Each sweep opens its **own tab** (`PUT http://127.0.0.1:9222/json/new?<BASE>`), builds its
own page state, and defaults to the dev port (`8901`, overridable with `PORT` / `BASE`).
Sweeps that post REST calls want the QA data dir: `AGENTUS_DATA=/tmp/agentus-qa-account`.

**Rebuild before you sweep a web change.** The dev server serves `packages/web/dist`, so
after editing web sources run `npm run build` (or `npm run build -w @agentus/web`) first, or
the sweep measures the previous bundle.

**Page-driving sweeps on `:8901` must log in themselves.** The operator's Edge profile
holds the cookie for the live port, not the dev one, so an unattended tab renders the login
wall and every step reads as a 401-induced "product failure". Standard opening:
`POST /api/auth/login` as `scratch` / `scratch-pass-1` (the `DEV_USER`/`DEV_PASS` defaults),
then reload. Assert the page is authenticated before measuring.

**Run one browser sweep at a time.** Two sweeps share this box's CPU and the one CDP
browser; the starved one fails in a cluster of unrelated places. Re-run a red suite alone
before believing it. And do not run a sweep in the same breath as a branch switch or any
server-source edit — the dev watcher restarts, the page's WebSocket drops mid-run, and one
assertion fails at random.

### The exit-code discipline (or node hangs)

End every sweep with:

```js
ws.close();
process.exit(fail ? 1 : 0);
```

A sweep that only sets `process.exitCode` prints its summary and then **hangs forever on
the open CDP WebSocket** — and a shell chaining two sweeps with `;` never reaches the
second one. Measured: three sweeps sat "still running" 8–25 minutes after their last check,
each holding a tab, which then made the next sweep time out. When a suite "hangs after
passing", look for the missing exit before hunting a product bug.

### Traps worth knowing before you write one

- **`Runtime.evaluate` needs `awaitPromise: true`**, or a `fetch(...)` expression comes back
  as a serialised pending Promise (`{}`) — truthy, so a step "succeeds" while nothing was
  created.
- **`Runtime.evaluate` must return something serialisable.** `returnByValue: true` on an
  expression that evaluates to a DOM node fails the whole call (`Object reference chain is
  too long`). Wrap it: `Boolean(document.querySelector('.sidebar'))`.
- **Enter needs `text:'\r'`.** `Input.dispatchKeyEvent` with only `key:'Enter'` / `code`
  delivers the event but the app's `keydown` handler never sees it. Add `text:'\r'`.
- **A trusted click lands where the viewport says.** If the target is scrolled out of the
  viewport the event is silently swallowed — `scrollIntoView({block:'center'})`, re-measure,
  assert `top >= 0 && bottom <= innerHeight`, then click.
- **The oracle comes from the page, not from node.** The cockpit is authenticated, so a
  node-side `fetch('<BASE>/api/sessions')` returns 401 and every "UI value == server value"
  comparison silently becomes "== undefined". Fetch from inside the page:
  `ev("fetch('/api/sessions').then(r=>r.json())")`.
- **The app consumes `?session=` and strips it** (`state.ts #openTarget` → `replaceState`),
  so a later `location.search` read is always null — keep the id in a variable. And
  `Page.reload` wipes injected page helpers; re-inject after every reload.
- **Never wrap `window.WebSocket`.** Installed via `Page.addScriptToEvaluateOnNewDocument`
  it replaces the constructor the app uses and the cockpit's own socket never connects.
  Patch `WebSocket.prototype.send` after the app is up instead.
- **Token-injection cannot reach the WS handshake.** Injecting the machine token as an HTTP
  header (via `Fetch.continueRequest` with `headers` as an **array** of `{name,value}`)
  authenticates REST but not `/ws`, and the app's WS URL carries no token. That is enough
  to prove REST-fed surfaces on the live instance but **not** WS-fed ones like the session
  rail's live rows — say which you proved and which you did not.

### Why a visual rule needs an injected fixture row

The dev instance's mock emits **no tool calls for an ordinary prompt** (see
[01-dev-loop.md](./01-dev-loop.md)). A sweep whose subject is a `.tool-card` will therefore
never produce one and spends its time failing. When the assertion is about the CSS, inject a
probe with the **real class names** into the real container, measure it, remove it, and
assert the count is unchanged (`0 → 0`) so a leaked probe cannot pass:

```js
const mk = (html) => { const d = document.createElement('div'); d.innerHTML = html;
  const el = d.firstElementChild; stream.appendChild(el); return el; };
const row = mk('<div class="msg"><div class="tool-card completed">…</div></div>');
const box = row.querySelector('.tool-card').getBoundingClientRect();
row.remove();
```

Say in the check's label which rows are real and which are probes. An operator who judges a
layout by eye still needs a screenshot; a probe that only the script saw is not verified.

### Writing a new sweep from an existing one

Copy the closest existing sweep and keep its scaffolding (identical in every file):

1. the CDP client (`send` / `ev` / `until` helpers over a `WebSocket`),
2. the `check(ok, what, detail)` counter and the pass/fail summary,
3. `PUT /json/new?<BASE>` to open the tab, `sleep(~2600)` to let the app boot,
4. login-as-scratch if the surface needs a live socket,
5. build the page state you need (create a **fresh** mock session rather than adopting one),
   and reset any preference you depend on (both `localStorage` and the server setting),
6. `ws.close(); process.exit(fail ? 1 : 0)`.

Prefer a new mock `[trigger]` prompt over editing a shared fixture constant — the mock is
spawned per session, so a new session picks up the edit with no server restart, and the
assertion then drives a real agent bubble instead of HTML the sweep injects.

## Table of existing sweeps

The QA directory is large; these are the ones that carry each surface, with what each covers.

| sweep (`scripts/qa/`) | covers |
|---|---|
| `layout-sweep.mjs` | rail indent ladder + folder icon + directory colour, accent-neutral split, three-pane widths with real pointer drags, chat column edge alignment, content-width rows (short tool card not stretched), phone 390px — 58 checks |
| `rail-archive-sweep.mjs` | the 已归档 section: built like 工作空间 (same row shape, folder icons, grouped by directory), a fold flag that survives a reload, and the two sections keeping separate fold state for the same path — 15 checks |
| `terminal-sweep.mjs` | the workspace panel's terminal is a real pty, not a text box: xterm mounted, a prompt only a tty prints, the shell's own echo of what was typed, an SGR colour surviving to the screen, and a resize that reaches the kernel (`stty size` + SIGWINCH) — 15 checks |
| `queue-sweep.mjs` | the message queue: enqueue while a turn runs, the row is not in the transcript, the three buttons' order, delete/edit, automatic ordered drain on `turn-end` — 28 checks |
| `table-sweep.mjs` | table headers sort three ways (numeric, not string), filter, full-screen reader with content rotation on a phone, a file chip in the reply, a relative image — real agent bubble via `[table]` |
| `rail-contrast-sweep.mjs` | sidebar text contrast computed per element against its actual background, in both palettes with the operator's blue and the built-in amber; the accent-vs-neutral chroma gap |
| `render-files-sweep.mjs` | local file links / images in a reply (all four forms), the workspace panel previewing and saving by type, the raw endpoint behind auth |
| `popover-sweep.mjs` | every popover's geometry at both viewports (a popover can pass every DOM text assertion while being off-screen) |
| `rail-sweep.mjs`, `rail-live-sweep.mjs`, `rail-recent-sweep.mjs` | the session rail: one title per row, row geometry, the ⋯ menu, inline rename landing in DOM *and* API, the phone bottom sheet, rail ordering |
| `message-actions-sweep.mjs` | per-message copy (text compared character-for-character), fork-on-tail |
| `permission-sweep.mjs` | a permission request reaches the operator's view (card + dialog), names the file, shows the diff, the answer reaches the agent, ≥32px tap targets |
| `voice-stop-sweep.mjs`, `call-sweep.mjs` | the speech layer and the full-screen call: deliberate stop vs real failure, the hero's real animation, phases, barge-in, controls on screen at 390×844 |
| `session-title-sweep.mjs`, `session-restart-sweep.mjs` | naming over API + browser; swapping an agent child under a live slot without it leaving the live list |
| `transcript-sweep.mjs`, `window-ui-sweep.mjs`, `turn-line-sweep.mjs`, `turn-pulse-sweep.mjs` | transcript rendering/paging/gestures, the usage strip, the turn timer and the silence→amber state |
| `config-sweep.mjs`, `dismiss-sweep.mjs`, `model-switch-sweep.mjs`, `plan-*-sweep.mjs` | the config/plan/model surfaces |
| `live-endpoints-check.mjs` | the file endpoints over the machine token; same source runs against live **and** dev |
| `think-cadence.mjs`, `render-lag-sweep.mjs`, `replay-window.mjs` | streaming cadence, render lag, replay windows |

Unit (`*.mts`) sweeps: `accent-text`, `transcript-fold`, `store-fold`, `live-stream`,
`resume-tail`, `rail-recent`, `turn-pulse`, `sentence-units`, `presence-rule`, `open-target`,
`plan-v2-sweep`, `asr-idle-wedge`. There are also `notify-smoke.mts` (the notify contract,
65 → 72 checks) and `notify-cockpit-e2e.mts` (a real agent turn end-to-end) for the phone
channel; see [`docs/android-notify-contract.md`](../android-notify-contract.md).

## Assertion discipline

Every sweep assertion must be able to prove **this run** caused the observed state:

- use a water mark (`createdAt >= runStart`) rather than "the newest row in that directory";
- establish `cwd` for any seeded fixture (`POST /api/sessions` refuses a `cwd` that is not a
  directory) and assert the fixture exists before asserting behaviour;
- set what you depend on first — a leftover server preference from an earlier run turns
  unrelated checks red;
- judge the effect on the far side ("the button cleared our state" is not "the answer
  reached the agent" — read the agent's own tool output);
- when a fix is claimed, re-run the suite whose surface you touched: a change to the harness
  invalidates every green it produced.

Cross-links: [01-dev-loop.md](./01-dev-loop.md) (ports, mock triggers) ·
[03-release.md](./03-release.md) (proving a release) ·
[04-recover.md](./04-recover.md) (stray tabs, leaked processes).
