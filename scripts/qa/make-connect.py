#!/usr/bin/env python3
"""把「2 秒一换」的和声接起来：和弦之间不再硬切，而是**滑过去**。

原来的做法是每段生成一个和弦再做交叉淡化 —— 等于一块一块地贴，边界上听得出来。
这里的做法换了根：四个声部**一直不停**，换和弦时只把每个声部的频率在 0.3–1.2 秒里
平滑滑到下一个音（相位连续），并且按声部进行（voice leading）选音，让相邻和弦之间
尽量少的音要动 —— Am→F 只动一个音，Am→C 也只动两个。

输出三个滑音长度，判断「多连才算连」。

用法：python3 scripts/qa/make-connect.py → scripts/qa/deep-v3/
"""
import importlib.util
import os
import pathlib

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("mds", HERE / "make-deep-sfx.py")
mds = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mds)
SR, DUR, N, T = mds.SR, mds.DUR, mds.N, mds.T
write, ring_reverb, slow_lfo, note = mds.write, mds.ring_reverb, mds.slow_lfo, mds.note
mds.OUT = str(HERE / "deep-v3")
os.makedirs(mds.OUT, exist_ok=True)

A2, E3 = 110.0, 164.81

# 四个和弦，按**声部进行**排好：相邻两个和弦尽量共用音，动的那一两个音走最短的路。
#           声部1      声部2      声部3      声部4
CHORDS = [
    (220.00, 261.63, 329.63, 440.00),   # Am : A3  C4  E4  A4
    (220.00, 261.63, 349.23, 440.00),   # F  : A3  C4  F4  A4   ← 只动一个音
    (196.00, 261.63, 329.63, 392.00),   # C  : G3  C4  E4  G4
    (196.00, 246.94, 293.66, 392.00),   # G  : G3  B3  D4  G4
]


def glide_freqs(seg=2.0, glide=0.7):
    """每个声部的频率轨迹：每段前 `glide` 秒从上一个音滑到当前音（S 曲线），相位连续。"""
    seg_n = int(SR * seg)
    n_total = N + int(SR * glide)          # 多生成一个滑音尾巴，循环点上也处于滑动中
    out = np.zeros((4, n_total))
    cur = np.array(CHORDS[-1], dtype=float)  # 从 G 滑进 Am：循环接缝不是硬切
    i = 0
    k = 0
    while i < n_total:
        target = np.array(CHORDS[k % len(CHORDS)], dtype=float)
        n = min(seg_n, n_total - i)
        g = min(int(SR * glide), n)
        for v in range(4):
            out[v, i:i + n] = cur[v]
            if g > 0:
                s = np.linspace(0, 1, g)
                s = 0.5 - 0.5 * np.cos(np.pi * s)          # 余弦 S 曲线：起止都不带拐点
                out[v, i:i + g] = cur[v] + (target[v] - cur[v]) * s
        cur = target
        i += n
        k += 1
    return out[:, :N]


def loopify(x, xfade=0.15):
    """等功率首尾缠绕：把尾巴叠进开头再切掉，循环点上没有相位突变（不会有咔哒）。"""
    n = int(SR * xfade)
    f = np.linspace(0, 1, n)
    y = x.copy()
    y[:n] = x[:n] * np.sin(f * np.pi / 2) + x[-n:] * np.cos(f * np.pi / 2)
    return y[:-n]


def render(glide, amp=0.22, sparkle=0.0, seed=5):
    f = glide_freqs(2.0, glide)
    phase = np.cumsum(2 * np.pi * f / SR, axis=1)
    out = np.zeros(N)
    for v in range(4):
        out += amp * np.sin(phase[v]) + 0.10 * np.sin(2 * phase[v])
    out += note(A2, amp=0.30) + note(E3, amp=0.07)          # 低音不跟着变，是这条音的"地板"
    if sparkle:
        rng = np.random.default_rng(seed)
        for _ in range(int(sparkle)):
            at = int(rng.integers(0, N - SR // 2))
            fr = float(rng.choice([523.25, 659.25, 784.0, 880.0]))
            ln = int(SR * 0.3)
            i = np.arange(ln)
            out[at:at + ln] += np.sin(2 * np.pi * fr * i / SR) * np.exp(-i / (SR * 0.07)) * 0.06
    return loopify(ring_reverb(out * slow_lfo(0.28, 0.05), decay=0.78, mix=0.45))


def main():
    write("w1-glide-0.7.wav", render(0.7))                  # 平衡点
    write("w2-glide-0.3.wav", render(0.3))                  # 只连一点点
    write("w3-glide-1.4.wav", render(1.4))                  # 几乎一直在滑
    write("w4-glide-0.7-spark.wav", render(0.7, sparkle=20))  # 连 + 稀疏点缀


if __name__ == "__main__":
    main()
