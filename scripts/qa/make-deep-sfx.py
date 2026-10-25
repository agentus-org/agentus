#!/usr/bin/env python3
"""「深邃」的思考长音候选（32 秒、无缝循环）。

操作员的原话是：和声方向对，但「一直是一个调」不行 —— 所以这一批全部是**会走的和声**：
缓慢的和弦进行、不换的低音 drone、环形混响（尾巴绕回开头，所以循环点听不出接缝）。

判据仍然是耳朵：放着听一分钟，第三次循环时还烦不烦。

用法：python3 scripts/qa/make-deep-sfx.py  → 输出 scripts/qa/deep-sfx/
"""
import os
import wave

import numpy as np

SR = 24000
DUR = 32.0
N = int(SR * DUR)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "deep-sfx")
T = np.arange(N) / SR


def note(f, dur=DUR, amp=1.0, detune=0.0):
    """整数周期，保证循环相位连续。detune 用一个略微走音的第二层做「厚」。"""
    k = max(1, round(f * dur))
    f0 = k / dur
    sig = np.sin(2 * np.pi * f0 * T)
    if detune:
        k2 = max(1, round((f + detune) * dur))
        sig = 0.65 * sig + 0.35 * np.sin(2 * np.pi * (k2 / dur) * T)
    return amp * sig


def saw(f, dur=DUR, amp=1.0, harmonics=10):
    k = max(1, round(f * dur))
    f0 = k / dur
    sig = np.zeros(N)
    for h in range(1, harmonics + 1):
        if f0 * h > SR / 2.2:
            break
        sig += np.sin(2 * np.pi * f0 * h * T) / h
    return amp * sig


def envelope_crossfade(seg_len, edge=0.25):
    """在和弦切换处做等功率交叉淡化，避免「咔」。"""
    n = int(SR * edge)
    up = np.linspace(0, 1, n) ** 2
    e = np.ones(seg_len)
    e[:n] = up
    e[-n:] = up[::-1]
    return e


