/** 状态音（#61）的共用底座：干活时的背景音 + 打断音。
 *
 *  抽成模块的原因不是「复用」，是**可诊断**：通话页里它是一段听不见的代码，出问题只能靠猜
 *  （第一版就是这样，素材解码成功、source 也 start 了，但整个 AudioContext 是 suspended，
 *  一个字都不响）。设置页现在能直接把它放出来给你听，并把「上下文状态 / 解码长度 / 错误」
 *  显示出来 —— 同一个实现，两处调用，测的就是产品用的那份。
 *
 *  两条环境事实，改之前先读：
 *  1. 浏览器的自动播放策略只允许**在用户手势的调用栈里**创建的 AudioContext 出声。挂载时建
 *     的 ctx 是 suspended，而 `resume()` 在没有手势时被静默拒绝（不抛错、不打日志）。
 *  2. `decodeAudioData` 认不认 m4a/aac 依浏览器而定（Android WebView 常见不认）。所以
 *     解码失败不算"没声音"的单一解释，得把错误露出来。 */

/** 同一个音的两种容器，按可用性挑。decodeAudioData 认不认 m4a/aac 依浏览器而定
 *  （Android WebView 上常见不认，而且它失败得很难看：整个 Promise.all 一起废掉），
 *  所以两件事同时做 —— 分别解码、各自记错、备一份 mp3。 */
const BED_URLS = ["/sfx/thinking.m4a", "/sfx/thinking.mp3"];
const CUT_URL = "/sfx/interrupt.wav";

let ctx: AudioContext | null = null;
let bedBuf: AudioBuffer | null = null;
let cutBuf: AudioBuffer | null = null;
let error = "";
let loading: Promise<void> | null = null;
let bed: { gain: GainNode; src: AudioBufferSourceNode | null } | null = null;
let preview: AudioBufferSourceNode | null = null;

type Ctor = typeof AudioContext;

function ctor(): Ctor | null {
  if (typeof window === "undefined") return null;
  return window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext
    ?? null;
}

/** 长命的通话音频上下文。没有音频设备/被策略拦住时返回 null（通话本身必须照常进行）。 */
export function audioCtx(): AudioContext | null {
  try {
    if (!ctx) {
      const C = ctor();
      if (!C) return null;
      ctx = new C();
    }
    if (ctx.state === "suspended") void ctx.resume().catch(() => { /* still no gesture */ });
    return ctx;
  } catch { return null; }
}

/** 在用户手势里调一次：没有这一步，挂载时建的 ctx 会一直 suspended。 */
export function unlockAudio(): void {
  const c = audioCtx();
  if (c && c.state === "suspended") void c.resume().catch(() => { /* ignore */ });
}

/** 预取两个音。可以重复调（并发安全）；失败原因留在 `error` 里。 */
export function loadSfx(): Promise<void> {
  if (loading) return loading;
  const c = audioCtx();
  if (!c) { error = "这个浏览器没有 AudioContext"; return Promise.resolve(); }
  const grab = (url: string): Promise<AudioBuffer> =>
    fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
      return r.arrayBuffer();
    }).then((a) => {
      // decodeAudioData 在部分 WebView 上会**既不 resolve 也不 reject** —— 于是整个
      // loadSfx 永远 pending，按钮点了什么反应都没有（连状态行都不出来）。给个上限。
      const decode = c.decodeAudioData(a);
      const timeout = new Promise<AudioBuffer>((_, rej) =>
        window.setTimeout(() => rej(new Error(`${url}: 解码超时`)), 4000));
      return Promise.race([decode, timeout]);
    });
  // 两个音、三种容器，**各自独立**：任何一个成功就算那个音可用，失败原因逐条攒起来。
  // 曾经用 Promise.all 一把梭 —— 于是 m4a 解不了的时候，连能播的 wav 也被判成"没有音"。
  const fails: string[] = [];
  const tryBed = async (i: number): Promise<void> => {
    if (i >= BED_URLS.length) { fails.push(`背景音：${BED_URLS.length} 个容器都解不了`); return; }
    try { bedBuf = await grab(BED_URLS[i]); } catch (e) {
      fails.push(`${BED_URLS[i]}: ${String((e as Error)?.message ?? e)}`);
      await tryBed(i + 1);
    }
  };
  loading = Promise.all([
    tryBed(0),
    grab(CUT_URL).then((k) => { cutBuf = k; }).catch((e) => {
      fails.push(`${CUT_URL}: ${String((e as Error)?.message ?? e)}`);
    }),
  ]).then(() => {
    error = fails.join(" | ");
    if (!bedBuf || !cutBuf) loading = null;   // 允许下次再试（比如换了网络/换了浏览器）
  });
  return loading;
}

