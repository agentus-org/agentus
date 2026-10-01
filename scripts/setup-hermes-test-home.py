#!/usr/bin/env python3
"""Create the isolated Hermes home that AgentSlot hands to every `hermes acp` child.

WHY THIS EXISTS
---------------
A spawned agent CLI inherits the server's env. With `HERMES_HOME` unset, `hermes acp`
falls back to the user's live `~/.hermes` — the same `state.db` the running gateway
has open. Two writers on one WAL SQLite (Hermes' bundled 3.50.4 has the documented
WAL-reset bug) corrupted a real user's state.db on 2026-10-02. AgentSlot now refuses
to spawn a backend whose home resolves to the live home (see
`packages/server/src/acp/backends.ts: buildSpawnEnv`), and defaults to this home.

WHAT IT WRITES
--------------
    ~/.agentslot-test/home/
      config.yaml   derived from ~/.hermes/config.yaml, with the dangerous bits off:
                      mcp_servers             -> {}   (no MCP servers per test session)
                      memory.provider         -> ''   (never attach to prod Hindsight)
                      memory.memory_enabled   -> false
                      kanban.dispatch_in_gateway -> false
      .env          copy of ~/.hermes/.env (0600) so the agent has provider keys

Hindsight note: its embedded Postgres instance is named by
`$HERMES_HOME/hindsight/config.json`'s `profile` field (default "hermes"), which does
NOT follow the Hermes profile name — leaving it at the default would attach a fresh
home to the production memory daemon. Memory is disabled here instead.

Usage:
    python3 scripts/setup-hermes-test-home.py [--home DIR] [--from DIR]
"""
from __future__ import annotations

import argparse
import os
import shutil
import stat
import sys
from pathlib import Path

try:
    import yaml  # provided by Hermes' own venv / most Python installs
except ImportError:  # pragma: no cover
    yaml = None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--home", default=os.environ.get("AGENTSLOT_HERMES_HOME",
                                                    str(Path.home() / ".agentslot-test" / "home")))
    ap.add_argument("--from", dest="source", default=str(Path.home() / ".hermes"))
    args = ap.parse_args()

    live, test = Path(args.source).expanduser(), Path(args.home).expanduser()
    if not (live / "config.yaml").exists():
        print(f"no config.yaml under {live} — nothing to derive from", file=sys.stderr)
        return 1
    if test.resolve() == live.resolve():
        print("refusing to write the isolated home on top of the live home", file=sys.stderr)
        return 1

    test.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(test.parent, 0o700)
    os.chmod(test, 0o700)

    cfg_text = (live / "config.yaml").read_text()
    if yaml is None:
        (test / "config.yaml").write_text(cfg_text)
        os.chmod(test / "config.yaml", 0o600)
        print("!! PyYAML missing: copied config.yaml verbatim.")
        print("!! Set these by hand before use: mcp_servers: {}, memory.provider: '',")
        print("!! memory.memory_enabled: false, kanban.dispatch_in_gateway: false")
    else:
        cfg = yaml.safe_load(cfg_text) or {}
        cfg["mcp_servers"] = {}
        mem = dict(cfg.get("memory") or {})
        mem.update({"memory_enabled": False, "user_profile_enabled": False, "provider": ""})
        cfg["memory"] = mem
        kan = dict(cfg.get("kanban") or {})
        kan["dispatch_in_gateway"] = False
        cfg["kanban"] = kan
        out = test / "config.yaml"
        out.write_text(yaml.safe_dump(cfg, sort_keys=False, allow_unicode=True))
        os.chmod(out, 0o600)

    env_src, env_dst = live / ".env", test / ".env"
    if env_src.exists():
        shutil.copyfile(env_src, env_dst)
        os.chmod(env_dst, 0o600)

    print(f"isolated Hermes home ready: {test}")
    print(f"  mode: {oct(stat.S_IMODE(test.stat().st_mode))}  config: {(test / 'config.yaml').stat().st_size}B")
    print("  verify: HERMES_HOME=%s hermes acp --check" % test)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())