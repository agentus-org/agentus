# Releasing to the live instance

This doc answers: how do I move a verified change from the dev tree onto the live instance
the operator uses, and how do I undo it?

## The rule that governs every release

`promote` **restarts the live server when server-side code changed**, and a restart SIGTERMs
every live `hermes acp` child — every session the operator has open, including his current
conversation. It is a release, not a hot reload. So:

- releases happen only after the sweeps are green and, unless the change is strictly
  web-only, **only when the operator says so** in that round;
- a strictly web-only change may be published without asking first — but "web-only" is
  decided by what `promote` prints, not by which files you remember editing (below).

## Branches

Work happens on a branch cut in the dev tree:

| branch | use |
|---|---|
| `feat/<slug>` | a feature |
| `fix/<slug>` | a fix (e.g. `fix/rail-readable-tokens`) |
| `run/<slug>` | created **by `promote` on the live tree** — never check it out yourself |
| `main` | the integration line; **not** what live runs from |

`TODO(verify)`: the project also refers to a `fix/<base>/<desc>` convention; the branches
observed in the tree are `feat/<slug>` and `fix/<slug>`.

Keep the dev tree on its own branch. `promote` publishes the dev tree's **current HEAD**,
whatever branch that is — leaving it parked on a stale branch publishes a rollback with no
warning. `promote` guards against the common case (HEAD strictly behind `origin/main` → it
refuses; override with `DEV_PROMOTE_FORCE=1` for a deliberate rollback), but it will not
know that you meant to be on another branch.

## Committing

Commit and push the dev branch **before** promoting: `promote` refuses an uncommitted tree
(`the dev tree has uncommitted changes — commit them first`), and the pushed branch is what
makes the round recoverable if the release goes wrong.

**Write the commit message to a file and use `-F`.** A multi-line message with inline
backticks (`` `--text-dim` ``) or `$`/`!` triggers shell command substitution inside
`-m "…"`, and the substitutions silently vanish from the message:

```bash
$EDITOR /tmp/msg.txt          # backticks, $ and ! are literal here
git commit -F /tmp/msg.txt
```

## Promoting

```bash
bash scripts/dev.sh promote [<slug>]
```

If `<slug>` is omitted, the branch name is used with `/` → `-`. What it does:

1. **Refuses** an uncommitted dev tree, and refuses HEAD-behind-`origin/main` (unless
   `DEV_PROMOTE_FORCE=1`).
2. Runs **detached** — because the restart it may cause kills the agent that ran it — and
   writes its log to `/tmp/agentus-qa-account/promote.log`. Follow it with:
   ```bash
   bash scripts/dev.sh promote-log      # follows the log (it hangs until the run ends)
   ```
   or read `/tmp/agentus-qa-account/promote.log` directly.
3. Checks the **live** tree out onto `run/<slug>` at the dev tip and rebuilds the web bundle.
4. Decides whether the live process must restart, from the diff between the live tree's old
   tip and the promoted HEAD:

| trigger | files |
|---|---|
| server graph | `packages/server/src/**`, `packages/shared/src/**` |
| start shape | `scripts/start.sh`, `package.json` |
| stale launcher | the live process is still running under `tsx watch` |

5. If a restart is needed, calls `scripts/relaunch.sh --port 8788 --tree <live>
   --launcher <live launcher>`, which TERMs the process group, waits for the port to free,
   starts the launcher, polls `/healthz`, and **asserts the pid changed** (a failure exits
   non-zero, so "built fine, still serving old code" cannot pass).
6. Resumes every live session it captured **before** the restart
   (`POST /api/sessions/<id>/resume`, expected HTTP 200 each).

### Web-only release (no restart)

When nothing in the trigger list moved, `promote` prints `no server-side change` and the
running server keeps its process. The new bundle is served on reload, so **no session is
interrupted at all** — the operator only hard-refreshes his tab. The three success criteria
are all required:

- `no server-side change` printed,
- the **asset hash moved** (`web asset: <before> -> <after>`; `promote` warns if web sources
  changed but the hash did not),
- the **pid did NOT move** (`lsof -ti:8788` unchanged — a moved pid means it took the
  restart branch and the release was not the kind it claimed to be).

`package.json` is a restart trigger, so **any** edit to it — even one new npm alias for a QA
sweep — turns a web-only round into a restarting one. When a web change rides on a dev
branch that also carries unreleased server work, cut the release from the live tip instead:

```bash
cd worktrees/agentus-dev
git checkout -B feat/<slug>-live <live-tip>     # live tip = git -C ../agentus rev-parse HEAD
git cherry-pick <web-commit>
git diff --name-only <live-tip> HEAD            # MUST list only packages/web/** (+ scripts/qa/**)
env -u AGENTUS_DATA -u AGENTUS_BASE -u AGENTUS_PORT -u DEV_* bash scripts/dev.sh promote <slug>
```

