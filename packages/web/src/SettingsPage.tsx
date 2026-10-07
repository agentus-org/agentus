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
import { NotifySettings } from "./NotifySettings";
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
    items: [{ anchor: "set-backends", label: "后端" }],
  },
  {
    id: "notify", label: "通知", hint: "手机上怎么收到",
    items: [{ anchor: "set-notify", label: "手机通知（Android 伴侣）" }],
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

const ACCENTS = ["#ffb454", "#5ba8d4", "#4ec9a0", "#8f7bd7", "#ff6b9d"];

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
        {/* ---------- 手机通知（Android 伴侣 + 推送规则） ---------- */}
        <NotifySettings sessionId={sessionId} />

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
                value={theme.accent || "#ffb454"}
                onChange={(e) => void pickTheme({ ...theme, accent: e.target.value })}
                aria-label="custom accent"
              />
              <button type="button" className="set-mini" onClick={() => void pickTheme({ ...theme, accent: "" })}>默认</button>
            </div>
          </div>
        </section>

        <h4 className="set-group" id="grp-voice" data-setgroup="voice">语音</h4>
        {/* ---------- 语音识别 ---------- */}
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
            <span className="set-hot-title">{hot ? `下次识别携带 ${hot.words.length} 个热词（固定 ${hot.fixed} / 动态 ${hot.dynamic}）` : "…"}</span>
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
              <label className="set-check">
                <input type="checkbox" checked={prefs.autoRead} onChange={(e) => setPrefs({ autoRead: e.target.checked })} />
                回复完成自动朗读
              </label>
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
