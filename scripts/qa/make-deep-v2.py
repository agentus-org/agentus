#!/usr/bin/env python3
"""H1「缓慢和声」的加密度变体。

操作员的话：「缓慢和声挺好的，但变化的太少了，他在干活其实是一个动态」。
所以这批保留 H1 的音色与低音 drone，只把**和声换得更勤**，并加一点"正在做事"的细节：

  V1  四和弦，每 4 秒换（H1 是一半速度）
  V2  八和弦，每 2 秒换（最密，几乎一直在动）
  V3  四和弦每 4 秒 + 稀疏的高音点缀（像有人在敲）
  V4  四和弦每 4 秒 + 每 2 秒一次极轻的低频推力（像心跳/推进）

全部 32 秒、环形混响、无缝循环。

用法：python3 scripts/qa/make-deep-v2.py → scripts/qa/deep-v2/
"""
import importlib.util
import os
import pathlib
import wave

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("mds", HERE / "make-deep-sfx.py")
mds = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mds)                       # __name__ != "__main__"，不会重跑 main()

SR, DUR, N, T = mds.SR, mds.DUR, mds.N, mds.T
note, chord_progression, ring_reverb, slow_lfo, write = (
    mds.note, mds.chord_progression, mds.ring_reverb, mds.slow_lfo, mds.write,
)
mds.OUT = str(HERE / "deep-v2")
os.makedirs(mds.OUT, exist_ok=True)

A2, C3, D3, E3, F3, G3, A3 = 110.0, 130.81, 146.83, 164.81, 174.61, 196.0, 220.0
B3, C4, D4, E4 = 246.94, 261.63, 293.66, 329.63

# Am - F - C - G，每和弦 4 秒（= H1 的两倍速）
FOUR = [(A3, [1, 1.2, 1.5]), (F3, [1, 1.26, 1.5]), (C3, [1, 1.26, 1.5]), (G3, [1, 1.25, 1.5])]
# 八和弦：Am - F - C - G - Em - Am - Dm - G，每和弦 2 秒
EIGHT = [(A3, [1, 1.2, 1.5]), (F3, [1, 1.26, 1.5]), (C3, [1, 1.26, 1.5]), (G3, [1, 1.25, 1.5]),
         (E3, [1, 1.2, 1.5]), (A3, [1, 1.2, 1.5]), (D3, [1, 1.2, 1.5]), (G3, [1, 1.25, 1.5])]


def drone(amp=0.30):
    return note(A2, amp=amp) + note(A2 * 2, amp=amp * 0.33)


def main():
    # V1 · 每 4 秒换一次
    v1 = chord_progression(FOUR, 4.0, edge=0.5) * 0.6 + drone()
    write("v1-4s.wav", ring_reverb(v1 * slow_lfo(0.3, 0.05)))

    # V2 · 每 2 秒换一次，八和弦走两遍
    v2 = chord_progression(EIGHT, 2.0, edge=0.35) * 0.6 + drone()
    write("v2-2s.wav", ring_reverb(v2 * slow_lfo(0.3, 0.07)))

    # V3 · 每 4 秒 + 稀疏高音点缀（像有人在敲键盘 / 一颗颗算出来）
    v3 = chord_progression(FOUR, 4.0, edge=0.5) * 0.55 + drone(0.28)
    rng = np.random.default_rng(5)
    for _ in range(34):                              # 32 秒里 34 个点，平均不到 1 秒一个
        at = int(rng.integers(0, N - SR // 2))
        f = float(rng.choice([440.0, 523.25, 659.25, 784.0, 880.0]))
        ln = int(SR * 0.28)
        i = np.arange(ln)
        v3[at:at + ln] += np.sin(2 * np.pi * f * i / SR) * np.exp(-i / (SR * 0.06)) * 0.085
    write("v3-sparkle.wav", ring_reverb(v3 * slow_lfo(0.25, 0.05), decay=0.75, mix=0.45))

    # V4 · 每 4 秒 + 每 2 秒一次极轻的低频推力
    v4 = chord_progression(FOUR, 4.0, edge=0.5) * 0.58 + drone(0.26)
    push = np.zeros(N)
    for beat in range(0, int(DUR / 2)):
        at = beat * 2 * SR
        ln = min(int(SR * 0.35), N - at)
        i = np.arange(ln)
        push[at:at + ln] += np.sin(2 * np.pi * 55 * i / SR) * np.exp(-i / (SR * 0.12)) * 0.12
    write("v4-pulse.wav", ring_reverb(v4 + push, decay=0.74, mix=0.42))


if __name__ == "__main__":
    main()
