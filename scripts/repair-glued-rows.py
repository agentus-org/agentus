#!/usr/bin/env python3
"""Split the transcript rows that the v3 fold wrongly glued together.

What happened: the store's one-time fold merged two adjacent short rows into one when both were
"fragments" (≤24 chars, no line break, no block key). The replay cleanup had already removed the
tool/operator rows that used to sit between two real messages, so adjacency in the table stopped
meaning adjacency in the stream: 93 rows across 8 sessions now hold two different messages glued
end to end ("Operation interrupted.Operation interrupted."), and the second half's own row is gone.

How they are found: a split point exists where BOTH halves exist as message texts in an older backup
of the same store, in that order, and both halves are ≤24 chars. That is evidence, not a heuristic —
a coincidental split into two strings that both happen to exist earlier is rare, and the `--apply`
mode prints every pair it would rewrite.

The timestamp of the second half is lost with the row; it is written as the first +5 s, which keeps
the order and puts it outside the 2 s window the (fixed) fold rule uses to recognise one stream.

Usage:
  python3 repair-glued-rows.py <live.sqlite> <reference.bak>            # dry run
  python3 repair-glued-rows.py <live.sqlite> <reference.bak> --apply    # rewrite
"""
import collections
import datetime
import json
import sqlite3
import sys


def text_of(payload):
    try:
        d = json.loads(payload)
    except Exception:
        return None
    c = d.get("content") if isinstance(d, dict) else None
    t = c.get("text") if isinstance(c, dict) else None
    return t if isinstance(t, str) else None


def with_text(payload, new_text):
    d = json.loads(payload)
    d["content"]["text"] = new_text
    return json.dumps(d, ensure_ascii=False)


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    live_path, ref_path = sys.argv[1], sys.argv[2]
    apply = "--apply" in sys.argv[3:]

    live = sqlite3.connect(live_path if apply else f"file:{live_path}?mode=ro", uri=not apply)
    live.execute("pragma busy_timeout = 8000")
    ref = sqlite3.connect(f"file:{ref_path}?mode=ro", uri=True)

    done = live.execute("select count(*) from repairs where name = 'unfold-glue'").fetchone()[0]
    if done:
        print("already repaired (repairs.unfold-glue is recorded) — nothing to do")
        return 0

    sessions = [r[0] for r in live.execute("select distinct session_id from messages")]
    found = []
    for sid in sessions:
        ref_rows = [text_of(p) for (p,) in ref.execute(
            "select payload from messages where session_id=? order by seq", (sid,))]
        ref_texts = collections.Counter(t for t in ref_rows if t)
        ref_order = {t: i for i, t in enumerate(t for t in ref_rows if t)}
        rows = live.execute(
            "select seq, kind, payload, created_at from messages where session_id=? order by seq", (sid,)
        ).fetchall()
        for seq, kind, payload, at in rows:
            t = text_of(payload)
            if not t or "\n" in t or not (2 <= len(t) <= 48):
                continue
            splits = []
            for i in range(1, len(t)):
                a, b = t[:i], t[i:]
                if len(a) > 24 or len(b) > 24:
                    continue
                if not ref_texts.get(a) or not ref_texts.get(b):
                    continue
                # an exact repeat ("Operation interrupted." twice) has no usable order — same text
                if a != b and ref_order[a] >= ref_order[b]:
                    continue
                splits.append((a, b))
            if len(splits) == 1:
                found.append((sid, seq, kind, at, t, splits[0]))

    print(f"rows to split: {len(found)}  ({len({f[0] for f in found})} sessions)")
    for sid, seq, kind, at, whole, (a, b) in found:
        print(f"  {sid} #{seq:<6} {kind:<7} {whole!r}")
        print(f"           -> {a!r}  +  {b!r}")

    if not apply:
        print("\ndry run — pass --apply to rewrite")
        return 0

    by_session = collections.defaultdict(list)
    for f in found:
        by_session[f[0]].append(f)

    changed = 0
    with live:
        for sid, items in by_session.items():
            rows = live.execute(
                "select seq, kind, payload, tool_call_id, block_key, created_at, turn_id"
                " from messages where session_id=? order by seq", (sid,)
            ).fetchall()
            splits = {f[1]: f[5] for f in items}
            rebuilt = []
            for seq, kind, payload, tool_id, block_key, at, turn_id in rows:
                parts = splits.get(seq)
                if not parts:
                    rebuilt.append((kind, payload, tool_id, block_key, at, turn_id))
                    continue
                a, b = parts
                rebuilt.append((kind, with_text(payload, a), tool_id, block_key, at, turn_id))
                # the second half's own created_at is gone with its row; +5 s keeps the order and puts
                # it outside the 2 s window the (fixed) fold uses to recognise one stream
                rebuilt.append((kind, with_text(payload, b), tool_id, block_key, at + 5000, turn_id))
                changed += 1
            # renumber this session from 1: a shifted/renumbered anchor is honest, an interleaved one
            # is not. Only sessions that actually contained a glued row are touched.
            live.execute("delete from messages where session_id=?", (sid,))
            live.executemany(
                "insert into messages (seq, session_id, kind, payload, tool_call_id, block_key, created_at, turn_id)"
                " values (?,?,?,?,?,?,?,?)",
                [(i + 1, sid, k, p, t, bk, a, tr) for i, (k, p, t, bk, a, tr) in enumerate(rebuilt)],
            )
        live.execute(
            "insert into repairs (name, version, at) values ('unfold-glue', 1, ?)",
            (datetime.datetime.now().isoformat(sep=" ", timespec="seconds"),),
        )
    print(f"rewritten: {changed} rows")
    return 0


if __name__ == "__main__":
    sys.exit(main())
