# Developing Agentus with a coding agent in the loop

This doc answers: how do I hand a task on this repository to a coding agent, and how do I
review what it produces?

## AGENTS.md — the file an agent reads first

`AGENTS.md` is a plain-markdown conventions file that coding agents (Hermes, Qoder CLI and
others) read automatically at the start of a session. It is where a repo states the things
that are true of every change: where things live, the invariants, the git discipline, the
commands to run. It is not documentation for humans — it is the brief an agent gets before
it touches anything.

**The Agentus repository itself carries no `AGENTS.md` as of this writing** — the
conventions that govern work on it live in this `docs/dev/` set plus the operator's own
working notes. `TODO(verify)`: a `docs/dev/`-aware root `AGENTS.md` may be added; if one
appears it becomes the entry point an agent reads first, and this manual is what it links to.

Where `AGENTS.md` **is** load-bearing in this workspace: the operator's spoken-reply
workspace (`~/Workspace/voice-chat/AGENTS.md`) is read by both `hermes` and `qodercli`, so
the same style rules apply whichever backend a session runs on. A running session keeps the
prompt it booted with, so an edit to that file only shows up in a **new** session. When a
task is about how Agentus-backed sessions should *speak*, that file — not the code — is the
lever.

## Handing a task to an agent

Agentus is a good target for agent work because every claim is checkable in-repo. Give the
agent four things and it can work without guessing.

**1. The real entry points.** Name the files, do not describe them:

| area | file |
|---|---|
| server entry | `packages/server/src/index.ts` (boots, resolves data dir, wires routes/WS) |
| spawn + ACP relay | `packages/server/src/acp/registry.ts`, `acp/backends.ts` |
| store | `packages/server/src/store/store.ts` |
| auth | `packages/server/src/auth.ts` |
| web app | `packages/web/src/App.tsx`, `state.ts`, `transcript.ts` |
| mock agent (dev/QA) | `packages/server/mock/agent.mjs` |
| dev launcher | `scripts/dev.sh` · release: `scripts/relaunch.sh` · `scripts/make-cert.sh` |

**2. The reference implementation to compare against.** Almost every UI question has a
sibling project that already answered it, and the operator expects behaviour parity, not
copied markup. Point the agent at the right checkout (below) and ask for the *contract* —
where the control lives, what it reads, how it behaves — never the markup.

**3. The verification the change must run.** State it up front so the agent does not declare
victory on a build:

- `npm run typecheck` (0 errors), then `npm run build`;
- the server smokes for the area (`node scripts/*.mjs`);
- for a UI change, a CDP sweep **and** `npm run build` before it (the server serves the built
  bundle). If no sweep covers the surface, the round writes one — see [02-verify.md](./02-verify.md);
- for a release, the deployed-bundle checks in [03-release.md](./03-release.md).

**4. The boundary.** The live instance may be restarted only by an explicit release, and
only on the operator's word unless the change is strictly web-only. Say this in the brief;
an unprompted `promote` kills the session the agent is running in.

## Reference implementations, and where they live

The operator asks to align a surface with these two products ("体验对齐" = behaviour parity).
Read the checkouts before designing; take the contract, not the code — a genuinely derived
block needs its license/NOTICE line, an idea needs nothing.

| product | checkout | what it is good for |
|---|---|---|
| AionUi | `~/Project/AionUi` (`packages/desktop/src/renderer`) | layout mechanics: resizable panes, grouped history, local-file preview, table zoom, markdown utils; its `docs/prds/**` give per-surface intent *and* a "已知局限" appendix (the admitted flaws are what NOT to copy) |
| hermes-studio | `~/.hermes/cache/studio-ref` (client) | the session menu, tool-run grouping (`ToolRunSummary.vue`, `tool-run-grouping.ts`), the message queue, `appendedTextDelta` streaming |

Repo-side notes on both are under [`docs/refs/`](../refs/) (`aionui-acp-rules.md`,
`hermes-studio-ui-ideas.md`).

Two rules that come out of using them:

- **Code, not screenshots.** A reference's source gives the decisions (e.g. "running tools
  are not grouped"; the exact `useResizableSplit` clamping) that a screenshot hides.
- **Check the form before borrowing.** AionUi is an Electron app; a mechanism that hangs off
  its Titlebar has no equivalent in a pure web page + Android WebView shell. Ask "does it
  attach to a layer we have?" before copying it.

## Review discipline

These are the habits that keep agent-produced changes safe on a two-instance, live-traffic
codebase.

- **Diagnose before editing.** For a reported defect or a "why did it do that" question,
  produce the mechanism (store query, log line, code path) and the numbers **first**, and
  stop there. A diff in the same turn as a question is answering a question with
  unrequested work. When a spec is restated, write your reading back — the shape, one
  example, and every point where your reading could differ — before touching code.
- **Root cause over symptom, and fix the class.** The operator reports the symptom
  accurately and the cause never. Find the general condition, not just the instance the
  report names, and say which class of defect it belongs to.
- **One logical change per commit.** Write the message to a file and use `-F` (inline
  backticks / `$` / `!` are eaten by the shell). If a file carries someone else's in-flight
  work, commit only your hunk (`git diff -U3 -- <file>` → `git apply --cached <patch>`),
  never a plain `git add <file>`.
- **Reproduce before you fix; make the new check prove the bug.** Run the assertion against
  the current (broken) build, quote the failing count, then fix, then re-run. A check that
  never failed on the broken build proves nothing.
- **Measure before and after, and put the numbers in the reply.** "Looks the same to me" is
  not evidence, and a light/dark screenshot pair can be two copies of one theme — compare
  real values.
- **Re-verify the checks that watched the thing you changed.** A behaviour change
  invalidates its own observation point; a harness edit invalidates every green it produced.
- **Leave the cockpit as you found it.** Purge the sessions, workspaces and probe files the
  round created; keep the operator's; report the final counts.
- **`main` and the live instance move only on their own paths** — merge/release per
  [03-release.md](./03-release.md), never as a side effect of a "fix".

Cross-links: [01-dev-loop.md](./01-dev-loop.md) · [02-verify.md](./02-verify.md) ·
[03-release.md](./03-release.md) · [04-recover.md](./04-recover.md).