Also drop `package.json` back to the live tip's version before promoting (`git checkout
<live-tip> -- package.json && git commit --amend --no-edit`) so the alias stays out of the
promoted tree, and run the sweep directly (`npx tsx scripts/qa/x.mts`) where the alias is
absent.

### Never fire the release from the dev environment

The shell that runs `promote` usually carries the QA instance's variables
(`AGENTUS_DATA=/tmp/agentus-qa-account`, `AGENTUS_BASE=…:8901`, `DEV_*`), and
`promote → relaunch.sh → launch.py` inherits them. The launcher now pins its own identity,
but wrap it anyway to keep the environment (and the log) honest:

```bash
env -u AGENTUS_DATA -u AGENTUS_BASE -u AGENTUS_PORT \
    -u DEV_LOG_PATH -u DEV_PROMOTE_DETACHED -u DEV_PROMOTE_SELF -u DEV_PROMOTE_SLUG \
    bash scripts/dev.sh promote <slug>
```

## Verifying what actually got deployed (with no password)

The promote log is one leg; prove the *served* instance independently. Everything below
needs no browser and no operator password.

**1. The machine token.** Each instance mints one at `<DATA_DIR>/auth.token` (0600). The
server accepts it as `Authorization: Bearer <token>` **or** `?token=<token>`. Read it inside
a script and never print it — and do not write the literal `Bearer <value>` shape into a
file, because the write-time secret masker rewrites it to `***` and breaks the syntax.
Assemble the header at runtime.

```bash
TOK=$(cat /tmp/agentus-qa-account/auth.token)          # dev;  live: worktrees/agentus/packages/server/.data/auth.token
curl -s --noproxy '*' -H "Authorization: Bearer $TOK" http://127.0.0.1:8901/api/sessions | head -c 300
```

**2. The served asset hash.** `GET /api/version` is public and returns the served bundle
hash. `promote` echoes it; you can also read it directly:

```bash
curl -s --noproxy '*' http://127.0.0.1:8788/api/version
```

**3. Grep the served bundle for the new markers.** Fetch the real vite-named file
(`assets/index-<hash>.js`) and look for a string only the new code has:

```bash
HASH=$(curl -s --noproxy '*' http://127.0.0.1:8788/api/version | ...)
curl -s --noproxy '*' "http://127.0.0.1:8788/assets/$HASH.js" | grep -c '<new-marker>'
```

Two traps: the file is `index-<hash>.js`, so a check that fetches `/assets/<hash>.js`
misses and hits the SPA fallback (a body opening with `<!doctype` means the wrong URL, not a
broken build); and `echo "$B" | grep -q` under `set -o pipefail` reports a **hit as a miss**
(grep exits on first match, `echo` takes SIGPIPE) — use `grep -q "$lit" <<<"$B"` or
`grep -c` against a saved file.

**4. Rebuild locally and compare the emitted filename.** Stronger than the hash alone and
needs no credentials: rebuild the same source in the live tree and confirm the produced
asset filename is **identical** to the one the live instance is serving.

```bash
cd worktrees/agentus && npm run build
ls packages/web/dist/assets/          # index-<hash>.js must match what /api/version reports
```

Same source in the two trees legitimately differs by ~5 KB (the dev build bakes absolute
source paths into its debug info) and therefore by hash — compare **strings/paths**, not
sizes, and expect the only differences to be tree-name fragments.

After a **restarting** release, the operator's open tab keeps the old bundle until a hard
refresh — say so in the hand-off. A web-only release needs only the hard refresh.

## Merging to main

Merging is a separate step from releasing, and is the standing convention for this repo once
a release is done. `main` is not what live runs from (`promote` puts live on `run/<slug>`),
so fast-forward the ref without checking `main` out anywhere:

```bash
cd worktrees/agentus-dev
git fetch origin
git push origin <dev-branch>:main          # fast-forward only
git branch -f main origin/<dev-branch>
git branch --set-upstream-to=origin/main main
```

Judge the outcome by identity, not by "the push succeeded": `git ls-remote origin
refs/heads/main` must equal the commit live is actually serving.

## Rollback

The release path has no separate rollback mechanism — you revert the change and promote
again:

1. On the dev tree, revert or fix the offending commit.
2. Promote. If HEAD is now behind `origin/main` and you mean to roll back deliberately,
   `promote` refuses; override with `DEV_PROMOTE_FORCE=1 bash scripts/dev.sh promote <slug>`.
   If the release restarted live, the new (reverted) server starts and `promote` resumes the
   sessions it captured before the restart.

The promote log is the record of what happened and where to look:

- **log file:** `/tmp/agentus-qa-account/promote.log`
- **follow:** `bash scripts/dev.sh promote-log`

Relay-side incident recovery (a live instance that came up on the wrong store, a slot that
did not resume) is in [04-recover.md](./04-recover.md).

Cross-links: [01-dev-loop.md](./01-dev-loop.md) · [02-verify.md](./02-verify.md) ·
[04-recover.md](./04-recover.md).