export function sfxStatus(): { ctxState: string; bed: number | null; cut: number | null; error: string; channel: string } {
  const c = audioCtx();
  return {
    ctxState: c ? c.state : "unavailable",
    bed: bedBuf ? bedBuf.duration : null,
    cut: cutBuf ? cutBuf.duration : null,
    error,
    channel: channel(),
  };
}

/** 兜底通道：`<audio loop>`。decodeAudioData 认不认容器依浏览器而定，HTMLAudioElement 几乎总认，
 *  而且不需要解码这一步。代价是音量只有 0..1 一档、淡入淡出靠 volume 手动爬（够用）。 */
let bedEl: HTMLAudioElement | null = null;
function bedElement(): HTMLAudioElement | null {
  if (typeof Audio === "undefined") return null;
  if (!bedEl) {
    bedEl = new Audio(BED_URLS[BED_URLS.length - 1]);
    bedEl.loop = true;
    bedEl.preload = "auto";
    bedEl.volume = Math.min(1, bedLevel * 2);
  }
  return bedEl;
}

export function channel(): "webaudio" | "element" | "none" {
  if (bedBuf) return "webaudio";
  if (bedEl) return "element";
  return "none";
}

export function ready(): { bed: AudioBuffer | null; cut: AudioBuffer | null } {
  return { bed: bedBuf, cut: cutBuf };
}

/** 打断音：一声 0.3 秒的短促提示。语义是「停」，不是「叮咚」。 */
export function playCut(): void {
  const c = audioCtx();
  if (!c || !cutBuf) return;
  try {
    const src = c.createBufferSource();
    const g = c.createGain();
    g.gain.value = 0.6;
    src.buffer = cutBuf;
    src.connect(g).connect(c.destination);
    src.start();
  } catch { /* no device: the line on screen still says it */ }
}

/** 背景音电平。0.10（≈-20 dB）在手机喇叭上基本等于没有 —— 试听时打断音听得见、底音听不见，
 *  十有八九不是"没触发"，是**太轻**。默认给 0.22（≈-13 dB）当底色，并且让人自己调。
 *  存 localStorage，通话页和设置页读同一个值。 */
const LEVEL_KEY = "agentus.sfx.bed";
let bedLevel = (() => {
  try {
    const v = Number(localStorage.getItem(LEVEL_KEY));
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.22;
  } catch { return 0.22; }
})();

export function getBedLevel(): number { return bedLevel; }
export function setBedLevel(v: number, previewSeconds = 0): void {
  bedLevel = Math.min(1, Math.max(0.02, v));
  try { localStorage.setItem(LEVEL_KEY, String(bedLevel)); } catch { /* private mode */ }
  if (bedEl) bedEl.volume = Math.min(1, bedLevel * 2);   // 元素的 volume 是线性，给点补偿
  if (bed) {
    const c = audioCtx();
    if (c) {
      bed.gain.gain.cancelScheduledValues(c.currentTime);
      bed.gain.gain.setTargetAtTime(bedLevel, c.currentTime, 0.08);
    }
  }
  if (previewSeconds > 0) previewBed(previewSeconds);
}

