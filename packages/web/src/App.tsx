import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useDismiss, useEscape } from "./useDismiss";
import { cockpit, type BackendView, type BlockedSlot, type MsgView, type SessionView } from "./state";
import { Markdown } from "./Markdown";
import { SettingsPage } from "./SettingsPage";
import { clockHM, messageTime, relTime, stamp } from "./time";
import { CallMode } from "./CallMode";
import { loadServerTheme } from "./theme";
import { watchingNow } from "./presence";
import { loadServerCallSettings } from "./callSettings";
import { WorkspacePicker } from "./WorkspacePicker";
import { ToolPanel } from "./ToolPanel";
import {
  browserDictationAvailable, dictation, isCallActive, loadServerVoicePrefs, loadVoiceCaps, speaker, useAutoRead, useDictation,
  subscribeVoiceCaps, useSpeaker, useVoicePrefs, voiceCaps, type VoicePrefs,
} from "./voice";
import {
  IconArrowDown, IconArchive, IconCheck, IconChevronDown, IconChevronRight, IconClose, IconCopy, IconDotsV, IconDownload, IconFile,
  IconFolder, IconGauge, IconChip, IconFork, IconHome, IconMenu, IconMic, IconPanel, IconPaperclip,
  IconPause, IconPencil, IconPhone, IconPlus, IconPower, IconRefresh, IconResume, IconSearch, IconSend, IconSettings, IconShield,
  IconStop, IconVolume, IconVolumeOff, IconBrain,
} from "./Icons";
import type { ClientCommand, PermissionDecision, PermissionDiff, PermissionRequestView, PromptAttachment, SessionInfo, TurnTrace, UsageView } from "@agentslot/shared";

export function App(): JSX.Element {
  const snap = useSyncExternalStore(cockpit.subscribe, cockpit.getSnapshot);
  const [drawer, setDrawer] = useState(false);
  // The new-session dialog, with the workspace the operator already pointed at (the rail's
  // per-directory 「+」) — no cwd means the standalone button, which browses for one.
  const [modal, setModal] = useState<{ cwd?: string } | false>(false);
  // ---- the approval dialog -----------------------------------------------------------
  // A request needs an ANSWER, and the agent gives up on its own if it gets none (Hermes
  // self-denies after `approvals.timeout`): so a fresh request OPENS a dialog on the session
  // on screen. 「稍后处理」 puts it away (the request stays pending, and its card stays in the
  // transcript); the header's ⚿ chip reopens it. Keyed by requestId, so a second request
  // asks again instead of inheriting the first one's dismissal.
  const [permSkipped, setPermSkipped] = useState<Record<string, boolean>>({});
  const [permReopened, setPermReopened] = useState("");
  // Settings is a view, not a modal: it replaces the chat area (hermes-studio's shape),
  // so a half-read conversation is still there when the operator comes back.
  const [settings, setSettings] = useState(false);

  // Who are we? Asked before anything else: /api/auth/me decides between the login
  // view and the cockpit. Dialling the socket first would be wasted — an
  // unauthenticated upgrade is refused with 401.
  useEffect(() => { void cockpit.checkAuth(); }, []);
  useEffect(() => { setDrawer(false); }, [snap.activeId]);
  // A refused resume is a dialog that needs the operator's attention, and the rail it was clicked
  // from can be covering it (the phone drawer sits above the plain modal layer): close it. Measured
  // on a 390px viewport — without this, tapping a dead slot in the drawer looked like nothing happened.
  useEffect(() => { if (snap.blocked) setDrawer(false); }, [snap.blocked]);
  useEscape(drawer, () => setDrawer(false));
  // The server's palette is the source of truth; the localStorage copy only made the
  // first frame right. Adopted once the operator is in (the endpoint needs a session).
  useEffect(() => {
    if (snap.auth !== "in") return;
    void loadServerTheme();
    void loadServerCallSettings();   // the call panel's knobs live on the server too
    void loadServerVoicePrefs();     // read-aloud / voice / recogniser: shared across devices
  }, [snap.auth]);

  if (snap.auth !== "in") return <AuthScreen />;
  // The session on screen and the request waiting on it (the dialog reads the FIRST one;
  // answering or dismissing it brings up the next).
  const activeView = snap.activeId ? cockpit.byId.get(snap.activeId) : undefined;
  const pendingPerm = activeView?.perms[0] ?? null;

  return (
    <div className="app">
      {drawer && <div className="scrim" onClick={() => setDrawer(false)} />}
      <Sidebar
        open={drawer}
        onNew={() => setModal({})}
        onNewIn={(cwd) => setModal({ cwd })}
        onSettings={() => { setSettings(true); setDrawer(false); }}
        settingsOpen={settings}
      />
      <Main
        onMenu={() => setDrawer(true)}
        settingsOpen={settings}
        onCloseSettings={() => setSettings(false)}
        onPermClick={() => { if (pendingPerm) setPermReopened(pendingPerm.requestId); }}
      />
      {modal && <NewSessionModal cwd={modal.cwd} onClose={() => setModal(false)} />}
      {/* Rendered here, not in the rail: the operator may have triggered the resume from the
          phone's bottom sheet and closed it, and this must still be on screen. */}
      {snap.blocked && <BlockedSlotDialog slot={snap.blocked} />}
      {/* The request that is waiting on THIS session. Shown unless the operator just put it
          away; a different request always asks again. */}
      {pendingPerm && activeView && (permReopened === pendingPerm.requestId || !permSkipped[pendingPerm.requestId]) ? (
        <PermDialog
          req={pendingPerm}
          sessionTitle={activeView.info.title}
          onSkip={() => {
            setPermSkipped((s) => ({ ...s, [pendingPerm.requestId]: true }));
            setPermReopened("");
          }}
        />
      ) : null}
      <StaleBanner />
    </div>
  );
}

/** Is this page still the bundle the server is serving?
 *
 *  A WebView (the Android app) or a tab left open across a deploy keeps running the JS it once
 *  loaded: the new code is deployed, the old code is on screen, and "the fix isn't there" is
 *  indistinguishable from "the fix is broken". Poll a small endpoint and say it out loud. */
function StaleBanner(): JSX.Element | null {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const loaded = document
      .querySelector<HTMLScriptElement>('script[src*="/assets/index-"]')
      ?.src.match(/index-([A-Za-z0-9_-]+)\.js/)?.[1] ?? null;
    if (!loaded) return;
    let live = true;
    const check = async (): Promise<void> => {
      try {
        const r = await fetch("/api/version", { cache: "no-store" });
        const j = (await r.json()) as { asset?: string | null };
        if (live && j.asset && j.asset !== loaded) setStale(true);
      } catch { /* offline, or an old server without the endpoint: say nothing */ }
    };
    void check();
    const t = window.setInterval(() => void check(), 60_000);
    const onVis = (): void => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { live = false; window.clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, []);
  if (!stale) return null;
  return (
    <button
      type="button"
      className="stale-banner"
      title="服务端已经换成新的一组前端资源，这个页面还跑着旧的"
      onClick={() => window.location.reload()}
    >
      已有新版本 · 点这里刷新（这个页面跑的还是旧代码）
    </button>
  );
}

/** A cold slot the agent can no longer adopt. Not a banner and not a toast — it is a decision
 *  (keep the transcript, or drop the slot), so it is a dialog, and it names the two agent homes
 *  the resume failed between.
 *
 *  Why it exists: resuming such a slot used to look like a success from here. ACP has no loud "no"
 *  — hermes answers an unknown session with an EMPTY load result and `refusal` on every prompt —
 *  so the slot came up "ready" and silently ate every message the operator sent. The server now
 *  refuses up front (409 + code); this is where the operator sees why and what can be done. */
function BlockedSlotDialog({ slot }: { slot: BlockedSlot }): JSX.Element {
  useEscape(true, () => cockpit.dismissBlocked());
  const mismatch = slot.code === "home_mismatch";
  return (
    <div className="modal-bg" onClick={() => cockpit.dismissBlocked()}>
      <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
        <h3>这个会话不能继续使用</h3>
        <div className="hint">
          {mismatch
            ? "它是在另一个 agent home 里创建的，而这行后端现在指向另一个 home —— agent 那边没有这份会话，发消息不会有任何回复。"
            : "agent 那边已经找不到这份会话了（它所在的 home 里没有这个会话），发消息不会有任何回复。"}
        </div>
        <div className="blocked-homes">
          <div><span>会话所属 home</span><code>{slot.sessionHome ?? "（早期会话，未记录）"}</code></div>
          <div><span>后端当前 home</span><code>{slot.rowHome ?? "（该后端没有 home）"}</code></div>
        </div>
        <div className="hint">
          「{slot.title}」的历史消息在本地库里，删除会连同记录一起清掉且无法撤销；想留着就先取消，再从会话菜单里导出。
        </div>
        <div className="row">
          <button className="cancel" onClick={() => cockpit.dismissBlocked()}>取消</button>
          <button className="go danger" onClick={() => cockpit.deleteBlocked()}>删除会话</button>
        </div>
      </div>
    </div>
  );
}

/** Login / splash. Deliberately plain — this is a door, not a dashboard. */
function AuthScreen(): JSX.Element {
  const { auth, authError, authBusy, authInfo } = useSyncExternalStore(cockpit.subscribe, cockpit.getSnapshot);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const splash = auth === "unknown";
  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    void cockpit.login(username.trim(), password).then((ok) => { if (ok) setPassword(""); });
  };
  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-logo">⛟ AgentSlot</div>
        <div className="auth-sub">keep your agents on the track</div>
        {splash ? (
          <div className="auth-note">正在检查登录状态…</div>
        ) : (
          <>
            <label className="auth-field">
              <span>用户名</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>
            <label className="auth-field">
              <span>密码</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                autoFocus
              />
            </label>
            {authError ? <div className="auth-err" role="alert">{authError}</div> : null}
            <button className="auth-btn" type="submit" disabled={authBusy}>
              {authBusy ? "登录中…" : "登录"}
            </button>
            {authInfo?.usingDefaultPassword ? (
              <div className="auth-warn">
                ⚠ 当前是默认口令 <code>admin / 123456</code>。够挡住误闯，挡不住同网段的人 —
                设置 <code>AGENTSLOT_PASSWORD</code> 后重启即可更换。
              </div>
            ) : null}
            <div className="auth-foot">
              会话保存在 HttpOnly Cookie 中（7 天）。脚本可用 <code>Authorization: Bearer</code> +
              数据目录里的 <code>auth.token</code>。
            </div>
          </>
        )}
      </form>
    </div>
  );
}

/** The rail groups sessions by the directory they work in — the thing an operator
 *  actually organises their work around. The header is the folder's name (the full path
 *  is in the tooltip), and a group collapses, so twenty sessions across four projects stay
 *  readable. Live and cold sessions live in the same group: they belong to the same work,
 *  and splitting them by process state was a machine's view, not the operator's. */
/** Copy text. `navigator.clipboard` only exists in a SECURE CONTEXT, and the cockpit's LAN
 *  entry is plain `http://<lan-ip>:8787` — so the execCommand path is load-bearing here, not
 *  a legacy courtesy (measured: on that origin navigator.clipboard is undefined while the
 *  https entry has it). Returns whether the text actually made it. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through to the textarea path */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** One-click copy for a message (studio puts this on every bubble, AionUi on every turn). */
function CopyButton({ text, what = "消息" }: { text: string; what?: string }): JSX.Element {
  const [state, setState] = useState<"" | "ok" | "no">("");
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const title = state === "ok" ? "已复制" : state === "no" ? "复制失败（浏览器拒绝）" : `复制${what}`;
  return (
    <button
      type="button"
      className={`bubble-btn copy ${state}`}
      title={title}
      aria-label={title}
      data-copy-state={state}
      onClick={async (e) => {
        e.stopPropagation();
        const ok = await copyText(text);
        setState(ok ? "ok" : "no");
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setState(""), 1500);
      }}
    >
      {state === "ok" ? <IconCheck size={13} /> : <IconCopy size={13} />}
    </button>
  );
}

/** Fork from the tail of the conversation (studio shows this on the LAST message only:
 *  a fork is "continue this work as a new session", and that only makes sense at the end
 *  of what the agent currently holds). The agent does the copying — ACP `session/fork`. */
function ForkHere({ sid, busy }: { sid: string; busy: boolean }): JSX.Element {
  const [state, setState] = useState<"idle" | "working" | "failed">("idle");
  const [err, setErr] = useState("");
  return (
    <button
      type="button"
      className={`bubble-btn fork ${state}`}
      disabled={busy || state === "working"}
      title={err || (state === "failed" ? "fork 失败" : "从这里 fork —— agent 把这段上下文复制到一个新会话")}
      aria-label={state === "failed" ? "fork 失败" : "从这里 fork"}
      onClick={async (e) => {
        e.stopPropagation();
        setState("working");
        setErr("");
        try {
          await cockpit.fork(sid);
          setState("idle");
        } catch (er) {
          setErr(String((er as Error)?.message ?? er));
          setState("failed");
        }
      }}
    >
      <IconFork size={13} />
    </button>
  );
}

/** The agent's mark. Hermes and Qoder ship real brand icons (hermes.png from the
 *  hermes-studio assets, qoder's favIcon from qoder.com) — use them wherever a backend
 *  has official artwork. The monogram stays as the fallback path (mock agent, missing
 *  asset, broken img) so a row ALWAYS renders something identifiable. */
const BACKEND_MARK: Record<string, { letter: string; label: string; icon?: string }> = {
  hermes: { letter: "H", label: "Hermes", icon: "/coding-agents/hermes.png" },
  qoder: { letter: "Q", label: "Qoder", icon: "/coding-agents/qoder.svg" },
  mock: { letter: "M", label: "Mock" },
};

/** When this session was last talked to (creation time when it has no messages yet). The rail
 *  orders by it, so the row also SHOWS it — one definition, used by the sort and by the label. */
function lastOf(s: SessionInfo): number {
  return s.lastAt ?? s.createdAt;
}

function BackendAvatar({ backend, cold, status }: { backend: string; cold: boolean; status: string }): JSX.Element {
  const mark = BACKEND_MARK[backend] ?? { letter: backend.slice(0, 1).toUpperCase(), label: backend };
  const [broken, setBroken] = useState(false);
  const useIcon = mark.icon && !broken;
  return (
    <span
      className={`be-avatar be-${backend} ${cold ? "cold" : ""}`}
      data-backend={backend}
      data-letter={mark.letter}
      title={`${mark.label} · ${cold ? "已归档（冷会话）" : status}`}
      aria-hidden="true"
    >
      {useIcon
        ? <img src={mark.icon} alt="" draggable={false} onError={() => setBroken(true)} />
        : mark.letter}
      {!cold ? <span className={`be-dot ${status}`} /> : null}
    </span>
  );
}

/** Everything that acts on a SESSION, in one menu: rename, fork, workspace, id, resume,
 *  delete. It replaces the row of tiny buttons that used to live on every session row —
 *  the rail is for finding work, the menu is for acting on it (studio's split). On a phone
 *  the same markup is laid out as a bottom sheet by CSS, where a thumb can reach it. */
