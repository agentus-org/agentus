// 网页通知 — the settings card for the BROWSER channel (webNotify.ts is the renderer).
//
// Two kinds of setting live in one card, and the split is the same one the rest of this app uses:
//
//   * WHICH events are worth a notification is server-side (`rules.web`), shared with the phone's own
//     switches and changeable without shipping a bundle;
//   * whether THIS device shows anything, and what it sounds like, is local — permission belongs to
//     the browser profile, the speakers belong to the machine, and neither travels to the phone. Same
//     reasoning as 听写引擎 / 朗读声音 being 本机设置.
//
// Written to answer three questions in the order an operator asks them: 能弹吗（权限/安全上下文）→
// 弹出来是什么样（铃声）→ 哪些事要弹（服务端规则）。
import { useCallback, useEffect, useState } from "react";
import { playChime, unlockChime, useWebNotify, webNotify, type NoticeSound } from "./webNotify";
import { AVAILABILITY_HINT, webPush, type PushStatus } from "./webPush";

interface WebRules {
  enabled: boolean;
  turnStart: boolean;
  approval: boolean;
  completion: boolean;
}

const WEB_RULE_ROWS: { key: keyof Omit<WebRules, "enabled">; label: string; hint: string }[] = [
  { key: "turnStart", label: "任务开始", hint: "「运行中」的一条 —— 桌面正在显示转录时通常是噪音，所以默认关" },
  { key: "approval", label: "需要我批准", hint: "agent 卡在权限请求上 → 通知不点不走，点一下回到那个会话" },
  { key: "completion", label: "跑完 / 出错", hint: "回合结束 → 一条通知；同一个会话只留最新一条，不堆一屏" },
];

const SOUNDS: [NoticeSound, string, string][] = [
  ["default", "系统默认", "交给操作系统响它自己的通知音（可能被系统的通知设置静音）"],
  ["chime", "自带提示音", "驾驶舱自己响一声（在浏览器里合成，不加载音频文件），音量可调"],
  ["silent", "静音", "只弹出来，不响"],
];

