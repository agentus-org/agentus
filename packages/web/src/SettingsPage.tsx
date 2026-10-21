// Settings — the config that is not per-session: the palette, the speech endpoints
// (百炼 / any OpenAI-compatible one) and the hotword list that rides with recognition.
//
// Shape follows hermes-studio's settings surface (a full-width panel in the main area,
// grouped rows, a save that reports honestly) and AionUi's idea that a provider is a
// table entry rather than a code path. Two kinds of setting live here on purpose:
//   * server-side (settings.json): provider, endpoint, key, models, hotwords, theme —
//     they follow the operator to any browser;
//   * this browser (localStorage): the dictation engine and read-aloud — a phone and a
//     desktop do not have the same microphones or voices.
import { useCallback, useEffect, useRef, useState } from "react";
import { IconArrowLeft, IconClose, IconMic, IconRefresh, IconSettings, IconStop, IconVolume } from "./Icons";
import { pushTheme, useTheme, type ThemeConfig } from "./theme";
import { AccountPanels, type AccountInfo } from "./Account";
import { PLAN_GUIDANCE_VARIANTS } from "../../shared/src/index";
import { NotifySettings } from "./NotifySettings";
import { TrustCard } from "./TrustCard";
import { WebNotifySettings } from "./WebNotifySettings";
import { BackendsPanel } from "./BackendsPanel";
import {
  dictation, getVoicePrefs, loadVoiceCaps, NO_CAPS, playBlob, unlockAudio, useDictation,
  useVoicePrefs, voiceCaps, type VoiceCaps, type VoicePrefs,
} from "./voice";

/**
 * The settings surface is a category list, not one long scroll (the shape AionUi's settings menu
 * has): each group is a heading in the content and a block in the left rail, and every card is
 * reachable by anchor. The page order below is the reading order of the page — the rail is the
 * way in for someone who already knows what they came to change.
 *
 * `anchor` values are real element ids on the cards (some live inside the panels: AccountPanels
 * renders three cards, so its ids are set in Account.tsx).
 */
const SET_NAV: { id: string; label: string; hint: string; items: { anchor: string; label: string }[] }[] = [
  {
    id: "account", label: "账号与安全", hint: "谁能进这台驾驶舱",
    items: [
      { anchor: "set-account", label: "账号" },
      { anchor: "set-sessions", label: "登录会话" },
      { anchor: "set-locks", label: "登录失败锁定" },
    ],
  },
  {
    id: "agent", label: "智能体", hint: "槽位跑哪个后端",
    items: [
      { anchor: "set-backends", label: "后端" },
      { anchor: "set-lifecycle", label: "回收与热备" },
      { anchor: "set-plan", label: "计划提示" },
      { anchor: "set-cockpit", label: "驾驶舱互发" },
      { anchor: "set-observer", label: "观察智能体" },
    ],
  },
  {
    id: "notify", label: "通知", hint: "电脑上怎么收到",
    items: [
      { anchor: "set-webnotify", label: "网页通知（这台设备）" },
      { anchor: "set-notify", label: "手机通知（Android 伴侣）" },
      { anchor: "set-roots", label: "根证书（自签 HTTPS）" },
    ],
  },
  {
    id: "look", label: "外观", hint: "配色",
    items: [{ anchor: "set-theme", label: "主题" }],
  },
  {
    id: "voice", label: "语音", hint: "怎么听、怎么说",
    items: [
      { anchor: "set-asr", label: "语音识别（ASR）" },
      { anchor: "set-hotwords", label: "热词" },
      { anchor: "set-tts", label: "语音合成（TTS）" },
      { anchor: "set-summary", label: "语音总结" },
      { anchor: "set-browser", label: "这个浏览器" },
    ],
  },
];

interface SettingsView {
  provider: "browser" | "openai" | "dashscope";
  baseUrl: string;
  apiKeySet: boolean;
  apiKeyMasked: string;
  apiKeySource: string | null;
  asrModel: string;
  asrBatchModel: string;
  asrStream: boolean;
  ttsModel: string;
  ttsVoice: string;
  ttsFormat: "wav" | "mp3";
  hotwords: string[];
  dynamicHotwords: boolean;
  hotwordLimit: number;
  theme: ThemeConfig;
  themeDefaults: ThemeConfig;
  ttsVoices: string[];
  /** agent-process knobs (settings.agent): the idle-reclaim threshold + the 热备 floor, 0 = off */
  agent?: { idleKillMin: number; warmSlots?: number; warmTtlHours?: number; cockpitSend?: boolean; showSilentBackground?: boolean; recallItemChars?: number; recallTotalChars?: number };
  /** 观察智能体 (issue #16). The observer that turns 「回合结束了」 into one spoken line. */
  observer?: { enabled: boolean; backend: string | null; systemPrompt: string; throttleSec: number; intervalSec: number };
  observerDefaults?: { enabled: boolean; backend: string | null; systemPrompt: string; throttleSec: number };
  observerPromptDefault?: string;
  observerPromptMax?: number;
  summary?: { enabled: boolean; prompt: string; maxChars: number; followSession: boolean; model: string; timeoutSec: number };
  summaryPromptDefault?: string;
  summaryPromptMax?: number;
  summaryCharsRange?: [number, number];
  summaryTimeoutRange?: [number, number];
  summaryModelDefault?: string;
  observerThrottleRange?: [number, number];
  observerIntervalRange?: [number, number];
  agentDefaults?: { idleKillMin: number; warmSlots?: number; warmTtlHours?: number; cockpitSend?: boolean; showSilentBackground?: boolean; recallItemChars?: number; recallTotalChars?: number };
  agentIdleRange?: [number, number];
  agentWarmRange?: [number, number];
  agentWarmTtlRange?: [number, number];
  agentRecallItemRange?: [number, number];
  agentRecallTotalRange?: [number, number];
  /** The plan-tool hint (settings.prefs.planHint): whether the cockpit tells the agent about the
   *  plan MCP mounted on the session, how often, and in whose words. Server-read per prompt, so
   *  this applies to the very next turn. */
  prefs?: { planHint?: { on: boolean; everyTurn: boolean; instruction: string } };
  updatedAt: number;
}

interface Models {
  total: number;
  asr: string[];
  tts: string[];
}

interface HotwordList {
  words: { word: string; weight: number; origin: "fixed" | "dynamic" }[];
  fixed: number;
  dynamic: number;
  /** Natural-language turns the next recognition would carry as `input.context` — the other
   *  half of the request, which used to be 0 forever (issue #21). */
  contextTurns?: number;
}

/** The editable slice of the voice settings (hotwords as text, because that is how an
 *  operator writes a list). */
interface Draft {
  provider: SettingsView["provider"];
  baseUrl: string;
  asrModel: string;
  asrBatchModel: string;
  asrStream: boolean;
  ttsModel: string;
  ttsVoice: string;
  ttsFormat: "wav" | "mp3";
  dynamicHotwords: boolean;
  hotwordLimit: number;
  hotwordsText: string;
}

/** Accent presets. #4aacdf is the DEFAULT (theme.css `:root --accent`), so it is offered first and
 *  reachable after a custom colour; #76bbdf is the brand accent (assets/logo — the mark's nodes), so
 *  the cockpit can be tinted to match its own logo. The amber stays as a preset on purpose: an
 *  operator who liked the old default must be able to pick it back. Rest are variety. */
const ACCENTS = ["#4aacdf", "#ffb454", "#76bbdf", "#4ec9a0", "#8f7bd7", "#ff6b9d"];

function draftOf(v: SettingsView): Draft {
  return {
    provider: v.provider,
    baseUrl: v.baseUrl,
    asrModel: v.asrModel,
    asrBatchModel: v.asrBatchModel,
    asrStream: v.asrStream,
    ttsModel: v.ttsModel,
    ttsVoice: v.ttsVoice,
    ttsFormat: v.ttsFormat,
    dynamicHotwords: v.dynamicHotwords,
    hotwordLimit: v.hotwordLimit,
    hotwordsText: v.hotwords.join("\n"),
  };
}

const sameDraft = (a: Draft, b: Draft): boolean => JSON.stringify(a) === JSON.stringify(b);


