// 手机通知 — the web-side half of the notify channel (docs/android-notify-contract.md §A3).
//
// The phone app renders whatever the server publishes; this panel is where the operator
// decides WHAT gets published and WHICH phone receives it. Nothing here needs an APK rebuild:
// the rules are server-side state, and the phone is a generic renderer (that is the whole
// point of the contract).
//
// Three things this panel must never do: claim a device is online when it is not, pretend a
// rule was saved when the POST failed, or hide the pairing code behind another click — the
// code is the one string that turns "an app I installed" into "my phone gets my agent's
// notifications".
import { useCallback, useEffect, useState } from "react";

interface NotifyRules {
  turnStart: boolean;
  approval: boolean;
  completion: boolean;
  quietWhenWatching: boolean;
}

interface NotifyDeviceRow {
  deviceId: string;
  name: string;
  platform: string;
  sdkInt: number;
  appVersion: string;
  capabilities: string[];
  createdAt: number;
  lastSeenAt: number | null;
  online: boolean;
}

interface NotifyView {
  rules: NotifyRules;
  presence: { sessionId: string | null; visible: boolean; call?: boolean; at: number };
  watching: boolean;
  code: string;
  pairUri: string;
  apkUrl: string;
  apkBytes: number | null;
  devices: NotifyDeviceRow[];
}

const RULE_ROWS: { key: keyof NotifyRules; label: string; hint: string }[] = [
  { key: "turnStart", label: "任务开始", hint: "agent 开始跑 → 一条进行中的卡片（Android 16 可提升成实时动态）" },
  { key: "approval", label: "需要我批准", hint: "权限请求 → 带按钮的通知，锁屏上就能按「仅此次 / 拒绝」" },
  { key: "completion", label: "跑完 / 出错", hint: "回合结束 → 一条可点开该会话的通知" },
  { key: "quietWhenWatching", label: "我正在看这个会话时不推", hint: "页面就在眼前时，手机上再响一次是噪音（审批除外——那是我必须做的决定）" },
];

function ago(ts: number | null): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  return `${Math.round(s / 3600)} 小时前`;
}

