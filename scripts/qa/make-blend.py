#!/usr/bin/env python3
"""只动接缝，不动音：和弦里还是原来那些音，只是换和弦的交界处让它们**叠一会儿**。

上一版（滑音）把每个声部的频率滑到下一个音上去了 —— 那等于把音改了，方向错了。
这一版的音和 v5 完全一样（同一套 chords、同一个 note()），唯一改动是每段的包络：
不用对称的交叉淡化（那是「旧的刚好退完、新的刚好进满」，交界处两边各只有一半），
而是让**旧的带一点余音退下去、新的同时在进来**，两边在一次换和弦里叠 0.3–0.9 秒。

用法：python3 scripts/qa/make-blend.py → scripts/qa/deep-v4/
"""
import importlib.util
import os
import pathlib

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("mds", HERE / "make-deep-sfx.py")
mds = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mds)
SR, DUR, N = mds.SR, mds.DUR, mds.N
note, ring_reverb, slow_lfo, write = mds.note, mds.ring_reverb, mds.slow_lfo, mds.write
mds.OUT = str(HERE / "deep-v4")
os.makedirs(mds.OUT, exist_ok=True)

A3, F3, C3, G3 = 220.0, 174.6, 130.8, 196.0
FOUR = [(A3, [1, 1.2, 1.5]), (F3, [1, 1.26, 1.5]), (C3, [1, 1.26, 1.5]), (G3, [1, 1.25, 1.5])]


def blend(seg=2.0, attack=0.22, tail=0.35, decay=0.20):
    """音不变，只改包络：段首淡入 attack 秒，段尾以指数衰减在 tail 秒里退掉（与下一段重叠）。"""
    n_tail = int(SR * tail)
    seg_n = int(SR * seg)
    out = np.zeros(N + n_tail)
    i = 0
    k = 0
    while i < len(out):
        root, ratios = FOUR[k % len(FOUR)]
        ln = min(seg_n + n_tail, len(out) - i)
        blk = np.zeros(ln)
        for r in ratios:
            blk += note(root * r, amp=1.0 / len(ratios))[:ln]
        e = np.ones(ln)
        a = min(int(SR * attack), ln)
        e[:a] = np.linspace(0, 1, a) ** 2                       # 起音：软，但不拖
        rel = np.arange(min(n_tail, ln))
        e[ln - len(rel):] *= np.exp(-rel / (SR * decay))        # 收尾：余音慢慢退，跨到下一段里
        out[i:i + ln] += blk * e
        i += seg_n
        k += 1
    x = out[:N]
    x[:n_tail] += out[N:N + n_tail] * 0.9                      # 绕回来的余音也接上，循环点不秃
    return x


def loopify(x, xfade=0.12):
    """等功率首尾缠绕：循环点上没有相位突变。"""
    n = int(SR * xfade)
    f = np.linspace(0, 1, n)
    y = x.copy()
    y[:n] = x[:n] * np.sin(f * np.pi / 2) + x[-n:] * np.cos(f * np.pi / 2)
    return y[:-n]


def build(tail, attack=0.22, decay=0.20, rev=0.45):
    x = blend(tail=tail, attack=attack, decay=decay)
    x += note(110.0, amp=0.30) + note(220.0, amp=0.10)          # 低音地板，和 v5 一致
    return loopify(ring_reverb(x * slow_lfo(0.30, 0.07), decay=0.78, mix=rev))


def main():
    write("x1-tail-0.35.wav", build(0.35))                     # 一点点衔接
    write("x2-tail-0.60.wav", build(0.60))                     # 明显一些
    write("x3-tail-0.90.wav", build(0.90, decay=0.26))         # 最连
    write("x4-tail-0.35-soft.wav", build(0.35, attack=0.40, rev=0.55))  # 一点 + 起音更软


if __name__ == "__main__":
    main()
