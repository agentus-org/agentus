#!/usr/bin/env python3
"""生成「思考中」的长音候选（可无缝循环），给操作员试听用。

判据不是"听起来高级"，是**能不能一直放着不烦**：所以每个候选都是 24 秒、音量压到
-20 dBFS 上下、首尾按整数周期对齐（循环点听不出接缝）。噪声类用环形交叉淡化。

用法：python3 scripts/qa/make-think-sfx.py   → 输出到 scripts/qa/think-sfx/
"""
import math
import os
import random
import struct
import wave

SR = 22050
DUR = 24.0
N = int(SR * DUR)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "think-sfx")


def write(name, samples, peak=0.25):
    """归一化到 peak（≈ -12 dBFS 峰值，听起来像"背景")并写成 16-bit 单声道 wav。"""
    m = max(1e-9, max(abs(x) for x in samples))
    scale = peak / m
    data = b"".join(struct.pack("<h", int(max(-1.0, min(1.0, x * scale)) * 32767)) for x in samples)
    path = os.path.join(OUT, name)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data)
    print(f"{name}: {len(data) / 1024:.0f} KB")


def ring_noise(seconds=DUR, lp=0.02):
    """低通噪声，首尾交叉淡化，保证循环接缝听不出来。"""
    n = int(SR * seconds)
    raw = [random.uniform(-1, 1) for _ in range(n)]
    out, y = [], 0.0
    for v in raw:                     # 一阶低通，去掉刺耳的高频
        y += lp * (v - y)
        out.append(y)
    fade = int(SR * 1.0)              # 1 秒环形交叉淡化
    for i in range(fade):
        t = i / fade
        out[i] = out[i] * t + out[n - fade + i] * (1 - t)
    return out[:n - fade]


def note(freq, dur=DUR):
    """整数周期：频率取 1/dur 的整数倍，循环点相位连续。"""
    k = max(1, round(freq * dur))
    f = k / dur
    return [math.sin(2 * math.pi * f * i / SR) for i in range(int(SR * dur))]


def env(samples, depth=0.35, rate=0.08):
    """极慢的起伏 —— 这是"活着"和"死机"的区别。"""
    n = len(samples)
    for i in range(n):
        samples[i] *= 1.0 - depth * (0.5 + 0.5 * math.sin(2 * math.pi * rate * i / SR))
    return samples


def gain(samples, g):
    return [v * g for v in samples]


def mix(*tracks):
    n = min(len(t) for t in tracks)
    out = [0.0] * n
    for t in tracks:
        for i in range(n):
            out[i] += t[i]
    return out


def main():
    os.makedirs(OUT, exist_ok=True)

    # T1 · 低频运转：55/110/165 Hz，像一个马达在低速跑
    t1 = mix(gain(note(55), 0.55), gain(note(110), 0.28), gain(note(165), 0.12), gain(ring_noise(), 0.05))
    write("t1-drone-low.wav", env(t1, 0.3, 0.06))

    # T2 · 柔和和声垫：A 大三和弦，温暖，不指向任何方向
    t2 = mix(gain(note(220), 0.30), gain(note(277.18), 0.24), gain(note(329.63), 0.20), gain(ring_noise(), 0.03))
    write("t2-pad-warm.wav", env(t2, 0.45, 0.05))

    # T3 · 空气/呼吸：只有噪声，没有音高 —— 最像"房间里有人"
    t3 = gain(ring_noise(lp=0.10), 0.9)
    write("t3-air.wav", env(t3, 0.55, 0.10))

    # T4 · 电子脉冲：60 Hz 底 + 每秒两次的轻微脉动
    base = note(60)
    pulse = [0.5 + 0.5 * math.sin(2 * math.pi * 1.5 * i / SR) for i in range(N)]
    t4 = mix([b * (0.45 + 0.55 * p) for b, p in zip(base, pulse)],
             gain(note(120), 0.15),
             gain(ring_noise(), 0.04))
    write("t4-pulse.wav", env(t4, 0.2, 0.07))

    # T5 · 微光：低频底 + 稀疏的高频泛音点缀（"有东西在发生"）
    pad = mix(gain(note(110), 0.35), gain(note(220), 0.12))
    sparkle = [0.0] * N
    random.seed(7)
    for _ in range(22):                                    # 24 秒里洒 22 个点
        at = random.randrange(0, N - SR)
        f = random.choice([880, 1046.5, 1318.5, 1568])
        ln = int(SR * 0.35)
        for i in range(ln):
            sparkle[at + i] += math.sin(2 * math.pi * f * i / SR) * math.exp(-i / (SR * 0.08)) * 0.22
    write("t5-sparkle.wav", env(mix(pad, sparkle), 0.25, 0.08))


if __name__ == "__main__":
    main()
