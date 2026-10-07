#!/usr/bin/env python3
"""Make the LIVE launcher refuse to inherit another instance's identity.

Why this exists (accident 2026-10-07, see track §64): the launcher is normally invoked from
inside a cockpit — i.e. from a shell whose environment carries THAT instance's identity
(`AGENTSLOT_PORT=8787 AGENTSLOT_DATA=<live>/.data` in this case). The launcher copies
`os.environ` wholesale, so those values travel with it, and a code version reading the other
namespace then believes it IS the other instance. That is what turned a dev experiment into a
live-store `reclaimOrphans()` that killed 9 live agent processes.

The launcher's own pop-list only covers the keys it knows about. This pass strips the whole
identity namespace — the current one and the pre-rename one — from BOTH `env` and
`os.environ` (some pins further down read os.environ directly), and drops the watch bridge,
which is a dev-only convenience that must never arrive from the outside (§50: live must not
hot-reload). Values the pins below set explicitly are untouched: the strip runs before them.

Idempotent: re-running on an already-hardened launcher is a no-op.

Usage: python3 scripts/agentus-harden-launcher.py <launcher.py>
"""
import pathlib
import sys

MARK = "# --- identity hygiene (scripts/agentus-harden-launcher.py) ---"
BLOCK = MARK + """
# 见 track §64：调用者往往是座舱/agent 自己的 shell，环境里带着「那个实例」的身份，而本文件
# 原样复制 os.environ —— 于是身份跟着一起走。两套命名空间一起剥（含改名前的旧名），env 与
# os.environ 都要剥：下面的 pin 有的直接读 os.environ。watch 同理不能从外面带进来。
for _ns in ("AGENTUS_", "AGENTSLOT_", "DEV_"):
    for _k in [k for k in list(os.environ) if k.startswith(_ns)]:
        os.environ.pop(_k, None)
        env.pop(_k, None)
for _k in ("AGENTUS_WATCH", "AGENTSLOT_WATCH", "AGENTUS_BASE", "AGENTSLOT_BASE"):
    os.environ.pop(_k, None)
    env.pop(_k, None)
"""


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    p = pathlib.Path(sys.argv[1])
    if not p.is_file():
        print(f"not a file: {p}", file=sys.stderr)
        return 1
    text = p.read_text(encoding="utf-8")
    if MARK in text:
        print(f"{p.name}: already hardened (no-op)")
        return 0
    anchor = "env = dict(os.environ)\n"
    if anchor not in text:
        print(f"{p}: anchor `{anchor.strip()}` not found — refusing to guess", file=sys.stderr)
        return 1
    p.write_text(text.replace(anchor, anchor + BLOCK, 1), encoding="utf-8")
    print(f"{p.name}: hardened")
    return 0


if __name__ == "__main__":
    sys.exit(main())
