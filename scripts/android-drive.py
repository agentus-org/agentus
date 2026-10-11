#!/usr/bin/env python3
"""Drive the Android companion on an emulator over adb: tap / type / long-press / screenshot by TEXT.

Usage (see the header of the app round in tasks/20261001-agentus/track.md §96):
    python3 scripts/android-drive.py shot a.png tap 服务器 fill 别称 HOME tap 保存并连接
Two traps this tool exists to absorb:
  1. `adb shell input text` is ASCII-only (Chinese throws inside the `input` tool, not in the app), and
     a tap that lands while the IME is animating is SWALLOWED — every later `input text` then goes into
     the field that still has focus (three values, one box). fill() re-checks uiautomator's focused="true"
     and clears the field first.
  2. Before trusting any screenshot, confirm the FOREGROUND package is the one you installed:
     an emulator can carry several builds at once (app.agentslot.companion next to app.agentus.companion)
     and the old one's foreground service will bring its activity back up.

Shots land in $AGENTUS_SHOTS (default: ./.shots). Re-dumps the view tree before every tap, so an
IME-open relayout cannot make a coordinate stale.
"""
import re
import subprocess
import sys
import time
import os

ADB = os.environ.get("ADB") or os.path.expanduser("~/Library/Android/sdk/platform-tools/adb")
SHOTS = os.environ.get("AGENTUS_SHOTS") or os.path.join(os.getcwd(), ".shots")


def sh(*args, binary=False):
    r = subprocess.run([ADB, *args], capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"adb {' '.join(args)} -> {r.stderr.decode(errors='replace')}")
    return r.stdout if binary else r.stdout.decode(errors="replace")


def nodes():
    sh("shell", "uiautomator", "dump", "/sdcard/ui.xml")
    xml = sh("shell", "cat", "/sdcard/ui.xml")
    out = []
    for m in re.finditer(r"<node([^>]*)>", xml):
        a = m.group(1)
        g = lambda k: (re.search(k + r'="([^"]*)"', a) or [None, ""])[1]
        b = g("bounds")
        mm = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", b)
        if not mm:
            continue
        x1, y1, x2, y2 = map(int, mm.groups())
        out.append({
            "text": g("text").replace("&amp;", "&"),
            "cls": g("class"),
            "clickable": g("clickable") == "true",
            "focused": g("focused") == "true",
            "cx": (x1 + x2) // 2, "cy": (y1 + y2) // 2,
            "bounds": b,
        })
    return out


def find(sub, cls=None):
    for n in nodes():
        if sub in n["text"] and (cls is None or cls in n["cls"]):
            return n
    raise SystemExit(f"not found: {sub!r}")


def tap(sub, cls=None):
    n = find(sub, cls)
    sh("shell", "input", "tap", str(n["cx"]), str(n["cy"]))
    time.sleep(0.4)
    return n


def longpress(sub, cls=None, ms=900):
    n = find(sub, cls)
    sh("shell", "input", "swipe", str(n["cx"]), str(n["cy"]), str(n["cx"]), str(n["cy"]), str(ms))
    time.sleep(0.8)
    return n


def type_text(s):
    sh("shell", "input", "text", s.replace(" ", "%s"))
    time.sleep(0.3)


def focused_text():
    for n in nodes():
        if n.get("focused"):
            return n
    return None


def fill(sub, text):
    """Tap the field, make sure the FOCUS actually landed there, clear it, then type.

    The emulator taught the hard way: tapping while the IME is animating swallows the tap, and every
    later `input text` then lands in the field that still has focus (three values in one box).
    """
    for attempt in range(3):
        tap(sub, cls="EditText")
        time.sleep(0.7)
        n = focused_text()
        if n and sub in n["text"] or (n and n["cls"].endswith("EditText")):
            break
    else:
        raise SystemExit(f"could not focus {sub!r}")
    sh("shell", "input", "keyevent", "123")          # MOVE_END
    sh("shell", "input", "keyevent", *(["67"] * 60))  # DEL × n — one call, input takes a list
    type_text(text)
    hide_ime()
    n = find(text, cls="EditText")
    print(f"[fill] {sub!r} = {n['text']!r}")


def clear_all_fields():
    """Empty every EditText. Needed because a filled field shows its CONTENT, not its hint, so the
    hint-based lookup (the only stable handle these fields have) disappears once they hold text."""
    fields = [n for n in nodes() if n["cls"].endswith("EditText")]
    for n in fields:
        sh("shell", "input", "tap", str(n["cx"]), str(n["cy"]))
        time.sleep(0.5)
        sh("shell", "input", "keyevent", "123")
        sh("shell", "input", "keyevent", *(["67"] * 80))
        time.sleep(0.2)
    hide_ime()
    print(f"[clear] {len(fields)} fields emptied")


def hide_ime():
    sh("shell", "input", "keyevent", "111")  # ESC closes the IME without navigating
    time.sleep(0.3)


def shot(name):
    time.sleep(1.0)
    data = sh("exec-out", "screencap", "-p", binary=True)
    path = os.path.join(SHOTS, name)
    open(path, "wb").write(data)
    print(f"[shot] {path}  {len(data)} bytes")
    return path


def dump_texts():
    for n in nodes():
        if n["text"] and (n["clickable"] or "Edit" in n["cls"]):
            print(f"{n['cls'].split('.')[-1]:10} {n['bounds']:24} {n['text']}")


if __name__ == "__main__":
    cmds = sys.argv[1:]
    i = 0
    while i < len(cmds):
        c = cmds[i]
        if c == "shot":
            shot(cmds[i + 1]); i += 2
        elif c == "tap":
            tap(cmds[i + 1]); i += 2
        elif c == "longpress":
            longpress(cmds[i + 1]); i += 2
        elif c == "type":
            type_text(cmds[i + 1]); i += 2
        elif c == "fill":
            fill(cmds[i + 1], cmds[i + 2]); i += 3
        elif c == "clearall":
            clear_all_fields(); i += 1
        elif c == "esc":
            hide_ime(); i += 1
        elif c == "texts":
            dump_texts(); i += 1
        elif c == "sleep":
            time.sleep(float(cmds[i + 1])); i += 2
        else:
            raise SystemExit(f"? {c}")
