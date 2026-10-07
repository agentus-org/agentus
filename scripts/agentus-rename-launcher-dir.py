#!/usr/bin/env python3
"""Rename the LIVE launcher directory's own contents: AGENTSLOT_* -> AGENTUS_*.

Called by scripts/apply-agentus-rename-live.sh after the directory itself has been
moved to ~/.hermes/cache/agentus.

What it deliberately does NOT touch: any `worktrees/agentslot` path. The two git
worktrees keep their current directory names in this round (the live one is the repo's
MAIN worktree, which `git worktree move` refuses to move), so a blind replace would
break every scratch script that points at the tree.

Usage: python3 scripts/agentus-rename-launcher-dir.py <dir> [--check]
"""
import pathlib
import sys

PH = "@@WORKTREE_KEEP@@"
TEXT_EXT = {".py", ".sh", ".mjs", ".mts", ".js", ".json", ".md", ".txt", ".crt", ".pem", ".cnf"}


def convert(text: str) -> str:
    t = text.replace("worktrees/agentslot", PH)          # protect: worktree dirs keep their names
    t = t.replace("cache/agentslot", "cache/agentus")    # the launcher dir's own path
    t = t.replace("AGENTSLOT_", "AGENTUS_")
    t = t.replace("AgentSlot", "Agentus")
    t = t.replace("agentslot", "agentus")
    return t.replace(PH, "worktrees/agentslot")


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    root = pathlib.Path(sys.argv[1])
    check_only = "--check" in sys.argv
    if not root.is_dir():
        print(f"not a directory: {root}", file=sys.stderr)
        return 1

    changed, left = [], []
    for p in sorted(root.rglob("*")):
        # extensionless scripts (hermes-acp-src) are text too — only skip known binaries
        if not p.is_file() or (p.suffix not in TEXT_EXT and p.suffix != ""):
            continue
        try:
            text = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        new = convert(text)
        if new != text:
            changed.append(p.name)
            if not check_only:
                p.write_text(new, encoding="utf-8")
        if "AGENTSLOT" in new or "AgentSlot" in new:
            left.append(str(p))

    # the root CA file was named after the product
    ca_old, ca_new = root / "agentslot-root.crt", root / "agentus-root.crt"
    if ca_old.exists() and not check_only:
        ca_old.rename(ca_new)
        changed.append(ca_old.name)

    print(f"launcher dir: {len(changed)} file(s) {'would change' if check_only else 'changed'}")
    for c in changed[:20]:
        print(f"  · {c}")
    if left:
        print(f"STILL CONTAINS AGENTSLOT ({len(left)}):")
        for l in left[:10]:
            print(f"  ! {l}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