export function WebNotifySettings(): JSX.Element {
  const st = useWebNotify();
  const [rules, setRules] = useState<WebRules | null>(null);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [push, setPush] = useState<PushStatus | null>(null);
  const [pushNote, setPushNote] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notify/settings", { credentials: "same-origin" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const view = (await res.json()) as { rules?: { web?: WebRules } };
      if (view.rules?.web) setRules(view.rules.web);
      setErr("");
    } catch (e) {
      setErr(`读不到网页通知规则：${(e as Error).message}`);
    }
  }, []);

  const loadPush = useCallback(async () => {
    setPush(await webPush.status());
  }, []);

  useEffect(() => {
    void load();
    void loadPush();
  }, [load, loadPush]);

  const saveRules = async (next: WebRules, label: string): Promise<void> => {
    setRules(next); // optimistic: the switch must not lag behind the finger
    setBusy(true);
    try {
      const res = await fetch("/api/notify/settings", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        // Only the web section: the server deep-merges it, so the phone's own switches (and everything
        // else in 设置) are not overwritten by a card that never read them.
        body: JSON.stringify({ rules: { web: next } }),
      });
      const out = (await res.json().catch(() => ({}))) as { error?: string; rules?: { web?: WebRules } };
      if (!res.ok) throw new Error(out.error ?? `${res.status}`);
      if (out.rules?.web) setRules(out.rules.web);
      setNote(label);
      setErr("");
    } catch (e) {
      setErr(`${label}失败：${(e as Error).message}`);
      await load(); // put the switch back to whatever the server really holds
    } finally {
      setBusy(false);
    }
  };

  const grant = async (): Promise<void> => {
    const result = await webNotify.requestPermission();
    if (result === "granted") {
      webNotify.setPrefs({ on: true });
      setNote("这台设备已开启网页通知");
      setErr("");
    } else if (result === "denied") {
      setErr("浏览器拒绝了通知权限 —— 需要在浏览器的网站设置里手动允许");
    }
  };

  const tryChime = (kind: "agent_done" | "approval"): void => {
    unlockChime();
    playChime(st.prefs.volume, kind);
  };

  const sendTest = async (): Promise<void> => {
    const ok = await webNotify.test();
    setNote(ok ? "已发一条测试通知" : "没弹出来 —— 看下面的权限/地址提示");
  };

  const pushOn = async (): Promise<void> => {
    setBusy(true);
    setPushNote("");
    try {
      const out = await webPush.enable();
      setPushNote(out.ok ? "这台设备已开通推送 —— 锁屏上应该能收到「跑完」了" : `没开成：${out.error}`);
      await loadPush();
    } finally {
      setBusy(false);
    }
  };

  const pushOff = async (): Promise<void> => {
    setBusy(true);
    try {
      await webPush.disable();
      setPushNote("这台设备已退订推送");
      await loadPush();
    } finally {
      setBusy(false);
    }
  };

  const pushTest = async (): Promise<void> => {
    setBusy(true);
    try {
      const out = await webPush.test();
      setPushNote(out.ok
        ? `已推到 ${out.sent} 台设备 —— 现在把屏幕锁上等一下`
        : `推送失败：${out.error ?? "推送服务拒绝了"}`);
      await loadPush();
    } finally {
      setBusy(false);
    }
  };

  const permissionLine = (): JSX.Element => {
    if (st.availability === "no-api") {
      return (
        <span className="set-hint">
          这个浏览器没有通知能力。手机 App 里的页面就是这种情况（WebView 不提供通知 API），
          那台手机由 App 自己的通道负责 —— 这里不影响它。
        </span>
      );
    }
    if (st.availability === "insecure") {
      return (
        <span className="set-hint">
          需要 <b>https</b> 或 <b>localhost</b> 打开驾驶舱才能弹系统通知：局域网明文地址
          （<code>http://192.168.x.x:8788</code>）浏览器不给这个能力。隧道入口或 127.0.0.1 都可以。
        </span>
      );
    }
    if (st.permission === "granted") {
      return (
        <>
          <button
            type="button"
            className={`set-mini ${st.prefs.on ? "on" : ""}`}
            aria-pressed={st.prefs.on}
            onClick={() => { unlockChime(); webNotify.setPrefs({ on: !st.prefs.on }); }}
          >
            {st.prefs.on ? "开" : "关"}
          </button>
          <span className="set-hint"> · 已授权。只有标签页不在前台（切走了/最小化了）时才弹，你盯着这个页面时不打扰。</span>
        </>
      );
    }
    if (st.permission === "denied") {
      return <span className="set-hint">通知被浏览器拦下了 —— 去浏览器的「网站设置 → 通知」里允许本网站，再刷新这个页面。</span>;
    }
    return (
      <>
        <button type="button" className="set-mini" disabled={busy} onClick={() => void grant()}>
          开启浏览器通知
        </button>
        <span className="set-hint"> · 会弹出浏览器的授权框（必须由点击触发，浏览器不允许自动要权限）。</span>
      </>
    );
  };

  const last = st.last;
  return (
    <section className="set-card" id="set-webnotify" data-setgroup="notify">
      <h3>网页通知（这台设备）</h3>
      <p className="set-hint">
        用浏览器打开驾驶舱时，由浏览器弹系统通知：切到别的标签页/别的应用后，「跑完」和「要我确认」
        会落到系统的通知中心，点一下就回到那条会话。什么时候该弹由服务端判定（和手机同一套文案、同一份事件），
        <b>这台设备是否显示、响不响是这台设备自己的事</b>（跟听写引擎一样，不跨设备同步）。
      </p>
      {err ? <div className="set-err" role="alert">{err}</div> : null}
      {note ? <div className="set-toast">{note}</div> : null}
      {pushNote ? <div className="set-toast">{pushNote}</div> : null}

      <div className="set-row">
        <label>这台设备</label>
        <div>{permissionLine()}</div>
      </div>

      {/* ---- 推送：唯一一条在屏幕锁上之后还能到的通道 ---- */}
      <div className="set-row">
        <label>锁屏 / 切后台</label>
        <div>
          {push?.availability !== "ok" ? (
            <span className="set-hint">{AVAILABILITY_HINT[push?.availability ?? "no-sw"]}</span>
          ) : push.subscribed ? (
            <>
              <button type="button" className="set-mini on" aria-pressed disabled={busy} onClick={() => void pushOff()}>
                已开通
              </button>
              <span className="set-hint">
                {" · 点一下退订。页面关掉、手机锁屏时，「跑完」和「要我确认」会走系统的推送服务到这里。"}
              </span>
            </>
          ) : (
            <>
              <button type="button" className="set-mini" disabled={busy} onClick={() => void pushOn()}>
                开启推送
              </button>
              <span className="set-hint">
                {" · 上面那个开关只管「页面还开着」，屏幕一锁就失效；推送才是关屏也能收的那条。"}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="set-row">
        <label>推送测试</label>
        <div>
          <button type="button" className="set-mini" disabled={busy || !push?.subs.length} onClick={() => void pushTest()}>
            往所有设备推一条
          </button>
          <span className="set-hint">
            {push?.subs.length
              ? ` · 服务端已记下 ${push.subs.length} 台设备的订阅${push.subs.some((x) => x.fails) ? "（有设备最近推失败，见下）" : ""}`
              : " · 还没有设备订阅推送"}
          </span>
        </div>
      </div>

      {push?.subs.length ? (
        <div className="set-row">
          <label>已订阅</label>
          <div className="set-hint" style={{ display: "grid", gap: "3px" }}>
            {push.subs.map((x) => (
              <span key={`${x.host}-${x.tail}`}>
                {x.host} · …{x.tail} · {x.lastOkAt ? `上次送达 ${new Date(x.lastOkAt).toLocaleString()}` : "还没送达过"}
                {x.fails ? ` · 失败 ${x.fails} 次${x.lastError ? `（${x.lastError.slice(0, 60)}）` : ""}` : ""}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="set-row">
        <label>铃声</label>
        <div>
          <div className="set-seg" role="group" aria-label="notification sound">
            {SOUNDS.map(([value, label, hint]) => (
              <button
                key={value}
                type="button"
                className={st.prefs.sound === value ? "on" : ""}
                aria-pressed={st.prefs.sound === value}
                title={hint}
                onClick={() => { unlockChime(); webNotify.setPrefs({ sound: value }); }}
              >
                {label}
              </button>
            ))}
          </div>
          {st.prefs.sound === "chime" ? (
            <label className="settings-range" style={{ display: "inline-flex", marginLeft: "10px" }}>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={st.prefs.volume}
                aria-label="volume"
                onChange={(e) => webNotify.setPrefs({ volume: Number(e.target.value) })}
              />
              <span className="set-hint">{Math.round(st.prefs.volume * 100)}%</span>
            </label>
          ) : null}
          <button type="button" className="set-mini" style={{ marginLeft: "10px" }} onClick={() => tryChime("agent_done")}>
            试听·完成
          </button>
          <button type="button" className="set-mini" style={{ marginLeft: "6px" }} onClick={() => tryChime("approval")}>
            试听·等你处理
          </button>
          <div className="set-hint" style={{ marginTop: "4px" }}>
            听到的就是真实通知的两段：<b>完成</b>是平稳的两声「叮—咚」；<b>等你处理</b>（审批/出错）更急、音往上走。
            点这两个按钮能听到，通知就能听到 —— 顺带这也是让浏览器解锁音频的那一次点击。
            通话中不会响（麦克风开着，声音会被 agent 听见）。
          </div>
        </div>
      </div>

      <div className="set-row">
        <label>测试</label>
        <div>
          <button type="button" className="set-mini" disabled={busy} onClick={() => void sendTest()}>
            发一条测试通知
          </button>
          <span className="set-hint">
            {last
              ? ` · 最近一次：${last.title}（${last.drawn ? "已交给系统" : "被系统拒了"}，${Math.max(0, Math.round((Date.now() - last.at) / 1000))} 秒前）`
              : " · 只弹到这台设备，不打扰手机"}
          </span>
        </div>
      </div>

      <div className="set-row">
        <label>要弹哪些</label>
        <div>
          <button
            type="button"
            className={`set-mini ${rules?.enabled ? "on" : ""}`}
            aria-pressed={Boolean(rules?.enabled)}
            disabled={!rules || busy}
            onClick={() => rules && void saveRules({ ...rules, enabled: !rules.enabled }, "已保存网页通知总开关")}
          >
            {rules?.enabled ? "总开关：开" : "总开关：关"}
          </button>
          <span className="set-hint"> · 关掉就是服务端不再往任何浏览器推（手机渠道不受影响）</span>
        </div>
      </div>

      {WEB_RULE_ROWS.map((r) => (
        <div className="set-row" key={r.key}>
          <label>{r.label}</label>
          <div>
            <button
              type="button"
              className={`set-mini ${rules?.[r.key] ? "on" : ""}`}
              aria-pressed={Boolean(rules?.[r.key])}
              disabled={!rules || busy}
              onClick={() => rules && void saveRules({ ...rules, [r.key]: !rules[r.key] }, "已保存网页通知规则")}
            >
              {rules?.[r.key] ? "开" : "关"}
            </button>
            <span className="set-hint"> {r.hint}</span>
          </div>
        </div>
      ))}
    </section>
  );
}