export function NotifySettings({ sessionId }: { sessionId?: string }): JSX.Element {
  const [view, setView] = useState<NotifyView | null>(null);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notify/settings", { credentials: "same-origin" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      setView((await res.json()) as NotifyView);
      setErr("");
    } catch (e) {
      setErr(`读不到手机通知设置：${(e as Error).message}`);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 5000); // device online-state is live, not a snapshot
    return () => window.clearInterval(t);
  }, [load]);

  const call = async (path: string, body: unknown, ok: string): Promise<boolean> => {
    setBusy(true);
    try {
      const res = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(out.error ?? `${res.status}`);
      setNote(ok);
      setErr("");
      await load();
      return true;
    } catch (e) {
      setErr(`${ok}失败：${(e as Error).message}`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const toggle = (key: keyof NotifyRules): void => {
    if (!view) return;
    // optimistic: flip locally first so the switch does not lag behind the finger, then
    // reconcile with whatever the server says it stored
    const next = { ...view.rules, [key]: !view.rules[key] };
    setView({ ...view, rules: next });
    void call("/api/notify/settings", { rules: next }, "已保存规则");
  };

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setNote("配对串已复制");
    } catch {
      setNote("复制失败，请手动选中");
    }
  };

  return (
    <section className="set-card">
      <h3>手机通知（Android 伴侣）</h3>
      <p className="set-hint">
        App 只是一个通用渲染器——它显示什么、什么时候响，全由这里的规则决定，
        <b>改规则不需要重新装 APK</b>。手机在外面也能收：App 自己开一条套接字连回这台服务端，
        服务端就知道要往哪台手机推。
      </p>
      {err ? <div className="set-err" role="alert">{err}</div> : null}
      {note ? <div className="set-toast">{note}</div> : null}

      <div className="set-row">
        <label>装 App</label>
        <div>
          <a className="set-mini" href={view?.apkUrl ?? "/agentslot-companion.apk"} download>
            agentslot-companion.apk
          </a>
          {view?.apkBytes ? <span className="set-hint"> · {(view.apkBytes / 1048576).toFixed(1)} MB</span> : null}
          <span className="set-hint"> · 装完在 App 里贴下面这行配对串，或直接填地址 + 用户名密码</span>
        </div>
      </div>

      <div className="set-row">
        <label>配对串</label>
        <div>
          <code className="set-input" style={{ display: "inline-block", minWidth: "20em" }}>{view?.pairUri ?? "…"}</code>
          <button type="button" className="set-mini" disabled={!view} onClick={() => void copy(view?.pairUri ?? "")}>复制</button>
          <button
            type="button"
            className="set-mini"
            disabled={busy}
            onClick={() => void call("/api/notify/pair-code/rotate", {}, "已换新配对码")}
          >换一个</button>
          <span className="set-hint"> · 当前码 <b>{view?.code ?? "…"}</b></span>
        </div>
      </div>

      {RULE_ROWS.map((r) => (
        <div className="set-row" key={r.key}>
          <label>{r.label}</label>
          <div>
            <button
              type="button"
              className={`set-mini ${view?.rules[r.key] ? "on" : ""}`}
              aria-pressed={Boolean(view?.rules[r.key])}
              disabled={!view || busy}
              onClick={() => toggle(r.key)}
            >
              {view?.rules[r.key] ? "开" : "关"}
            </button>
            <span className="set-hint"> {r.hint}</span>
          </div>
        </div>
      ))}

      <div className="set-row">
        <label>现在</label>
        <div className="set-hint">
          {view?.presence.call
            ? <>正在通话 <b>{view.presence.sessionId?.slice(0, 8) ?? ""}</b>（这个会话的进行中/完成通知不推，其它通知照发但静音 —— 免提的声音会进麦克风）</>
            : view?.presence.sessionId
              ? <>你正看着 <b>{view.presence.sessionId.slice(0, 8)}</b>{view.watching ? "（这个会话的进行中/完成通知暂时不推）" : "（但「我正在看就不推」是关的）"}</>
              : "没有正在查看的会话"}
        </div>
      </div>

      <div className="set-row">
        <label>操作</label>
        <div>
          <button type="button" className="set-mini" disabled={busy} onClick={() => void call("/api/notify/probe", {}, "已发测试通知")}>
            发测试通知到手机
          </button>
          <button
            type="button"
            className="set-mini"
            disabled={busy || !sessionId}
            title={sessionId ? "把这条会话推成一条手机通知" : "先打开一个会话"}
            onClick={() => void call("/api/notify/push", { sessionId, kind: "note", title: "来自驾驶舱的推送" }, "已推到手机")}
          >
            把当前会话推到手机
          </button>
        </div>
      </div>

      <div className="set-row">
        <label>试上岛</label>
        <div>
          {/* Two island APIs, and they fail for completely different reasons: the vendor one needs
              Xiaomi's platform-side grant, Android 16's own Live Update needs none. Sending one frame
              down each path is how "手机上到底能不能上岛" is answered without a new APK. */}
          <button type="button" className="set-mini" disabled={busy}
            title="按 App 自己的顺序（先小米焦点通知，再安卓原生实时动态）"
            onClick={() => void call("/api/notify/push", { sessionId, kind: "island", title: "上岛测试 · 自动" }, "已推自动通道")}>
            自动通道
          </button>
          <button type="button" className="set-mini" disabled={busy}
            title="只走安卓 16 原生实时动态（不需要小米任何授权）"
            onClick={() => void call("/api/notify/push", { sessionId, kind: "island", path: "aosp", title: "上岛测试 · 原生实时动态" }, "已推原生通道")}>
            原生实时动态
          </button>
          <button type="button" className="set-mini" disabled={busy}
            title="只走小米超级岛 / 焦点通知（需要小米平台侧开通）"
            onClick={() => void call("/api/notify/push", { sessionId, kind: "island", path: "xiaomi", title: "上岛测试 · 小米岛" }, "已推小米通道")}>
            小米岛
          </button>
        </div>
      </div>

      <div className="set-row">
        <label>已配对设备</label>
        <div>
          {(view?.devices.length ?? 0) === 0 ? (
            <span className="set-hint">还没有设备。装好 App、贴上面那行配对串，这里就会多一台。</span>
          ) : (
            <table style={{ borderCollapse: "collapse" }}>
              <tbody>
                {view?.devices.map((d) => (
                  <tr key={d.deviceId}>
                    <td style={{ padding: "2px 10px 2px 0" }}>
                      <b style={{ color: d.online ? "#4ec9a0" : "inherit" }}>{d.online ? "●" : "○"}</b> {d.name}
                    </td>
                    <td className="set-hint" style={{ padding: "2px 10px 2px 0" }}>
                      {d.platform} {d.sdkInt} · v{d.appVersion} · {d.online ? "在线" : `最后在线 ${ago(d.lastSeenAt)}`}
                    </td>
                    <td className="set-hint" style={{ padding: "2px 10px 2px 0" }} title={d.capabilities.join(", ")}>
                      {(d.capabilities ?? []).length} 项能力
                    </td>
                    <td>
                      <button
                        type="button"
                        className="set-mini"
                        disabled={busy}
                        onClick={() => void call("/api/notify/devices/revoke", { deviceId: d.deviceId }, `已撤销 ${d.name}`)}
                      >撤销</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </section>
  );
}
