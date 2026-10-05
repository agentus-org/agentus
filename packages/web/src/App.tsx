import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useDismiss, useEscape } from "./useDismiss";
import { cockpit, type BackendView, type MsgView, type SessionView } from "./state";
import { Markdown } from "./Markdown";
import { SettingsPage } from "./SettingsPage";
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
  IconStop, IconVolume, IconVolumeOff,
} from "./Icons";
import type { ClientCommand, PromptAttachment, SessionInfo, TurnTrace, UsageView } from "@agentslot/shared";

export function App(): JSX.Element {
  const snap = useSyncExternalStore(cockpit.subscribe, cockpit.getSnapshot);
  const [drawer, setDrawer] = useState(false);
  const [modal, setModal] = useState(false);
  // Settings is a view, not a modal: it replaces the chat area (hermes-studio's shape),
  // so a half-read conversation is still there when the operator comes back.
  const [settings, setSettings] = useState(false);

  // Who are we? Asked before anything else: /api/auth/me decides between the login
  // view and the cockpit. Dialling the socket first would be wasted — an
  // unauthenticated upgrade is refused with 401.
  useEffect(() => { void cockpit.checkAuth(); }, []);
  useEffect(() => { setDrawer(false); }, [snap.activeId]);
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

  return (
    <div className="app">
      {drawer && <div className="scrim" onClick={() => setDrawer(false)} />}
      <Sidebar
        open={drawer}
        onNew={() => setModal(true)}
        onSettings={() => { setSettings(true); setDrawer(false); }}
        settingsOpen={settings}
      />
      <Main
        onMenu={() => setDrawer(true)}
        settingsOpen={settings}
        onCloseSettings={() => setSettings(false)}
      />
      {modal && <NewSessionModal onClose={() => setModal(false)} />}
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

function Sidebar({ open, onNew, onSettings, settingsOpen }: {
  open: boolean;
  onNew: () => void;
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
    const lastOf = (s: SessionInfo): number => s.lastAt ?? s.createdAt;
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
            {conn === "offline" ? "⚠ 与服务的连接已断开 — 正在重连（指令会排队）" : "⚠ 服务不可达 — 请求超时"}
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

function Main({ onMenu, settingsOpen, onCloseSettings }: {
  onMenu: () => void;
  settingsOpen: boolean;
  onCloseSettings: () => void;
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

function ChatHead({ v, onMenu, panelOpen, onTogglePanel, onPickWorkspace, call, onCall }: {
  v: SessionView;
  onMenu: () => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
  onPickWorkspace: () => void;
  call: boolean;
  onCall: () => void;
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
        <span className="chip perm-chip" title="requests waiting for your approval in this session">
          <span className="perm-pulse" />⚿ {v.perms.length}
        </span>
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
          {v.perms.map((p) => <PermCard key={p.requestId} sid={v.info.id} req={p} />)}
          {v.msgs.map((m, i) => (
            <Bubble key={m.key} m={m} sid={v.info.id} busy={v.busy} last={i === v.msgs.length - 1} />
          ))}
          {v.busy && <div className="stream-hint">▸ turn in progress…</div>}
          {showWait && <div className="stream-hint">⏳ still waiting for the agent…</div>}
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
function Bubble({ m, sid, last, busy }: { m: MsgView; sid: string; last: boolean; busy: boolean }): JSX.Element | null {
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
              <CopyButton text={m.text} what="这条回复" />
              <SpeakButton id={m.key} text={m.text} />
              {last && !busy ? <ForkHere sid={sid} busy={busy} /> : null}
            </div>
          </div>
        </div>
      );
    case "thought":
      return <Thought m={m} />;
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

function Thought({ m }: { m: Extract<MsgView, { kind: "thought" }> }): JSX.Element {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? m.open;
  return (
    <div className="msg thought">
      <div
        className="role"
        style={{ cursor: "pointer" }}
        onClick={() => setUserOpen(!open)}
      >
        💭 thinking {open ? "▾" : "▸"}
      </div>
      {open && (
        <div className="bubble">
          {m.text}
          <div className="bubble-actions">
            <CopyButton text={m.text} what="这段思考" />
          </div>
        </div>
      )}
    </div>
  );
}

function PermCard({ sid, req }: { sid: string; req: SessionView["perms"][number] }): JSX.Element {
  return (
    <div className="msg">
      <div className="perm-card">
        <div className="q">🔑 <b>{req.kind}</b> wants to: <b>{req.toolCallTitle}</b></div>
        <div className="tc">{req.toolCallTitle}</div>
        <div className="opts">
          {req.options.map((o) => (
            <button
              key={o.optionId}
              className={o.kind.startsWith("allow") ? "allow" : "reject"}
              onClick={() =>
                cockpit.send({
                  t: "respond-permission", sessionId: sid, requestId: req.requestId,
                  decision: { outcome: "selected", optionId: o.optionId },
                  optionKind: o.kind, signature: `${req.kind}:${req.toolCallTitle}`,
                })
              }
            >
              {o.name}
            </button>
          ))}
          <button
            title="拒绝该请求：agent 会收到 cancelled，本轮就停在这里"
            onClick={() =>
              cockpit.send({
                t: "respond-permission", sessionId: sid, requestId: req.requestId,
                decision: { outcome: "cancelled" },
              })
            }
          >
            Dismiss (deny)
          </button>
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
 *  ACP has no method to set a window (the SDK routes none, and `session/set_context`
 *  answers "Method not found" — probed against Hermes), so this number is the budget the
 *  gauge measures against. What actually moves context is the agent's own `/compress`
 *  (advertised over ACP, so the button only appears when this agent really has it) and
 *  switching to a model with a longer window. */
function UsageRow({ v }: { v: SessionView }): JSX.Element | null {
  const usage = v.info.usage;
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

  return (
    <div className={`usage-row ${level}`} ref={rowRef}>
      <button className="usage-text" onClick={() => setOpen((o) => !o)} title="context window and this turn">
        ctx {fmt(usage.used)}{limit > 0 ? ` / ${fmt(limit)}` : ""}
        {limit > 0 ? ` · ${pct}% · ${fmt(remaining)} left` : ""}
        {source === "session" ? " (本会话声明)" : source === "model" ? " (模型记录)" : ""}
        {usage.cost != null ? ` · $${usage.cost.toFixed(4)}` : ""}
        {trace && (trace.effort || trace.mode)
          ? ` · ${[trace.effort && `effort ${trace.effort}`, trace.mode && `mode ${trace.mode}`].filter(Boolean).join(" / ")}`
          : ""}
      </button>
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
      {limit > 0 ? (
        <div className="usage-bar" title={`${fmt(usage.used)} of ${fmt(limit)} tokens`}>
          <i style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      {open ? (
        <div className="usage-detail">
          <div>context window: {usage.used} / {limit || "—"} tokens ({pct}%)</div>
          <div>remaining: {limit > 0 ? remaining : "unknown"} tokens</div>
          <div>window source: <b>{sourceLabel}</b></div>
          {usage.size > 0 && source !== "agent" ? <div>agent reports: {fmt(usage.size)} tokens (usage_update)</div> : null}
          {remembered && source === "session" ? <div>remembered for this model: {fmt(remembered)} tokens</div> : null}
          {usage.cost != null ? <div>session cost: ${usage.cost.toFixed(6)}</div> : null}
          {trace?.model ? <div>model: {trace.model}</div> : null}
          {trace && (trace.effort || trace.mode)
            ? <div>this turn: {[trace.effort && `effort ${trace.effort}`, trace.mode && `mode ${trace.mode}`].filter(Boolean).join(", ")}</div>
            : null}
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
              {declared ? (
                <button className="usage-edit-btn" disabled={busy !== ""} onClick={() => void apply(null, { remember })}>reset</button>
              ) : null}
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
              设置窗口长度
            </button>
          )}
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
          <div className="usage-note">
            ACP 没有"设置窗口"的方法（实测 <code>session/set_context</code> → Method not found），所以这个数字是仪表盘的预算；
            声明按模型记住。真正改变上下文的是上面两个命令与换模型。
          </div>
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
  // effort and model have their own toolbar buttons now; settings keeps everything else
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
      {/* Config options the agent advertises that are NOT the effort knob (that one has
          its own button now). Generic on purpose: a backend that adds an option gets it
          rendered without a code change here. */}
      {info.configOptions
        .filter((o) => o.type === "select" && o.options && o !== cfg && o !== modelCfg)
        .map((o) => (
          <div className="settings-group" key={o.id}>
            <div className="settings-label"><IconSettings size={13} /> {o.name || o.id}</div>
            {o.options?.map((opt) => (
              <button
                key={String(opt.value)}
                className={`settings-opt ${String(o.currentValue ?? "") === String(opt.value) ? "sel" : ""}`}
                onClick={() => cockpit.send({ t: "set-config", sessionId: info.id, configId: o.id, value: opt.value })}
              >
                {opt.name}
              </button>
            ))}
          </div>
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
  const [switching, setSwitching] = useState(false);
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
              e.target.style.height = "42px";
              e.target.style.height = Math.min(e.target.scrollHeight, window.innerHeight * 0.4) + "px";
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
                                  className={`tb-opt ${m.modelId === currentModel ? "sel" : ""}`}
                                  title={m.description ? `${m.modelId} — ${m.description}` : m.modelId}
                                  data-model={m.modelId}
                                  onClick={() => {
                                    setPop(null);
                                    setModelQuery("");
                                    if (m.modelId === currentModel) return;
                                    setSwitching(true);
                                    void cockpit.setModel(v.info.id, m.modelId)
                                      .catch((e) => setAttachErr(`model switch failed: ${String((e as Error)?.message ?? e)}`))
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

function NewSessionModal({ onClose }: { onClose: () => void }): JSX.Element {
  useEscape(true, onClose);
  const [backend, setBackend] = useState("");
  const [cwd, setCwd] = useState("");
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
        const first = rows.find((b) => !b.blocked);
        setBackend((cur) => cur || first?.id || "");
      })
      .catch((e) => setErr(`后端列表拉取失败：${String((e as Error).message ?? e)}`))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const create = async () => {
    setBusy(true); setErr("");
    try {
      const id = await cockpit.createSession(backend, cwd.trim(), title.trim());
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
              title={b.blocked ? `blocked: ${b.blocked}` : b.home ? `home: ${b.home}` : undefined}
              disabled={!!b.blocked}
              className={`${backend === b.id ? "sel" : ""} ${b.blocked ? "blocked" : ""}`}
              onClick={() => setBackend(b.id)}
            >
              {b.label}
              {b.blocked ? " ⊘" : ""}
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
                  {sel.allowLiveHome ? <b className="be-danger"> · live home 已放行（危险）</b> : null}
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
              {sel.blocked ? <div className="err">blocked: {sel.blocked}</div> : null}
              {(sel.warnings ?? []).map((w, i) => <div key={i} className="hint-warn">{w}</div>)}
            </div>
          );
        })()}
        <label>working directory</label>
        <WorkspacePicker value={cwd} onChange={setCwd} />
        <label>title (optional)</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. fix flaky tests" />
        {err && <div className="err">{err}</div>}
        <div className="row">
          <button className="cancel" onClick={onClose}>cancel</button>
          <button className="go" disabled={busy} onClick={create}>{busy ? "spawning…" : "launch"}</button>
        </div>
      </div>
    </div>
  );
}