export function SettingsPage({ onClose, sessionId }: { onClose: () => void; sessionId?: string }): JSX.Element {
  const theme = useTheme();
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [models, setModels] = useState<Models | null>(null);
  const [modelsErr, setModelsErr] = useState("");
  const [caps, setCaps] = useState<VoiceCaps>(NO_CAPS);
  const [hot, setHot] = useState<HotwordList | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [ttsText, setTtsText] = useState("Agentus 语音合成自测：龙安欢音色。");
  // account, sessions and login locks live in Account.tsx (their own endpoints, their own
  // loading); this page only carries the identity the 账号 card prints.
  const [acc, setAcc] = useState<AccountInfo | null>(null);
  const [prefs, setPrefs] = useVoicePrefs();
  const dict = useDictation();
  // 槽位回收与热备 (settings.agent). Its own immediate-save control like the prefs toggles: it is one
  // number that decides whether agent processes get killed, and making it ride the general 保存
  // button would leave the operator wondering whether it took effect.
  const [idleKill, setIdleKill] = useState<number | null>(null);
  const [idleMsg, setIdleMsg] = useState("");
  const [warmSlots, setWarmSlots] = useState<number | null>(null);
  const [warmTtl, setWarmTtl] = useState<number | null>(null);
  const [warmMsg, setWarmMsg] = useState("");
  // 记忆召回条目的两个上限（issue #37 的容量）：单条多少字、一轮总共多少字。不是格式化偏好 ——
  // 这两个数决定「每轮往库和 wire 里放多少字节」，所以放在设置里而不是写死在代码里。
  const [recallItem, setRecallItem] = useState<number | null>(null);
  const [recallTotal, setRecallTotal] = useState<number | null>(null);
  const [recallMsg, setRecallMsg] = useState("");
  const [planHint, setPlanHint] = useState<{ on: boolean; everyTurn: boolean; instruction: string } | null>(null);
  const [planHintMsg, setPlanHintMsg] = useState("");
  // 驾驶舱互发消息 — the write half of the cockpit CLI (server `settings.agent.cockpitSend`, default off).
  const [cockpitSend, setCockpitSend] = useState<boolean | null>(null);
  // 显示不唤醒的后台进程 (#35) — 默认关：后台任务行与 rail 角标回答的是「这个会话还在干活吗」,
  // 而静默进程是 agent 自己在轮询的活, 操作者不需要看见。
  const [showSilentBg, setShowSilentBg] = useState<boolean | null>(null);
  const [cockpitMsg, setCockpitMsg] = useState("");
  // 观察智能体 — the agent behind 工作播报 (issue #16). Every field saves on its own, like the
  // cockpit switch: this section's whole point is that the next brief sounds different.
  const [observer, setObserver] = useState<{ enabled: boolean; backend: string | null; systemPrompt: string; throttleSec: number; intervalSec: number } | null>(null);
  const [observerMsg, setObserverMsg] = useState("");
  // 语音总结 — the message speaker's long press. Saves on its own like the observer's card: the
  // whole point is that the next long press summarises differently.
  const [summary, setSummary] = useState<{ enabled: boolean; prompt: string; maxChars: number; followSession: boolean; model: string; timeoutSec: number } | null>(null);
  const [summaryMsg, setSummaryMsg] = useState("");
  const [backendOptions, setBackendOptions] = useState<{ id: string; label: string }[]>([]);

  const load = useCallback(async (): Promise<void> => {
    setErr("");
    try {
      const who = await fetch("/api/auth/me", { credentials: "same-origin" });
      if (who.ok) {
        const a = (await who.json().catch(() => ({}))) as Partial<AccountInfo>;
        if (a.configuredUsername) {
          setAcc({ configuredUsername: a.configuredUsername, credentialSource: a.credentialSource ?? "default",
                   minPasswordLen: a.minPasswordLen ?? 6, usingDefaultPassword: Boolean(a.usingDefaultPassword) });
        }
      }
      const res = await fetch("/api/settings", { credentials: "same-origin" });
      const data = (await res.json().catch(() => ({}))) as SettingsView & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `settings ${res.status}`);
      setView(data);
      setDraft((cur) => cur ?? draftOf(data));
      if (typeof data.agent?.idleKillMin === "number") setIdleKill(data.agent.idleKillMin);
      if (typeof data.agent?.warmSlots === "number") setWarmSlots(data.agent.warmSlots);
      if (typeof data.agent?.warmTtlHours === "number") setWarmTtl(data.agent.warmTtlHours);
      if (typeof data.agent?.recallItemChars === "number") setRecallItem(data.agent.recallItemChars);
      if (typeof data.agent?.recallTotalChars === "number") setRecallTotal(data.agent.recallTotalChars);
      if (data.prefs?.planHint) setPlanHint(data.prefs.planHint);
      if (typeof data.agent?.cockpitSend === "boolean") setCockpitSend(data.agent.cockpitSend);
      if (typeof data.agent?.showSilentBackground === "boolean") setShowSilentBg(data.agent.showSilentBackground);
      if (data.observer) setObserver(data.observer);
      if (data.summary) setSummary(data.summary);
      const be = await fetch("/api/backends", { credentials: "same-origin" })
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => []);
      setBackendOptions((Array.isArray(be) ? be : []).map((b: { id: string; label?: string }) => ({ id: b.id, label: b.label ?? b.id })));
      await loadVoiceCaps(true);
      setCaps(voiceCaps());
      const [m, h] = await Promise.all([
        fetch("/api/voice/models", { credentials: "same-origin" }),
        fetch(`/api/voice/hotwords${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`, { credentials: "same-origin" }),
      ]);
      if (m.ok) {
        setModels((await m.json()) as Models);
        setModelsErr("");
      } else {
        const d = (await m.json().catch(() => ({}))) as { error?: string };
        setModelsErr(d.error ?? `model list ${m.status}`);
      }
      if (h.ok) setHot((await h.json()) as HotwordList);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
  }, [sessionId]);

  useEffect(() => { void load(); }, [load]);

  const dirty = Boolean(view && draft && !sameDraft(draft, draftOf(view)));

  /** 槽位回收与热备 saves on its own (a number field, on blur): it is not part of the voice draft, and a
   *  half-typed number must never be stored — the server clamps the range again on its side. */
  const saveIdle = async (): Promise<void> => {
    if (idleKill == null) return;
    const [lo, hi] = view?.agentIdleRange ?? [0, 60];
    const v = Math.max(lo, Math.min(hi, Math.round(idleKill)));
    setIdleKill(v);
    setIdleMsg("");
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: { idleKillMin: v } }),
      });
      const data = (await res.json().catch(() => ({}))) as SettingsView & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `save failed (${res.status})`);
      setView(data);
      setIdleMsg(v === 0 ? "已保存：空闲槽位不再被回收。" : `已保存：空闲 ${v} 分钟后停掉 agent 进程。`);
    } catch (e) {
      setIdleMsg(`保存失败：${String((e as Error)?.message ?? e)}`);
    }
  };

  /** 热备 saves as ONE update: the count and its TTL are a single decision (a count without a TTL is
   *  a permanent ~700 MB floor), so a half-typed pair must never be stored. Same shape as `saveIdle`
   *  — on blur, outside the voice draft, server clamps the ranges again. */
  const saveWarm = async (): Promise<void> => {
    if (warmSlots == null && warmTtl == null) return;
    const [slo, shi] = view?.agentWarmRange ?? [0, 20];
    const [tlo, thi] = view?.agentWarmTtlRange ?? [0, 168];
    const n = Math.max(slo, Math.min(shi, Math.round(warmSlots ?? view?.agentDefaults?.warmSlots ?? 5)));
    const h = Math.max(tlo, Math.min(thi, Math.round(warmTtl ?? view?.agentDefaults?.warmTtlHours ?? 24)));
    setWarmSlots(n);
    setWarmTtl(h);
    setWarmMsg("");
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: { warmSlots: n, warmTtlHours: h } }),
      });
      const data = (await res.json().catch(() => ({}))) as SettingsView & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `save failed (${res.status})`);
      setView(data);
      setWarmMsg(
        n === 0
          ? "已保存：热备已关闭，只按上面的空闲时长回收。"
          : h === 0
            ? `已保存：最近 ${n} 个会话保底保活，不过期。`
            : `已保存：最近 ${n} 个会话保活，闲置超过 ${h} 小时才回收。`,
      );
    } catch (e) {
      setWarmMsg(`保存失败：${String((e as Error)?.message ?? e)}`);
    }
  };

  /** 召回条目的两个上限同样是一次保存：单条字数与一轮总量是一对（总量才是闸门），半存一半会让
   *  界面上的「12K」和实际生效的数对不上。范围在页面和 server 两边都夹一次。 */
  const saveRecall = async (): Promise<void> => {
    if (recallItem == null && recallTotal == null) return;
    const [ilo, ihi] = view?.agentRecallItemRange ?? [80, 2000];
    const [tlo, thi] = view?.agentRecallTotalRange ?? [2000, 60000];
    const i = Math.max(ilo, Math.min(ihi, Math.round(recallItem ?? view?.agentDefaults?.recallItemChars ?? 400)));
    const t = Math.max(tlo, Math.min(thi, Math.round(recallTotal ?? view?.agentDefaults?.recallTotalChars ?? 12000)));
    setRecallItem(i);
    setRecallTotal(t);
    setRecallMsg("");
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: { recallItemChars: i, recallTotalChars: t } }),
      });
      const data = (await res.json().catch(() => ({}))) as SettingsView & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `save failed (${res.status})`);
      setView(data);
      setRecallMsg(`已保存：单条最多 ${i} 字、一轮最多 ${t} 字（下一个回合生效）。`);
    } catch (e) {
      setRecallMsg(`保存失败：${String((e as Error)?.message ?? e)}`);
    }
  };

  /** 观察智能体 saves on its own. The backend list is fetched here rather than through the backends
   *  page's store: the card only needs id + label, and a select that lags behind a deleted backend is
   *  worse than a select that knows less. */
  const saveObserver = async (patch: Partial<{ enabled: boolean; backend: string | null; systemPrompt: string; throttleSec: number; intervalSec: number }>): Promise<void> => {
    const next = {
      enabled: observer?.enabled ?? false,
      backend: observer?.backend ?? null,
      systemPrompt: observer?.systemPrompt ?? "",
      throttleSec: observer?.throttleSec ?? 120,
      // Sent along on every save so this card can never silently reset the beat the speaker menu set
      // (the server applies only the keys it is given, but a missing key here would show a stale box).
      intervalSec: observer?.intervalSec ?? 0,
      ...patch,
    };
    setObserver(next);
    setObserverMsg("");
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ observer: next }),
      });
      const data = (await res.json().catch(() => ({}))) as SettingsView & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `save failed (${res.status})`);
      setView(data);
      if (data.observer) setObserver(data.observer);
      setObserverMsg("已保存：下一次播报就是新设置。");
    } catch (e) {
      setObserverMsg(`保存失败：${String((e as Error)?.message ?? e)}`);
    }
  };

  /** 语音总结 saves on its own, same rule as 观察智能体: one number or one sentence at a time, and the
   *  next long press already uses it (the server reads the section per request). */
  const saveSummary = async (patch: Partial<{ enabled: boolean; prompt: string; maxChars: number; followSession: boolean; model: string; timeoutSec: number }>): Promise<void> => {
    const next = {
      enabled: summary?.enabled ?? true,
      prompt: summary?.prompt ?? "",
      maxChars: summary?.maxChars ?? 120,
      followSession: summary?.followSession ?? true,
      model: summary?.model ?? "",
      timeoutSec: summary?.timeoutSec ?? 20,
      ...patch,
    };
    setSummary(next);
    setSummaryMsg("");
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ summary: next }),
      });
      const data = (await res.json().catch(() => ({}))) as SettingsView & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `save failed (${res.status})`);
      setView(data);
      if (data.summary) setSummary(data.summary);
      setSummaryMsg("已保存 —— 下一次长按就用新的设置。");
    } catch (e) {
      setSummaryMsg(`保存失败：${String((e as Error)?.message ?? e)}`);
    }
  };

  /** 驾驶舱互发消息 saves on its own too — and it is the ONE switch here whose subject is an agent
   *  talking to another agent, so the copy has to be blunt about what turning it on means. */
  const saveCockpitSend = async (next: boolean): Promise<void> => {
    setCockpitSend(next);
    setCockpitMsg("");
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: { cockpitSend: next } }),
      });
      const data = (await res.json().catch(() => ({}))) as SettingsView & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `save failed (${res.status})`);
      setView(data);
      setCockpitSend(Boolean(data.agent?.cockpitSend));
      setCockpitMsg(next ? "已保存：会话之间可以互发消息了（仅限空闲的会话）。" : "已保存：agent 只能读，不能给别的会话发消息。");
    } catch (e) {
      setCockpitSend(!next);
      setCockpitMsg(`保存失败：${String((e as Error)?.message ?? e)}`);
    }
  };

  /** 后台任务行的降噪开关 (#35). Same shape as cockpitSend: optimistic local state, then the
   *  server's answer wins; a failed save puts the checkbox back rather than lying. */
  const saveShowSilentBg = async (next: boolean): Promise<void> => {
    setShowSilentBg(next);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: { showSilentBackground: next } }),
      });
      const data = (await res.json().catch(() => ({}))) as SettingsView & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `save failed (${res.status})`);
      setView(data);
      setShowSilentBg(Boolean(data.agent?.showSilentBackground));
    } catch {
      setShowSilentBg(!next);
    }
  };

  /** 计划提示注入 saves on its own, like the lifecycle numbers: it is not part of the voice draft
   *  and it must apply to the next turn, not to the next 保存. */
  const savePlanHint = async (patch: { on?: boolean; everyTurn?: boolean; instruction?: string }): Promise<void> => {
    const next = {
      on: planHint?.on ?? true,
      // Defaults mirror PREFS_DEFAULT on the server (on + every turn).
      everyTurn: planHint?.everyTurn ?? true,
      instruction: planHint?.instruction ?? "",
      ...patch,
    };
    setPlanHint(next);
    setPlanHintMsg("");
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prefs: { planHint: next } }),
      });
      const data = (await res.json().catch(() => ({}))) as SettingsView & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `save failed (${res.status})`);
      setView(data);
      setPlanHint(data.prefs?.planHint ?? next);
      setPlanHintMsg(
        !next.on
          ? "已保存：prompt 里不再追加计划提示。"
          : next.everyTurn
            ? "已保存：每回合都提醒 agent 用 update_plan。"
            : "已保存：只在每个 agent 进程的首条提醒一次。",
      );
    } catch (e) {
      setPlanHintMsg(`保存失败：${String((e as Error)?.message ?? e)}`);
    }
  };

  const save = async (): Promise<boolean> => {
    if (!draft) return false;
    setBusy("save");
    setErr("");
    setMsg("");
    try {
      const voice: Record<string, unknown> = {
        ...draft,
        hotwords: draft.hotwordsText.split("\n").map((s) => s.trim()).filter(Boolean),
      };
      delete voice.hotwordsText;
      if (keyInput.trim()) voice.apiKey = keyInput.trim();
      const res = await fetch("/api/settings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ voice }),
      });
      const data = (await res.json().catch(() => ({}))) as SettingsView & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `save failed (${res.status})`);
      setView(data);
      setDraft(draftOf(data));
      setKeyInput("");
      await loadVoiceCaps(true);
      setCaps(voiceCaps());
      const h = await fetch(`/api/voice/hotwords${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`, { credentials: "same-origin" });
      if (h.ok) setHot((await h.json()) as HotwordList);
      setMsg("已保存");
      window.setTimeout(() => setMsg(""), 2500);
      return true;
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
      return false;
    } finally {
      setBusy("");
    }
  };

  const pickTheme = async (next: ThemeConfig): Promise<void> => {
    const problem = await pushTheme(next);
    if (problem) setErr(problem);
  };

  const testTts = async (): Promise<void> => {
    // Unlock playback BEFORE the first await: the gesture is what buys the permission,
    // and the synthesis round trip is longer than Chrome's activation window.
    await unlockAudio();
    if (dirty && !(await save())) return;
    setBusy("tts");
    setErr("");
    setMsg("");
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: ttsText, voice: draft?.ttsVoice }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? `tts ${res.status}`);
      }
      const blob = await res.blob();
      await playBlob(blob);
      setMsg(`合成成功 · ${blob.type || "audio"} · ${Math.round(blob.size / 1024)} KB`);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  };

  const testStt = (): void => {
    setErr("");
    void dictation.start(getVoicePrefs(), sessionId);
  };

  const reloadModels = async (): Promise<void> => {
    setBusy("models");
    setModelsErr("");
    try {
      const res = await fetch("/api/voice/models", { credentials: "same-origin" });
      const data = (await res.json().catch(() => ({}))) as Models & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `model list ${res.status}`);
      setModels(data);
      setMsg(`endpoint 报告 ${data.total} 个模型`);
    } catch (e) {
      setModelsErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  };

  const field = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft((cur) => (cur ? { ...cur, [key]: value } : cur));
  };

  const listening = dict.status === "listening" || dict.status === "requesting" || dict.status === "recording";

  // ---- the category rail: one page at a time (AionUi's settings shape) ----
  //
  // Switching category hides the other groups rather than unmounting them: these cards hold
  // in-flight state (a backend row being edited, a loaded device list, the account snapshot), and
  // a settings page that throws a draft away because you glanced at another category is worse than
  // one that keeps a few hidden nodes around. Hiding is CSS; the anchor ids stay live, so a link
  // into a specific card still works from outside.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [navCat, setNavCat] = useState<string>(SET_NAV[0].id);
  const [navActive, setNavActive] = useState<string>(SET_NAV[0].items[0].anchor);

  const openCat = useCallback((id: string): void => {
    const group = SET_NAV.find((g) => g.id === id);
    setNavCat(id);
    setNavActive(group?.items[0]?.anchor ?? "");
    // a category is a page: it opens at its top, not at wherever the last one was scrolled to
    bodyRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  const jump = useCallback((anchor: string): void => {
    document.getElementById(anchor)?.scrollIntoView({ block: "start", behavior: "smooth" });
    setNavActive(anchor);
  }, []);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    // Only the OPEN category's cards can be "the one being read": the others are hidden (a hidden
    // card reports a zero-height rect), and including them would make the spy jump to the last
    // anchor of the whole page.
    const anchors = (SET_NAV.find((g) => g.id === navCat)?.items ?? []).map((i) => i.anchor);
    if (!anchors.length) return;
    const onScroll = (): void => {
      const top = body.getBoundingClientRect().top;
      let current = anchors[0];
      for (const a of anchors) {
        const el = document.getElementById(a);
        if (el && el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().top - top <= 32) current = a;
      }
      // The end of the page reads as the last card: a short final one never crosses the fold.
      if (body.scrollTop + body.clientHeight >= body.scrollHeight - 4) current = anchors[anchors.length - 1];
      setNavActive((prev) => (prev === current ? prev : current));
    };
    body.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => body.removeEventListener("scroll", onScroll);
  }, [navCat]);

  return (
    <div className="main">
      <div className="chat-head set-head">
        <button className="icon-btn" onClick={onClose} title="返回会话" aria-label="back"><IconArrowLeft size={16} /></button>
        <span className="title"><IconSettings size={14} /> 设置</span>
        <span className="head-spacer" />
        {msg ? <span className="set-toast">{msg}</span> : null}
        <button className="set-save" onClick={() => void save()} disabled={busy === "save" || !dirty}>
          {busy === "save" ? "保存中…" : dirty ? "保存" : "已保存"}
        </button>
      </div>
      <div className="set-main">
        <nav className="set-nav" aria-label="设置分类">
          {SET_NAV.map((g) => (
            <div className="set-nav-group" key={g.id}>
              <button
                type="button"
                className={`set-nav-cat ${navCat === g.id ? "on" : ""}`}
                aria-current={navCat === g.id ? "page" : undefined}
                onClick={() => openCat(g.id)}
                title={g.hint}
              >
                {g.label}
              </button>
              {/* sub-entries of the OPEN category only: with one page at a time, a closed
                  category's items would have nowhere to point */}
              {navCat === g.id
                ? g.items.map((item) => (
                    <button
                      type="button"
                      key={item.anchor}
                      className={`set-nav-item ${navActive === item.anchor ? "on" : ""}`}
                      aria-current={navActive === item.anchor ? "true" : undefined}
                      onClick={() => jump(item.anchor)}
                    >
                      {item.label}
                    </button>
                  ))
                : null}
            </div>
          ))}
        </nav>
        <div className="set-body" ref={bodyRef} data-cat={navCat} data-set-scroll>
        {err ? (
          <div className="set-err" role="alert">
            {err}
            <button className="draft-x" onClick={() => setErr("")} aria-label="dismiss"><IconClose size={11} /></button>
          </div>
        ) : null}

        <h4 className="set-group" id="grp-account" data-setgroup="account">账号与安全</h4>
        {/* ---------- 账号 / 登录会话 / 登录失败锁定 ---------- */}
        <AccountPanels
          account={acc}
          onChanged={(next) => setAcc((cur) => (cur ? { ...cur, ...next } : cur))}
        />

        <h4 className="set-group" id="grp-agent" data-setgroup="agent">智能体</h4>
        {/* ---------- 后端：用哪个命令 / 哪个 home / 哪个 profile（M6） ---------- */}
        <BackendsPanel />

        <h4 className="set-group" id="grp-notify" data-setgroup="notify">通知</h4>
        {/* ---------- 网页通知（浏览器系统通知，本机设置） ---------- */}
        <WebNotifySettings />
        {/* ---------- 手机通知（Android 伴侣 + 推送规则） ---------- */}
        <NotifySettings sessionId={sessionId} />
        {/* ---------- 根证书：手机/电脑装一次就不再报「不是私密连接」 ---------- */}
        <TrustCard />

        <h4 className="set-group" id="grp-look" data-setgroup="look">外观</h4>
        {/* ---------- 主题 ---------- */}
        <section className="set-card" id="set-theme" data-setgroup="look">
          <h3>主题</h3>
          <p className="set-hint">
            亮/暗跟随系统；强调色会重新给整套驾驶舱上色（按钮、链接、流式光标、用量环）。
            选择存在服务端，换一台设备也一致。
          </p>
          <div className="set-row">
            <label>外观</label>
            <div className="set-seg" role="group" aria-label="theme mode">
              {([["system", "跟随系统"], ["light", "亮"], ["dark", "暗"]] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={theme.mode === value ? "on" : ""}
                  aria-pressed={theme.mode === value}
                  onClick={() => void pickTheme({ ...theme, mode: value })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="set-row">
            <label>强调色</label>
            <div className="set-swatches">
              {ACCENTS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`set-swatch ${theme.accent === c ? "on" : ""}`}
                  style={{ background: c }}
                  title={c}
                  aria-label={`accent ${c}`}
                  onClick={() => void pickTheme({ ...theme, accent: c })}
                />
              ))}
              <input
                type="color"
                className="set-color"
                value={theme.accent || "#4aacdf"}
                onChange={(e) => void pickTheme({ ...theme, accent: e.target.value })}
                aria-label="custom accent"
              />
              <button type="button" className="set-mini" onClick={() => void pickTheme({ ...theme, accent: "" })}>默认</button>
            </div>
          </div>
        </section>

        <h4 className="set-group" id="grp-voice" data-setgroup="voice">语音</h4>
        {/* ---------- 语音识别 ---------- */}
        {/* ---------- 槽位回收与热备（智能体） ---------- */}
        <section className="set-card" id="set-lifecycle" data-setgroup="agent">
          <h3>槽位回收与热备</h3>
          <p className="set-hint">
            空闲超过这个时长后，自动停掉槽位的 <b>agent 进程</b> 以释放内存 —— 对话记录、模型、思考深度全都
            保留，点一下该槽位就会重新起来（状态显示「已回收（空闲）」）。这是「回收进程」，不是「归档会话」：
            归档只在你手动点击时发生，两者互不影响。数值对齐 AionUi 的「Agent 空闲超时」，<b>0 = 关闭</b>。
          </p>
          <p className="set-hint">
            下面的 <b>热备</b> 是保底，不是上限：最近 N 个会话即使空闲也留着进程 —— 「我只是离开浏览器」
            不该丢掉刚才那个会话的 agent。名额自己也有寿命（小时），超时照样回收：5 个热备 × 约 137 MB
            ≈ 700 MB，这就是它默认 24 小时过期的原因。正在跑回合、等你审批、你正看着的会话从不被回收。
          </p>
          <div className="set-row">
            <label>Agent 空闲超时（分钟）</label>
            <div className="set-pair">
              <input
                className="set-num"
                type="number"
                min={view?.agentIdleRange?.[0] ?? 0}
                max={view?.agentIdleRange?.[1] ?? 60}
                step={5}
                value={idleKill ?? view?.agentDefaults?.idleKillMin ?? 5}
                onChange={(e) => setIdleKill(Number(e.target.value))}
                onBlur={() => void saveIdle()}
              />
              <span className="set-hint">
                {idleKill === 0
                  ? "已关闭：空闲的槽位不会被回收（长跑任务可以这么做）"
                  : `空闲 ${idleKill ?? view?.agentDefaults?.idleKillMin ?? 5} 分钟后回收`}
              </span>
            </div>
          </div>
          <div className="set-row">
            <label>热备槽位（最近 N 个）</label>
            <div className="set-pair">
              <input
                className="set-num"
                type="number"
                min={view?.agentWarmRange?.[0] ?? 0}
                max={view?.agentWarmRange?.[1] ?? 20}
                step={1}
                value={warmSlots ?? view?.agentDefaults?.warmSlots ?? 5}
                onChange={(e) => setWarmSlots(Number(e.target.value))}
                onBlur={() => void saveWarm()}
              />
              <span className="set-hint">
                {warmSlots === 0
                  ? "已关闭：没有保底名额，只按上面的空闲时长回收"
                  : `最近 ${warmSlots ?? view?.agentDefaults?.warmSlots ?? 5} 个会话即使空闲也不回收`}
              </span>
            </div>
          </div>
          <div className="set-row">
            <label>热备最长闲置（小时）</label>
            <div className="set-pair">
              <input
                className="set-num"
                type="number"
                min={view?.agentWarmTtlRange?.[0] ?? 0}
                max={view?.agentWarmTtlRange?.[1] ?? 168}
                step={1}
                value={warmTtl ?? view?.agentDefaults?.warmTtlHours ?? 24}
                onChange={(e) => setWarmTtl(Number(e.target.value))}
                onBlur={() => void saveWarm()}
              />
              <span className="set-hint">
                {warmTtl === 0
                  ? "不过期：一直留着（内存也就一直占着）"
                  : `闲置超过 ${warmTtl ?? view?.agentDefaults?.warmTtlHours ?? 24} 小时，连热备名额也停掉`}
              </span>
            </div>
          </div>
          {idleMsg ? <p className="set-hint">{idleMsg}</p> : null}
          {warmMsg ? <p className="set-hint">{warmMsg}</p> : null}
          <div className="set-row">
            <label>召回条目：单条字数</label>
            <div className="set-pair">
              <input
                className="set-num"
                type="number"
                min={view?.agentRecallItemRange?.[0] ?? 80}
                max={view?.agentRecallItemRange?.[1] ?? 2000}
                step={50}
                value={recallItem ?? view?.agentDefaults?.recallItemChars ?? 400}
                onChange={(e) => setRecallItem(Number(e.target.value))}
                onBlur={() => void saveRecall()}
              />
              <span className="set-hint">
                展开「N 条」后每条最多 {recallItem ?? view?.agentDefaults?.recallItemChars ?? 400} 字，超了截断
              </span>
            </div>
          </div>
          <div className="set-row">
            <label>召回条目：一轮总字数</label>
            <div className="set-pair">
              <input
                className="set-num"
                type="number"
                min={view?.agentRecallTotalRange?.[0] ?? 2000}
                max={view?.agentRecallTotalRange?.[1] ?? 60000}
                step={1000}
                value={recallTotal ?? view?.agentDefaults?.recallTotalChars ?? 12000}
                onChange={(e) => setRecallTotal(Number(e.target.value))}
                onBlur={() => void saveRecall()}
              />
              <span className="set-hint">
                不按条数限制，只按这个总量截：短记忆能多进几条，长记忆少进几条
              </span>
            </div>
          </div>
          {recallMsg ? <p className="set-hint">{recallMsg}</p> : null}
        </section>

        <section className="set-card" id="set-plan" data-setgroup="agent">
          <h3>计划提示注入</h3>
          <p className="set-hint">
            驾驶舱给每个会话挂了一个 <b>plan MCP</b>（工具名 <code>update_plan</code>），会话卡片上那份计划就是它写进来的。
            问题出在最后一公里：这类工具在 agent 侧是<b>懒加载</b>的 —— 它自己的工具描述写着「优先于你自带的 todo」，
            但模型不去检索就永远看不到这句话，于是 agent 全程用自己那个「进程一死就没了、驾驶舱也看不见」的 todo，
            计划卡片一直是空的。
          </p>
          <p className="set-hint">
            打开后，驾驶舱会在你那条消息的尾部追加一小段指引，告诉 agent 这个工具存在、多步任务应当用它发布并逐步更新、
            以及懒加载时怎么检索到它。做法对齐 Hermes Studio 的<b>每回合注入</b> —— 它就是这么做到 agent 爱用的。
            <b>关掉后，prompt 里只有你自己打的那句话。</b>改完立刻对下一个回合生效，不用重启会话。
          </p>
          <div className="set-row">
            <label>注入计划使用提示</label>
            <div className="set-pair">
              <input
                type="checkbox"
                checked={planHint?.on ?? true}
                onChange={(e) => void savePlanHint({ on: e.target.checked })}
              />
              <span className="set-hint">
                {planHint?.on ?? true
                  ? "已开启：让 agent 知道该用 update_plan 维护计划"
                  : "已关闭：prompt 不再被追加任何内容"}
              </span>
            </div>
          </div>
          <div className="set-row">
            <label>注入频率</label>
            <div className="set-pair">
              <select
                className="set-select"
                value={(planHint?.everyTurn ?? true) ? "every" : "first"}
                disabled={!(planHint?.on ?? true)}
                onChange={(e) => void savePlanHint({ everyTurn: e.target.value === "every" })}
              >
                <option value="every">每回合（默认，对齐 Studio）</option>
                <option value="first">仅每个 agent 进程的首条（省 token）</option>
              </select>
            </div>
          </div>
          <div className="set-row">
            <label>注入内容</label>
          </div>
          <textarea
            className="set-textarea"
            rows={6}
            spellCheck={false}
            disabled={!(planHint?.on ?? true)}
            value={planHint?.instruction ?? ""}
            placeholder="留空即用内置文案 —— 原文就在下面「内置文案」里，能直接看、能照着改。"
            onChange={(e) =>
              setPlanHint((p) => ({ ...(p ?? { on: true, everyTurn: true, instruction: "" }), instruction: e.target.value }))
            }
            onBlur={(e) => void savePlanHint({ instruction: e.target.value })}
          />
          {/* The box above is an OVERRIDE, so an empty one is the normal case — which used to leave
              the operator with a paraphrase in the placeholder and no way to read what actually goes
              out. Show the real strings, from the same constant the server injects (shared). */}
          <details className="set-builtin" open={!planHint?.instruction?.trim()}>
            <summary>
              {planHint?.instruction?.trim()
                ? "内置文案（你写了自定义的，下面这些不再生效；清空即可恢复）"
                : "内置文案（留空时生效的就是它，按情况三选一）"}
            </summary>
            <p className="set-hint">
              驾驶舱按这次的情况挑一条，接在「这次还有哪些步骤没做完」后面一起发给你那条消息的尾部。
              内容会随计划变，所以这里只列<b>指引</b>那半段的原文。
            </p>
            {PLAN_GUIDANCE_VARIANTS.map((v) => (
              <div className="set-builtin-item" key={v.id}>
                <div className="set-builtin-when">{v.when}</div>
                <pre className="set-builtin-text">{v.text}</pre>
              </div>
            ))}
          </details>
          <p className="set-hint">
            这里写的只是<b>指引</b>那一半（告诉 agent 有个计划工具、该怎么用它）。另一半是<b>计划状态</b> ——
            「哪些步骤还没做完」，那是每个回合从驾驶舱的计划卡片现取的，任何人都改不了，所以这里的文字永远不会和卡片说的不一样。
            清空即恢复内置文案。
          </p>
          <p className="set-hint">
            没有计划可提醒时不会硬凑字数：频率选「每回合」也只在该会话确有未完成计划时才重复注入；
            一步就能做完的请求不受影响。没注入过的那次不会作废，打开开关或从「仅首条」切回来的那一回合会补上。
          </p>
          {planHintMsg ? <p className="set-hint">{planHintMsg}</p> : null}
        </section>

        <section className="set-card" id="set-observer" data-setgroup="agent">
          <h3>观察智能体（工作播报）</h3>
          <p className="set-hint">
            「工作播报」不是把长回复念一遍，而是由一个<b>观察员</b>念一句进展。它就是一个普通的 ACP 会话，
            每个被观察的会话配一个，<b>常驻、上下文连续</b>：第一次看完之后它就记得这个会话在做什么，
            之后每次只收到一行触发语（「这一轮结束了，看看进展」）。
          </p>
          <p className="set-hint">
            事实<b>全靠它自己查</b>：它用 <code>$AGENTUS_COCKPIT_BIN</code> 读会话、消息尾部、计划、待审批，
            驾驶舱<b>不塞任何现成数据</b>进去 —— 这样播报不会跟着我们的模板一起说错。
            它跑在自己的<b>草稿目录</b>里（<code>~/.hermes/agentus/observers/&lt;会话 id&gt;</code>），
            不看你的项目目录，也不出现在会话列表里。
          </p>
          <p className="set-hint">
            花钱的地方只有一处：<b>回合结束</b>时让它写一句。待审批、计划里完成一步这类事件是现成的事实，
            驾驶舱直接念，<b>不花 token</b>。观察员起不来时，会降级成 #11 的那句「会话名 · 任务名」。
          </p>
          <div className="set-row">
            <label>启用观察员</label>
            <div className="set-pair">
              <input
                type="checkbox"
                checked={observer?.enabled ?? false}
                onChange={(e) => void saveObserver({ enabled: e.target.checked })}
              />
              <span className="set-hint">
                {observer?.enabled
                  ? "已启用：回合结束时由它念一句进展"
                  : "已关闭：播报降级成「会话名 · 任务名」，不起任何模型"}
              </span>
            </div>
          </div>
          <div className="set-row">
            <label>用哪个后端跑它</label>
            <div className="set-pair">
              <select
                className="set-select"
                value={observer?.backend ?? ""}
                disabled={!(observer?.enabled ?? false)}
                onChange={(e) => void saveObserver({ backend: e.target.value || null })}
              >
                <option value="">跟被观察的会话同一个后端（默认）</option>
                {backendOptions.map((b) => (
                  <option key={b.id} value={b.id}>{b.label}</option>
                ))}
              </select>
              <span className="set-hint">建议挑一个便宜、快的模型 —— 它只做「看一眼、说一句」。</span>
            </div>
          </div>
          <div className="set-row">
            <label>同一会话最短间隔（秒）</label>
            <div className="set-pair">
              <input
                className="set-num"
                type="number"
                min={view?.observerThrottleRange?.[0] ?? 0}
                max={view?.observerThrottleRange?.[1] ?? 3600}
                step={30}
                value={observer?.throttleSec ?? 120}
                onChange={(e) => setObserver((o) => (o ? { ...o, throttleSec: Number(e.target.value) } : o))}
                onBlur={(e) => void saveObserver({ throttleSec: Number(e.target.value) })}
              />
              <span className="set-hint">0 = 每回合都播报；待审批这类零成本事件不受它限制。</span>
            </div>
          </div>
          <div className="set-row">
            <label>节拍（每 N 秒报一次）</label>
            <div className="set-pair">
              <input
                className="set-num"
                type="number"
                min={view?.observerIntervalRange?.[0] ?? 0}
                max={view?.observerIntervalRange?.[1] ?? 3600}
                step={30}
                value={observer?.intervalSec ?? 0}
                onChange={(e) => setObserver((o) => (o ? { ...o, intervalSec: Number(e.target.value) } : o))}
                onBlur={(e) => void saveObserver({ intervalSec: Number(e.target.value) })}
              />
              <span className="set-hint">
                0 = 关（只在回合结束、待审批时说）。设了节拍之后，<b>只有「有任务在跑」</b>时才按节拍说话 ——
                空闲的会话不报平安；同一个回合最多 8 条。顶部喇叭长按也能直接选 1/2/5 分钟。
              </span>
            </div>
          </div>
          <div className="set-row">
            <label>它的设定（system prompt）</label>
          </div>
          <textarea
            className="set-textarea"
            rows={6}
            spellCheck={false}
            disabled={!(observer?.enabled ?? false)}
            value={observer?.systemPrompt ?? ""}
            placeholder="留空即用内置模板 —— 原文就在下面，能直接看、能照着改。"
            onChange={(e) => setObserver((o) => (o ? { ...o, systemPrompt: e.target.value } : o))}
            onBlur={(e) => void saveObserver({ systemPrompt: e.target.value })}
          />
          <details className="set-builtin" open={!(observer?.systemPrompt ?? "").trim()}>
            <summary>
              {(observer?.systemPrompt ?? "").trim()
                ? "内置模板（你写了自定义的，它不再生效；清空即可恢复）"
                : "内置模板（留空时生效的就是它）"}
            </summary>
            <pre className="set-builtin-text">{view?.observerPromptDefault ?? ""}</pre>
          </details>
          <p className="set-hint">
            你写的设定之后会自动补上一句「你负责的会话 id 是 …」，那一句不能改 —— 观察员靠它才知道看哪一个。
            改完立刻对下一次播报生效，不用重启会话。
          </p>
          {observerMsg ? <p className="set-hint">{observerMsg}</p> : null}
        </section>


        <section className="set-card" id="set-cockpit" data-setgroup="agent">
          <h3>驾驶舱互发消息（cockpit CLI）</h3>
          <p className="set-hint">
            每个会话里的 agent 都拿到了一个本机命令 <code>$AGENTUS_COCKPIT_BIN</code>，可以用它
            <b>读</b> 这个驾驶舱：有哪些会话、谁在跑、各自的消息尾部、计划、正在等哪个审批。
            数据面只做选择和截断，不做摘要、不改写 —— 会转述驾驶舱的机器就会说错驾驶舱。
          </p>
          <p className="set-hint">
            下面这个开关管的是另一半：<b>往别的会话里发消息</b>。默认关，因为两个 agent 互相回话
            会变成一台烧 token 的循环生成器。打开后也只对<b>空闲</b>会话生效 —— 正在跑回合的会话会
            直接拒绝（<code>target_busy</code>），<b>绝不抢占你开的那一轮</b>；已回收/归档的会话也拒绝
            （<code>target_cold</code> / <code>out_of_scope</code>），驾驶舱不会替你把它唤醒。
          </p>
          <div className="set-row">
            <label>允许会话之间互发消息</label>
            <div className="set-pair">
              <input
                type="checkbox"
                checked={cockpitSend ?? false}
                onChange={(e) => void saveCockpitSend(e.target.checked)}
              />
              <span className="set-hint">
                {cockpitSend
                  ? "已开启：agent 可以给空闲会话留话（对方不一定读、也不一定回）"
                  : "已关闭：agent 只能读驾驶舱，不能往里写"}
              </span>
            </div>
          </div>
          <p className="set-hint">
            这个通道的身份是<b>随进程发的一次性令牌</b>（放在环境变量里，不进命令行、不进 <code>ps</code>），
            进程一死就失效；也只听本机回环地址。改动立刻对下一轮生效，不用重启会话。
          </p>
          {cockpitMsg ? <p className="set-hint">{cockpitMsg}</p> : null}
        </section>

        <section className="set-card" id="set-background" data-setgroup="agent">
          <h3>后台任务行</h3>
          <p className="set-hint">
            后台任务行和会话轨上的 <b>⚡ 角标</b>默认只显示<b>会唤醒 agent 的进程</b>
            （<code>notify_on_complete</code>）—— 那种进程意味着 agent 没有真正收工，它还在等这次
            结果回来继续干活，所以那一行是绿的、会呼吸，会话也保持「进行中」。
          </p>
          <p className="set-hint">
            静默进程（agent 自己轮询取结果、不打算被唤醒的那种）默认不显示：它们只是噪音，
            会把「这个会话还要不要我看」这个问题淹没。打开下面的开关就会显示全部，
            包括跑完就静默消失的那些。
          </p>
          <div className="set-row">
            <label>显示不唤醒的后台进程</label>
            <div className="set-pair">
              <input
                type="checkbox"
                checked={showSilentBg ?? false}
                onChange={(e) => void saveShowSilentBg(e.target.checked)}
              />
              <span className="set-hint">
                {showSilentBg
                  ? "已开启：所有后台进程都显示（静默型跑完即消失）"
                  : "已关闭：只显示会唤醒会话的进程"}
              </span>
            </div>
          </div>
          <p className="set-hint">
            需要带这个标记的后端（Hermes fork <code>agentus/v0.22.0/merge-*</code> 那一版起）。
            旧后端不发这个字段，于是所有进程都被当作静默型 —— 那时这一行不会出现，
            开关也没有东西可显示。
          </p>
        </section>

        <section className="set-card" id="set-asr" data-setgroup="voice">
          <h3>语音识别（ASR）</h3>
          <p className="set-hint">
            当前生效：<b>{caps.provider}</b>
            {caps.stt.streaming ? " · 流式" : ""}
            {caps.stt.server ? ` · ${caps.stt.streaming ? caps.stt.model : caps.stt.batchModel}` : " · 未配置（只能用浏览器自带识别）"}
          </p>
          <div className="set-row">
            <label>提供方</label>
            <select
              className="set-select"
              value={draft?.provider ?? "browser"}
              onChange={(e) => field("provider", e.target.value as Draft["provider"])}
            >
              <option value="dashscope">阿里百炼（DashScope，本文档默认）</option>
              <option value="openai">OpenAI 兼容端点</option>
              <option value="browser">浏览器自带（不经过服务端）</option>
            </select>
          </div>
          <div className="set-row">
            <label>端点</label>
            <input
              className="set-input"
              placeholder="https://llm-xxxx.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
              value={draft?.baseUrl ?? ""}
              onChange={(e) => field("baseUrl", e.target.value)}
              spellCheck={false}
            />
          </div>
          <div className="set-row">
            <label>API Key</label>
            <input
              className="set-input"
              type="password"
              placeholder={view?.apiKeySet ? `已保存 ${view.apiKeyMasked}（留空不改）` : "sk-…"}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          {view?.apiKeySource ? (
            <p className="set-hint">密钥来自环境：<code>{view.apiKeySource}</code>（<code>DASHSCOPE_API_KEY</code> / <code>DASHSCOPE_BASE_URL</code>）</p>
          ) : null}
          <div className="set-row">
            <label>流式模型</label>
            <div className="set-pair">
              <input className="set-input" list="asr-models" value={draft?.asrModel ?? ""} onChange={(e) => field("asrModel", e.target.value)} spellCheck={false} />
              <label className="set-check">
                <input type="checkbox" checked={Boolean(draft?.asrStream)} onChange={(e) => field("asrStream", e.target.checked)} />
                启用流式（边说边出字）
              </label>
            </div>
          </div>
          <div className="set-row">
            <label>批量模型</label>
            <input className="set-input" list="asr-models" value={draft?.asrBatchModel ?? ""} onChange={(e) => field("asrBatchModel", e.target.value)} spellCheck={false} />
          </div>
          <datalist id="asr-models">
            {(models?.asr ?? []).map((m) => <option key={m} value={m} />)}
          </datalist>
          <p className="set-hint">
            {modelsErr
              ? `无法读取端点模型列表：${modelsErr}`
              : models
                ? `端点报告 ${models.total} 个模型，其中识别类 ${models.asr.length} 个（上面可直接选，也可以手填任意 id）`
                : "正在读取端点模型列表…"}
            <button className="set-mini" onClick={() => void reloadModels()} disabled={busy === "models"}>
              <IconRefresh size={11} /> 重新读取
            </button>
          </p>
        </section>

        {/* ---------- 热词 ---------- */}
        <section className="set-card" id="set-hotwords" data-setgroup="voice">
          <h3>热词</h3>
          <p className="set-hint">
            固定热词每行一个，可写 <code>词=权重</code>（1–5，<code>50</code> 是超级热词）；
            动态热词从当前会话的上下文里自动抽取高频实体词，一起送进识别。
          </p>
          <textarea
            className="set-textarea"
            rows={5}
            placeholder={"Agentus=5\nACP\nqodercli"}
            value={draft?.hotwordsText ?? ""}
            onChange={(e) => field("hotwordsText", e.target.value)}
            spellCheck={false}
          />
          <div className="set-row">
            <label>动态热词</label>
            <div className="set-pair">
              <label className="set-check">
                <input type="checkbox" checked={Boolean(draft?.dynamicHotwords)} onChange={(e) => field("dynamicHotwords", e.target.checked)} />
                从上下文抽取
              </label>
              <label className="set-check">
                上限
                <input
                  className="set-num"
                  type="number"
                  min={0}
                  max={200}
                  value={draft?.hotwordLimit ?? 30}
                  onChange={(e) => field("hotwordLimit", Number(e.target.value))}
                />
              </label>
            </div>
          </div>
          <div className="set-hot">
            <span className="set-hot-title">
              {hot
                ? `下次识别携带 ${hot.words.length} 个热词（固定 ${hot.fixed} / 动态 ${hot.dynamic}）` +
                  `，上下文 ${hot.contextTurns ?? 0} 轮`
                : "…"}
            </span>
            <div className="set-hot-list">
              {(hot?.words ?? []).slice(0, 40).map((w) => (
                <span key={`${w.origin}-${w.word}`} className={`set-chip ${w.origin}`} title={`${w.origin} · 权重 ${w.weight}`}>
                  {w.word}
                  {w.weight >= 5 ? <b>{w.weight === 50 ? "50" : w.weight}</b> : null}
                </span>
              ))}
              {hot && !hot.words.length ? <span className="set-hint">还没有热词：写几个固定词，或先聊两句再回来看动态抽取。</span> : null}
            </div>
          </div>
        </section>

        {/* ---------- 语音合成 ---------- */}
        <section className="set-card" id="set-summary" data-setgroup="voice">
          <h3>语音总结（消息喇叭长按）</h3>
          <p className="set-hint">
            <b>长按</b>任意一条消息旁边的喇叭（电脑上右键）→「语音播报总结」：把这一条压成几十秒能听完的一段话再念出来。
            适合那种一屏表格、或者很长的输出 —— 通勤时听完就能知道结论。
          </p>
          <p className="set-hint">
            它<b>不经过 agent</b>，也不带会话历史：只把<b>这一条消息</b>加下面这段指令，发一次
            <code>chat/completions</code>，拿回一段话交给同一个 TTS 念。
            消息本身就短于字数上限时<b>直接念原文</b>，不花一次模型调用。
          </p>
          <div className="set-row">
            <label>启用</label>
            <div className="set-pair">
              <input
                type="checkbox"
                checked={summary?.enabled ?? true}
                onChange={(e) => void saveSummary({ enabled: e.target.checked })}
              />
              <span className="set-hint">
                {summary?.enabled ?? true ? "已启用：长按菜单里会出现「语音播报总结」" : "已关闭：长按只出菜单，没有这一项"}
              </span>
            </div>
          </div>
          <div className="set-row">
            <label>用会话自己的模型</label>
            <div className="set-pair">
              <input
                type="checkbox"
                checked={summary?.followSession ?? true}
                onChange={(e) => void saveSummary({ followSession: e.target.checked })}
              />
              <span className="set-hint">
                {summary?.followSession ?? true
                  ? "已开启：跟这个会话当前选的 provider 和模型走 —— 你在用 DeepSeek，这笔就记在 DeepSeek 上"
                  : "已关闭：改用下面那个模型，走「语音」里配的 DashScope 端点"}
              </span>
            </div>
          </div>
          <p className="set-hint">
            端点与 key <b>不在这里配第二份</b>：驾驶舱读 agent 自己的家 —— <code>config.yaml</code> 里的
            <code>providers.&lt;id&gt;</code>（本机的 <code>lab</code> 就是），或那几家的 key
            （<code>~/.hermes/.env</code> 的 <code>DEEPSEEK_API_KEY</code>、<code>OPENROUTER_API_KEY</code> 等）。
            只认 OpenAI 兼容的 <code>/v1/chat/completions</code>；Anthropic Messages / Bedrock / Vertex 这类形状解析不出来，
            会退到下面那个模型，并在播报稿那一行写明「语音端点」。
          </p>
          <div className="set-row">
            <label>字数上限</label>
            <div className="set-pair">
              <input
                className="set-num"
                type="number"
                min={view?.summaryCharsRange?.[0] ?? 40}
                max={view?.summaryCharsRange?.[1] ?? 400}
                step={10}
                value={summary?.maxChars ?? 120}
                onChange={(e) => setSummary((v) => (v ? { ...v, maxChars: Number(e.target.value) } : v))}
                onBlur={(e) => void saveSummary({ maxChars: Number(e.target.value) })}
              />
              <span className="set-hint">中文大约每字 0.2–0.3 秒（120 字 ≈ 25–35 秒）。它同时也是「短于此就念原文」的阈值。</span>
            </div>
          </div>
          <div className="set-row">
            <label>备用模型（语音端点）</label>
            <div className="set-pair">
              <input
                className="set-input"
                type="text"
                placeholder={`${view?.summaryModelDefault ?? "qwen-flash"}（默认）`}
                value={summary?.model ?? ""}
                onChange={(e) => setSummary((v) => (v ? { ...v, model: e.target.value } : v))}
                onBlur={(e) => void saveSummary({ model: e.target.value })}
              />
              <span className="set-hint">
                只在上面关掉、或会话那个 provider 解析不出来时用。<code>{view?.summaryModelDefault ?? "qwen-flash"}</code> 是默认。
              </span>
            </div>
          </div>
          <div className="set-row">
            <label>超时（秒）</label>
            <div className="set-pair">
              <input
                className="set-num"
                type="number"
                min={view?.summaryTimeoutRange?.[0] ?? 5}
                max={view?.summaryTimeoutRange?.[1] ?? 60}
                step={5}
                value={summary?.timeoutSec ?? 20}
                onChange={(e) => setSummary((v) => (v ? { ...v, timeoutSec: Number(e.target.value) } : v))}
                onBlur={(e) => void saveSummary({ timeoutSec: Number(e.target.value) })}
              />
              <span className="set-hint">超时就<b>明说失败</b>，不会拿原文冒充总结。可以重试。</span>
            </div>
          </div>
          <div className="set-row">
            <label>怎么改写</label>
          </div>
          <textarea
            className="set-textarea"
            rows={7}
            spellCheck={false}
            value={summary?.prompt ?? ""}
            placeholder="留空即用内置模板 —— 原文就在下面，能直接看、能照着改。"
            onChange={(e) => setSummary((v) => (v ? { ...v, prompt: e.target.value } : v))}
            onBlur={(e) => void saveSummary({ prompt: e.target.value })}
          />
          <details className="set-builtin" open={!(summary?.prompt ?? "").trim()}>
            <summary>
              {(summary?.prompt ?? "").trim()
                ? "内置模板（你写了自定义的，它不再生效；清空即可恢复）"
                : "内置模板（留空时生效的就是它）"}
            </summary>
            <pre className="set-builtin-text">{view?.summaryPromptDefault ?? ""}</pre>
          </details>
          <p className="set-hint">
            <code>{"{maxChars}"}</code> 会被换成上面的字数上限。消息正文作为<b>用户那一轮</b>单独发出去，
            不带系统人设、不带历史、不带工具 —— 所以它只会总结你长按的那一条。
          </p>
          {summaryMsg ? <p className="set-hint">{summaryMsg}</p> : null}
        </section>
        <section className="set-card" id="set-tts" data-setgroup="voice">
          <h3>语音合成（TTS）</h3>
          <p className="set-hint">
            走百炼的 <code>SpeechSynthesizer</code>（合成结果由服务端取回，密钥不出服务端）。
            朗读按钮仍可在下面选择走浏览器自带声音。
          </p>
          <div className="set-row">
            <label>模型</label>
            <input className="set-input" list="tts-models" value={draft?.ttsModel ?? ""} onChange={(e) => field("ttsModel", e.target.value)} spellCheck={false} />
          </div>
          <datalist id="tts-models">
            {(models?.tts ?? []).map((m) => <option key={m} value={m} />)}
          </datalist>
          <div className="set-row">
            <label>音色</label>
            <div className="set-pair">
              <input className="set-input" list="tts-voices" value={draft?.ttsVoice ?? ""} onChange={(e) => field("ttsVoice", e.target.value)} spellCheck={false} />
              <select className="set-select" value={draft?.ttsFormat ?? "wav"} onChange={(e) => field("ttsFormat", e.target.value as Draft["ttsFormat"])}>
                <option value="wav">wav</option>
                <option value="mp3">mp3</option>
              </select>
            </div>
          </div>
          <datalist id="tts-voices">
            {(view?.ttsVoices ?? []).map((v) => <option key={v} value={v} />)}
          </datalist>
          <p className="set-hint">默认 <code>longanhuan_v3.6</code> = 龙安欢。系统音色还有 loongjielidou / loongeva / loongjohn，手填任意音色 id 也可以。</p>
          <div className="set-row">
            <label>试听</label>
            <div className="set-pair">
              <input className="set-input" value={ttsText} onChange={(e) => setTtsText(e.target.value)} />
              <button className="set-mini" onClick={() => void testTts()} disabled={busy === "tts"}>
                <IconVolume size={12} /> {busy === "tts" ? "合成中…" : "合成并播放"}
              </button>
            </div>
          </div>
          <p className="set-hint">试听使用已保存的配置（有未保存修改会先保存）。</p>
        </section>

        {/* ---------- 这个浏览器 ---------- */}
        <section className="set-card" id="set-browser" data-setgroup="voice">
          <h3>这个浏览器</h3>
          <p className="set-hint">听写引擎与朗读声音是本机设置：手机和电脑的麦克风/声音本来就不一样。</p>
          <div className="set-row">
            <label>听写引擎</label>
            <select
              className="set-select"
              value={prefs.stt}
              onChange={(e) => setPrefs({ stt: e.target.value as VoicePrefs["stt"] })}
            >
              <option value="auto">自动（优先服务端流式）</option>
              <option value="stream">服务端流式（百炼，带热词）</option>
              <option value="browser">浏览器自带</option>
              <option value="server">服务端批量上传</option>
            </select>
          </div>
          <div className="set-row">
            <label>测试识别</label>
            <div className="set-pair">
              <button className="set-mini" onClick={testStt} disabled={listening || dict.status === "transcribing"}>
                <IconMic size={12} /> 开麦说一句
              </button>
              {listening || dict.status === "transcribing" ? (
                <button className="set-mini" onClick={() => dictation.stop()}><IconStop size={11} /> 停止</button>
              ) : null}
              <span className={`dict-chip ${dict.error ? "err" : ""}`} style={{ margin: 0 }}>
                {dict.error
                  ? dict.error
                  : dict.status === "requesting"
                    ? "等待麦克风…"
                    : dict.status === "transcribing"
                      ? "收尾中…"
                      : `${dict.text}${dict.interim ? ` ${dict.interim}` : ""}${dict.engine ? ` · ${dict.engine}` : ""}`}
              </span>
            </div>
          </div>
          <div className="set-row">
            <label>朗读</label>
            <div className="set-pair">
              {/* 三档 (issue #16): 关 / 自动朗读 / 工作播报. Same value the header's speaker button
                  writes — one pref, two doors, so they can never disagree. */}
              <select
                className="set-select"
                value={prefs.speakMode ?? (prefs.autoRead ? "reply" : "off")}
                onChange={(e) => {
                  const m = e.target.value as "off" | "reply" | "brief";
                  setPrefs({ speakMode: m, autoRead: m === "reply" });
                }}
              >
                <option value="off">关（不自动出声）</option>
                <option value="reply">自动朗读（念整条回复）</option>
                <option value="brief">工作播报（念驾驶舱的一句话）</option>
              </select>
              <label className="set-check">
                <input type="checkbox" checked={prefs.serverTts} onChange={(e) => setPrefs({ serverTts: e.target.checked })} />
                用服务端声音（否则用系统声音）
              </label>
            </div>
          </div>
        </section>

        <div className="set-actions">
          <button className="set-save" onClick={() => void save()} disabled={busy === "save" || !dirty}>
            {busy === "save" ? "保存中…" : "保存"}
          </button>
          {dirty ? <button className="set-mini" onClick={() => setDraft(view ? draftOf(view) : null)}>撤销修改</button> : null}
        </div>
        </div>
      </div>
    </div>
  );
}