function SessionMenu({ x, y, trigger, info, cold, canFork, onDismiss, onRename, onRetitle, retitling, onFork, onWorkspace, onExport, onResume, onCloseSession, onDelete }: {
  x: number; y: number; trigger: HTMLElement | null;
  info: SessionInfo; cold: boolean; canFork: boolean;
  onDismiss: () => void; onRename: () => void; onRetitle: () => void; retitling: boolean;
  onFork: () => void; onWorkspace: () => void;
  onExport: () => void;
  onResume: () => void; onCloseSession: () => void; onDelete: () => void;
}): JSX.Element {
  const panel = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(trigger);
  triggerRef.current = trigger;
  useDismiss(true, [panel, triggerRef], onDismiss);
  // Two passes: render, MEASURE, then clamp into the viewport. Trusting the click point was
  // how a menu ended up hanging off the bottom of a short screen (a popover at y<0 is
  // present in the DOM and invisible on it — a bug this repo has already paid for once).
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(6, Math.min(x, window.innerWidth - r.width - 6)),
      top: Math.max(6, Math.min(y, window.innerHeight - r.height - 6)),
    });
  }, [x, y]);

  const item = (label: string, icon: JSX.Element, onClick: () => void, danger = false): JSX.Element => (
    <button
      type="button"
      role="menuitem"
      className={`sess-menu-item ${danger ? "danger" : ""}`}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  return (
    <div
      ref={panel}
      className="sess-menu"
      role="menu"
      aria-label={`会话设置：${info.title}`}
      style={pos ? { left: pos.left, top: pos.top } : { left: x, top: y, visibility: "hidden" }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="sess-menu-head">
        <BackendAvatar backend={info.backend} cold={cold} status={info.status} />
        <span className="sess-menu-title" title={info.workspace || info.cwd}>{info.title}</span>
      </div>
      {item("重命名", <IconPencil size={14} />, onRename)}
      {item(
        retitling ? "正在重新生成…" : "重新生成会话名",
        retitling ? <IconRefresh size={14} className="spin" /> : <IconRefresh size={14} />,
        onRetitle,
      )}
      {canFork ? item(cold ? "fork 会话（先恢复）" : "fork 会话", <IconFork size={14} />, onFork) : null}
      {item("工作目录…", <IconFolder size={14} />, onWorkspace)}
      {item("导出会话（Markdown）", <IconDownload size={14} />, onExport)}
      {item("复制会话 ID", <IconCopy size={14} />, () => { void copyText(info.id); })}
      {cold ? item("取消归档并恢复", <IconResume size={14} />, onResume) : null}
      {cold
        ? item("删除会话（连记录）", <IconClose size={14} />, onDelete, true)
        : item("归档会话", <IconArchive size={14} />, onCloseSession)}
    </div>
  );
}

function Sidebar({ open, onNew, onNewIn, onSettings, settingsOpen }: {
  open: boolean;
  onNew: () => void;
  /** Create a session in the directory the operator already pointed at (a rail group's 「+」). */
  onNewIn: (cwd: string) => void;
  onSettings: () => void;
  settingsOpen: boolean;
}): JSX.Element {
  const { sessions, archived, activeId, conn, net, netError, authInfo } = useSyncExternalStore(cockpit.subscribe, cockpit.getSnapshot);
  // ---- presence: tell the server which session is on screen, so the phone can stay quiet while
  // I am looking at it (设置 → 手机通知 → 我正在看这个会话时不推). "Looking at it" means the tab is
  // visible AND I touched the machine recently — a laptop left open with the cockpit on screen is
  // not somebody watching, and treating it as such would silently swallow every notification.
  // Best-effort throughout: presence must never break the cockpit.
  //
  // Deliberately NOT one effect with a cleanup: the first version nulled the presence in the
  // cleanup on every session change, and that write raced its own follow-up ("I am watching X"),
  // leaving the server believing nobody was looking (caught by recording what the page actually
  // sent). So: a plain report per session change with no teardown, and a separate long-lived
  // effect that owns the interval and the "I am leaving" write.
  const lastInput = useRef(Date.now());
  // Relative stamps on the rail ("刚刚" / "12 分钟前") are only true for about a minute: without a
  // tick a row keeps saying "刚刚" an hour later. Slow on purpose — the rail is scanned, and a
  // 60s re-render of a list this size costs nothing.
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setClockTick((n) => n + 1), 60_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    const bump = (): void => { lastInput.current = Date.now(); };
    const events = ["pointerdown", "keydown", "mousemove", "wheel", "touchstart"];
    for (const e of events) window.addEventListener(e, bump, { passive: true });
    return () => { for (const e of events) window.removeEventListener(e, bump); };
  }, []);
  /** True when a human is plausibly at this screen right now (see presence.ts for why it is not
   *  merely "the tab is visible"). */
  const amWatching = (): boolean =>
    watchingNow({ visible: document.visibilityState === "visible", lastInputAt: lastInput.current, now: Date.now() });
  /** Are we ON A CALL with the session on screen? A call is not "watching": the hands are free and the
   *  screen is not being touched, so the idle rule above would drop presence mid-conversation — and the
   *  completion card ("跑完了") then arrived WITH A SOUND, into the microphone the agent is listening on. */
  const amOnCall = (): boolean => isCallActive() && document.visibilityState === "visible";
  const reportPresence = (sessionId: string | null, visible: boolean, keepalive = false, call = false): void => {
    void fetch("/api/notify/presence", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      keepalive,
      body: JSON.stringify({ sessionId, visible, call }),
    }).catch(() => { /* presence is a hint, never a requirement */ });
  };
  useEffect(() => {
    // A call keeps the session reported even while nothing is touched: the server treats that as
    // "watching" (suppress the duplicate) and as "a call is live" (send anything else silently).
    if (amOnCall()) reportPresence(activeId ?? null, true, false, true);
    else if (amWatching()) reportPresence(activeId ?? null, true);
    else reportPresence(null, false);
  }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps
  const activeRef = useRef<string | null>(activeId ?? null);
  activeRef.current = activeId ?? null;
  useEffect(() => {
    const tick = (): void => {
      if (amOnCall()) reportPresence(activeRef.current, true, false, true);
      else if (amWatching()) reportPresence(activeRef.current, true);
      else reportPresence(null, false);
    };
    const t = window.setInterval(tick, 30_000); // server-side TTL is 90s
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
      reportPresence(null, false, true); // leaving the page means nobody is looking
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [q, setQ] = useState("");
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [busyId, setBusyId] = useState("");
  const [err, setErr] = useState("");
  // ---- row menus + inline rename ------------------------------------------------
  // One menu per row, opened three ways (studio parity): right-click, the ⋯ button, and a
  // phone long-press. The LONG PRESS is a plain timer, not a hook per row — only one press
  // can be in flight, and a per-row hook would be a hooks-order trap inside the map below.
  const rows = useRef<Map<string, HTMLElement>>(new Map());
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; trigger: HTMLElement | null } | null>(null);
  const [editing, setEditing] = useState("");
  const [draft, setDraft] = useState("");
  const [pickFor, setPickFor] = useState("");
  // which session's menu is waiting on a regenerated name (drives the menu's spinner)
  const [retitling, setRetitling] = useState("");
  const pressTimer = useRef<number | null>(null);
  const pressFired = useRef(false);
  const pressClear = (): void => { if (pressTimer.current) { window.clearTimeout(pressTimer.current); pressTimer.current = null; } };
  useEffect(() => pressClear, []);
  // A long press must also swallow the click that follows it, or the menu opens AND the
  // session switches underneath it.
  const pressStart = (id: string, x: number, y: number): void => {
    pressFired.current = false;
    pressClear();
    pressTimer.current = window.setTimeout(() => {
      pressFired.current = true;
      openMenu(id, x, y, rows.current.get(id) ?? null);
    }, 500);
  };
  const openMenu = (id: string, x: number, y: number, trigger: HTMLElement | null): void => {
    setMenu({ id, x, y, trigger });
  };
  /** Open from a button/row: the pointer's own coordinates when we have them, else the
   *  anchor's box. A keyboard/programmatic click carries (0,0) — that must not fling the
   *  menu into the corner, so an all-zero point is treated as "no point" and the menu
   *  lands under the element that was activated (the row's ⋯ button). */
  const openFrom = (id: string, e: { clientX?: number; clientY?: number }, anchorEl?: HTMLElement | null): void => {
    const row = rows.current.get(id);
    const anchor = anchorEl ?? row ?? null;
    const box = anchor?.getBoundingClientRect();
    const hasPoint = Number.isFinite(e.clientX) && Number.isFinite(e.clientY)
      && (e.clientX !== 0 || e.clientY !== 0);
    const x = hasPoint ? Number(e.clientX) : (box ? box.right - 6 : 12);
    const y = hasPoint ? Number(e.clientY) : (box ? box.bottom + 4 : 12);
    openMenu(id, x, y, anchor);
  };
  const startRename = (s: SessionInfo): void => { setMenu(null); setDraft(s.title); setEditing(s.id); };
  const commitRename = async (id: string): Promise<void> => {
    const next = draft.trim();
    setEditing("");
    const cur = sessions.find((x) => x.id === id) ?? archived.find((x) => x.id === id);
    if (!cur || next === cur.title) return;   // nothing to do (also covers "opened, typed nothing")
    setErr("");
    try {
      await cockpit.rename(id, next.length ? next : null);
    } catch (e) {
      setErr(`改名失败：${String((e as Error)?.message ?? e)}`);
    }
  };
  // "重新生成会话名": keep the menu open with a spinner while the server asks the agent
  // (a fork + one turn, up to ~90s), then close it. The row itself updates over WS.
  const regenerateTitle = async (info: SessionInfo): Promise<void> => {
    setErr("");
    setRetitling(info.id);
    try {
      const { via } = await cockpit.regenerateTitle(info.id);
      setMenu(null);
      if (via === "derived") {
        // Honest about what happened: no agent summary — we named it after the latest message.
        setErr("已按最新一条消息生成会话名（该后端不支持摘要式重新生成）");
      }
    } catch (e) {
      setErr(`生成会话名失败：${String((e as Error)?.message ?? e)}`);
    } finally {
      setRetitling("");
    }
  };
  const menuInfo = menu ? (sessions.find((x) => x.id === menu.id) ?? archived.find((x) => x.id === menu.id) ?? null) : null;
  const menuCold = menu ? !sessions.some((x) => x.id === menu.id) : false;
  const needle = q.trim().toLowerCase();
  const match = (s: { title: string; backend: string; cwd: string; workspace?: string | null }) =>
    !needle || `${s.title} ${s.backend} ${s.workspace || s.cwd}`.toLowerCase().includes(needle);

  const groups = useMemo(() => {
    const all = [
      ...sessions.map((s) => ({ s, cold: false })),
      ...archived.map((s) => ({ s, cold: true })),
    ].filter(({ s }) => match(s));
    const byPath = new Map<string, { path: string; label: string; items: { s: SessionInfo; cold: boolean }[] }>();
    for (const it of all) {
      const path = it.s.workspace || it.s.cwd;
      const label = path.split("/").filter(Boolean).pop() ?? path;
      const g = byPath.get(path) ?? { path, label, items: [] };
      g.items.push(it);
      byPath.set(path, g);
    }
    const activeKey = activeId ? (sessions.find((s) => s.id === activeId)?.workspace ?? sessions.find((s) => s.id === activeId)?.cwd ?? "") : "";
    // When the operator last TALKED to a session (creation time when it has no messages yet).
    // The rule lives at module scope (`lastOf`): the row renders the same value it sorts by.
    // A workspace is as recent as its newest session, so the workspace order follows the
    // session order: chat in a directory and that group rises with it.
    const at = (g: { items: { s: SessionInfo }[] }): number => g.items.reduce((m, i) => Math.max(m, lastOf(i.s)), 0);
    return [...byPath.values()]
      // live before cold inside a group (a session you can talk to now beats one you cannot),
      // then whichever one the operator last talked to
      .map((g) => ({
        ...g,
        items: [...g.items].sort((a, b) =>
          (a.cold === b.cold ? 0 : a.cold ? 1 : -1)
          || (lastOf(b.s) - lastOf(a.s))
          || (b.s.createdAt - a.s.createdAt)),
      }))
      // the group you are working in first, then by last chat, then alphabetically
      .sort((a, b) => (a.path === activeKey ? -1 : b.path === activeKey ? 1 : at(b) - at(a) || a.label.localeCompare(b.label)));
  }, [sessions, archived, activeId, needle]);

  const onFork = async (id: string): Promise<void> => {
    setBusyId(id);
    setErr("");
    try {
      await cockpit.fork(id);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusyId("");
    }
  };

  return (
    <aside className={`sidebar ${open ? "open" : ""}`}>
      <header>
        <span className="logo">⛟ AgentSlot</span>
        <span className="tagline">keep your agents on the track</span>
        <button
          className={`icon-btn rail-gear ${settingsOpen ? "on" : ""}`}
          title="设置 — 后端、主题、语音识别、语音合成、热词"
          aria-label="settings"
          aria-pressed={settingsOpen}
          onClick={onSettings}
        >
          <IconSettings size={15} />
        </button>
      </header>
      {net === "degraded" || conn === "offline" ? (
        <div className="net-banner" title={netError}>
          <span>
            {conn === "offline"
              ? "⚠ 与服务的连接已断开 — 正在重连（指令会排队）"
              : `⚠ 服务不可达 — ${netError || "请求超时"}`}
          </span>
          <button onClick={() => location.reload()}>reload</button>
        </div>
      ) : null}
      <button className="new-btn" onClick={onNew} title="new session (pick a backend + working directory)">
        <IconPlus size={14} /> new session
      </button>
      <div className="rail-search-wrap">
        <IconSearch size={13} />
        <input
          className="rail-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search sessions…"
          aria-label="search sessions"
        />
      </div>
      {err ? (
        <div className="rail-error" title={err}>
          {err}
          <button className="draft-x" aria-label="dismiss" onClick={() => setErr("")}><IconClose size={11} /></button>
        </div>
      ) : null}
      <div className="session-list">
        {groups.map((g) => {
          const isOpen = Boolean(needle) || !closed[g.path];
          const liveCount = g.items.filter((i) => !i.cold).length;
          return (
            <div className="rail-group" key={g.path}>
              <div className="rail-group-row">
              <button
                type="button"
                className={`rail-group-head ${isOpen ? "open" : ""}`}
                title={g.path}
                aria-expanded={isOpen}
                data-workspace={g.path}
                onClick={() => setClosed((c) => ({ ...c, [g.path]: !c[g.path] }))}
              >
                <IconChevronRight size={11} className={`rail-group-chev ${isOpen ? "open" : ""}`} />
                <IconFolder size={12} />
                <span className="rail-group-name">{g.label}</span>
                <span className="rail-group-count">
                  {g.label && liveCount ? `${liveCount}/${g.items.length}` : g.items.length}
                </span>
              </button>
              {/* "start a session HERE" — the directory this group is, without re-picking it
                  (AionUi's per-project 「+」 in `GroupedHistory`: the header carries the
                  affordance, and the new-session screen opens pre-pointed at that folder).
                  Hover-revealed on desktop like the row menu, always on a touch screen. */}
              <button
                type="button"
                className="item-btn group-add"
                title={`在 ${g.path} 新建会话`}
                aria-label={`在 ${g.path} 新建会话`}
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  setClosed((c) => ({ ...c, [g.path]: false }));
                  onNewIn(g.path);
                }}
              >
                <IconPlus size={12} />
              </button>
            </div>
              {isOpen ? (
                <div className="rail-group-body">
                  {g.items.map(({ s, cold }) => (
                    <div
                      key={s.id}
                      ref={(el) => { if (el) rows.current.set(s.id, el); else rows.current.delete(s.id); }}
                      className={`session-item ${cold ? "cold" : ""} ${s.id === activeId ? "active" : ""} ${editing === s.id ? "editing" : ""}`}
                      data-session={s.id}
                      title={cold ? `${s.title} — 已归档，点一下取消归档并恢复` : s.title}
                      onContextMenu={(e) => { e.preventDefault(); openFrom(s.id, e); }}
                      onTouchStart={(e) => { const t = e.touches[0]; pressStart(s.id, t?.clientX ?? 0, t?.clientY ?? 0); }}
                      onTouchEnd={pressClear}
                      onTouchMove={pressClear}
                      onTouchCancel={pressClear}
                      onClick={(e) => {
                        if (pressFired.current) { pressFired.current = false; e.preventDefault(); return; }
                        if (editing === s.id) return;
                        if (cold) void cockpit.resume(s.id); else cockpit.setActive(s.id);
                      }}
                    >
                      <BackendAvatar backend={s.backend} cold={cold} status={s.status} />
                      {editing === s.id ? (
                        <input
                          className="title-input"
                          value={draft}
                          autoFocus
                          aria-label={`重命名 ${s.title}`}
                          onChange={(e) => setDraft(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onPointerDown={(e) => e.stopPropagation()}
                          onBlur={() => void commitRename(s.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); void commitRename(s.id); }
                            else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setEditing(""); }
                          }}
                        />
                      ) : (
                        <span className="title" onDoubleClick={(e) => { e.stopPropagation(); startRename(s); }}>{s.title}</span>
                      )}
                      {cockpit.byId.get(s.id)?.perms.length ? (
                        <span className="badge perm" title="有审批在等你">⚿ {cockpit.byId.get(s.id)!.perms.length}</span>
                      ) : null}
                      {/* When I last talked to this session — sorted by it, so it has to be visible.
                          Relative on purpose ("刚刚" / "3 小时前" / "昨天"), with the exact stamp in
                          the tooltip; the operator asked for exactly this and for it to age. */}
                      <span className="rail-at" title={`最后一次消息：${stamp(lastOf(s))}`}>{relTime(lastOf(s))}</span>
                      <button
                        type="button"
                        className="item-btn row-menu"
                        title="会话设置：重命名 / fork / 工作目录 / 导出 / 归档"
                        aria-label={`${s.title} 的会话设置`}
                        aria-haspopup="menu"
                        aria-expanded={menu?.id === s.id}
                        onClick={(e) => { e.stopPropagation(); e.preventDefault(); openFrom(s.id, e, e.currentTarget); }}
                      >
                        <IconDotsV size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
        {!groups.length && (
          <div className="rail-empty">
            {needle ? "no session matches that search." : "No sessions yet — create one."}
          </div>
        )}
      </div>
      {menu && menuInfo ? createPortal(<SessionMenu
          x={menu.x} y={menu.y} trigger={menu.trigger}
          info={menuInfo} cold={menuCold} canFork={Boolean(menuInfo.acpSessionId) || menuCold}
          onDismiss={() => setMenu(null)}
          onRename={() => startRename(menuInfo)}
          retitling={retitling === menuInfo.id}
          onRetitle={() => { void regenerateTitle(menuInfo); }}
          onFork={() => { setMenu(null); void onFork(menuInfo.id); }}
          onWorkspace={() => { setMenu(null); setPickFor(menuInfo.id); }}
          onExport={() => {
            setMenu(null);
            // cookie-auth'd GET with Content-Disposition: attachment — the browser saves it.
            // Works for archived sessions too: the export renders from our own rows, not the agent.
            const a = document.createElement("a");
            a.href = `/api/sessions/${menuInfo.id}/export?format=md`;
            a.download = "";
            document.body.appendChild(a); a.click(); a.remove();
          }}
          onResume={() => { setMenu(null); void cockpit.resume(menuInfo.id); }}
          onCloseSession={() => {
            setMenu(null);
            if (confirm(`归档“${menuInfo.title}”？\n\nagent 进程会退出，记录保留在归档里（随时可取消归档并恢复）。`)) cockpit.closeSession(menuInfo.id);
          }}
          onDelete={() => {
            setMenu(null);
            if (confirm(`删除“${menuInfo.title}”？\n\n记录会从磁盘上移除，无法撤销。`)) cockpit.purgeCold(menuInfo.id);
          }}
        />, document.body) : null}
      {pickFor ? createPortal(
        <div className="modal-bg" onClick={() => setPickFor("")}>
          <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
            <h3>工作目录</h3>
            <div className="hint">
              文件面板与终端以它为根。运行中的 agent 仍留在启动时的目录 —— 新目录对下一次恢复生效。
            </div>
            <WorkspacePicker
              value={(sessions.find((x) => x.id === pickFor) ?? archived.find((x) => x.id === pickFor))?.workspace
                ?? (sessions.find((x) => x.id === pickFor) ?? archived.find((x) => x.id === pickFor))?.cwd ?? ""}
              onChange={(path) => { const id = pickFor; setPickFor(""); void cockpit.setWorkspace(id, path); }}
            />
            <div className="row"><button className="cancel" onClick={() => setPickFor("")}>取消</button></div>
          </div>
        </div>, document.body) : null}
      <footer>
        <span className={`conn ${conn}`}>{conn === "online" ? "● online" : conn}</span>
        {authInfo ? <span className="who" title={`signed in as ${authInfo.username ?? "?"}`}>{authInfo.username}</span> : null}
        <button
          className="logout-btn"
          title={`signed in as ${authInfo?.username ?? "?"} — sign out`}
          aria-label="sign out"
          onClick={() => void cockpit.logout()}
        >
          <IconPower size={14} />
        </button>
      </footer>
    </aside>
  );
}

function Main({ onMenu, settingsOpen, onCloseSettings, onPermClick }: {
  onMenu: () => void;
  settingsOpen: boolean;
  onCloseSettings: () => void;
  /** Reopen the approval dialog for the request waiting on this session (the ⚿ chip). */
  onPermClick: () => void;
}): JSX.Element {
  const { active } = useSyncExternalStore(cockpit.subscribe, cockpit.getSnapshot);
  // The panel (files · terminal) is per-slot UI state, not a server thing: it lives
  // here so switching slots keeps the panel open on the new slot's workspace.
  const [panelOpen, setPanelOpen] = useState(false);
  const [pickWorkspace, setPickWorkspace] = useState(false);
  // The call overlay is launched from the HEAD (it is a way of talking to the session,
  // like the other head controls) but lives in the composer, so the state sits here:
  // the head opens it, the composer renders it and can hand the keyboard back.
  const [call, setCall] = useState(false);
  // Voice capabilities are fetched once; the buttons fall back to browser-only until
  // the answer arrives.
  useEffect(() => { void loadVoiceCaps(); }, []);
  useAutoRead(lastFinishedReply(active), Boolean(active && !active.busy && active.loaded));

  if (settingsOpen) {
    return <SettingsPage onClose={onCloseSettings} sessionId={active?.info.id} />;
  }
  if (!active) {
    return (
      <div className="main">
        <div className="chat-head">
          <button className="icon-btn menu-btn" onClick={onMenu} title="sessions" aria-label="sessions"><IconMenu /></button>
          <span className="title">AgentSlot</span>
        </div>
        <div className="empty">
          <div className="big">⛟</div>
          <p>No session selected.<br />Create one and point it at a real <code>hermes acp</code> / <code>qodercli --acp</code>.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="main">
      <ChatHead
        v={active}
        onMenu={onMenu}
        panelOpen={panelOpen}
        onTogglePanel={() => setPanelOpen((o) => !o)}
        onPickWorkspace={() => setPickWorkspace(true)}
        call={call}
        onCall={() => { dictation.stop(); setCall(true); }}
        onPerm={onPermClick}
      />
      <div className="main-body">
        <div className="chat-col">
          <Stream v={active} />
          <Composer v={active} call={call} onCloseCall={() => setCall(false)} />
        </div>
        {panelOpen && (
          <ToolPanel
            v={active}
            onClose={() => setPanelOpen(false)}
            onPickWorkspace={() => setPickWorkspace(true)}
          />
        )}
      </div>
      {pickWorkspace && (
        <WorkspaceModal
          v={active}
          onClose={() => setPickWorkspace(false)}
        />
      )}
    </div>
  );
}

/** The reply an auto-read should speak: the newest agent message, but only when it
 *  just arrived (a slot opened from history must not start talking to the room). */
function lastFinishedReply(v: SessionView | undefined): { key: string; text: string } | null {
  if (!v || v.busy || !v.loaded) return null;
  if (Date.now() - v.lastAt > 30_000) return null;
  for (let i = v.msgs.length - 1; i >= 0; i -= 1) {
    const m = v.msgs[i];
    if (m.kind === "agent" && m.text.trim()) return { key: m.key, text: m.text };
  }
  return null;
}

/** Point the current slot at another directory. Same picker as "new slot" — the
 *  difference is the consequence, and that is spelled out in the modal. */
function WorkspaceModal({ v, onClose }: { v: SessionView; onClose: () => void }): JSX.Element {
  useEscape(true, onClose);
  const current = v.info.workspace || v.info.cwd;
  const [path, setPath] = useState(current);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const save = async (): Promise<void> => {
    setBusy(true);
    setErr("");
    try {
      await cockpit.setWorkspace(v.info.id, path.trim());
      onClose();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
        <h3>workspace</h3>
        <div className="hint">
          the file panel and terminal work here. A running agent keeps the directory it
          was started in — the new one applies to this session from the next resume.
        </div>
        <WorkspacePicker value={path} onChange={setPath} />
        {err && <div className="err">{err}</div>}
        <div className="row">
          <button className="cancel" onClick={onClose}>cancel</button>
          <button className="go" disabled={busy || !path.trim()} onClick={() => void save()}>
            {busy ? "saving…" : "use this folder"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatHead({ v, onMenu, panelOpen, onTogglePanel, onPickWorkspace, call, onCall, onPerm }: {
  v: SessionView;
  onMenu: () => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
  onPickWorkspace: () => void;
  call: boolean;
  onCall: () => void;
  onPerm: () => void;
}): JSX.Element {
  const info = v.info;
  const wsName = (info.workspace || info.cwd).split("/").filter(Boolean).pop() ?? info.cwd;
  const [prefs, setPrefs] = useVoicePrefs();
  // capabilities land after boot (loadVoiceCaps) — subscribe, or a browser with no local
  // voice would keep the button disabled after the server answered that it can speak
  const caps = useSyncExternalStore(subscribeVoiceCaps, voiceCaps);
  // Auto-read is a LISTENING MODE rather than a buried setting: it changes what every
  // reply does, so the operator asked for it next to the session's own controls (this is
  // the one addition to the header; mode/depth/context stay in the composer). Same pref
  // as the settings switch — one store, so the two can never disagree.
  const canSpeak = caps.tts.server
    || (typeof window !== "undefined" && "speechSynthesis" in window);
  const autoReadTitle = !canSpeak
    ? "自动朗读：这台设备没有可用语音（浏览器无 speechSynthesis，服务端也没配）"
    : prefs.autoRead
      ? "自动朗读：开 —— 每条回复结束后自动念出来（点一下关闭）"
      : "自动朗读：关 —— 点一下开启，之后每条回复结束都会自动念出来";
  // The head keeps identity and session controls: where this slot works, the panel that
  // shows it, and the two ways of TALKING to it (call, auto-read) — the operator's call
  // list. Mode, thinking depth and context stay in the composer, where the prompt is
  // written: a header is a place for identity, not for settings.
  return (
    <div className="chat-head">
      <button className="icon-btn menu-btn" onClick={onMenu} title="sessions" aria-label="sessions"><IconMenu /></button>
      <span className="title" title={info.title}>{info.title}</span>
      {v.perms.length > 0 ? (
        <button
          type="button"
          className="chip perm-chip"
          title="这个会话有请求等你的答复 —— 点一下打开授权弹窗"
          aria-label={`有 ${v.perms.length} 个请求等你授权`}
          onClick={onPerm}
        >
          <span className="perm-pulse" />⚿ {v.perms.length}
        </button>
      ) : null}
      <span className="head-spacer" />
      {/* One cluster: the way in to talking with this session (call, dictation-backed
          reading), then where it works and what it shows. Same gap as the composer's
          tool row — icon buttons that belong together should read as one strip, not
          as separate stops. */}
      <span className="head-actions">
        <button
          className={`icon-btn ${call ? "on" : ""}`}
          title="语音通话 —— 像打电话一样跟这个会话说话"
          aria-label="开始语音通话"
          onClick={onCall}
        >
          <IconPhone />
        </button>
        <button
          className={`icon-btn auto-read ${prefs.autoRead ? "on" : ""}`}
          title={autoReadTitle}
          aria-label="自动朗读新回复"
          aria-pressed={prefs.autoRead}
          disabled={!canSpeak}
          onClick={() => setPrefs({ autoRead: !prefs.autoRead })}
        >
          {prefs.autoRead ? <IconVolume /> : <IconVolumeOff />}
        </button>
        <button
          className="icon-btn"
          title={`workspace: ${info.workspace || info.cwd}\nclick to point this session at another directory`}
          aria-label="workspace"
          onClick={onPickWorkspace}
        >
          <IconFolder />
        </button>
        <button
          className={`icon-btn ${panelOpen ? "on" : ""}`}
          title="workspace panel — files and terminal"
          aria-label="workspace panel"
          aria-expanded={panelOpen}
          onClick={onTogglePanel}
        >
          <IconPanel />
        </button>
      </span>
    </div>
  );
}

/** Context-window gauge from ACP usage_update (AionUi F-DISPLAY-07 lineage).
 *  Icon-first like the rest of the head: a ring that fills, the numbers in the
 *  tooltip — plus the per-turn trace, which no longer needs its own chip because the
 *  two selects already show mode and depth (AionUi F-DISPLAY-11). */
function ContextGauge({ usage, trace }: { usage?: UsageView | null; trace?: TurnTrace | null }): JSX.Element | null {
  if (!usage || (!usage.used && !usage.size)) return null;
  const pct = usage.size > 0 ? Math.min(100, Math.round((usage.used / usage.size) * 100)) : 0;
  const level = pct >= 85 ? "hot" : pct >= 65 ? "warn" : "ok";
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
  const R = 7;
  const C = 2 * Math.PI * R;
  const traceText = trace && (trace.effort || trace.mode)
    ? ` · this turn: ${[trace.effort && `effort ${trace.effort}`, trace.mode && `mode ${trace.mode}`].filter(Boolean).join(", ")}`
    : "";
  return (
    <span
      className={`ctx ${level}`}
      title={
        (usage.size > 0
          ? `context window: ${usage.used} / ${usage.size} tokens (${pct}%)`
          : `context used: ${usage.used} tokens (this agent reports no window size)`)
        + (usage.cost != null ? `, cost $${usage.cost.toFixed(4)}` : "")
        + traceText
      }
    >
      <svg width={18} height={18} viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r={R} fill="none" stroke="currentColor" strokeOpacity={0.22} strokeWidth={2} />
        {usage.size > 0 ? (
          <circle
            cx="9" cy="9" r={R} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"
            strokeDasharray={`${(C * pct) / 100} ${C}`}
            transform="rotate(-90 9 9)"
          />
        ) : null}
      </svg>
      <span className="ctx-text">
        {fmt(usage.used)}{usage.size > 0 ? `/${fmt(usage.size)}` : ""}
      </span>
    </span>
  );
}

/** Imperative "follow the stream again" hook, so the composer can re-attach the
 *  view when the operator sends. Module-level on purpose: the two components have
 *  no shared parent state and threading a ref through the tree for this would be
 *  more code than the behaviour is worth. */
const streamReattach: { current: () => void } = { current: () => {} };

function Stream({ v }: { v: SessionView }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const programmatic = useRef(false);
  const keepUntil = useRef(0);
  const [follow, setFollow] = useState(true);
  const [unseen, setUnseen] = useState(false);
  const [, force] = useState(0);

  // How close to the bottom still counts as "following". Generous on purpose: a
  // 48px blind spot meant the smallest scroll-up got yanked back by the next
  // streamed chunk (the reported bug).
  const NEAR = 140;

  const isNear = (el: HTMLDivElement): boolean => el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR;

  const scrollNow = (): void => {
    const el = ref.current;
    if (!el) return;
    programmatic.current = true; // our own scroll must not count as "user scrolled away"
    el.scrollTop = el.scrollHeight;
  };

  streamReattach.current = () => {
    stick.current = true;
    keepUntil.current = Date.now() + 1500; // keep following briefly after a send
    setFollow(true);
    setUnseen(false);
    scrollNow();
  };

  // ---- user intent beats scroll position -------------------------------------
  // Position alone is not enough: while a turn streams, the newest chunk is added
  // right under the viewport, so a wheel/touch/key gesture has to detach *now*,
  // not after we happen to fall more than NEAR behind.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const detach = (): void => {
      programmatic.current = false;
      stick.current = false;
      setFollow(false);
    };
    const onScroll = (): void => {
      if (programmatic.current) {
        programmatic.current = false;
        return;
      }
      const near = isNear(el);
      stick.current = near;
      setFollow(near);
      if (near) setUnseen(false);
    };
    const onWheel = (e: WheelEvent): void => { if (e.deltaY < 0) detach(); };
    let touchY = 0;
    const onTouchStart = (e: TouchEvent): void => { touchY = e.touches[0]?.clientY ?? 0; };
    // dragging the finger DOWN scrolls back toward older content => detach
    const onTouchMove = (e: TouchEvent): void => {
      const y = e.touches[0]?.clientY ?? 0;
      if (y > touchY + 4) detach();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "PageUp" || e.key === "ArrowUp" || e.key === "Home") detach();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("keydown", onKey);
    };
  }, []);

  // Follow only while following: no scroll is forced on a reader who scrolled away.
  useEffect(() => {
    if (stick.current || Date.now() < keepUntil.current) {
      scrollNow();
      return;
    }
    if (v.msgs.length) setUnseen(true); // output arrived off-screen: say so on the button
    // v.rev, not v.msgs: chunks merge into the bubble above, so the array identity is
    // stable and this effect would never run on new output.
  }, [v.rev, v.busy, v.perms.length]);

  // Keep the reader's place when an older page is prepended (paging used to shove
  // the viewport by a whole page, so "load earlier" felt like a jump to nowhere).
  const loadEarlier = async (): Promise<void> => {
    const el = ref.current;
    const beforeH = el?.scrollHeight ?? 0;
    const beforeT = el?.scrollTop ?? 0;
    stick.current = false;
    setFollow(false);
    await cockpit.loadEarlier(v.info.id);
    requestAnimationFrame(() => {
      const after = ref.current;
      if (!after) return;
      programmatic.current = true;
      after.scrollTop = after.scrollHeight - beforeH + beforeT;
    });
  };

  // The transcript is FOLDED now (a turn's tool calls are one row, finished thinking is one
  // line), so one page of history can fit on a screen with more still on disk — and a
  // "load earlier messages" button with empty space under it is the one thing the operator
  // cannot read anything into. Keep pulling pages while there is room. Bounded: a slot with
  // hundreds of messages must not load forever in the background.
  const autoPages = useRef(0);
  useEffect(() => { autoPages.current = 0; }, [v.info.id]);
  useEffect(() => {
    const el = ref.current;
    if (!el || !v.hasOlder || v.loadingOlder || autoPages.current >= 4) return;
    if (el.scrollHeight > el.clientHeight + 80) return;
    autoPages.current += 1;
    void cockpit.loadEarlier(v.info.id);
  }, [v.rev, v.hasOlder, v.loadingOlder, v.info.id]);

  // idle hint: running but silent for >3min => "still waiting" (AionUi F-RELIABILITY-02 lite)
  useEffect(() => {
    if (!v.busy) return;
    const t = setTimeout(() => force((x) => x + 1), 180_000);
    return () => clearTimeout(t);
  }, [v.busy, v.msgs.length]);

  const showWait = v.busy && Date.now() - v.lastAt > 175_000;

  return (
    <div className="stream-wrap">
      <div className="stream" ref={ref} tabIndex={0}>
        <div className="stream-inner">
          {v.hasOlder && (
            <div className="load-earlier">
              <button className="ghost-btn" disabled={v.loadingOlder} onClick={() => void loadEarlier()}>
                {v.loadingOlder ? "loading…" : "↑ load earlier messages"}
              </button>
            </div>
          )}
          {foldWork(v.msgs, v.busy).map((row) => (row.kind === "work"
            ? <WorkRun key={row.key} items={row.items} />
            : <Bubble key={row.m.key} m={row.m} sid={v.info.id} busy={v.busy} last={row.tail} live={row.live} />))}
          {v.busy && <div className="stream-hint">▸ turn in progress…</div>}
          {showWait && <div className="stream-hint">⏳ still waiting for the agent…</div>}
          {/* A request belongs NEXT TO the turn that is waiting on it — at the tail, where the
              eye already is. Rendering it above the whole transcript (the old place) put it
              thousands of pixels out of sight in any conversation longer than a screen: the
              operator saw nothing while the agent sat blocked, and Hermes self-denied after
              its own `approvals.timeout`. Measured: rect.top = -7365px on a 20-message
              transcript, -10600px at 390×844. */}
          {v.perms.map((p) => <PermCard key={p.requestId} sid={v.info.id} req={p} />)}
        </div>
      </div>
      {!follow && (
        <button
          className={`jump-latest ${unseen ? "has-new" : ""}`}
          onClick={() => streamReattach.current()}
          title={unseen ? "new output — jump to the newest" : "jump to the newest"}
          aria-label="jump to newest output"
        >
          <IconArrowDown size={14} />
          {unseen ? <span className="jump-dot" aria-hidden="true" /> : null}
        </button>
      )}
    </div>
  );
}

/** One message. `last` marks the transcript tail — that is where the fork action lives
 *  (a fork means "carry this work on as a new session", which only makes sense from the
 *  end of what the agent currently holds), and copy is on every message. */
function Bubble({ m, sid, last, busy, live }: { m: MsgView; sid: string; last: boolean; busy: boolean; live?: boolean }): JSX.Element | null {
  switch (m.kind) {
    case "user":
      return (
        <div className="msg user">
          <div className="role">YOU</div>
          <div className="bubble">
            {m.files.length > 0 ? (
              <div className="bubble-files">
                {m.files.map((f, i) => (
                  <span key={`${f.name}-${i}`} className="bubble-file" title={f.name}>
                    {f.kind === "image" ? <IconPaperclip size={12} /> : <IconFile size={12} />}
                    {f.name}
                  </span>
                ))}
              </div>
            ) : null}
            {m.text}
            <div className="bubble-actions">
              {m.at ? <span className="msg-at" title={stamp(m.at)}>{messageTime(m.at)}</span> : null}
              <CopyButton text={m.text} what="这条消息" />
            </div>
          </div>
        </div>
      );
    case "agent":
      return (
        <div className="msg agent">
          <div className="role">AGENT</div>
          <div className="bubble">
            <Markdown text={m.text} />
            <div className="bubble-actions">
              {m.at ? <span className="msg-at" title={stamp(m.at)}>{messageTime(m.at)}</span> : null}
              <CopyButton text={m.text} what="这条回复" />
              <SpeakButton id={m.key} text={m.text} />
              {last && !busy ? <ForkHere sid={sid} busy={busy} /> : null}
            </div>
          </div>
        </div>
      );
    case "thought":
      return <Thought m={m} live={Boolean(live)} />;
    case "tool":
      return <ToolCard m={m} />;
    case "plan":
      if (!m.items.length) return null;
      return (
        <div className="msg plan"><div className="bubble">
          {m.items.map((it, i) => (
            <div key={i}>{it.status === "completed" ? "☑" : it.status === "in_progress" ? "▶" : "☐"} {it.content}</div>
          ))}
        </div></div>
      );
    case "meta":
      return <div className="msg meta"><div className="bubble">{m.text}</div></div>;
    default:
      return null;
  }
}

/** Tool call card with viewable input/output (AionUi F-DISPLAY-03). Collapsed by
 *  default so a long transcript stays scannable; the agent's own status drives the colour. */
/** One line, always. A tool call is a step in the transcript, not a report: the title
 *  is truncated (the operator asked for it), the status is a dot instead of a second
 *  line of text, and the full name/kind/status/input/output only appear once expanded. */
function ToolCard({ m }: { m: Extract<MsgView, { kind: "tool" }> }): JSX.Element {
  const [open, setOpen] = useState(false);
  const hasBody = Boolean(m.input || m.detail);
  const status = statusOf(m.status);
  return (
    <div className="msg">
      <div className={`tool-card ${m.status}`}>
        <button
          type="button"
          className="tool-head"
          onClick={() => hasBody && setOpen((x) => !x)}
          title={hasBody ? `${m.title}\nclick for the full call and its result` : m.title}
          aria-expanded={hasBody ? open : undefined}
        >
          <span className={`tool-dot ${status}`} aria-hidden="true" />
          <span className="tool-title">{m.title}</span>
          {m.at ? <span className="msg-at" title={stamp(m.at)}>{clockHM(m.at)}</span> : null}
          {hasBody ? <IconChevronRight size={11} className={`tool-chev ${open ? "open" : ""}`} /> : null}
        </button>
        {open && (
          <div className="tool-body">
            <div className="lbl">tool</div>
            <pre className="tool-meta">{m.title}</pre>
            <div className="lbl">kind · status</div>
            <pre className="tool-meta">{m.kind2 ? `${m.kind2} · ` : ""}{m.status}</pre>
            {m.input ? (
              <>
                <div className="lbl">input</div>
                <pre>{m.input}</pre>
              </>
            ) : null}
            {m.detail ? (
              <>
                <div className="lbl">output</div>
                <pre>{m.detail}</pre>
              </>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

/** ACP tool-call status → the dot's class. Unknown states stay neutral rather than
 *  being reported as failures. */
function statusOf(raw: string): "running" | "ok" | "err" | "idle" {
  const s = String(raw || "").toLowerCase();
  if (s === "completed" || s === "success") return "ok";
  if (s === "failed" || s === "error" || s === "cancelled") return "err";
  if (s === "in_progress" || s === "running" || s === "pending") return "running";
  return "idle";
}

/** Thinking, folded to keep the transcript readable — the operator's report was "老是刷屏".
 *
 *  While this block is the one still being written it stays open, but inside a small window
 *  that scrolls itself (about six lines: enough to see it think, not enough to take the
 *  screen). As soon as the agent moves on — a tool call, a reply — the block folds itself to
 *  its header line, and a click is what opens it from then on. That is hermes-studio's shape
 *  (`thinkingStreamingNow` keeps only the live one open; `thinkingOverride` for a click),
 *  with the scrolling window the operator asked for on top. */
function Thought({ m, live }: { m: Extract<MsgView, { kind: "thought" }>; live: boolean }): JSX.Element {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? live;
  const body = useRef<HTMLDivElement>(null);
  // a live window follows its own tail: text arrives in chunks and the reader should be at
  // the newest line without touching anything (deps by value, so this runs as the text grows)
  useEffect(() => {
    if (live && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [m.text, live]);
  return (
    <div className={`msg thought${live ? " live" : ""}`}>
      <button
        type="button"
        className="role thought-head"
        aria-expanded={open}
        aria-label={`${open ? "fold" : "open"} the agent's thinking`}
        onClick={() => setUserOpen(!open)}
      >
        <IconChevronRight size={11} className={`thought-chev${open ? " open" : ""}`} />
        💭 {live ? "思考中…" : "思考"}
        <span className="thought-meta">{m.at ? `${messageTime(m.at)} · ` : ""}{m.text.length} 字</span>
      </button>
      {open && (
        <div className={`bubble${live ? " live" : ""}`} ref={body}>
          {m.text}
          {live ? null : (
            <div className="bubble-actions">
              <CopyButton text={m.text} what="这段思考" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One row of the transcript: a message as it stands, or one stretch of the agent's WORK
 *  (its thinking and its tool calls, in order) folded into a single line. */
type ToolMsg = Extract<MsgView, { kind: "tool" }>;
type ThoughtMsg = Extract<MsgView, { kind: "thought" }>;
type WorkItem = ToolMsg | ThoughtMsg;
const isWork = (m: MsgView): m is WorkItem => m.kind === "thought" || m.kind === "tool";
type StreamRow =
  | { kind: "msg"; m: MsgView; live: boolean; tail: boolean }
  | { kind: "work"; key: string; items: WorkItem[]; tail: boolean };

/** How many of the newest work items stay OUT of the fold and render as their own rows.
 *  The operator's rule (2026-10-06): "保留最后 5 条…下一轮开始的时候，那 5 条再自动合并到那一行里". */
const TAIL_PREVIEW = 5;

/** Fold one stretch of work into a single row — thinking and tool calls TOGETHER.
 *
 *  Why both (measured 2026-10-06): folding only the calls moved the flood rather than ending it.
 *  A turn that reasons and calls in alternation (the shape every real agent has) still printed ten
 *  `💭 思考` rows: 20 rows became 11. Worse, the tool row was anchored at the FIRST call, so calls
 *  that ran later rendered ABOVE reasoning that came after them — the transcript read out of order,
 *  which is what "后面执行的怎么折到最前面去了" describes. A run is therefore every consecutive
 *  thinking/call item, anchored where the work began and holding its items in the order they
 *  happened. Inside, each item keeps its own OLD row: a `💭 思考 · N 字` line that folds itself when
 *  the burst ends, and a one-line tool card you can open. Three layers of folding, all in play:
 *  the run (N calls / M bursts) → the burst line → the call's input/output.
 *
 *  A run ENDS at an assistant reply (or a new prompt): the anchor must never swallow the answer,
 *  and text interleaved mid-turn keeps its true position — chronology stays exact. Fewer than two
 *  folded items is not worth a click: alone, a thought or a call reads better as itself. */
function foldWork(msgs: MsgView[], busy: boolean): StreamRow[] {
  type Chunk =
    | { kind: "msg"; m: MsgView }
    | { kind: "work"; items: WorkItem[]; current: boolean };
  const chunks: Chunk[] = [];
  let i = 0;
  while (i < msgs.length) {
    const m = msgs[i];
    if (!isWork(m)) {
      chunks.push({ kind: "msg", m });
      i++;
      continue;
    }
    let j = i;
    while (j < msgs.length && isWork(msgs[j])) j++;
    chunks.push({ kind: "work", items: msgs.slice(i, j).filter(isWork), current: false });
    i = j;
  }
  // Which stretch keeps its newest items OUT of the fold: the newest stretch, until the operator
  // starts the NEXT round (a user row after it) or the agent starts another stretch of work.
  // Everything older is folded into its header line for good — "下一轮开始那 5 条自动合并进去".
  const lastWork = chunks.map((c) => c.kind).lastIndexOf("work");
  let lastUser = -1;
  chunks.forEach((c, idx) => {
    if (c.kind === "msg" && c.m.kind === "user") lastUser = idx;
  });
  if (lastWork > lastUser) {
    const c = chunks[lastWork];
    if (c.kind === "work") c.current = true;
  }

  const rows: StreamRow[] = [];
  const asRow = (m: MsgView): StreamRow => ({ kind: "msg", m, live: false, tail: false });
  for (const c of chunks) {
    if (c.kind === "msg") {
      rows.push(asRow(c.m));
      continue;
    }
    // He asked for the newest few to stay on screen in the OLD shape (a burst line that folds
    // itself, a tool card you can open) and for the 6th-oldest onwards to fold into the header:
    // "出现第 6 条的时候，那最第一条就折到那个里面去".
    const keep = c.current ? c.items.slice(-TAIL_PREVIEW) : [];
    const folded = c.items.slice(0, c.items.length - keep.length);
    // one folded item is not worth a row of its own unless the rule demands it (the current
    // stretch, where the count must grow as items arrive)
    if (folded.length >= (c.current ? 1 : 2)) {
      rows.push({ kind: "work", key: `work-${rows.length}`, items: folded, tail: false });
    } else {
      folded.forEach((m) => rows.push(asRow(m)));
    }
    keep.forEach((m) => rows.push(asRow(m)));
  }
  // `tail` drives the fork affordance and must land on the last real MESSAGE: a work row is not
  // something you can fork from. `live` marks the row that is still arriving (the live burst
  // scrolls in its own small window).
  const lastMsg = [...rows].reverse().find((r) => r.kind === "msg");
  if (lastMsg && lastMsg.kind === "msg") lastMsg.tail = true;
  const tailRow = rows[rows.length - 1];
  if (busy && tailRow && tailRow.kind === "msg") tailRow.live = true;
  return rows;
}

/** The folded part of one stretch of work, as a single line: how many calls, how many bursts,
 *  which calls it touched, how it went. Its body is the SAME rows the tail uses (a burst line
 *  that folds itself, a tool card that opens its input/output), in the order they happened — so
 *  folding hides nothing, it just stops the screen from scrolling. The box is bounded: a stretch
 *  with 40 steps cannot push the composer off screen. */
function WorkRun({ items }: { items: WorkItem[] }): JSX.Element {
  const [open, setOpen] = useState(false);
  const tools = items.filter((x): x is ToolMsg => x.kind === "tool");
  const thoughts = items.filter((x): x is ThoughtMsg => x.kind === "thought");
  const errs = tools.filter((t) => statusOf(t.status) === "err").length;
  const running = tools.some((t) => statusOf(t.status) === "running");
  const chars = thoughts.reduce((n, t) => n + t.text.length, 0);
  const names = [...new Set(tools.map((t) => t.title.replace(/\s+/g, " ").trim()))];
  const shown = names.slice(0, 2).map((n) => (n.length > 34 ? `${n.slice(0, 33)}…` : n)).join(" · ");
  const label = tools.length && thoughts.length
    ? `${tools.length} 次工具调用 · ${thoughts.length} 段思考`
    : tools.length ? `${tools.length} 次工具调用` : `${thoughts.length} 段思考`;
  // The folded stretch gets ONE stamp: when it started (and when it ended, if that is a
  // different minute). A fold hides rows, so without this the operator loses the only thing
  // that says how long the agent was busy.
  const ats = items.map((i) => i.at).filter((n): n is number => typeof n === "number");
  const from = ats.length ? Math.min(...ats) : null;
  const to = ats.length ? Math.max(...ats) : null;
  return (
    <div className="msg">
      <div className="work-run">
        <button
          type="button"
          className="work-run-head"
          aria-expanded={open}
          title={[`折叠了 ${tools.length} 次工具调用、${thoughts.length} 段思考（${chars} 字）`, "点开看它们",
            ...tools.map((t) => `· ${t.title}`)].join("\n")}
          onClick={() => setOpen((x) => !x)}
        >
          <IconChevronRight size={11} className={`work-chev${open ? " open" : ""}`} />
          <span className="work-run-icon" aria-hidden="true">{tools.length ? "⚙" : "💭"}</span>
          <span className="work-run-count">{label}</span>
          {names.length ? (
            <span className="work-run-names">{names.length > 2 ? `${shown} +${names.length - 2}` : shown}</span>
          ) : (
            <span className="work-run-chars">{chars} 字</span>
          )}
          <span className={`work-run-state ${errs ? "err" : running ? "run" : "ok"}`} aria-hidden="true">
            {errs ? `✗ ${errs}` : running ? "•••" : "✓"}
          </span>
          {from ? (
            <span className="msg-at" title={`${stamp(from)}${to && to !== from ? ` → ${stamp(to)}` : ""}`}>
              {clockHM(from)}{to && to - from >= 60_000 ? `–${clockHM(to)}` : ""}
            </span>
          ) : null}
        </button>
        {open && (
          <div className="work-run-items">
            {items.map((it) => (it.kind === "thought" ? <Thought key={it.key} m={it} live={false} /> : <ToolCard key={it.key} m={it} />))}
          </div>
        )}
      </div>
    </div>
  );
}

/** The pending request as it sits in the transcript: durable, at the tail, and answering
 *  from here is the same call the dialog makes (one implementation, one place that talks
 *  to the server). It stays after the dialog is put away, and after a page reload the
 *  request is replayed by the server, so a decision is never only-visible-once. */
function PermCard({ sid, req }: { sid: string; req: PermissionRequestView }): JSX.Element {
  return (
    <div className="msg">
      <div className="perm-card">
        <div className="q">🔑 agent 要执行：<b>{req.toolCallTitle}</b>（{req.kind}）</div>
        <PermSubject req={req} />
        <div className="opts">
          <PermOptions sid={sid} req={req} />
        </div>
      </div>
    </div>
  );
}

/** What the request is about, when the agent said: the file, and (when it sent one) the change. */
function PermSubject({ req }: { req: PermissionRequestView }): JSX.Element | null {
  // With a change attached the subject IS the change row: file + `＋N −M`, diff on click.
  if (req.diff) return <PermChanges diff={req.diff} />;
  const file = req.path ?? null;
  if (!file) return null;
  return (
    <div className="perm-file" title={file}>
      <IconFile size={12} />
      <code>{file}</code>
    </div>
  );
}

/** The agent's own options, verbatim: the answer set comes from the AGENT (a control we
 *  draw must be one it can honour), so nothing is invented or translated here. `取消这次
 *  请求` is the protocol's own escape hatch — it answers `cancelled`, which is what the
 *  agent already receives when nobody replies, and it is the only way out of a request
 *  whose option list has no reject. */
function PermOptions({ sid, req, onAnswered }: {
  sid: string; req: PermissionRequestView; onAnswered?: () => void;
}): JSX.Element {
  const answer = (decision: PermissionDecision, option?: { optionId: string; kind: string }): void => {
    cockpit.send({
      t: "respond-permission", sessionId: sid, requestId: req.requestId, decision,
      // `allow_always` is remembered per live session server-side; the signature is what
      // makes the next identical request in this session pass without asking again.
      ...(option ? { optionKind: option.kind, signature: `${req.kind}:${req.toolCallTitle}` } : {}),
    });
    onAnswered?.();
  };
  return (
    <>
      {req.options.map((o) => (
        <button
          key={o.optionId}
          className={o.kind.startsWith("allow") ? "allow" : "reject"}
          onClick={() => answer({ outcome: "selected", optionId: o.optionId }, o)}
        >
          {o.name}
        </button>
      ))}
      <button
        title="不选任何一项：agent 会收到 cancelled，这一轮就停在这里"
        onClick={() => answer({ outcome: "cancelled" })}
      >
        取消这次请求
      </button>
    </>
  );
}

/** Unified, hunk-only line diff of the agent's before/after.
 *
 *  Hermes' edit approval hands over the WHOLE file twice (`acp.tool_diff_content`: old_text and
 *  new_text are entire file contents), and the operator's question is never "what is in this
 *  file" — it is "what changes". So: drop the common head and tail, diff the middle, then keep
 *  only changed lines plus 3 lines of context and collapse the rest into a counted gap. */
type DiffLine = { kind: "ctx" | "add" | "del" | "gap"; text: string; oldNo: number | null; newNo: number | null };

function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.length ? oldText.replace(/\n$/, "").split("\n") : [];
  const b = newText.length ? newText.replace(/\n$/, "").split("\n") : [];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const headCtx: DiffLine[] = [];
  const CTX = 3;
  if (head > CTX) headCtx.push({ kind: "gap", text: `⋯ 上面 ${head - CTX} 行未变 ⋯`, oldNo: null, newNo: null });
  for (let i = Math.max(0, head - CTX); i < head; i++) headCtx.push({ kind: "ctx", text: a[i], oldNo: i + 1, newNo: i + 1 });

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const pairs: DiffLine[] = [];
  // LCS over the middle; a pathological pair of files would blow up memory, so fall back to
  // "the whole middle was replaced" — coarser, but still honest about what the request does.
  if (midA.length * midB.length > 250_000) {
    midA.forEach((t, i) => pairs.push({ kind: "del", text: t, oldNo: head + i + 1, newNo: null }));
    midB.forEach((t, i) => pairs.push({ kind: "add", text: t, oldNo: null, newNo: head + i + 1 }));
  } else {
    const n = midA.length, m = midB.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { pairs.push({ kind: "ctx", text: midA[i], oldNo: head + i + 1, newNo: head + j + 1 }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { pairs.push({ kind: "del", text: midA[i], oldNo: head + i + 1, newNo: null }); i++; }
      else { pairs.push({ kind: "add", text: midB[j], oldNo: null, newNo: head + j + 1 }); j++; }
    }
    while (i < n) { pairs.push({ kind: "del", text: midA[i], oldNo: head + i + 1, newNo: null }); i++; }
    while (j < m) { pairs.push({ kind: "add", text: midB[j], oldNo: null, newNo: head + j + 1 }); j++; }
  }
  const tailCtx: DiffLine[] = [];
  for (let i = 0; i < Math.min(tail, CTX); i++) {
    tailCtx.push({ kind: "ctx", text: a[a.length - tail + i], oldNo: a.length - tail + i + 1, newNo: b.length - tail + i + 1 });
  }
  if (tail > CTX) tailCtx.push({ kind: "gap", text: `⋯ 下面 ${tail - CTX} 行未变 ⋯`, oldNo: null, newNo: null });

  // hunk selection over the middle: changed lines ±3, everything else becomes a counted gap
  const keep = new Array(pairs.length).fill(false);
  pairs.forEach((p, k) => {
    if (p.kind === "ctx") return;
    for (let c = Math.max(0, k - CTX); c <= Math.min(pairs.length - 1, k + CTX); c++) keep[c] = true;
  });
  const body: DiffLine[] = [];
  let skipped = 0;
  pairs.forEach((p, k) => {
    if (!keep[k]) { skipped++; return; }
    if (skipped) { body.push({ kind: "gap", text: `⋯ 中间 ${skipped} 行未变 ⋯`, oldNo: null, newNo: null }); skipped = 0; }
    body.push(p);
  });
  if (skipped) body.push({ kind: "gap", text: `⋯ 中间 ${skipped} 行未变 ⋯`, oldNo: null, newNo: null });
  return [...headCtx, ...body, ...tailCtx];
}

/** 「变更」 as a ROW you click, not a wall of text — the shape AionUi's FileChangesPanel uses
 *  for the same question (`＋N −M` stats, diff on demand). Collapsed by default because the
 *  payload is two whole files, and an operator deciding on an edit needs the change, not the file. */
function PermChanges({ diff }: { diff: PermissionDiff }): JSX.Element {
  const [open, setOpen] = useState(false);
  const oldText = diff.oldText ?? "";
  const newText = diff.newText ?? "";
  const isNew = newText.length > 0 && oldText.length === 0;
  const lines = diffLines(oldText, newText);
  const added = lines.filter((l) => l.kind === "add").length;
  const removed = lines.filter((l) => l.kind === "del").length;
  return (
    <div className="perm-changes">
      <button
        type="button"
        className="perm-change-row"
        aria-expanded={open}
        aria-label={`${open ? "收起" : "查看"} ${diff.path ?? "这份文件"} 的变更`}
        onClick={() => setOpen((o) => !o)}
      >
        <IconFile size={13} />
        <code title={diff.path ?? ""}>{diff.path ?? "（未命名文件）"}</code>
        <span className="perm-counts">
          {isNew
            ? <span className="add">新文件 · {added} 行</span>
            : <><span className="add">+{added}</span><span className="del">−{removed}</span></>}
        </span>
        <span className="perm-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="perm-diff" role="region" aria-label="变更内容">
          {lines.map((l, i) => (l.kind === "gap" ? (
            <div className="perm-diff-gap" key={i}>{l.text}</div>
          ) : (
            <div className={`perm-diff-line ${l.kind}`} key={i}>
              <span className="no">{l.oldNo ?? ""}</span>
              <span className="no">{l.newNo ?? ""}</span>
              <span className="sig">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
              <span className="txt">{l.text || " "}</span>
            </div>
          )))}
        </div>
      ) : null}
      {diff.truncated ? (
        <div className="perm-cut">agent 发来的是整份文件，这里只保留了改动附近的部分</div>
      ) : null}
    </div>
  );
}

/** The approval DIALOG — the thing the operator asked for ("要改文件的时候弹出来让我点确认").
 *
 *  Why a dialog on top of the card: a request is a decision with a deadline, and the agent
 *  gives up on its own if nobody answers (Hermes self-denies at `approvals.timeout`, 60 s on
 *  this box). The card lives in the transcript — which is exactly where an operator who
 *  scrolled away from the tail is not looking. This is the same shape as the blocked-slot
 *  dialog: one decision, its cause, and the actions on it.
 *
 *  It reads the FIRST pending request of the session on screen; answering or dismissing it
 *  brings up the next one. `稍后处理` closes the dialog WITHOUT answering — the request stays
 *  pending, its card stays in the transcript, and the header's ⚿ chip brings this back. Esc
 *  is that same "not now", never a deny: a keypress must not decide for the agent. */
function PermDialog({ req, sessionTitle, onSkip }: {
  req: PermissionRequestView; sessionTitle: string; onSkip: () => void;
}): JSX.Element {
  useEscape(true, onSkip);
  // Elapsed time since the request arrived, measured (never a fabricated deadline): how long
  // the AGENT has been sitting there is the operator's only real urgency signal here.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [req.requestId]);
  const waited = Math.max(0, Math.round((now - req.createdAt) / 1000));
  return (
    /* Clicking the backdrop means "not now", not "nothing happened": the card stays in the
       transcript with the same buttons, and the ⚿ chip in the header reopens this dialog. A
       backdrop that swallows the click reads as a broken window — the operator's own words
       ("弹窗点击不了") — and it also blocks the rail, so a request in one session made every
       OTHER session unreachable until it was answered. */
    <div className="modal-bg perm-bg" onClick={onSkip}>
      <div
        className="modal perm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="agent 请求授权"
        data-request-id={req.requestId}
        data-session-id={req.sessionId}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Agent 请求授权</h3>
        <div className="perm-ask">
          「{sessionTitle}」里的 agent 停在这里等你答复 —— 它要执行 <b>{req.toolCallTitle}</b>（{req.kind}）。
        </div>
        <PermSubject req={req} />
        <div className="opts perm-opts">
          <PermOptions sid={req.sessionId} req={req} />
        </div>
        <div className="perm-note">
          已等待 {waited} 秒。一直不答复的话，agent 那边会自己放弃这次请求（等同拒绝），这一轮就停在这里。
        </div>
        <div className="row">
          <button className="cancel" onClick={onSkip}>稍后处理</button>
        </div>
      </div>
    </div>
  );
}

/** Read this reply aloud / stop reading. One button, because the two states are the
 *  same affordance (hermes-studio puts play/stop in the same place for the same
 *  reason: you click where you last clicked). */
function SpeakButton({ id, text }: { id: string; text: string }): JSX.Element | null {
  const [prefs] = useVoicePrefs();
  const spoken = useSpeaker();
  if (!text.trim()) return null;
  const playing = spoken.speaking && spoken.speakingId === id;
  // Only claim we cannot speak when the browser really has no speech synthesis at all:
  // "no voices yet" is a loading state, not a verdict (the list arrives late in Chromium).
  if (typeof window !== "undefined" && !("speechSynthesis" in window) && !prefs.serverTts) {
    return <span className="bubble-note" title="this browser has no speech synthesis">no voices</span>;
  }
  return (
    <button
      className={`bubble-btn speak ${playing ? "on" : ""}`}
      title={playing ? "stop reading" : "read this reply aloud"}
      aria-label={playing ? "stop reading" : "read aloud"}
      onClick={() => {
        if (playing) speaker.stop();
        else void speaker.speak(text, id, prefs);
      }}
    >
      {playing ? <IconVolumeOff size={13} /> : <IconVolume size={13} />}
    </button>
  );
}

/** Attachments the operator added to the next prompt. Kept client-side until send:
 *  the bytes become ACP content blocks in the server (see PromptAttachment). */
interface Draft {
  id: string;
  name: string;
  kind: "image" | "text";
  mimeType: string;
  /** data: URL for the thumbnail (images only) */
  preview?: string;
  /** base64 payload for images, the raw text for text files */
  payload: string;
  bytes: number;
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;

function readFileAsDraft(file: File): Promise<Draft | { error: string }> {
  const isImage = IMAGE_TYPES.includes(file.type);
  if (isImage) {
    if (file.size > MAX_IMAGE_BYTES) return Promise.resolve({ error: `${file.name}: image larger than 4MB` });
    return new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => {
        const url = String(fr.result ?? "");
        resolve({
          id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 7)}`,
          name: file.name, kind: "image", mimeType: file.type,
          preview: url, payload: url.slice(url.indexOf(",") + 1), bytes: file.size,
        });
      };
      fr.onerror = () => resolve({ error: `${file.name}: could not be read` });
      fr.readAsDataURL(file);
    });
  }
  if (file.size > MAX_TEXT_BYTES) return Promise.resolve({ error: `${file.name}: larger than 256kB — attach it as a path instead` });
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve({
      id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 7)}`,
      name: file.name, kind: "text", mimeType: file.type || "text/plain",
      payload: String(fr.result ?? ""), bytes: file.size,
    });
    fr.onerror = () => resolve({ error: `${file.name}: could not be read` });
    fr.readAsText(file);
  });
}

function humanBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} kB` : `${(n / 1048576).toFixed(1)} MB`;
}

/** What to print on the model button: the model, not its provider.
 *  Agents name models "Provider · model" (Hermes) or "provider:model" (wire ids), and the
 *  toolbar only has room for the interesting half. */
export function shortModelName(name: string, modelId?: string): string {
  const source = (name || modelId || "").trim();
  if (!source) return "";
  const afterDot = source.includes("·") ? source.split("·").pop()!.trim() : source;
  const afterColon = afterDot.includes(":") ? afterDot.split(":").pop()!.trim() : afterDot;
  return afterColon || afterDot || source;
}

/** Which provider a model came from: the id prefix ("openrouter:anthropic/…") or the
 *  description agents attach ("Provider: OpenRouter"). Used to group the list. */
export function modelProvider(m: { modelId: string; name?: string; description?: string | null }): string {
  const clean = (raw: string): string => raw
    // agents mark the active entry in the description ("Provider: X · current"): that is
    // a state, not a provider, and keeping it split one provider into two groups.
    .replace(/[•·|,-]?\s*\b(current|active|selected|default)\b\s*$/i, "")
    .replace(/[•·|,\s-]+$/g, "")
    .trim();
  const fromDesc = /^\s*provider:\s*(.+)$/i.exec(m.description ?? "");
  if (fromDesc) {
    const name = clean(fromDesc[1]);
    if (name) return name;
  }
  const prefix = m.modelId.includes(":") ? m.modelId.split(":")[0] : "";
  return clean(prefix) || "other";
}

/** Thinking depth as colour + filled pips rather than words: the operator asked for the
 *  label to go away, and a level is easier to read as a small scale than as text. */
const EFFORT_COLORS = ["#7f8c98", "#5fb3a1", "#7fb069", "#d9a441", "#e8843c", "#f0603f", "#ff4d4d"];

export function effortStyle(value: string, options: { value: string }[]): { color: string; level: number; total: number } {
  const total = Math.max(1, options.length);
  const idx = options.findIndex((o) => String(o.value) === String(value));
  const level = idx < 0 ? 0 : idx + 1;
  const color = idx < 0 ? "var(--text-dim)" : EFFORT_COLORS[Math.min(idx, EFFORT_COLORS.length - 1)];
  return { color, level, total };
}

/** Seven ticks, filled up to the level, in the level's colour. */
function EffortPips({ level, total, color }: { level: number; total: number; color: string }): JSX.Element {
  const ticks = Math.min(7, total);
  const filled = Math.max(0, Math.min(ticks, Math.round((level / total) * ticks)));
  return (
    <span className="tb-pips" aria-hidden="true">
      {Array.from({ length: ticks }).map((_, i) => (
        <i key={i} style={{ background: i < filled ? color : "var(--line)" }} />
      ))}
    </span>
  );
}

/** ACP tags config options with a `category` ("model" | "mode" | "thought_level" | …)
 *  exactly so clients can place them. Hermes leaves it unset today, so fall back to the
 *  option's id — and never invent an option the agent did not advertise. */
function pickConfigOption(options: SessionView["info"]["configOptions"], kind: "effort" | "model"): SessionView["info"]["configOptions"][number] | undefined {
  const wanted = kind === "effort" ? ["thought_level", "reasoning"] : ["model", "model_config"];
  const idRe = kind === "effort" ? /reason|effort|think|depth/i : /model/i;
  return options.find((o) => o.type === "select" && o.category && wanted.includes(String(o.category)))
    ?? options.find((o) => o.type === "select" && idRe.test(o.id));
}

/** Icon + current value + chevron, opening a list: one control per concern, the way the
 *  operator asked for (hermes-studio's toolbar: effort, settings, model). */
function ToolbarSelect({ label, title, icon, value, children, open, onToggle, testId }: {
  label: string;
  title: string;
  icon: JSX.Element;
  value: string;
  children: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  testId?: string;
}): JSX.Element {
  // the wrap holds the trigger AND the list, so a pointerdown here is "inside"
  // (re-clicking the trigger keeps toggling, anything else puts the list away)
  const wrapRef = useRef<HTMLDivElement>(null);
  useDismiss(open, [wrapRef], onToggle);
  return (
    <div className="tb-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`tb-btn ${open ? "on" : ""}`}
        title={title}
        aria-label={title}
        aria-expanded={open}
        data-testid={testId}
        onClick={onToggle}
      >
        {icon}
        <span className="tb-label">{value || label}</span>
        <IconChevronDown size={11} className="tb-chev" />
      </button>
      {open ? children : null}
    </div>
  );
}

/** A list of agent-advertised choices (thinking depth, model, mode). */
function ChoiceList({ items, current, onPick, empty }: {
  items: { value: string; name: string; hint?: string | null; color?: string }[];
  current: string | null;
  onPick: (value: string) => void;
  empty: string;
}): JSX.Element {
  if (!items.length) return <div className="tb-list"><div className="tb-empty">{empty}</div></div>;
  return (
    <div className="tb-list" role="listbox">
      {items.map((it) => (
        <button
          key={it.value}
          role="option"
          aria-selected={it.value === current}
          className={`tb-opt ${it.value === current ? "sel" : ""}`}
          title={it.hint ? `${it.name} — ${it.hint}` : it.name}
          onClick={() => onPick(it.value)}
        >
          <span className="tb-opt-name">
            {it.color ? <i className="tb-dot" style={{ background: it.color }} /> : null}
            {it.name}
          </span>
          {it.hint ? <span className="tb-opt-hint">{it.hint}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** Context + spend, in small type above the box (the operator's ask). The bar is the same
 *  reading the ring used to give, minus the ring's claim on the header.
 *
 *  The window number has three possible sources, and the popover names the one in play:
 *  this session's declaration → the declaration remembered for this MODEL (studio's shape:
 *  it keeps a context length per provider+model) → the agent's own `usage_update.size`.
 *
 *  ACP has no *dedicated* method to set a window, but an agent may advertise one as a config
 *  option (Hermes exposes `context_budget`, free-form) — that is the real knob, so when it is
 *  present the declaration field says so instead of pretending to be it. Without one, this
 *  number only moves the gauge; what changes context then is the agent's own `/compress`
 *  (advertised over ACP, so the button only appears when the agent really has it) or a model
 *  with a longer window. */
/** Is this option the context window/limit knob? It belongs on the usage row above the input,
 *  not in the settings popover: the operator asked to set the window where the number is
 *  (「不要到设置里面改…就点这个上下文的地方」), and settings is for thinking depth. */
export function isContextWindowOption(o: SessionView["info"]["configOptions"][number]): boolean {
  if (o.category === "_context_window") return true;
  return /budget|context/i.test(`${o.id} ${o.name ?? ""}`);
}

function UsageRow({ v }: { v: SessionView }): JSX.Element | null {
  const usage = v.info.usage;
  // The agent's own context-budget option, when it advertises one: that is the REAL knob (it moves
  // the window Hermes compresses against), so the declaration field below points at it instead of
  // pretending to be it.
  const budgetCfg = v.info.configOptions.find(isContextWindowOption);
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const trace = v.trace;
  // clicking a message, another session, or empty space puts the popover away
  useDismiss(open, [rowRef], () => { setOpen(false); setEditing(false); });
  if (!usage || (!usage.used && !usage.size)) return null;

  const declared = v.info.contextLimit && v.info.contextLimit > 0 ? v.info.contextLimit : null;
  const remembered = v.info.modelContextLimit && v.info.modelContextLimit > 0 ? v.info.modelContextLimit : null;
  const source: "session" | "model" | "agent" = declared ? "session" : remembered ? "model" : "agent";
  const limit = declared ?? remembered ?? usage.size;
  const pct = limit > 0 ? Math.min(100, Math.round((usage.used / limit) * 100)) : 0;
  const level = pct >= 85 ? "hot" : pct >= 65 ? "warn" : "ok";
  const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
  const remaining = limit > 0 ? Math.max(0, limit - usage.used) : 0;
  const commands = v.info.commands ?? [];
  const has = (name: string): boolean => commands.some((c) => c.name === name);
  const sourceLabel = source === "session"
    ? "你为本会话声明"
    : source === "model" ? "你为这个模型记下的" : "agent 上报（usage_update）";

  const apply = async (value: number | null, opts: { remember?: boolean; forgetModel?: boolean } = {}): Promise<void> => {
    setBusy(opts.forgetModel ? "forget" : "save");
    setErr("");
    try {
      await cockpit.setContextLimit(v.info.id, value, opts);
      setEditing(false);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  };

  /** Send one of the agent's OWN commands (they arrive over ACP as available commands). */
  const runCommand = (name: string): void => {
    cockpit.send({ t: "prompt", sessionId: v.info.id, text: `/${name}` });
    setOpen(false);
  };

  /** Set the context window through the agent's own option — the REAL knob (it moves the window
   *  Hermes compresses against, and it is saved for the model). Used from the usage row, next to
   *  the number it changes. */
  const sendConfig = (configId: string, value: string): void => {
    const cleaned = value.trim();
    if (!cleaned) return;
    cockpit.send({ t: "set-config", sessionId: v.info.id, configId, value: cleaned });
    setDraft("");
  };
  const budgetValue = String(budgetCfg?.currentValue ?? "");

  return (
    <div className={`usage-row ${level}`} ref={rowRef}>
      {/* The strip above the box IS the context gauge: the window length, the battery-style line,
          and — when it is nearly full — the one useful action. Thinking depth and this turn's mode
          have their own controls; spelling them out here was noise (operator: 「这个上面就不用写
          什么 effort low 啊什么什么的，这里就只写这个上下文长度」). */}
      <button className="usage-text" onClick={() => setOpen((o) => !o)} title="上下文窗口 — 点这里改">
        <IconGauge size={12} className="usage-icon" />
        {/* used / total · pct — the shape every other agent product uses (AionUi "45.2K / 200K",
            studio "12.3K / 200K (6%)"): a bare length answers nothing about how much of it is spent
            (operator: 「已用上下文的数量也要写上去……应该把总的、还有已用的、占的百分比都写上去」). */}
        {limit > 0 ? `${fmt(usage.used)} / ${fmt(limit)}` : `${fmt(usage.used)} / —`}
        {limit > 0 ? ` · ${pct}%` : ""}
        {source === "session" ? " · 声明" : source === "model" ? " · 模型记录" : ""}
      </button>
      {limit > 0 ? (
        <div className="usage-bar" title={`${usage.used} / ${limit} tokens (${pct}%)`}>
          <i style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      {/* A nearly-full window gets the useful action in place, using the command this agent
          advertised — never a button for a command it does not have. */}
      {level === "hot" && has("compress") && !v.busy ? (
        <button
          className="usage-act"
          onClick={() => runCommand("compress")}
          title="发送 /compress：让 agent 压缩上下文（这是它自己公告的命令）"
        >
          <IconChip size={11} /> 压缩上下文
        </button>
      ) : null}
      {open ? (
        <div className="usage-detail">
          {/* ── 改窗口就在这儿 ────────────────────────────────────────────────
              输入框上面这一行，点开就是上下文窗口的设置：预设 + 任意 token 数。走的是 agent
              自己公告的那项 config option（Hermes 的 `context_budget`），所以是真旋钮 —— 改的是
              这个模型，不是仪表盘上的一个数字。预设/常用值提示参考 studio 的「点开数字即改」，
              百分比口径照 AionUi：分母只认 agent 上报或自己声明的，绝不猜。 */}
          <div className="usage-set">
            <div className="usage-set-head">
              <IconGauge size={12} /> 上下文窗口
              <span className="usage-set-scope">
                {budgetCfg ? (String((budgetCfg.meta as Record<string, unknown>)?.scope ?? "") === "model" ? "按模型" : "") : "仅声明"}
              </span>
            </div>
            {budgetCfg ? (
              <>
                <div className="usage-set-chips">
                  {(budgetCfg.options ?? []).map((opt) => (
                    <button
                      key={String(opt.value)}
                      className={`usage-chip ${budgetValue === String(opt.value) ? "sel" : ""}`}
                      onClick={() => sendConfig(budgetCfg.id, String(opt.value))}
                    >
                      {String(opt.value) === "auto" ? "自动" : opt.name}
                    </button>
                  ))}
                </div>
                <div className="usage-edit">
                  <input
                    value={draft}
                    inputMode="numeric"
                    aria-label="context window in tokens"
                    placeholder={(budgetCfg.meta as Record<string, unknown>)?.freeform === true
                      ? "任意 token 数，如 300000" : "填一个数"}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") sendConfig(budgetCfg.id, draft);
                      if (e.key === "Escape") { e.stopPropagation(); setOpen(false); }
                    }}
                  />
                  <button className="usage-edit-btn" disabled={!draft.trim()} onClick={() => sendConfig(budgetCfg.id, draft)}>set</button>
                </div>
                <div className="settings-note">常用：256k / 512k / 768k / 1m；填 auto 回到模型自己的窗口。</div>
                <div className="usage-note">
                  改的是<b>这个模型</b>：同模型的所有会话（含新开的、别的槽位）都用同一个上限。它只会让 Hermes 更早压缩，不会把窗口撑过模型本身。
                </div>
              </>
            ) : (
              <>
                <div className="usage-note">
                  这个后端没公告上下文旋钮，所以下面这个数只是仪表盘的<b>声明</b>，只影响百分比；真减上下文用压缩命令或换模型。
                </div>
                {editing ? (
                  <div className="usage-edit">
                    <input
                      autoFocus
                      value={draft}
                      inputMode="numeric"
                      aria-label="context window in tokens"
                      placeholder={String(usage.size || v.info.contextLimit || 200000)}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          const n = Number(draft.replace(/[^0-9]/g, ""));
                          if (n > 0) void apply(n, { remember });
                        }
                        if (e.key === "Escape") { e.stopPropagation(); setEditing(false); }
                      }}
                    />
                    <button
                      className="usage-edit-btn"
                      disabled={busy !== "" || !Number(draft.replace(/[^0-9]/g, ""))}
                      onClick={() => void apply(Number(draft.replace(/[^0-9]/g, "")), { remember })}
                    >
                      {busy === "save" ? "…" : "set"}
                    </button>
                    <label className="usage-check" title="像 studio 那样按模型记住：下次用这个模型自动带回来">
                      <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                      记到本模型
                    </label>
                    {remembered ? (
                      <button
                        className="usage-edit-btn"
                        disabled={busy !== ""}
                        onClick={() => void apply(null, { forgetModel: true })}
                      >
                        {busy === "forget" ? "…" : "忘掉本模型记录"}
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <button className="usage-edit-btn" onClick={() => { setDraft(String(limit || 200000)); setEditing(true); }}>
                    声明窗口长度
                  </button>
                )}
              </>
            )}
          </div>
          <div>已用 {usage.used} / {limit || "—"} tokens（{pct}%）</div>
          <div>剩余：{limit > 0 ? remaining : "unknown"} tokens</div>
          <div>窗口来源：<b>{sourceLabel}</b></div>
          {usage.size > 0 && source !== "agent" ? <div>agent 上报：{fmt(usage.size)} tokens (usage_update)</div> : null}
          {remembered && source === "session" ? <div>本模型记录：{fmt(remembered)} tokens</div> : null}
          {usage.cost != null ? <div>本轮花费：${usage.cost.toFixed(6)}</div> : null}
          {trace?.model ? <div>model：{trace.model}</div> : null}
          {trace && (trace.effort || trace.mode)
            ? <div>本轮：{[trace.effort && `思考强度 ${trace.effort}`, trace.mode && `模式 ${trace.mode}`].filter(Boolean).join("，")}</div>
            : null}
          {has("compress") || has("context") ? (
            <div className="usage-actions">
              {has("compress") ? (
                <button className="usage-act" onClick={() => runCommand("compress")} title="让 agent 压缩上下文（/compress，它自己公告的命令）">压缩上下文</button>
              ) : null}
              {has("context") ? (
                <button className="usage-act" onClick={() => runCommand("context")} title="看消息按角色分布（/context）">消息分布</button>
              ) : null}
            </div>
          ) : null}
          {err ? <div className="usage-edit-err">{err}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/** One config option the agent advertised. Presets are chips; when the agent marks the option
 *  free-form (`_meta.freeform` — the extension slot ACP reserves for custom option kinds) an
 *  input rides alongside them, because those presets are shortcuts rather than the allowed set.
 *  We send exactly what was typed and let the agent's rebuilt list be the truth. */
function ConfigOptionGroup({ o, sessionId }: {
  o: SessionView["info"]["configOptions"][number];
  sessionId: string;
}): JSX.Element {
  const meta = (o.meta ?? {}) as Record<string, unknown>;
  const freeform = meta.freeform === true;
  const [draft, setDraft] = useState("");
  const current = String(o.currentValue ?? "");
  const unit = typeof meta.unit === "string" ? meta.unit : "tokens";
  const send = (value: string) => cockpit.send({ t: "set-config", sessionId, configId: o.id, value });
  return (
    <div className="settings-group">
      <div className="settings-label"><IconSettings size={13} /> {o.name || o.id}</div>
      {o.options?.map((opt) => (
        <button
          key={String(opt.value)}
          className={`settings-opt ${current === String(opt.value) ? "sel" : ""}`}
          onClick={() => send(String(opt.value))}
        >
          {opt.name}
        </button>
      ))}
      {freeform ? (
        <div className="settings-freeform">
          <input
            className="settings-input"
            type="number"
            inputMode="numeric"
            min={typeof meta.min === "number" ? meta.min : undefined}
            step={typeof meta.step === "number" ? meta.step : 1024}
            placeholder={`任意 ${unit}`}
            aria-label={`${o.name || o.id} value`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && draft.trim()) send(draft.trim()); }}
          />
          <button className="settings-opt" disabled={!draft.trim()} onClick={() => send(draft.trim())}>set</button>
        </div>
      ) : null}
    </div>
  );
}

/** Everything that used to crowd the header: permission mode, thinking depth,
 *  read-aloud, dictation engine. One popover, next to the prompt it affects. */
function SettingsPopover({ v, prefs, setPrefs, onClose, panelRef }: {
  v: SessionView;
  prefs: VoicePrefs;
  setPrefs: (patch: Partial<VoicePrefs>) => void;
  onClose: () => void;
  panelRef: React.RefObject<HTMLDivElement>;
}): JSX.Element {
  const info = v.info;
  const modes = info.modes?.availableModes ?? [];
  // model has its own toolbar button; settings keeps thinking depth, permission mode and voice
  const cfg = pickConfigOption(info.configOptions, "effort");
  const modelCfg = pickConfigOption(info.configOptions, "model");
  // re-render when the browser finally publishes its voice list
  const voiceCount = useSyncExternalStore(speaker.subscribeVoices, () => speaker.voices().length);
  const voices = voiceCount ? speaker.voices() : [];
  const caps = voiceCaps();
  return (
    <div className="settings-pop" role="dialog" aria-label="chat settings" ref={panelRef}>
      <div className="settings-head">
        <span>chat settings</span>
        <span className="head-spacer" />
        <button className="icon-btn" title="close" aria-label="close" onClick={onClose}><IconClose size={13} /></button>
      </div>
      {modes.length > 0 && (
        <div className="settings-group">
          <div className="settings-label"><IconShield size={13} /> permission mode</div>
          {modes.map((m) => (
            <button
              key={m.id}
              className={`settings-opt ${info.modes?.currentModeId === m.id ? "sel" : ""}`}
              onClick={() => cockpit.send({ t: "set-mode", sessionId: info.id, modeId: m.id })}
            >
              {m.name}
            </button>
          ))}
        </div>
      )}
      {/* Thinking depth lives HERE: the settings button is the operator's thinking-strength
          control (「输入框最下面那个设置按钮就只做这个思考强度的一个设置」). The toolbar keeps its
          pips button as the at-a-glance level; this is the labelled list, with the levels only
          this route really takes. */}
      {cfg?.options?.length ? (
        <div className="settings-group">
          <div className="settings-label"><IconBrain size={13} /> thinking depth</div>
          {cfg.options.map((o, i) => (
            <button
              key={String(o.value)}
              className={`settings-opt ${String(cfg.currentValue ?? "") === String(o.value) ? "sel" : ""}`}
              onClick={() => cockpit.send({ t: "set-config", sessionId: info.id, configId: cfg.id, value: String(o.value) })}
            >
              <i className="settings-dot" style={{ ["--effort" as string]: EFFORT_COLORS[Math.min(i, EFFORT_COLORS.length - 1)] }} />
              {o.name}
            </button>
          ))}
          <div className="settings-note">只列这个路由真支持的档；改的是本会话。</div>
        </div>
      ) : null}
      {/* Everything else the agent advertises — EXCEPT the context window: that one is set on the
          usage row above the input, next to the number it changes (the operator asked for it there,
          not in settings). A backend that adds an option still gets it rendered here for free. */}
      {info.configOptions
        .filter((o) => o.type === "select" && o.options && o !== cfg && o !== modelCfg && !isContextWindowOption(o))
        .map((o) => (
          <ConfigOptionGroup key={o.id} o={o} sessionId={info.id} />
        ))}
      <div className="settings-group">
        <div className="settings-label"><IconVolume size={13} /> read replies aloud</div>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={prefs.autoRead}
            onChange={(e) => setPrefs({ autoRead: e.target.checked })}
          />
          <span>speak every finished reply</span>
        </label>
        {voices.length > 0 && (
          <select
            className="settings-select"
            value={prefs.voiceURI}
            onChange={(e) => setPrefs({ voiceURI: e.target.value })}
            aria-label="voice"
          >
            <option value="">auto voice ({prefs.lang})</option>
            {voices.map((vc) => (
              <option key={vc.voiceURI} value={vc.voiceURI}>{vc.name} — {vc.lang}</option>
            ))}
          </select>
        )}
        {voices.length === 0 ? <div className="settings-note">this browser exposes no voices</div> : null}
        <label className="settings-range">
          <span>speed {prefs.rate.toFixed(2)}×</span>
          <input
            type="range" min={0.5} max={2} step={0.05}
            value={prefs.rate}
            onChange={(e) => setPrefs({ rate: Number(e.target.value) })}
          />
        </label>
        {caps.tts.server ? (
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={prefs.serverTts}
              onChange={(e) => setPrefs({ serverTts: e.target.checked })}
            />
            <span>use the server voice ({caps.tts.model ?? "configured"})</span>
          </label>
        ) : null}
      </div>
      <div className="settings-group">
        <div className="settings-label"><IconMic size={13} /> dictation</div>
        <select
          className="settings-select"
          value={prefs.stt}
          onChange={(e) => setPrefs({ stt: e.target.value as VoicePrefs["stt"] })}
          aria-label="dictation engine"
        >
          <option value="auto">auto — 服务端流式 &gt; 浏览器 &gt; 批量</option>
          <option value="stream">stream{caps.stt.streaming ? ` (${caps.stt.model ?? "百炼"})` : " (not configured)"}</option>
          <option value="browser">browser{!browserDictationAvailable() ? " (unavailable)" : ""}</option>
          <option value="server">server{caps.stt.server ? ` (${caps.stt.batchModel ?? "configured"})` : " (not configured)"}</option>
        </select>
        <input
          className="settings-input"
          value={prefs.lang}
          onChange={(e) => setPrefs({ lang: e.target.value })}
          placeholder="language, e.g. zh-CN"
          aria-label="speech language"
        />
        <div className="settings-note">
          browser dictation {browserDictationAvailable() ? "available" : "unavailable"} · {caps.provider} STT{" "}
          {caps.stt.streaming ? "streaming" : caps.stt.server ? "batch" : "not configured"}
        </div>
      </div>
    </div>
  );
}

function Composer({ v, call, onCloseCall }: { v: SessionView; call: boolean; onCloseCall: () => void }): JSX.Element {
  const [text, setText] = useState("");
  // a phone-width placeholder that wraps to a second line just looks broken
  const placeholder = window.innerWidth < 720 ? "message… (/ for commands)" : "message… (Enter send, Shift+Enter newline, / for commands)";
  const [pick, setPick] = useState(0); // highlighted row in the slash palette
  // clicking outside hides the palette without eating the "/..." the operator typed
  const [paletteHidden, setPaletteHidden] = useState(false);
  const composerRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [attachErr, setAttachErr] = useState("");
  const [dragging, setDragging] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // which toolbar popover is open: "effort" | "model" | null (settings has its own flag)
  const [pop, setPop] = useState<"effort" | "model" | null>(null);
  const [modelQuery, setModelQuery] = useState("");

  // Grow with the content on EVERY value change — not only on keystrokes: dictation, the slash
  // palette and a restored draft all set `text` programmatically, and a box frozen at 42px is
  // what "字数多的时候编辑不方便" looks like. Same shape as hermes-studio's ChatInput
  // (`autoSizeTextarea`: height = min(scrollHeight, cap), overflow beyond the cap).
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "42px";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text]);
  const [switching, setSwitching] = useState(false);
  // A refused model switch keeps the picker OPEN and pins the agent's own sentence next to the
  // offending row: on the live cockpit the whole report used to be "Invalid params" in a banner
  // under a closed popover, which says nothing about what to do (track §61 — the reason lives in
  // the ACP error's `data.details`, and the list the operator picks from is a wider one than the
  // one the agent validates against, so "listed" does not mean "switchable").
  const [modelErr, setModelErr] = useState<{ id: string; text: string } | null>(null);
  // Picks this agent has already refused, for as long as we are looking at this session: after one
  // attempt the operator can see which entries of a too-generous list are not switchable, without
  // having to remember. Not a block — clicking one re-tries (the agent's answer may have changed).
  const [modelBad, setModelBad] = useState<Record<string, string>>({});
  // A new session is a different agent: what it refuses is a different question.
  useEffect(() => { setModelBad({}); setModelErr(null); }, [v.info.id]);
  const [prefs, setPrefs] = useVoicePrefs();
  const dict = useDictation();
  const spoken = useSpeaker();
  const ta = useRef<HTMLTextAreaElement>(null);
  // The call overlay is owned by Main (it is opened from the chat head); the composer
  // renders it so "改用键盘" can put the cursor back in the prompt box, draft intact.
  const fileRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files: FileList | File[]): Promise<void> => {
    const list = Array.from(files);
    if (!list.length) return;
    const results = await Promise.all(list.map((f) => readFileAsDraft(f)));
    const good: Draft[] = [];
    const bad: string[] = [];
    for (const r of results) {
      if ("error" in r) bad.push(r.error);
      else good.push(r);
    }
    if (good.length) setDrafts((cur) => [...cur, ...good]);
    setAttachErr(bad.join(" · "));
  };

  const send = () => {
    const t = text.trim();
    if ((!t && !drafts.length) || v.busy || v.info.status !== "ready") return;
    const attachments: PromptAttachment[] = drafts.map((d) => (
      d.kind === "image"
        ? { kind: "image", mimeType: d.mimeType, data: d.payload, name: d.name }
        : { kind: "text", name: d.name, text: d.payload }
    ));
    cockpit.send({ t: "prompt", sessionId: v.info.id, text: t, attachments });
    setText("");
    setDrafts([]);
    setAttachErr("");
    setPick(0);
    // Sending is an explicit "show me the answer": re-attach the stream even if the
    // operator had scrolled up to read something.
    streamReattach.current();
  };

  // Dictation finishes into the composer: one line of plumbing, because the composer
  // is the only place a prompt can land.
  useEffect(() => {
    // While a call is up the microphone belongs to the CALL, not to this draft box. This sink used
    // to run anyway, and `ta.focus()` at the end is what raises the on-screen keyboard: the call
    // itself stops/starts the shared dictation (mute, phase change, echo of our own voice reaching
    // the phone's microphone mid-reply), which lands the transcript here in an idle state — so the
    // operator's words went into the composer AND the IME popped up in the middle of the answer.
    if (call) return;
    if (dict.status !== "idle" || !dict.text) return;
    const heard = dictation.consume();
    if (!heard) return;
    setText((cur) => (cur.trim() ? `${cur.trim()} ${heard}` : heard));
    ta.current?.focus();
  }, [dict.status, dict.text, call]);

  // Slash palette (AionUi F-DISPLAY-10): the commands are the AGENT's own
  // (available_commands_update over ACP) — we never invent a command list here.
  const slashQuery = /^\/\S*$/.test(text) ? text.slice(1).toLowerCase() : null;
  const matches = slashQuery === null ? [] : v.info.commands
    .filter((c) => c.name.toLowerCase().includes(slashQuery))
    .slice(0, 8);
  const paletteOpen = slashQuery !== null && v.info.status === "ready" && !paletteHidden;

  // every popover in here goes away when the pointer leaves it or Escape is pressed
  useDismiss(paletteOpen, [composerRef], () => setPaletteHidden(true));
  // the toolbar counts as "inside" (its triggers own their own lists); the settings
  // panel is the other inside region. Anything else — a message, empty space, another
  // session — dismisses whatever is open.
  useDismiss(settingsOpen || pop !== null, [popRef, barRef], () => { setPop(null); setSettingsOpen(false); });
  // switching sessions must not carry an open menu across
  useEffect(() => { setPop(null); setSettingsOpen(false); setPaletteHidden(false); }, [v.info.id]);

  const accept = (name: string) => {
    setText(`/${name} `);
    setPick(0);
    ta.current?.focus();
  };

  const listening = dict.status === "listening" || dict.status === "recording" || dict.status === "requesting";
  // The three controls the operator sees: attachments, thinking depth, settings, model —
  // model and depth only when the agent actually advertises them (never a dead button).
  const effortCfg = pickConfigOption(v.info.configOptions, "effort");
  const modelCfg = pickConfigOption(v.info.configOptions, "model");
  const models = v.info.models?.availableModels ?? [];
  const currentModel = v.info.models?.currentModelId ?? "";
  const modelFullName = models.find((m) => m.modelId === currentModel)?.name
    ?? modelCfg?.options?.find((o) => String(o.value) === String(modelCfg.currentValue ?? ""))?.name
    ?? currentModel;
  // the button shows the model alone ("qwen3.8-flash"), never "Provider · model"
  const modelName = shortModelName(modelFullName, currentModel);
  const effortName = effortCfg?.options?.find((o) => String(o.value) === String(effortCfg.currentValue ?? ""))?.name ?? "";
  const effort = effortCfg ? effortStyle(String(effortCfg.currentValue ?? ""), effortCfg.options ?? []) : null;
  // Group by provider (Hermes knows 500+ models: a flat list is unusable), with the
  // current model's group open. Filtering opens everything that matches.
  const [closedGroups, setClosedGroups] = useState<Record<string, boolean>>({});
  const modelGroups = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    const filtered = q
      ? models.filter((m) => `${m.modelId} ${m.name} ${m.description ?? ""}`.toLowerCase().includes(q))
      : models;
    const byProvider = new Map<string, typeof filtered>();
    for (const m of filtered) {
      const key = modelProvider(m);
      const list = byProvider.get(key);
      if (list) list.push(m);
      else byProvider.set(key, [m]);
    }
    const currentProvider = models.find((m) => m.modelId === currentModel);
    const currentKey = currentProvider ? modelProvider(currentProvider) : "";
    return [...byProvider.entries()]
      .map(([provider, list]) => ({
        provider,
        list: list.slice(0, 200),
        truncated: list.length > 200,
        current: provider === currentKey,
      }))
      // the operator's provider first, then alphabetically
      .sort((a, b) => (a.current === b.current ? a.provider.localeCompare(b.provider) : a.current ? -1 : 1));
  }, [models, modelQuery, currentModel]);

  return (
    <div
      className={`composer ${dragging ? "drop-active" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer?.files?.length) void addFiles(e.dataTransfer.files);
      }}
    >
      <UsageRow v={v} />
      <div className="composer-inner" ref={composerRef}>
        {paletteOpen && (
          <div className="slash-palette" role="listbox" aria-label="slash commands">
            {matches.length ? (
              matches.map((c, i) => (
                <div
                  key={c.name}
                  role="option"
                  aria-selected={i === pick}
                  className={`slash-item ${i === pick ? "sel" : ""}`}
                  onMouseEnter={() => setPick(i)}
                  onClick={() => accept(c.name)}
                >
                  <span className="cmd">/{c.name}</span>
                  {c.description ? <span className="desc">{c.description}</span> : null}
                  <span className="src" title="advertised by the agent over ACP">agent</span>
                </div>
              ))
            ) : (
              <div className="slash-item empty">
                {v.info.commands.length
                  ? `no command matches “/${slashQuery}”`
                  : "this agent advertises no slash commands"}
              </div>
            )}
          </div>
        )}
        {settingsOpen && (
          <SettingsPopover v={v} prefs={prefs} setPrefs={setPrefs} onClose={() => setSettingsOpen(false)} panelRef={popRef} />
        )}
        {drafts.length > 0 && (
          <div className="draft-row">
            {drafts.map((d) => (
              <span key={d.id} className={`draft ${d.kind}`} title={`${d.name} · ${humanBytes(d.bytes)}`}>
                {d.preview ? <img src={d.preview} alt={d.name} /> : <IconFile size={13} />}
                <span className="draft-name">{d.name}</span>
                <button
                  className="draft-x"
                  aria-label={`remove ${d.name}`}
                  onClick={() => setDrafts((cur) => cur.filter((x) => x.id !== d.id))}
                >
                  <IconClose size={11} />
                </button>
              </span>
            ))}
            <button className="draft-clear" onClick={() => setDrafts([])}>clear</button>
          </div>
        )}
        {attachErr && <div className="composer-note err">{attachErr}</div>}
        {/* The speaker records why it fell back / failed — it was never rendered, so a
            server-voice failure silently switched the operator to the system voice.
            Surfacing it here is the honest half of that fallback. */}
        {spoken.note ? <div className="composer-note">{spoken.note}</div> : null}
        {spoken.error ? <div className="composer-note err">{spoken.error}</div> : null}
        {listening || dict.status === "transcribing" || dict.error ? (
          <div className={`dict-chip ${dict.error ? "err" : ""}`}>
            <IconMic size={13} />
            {dict.error
              ? dict.error
              : dict.status === "requesting"
                ? "waiting for the microphone…"
                : dict.status === "transcribing"
                  ? "transcribing…"
                  : (
                    <>
                      {dict.text} <span className="interim">{dict.interim}</span>
                      {dict.engine === "stream" ? " · 流式" : ""}
                      {dict.engine === "server" ? ` · ${dict.seconds}s` : ""}
                    </>
                  )}
            {listening ? (
              <button className="dict-stop" onClick={() => dictation.stop()}>stop</button>
            ) : null}
          </div>
        ) : null}
        <div className="composer-box">
          <textarea
            ref={ta}
            rows={1}
            value={text}
            onFocus={() => setPaletteHidden(false)}
            placeholder={v.info.status === "ready" ? placeholder : v.info.status}
            onChange={(e) => {
              setText(e.target.value);
              setPaletteHidden(false);
              setPick(0);
            }}
            onKeyDown={(e) => {
              if (paletteOpen && matches.length) {
                if (e.key === "ArrowDown") { e.preventDefault(); setPick((i) => (i + 1) % matches.length); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setPick((i) => (i - 1 + matches.length) % matches.length); return; }
                if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                  e.preventDefault();
                  accept(matches[pick].name);
                  return;
                }
                if (e.key === "Escape") { e.preventDefault(); setText(""); return; }
              }
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            }}
          />
          <div className="composer-bar" ref={barRef}>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              accept={`${IMAGE_TYPES.join(",")},.txt,.md,.json,.log,.csv,.ts,.tsx,.js,.jsx,.py,.rb,.go,.rs,.java,.c,.cpp,.h,.sh,.yaml,.yml,.toml,.ini,.html,.css`}
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              className="icon-btn"
              title="attach an image or a text file"
              aria-label="attach"
              onClick={() => fileRef.current?.click()}
            >
              <IconPlus size={16} />
            </button>
            {effortCfg && effort ? (
              // No label: the colour and the pips say the level (the name lives in the
              // tooltip and in the list). It also gives the model button its room back.
              <div className="tb-wrap" style={{ ["--effort" as string]: effort.color }}>
                <button
                  type="button"
                  className={`tb-btn tb-effort ${pop === "effort" ? "on" : ""}`}
                  style={{ color: effort.level ? effort.color : undefined }}
                  title={`thinking depth — ${effortName || "agent default"}`}
                  aria-label={`thinking depth: ${effortName || "agent default"}`}
                  aria-expanded={pop === "effort"}
                  data-testid="tb-effort"
                  onClick={() => { setSettingsOpen(false); setPop((p) => (p === "effort" ? null : "effort")); }}
                >
                  <EffortPips level={effort.level} total={effort.total} color={effort.color} />
                  <IconChevronDown size={11} className="tb-chev" />
                </button>
                {pop === "effort" ? (
                  <ChoiceList
                    items={(effortCfg.options ?? []).map((o, i) => ({
                      value: String(o.value),
                      name: o.name,
                      hint: null,
                      color: EFFORT_COLORS[Math.min(i, EFFORT_COLORS.length - 1)],
                    }))}
                    current={String(effortCfg.currentValue ?? "")}
                    empty="the agent advertises no levels"
                    onPick={(value) => {
                      cockpit.send({ t: "set-config", sessionId: v.info.id, configId: effortCfg.id, value });
                      setPop(null);
                    }}
                  />
                ) : null}
              </div>
            ) : null}
            <button
              className={`icon-btn ${settingsOpen ? "on" : ""}`}
              title="chat settings — permission mode, voice"
              aria-label="chat settings"
              aria-expanded={settingsOpen}
              onClick={() => { setPop(null); setSettingsOpen((o) => !o); }}
            >
              <IconSettings size={16} />
            </button>
            {(models.length > 0 || modelCfg) ? (
              <ToolbarSelect
                label="model"
                title={`model — currently ${modelName || "unknown"}`}
                icon={<IconChip size={15} />}
                value={switching ? `${modelName} …` : modelName}
                testId="tb-model"
                open={pop === "model"}
                onToggle={() => { setSettingsOpen(false); setPop((p) => (p === "model" ? null : "model")); }}
              >
                {models.length > 0 ? (
                  <div className="tb-list wide">
                    {/* The refused pick's own sentence, kept above the list: the row may be
                        scrolled out of view or filtered away, the reason must not be. */}
                    {modelErr ? (
                      <div className="tb-err" role="alert" data-model-err={modelErr.id}>
                        <span className="tb-err-id">{modelErr.id}</span>
                        <span className="tb-err-text">{modelErr.text}</span>
                      </div>
                    ) : null}
                    {models.length > 12 ? (
                      <input
                        className="tb-search"
                        autoFocus
                        value={modelQuery}
                        placeholder={`filter ${models.length} models…`}
                        aria-label="filter models"
                        onChange={(e) => setModelQuery(e.target.value)}
                      />
                    ) : null}
                    {modelGroups.map((g) => {
                      const open = Boolean(modelQuery.trim()) || !closedGroups[g.provider];
                      return (
                        <div className="tb-group" key={g.provider}>
                          <button
                            type="button"
                            className={`tb-group-head ${open ? "open" : ""}`}
                            aria-expanded={open}
                            title={`${g.provider} · ${g.list.length} model(s)`}
                            data-provider={g.provider}
                            onClick={() => setClosedGroups((c) => ({ ...c, [g.provider]: !c[g.provider] }))}
                          >
                            <IconChevronRight size={11} className={`tb-group-chev ${open ? "open" : ""}`} />
                            <span className="tb-group-name">{g.provider}</span>
                            <span className="tb-group-count">{g.list.length}</span>
                          </button>
                          {open ? (
                            <div className="tb-group-body">
                              {g.list.map((m) => (
                                <button
                                  key={m.modelId}
                                  className={`tb-opt ${m.modelId === currentModel ? "sel" : ""} ${modelErr?.id === m.modelId || modelBad[m.modelId] ? "bad" : ""}`}
                                  title={modelBad[m.modelId]
                                    ? `${m.modelId} — this agent refused it: ${modelBad[m.modelId]}`
                                    : (m.description ? `${m.modelId} — ${m.description}` : m.modelId)}
                                  data-model={m.modelId}
                                  data-model-refused={modelBad[m.modelId] ? "1" : undefined}
                                  onClick={() => {
                                    if (m.modelId === currentModel) { setPop(null); setModelQuery(""); return; }
                                    setSwitching(true);
                                    setModelErr(null);
                                    // Not closed up front: a refusal has to be read where the pick
                                    // was made, with the list still in front of the operator.
                                    void cockpit.setModel(v.info.id, m.modelId)
                                      .then(() => { setPop(null); setModelQuery(""); setModelErr(null); setAttachErr(""); })
                                      .catch((e) => {
                                        const text = String((e as Error)?.message ?? e);
                                        setModelErr({ id: m.modelId, text });
                                        setModelBad((prev) => ({ ...prev, [m.modelId]: text }));
                                        setAttachErr(`model switch failed: ${text}`);
                                      })
                                      .finally(() => setSwitching(false));
                                  }}
                                >
                                  <span className="tb-opt-name">{shortModelName(m.name, m.modelId)}</span>
                                </button>
                              ))}
                              {g.truncated ? <div className="tb-empty">first 200 of this provider — filter to narrow</div> : null}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                    {!modelGroups.length ? <div className="tb-empty">no model matches “{modelQuery}”</div> : null}
                  </div>
                ) : (
                  <ChoiceList
                    items={(modelCfg?.options ?? []).map((o) => ({ value: String(o.value), name: o.name }))}
                    current={String(modelCfg?.currentValue ?? "")}
                    empty="the agent lists no models"
                    onPick={(value) => {
                      if (modelCfg) cockpit.send({ t: "set-config", sessionId: v.info.id, configId: modelCfg.id, value });
                      setPop(null);
                    }}
                  />
                )}
              </ToolbarSelect>
            ) : null}
            <span className="head-spacer" />
            {spoken.speaking ? (
              <button className="icon-btn on" title="stop reading aloud" aria-label="stop reading" onClick={() => speaker.stop()}>
                <IconPause size={14} />
              </button>
            ) : null}
            <button
              className={`icon-btn ${listening ? "on rec" : ""}`}
              title={dict.error ? dict.error : listening ? "stop dictation" : "dictate a prompt"}
              aria-label="dictate"
              onClick={() => {
                dictation.cancel();
                // the session is what lets the recogniser carry this conversation's hotwords
                void dictation.start(prefs, v.info.id);
              }}
            >
              <IconMic size={16} />
            </button>
            {call ? (
              <CallMode
                sessionId={v.info.id}
                onClose={onCloseCall}
                onKeyboard={() => { onCloseCall(); window.setTimeout(() => ta.current?.focus(), 30); }}
              />
            ) : null}
            {v.busy ? (
              <button
                className="send-btn stop"
                title="stop this turn"
                aria-label="stop this turn"
                onClick={() => cockpit.send({ t: "cancel", sessionId: v.info.id })}
              >
                <IconStop size={14} />
              </button>
            ) : (
              <button
                className="send-btn"
                onClick={send}
                disabled={(!text.trim() && !drafts.length) || v.info.status !== "ready"}
                title="send (Enter)"
                aria-label="send"
              >
                <IconSend size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The registry row shape lives with the client store (state.ts) — one type, one place.
 *  The dialog only reads it; editing happens on the settings page. */
type BackendRow = BackendView;

function NewSessionModal({ cwd: initialCwd, onClose }: { cwd?: string; onClose: () => void }): JSX.Element {
  useEscape(true, onClose);
  const [backend, setBackend] = useState("");
  // A rail group's 「+」 hands its directory in (`initialCwd`): then the only thing left to
  // choose is which agent runs there — the point of the + is that the folder is already
  // decided, and re-picking it is the step the operator asked to be rid of.
  const [dir, setDir] = useState(initialCwd ?? "");
  const fixedDir = initialCwd ?? "";
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [backends, setBackends] = useState<BackendRow[]>([]);

  const load = () => {
    setLoading(true); setErr("");
    cockpit
      .loadBackends()
      .then((rows) => {
        setBackends(rows);
        const first = rows[0];
        setBackend((cur) => cur || first?.id || "");
      })
      .catch((e) => setErr(`后端列表拉取失败：${String((e as Error).message ?? e)}`))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const create = async () => {
    setBusy(true); setErr("");
    try {
      const id = await cockpit.createSession(backend, dir.trim(), title.trim());
      cockpit.setActive(id);
      onClose();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>New session</h3>
        <label>backend</label>
        <div className="backend-pick">
          {loading && <span className="dim">loading…</span>}
          {!loading && !backends.length && <span className="dim">no backends</span>}
          {backends.map((b) => (
            <button
              key={b.id}
              title={b.home ? `home: ${b.home}` : undefined}
              className={backend === b.id ? "sel" : ""}
              onClick={() => setBackend(b.id)}
            >
              {b.label}
            </button>
          ))}
          <button className="retry" title="reload backend list" onClick={load}>⟳</button>
        </div>
        {(() => {
          // What this row will actually be: which code (cmd + env), which home, which profile.
          // It is the operator's one chance to notice "oh, this one writes into my LIVE home".
          const sel = backends.find((b) => b.id === backend);
          if (!sel) return null;
          return (
            <div className="hint be-hint">
              <div>
                runs: <code>{sel.cmd} {(sel.args ?? []).join(" ")}</code>
                {sel.profile ? <> · profile <code>{sel.profile}</code></> : null}
              </div>
              {sel.home ? (
                <div>
                  home: <code>{sel.home}</code>
                </div>
              ) : null}
              {(sel.env ?? []).length ? <div>env: <code>{(sel.env ?? []).join(", ")}</code></div> : null}
              {sel.health?.at ? (
                <div className={sel.health.status === "online" ? "be-dim" : "err"}>
                  上次检查：{sel.health.status}
                  {sel.health.kind ? ` · ${sel.health.kind}` : ""}
                  {sel.health.errorCode ? ` · ${sel.health.errorCode}` : ""}
                  {sel.health.status !== "online" && sel.health.guidance ? <div className="be-guidance">{sel.health.guidance}</div> : null}
                </div>
              ) : null}
              {(sel.warnings ?? []).map((w, i) => <div key={i} className="hint-warn">{w}</div>)}
            </div>
          );
        })()}
        <label>working directory</label>
        {fixedDir ? (
          <div className="ns-fixed-dir" title={fixedDir}>
            <IconFolder size={13} />
            <code>{fixedDir}</code>
          </div>
        ) : (
          <WorkspacePicker value={dir} onChange={setDir} />
        )}
        <label>title (optional)</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. fix flaky tests" />
        {err && <div className="err">{err}</div>}
        <div className="row">
          <button className="cancel" onClick={onClose}>cancel</button>
          <button className="go" disabled={busy || !dir.trim()} onClick={create}>{busy ? "spawning…" : "launch"}</button>
        </div>
      </div>
    </div>
  );
}