def chord_progression(chords, seg_seconds=8.0, edge=0.6):
    """chords: [(root_freq, [ratios...]), ...] —— 每个和弦占 seg 秒，整体铺满 DUR。"""
    out = np.zeros(N)
    seg = int(SR * seg_seconds)
    edge = int(SR * edge)
    for i, (root, ratios) in enumerate(chords):
        start = i * seg
        stop = min(N, start + seg)
        ln = stop - start
        if ln <= 0:
            break
        blk = np.zeros(ln)
        for r in ratios:
            blk += note(root * r, amp=1.0 / len(ratios))[start:stop]
        e = np.ones(ln)
        n = min(edge, ln // 2)
        if n > 0:
            ramp = np.linspace(0, 1, n) ** 2
            e[:n] = ramp
            e[-n:] = ramp[::-1]
        out[start:stop] += blk * e
    return out


def ring_reverb(x, decay=0.72, mix=0.45, taps=(0.031, 0.047, 0.061, 0.079)):
    """环形（循环）Schroeder 混响：尾音绕回开头，循环点听不出接缝。"""
    wet = np.zeros(N)
    for t in taps:
        d = int(SR * t)
        for k in range(1, 6):
            wet += (decay ** k) * np.roll(x, d * k)
    wet /= (len(taps) * 3)
    return (1 - mix) * x + mix * wet


def slow_lfo(depth=0.3, rate=0.05):
    return 1.0 - depth * (0.5 + 0.5 * np.sin(2 * np.pi * rate * T))


def lowpass(x, alpha=0.15):
    y = np.copy(x)
    for i in range(1, N):
        y[i] = y[i - 1] + alpha * (x[i] - y[i - 1])
    return y


def write(name, samples, peak=0.32):
    m = max(1e-9, float(np.max(np.abs(samples))))
    data = np.clip(samples / m * peak, -1, 1)
    pcm = (data * 32767).astype("<i2").tobytes()
    with wave.open(os.path.join(OUT, name), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm)
    print(f"{name}: {len(pcm) / 1024:.0f} KB")


def main():
    os.makedirs(OUT, exist_ok=True)
    A2, C3, D3, E3, F3, G3, A3 = 110.0, 130.81, 146.83, 164.81, 174.61, 196.0, 220.0

    # H1 · 缓慢和声：Am → F → C → G，每个 8 秒。低音一直挂 A。
    h1 = chord_progression([
        (A3, [1, 1.2, 1.5]),            # Am
        (F3, [1, 1.26, 1.5]),           # F
        (C3, [1, 1.26, 1.5]),           # C
        (G3, [1, 1.25, 1.5]),           # G
    ], 8.0) * 0.55
    h1 += note(A2, amp=0.30) + note(A2 * 2, amp=0.10)
    write("h1-progression.wav", ring_reverb(h1 * slow_lfo(0.35, 0.04)))

    # H2 · 深渊下行：低音半音一声一声往下沉，重 sub。
    down = [(A3, [1, 1.5]), (110 * 0.943, [1, 1.5]), (110 * 0.891, [1, 1.5]), (110 * 0.840, [1, 1.5])]
    h2 = chord_progression(down, 8.0) * 0.45
    h2 += note(27.5, amp=0.45)                      # 真的 sub，听感是「深处」
    h2 += lowpass(np.random.default_rng(3).normal(0, 1, N), 0.02) * 0.05
    write("h2-descent.wav", ring_reverb(h2 * slow_lfo(0.25, 0.03), decay=0.8, mix=0.5))

    # H3 · 星尘：低频不动，高频慢弧上行 + 稀疏钟声。
    h3 = note(A2, amp=0.35) + note(A2 * 3, amp=0.08)
    sweep = np.sin(2 * np.pi * (np.cumsum(np.linspace(300, 700, N)) / SR))
    h3 += sweep * 0.06 * (0.5 + 0.5 * np.sin(2 * np.pi * 0.04 * T))
    rng = np.random.default_rng(11)
    for _ in range(14):
        at = int(rng.integers(0, N - SR))
        f = float(rng.choice([1046.5, 1318.5, 1568, 2093]))
        ln = int(SR * 0.9)
        i = np.arange(ln)
        h3[at:at + ln] += np.sin(2 * np.pi * f * i / SR) * np.exp(-i / (SR * 0.25)) * 0.16
    write("h3-stardust.wav", ring_reverb(h3, decay=0.78, mix=0.55))

    # H4 · 大教堂：五度堆叠 + 管风琴谐波，长混响。
    organ = note(A2, amp=0.28) + note(E3, amp=0.20) + note(A3, amp=0.14)
    organ += saw(A2, amp=0.06, harmonics=6) * 0.5
    write("h4-cathedral.wav", ring_reverb(organ * slow_lfo(0.2, 0.02), decay=0.86, mix=0.6))

    # H5 · 电子进化：锯齿 pad，滤波缓慢打开又关上。
    pad = saw(A3, amp=0.22, harmonics=8) + saw(C3, amp=0.18, harmonics=6)
    cutoff = 0.02 + 0.10 * (0.5 + 0.5 * np.sin(2 * np.pi * 0.03 * T))
    y = np.copy(pad)
    for i in range(1, N):
        y[i] = y[i - 1] + cutoff[i] * (pad[i] - y[i - 1])
    y += note(55, amp=0.3)
    write("h5-evolving.wav", ring_reverb(y * 0.8, decay=0.7, mix=0.4))

    # H6 · 悬浮：没有明确和声，几个不成整数比的正弦慢慢漂移。
    h6 = np.zeros(N)
    for f, a in [(73.4, 0.30), (110.0, 0.22), (164.2, 0.16), (233.1, 0.10), (349.2, 0.06)]:
        drift = 1 + 0.0012 * np.sin(2 * np.pi * 0.017 * T + f)
        h6 += a * np.sin(2 * np.pi * f * T * drift)
    write("h6-float.wav", ring_reverb(h6 * slow_lfo(0.45, 0.035), decay=0.82, mix=0.5))


if __name__ == "__main__":
    main()