/** 背景音的起停。want=true 时淡入并循环，false 时淡出并停掉（不是一直挂着空转）。 */
export function setBed(want: boolean, fadeMs = 1200): void {
  if (!bedBuf) {
    // WebAudio 那条路没有可用的 buffer：用元素放。通话页照常工作，只是没有精确的淡入淡出。
    const el = bedElement();
    if (!el) return;
    if (want) { el.volume = Math.min(1, bedLevel * 2); void el.play().catch(() => { /* still blocked */ }); }
    else el.pause();
    return;
  }
  const c = audioCtx();
  if (!c) return;
  if (want) {
    if (!bed) {
      const gain = c.createGain();
      gain.gain.value = 0.0001;
      gain.connect(c.destination);
      bed = { gain, src: null };
    }
    if (!bed.src) {
      const src = c.createBufferSource();
      src.buffer = bedBuf;
      src.loop = true;
      src.connect(bed.gain);
      src.start();
      bed.src = src;
    }
    bed.gain.gain.cancelScheduledValues(c.currentTime);
    bed.gain.gain.setValueAtTime(Math.max(0.0001, bed.gain.gain.value), c.currentTime);
    bed.gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, bedLevel), c.currentTime + fadeMs / 1000);
    return;
  }
  if (!bed) return;
  const b = bed;
  bed = null;
  try {
    b.gain.gain.cancelScheduledValues(c.currentTime);
    b.gain.gain.setValueAtTime(Math.max(0.0001, b.gain.gain.value), c.currentTime);
    b.gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + fadeMs / 2000);
    const src = b.src;
    window.setTimeout(() => { try { src?.stop(); } catch { /* already */ } b.gain.disconnect(); }, fadeMs / 2 + 80);
  } catch { /* gone */ }
}

export function bedPlaying(): boolean {
  return Boolean(bed && bed.src) || Boolean(bedEl && !bedEl.paused);
}

/** 设置页的试听：放 3 秒背景音（走真实的 bed 通道，含淡入），停掉后再放打断音。 */
export function previewBed(seconds = 3): void {
  const c = audioCtx();
  if (!c) return;
  if (preview) { try { preview.stop(); } catch { /* already */ } preview = null; }
  if (!bedBuf) {
    const el = bedElement();
    if (!el) return;
    el.currentTime = 0;
    el.volume = Math.min(1, bedLevel * 2);
    void el.play().then(() => {
      window.setTimeout(() => { try { el.pause(); } catch { /* gone */ } }, seconds * 1000);
    }).catch(() => { /* blocked: 状态行会显示 */ });
    return;
  }
  try {
  const src = c.createBufferSource();
  const g = c.createGain();
  src.buffer = bedBuf;
  src.loop = true;
  // 试听放得比通话里响一档：目的是让人确认"这条音存在、能播"，不是复现通话的音量。
  const level = Math.min(1, Math.max(0.35, bedLevel * 1.8));
  g.gain.value = 0.0001;
  src.connect(g).connect(c.destination);
  g.gain.exponentialRampToValueAtTime(level, c.currentTime + 0.3);
  g.gain.setValueAtTime(level, c.currentTime + seconds);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + seconds + 0.2);
  src.start();
  src.stop(c.currentTime + seconds + 0.3);
  preview = src;
  } catch { /* scheduling refused: 调用方会把状态行显示出来 */ }
}

// 排障入口：控制台里 __sfx.previewBed() / __sfx.sfxStatus() 就能把这条链子照出来。
// 通话页里的声音听不见也看不见，没有这个入口只能靠猜（这一轮就是这么耗掉的）。
if (typeof window !== "undefined") {
  (window as unknown as { __sfx?: unknown }).__sfx = {
    loadSfx, previewBed, playCut, setBed, sfxStatus, bedPlaying, channel, getBedLevel, setBedLevel,
  };
}
