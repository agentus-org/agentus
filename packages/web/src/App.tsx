import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useDismiss, useEscape, usePopoverFit } from "./useDismiss";
import { ModelList } from "./ModelList";
import { modelProvider, shortModelName } from "./modelNames";
import { busyNow, cockpit, type BackendView, type BlockedSlot, type MsgView, type SessionView, type SetupPick, type StatusNote } from "./state";
import { Markdown } from "./Markdown";
import { SettingsPage } from "./SettingsPage";
import { clockHM, messageTime, relTime, stamp } from "./time";
import { durationWords, turnPulseState } from "./turn-state";
import { backendChoices, markOf } from "./agents";
import { CallMode } from "./CallMode";
import { loadServerTheme } from "./theme";
import { BrandMark } from "./Brand";
import { watchingNow } from "./presence";
import { loadServerCallSettings } from "./callSettings";
import { WorkspacePicker } from "./WorkspacePicker";
import { WorkspaceButton } from "./WorkspaceButton";
import { ToolPanel } from "./ToolPanel";
import type { PanelTarget } from "./ToolPanel";
import { MIN_CHAT, usePaneWidth } from "./paneWidth";
import { onOpenLocalFile, openLocalFile } from "./fileBus";
import { diffLines, mergeChanges, type DiffLine, type FileChange, type ToolChange } from "./changes";
import { RAIL_RECENT, railRows, splitRecent } from "./rail";
import { fitPlanSteps } from "./plan-fit";
import { parseBgNotice, shortCommand } from "./bgNotice";
import { copyText } from "./clipboard";
import { fmtTokens } from "./tokens";
import {
  forgetSummary, getLatestSummary, getSummary, subscribeSummaries, summariesVersion, summarizeMessage,
  summaryKey, SummaryError,
  type SpeechSummary,
} from "./speechSummary";
import {
  browserDictationAvailable, dictation, isCallActive, loadServerVoicePrefs, loadVoiceCaps, speaker, useAutoRead,
  useBriefSpeak, useDictation,
  subscribeVoiceCaps, useSpeaker, useVoicePrefs, voiceCaps, type VoicePrefs,
} from "./voice";
import {
  IconActivity, IconArrowDown, IconArrowUp, IconArchive, IconCheck, IconChevronDown, IconChevronRight, IconClose, IconCopy, IconDot, IconDotsV, IconDownload, IconEye, IconFile,
  IconFolder, IconFolderOpen, IconGauge, IconChip, IconFork, IconHome, IconMenu, IconMic, IconPanel, IconPaperclip,
  IconPause, IconPencil, IconPhone, IconPlus, IconPower, IconRefresh, IconResume, IconSearch, IconSend, IconSettings, IconShield,
  IconStop, IconVolume, IconVolumeOff, IconBrain, IconUsers,
} from "./Icons";
import type { ClientCommand, PermissionDecision, PermissionDiff, PermissionRequestView, PromptAttachment, SessionInfo, StatusNoteItem, TurnTrace, UsageView } from "../../shared/src/index";
import { installNoticeBridge, setNoticeOpener, unlockChime } from "./webNotify";

export function App(): JSX.Element {
  const snap = useSyncExternalStore(cockpit.subscribe, cockpit.getSnapshot);
  const [drawer, setDrawer] = useState(false);
  // ---- the rail's three states on a wide screen (issue #33) ---------------------------------
  // `expanded` (the full list) → `compact` (a 60px strip of backend avatars) → `hidden` (the
  // transcript gets the whole window). The drawer stays what it is on a phone (≤720px): one pane
  // at a time, opened by the same button. Persisted because a tablet user sets this ONCE and
  // expects it to hold across reloads — the same reason `agentus.rail-width` is persisted.
  const [railMode, setRailMode] = useState<"expanded" | "compact" | "hidden">(() => {
    try {
      const v = localStorage.getItem("agentus.rail-mode");
      return v === "compact" || v === "hidden" ? v : "expanded";
    } catch {
      return "expanded";
    }
  });
  useEffect(() => {
    try { localStorage.setItem("agentus.rail-mode", railMode); } catch { /* private mode */ }
  }, [railMode]);
  /** The one 「sessions」 button does the right thing per form factor: on a phone it opens the
   *  drawer (there is no room for a rail), on a wide screen it cycles what the rail IS. */
  const onMenu = useCallback(() => {
    if (window.matchMedia("(max-width: 720px)").matches) { setDrawer(true); return; }
    setRailMode((m) => (m === "expanded" ? "compact" : m === "compact" ? "hidden" : "expanded"));
  }, []);
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
  // The speaker menu's 「自定义节拍…」 needs to OPEN settings, and it lives four components deep
  // (App → Main → ChatPane → head). An event beats threading a prop through three layers for one
  // global action — and the menu closes itself on click either way.
  useEffect(() => {
    const open = (): void => { setSettings(true); setDrawer(false); };
    window.addEventListener("agentus:open-settings", open);
    return () => window.removeEventListener("agentus:open-settings", open);
  }, []);

  // ---- the two side panes, both resizable and both the operator's to size -----------------
  // The clamps are carved out in order — the rail first, the panel against what the rail left —
  // so no drag can squeeze the chat column below `MIN_CHAT`. See `paneWidth.tsx`.
  const rail = usePaneWidth({
    storage: "agentus.rail-width",
    fallback: 268,
    min: 200,
    max: () => Math.min(460, window.innerWidth - MIN_CHAT - 200),
    rightEdge: true,
    label: "resize the session rail",
  });
  const panel = usePaneWidth({
    storage: "agentus.panel-width",
    fallback: 760,
    min: 380,
    max: () => Math.max(380, window.innerWidth - rail.width - MIN_CHAT),
    label: "resize the workspace panel",
  });

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
        mode={railMode}
        onNew={() => setModal({})}
        onNewIn={(cwd) => setModal({ cwd })}
        onSettings={() => { setSettings(true); setDrawer(false); }}
        settingsOpen={settings}
        railWidth={rail.width}
        railHandle={rail.handle}
      />
      <Main
        onMenu={onMenu}
        settingsOpen={settings}
        onCloseSettings={() => setSettings(false)}
        onPermClick={() => { if (pendingPerm) setPermReopened(pendingPerm.requestId); }}
        panelWidth={panel.width}
        panelHandle={panel.handle}
      />
      {modal && <StartPage cwd={modal.cwd} onClose={() => setModal(false)} />}
      {/* Rendered here, not in the rail: the operator may have triggered the resume from the
          phone's bottom sheet and closed it, and this must still be on screen. */}
      {snap.blocked && <BlockedSlotDialog slot={snap.blocked} />}
      {/* The request that is waiting on THIS session. Shown unless the operator just put it
          away; a different request always asks again. */}
      {pendingPerm && activeView && (permReopened === pendingPerm.requestId || !permSkipped[pendingPerm.requestId]) ? (
        <PermDialog
          req={pendingPerm}
          sessionTitle={activeView.info.title}
          waiting={activeView.perms.length}
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
        <div className="auth-logo"><BrandMark size={30} /> Agentus</div>
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
                设置 <code>AGENTUS_PASSWORD</code> 后重启即可更换。
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

/** When this session was last talked to (creation time when it has no messages yet). The rail
 *  orders by it, so the row also SHOWS it — one definition, used by the sort and by the label. */
function lastOf(s: SessionInfo): number {
  return s.lastAt ?? s.createdAt;
}

/** A rail group = one directory and the sessions that ran in it. */
interface RailGroup {
  path: string;
  label: string;
  items: { s: SessionInfo; cold: boolean }[];
}

/** Group sessions by the directory they were pointed at — the ONE rule behind both rail sections
 *  (工作空间 and 已归档), so the archived list reads exactly like the live one instead of being a
 *  second, subtly different ordering.
 *
 *  ONE key orders everything here: when the session was last TALKED to (`lastOf`). Nothing about what
 *  is merely SELECTED moves a row any more, and neither does which row happens to have a process:
 *  two rules used to do exactly that — the group holding the active session sorted first, and a
 *  live row sorted above a cold one — so the rail moved because the operator LOOKED at something.
 *  Clicking between two workspaces swapped those two groups on every click, and waking a cold
 *  session lifted it above its live siblings: the list jumped under the hand that was reading it
 *  (operator, 2026-10-11: 「我频繁在两个空间中的会话间点击，会话列表跳来跳去」). The cost of dropping
 *  both is accepted deliberately: opening a workspace you have not talked in for a while does not
 *  lift it to the top — the row is still highlighted, still expanded, and still pinned into its
 *  group's visible window by `splitRecent`, so it is reachable; the list simply stays put until
 *  somebody actually says something. */
function groupSessions(all: { s: SessionInfo; cold: boolean }[]): RailGroup[] {
  const byPath = new Map<string, RailGroup>();
  for (const it of all) {
    const path = it.s.workspace || it.s.cwd;
    const label = path.split("/").filter(Boolean).pop() ?? path;
    const g = byPath.get(path) ?? { path, label, items: [] };
    g.items.push(it);
    byPath.set(path, g);
  }
  // A workspace is as recent as its newest session, so the group order follows the session order:
  // chat in a directory and that group rises with it.
  const at = (g: RailGroup): number => g.items.reduce((m, i) => Math.max(m, lastOf(i.s)), 0);
  return [...byPath.values()]
    // whichever one the operator last TALKED to (showing a group's own newest row first), then
    // creation time for rows that have never been talked to
    .map((g) => ({
      ...g,
      items: [...g.items].sort((a, b) => lastOf(b.s) - lastOf(a.s) || (b.s.createdAt - a.s.createdAt)),
    }))
    // the group you last talked in first, then by last chat, then alphabetically
    .sort((a, b) => at(b) - at(a) || a.label.localeCompare(b.label));
}

/** The statuses a rail row can wear, in the operator's words. The raw wire value is protocol
 *  vocabulary (`running`), and a tooltip that reads "hermes · running" names the class in the
 *  wrong language — the row is a sentence about a session, not a debug dump. */
const STATUS_WORD: Record<string, string> = {
  starting: "启动中", ready: "待命", running: "运行中", error: "出错", closed: "已关闭",
  // not an error and not the operator's doing: the cockpit stopped an idle process to reclaim memory,
  // and one click brings it back (设置 → 智能体 → Agent 空闲超时).
  reaped: "已回收（空闲）",
};

function BackendAvatar({ backend, cold, status, wake }: { backend: string; cold: boolean; status: string; wake?: boolean }): JSX.Element {
  const mark = markOf(backend);
  const [broken, setBroken] = useState(false);
  const useIcon = mark.icon && !broken;
  // Three questions, three carriers, on purpose.
  //   · "is there a process behind this row at all" is answered STATICALLY, by the corner badge:
  //     a badge means "a live ACP process", absent means the session is on disk only. `cold` is the
  //     server's own word for "no process", so the badge follows `cold` and nothing else.
  //   · "is anything working RIGHT NOW" is answered by MOTION: only the running row moves — a
  //     breathing halo on the mark (studio's streaming ring in our tokens). Every other state stays
  //     still, which is what makes the one moving row findable.
  //   · …and the badge itself says WHICH of the two it is, by COLOUR: 待命/出错/已回收 wear a neutral
  //     grey dot (a process exists, it is not doing anything), a session that is RUNNING wears the
  //     same dot in green. The dot used to be green for every row with a process, which made the one
  //     fact worth scanning for disappear into a rail of green pixels (operator, 2026-10-11:
  //     「绿点点是 acp 进程运行中…能不能改成灰色的，然后进行中的不仅显示光流也显示当前这个绿色」).
  //     The status WORD (待命/运行中/出错) stays in the tooltip and in the row, never in a 7px pixel.
  // 「还在跑」有两种：回合在进行（status），以及回合已经结束但有一个唤醒型后台进程在等
  // 结果回来（issue #35）。后者同样意味着这个会话没有收工 —— 呼吸灯必须继续亮，否则
  // 语义正好反了：会话明明在等唤醒续跑，却亮成「已结束待查看」。
  const live = !cold && (status === "running" || wake === true);
  return (
    <span
      className={`be-avatar be-${backend} ${cold ? "cold" : ""} ${live ? "live" : ""}`}
      data-backend={backend}
      data-letter={mark.letter}
      // "cold" is about the PROCESS, not about the archive — the row's own title says whether the
      // session was put away, and a crashed slot must not be labelled 已归档 (that is the bug).
      title={`${mark.label} · ${cold ? "无进程" : wake && status !== "running" ? "等后台任务唤醒" : STATUS_WORD[status] ?? status}`}
      aria-hidden="true"
    >
      {useIcon
        ? <img src={mark.icon} alt="" draggable={false} onError={() => setBroken(true)} />
        : mark.letter}
      {!cold ? <span className={`be-dot proc ${live ? "running" : ""}`} /> : null}
    </span>
  );
}

/** WHO is speaking, on the message itself. The label there used to read "AGENT" — that names the
 *  class, not the agent, while the rail right beside it showed a face. Studio puts the mark on every
 *  message; we reuse the rail's own artwork (`/coding-agents/*`) so one agent looks the same in both
 *  places.
 *
 *  A backend with NO artwork (the mock agent) renders no mark here at all: the name is printed right
 *  beside it, and the rail's monogram in front of the word would read as 「MMock」. The monogram exists
 *  for the rail because a rail row has no room for a name; this row does. A broken image falls back to
 *  the same nothing, leaving the name — which is the identification either way. */
function AgentMark({ backend }: { backend: string }): JSX.Element | null {
  const mark = markOf(backend);
  const [broken, setBroken] = useState(false);
  if (!mark.icon || broken) return null;
  return (
    <span className="agent-mark" data-backend={backend} aria-hidden="true">
      <img src={mark.icon} alt="" draggable={false} onError={() => setBroken(true)} />
    </span>
  );
}

/** Everything that acts on a SESSION, in one menu: rename, fork, workspace, id, resume, restart,
 *  delete. It replaces the row of tiny buttons that used to live on every session row —
 *  the rail is for finding work, the menu is for acting on it (studio's split). On a phone
 *  the same markup is laid out as a bottom sheet by CSS, where a thumb can reach it. */
function SessionMenu({ x, y, trigger, info, cold, archived, unread, canFork, onDismiss, onRename, onRetitle, retitling, onFork, onWorkspace, onExport, onRestart, onResume, onArchive, onUnarchive, onUnarchiveResume, onToggleUnread, onDelete }: {
  x: number; y: number; trigger: HTMLElement | null;
  info: SessionInfo; cold: boolean; /** the operator put it away — independent of `cold` */
  archived: boolean;
  /** 这一行现在带不带「还没看」的点 —— 菜单的标签就照它说（一个开关，不是一个新状态） */
  unread: boolean;
  canFork: boolean;
  onDismiss: () => void; onRename: () => void; onRetitle: () => void; retitling: boolean;
  onFork: () => void; onWorkspace: () => void;
  onExport: () => void;
  /** 设为未读 / 设为已读： 「点进去看了，但还没决策」的唯一入口（AionUi 的 手动未读） */
  onToggleUnread: () => void;
  /** Live slots only: swap the agent process under this slot — same session and picks, new pid. */
  onRestart: () => void;
  onResume: () => void;
  /** 归档 / 取消归档：the operator's storage decision (the server stops a live process as part of it) */
  onArchive: () => void; onUnarchive: () => void;
  /** 取消归档并恢复 — the one action that means "bring this conversation back to where I work" */
  onUnarchiveResume: () => void;
  onDelete: () => void;
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
      {/* A switch, not a state: the label says what the click will DO. 「设为未读」 is the operator's
          way back — they opened the row, so the completion dot went away, but they were not ready to
          decide and want the reminder to survive the reload. */}
      {item(unread ? "设为已读" : "设为未读", unread ? <IconEye size={14} /> : <IconDot size={14} />, onToggleUnread)}
      {item(
        retitling ? "正在重新生成…" : "重新生成会话名",
        retitling ? <IconRefresh size={14} className="spin" /> : <IconRefresh size={14} />,
        onRetitle,
      )}
      {canFork ? item(cold ? "fork 会话（先恢复）" : "fork 会话", <IconFork size={14} />, onFork) : null}
      {item("工作目录…", <IconFolder size={14} />, onWorkspace)}
      {item("导出会话（Markdown）", <IconDownload size={14} />, onExport)}
      {item("复制会话 ID", <IconCopy size={14} />, () => { void copyText(info.id); })}
      {/* Two independent questions, so two independent controls. ① is there a process (wake it /
          restart it)? ② did the operator put it away? Collapsing them into one row was the old bug:
          「归档会话」 silently meant 「关掉进程」, and a crashed slot looked archived. */}
      {archived && cold
        ? item("取消归档并恢复", <IconResume size={14} />, onUnarchiveResume)
        : cold
          ? item("恢复会话", <IconResume size={14} />, onResume)
          : item("重启 agent 进程", <IconPower size={14} />, onRestart)}
      {archived
        ? (cold ? null : item("取消归档", <IconResume size={14} />, onUnarchive))
        : item("归档会话", <IconArchive size={14} />, onArchive)}
      {cold ? item("删除会话（连记录）", <IconClose size={14} />, onDelete, true) : null}
    </div>
  );
}

function Sidebar({ open, mode, onNew, onNewIn, onSettings, settingsOpen, railWidth, railHandle }: {
  open: boolean;
  /** Wide-screen state of the rail: full list / 60px avatar strip / gone (issue #33). */
  mode: "expanded" | "compact" | "hidden";
  onNew: () => void;
  /** Create a session in the directory the operator already pointed at (a rail group's 「+」). */
  onNewIn: (cwd: string) => void;
  onSettings: () => void;
  settingsOpen: boolean;
  /** The rail is resizable by dragging its right edge (`paneWidth.tsx`); the width goes out as a
   *  CSS variable so the phone drawer's own `width` rule still wins over it. */
  railWidth: number;
  railHandle: JSX.Element;
}): JSX.Element {
  const { sessions, cold, archived, activeId, conn, net, netError, authInfo } = useSyncExternalStore(cockpit.subscribe, cockpit.getSnapshot);
  // 中文用户改会话名时第一下回车是「选词」(#29)，不是「确认重命名」。
  const ime = useImeGuard();
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
  // ---- the browser-notification channel's page half (webNotify.ts) -----------------------------
  // Two once-per-page wirings and one gesture hook:
  //  * the bridge, so a click that happened in the SERVICE WORKER (which cannot select a session)
  //    comes back here to be honoured in place instead of reloading the cockpit;
  //  * the opener, so "open the session that notified me" is the same in-page switch the rail does;
  //  * audio unlock — a chime may only start inside a gesture, and the moment a notification arrives
  //    is by definition not one, so the first real interaction is where the context gets created.
  useEffect(() => {
    installNoticeBridge();
    setNoticeOpener((id) => cockpit.setActive(id));
    const unlock = (): void => unlockChime();
    const events = ["pointerdown", "keydown", "touchstart"];
    for (const e of events) window.addEventListener(e, unlock, { passive: true });
    return () => { for (const e of events) window.removeEventListener(e, unlock); };
  }, []);
  const [q, setQ] = useState("");
  // ---- group folding: which DIRECTORIES are open ----------------------------------------------
  // A directory fold is a layout preference, not view state: the operator folds the projects he is
  // not working in and expects them to stay folded — a reload that re-opens twenty of them is the
  // bug he reported (AionUi persists this too, `useWorkspaceExpansionState`). Keyed by directory
  // path, namespaced per section so 工作空间 and 已归档 never collide, and PRUNED on load: a
  // directory that no longer has sessions should not hold a key forever.
  const RAIL_CLOSED_KEY = "agentus.railClosed";
  const RAIL_MORE_KEY = "agentus.railMore";
  const readFoldStore = (key: string): Record<string, boolean> => {
    try {
      const raw = JSON.parse(localStorage.getItem(key) ?? "{}") as unknown;
      return raw && typeof raw === "object" ? (raw as Record<string, boolean>) : {};
    } catch { return {}; }
  };
  const [closed, setClosed] = useState<Record<string, boolean>>(() => readFoldStore(RAIL_CLOSED_KEY));
  // Which directory groups the operator unrolled past RAIL_RECENT. Persisted too — it is the same
  // kind of preference, and losing it silently re-hides sessions the operator had chosen to see.
  const [more, setMore] = useState<Record<string, boolean>>(() => readFoldStore(RAIL_MORE_KEY));
  useEffect(() => {
    try { localStorage.setItem(RAIL_CLOSED_KEY, JSON.stringify(closed)); } catch { /* private mode: folding just won't stick */ }
  }, [closed]);
  useEffect(() => {
    try { localStorage.setItem(RAIL_MORE_KEY, JSON.stringify(more)); } catch { /* same */ }
  }, [more]);
  // ---- section folding: 团队 / 工作空间 / 已归档 ---------------------------------------
  // A folded SECTION is a layout preference too: it survives the reload in localStorage, like the
  // palette and the voice prefs. A search query always opens them — a result you cannot see is not
  // a result.
  const RAIL_FOLD_KEY = "agentus.railSections";
  const [folded, setFolded] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(RAIL_FOLD_KEY) ?? "{}") as Record<string, boolean>; } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem(RAIL_FOLD_KEY, JSON.stringify(folded)); } catch { /* private mode: folding just won't stick */ }
  }, [folded]);
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
  const menuInfo = menu
    ? (sessions.find((x) => x.id === menu.id) ?? cold.find((x) => x.id === menu.id)
      ?? archived.find((x) => x.id === menu.id) ?? null)
    : null;
  // Both facts come from the ROW (the server sends them with every list), never from which bucket it
  // arrived in: an archived row can be live, and a cold row is not necessarily archived.
  const menuCold = Boolean(menuInfo?.cold);
  const menuArchived = Boolean(menuInfo?.archivedAt);
  const pickInfo = pickFor
    ? (sessions.find((x) => x.id === pickFor) ?? cold.find((x) => x.id === pickFor)
      ?? archived.find((x) => x.id === pickFor) ?? null)
    : null;
  const needle = q.trim().toLowerCase();
  const match = (s: { title: string; backend: string; cwd: string; workspace?: string | null }) =>
    !needle || `${s.title} ${s.backend} ${s.workspace || s.cwd}`.toLowerCase().includes(needle);

  // 工作空间 holds every row that is NOT archived: the ones with a process (live) and the ones
  // without (cold — closed, crashed, or reclaimed for being idle). A dead slot is still a slot the
  // operator may want back, so it belongs here — NOT under 已归档, which is now a statement about
  // what HE decided (see the archived flag) rather than about what happened to a process.
  const groups = useMemo(
    () => {
      const rows = railRows(sessions, cold).filter(({ s }) => match(s));
      return groupSessions(rows);
    },
    [sessions, cold, needle]
  );

  // 已归档 is a section of its own (parallel to 工作空间, as the operator asked), built by the SAME
  // grouping rule — same directories, same ordering — so the two sections read alike. Its contents
  // are chosen by the ARCHIVE FLAG, not by liveness: a session the operator put away belongs here
  // whatever its process is doing, and a session that merely lost its process stays in 工作空间.
  // `cold` comes from the server with each row (an archived row that has been resumed is live).
  const archivedGroups = useMemo(
    () => groupSessions(archived.map((s) => ({ s, cold: Boolean(s.cold) })).filter(({ s }) => match(s))),
    [archived, needle]
  );

  const teamOpen = Boolean(needle) || !folded.team;
  const workspacesOpen = Boolean(needle) || !folded.workspaces;
  const archivedOpen = Boolean((needle && archivedGroups.length) || !folded.archived);

  // Prune fold keys for directories that no longer have any sessions — otherwise a deleted project
  // keeps its flag forever (AionUi prunes its expansion state the same way). Guarded on a NON-EMPTY
  // list: at first paint the sessions have not arrived yet, and pruning against "nothing" would wipe
  // the operator's layout on every single reload.
  const foldPaths = useMemo(() => new Set([...groups, ...archivedGroups].map((g) => g.path)), [groups, archivedGroups]);
  useEffect(() => {
    if (!foldPaths.size) return;
    const keep = (o: Record<string, boolean>): Record<string, boolean> => {
      const entries = Object.entries(o).filter(([k]) => foldPaths.has(k.replace(/^(ws|arch):/, "")));
      return entries.length === Object.keys(o).length ? o : Object.fromEntries(entries);
    };
    setClosed(keep);
    setMore(keep);
  }, [foldPaths]);

  /** Render one section's directory list. `ns` namespaces the fold keys, so the SAME directory path
   *  can be open in 工作空间 and folded in 已归档 without the two fighting over one flag. */
  const renderGroups = (list: RailGroup[], ns: string): JSX.Element[] =>
    list.map((g) => {
      const key = ns + g.path;
        const isOpen = Boolean(needle) || !closed[key];
        const liveCount = g.items.filter((i) => !i.cold).length;
        // ---- recent-N: a workspace holds its newest few, the rest behind a click -----------------
        // The rule itself lives in `rail.ts` (with its own suite). No group is exempt any more: the
        // group you are working in folds like every other one, and the row you are IN is pinned
        // inside that limit instead — the conversation never disappears, the list still stops at N.
        const { shown, hidden } = splitRecent(g.items, {
          searching: Boolean(needle),
          isActive: (i) => i.s.id === activeId,
          // A row with a request waiting for the operator must not fold away: this badges it (`⚿ N`)
          // and it is the way in to the conversation holding it — the dialog only draws the ACTIVE
          // session's request, so a hidden row is a request nothing on screen announces.
          mustShow: (i) => Boolean(cockpit.byId.get(i.s.id)?.perms.length),
          expanded: Boolean(more[key]),
        });
        return (
          <div className="rail-group" key={g.path}>
            <div className="rail-group-row">
            <button
              type="button"
              className={`rail-group-head ${isOpen ? "open" : ""}`}
              title={g.path}
              aria-expanded={isOpen}
              data-workspace={g.path}
              onClick={() => setClosed((c) => ({ ...c, [key]: !c[key] }))}
            >
              {isOpen ? (
                <IconFolderOpen size={13} className="rail-group-folder" />
              ) : (
                <IconFolder size={13} className="rail-group-folder" />
              )}
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
                setClosed((c) => ({ ...c, [key]: false }));
                onNewIn(g.path);
              }}
            >
              <IconPlus size={12} />
            </button>
          </div>
            {isOpen ? (
              <div className="rail-group-body">
                {shown.map(({ s, cold }) => (
                  <div
                    key={s.id}
                    ref={(el) => { if (el) rows.current.set(s.id, el); else rows.current.delete(s.id); }}
                    className={`session-item ${cold ? "cold" : ""} ${s.id === activeId ? "active" : ""} ${editing === s.id ? "editing" : ""}`}
                    data-session={s.id}
                    title={(s.archivedAt
                      ? `${s.title} — 已归档${cold ? "（进程已停）" : ""}，点一下打开；菜单里可取消归档并恢复`
                      : `${s.title}${cold ? " — 进程已停，点一下恢复" : ""}`)
                      // a name given by ANOTHER agent is a claim about what this session is; the
                      // operator should be able to see who made it (titleBy = that session's id)
                      + (s.titleBy ? `\n名字由会话 ${s.titleBy} 的 agent 改的` : "")}
                    onContextMenu={(e) => { e.preventDefault(); openFrom(s.id, e); }}
                    onTouchStart={(e) => { const t = e.touches[0]; pressStart(s.id, t?.clientX ?? 0, t?.clientY ?? 0); }}
                    onTouchEnd={pressClear}
                    onTouchMove={pressClear}
                    onTouchCancel={pressClear}
                    onClick={(e) => {
                      if (pressFired.current) { pressFired.current = false; e.preventDefault(); return; }
                      if (editing === s.id) return;
                      // An ARCHIVED row opens for reading: it was put away on purpose, so a plain
                      // click must not quietly undo that (the menu's 「取消归档并恢复」 is the
                      // statement that means it). A cold row in 工作空间 wakes on click, as before.
                      if (cold && !s.archivedAt) void cockpit.resume(s.id);
                      else cockpit.setActive(s.id);
                    }}
                  >
                    <BackendAvatar
                      backend={s.backend}
                      cold={cold}
                      status={s.status}
                      wake={(cockpit.byId.get(s.id)?.background ?? []).some((t) => t.status === "running")}
                    />
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
                        {...ime.handlers}
                        onKeyDown={(e) => {
                          if (ime.isComposing(e)) return; // 选词回车：让输入法自己处理
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
                    {/* 「这个会话还没干完」 at the list level (issue #22): a turn can end while a build keeps
                        running, and the rail is where the operator scans for what still needs him. Counted,
                        not a bare dot — two processes and one are different amounts of waiting.
                        The icon is an activity pulse, not a cog: 「⚙ 在别的 App 里就是设置」 (the operator,
                        2026-10-18) — and the cog did sit confusingly close to the settings button. */}
                    {(() => {
                      const running = cockpit.byId.get(s.id)?.background?.filter((t) => t.status === "running").length ?? 0;
                      return running ? (
                        <span className="badge bg" title={`${running} 个后台任务还在跑（完成后会唤醒会话）`}>
                          <IconActivity size={9} />{running}
                        </span>
                      ) : null;
                    })()}
                    {/* When I last talked to this session — sorted by it, so it has to be visible.
                        Relative on purpose ("刚刚" / "3 小时前" / "昨天"), with the exact stamp in
                        the tooltip; the operator asked for exactly this and for it to age. */}
                    <span className="rail-at" title={`最后一次消息：${stamp(lastOf(s))}`}>{relTime(lastOf(s))}</span>
                    {/* 「跑完了，还没看」 — AionUi's completion dot, at the row's right end (a flex item,
                        not an overlay: the ⋯ button keeps its slot, so nothing jumps on hover). Shown
                        only when this row is NOT already the thing to look at — a running turn has the
                        live mark, a pending approval has the ⚿ badge, and a second dot there would
                        answer a question nobody asked. */}
                    {cockpit.isUnread(s.id)
                      && !cockpit.byId.get(s.id)?.busy
                      && !cockpit.byId.get(s.id)?.perms.length
                      // 等唤醒 ≠ 跑完等你看 (#35)：蓝点说「停下来了，回来看」，而这个会话
                      // 马上会因为后台结果自己继续 —— 蓝点会把「还在干活」读成「干完了」。
                      && !(cockpit.byId.get(s.id)?.background ?? []).some((t) => t.status === "running") ? (
                        <span
                          className="unread-dot"
                          data-unread
                          title="这轮已经结束了，你还没看"
                          aria-label="未读"
                        />
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
            {/* 「展开其余 N 条」 — the tail of this workspace, one click away. Rendered only when
                something is actually hidden (and never while a search is filtering: that view
                claims to show every match). */}
            {isOpen && !needle && g.items.length > RAIL_RECENT && (
              <button
                type="button"
                className={`rail-more ${more[key] ? "open" : ""}`}
                onClick={() => setMore((mm) => ({ ...mm, [key]: !mm[key] }))}
                aria-expanded={Boolean(more[key])}
                title={more[key] ? "只显示最近几个" : `展开这个工作空间里其余的 ${g.items.length - RAIL_RECENT} 个会话`}
              >
                <IconChevronRight size={10} className={`rail-more-chev ${more[key] ? "open" : ""}`} />
                {more[key] ? "收起" : `展开其余 ${g.items.length - RAIL_RECENT} 条`}
              </button>
            )}
          </div>
        );
    });

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
    // The width is inline (the operator's drag), so `compact` has to win HERE — a class rule cannot
    // override an inline custom property.
    <aside className={`sidebar ${open ? "open" : ""} ${mode}`} style={{ "--rail-w": `${mode === "compact" ? 60 : railWidth}px` } as CSSProperties}>
      {railHandle}
      <header>
        <span className="logo"><BrandMark size={24} /> Agentus</span>
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
        <IconPlus size={14} /> <span className="new-label">new session</span>
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
        {/* Two sections, in this order: 团队 above 工作空间 (AionUi's sider puts its team section
            immediately above the project groups, and that is the shape the operator asked for).
            团队 has no backend yet, so its row is a `div` with aria-disabled — nothing to click,
            nothing to tab into — and it says 「还没做」 instead of pretending to work. When the
            feature lands, this row becomes the entry point and the label stays. */}
        {/* A section head is a fold control, not a label (AionUi's team section has exactly this
            chevron, and the state is remembered there too). Folding is what the operator asked for
            after comparing the two rails. */}
        <button type="button" className={`rail-section ${teamOpen ? "open" : ""}`} data-section="team"
                aria-expanded={teamOpen} aria-controls="rail-team"
                title={teamOpen ? "折叠团队" : "展开团队"}
                onClick={() => setFolded((f) => ({ ...f, team: !f.team }))}>
          <IconChevronRight size={11} className={`rail-section-chev ${teamOpen ? "open" : ""}`} />
          <span>团队</span>
        </button>
        {teamOpen ? (
          <div className="rail-placeholder" data-placeholder="team" id="rail-team" aria-disabled="true"
               title="团队 — 还没有实现，先占个位（现在的驾驶舱一条会话就是一个 agent，没有团队/成员的概念）">
            <IconUsers size={13} />
            <span className="rail-placeholder-name">还没做，先占个位</span>
          </div>
        ) : null}
        {/* The workspaces themselves are the menu: each row below is one, and its sessions are
            nested inside it. The label exists so the rail reads as a list of sections rather than
            an undifferentiated pile of group headers. */}
        <button type="button" className={`rail-section ${workspacesOpen ? "open" : ""}`} data-section="workspaces"
                aria-expanded={workspacesOpen} aria-controls="rail-workspaces"
                title={workspacesOpen ? "折叠工作空间" : "展开工作空间"}
                onClick={() => setFolded((f) => ({ ...f, workspaces: !f.workspaces }))}>
          <IconChevronRight size={11} className={`rail-section-chev ${workspacesOpen ? "open" : ""}`} />
          <span>工作空间</span>
        </button>
        <div id="rail-workspaces">
        {workspacesOpen ? renderGroups(groups, "ws:") : null}
        {workspacesOpen && !groups.length && (
          <div className="rail-empty">
            {needle ? "no session matches that search." : "No sessions yet — create one."}
          </div>
        )}
        </div>
        {/* 已归档 — a section of its own, parallel to 工作空间 and built the same way (directories,
            each holding its sessions), because the operator asked for exactly that: an archived
            session should read in the same shape as a live one, just under its own heading. It
            carries its own fold flag (`folded.archived`) and its own directory-fold namespace. */}
        <button type="button" className={`rail-section ${archivedOpen ? "open" : ""}`} data-section="archived"
                aria-expanded={archivedOpen} aria-controls="rail-archived"
                title={archivedOpen ? "折叠已归档" : "展开已归档"}
                onClick={() => setFolded((f) => ({ ...f, archived: !f.archived }))}>
          <IconChevronRight size={11} className={`rail-section-chev ${archivedOpen ? "open" : ""}`} />
          <span>已归档</span>
          {archived.length ? <span className="rail-section-count">{archived.length}</span> : null}
        </button>
        <div id="rail-archived" data-archived="1">
        {archivedOpen ? renderGroups(archivedGroups, "arch:") : null}
        {archivedOpen && !archivedGroups.length && (
          <div className="rail-empty">
            {needle ? "no archived session matches that search." : "Nothing archived yet."}
          </div>
        )}
        </div>
      </div>
      {menu && menuInfo ? createPortal(<SessionMenu
          x={menu.x} y={menu.y} trigger={menu.trigger}
          info={menuInfo} cold={menuCold} archived={menuArchived}
          unread={cockpit.isUnread(menuInfo.id)}
          onToggleUnread={() => {
            // Close first: the row's dot changes state underneath the menu, and the menu is anchored to
            // a trigger that just moved.
            setMenu(null);
            cockpit.toggleUnread(menuInfo.id);
          }}
          canFork={Boolean(menuInfo.acpSessionId) || menuCold}
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
          onArchive={() => {
            setMenu(null);
            if (confirm(`归档“${menuInfo.title}”？\n\n收进「已归档」，随时可以取消归档并恢复。${
              menuCold ? "" : "运行中的 agent 进程会一起停掉（对话记录保留）。"}`)) void cockpit.setArchived(menuInfo.id, true);
          }}
          onUnarchive={() => { setMenu(null); void cockpit.setArchived(menuInfo.id, false); }}
          onUnarchiveResume={() => { setMenu(null); void cockpit.unarchiveAndResume(menuInfo.id); }}
          onRestart={() => {
            setMenu(null);
            // The one honest warning: this kills the process, so a turn in flight dies with it.
            if (confirm(`重启“${menuInfo.title}”的 agent 进程？\n\n旧进程退出、新进程接管同一个会话：对话记录、模型和思考深度都保留，只有进程换新（改完代码或改了后端配置后，用它让槽位吃到新东西）。正在跑的这一轮会被中断。`)) void cockpit.restart(menuInfo.id);
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
              value={pickInfo?.workspace ?? pickInfo?.cwd ?? ""}
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

function Main({ onMenu, settingsOpen, onCloseSettings, onPermClick, panelWidth, panelHandle }: {
  onMenu: () => void;
  settingsOpen: boolean;
  onCloseSettings: () => void;
  /** Reopen the approval dialog for the request waiting on this session (the ⚿ chip). */
  onPermClick: () => void;
  /** Resizable workspace panel (`paneWidth.tsx`): width in px, and the handle for its LEFT edge. */
  panelWidth: number;
  panelHandle: JSX.Element;
}): JSX.Element {
  const { active } = useSyncExternalStore(cockpit.subscribe, cockpit.getSnapshot);
  // The panel (files · terminal) is per-slot UI state, not a server thing: it lives
  // here so switching slots keeps the panel open on the new slot's workspace.
  const [panelOpen, setPanelOpen] = useState(false);
  // A file pushed into the panel from outside it — a file link or an image in a reply
  // (fileBus.ts). A fresh object each time, so clicking the same link twice reopens it.
  const [panelFocus, setPanelFocus] = useState<PanelTarget | null>(null);
  useEffect(() => onOpenLocalFile((req) => {
    setPanelOpen(true);
    setPanelFocus({ ...req });
  }), []);
  const [pickWorkspace, setPickWorkspace] = useState(false);
  // The call overlay is launched from the HEAD (it is a way of talking to the session,
  // like the other head controls) but lives in the composer, so the state sits here:
  // the head opens it, the composer renders it and can hand the keyboard back.
  const [call, setCall] = useState(false);
  // Voice capabilities are fetched once; the buttons fall back to browser-only until
  // the answer arrives.
  useEffect(() => { void loadVoiceCaps(); }, []);
  useAutoRead(lastFinishedReply(active), Boolean(active && !active.busy && active.loaded));
  // 工作播报: the cockpit's own one-line briefs about this session (issue #16). Same speaker, a
  // different source — and the SERVER owns the policy (throttle, what is worth saying, the fallback
  // when no observer can speak), so this side never has to decide.
  useBriefSpeak(lastBrief(active), Boolean(active));

  if (settingsOpen) {
    return <SettingsPage onClose={onCloseSettings} sessionId={active?.info.id} />;
  }
  if (!active) {
    return (
      <div className="main">
        <div className="chat-head">
          <button className="icon-btn menu-btn" onClick={onMenu} title="sessions" aria-label="sessions"><IconMenu /></button>
          <span className="title">Agentus</span>
        </div>
        <div className="empty">
          <div className="big"><BrandMark size={72} /></div>
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
            focus={panelFocus}
            panelWidth={panelWidth}
            panelHandle={panelHandle}
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

/** The newest 工作播报 line for this session, as a speaker target. Keyed by the line's own id so
 *  the same brief is never spoken twice (the ring buffer survives re-renders). */
function lastBrief(v: SessionView | undefined): { key: string; text: string } | null {
  const line = v?.speaks?.[v.speaks.length - 1];
  return line ? { key: `brief:${line.id}`, text: line.text } : null;
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
  // 三档 (issue #16): 关 / 自动朗读（念整条回复）/ 工作播报（念驾驶舱的一句话播报）。 One position on
  // the header, three states — a fourth switch in 设置 would be a second place to look for the same
  // decision. `speakMode` is the server's word; `autoRead` is only the pre-#16 alias for "reply".
  const mode: "off" | "reply" | "brief" =
    prefs.speakMode ?? (prefs.autoRead ? "reply" : "off");
  const [speakMenu, setSpeakMenu] = useState(false);
  const speakRef = useRef<HTMLSpanElement | null>(null);
  useDismiss(speakMenu, [speakRef], () => setSpeakMenu(false));
  // 节拍 (issue #24). Read here, next to the mode, because the menu shows ONE ✓ across all six
  // items: 「工作播报」 without a beat and 「每 2 分钟」 are different positions on the same switch.
  const [intervalSec, saveInterval] = useObserverInterval();
  const setMode = (next: "off" | "reply" | "brief", interval?: number): void => {
    setSpeakMenu(false);
    // Mutual exclusion is the data model, not a UI convention: `speakMode` is ONE field, so 自动朗读
    // and 工作播报 cannot both be on. A beat is only ever written together with `brief`.
    setPrefs({ speakMode: next, autoRead: next === "reply" });
    if (next === "brief" && interval !== undefined) saveInterval(interval);
  };
  // 单击 = 开/关，长按（手机）/ 右键（桌面）/ Shift+F10（键盘）= 选档。
  // Why this split (the operator, 2026-10-18): the three-way menu had taken over the ONE gesture
  // used most — every tap opened a menu to turn a switch off. Turning reading on or off is the
  // frequent action and deserves the single click back; picking WHICH thing to read is rare and
  // earns the longer gesture, which is also what a menu means everywhere else in this app
  // (rail rows: ⋯ / right-click / phone long-press).
  // A long press must swallow the click that follows it, or the menu opens AND the mode flips.
  const speakPress = useRef<{ timer: number | null; fired: boolean }>({ timer: null, fired: false });
  const speakPressClear = (): void => {
    if (speakPress.current.timer) { window.clearTimeout(speakPress.current.timer); speakPress.current.timer = null; }
  };
  useEffect(() => speakPressClear, []);
  const speakPressStart = (): void => {
    speakPress.current.fired = false;
    speakPressClear();
    speakPress.current.timer = window.setTimeout(() => {
      speakPress.current.fired = true;
      setSpeakMenu(true);
    }, 500);
  };
  /** brief is not reachable by clicking: a click always means 「开/关」, so from brief it turns
   *  reading OFF rather than silently downgrading to reply (that would be changing a mode the
   *  operator asked for without asking). */
  const speakClick = (): void => {
    if (speakPress.current.fired) { speakPress.current.fired = false; return; }
    setMode(mode === "off" ? "reply" : "off");
  };
  // The menu, as data: one flat list, each row carrying the mode AND the beat it means. Flat on
  // purpose (the operator's words): 「长按的时候就有多个可选项，工作播报（每分钟）、（每 2 分钟）…」
  // — a nested 「模式 → 节拍」 would be two clicks for one decision.
  const SPEAK_ITEMS: { key: string; mode: "off" | "reply" | "brief"; interval: number | null; label: string }[] = [
    { key: "off", mode: "off", interval: null, label: "关" },
    { key: "reply", mode: "reply", interval: null, label: "自动朗读（点一下就是这个 · 默认）" },
    { key: "brief", mode: "brief", interval: 0, label: "工作播报（有进展就说一句）" },
    { key: "brief-60", mode: "brief", interval: 60, label: "工作播报（每 1 分钟也报一次）" },
    { key: "brief-120", mode: "brief", interval: 120, label: "工作播报（每 2 分钟也报一次）" },
    { key: "brief-300", mode: "brief", interval: 300, label: "工作播报（每 5 分钟也报一次）" },
  ];
  const isItemOn = (it: (typeof SPEAK_ITEMS)[number]): boolean =>
    it.mode === mode && (it.mode !== "brief" || it.interval === intervalSec);
  /** 节拍是自定义值（菜单里没有这一档）：它仍然是在用的那个 —— ✓ 落到「自定义」那一行，
   *  否则菜单会出现「一个都没选」的假象。 */
  const customOn = mode === "brief" && !SPEAK_ITEMS.some((it) => it.mode === "brief" && it.interval === intervalSec);
  const speakLabel =
    mode === "off"
      ? "关"
      : mode === "reply"
        ? "自动朗读（念整条回复）"
        : intervalSec > 0
          ? `工作播报 · 每 ${intervalLabel(intervalSec)}`
          : "工作播报（念驾驶舱的一句话）";
  const autoReadTitle = !canSpeak
    ? "朗读：这台设备没有可用语音（浏览器无 speechSynthesis，服务端也没配）"
    : `朗读：${speakLabel} —— 点一下开/关，长按选档（右键同）`;
  // The head keeps identity and session controls: where this slot works, the panel that
  // shows it, and the two ways of TALKING to it (call, auto-read) — the operator's call
  // list. Mode, thinking depth and context stay in the composer, where the prompt is
  // written: a header is a place for identity, not for settings.
  return (
    <div className="chat-head">
      <button className="icon-btn menu-btn" onClick={onMenu} title="sessions" aria-label="sessions"><IconMenu /></button>
      <span className="title" title={info.title}>{info.title}</span>
      <TurnPulse busy={busyNow(v)} lastAt={v.lastAt} />
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
        <span className="speak-wrap" ref={speakRef}>
          <button
            className={`icon-btn auto-read ${mode !== "off" ? "on" : ""}`}
            title={autoReadTitle}
            aria-label="朗读：点一下开/关，长按选读什么"
            aria-pressed={mode !== "off"}
            aria-haspopup="menu"
            aria-expanded={speakMenu}
            data-speak-mode={mode}
            disabled={!canSpeak}
            onClick={speakClick}
            onPointerDown={speakPressStart}
            onPointerUp={speakPressClear}
            onPointerLeave={speakPressClear}
            onPointerCancel={speakPressClear}
            onContextMenu={(e) => { e.preventDefault(); speakPressClear(); setSpeakMenu(true); }}
            onKeyDown={(e) => {
              // A keyboard has no long press. Shift+F10 and the ContextMenu key are what every
              // desktop OS uses to ask for "the menu for this thing", so the menu stays reachable
              // without spending a permanent caret next to the button.
              if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
                e.preventDefault();
                setSpeakMenu(true);
              }
            }}
          >
            {mode === "off" ? <IconVolumeOff /> : <IconVolume />}
            {mode === "brief" ? <span className="speak-dot" aria-hidden /> : null}
          </button>
          {speakMenu ? (
            <div className="speak-menu" role="menu">
              {SPEAK_ITEMS.map((it) => (
                <button
                  key={it.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isItemOn(it)}
                  className={`speak-menu-item ${isItemOn(it) ? "on" : ""}`}
                  data-speak-option={it.key}
                  onClick={() => setMode(it.mode, it.interval ?? undefined)}
                >
                  <span className="speak-check">{isItemOn(it) ? "✓" : ""}</span>
                  <span className="speak-name">{it.label}</span>
                </button>
              ))}
              <button
                type="button"
                role="menuitem"
                aria-checked={customOn}
                className={`speak-menu-item ${customOn ? "on" : ""}`}
                data-speak-option="custom"
                onClick={() => {
                  setSpeakMenu(false);
                  // The numeric box lives in 设置 → 观察智能体; opening it from here is the shortest
                  // path to 「自定义」 without teaching a second place to type a number.
                  window.dispatchEvent(new CustomEvent("agentus:open-settings", { detail: "voice" }));
                }}
              >
                <span className="speak-check">{customOn ? "✓" : ""}</span>
                <span className="speak-name">
                  {customOn ? `自定义节拍（现在 · 每 ${intervalLabel(intervalSec)}）` : "自定义节拍…"}
                </span>
              </button>
              <p className="speak-hint">
                {mode === "brief"
                  ? intervalSec > 0
                    ? `有任务在跑时每 ${intervalLabel(intervalSec)} 念一句；没任务在跑不念。观察员在 设置 → 观察智能体`
                    : "回合结束、待审批时由一个观察智能体念一句（设置 → 观察智能体）"
                  : mode === "reply"
                    ? "每条回复结束后念全文 —— 长回复会被截断"
                    : "不自动出声；点消息旁的喇叭可以按需念"}
              </p>
            </div>
          ) : null}
        </span>
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
        {fmtTokens(usage.used)}{usage.size > 0 ? `/${fmtTokens(usage.size)}` : ""}
      </span>
    </span>
  );
}

/** Imperative "follow the stream again" hook, so the composer can re-attach the
 *  view when the operator sends. Module-level on purpose: the two components have
 *  no shared parent state and threading a ref through the tree for this would be
 *  more code than the behaviour is worth. */
const streamReattach: { current: () => void } = { current: () => {} };

/** How many pages the AUTOMATIC path may pull in a row before it stops and leaves the button for
 *  the reader. A slot with hundreds of messages must not load its whole history in the background
 *  (this was the ceiling of the fill-an-empty-screen rule; it now also bounds the scroll-driven
 *  pulls, which is what keeps a fast scroll from queueing a dozen requests). */
const AUTO_PAGE_MAX = 4;

/** A turn in flight, at ZERO vertical cost.
 *
 *  This is what replaced the two text lines at the transcript tail (`▸ turn in progress…`, then
 *  `⏳ still waiting for the agent…`) — the operator's verdict was 「删掉吧，太占地方了吧，没必要啊，
 *  下面的按钮显示终止态其实就能看出来在运行」. See `turn-state.ts` for what the dot says and why the
 *  decision is a pure function: the clock ticks inside THIS component (props: the flag and the
 *  last-activity stamp), so ticking it can never drag the transcript into a re-render. */
const TurnPulse = memo(function TurnPulse({ busy, lastAt }: { busy: boolean; lastAt: number }): JSX.Element | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const t = window.setInterval(() => tick((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, [busy]);
  if (!busy) return null;
  const { quiet, said } = turnPulseState(lastAt, Date.now());
  return <span className={`turn-pulse ${quiet ? "quiet" : ""}`} role="status" aria-label={said} title={said} />;
});

/** The turn's progress line, at the transcript tail — the position the operator picked, in the shape
 *  both references share (studio's `LiveReasoningStatus.vue`, AionUi's `ThoughtDisplay.tsx`): a
 *  spinner, one word, and the elapsed time. It is the ONE number we had nowhere, and it counts from
 *  the SEND (`busySince`, stamped on `turn-start`) so it answers 「我等了多久」 rather than 「模型说了
 *  多久」.
 *
 *  The clock lives in HERE, for the reason the deleted `Busy` also owned its own: a ticking second
 *  must not drag the transcript's rows into a re-render. */
const TurnLine = memo(function TurnLine({ busy, since }: { busy: boolean; since: number | null }): JSX.Element | null {
  // Re-stamped on every (busy, since) change, so a SECOND message sent into a running turn restarts
  // the clock — the operator asked for the count from the send. A page that loaded MID-turn has no
  // `turn-start` for this turn: it anchors on first sight, which undercounts instead of inventing a
  // start out of `lastAt` (a stamp every incoming frame resets).
  const [anchor, setAnchor] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!busy) { setAnchor(null); return; }
    setAnchor(since ?? Date.now());
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [busy, since]);
  if (!busy) return null;
  const startedAt = anchor ?? since;
  return (
    <div className="stream-hint" role="status" data-anchor={startedAt ?? undefined}>
      <span className="stream-spin" aria-hidden="true" />
      <span>处理中</span>
      {startedAt != null ? <span className="elapsed">({durationWords(now - startedAt)})</span> : null}
      {/* The agent's status lines are NOT here any more (operator, 2026-10-18): 「它不只是这一个状态，
          压缩什么的也会显示，所以应该放在会话记录框里面」. They are transcript rows now — see
          StatusNoteRow. This line is only the clock: 「我现在等了多久」. */}
    </div>
  );
});

/** Background work that outlived its turn (issue #22) — the ACP twin of the desktop's status stack.
 *
 *  WHY IT IS NEEDED. A turn ends when the AGENT stops talking, not when its work does: `npm run build`
 *  started with `background=true` keeps running while the session reads `ready`. Every other surface
 *  (desktop, CLI) shows that; the cockpit showed nothing, so 「会话看起来结束了、实际没结束」 was a
 *  trust hole with no way to notice it.
 *
 *  THREE RULES FROM THE DESIGN. (1) It lives above the composer, not in the transcript: this is state,
 *  and a stored row would hang a dead process under a conversation from last month. (2) It appears only
 *  once the turn is over — during a turn the tail line is already the status. (3) A row is running or
 *  exited-with-a-code, and an exit shows exactly once: the agent reports it when it has no
 *  `notify_on_complete`, and it is the only witness that the process ever ended.
 */
// NOT `memo`: the store MUTATES the SessionView in place (one object per session, same reference), so a
// memoised component never re-renders when a snapshot frame changes `background` — measured: the rail
// badge lit up while this row stayed invisible forever.
function BackgroundRow({ v }: { v: SessionView }): JSX.Element | null {
  const tasks = v.background ?? [];
  const [open, setOpen] = useState(false);
  // Shown whenever the agent has background work — during a turn too. Hiding it while busy made the row
  // flash out of existence exactly when a completion wakes a new turn (measured: it was never visible for
  // a full second), and the operator's question 「这个会话还在干活吗」 does not pause while the agent talks.
  if (!tasks.length) return null;
  const running = tasks.filter((t) => t.status === "running");
  const exited = tasks.filter((t) => t.status !== "running");
  // #39: a subagent is not a process — it has no pid and no command line, it has a GOAL. Counted
  // separately so the head line can say 「其中 2 个子任务」 instead of pretending they are shell jobs.
  const subs = running.reduce((n, t) => n + (t.kind === "delegation" ? (t.taskCount ?? 1) : 0), 0);
  // Every row that survives the server's filter is a WAKE-UP process (#35): the agent is not done,
  // it is waiting for this result to continue. Said in words because a number alone reads like
  // 「有个后台程序在跑，跟我没关系」.
  const head = running.length
    ? `后台任务 ${running.length} 个运行中${subs ? `（含 ${subs} 个子任务）` : ""} · 完成后会唤醒会话`
    : `${exited.length} 个后台任务已结束`;
  return (
    <div className={`bg-row ${open ? "open" : ""}`} data-count={tasks.length}>
      <button type="button" className="bg-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span
          className="bg-dot"
          aria-hidden="true"
          data-state={running.length ? "running" : "exited"}
          data-wake={running.length ? "1" : undefined}
        />
        <span className="bg-text">{head}</span>
        {/* The turn is over, so nothing else on screen says work continues — this hint is the whole
            reason the row exists. */}
        {/* Only when the turn is over: during a turn the tail line already says the agent is working, and
            the point of this sentence is that the conversation looks finished while the work does not. */}
        {running.length && !v.busy ? <span className="bg-hint">会话已空闲，后台仍在跑</span> : null}
        <span className="bg-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <ul className="bg-list">
          {tasks.map((t) => (
            <li key={t.id} className="bg-item" data-state={t.status} data-kind={t.kind ?? "process"}>
              {t.kind === "delegation" ? <span className="bg-tag">子任务</span> : null}
              {/* Wrapped, not ellipsised. The command IS what the operator opens this row to read
                  (「它到底在跑什么、带什么参数」); a single truncated line answered a different question.
                  The agent caps the string it sends (200 chars until #23), so a very long pipeline can
                  still arrive short — that is a producer limit, not this row's. For a delegation the
                  same slot holds the GOAL: there is no command line, only what the child was told to do. */}
              <pre className="bg-cmd-full">{t.command || t.id}</pre>
              <div className="bg-item-foot">
                <span className="bg-meta">
                  {t.kind === "delegation" ? (
                    <>
                      {(t.taskCount ?? 1) > 1 ? `${t.taskCount} 个子代理 · ` : ""}
                      {t.status === "running"
                        ? `运行 ${durationWords((t.uptimeSeconds ?? 0) * 1000)}${t.phase === "stalling" ? " · 停滞中" : t.phase === "finalizing" ? " · 收尾中" : ""}`
                        : "已结束"}
                    </>
                  ) : (
                    <>
                      {t.pid ? `pid ${t.pid} · ` : ""}
                      {t.status === "running"
                        ? `运行 ${durationWords((t.uptimeSeconds ?? 0) * 1000)}`
                        : `exit ${t.exitCode ?? "?"}`}
                    </>
                  )}
                </span>
                {t.command ? <CopyButton text={t.command} what={t.kind === "delegation" ? "这个目标" : "这条命令"} /> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 一条状态记录：agent 或它所在的运行时关于「正在干什么」的公告 —— 回忆了几条记忆、上下文压缩了、
 *  在等 provider。「处理中」那行只回答「等了多久」，这些行回答「它到底在忙什么」。
 *
 *  为什么是会话记录里的一行而不是尾巴上的一句话（操作者 2026-10-18）：尾巴只有一个位置，新的一句
 *  会把上一句顶掉，于是「压缩开始」永远看不到「压缩完成」；而且同一时刻只能显示一条，回忆与压缩
 *  同时发生时就丢了一条。做成行以后按时间往下排，滚动自然往上走，滚上去就是历史。
 *
 *  它「不是消息」这件事仍然成立：不能导出成 markdown，也不是谁说过的话 —— 所以它在库里是单独一种
 *  `kind`（`note`），渲染成这行而不是气泡。**但它是落库的**（同一个 2026-10-18 的第二个决定）：
 *  「回忆了几条记忆」「上下文压缩过」「有警告」事后还有意义，刷新一次就消失是丢信息。真正的呼吸声
 *  （provider 倒计时、租约闲聊）不落库，仍然只活在 state.ts 的 `notes` 里，随回合结束消失。 */
function StatusNoteRow({ n }: {
  n: Pick<StatusNote, "key" | "kind" | "text" | "at"> & { hits?: number; items?: StatusNoteItem[]; truncated?: boolean };
}): JSX.Element {
  const clock = new Date(n.at);
  const hh = `${String(clock.getHours()).padStart(2, "0")}:${String(clock.getMinutes()).padStart(2, "0")}:${String(clock.getSeconds()).padStart(2, "0")}`;
  // 「recalled 8 memories」只说记忆被用上了，没说用上的是哪几条 —— 展开就是这行唯一缺的那半句话
  // （issue #37）。没有条目的行（压缩、警告、别家 agent 的状态行）保持原来那一行，一个像素都不变。
  const items = n.items ?? [];
  const [open, setOpen] = useState(false);
  return (
    <div className="status-note" data-kind={n.kind || "lifecycle"} role="note" title={clock.toLocaleString()}>
      <span className="status-note-time">{hh}</span>
      <span className="status-note-text">{n.text}</span>
      {items.length ? (
        <>
          <button
            type="button"
            className="status-note-toggle"
            aria-expanded={open}
            aria-label={`${open ? "收起" : "展开"}这 ${items.length} 条记忆`}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "收起" : `${items.length} 条`}
          </button>
          {open ? (
            <ol className="status-note-items">
              {items.map((it, i) => (
                <li key={i} className="status-note-item">
                  <span className="status-note-item-text">{it.text}</span>
                  {it.tags?.length ? <span className="status-note-item-tags">{it.tags.join(" · ")}</span> : null}
                </li>
              ))}
              {n.truncated ? <li className="status-note-item more">…还有更多，已截断</li> : null}
            </ol>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** THE TRANSCRIPT ROWS — one implementation, two surfaces.
 *
 *  The chat page renders it inside its `.stream-inner`; the call's captions view renders the very
 *  same component inside its frosted panel. That is the operator's requirement in their own words
 *  (「就用我们现在的这个聊天页面……UI 不要变」): the agent's mark and name, YOU, collapsible
 *  thinking, tool cards, plan cards, streaming markdown — the call must not grow a second, simplified
 *  transcript that drifts away from the one they read every day.
 *
 *  `App` passes this function down to `CallMode` as a prop instead of `CallMode` importing it, so
 *  the two modules do not import each other. */
function TranscriptRows({ msgs, sid, backend, busy, base, notes = [] }: {
  msgs: MsgView[]; sid: string; backend: string; busy: boolean; base: string; notes?: StatusNote[];
}): JSX.Element {
  // 状态行按「它来的时候最新那条消息是谁」插回去（`afterKey`），而不是一律堆在末尾 —— 回忆发生在
  // 回复之前、压缩发生在回合中间，堆在末尾等于把时间顺序讲错。锚点消息不在本页（翻页翻掉了、或
  // 还在后面的页里）时退到末尾：宁可位置不精确，也不能让一行状态凭空消失。
  const rows = foldWork(msgs);
  const out: JSX.Element[] = [];
  let n = 0;
  // #38 文件变更：挂在**那次工具执行**旁边，不再攒到回合末尾（操作者 2026-10-21）。
  // 原先的回合级 flush 有个真实的读法错误：一轮里改了 5 个文件、之后又跑了 20 分钟命令，
  // 那块「N 个文件变更」落在回合尾巴，离改动已经隔了一屏工具卡，看的人以为最后那条命令改的。
  // 现在每一段折叠（WorkRun）后紧跟它自己那几次调用改出的文件，位置就是执行的位置。
  while (n < notes.length && notes[n].afterKey === null) {
    out.push(<StatusNoteRow key={notes[n].key} n={notes[n]} />);
    n++;
  }
  for (const row of rows) {
    if (row.kind === "work") {
      out.push(<WorkRun key={row.key} items={row.items} />);
      out.push(<FileChangesPanel key={`fc-${row.key}`} msgs={row.items} />);
    } else if (row.m.kind === "note") {
      // 落库的状态行：它本来就是一条消息行（kind `note`），位置由 seq 定，所以直接画在这一行上，
      // 不需要 `afterKey` 锚点那套（那套是给内存里、没有 seq 的临时状态行用的）。
      out.push(
        <StatusNoteRow
          key={row.m.key}
          n={{
            key: row.m.key, kind: row.m.category, text: row.m.text, at: row.m.at ?? Date.now(),
            hits: row.m.hits, items: row.m.items, truncated: row.m.truncated,
          }}
        />,
      );
    } else {
      out.push(<Bubble key={row.m.key} m={row.m} sid={sid} backend={backend} busy={busy} last={row.tail} live={row.live} base={base} />);
      // 不折叠的单条工具消息（夹在气泡之间、够不上一段）也把它的文件变更挂在自己下面。
      if (row.m.kind === "tool") out.push(<FileChangesPanel key={`fc-${row.m.key}`} msgs={[row.m]} />);
    }
    const keys = new Set<string>(row.kind === "msg" ? [row.m.key] : row.items.map((i) => i.key));
    for (let cand = notes[n]; cand && cand.afterKey !== null && keys.has(cand.afterKey); cand = notes[n]) {
      out.push(<StatusNoteRow key={cand.key} n={cand} />);
      n++;
    }
  }
  while (n < notes.length) {
    out.push(<StatusNoteRow key={notes[n].key} n={notes[n]} />);
    n++;
  }
  return <>{out}</>;
}

function Stream({ v }: { v: SessionView }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const keepUntil = useRef(0);
  const intentAt = useRef(-1e9);   // the last time the READER's hand touched this scroller
  const progUntil = useRef(0);     // the last time WE wrote scrollTop (short window, see below)
  const lastTop = useRef(0);
  const lastSH = useRef(0);
  const [follow, setFollow] = useState(true);
  const [unseen, setUnseen] = useState(false);

  // ---- leaving is DIRECTION, returning is a small number ----------------------
  // What this replaces, measured 2026-10-13 (track §99): ONE threshold (140px) decided both
  // questions, so a gesture that left the reader within 140px of the tail was re-armed by the very
  // next scroll event (`stick = isNear()`) — the wheel/touch detach was overwritten by POSITION —
  // and the next streamed chunk (≈10 writes/s of `scrollTop = scrollHeight`) dragged the viewport
  // back. Net effect of a 400px drag away from the tail: 0px, and the same quick flick escaped on
  // one run and not the next ("it feels unreliable" is literally that race). Now a move toward older
  // content detaches (studio: `delta < -1`), and returning needs the tail itself.
  const TAIL_PX = 64;
  const now = (): number => performance.now();
  const isAtTail = (el: HTMLDivElement): boolean => el.scrollHeight - el.scrollTop - el.clientHeight <= TAIL_PX;
  /** How long after a real input event a content move still counts as the reader's doing. */
  const INTENT_MS = 1200;

  const markWrote = (el: HTMLDivElement): void => {
    progUntil.current = now() + 150;
    lastTop.current = el.scrollTop;
    lastSH.current = el.scrollHeight;
  };

  const scrollNow = (): void => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    markWrote(el); // our own write must not count as "the reader scrolled away"
  };

  /** The reader has taken over: stop following, and let that beat the post-send keep-alive.
   *  (studio's keep-alive re-checks `userDetachedFromBottom` before scrolling; ours used to test
   *  `keepUntil` first and unconditionally, so for 1.5s after a send — exactly when the first
   *  output arrives — every gesture was ignored: a measured 500px swipe moved 0px.) */
  const detach = (): void => {
    stick.current = false;
    keepUntil.current = 0;
    setFollow(false);
  };

  streamReattach.current = () => {
    stick.current = true;
    keepUntil.current = now() + 1200; // keep following briefly after a send
    setFollow(true);
    setUnseen(false);
    scrollNow();
  };

  // ---- user intent beats scroll position -------------------------------------
  // Position alone is not enough: while a turn streams, the newest chunk is added
  // right under the viewport, so a wheel/touch/key gesture has to detach *now*.
  // And once detached, POSITION must not re-arm it — that is the bug this file
  // carried until §99 (see the constants above): the reader's gesture was undone by
  // the next scroll event while the tail was still within one threshold.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const intent = (): void => { intentAt.current = now(); };
    const onScroll = (): void => {
      const top = el.scrollTop;
      const delta = top - lastTop.current;
      lastTop.current = top;
      const sh = el.scrollHeight;
      // Content that got SHORTER clamps scrollTop down and fires a scroll event that reads as
      // "moved up" with no reader behind it (hermes-webui's measured class) — never treat that as
      // intent, or live-follow silently dies mid-stream.
      const shrank = sh < lastSH.current - 1;
      lastSH.current = sh;
      // Direction decides. Our own writes only ever move scrollTop DOWN (toward the tail), so a
      // move UP within the reader's input window is the reader, whatever produced it (wheel,
      // touch, keyboard, a scrollbar drag — all of which stamp `intentAt`).
      if (delta < -2 && !shrank && now() - intentAt.current < INTENT_MS) { detach(); return; }
      if (now() < progUntil.current) return; // our own write: it says nothing about the reader
      const near = isAtTail(el);
      if (near !== stick.current) { stick.current = near; setFollow(near); }
      if (near) setUnseen(false);
    };
    const onWheel = (e: WheelEvent): void => { intent(); if (e.deltaY < 0) detach(); };
    let touchY = 0;
    const onTouchStart = (e: TouchEvent): void => { intent(); touchY = e.touches[0]?.clientY ?? 0; };
    // dragging the finger DOWN scrolls back toward older content => detach
    const onTouchMove = (e: TouchEvent): void => {
      intent();
      const y = e.touches[0]?.clientY ?? 0;
      if (y > touchY + 4) detach();
    };
    const onKey = (e: KeyboardEvent): void => {
      intent(); // Space / PageDown scroll too, and the scroll event alone is not enough evidence
      if (e.key === "PageUp" || e.key === "ArrowUp" || e.key === "Home") detach();
    };
    // A scrollbar drag arrives as pointerdown + scroll deltas, with no wheel/touch event at all.
    const onPointerDown = (): void => intent();
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("keydown", onKey);
    el.addEventListener("pointerdown", onPointerDown, { passive: true });
    markWrote(el); // start from the real geometry instead of a stale 0
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("pointerdown", onPointerDown);
    };
  }, []);

  // Follow only while following: no scroll is forced on a reader who scrolled away.
  useEffect(() => {
    if (stick.current || now() < keepUntil.current) {
      scrollNow();
      return;
    }
    if (v.msgs.length) setUnseen(true); // output arrived off-screen: say so on the button
    // v.rev, not v.msgs: chunks merge into the bubble above, so the array identity is
    // stable and this effect would never run on new output.
  }, [v.rev, v.busy, v.perms.length]);

  // The same follow, driven by GEOMETRY rather than by data events: late layout (an image, syntax
  // highlighting, a markdown re-parse, a row folding) changes scrollHeight without any `v.rev`, and
  // that used to leave the viewport a few pixels short of the tail with nothing to fix it. studio
  // does exactly this with its ResizeObserver.
  useEffect(() => {
    const el = ref.current;
    const inner = (el?.firstElementChild as HTMLElement | null) ?? null;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (!stick.current && now() >= keepUntil.current) return;
      requestAnimationFrame(() => {
        if (stick.current || now() < keepUntil.current) scrollNow();
      });
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [v.info.id]);

  // Keep the reader's place when an older page is prepended (paging used to shove
  // the viewport by a whole page, so "load earlier" felt like a jump to nowhere).
  //
  // `fromScroll` marks the AUTOMATIC path: it must not touch the follow state, because it only
  // fires once the reader has already left the tail — clearing `stick` there would mean a reader
  // who scrolled up and then came back down stayed detached for good. The prepend anchoring below
  // runs on BOTH paths (markWrote stamps `progUntil`, so the scroll this write raises can never be
  // mistaken for the reader's gesture by the contract effect above).
  const pageOlder = async (fromScroll: boolean): Promise<void> => {
    const el = ref.current;
    const beforeH = el?.scrollHeight ?? 0;
    const beforeT = el?.scrollTop ?? 0;
    if (!fromScroll) {
      stick.current = false;
      setFollow(false);
    }
    setPagedOnce(true);
    await cockpit.loadEarlier(v.info.id);
    requestAnimationFrame(() => {
      const after = ref.current;
      if (!after) return;
      after.scrollTop = after.scrollHeight - beforeH + beforeT;
      markWrote(after);
    });
  };
  const loadEarlier = (): void => { void pageOlder(false); };

  /** A failed STARTUP, retried. The row never got an agent (that is exactly why it failed), so
   *  `resume` has nothing to attach to — the only honest retry is a new row with the same backend
   *  and cwd, carrying over whatever was waiting in the queue (the first message, normally). */
  const retryStart = async (view: SessionView): Promise<void> => {
    const pending = [...view.queue];
    try {
      const id = await cockpit.createSession(String(view.info.backend), view.info.cwd, "");
      cockpit.setActive(id);
      for (const q of pending) cockpit.enqueuePrompt(id, q.text, q.attachments);
      cockpit.purgeCold(view.info.id);
    } catch {
      /* the failed row stays where it is, and so does its queue */
    }
  };

  // The transcript is FOLDED now (a turn's tool calls are one row, finished thinking is one
  // line), so one page of history can fit on a screen with more still on disk — and a
  // "load earlier messages" button with empty space under it is the one thing the operator
  // cannot read anything into. Keep pulling pages while there is room. Bounded: a slot with
  // hundreds of messages must not load forever in the background.
  const autoPages = useRef(0);
  const [pagedOnce, setPagedOnce] = useState(false);   // has this view ever paged backwards?
  useEffect(() => { autoPages.current = 0; setPagedOnce(false); }, [v.info.id]);
  useEffect(() => {
    const el = ref.current;
    if (!el || !v.hasOlder || v.loadingOlder || autoPages.current >= AUTO_PAGE_MAX) return;
    if (el.scrollHeight > el.clientHeight + 80) return;
    autoPages.current += 1;
    void pageOlder(true);
  }, [v.rev, v.hasOlder, v.loadingOlder, v.info.id]);

  // Sliding up to the top pages backwards by itself (the operator's ask: 去掉那个手动点击). The
  // trigger is one and a half screens from the top rather than the exact top, so the next page is
  // already in place by the time the reader gets there — the browser's own infinite-scroll feel.
  // Anchoring lives in `pageOlder`, so a page landing mid-gesture does not move the text under the
  // reader's eye. Own effect (not folded into the contract effect above) because this one has to
  // re-read `v.hasOlder` / `v.loadingOlder`; the contract effect is deliberately mount-once.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = (): void => {
      if (!v.hasOlder || v.loadingOlder || autoPages.current >= AUTO_PAGE_MAX) return;
      if (el.scrollTop > el.clientHeight * 1.5) return;
      autoPages.current += 1;
      void pageOlder(true);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [v.info.id, v.hasOlder, v.loadingOlder]);

  // The transcript tail no longer carries a turn hint (operator: 「太占地方了」) — the turn's state
  // lives in the chat head (`TurnPulse`) and in the rail row, both of which cost no row here.
  return (
    <div className="stream-wrap">
      <div className="stream" ref={ref} tabIndex={0}>
        <div className="stream-inner">
          {/* A session that is still COMING UP (created a moment ago, or woken from cold) has a row
              and no agent yet. Say so here, where its first message will appear, instead of leaving
              an empty transcript that reads as "it ate my message". */}
          {v.info.status === "starting" ? (
            <div className="start-hold" role="status">
              <span className="stream-spin" aria-hidden="true" />
              <span>正在启动 agent 进程…好了会自动把消息发出去</span>
            </div>
          ) : null}
          {/* …and the other end of it: the handshake failed. The reason is the server's own
              `lastError` (the error plus the agent's stderr tail), delivered in the session rather
              than in an HTTP call that has long since answered. */}
          {v.info.status === "error" && v.info.lastError ? (
            <div className="start-fail" role="alert">
              <div className="start-fail-why">会话启动失败：{v.info.lastError}</div>
              <div className="start-fail-act">
                <button className="ghost-btn" onClick={() => void retryStart(v)}>再试一次</button>
                <button className="ghost-btn" onClick={() => cockpit.purgeCold(v.info.id)}>删除这个会话</button>
              </div>
            </div>
          ) : null}
          {/* The paging affordance: while there is more it is the button (and, once a pull is in
              flight, a quiet "loading…" in its place so the top of the transcript is never a blank
              band that the reader reads as the beginning). When the history is exhausted it says so
              — but only if this view actually paged, so a one-page session does not carry a label
              announcing that nothing happened. */}
          {v.hasOlder ? (
            <div className="load-earlier">
              {v.loadingOlder ? (
                <span className="load-earlier-busy">正在加载更早的消息…</span>
              ) : (
                <button className="ghost-btn" onClick={() => loadEarlier()}>↑ load earlier messages</button>
              )}
            </div>
          ) : pagedOnce && v.msgs.length ? (
            <div className="load-earlier"><span className="load-earlier-end">已到开头</span></div>
          ) : null}
          <TranscriptRows msgs={v.msgs} notes={v.notes} sid={v.info.id} backend={v.info.backend} busy={busyNow(v)} base={v.info.workspace || v.info.cwd} />
          <TurnLine busy={busyNow(v)} since={v.busySince} />
          {/* A request belongs NEXT TO the turn that is waiting on it — at the tail, where the
              eye already is. Rendering it above the whole transcript (the old place) put it
              thousands of pixels out of sight in any conversation longer than a screen: the
              operator saw nothing while the agent sat blocked, and Hermes self-denied after
              its own `approvals.timeout`. Measured: rect.top = -7365px on a 20-message
              transcript, -10600px at 390×844. */}
          {/* 审批卡不在末尾另画一遍：请求落地时就已经写进转录（kind=approval），
              末尾再补一张等于同一个请求在屏幕上出现两次。这里只补「有 perms 但没有对应行」
              的兜底（升级前就挂着的旧请求，或者落库失败），免得那种请求变成看不见的死锁。 */}
          {v.perms.filter((p) => !v.msgs.some((m) => m.kind === "approval" && m.requestId === p.requestId))
            .map((p) => <PermCard key={p.requestId} sid={v.info.id} req={p} />)}
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
// ---- the memo boundaries -------------------------------------------------------------------------
// The stream re-renders the WHOLE row list on every published frame (the store hands out one snapshot
// for the session; the row components are not told which row changed). That is fine only if an
// unchanged row costs nothing to re-render — which is what these wrappers buy: 380 rows of a heavy
// transcript render ONCE instead of once per frame while a turn streams.
//
// 🔴 Identity is NOT a valid "nothing changed" test here. The store updates a row IN PLACE
// (`m.open = false` at turn-end, `existing.status = …` when a tool call settles, `#ingest` re-lighting
// `open`), so a row can change while its object reference stays the same. A memo that short-circuits
// on `a.m === b.m` therefore FREEZES the row on whatever it looked like first — measured 2026-10-08:
// the thinking window's `live` prop flipped true→false at turn-end (the data was correct) but the
// comparator returned "equal" on identity, the row never re-rendered, and the 「思考中…」 window stayed
// on screen until a reload rebuilt every row. Compare the fields the component actually reads.
const MemoThought = memo(Thought, (a, b) =>
  a.live === b.live && a.m.key === b.m.key && a.m.text === b.m.text && a.m.at === b.m.at);
const sameTool = (a: { m: MsgView }, b: { m: MsgView }) => {
  const x = a.m as Extract<MsgView, { kind: "tool" }>;
  const y = b.m as Extract<MsgView, { kind: "tool" }>;
  return x.key === y.key && x.title === y.title && x.status === y.status
    && x.detail === y.detail && x.input === y.input && x.at === y.at;
};
const MemoToolCard = memo(ToolCard, sameTool);
const samePlan = (a: { m: MsgView; busy: boolean }, b: { m: MsgView; busy: boolean }) => {
  const x = a.m as Extract<MsgView, { kind: "plan" }>;
  const y = b.m as Extract<MsgView, { kind: "plan" }>;
  return a.busy === b.busy && x.key === y.key && x.at === y.at
    && x.terminal === y.terminal && x.explanation === y.explanation
    && JSON.stringify(x.items) === JSON.stringify(y.items);
};
const MemoPlanCard = memo(PlanCard, samePlan);

/**
 * A background-completion notice, folded.
 *
 * The agent wakes itself by sending that notice as a PROMPT (ACP has no server→agent channel), so the
 * row is a machine-written nine-line block: header, `Command:`, `Output:`, then the shell's own
 * startup noise. Raw, it reads like a stack trace in the middle of the conversation. Folded, the one
 * thing the operator needs — 「跑完了，成功，跑了什么」 — is a single line; the output is one click away,
 * and the copy button still yields the original text verbatim (the roster keeps it untouched).
 */
function BgNoticeBlock({ text }: { text: string }): JSX.Element {
  const notice = parseBgNotice(text);
  const [open, setOpen] = useState(false);
  // Not a completion notice (an operator pasting one, a future format): render what we were given.
  if (!notice) return <>{text}</>;
  return (
    <div className={`bg-notice ${open ? "open" : ""}`} data-ok={notice.ok ? "ok" : "fail"}>
      <button type="button" className="bg-notice-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="bg-notice-dot" aria-hidden="true" />
        <span className="bg-notice-title">后台任务完成</span>
        <code className="bg-notice-cmd" title={notice.command}>{shortCommand(notice.command)}</code>
        <span className="bg-notice-code">exit {notice.exitCode}</span>
        <span className="bg-notice-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="bg-notice-body">
          <div className="bg-notice-label">命令</div>
          <pre className="bg-notice-pre">{notice.command || "(未报告)"}</pre>
          <div className="bg-notice-label">输出{notice.output ? "" : "（空）"}</div>
          {notice.output ? <pre className="bg-notice-pre">{notice.output}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}

function Bubble({ m, sid, backend, last, busy, live, base }: { m: MsgView; sid: string; backend: string; last: boolean; busy: boolean; live?: boolean; base?: string }): JSX.Element | null {
  switch (m.kind) {
    case "user":
      return (
        <div className={`msg user${m.from ? " from-agent" : ""}`}>
          {/* «YOU» is only true when the operator typed it. A cross-session message is a turn
              boundary too, but presenting another agent's words as the operator's own is exactly the
              kind of quiet lie this cockpit must not tell. */}
          <div className="role" title={m.from ? `会话 ${m.from.id}` : undefined}>
            {m.from ? `来自「${m.from.title}」` : "YOU"}
          </div>
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
            {m.from ? <BgNoticeBlock text={m.text} /> : m.text}
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
          <div className="role with-mark">
            <AgentMark backend={backend} />
            {markOf(backend).label || "AGENT"}
          </div>
          <div className="bubble">
            <Markdown text={m.text} base={base} />
            <div className="bubble-actions">
              {m.at ? <span className="msg-at" title={stamp(m.at)}>{messageTime(m.at)}</span> : null}
              <CopyButton text={m.text} what="这条回复" />
              <SpeakButton id={m.key} text={m.text} sid={sid} />
              {last && !busy ? <ForkHere sid={sid} busy={busy} /> : null}
            </div>
            {/* inside the bubble, under the action row: 「它念了什么」 belongs to this message */}
            <SummaryNote mkey={m.key} />
          </div>
        </div>
      );
    case "thought":
      // An empty thought is not drawn (and the server no longer stores one): it is the shape an
      // unreadable status carrier takes, and a 「思考 0 字」 row reads as a bug to the operator rather
      // than as the nothing it is.
      return m.text.trim() ? <MemoThought m={m} live={Boolean(live)} /> : null;
    // 审批卡：这条记录在请求到达时就落库了。还挂着 → 原样的按钮（和弹窗打的是同一个调用）；
    // 有结论 → 说话的那张卡；服务端已经不认了（重启/超时）→ 说明它作废了，而不是留一排死按钮。
    case "approval":
      return <ApprovalRow m={m} sid={sid} />;
    case "project-skills":
      return <ProjectSkillsRow m={m} sid={sid} />;
    case "tool":
      return <MemoToolCard m={m} />;
    case "plan":
      return <MemoPlanCard m={m} busy={busy} />;
    case "meta":
      return <div className="msg meta"><div className="bubble">{m.text}</div></div>;
    default:
      return null;
  }
}

/** The LIVE plan, pinned above the composer — above the context strip, exactly where the operator
 *  asked for it: always in sight while typing, instead of buried in the scroll. Collapsed it is ONE
 *  line: title, per-step dots (a filled dot per completed step), count, state. It does NOT move at
 *  turn end; it is retired into the transcript only when a NEW turn produces a new plan (the state
 *  layer splices the old card into its own turn's end). Mirrors Studio's TaskPlanCard semantics. */
function PlanBar({ v }: { v: SessionView }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLOListElement | null>(null);
  const plan = v.plan;
  // Phone only: a step that wraps doubles the card's height and breaks the icon column, so shrink it
  // until it fits (see plan-fit.ts). Runs after layout, when the real width is known.
  useLayoutEffect(() => { if (open) fitPlanSteps(bodyRef.current); }, [open, plan]);
  if (!plan || !plan.items.length) return null;
  const total = plan.items.length;
  const done = plan.items.filter((it) => it.status === "completed").length;
  const allDone = done === total;
  const stateText =
    plan.terminal === "interrupted" ? "已打断"
    : plan.terminal === "failed" ? "运行出错"
    : plan.terminal === "ended" ? "回合结束"
    : allDone ? "已完成"
    : v.busy ? "进行中" : "待命中";
  const stateClass = plan.terminal ? "terminal" : allDone ? "done" : v.busy ? "running" : "";
  return (
    <div className={`plan-bar ${allDone && !plan.terminal ? "completed" : ""}`}>
      <button
        type="button"
        className="plan-head"
        onClick={() => setOpen((x) => !x)}
        aria-expanded={open}
        title="任务计划 · 点击展开/折叠"
      >
        {/* The header stays the LABEL 「任务计划」, always: it answers 「这一块是什么」, and a 40-character
            name shoved in here crowds out the dots, the count and the state (measured — the operator's
            words: 「不能直接把那个标题放这里面，太长了看不了」). The name is the card's FIRST LINE
            instead, one line under this header, where it has the full width and only costs height when
            the card is open. */}
        <span className="plan-title">任务计划</span>
        <span className="plan-dots" aria-hidden="true">
          {plan.items.map((it, i) => (
            <span key={i} className={`dot ${it.status}`} />
          ))}
        </span>
        <span className="plan-count">{done}/{total}</span>
        <span className={`plan-state ${stateClass}`}>{stateText}</span>
        <IconChevronRight size={11} className={`tool-chev ${open ? "open" : ""}`} />
      </button>
      {open ? (
        <ol className="plan-body" ref={bodyRef}>
          {plan.title ? <li className="plan-name" aria-label="计划名">{plan.title}</li> : null}
          {plan.items.map((it, i) => (
            <li key={i} className={`plan-step ${it.status}`}>
              <span className="step-icon" aria-hidden="true">{it.status === "completed" ? "✓" : it.status === "in_progress" ? "◉" : it.status === "cancelled" ? "✕" : "○"}</span>
              <span className="step-title">{it.content}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {/* The plan's own remark, one dim line under the steps (Studio's `plan-explanation`): why
          this update, or what the scope is now. Shown expanded, so the collapsed bar stays one line. */}
      {open && plan.explanation ? <p className="plan-explanation">{plan.explanation}</p> : null}
    </div>
  );
}

/** Task plan card — every ACP `plan` frame is a whole-list snapshot (replace semantics),
 *  so the transcript folds them into this ONE card. Mirrors hermes-studio's TaskPlanCard:
 *  a count header that collapses, three-state step icons, and an execution-state line the
 *  AGENT can never write — the server's turn lifecycle stamps `_slotPlanTerminal` when a
 *  run ends with unfinished steps, and those steps demote back to pending (nothing runs
 *  them anymore). Unknown statuses render neutral rather than as failures. */
function PlanCard({ m, busy }: { m: Extract<MsgView, { kind: "plan" }>; busy: boolean }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLOListElement | null>(null);
  // Same phone-only fit as PlanBar (see plan-fit.ts).
  useLayoutEffect(() => { if (open) fitPlanSteps(bodyRef.current); }, [open, m]);
  const total = m.items.length;
  if (!total) return null;
  const done = m.items.filter((it) => it.status === "completed").length;
  const allDone = done === total;
  const stateText =
    m.terminal === "interrupted" ? "已打断"
    : m.terminal === "failed" ? "运行出错"
    : m.terminal === "ended" ? "回合结束"
    : allDone ? "已完成"
    : busy ? "进行中" : "";
  const stateClass = m.terminal ? "terminal" : allDone ? "done" : busy ? "running" : "";
  return (
    <div className="msg">
      <div className={`plan-card ${allDone && !m.terminal ? "completed" : ""}`}>
        <button type="button" className="plan-head" onClick={() => setOpen((x) => !x)} aria-expanded={open} title="任务计划 · click to collapse/expand">
          <span className="plan-title">任务计划</span>
          <span className="plan-dots" aria-hidden="true">
            {m.items.map((it, i) => (
              <span key={i} className={`dot ${it.status}`} />
            ))}
          </span>
          <span className="plan-count">{done}/{total}</span>
          {stateText ? <span className={`plan-state ${stateClass}`}>{stateText}</span> : null}
          <IconChevronRight size={11} className={`tool-chev ${open ? "open" : ""}`} />
        </button>
        {open ? (
          <ol className="plan-body" ref={bodyRef}>
            {m.title ? <li className="plan-name" aria-label="计划名">{m.title}</li> : null}
            {m.items.map((it, i) => (
              <li key={i} className={`plan-step ${it.status}`}>
                <span className="step-icon" aria-hidden="true">{it.status === "completed" ? "✓" : it.status === "in_progress" ? "◉" : it.status === "cancelled" ? "✕" : "○"}</span>
                <span className="step-title">{it.content}</span>
              </li>
            ))}
          </ol>
        ) : null}
        {/* The plan's own remark, one dim line under the steps (Studio's `plan-explanation`). */}
        {open && m.explanation ? <p className="plan-explanation">{m.explanation}</p> : null}
      </div>
    </div>
  );
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
  const [stuck, setStuck] = useState(true);
  // The window is about six lines, so "at the tail" is a small number here: the transcript's 140px
  // would be most of this box.
  const NEAR_THOUGHT = 24;
  // ---- the reader is in charge of a live window -------------------------------
  // A live window follows its own tail, but position alone cannot decide WHO is following: the
  // newest line lands right under the viewport, so the smallest scroll-up was yanked back by the
  // next chunk. Worse, this window sits INSIDE the transcript, so a gesture that landed here never
  // reached the transcript at all — the reader had to fight this box first, which is exactly the
  // reported 「要滑到很上面才停」. So: a gesture detaches NOW, and a detached window stays put until
  // the reader asks for the tail again.
  useEffect(() => {
    const el = body.current;
    if (!el || !live) return;
    let lastTop = el.scrollTop;
    const atTail = (): boolean => el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_THOUGHT;
    // Same rule as the transcript above (§99): leaning on position alone re-arms the follow on the
    // reader's own scroll event, so a small scroll-up inside this window was undone by the next
    // chunk. Direction decides instead — a move toward older lines turns the follow off and the
    // scroll listener never turns it back on.
    const onScroll = (): void => {
      const top = el.scrollTop;
      const delta = top - lastTop;
      lastTop = top;
      if (delta < -2) { setStuck(false); return; }
      setStuck(atTail());
    };
    const onWheel = (e: WheelEvent): void => { if (e.deltaY < 0) setStuck(false); };
    let touchY = 0;
    const onTouchStart = (e: TouchEvent): void => { touchY = e.touches[0]?.clientY ?? 0; };
    // dragging the finger DOWN scrolls back toward older lines => detach
    const onTouchMove = (e: TouchEvent): void => {
      if ((e.touches[0]?.clientY ?? 0) > touchY + 4) setStuck(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "PageUp" || e.key === "ArrowUp" || e.key === "Home") setStuck(false);
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
    // `open` too: the box does not exist until the header is clicked, and a listener that only ran
    // on mount would never be there for the reader who opened it mid-turn.
  }, [live, open]);
  // a live window follows its own tail: text arrives in chunks and the reader should be at
  // the newest line without touching anything (deps by value, so this runs as the text grows)
  useEffect(() => {
    if (!live || !stuck) return;
    const el = body.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [m.text, live, stuck]);
  const toTail = (): void => {
    setStuck(true);
    const el = body.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
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
      {live && open && !stuck && (
        <button
          type="button"
          className="thought-stick"
          onClick={toTail}
          title="follow the newest thinking again"
          aria-label="follow the newest thinking again"
        >
          <IconArrowDown size={11} /> 回到最新
        </button>
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
function foldWork(msgs: MsgView[]): StreamRow[] {
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
  // something you can fork from.
  const lastMsg = [...rows].reverse().find((r) => r.kind === "msg");
  if (lastMsg && lastMsg.kind === "msg") lastMsg.tail = true;
  // `live` marks the row that is still ARRIVING — the small self-scrolling thinking window. It is read
  // from the ROW's own state (`open`, cleared when the turn ends), never inferred from "the last row
  // while busy": the block that stays live through a turn is the reasoning one, and a turn usually ends
  // on the agent's answer — so a position-based marking could point at a row that never arrives again
  // and leave it marked live forever.
  for (const r of rows) {
    if (r.kind === "msg" && (r.m.kind === "agent" || r.m.kind === "thought")) r.live = Boolean(r.m.open);
  }
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
            {/* A folded stretch is HISTORY: nothing inside it can change any more, so the wrapper
                keeps it from re-rendering when a later frame touches something else. */}
            {items.map((it) => (it.kind === "thought"
              ? <MemoThought key={it.key} m={it} live={false} />
              : <MemoToolCard key={it.key} m={it} />))}
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

/** One persisted approval request, rendered where it happened.
 *
 *  Why it exists at all: the request used to live only in `v.perms` (a transient event). The dialog
 *  covered the screen, the operator answered, and then NOTHING remained in the transcript — no way to
 *  see later what had been asked or what had been allowed. This row is written by the server the
 *  moment the request arrives and updated in place when the decision lands, so the conversation keeps
 *  the receipt.
 *
 *  Buttons only while the server still holds the request: a request that expired (Hermes self-denies
 *  at its own `approvals.timeout`) or vanished with a restart shows its 作废 state instead of offering
 *  a click that can only fail. */
function ApprovalRow({ m, sid }: { m: Extract<MsgView, { kind: "approval" }>; sid: string }): JSX.Element {
  const snap = useSyncExternalStore(cockpit.subscribe, cockpit.getSnapshot);
  const stillLive = snap.active?.info.id === sid
    && Boolean(snap.active?.perms.some((p) => p.requestId === m.requestId));
  const req = {
    requestId: m.requestId, sessionId: sid, toolCallTitle: m.title, kind: m.kind2,
    options: m.options, createdAt: m.at ?? Date.now(), path: m.path, diff: m.diff,
  } as PermissionRequestView;
  if (!m.decision) {
    return stillLive || !snap.active ? <PermCard sid={sid} req={req} /> : <ApprovalSettled m={m} lapsed />;
  }
  return <ApprovalSettled m={m} />;
}

/** 有结论（或作废）的审批卡：只说事实 —— 问的是哪件事、答的是什么。 */
function ApprovalSettled({ m, lapsed }: { m: Extract<MsgView, { kind: "approval" }>; lapsed?: boolean }): JSX.Element {
  const pickedId = m.decision && m.decision.outcome === "selected" ? m.decision.optionId : null;
  const picked = m.options.find((o) => o.optionId === pickedId);
  const label = lapsed
    ? "已作废（服务端不再等这个请求了）"
    : m.decision?.outcome === "selected"
      ? `已答：${picked?.name ?? "已选"}`
      : "已取消";
  const tone = lapsed || m.decision?.outcome !== "selected" ? "no" : "yes";
  return (
    <div className="msg">
      <div className={`perm-card done ${tone}`}>
        <div className="q">🔑 agent 曾要执行：<b>{m.title}</b>（{m.kind2}）</div>
        <PermSubject req={{ requestId: m.requestId, sessionId: "", toolCallTitle: m.title, kind: m.kind2, options: m.options, createdAt: m.at ?? 0, path: m.path, diff: m.diff }} />
        <div className="perm-decision">{label}</div>
      </div>
    </div>
  );
}

/** 「这个仓库有 N 个项目 skill 没启用」——一张能就地决定的卡（决定写回同一行）。
 *  这是 #32 的落地形态：以前它是一行闪过的状态，看完就没了，也没法答。 */
function ProjectSkillsRow({ m, sid }: { m: Extract<MsgView, { kind: "project-skills" }>; sid: string }): JSX.Element {
  const decided = m.state === "trusted" || m.state === "ignore";
  const act = (value: string): void => { cockpit.send({ t: "set-config", sessionId: sid, configId: "project_skills", value }); };
  return (
    <div className="msg">
      <div className={`perm-card skills ${decided ? "done" : ""} ${m.state === "trusted" ? "yes" : m.state === "ignore" ? "no" : ""}`}>
        <div className="q">📦 {m.text}</div>
        {m.root ? <div className="perm-file" title={m.root}><IconFile size={12} /><code>{m.root}</code></div> : null}
        {decided ? (
          <div className="perm-decision">{m.state === "trusted" ? "已信任：这个仓库的 skill 会随会话加载" : "已忽略：不再问，也不加载"}</div>
        ) : (
          <div className="opts">
            <button className="opt primary" onClick={() => act("trusted")}>信任这个仓库（{m.count} 个 skill）</button>
            <button className="opt" onClick={() => act("ignore")}>这个仓库不用问</button>
          </div>
        )}
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
  sid: string; req: PermissionRequestView; onAnswered?: (label: string) => void;
}): JSX.Element {
  const answer = (decision: PermissionDecision, label: string, option?: { optionId: string; kind: string }): void => {
    // One answer per request — but only while the first one is still plausibly in flight. Past
    // `PERM_ACK_MS` the surface has already told the operator it was not confirmed, so his next
    // click is the retry, not a double answer (a frame written into a half-open socket is delivered
    // by nothing, and refusing the retry would leave the request unanswerable).
    const cur = cockpit.permAnswer(req.requestId);
    if (cur && !cur.lapsed) return;
    const delivered = cockpit.send({
      t: "respond-permission", sessionId: sid, requestId: req.requestId, decision,
      // `allow_always` is remembered per live session server-side; the signature is what
      // makes the next identical request in this session pass without asking again.
      ...(option ? { optionKind: option.kind, signature: `${req.kind}:${req.toolCallTitle}` } : {}),
    });
    // `delivered` = it went onto the wire, so an acknowledgement is due and the 「已提交」 claim has
    // to expire if none comes. A queued answer (`false`) is not armed — the queue notice says so.
    cockpit.markPermAnswered(req.requestId, label, delivered);
    onAnswered?.(label);
  };
  // The operator's click has to be visible BEFORE the server's event comes back: the answer travels
  // out and returns as `permission-resolved`, and on a slow link (a phone on the tunnel) a popup
  // that does not move reads as 「点了没反应」. AionUi draws the same state (`hasResponded`), and it
  // is also what keeps a second click off a request that is already answered.
  const answered = cockpit.permAnswer(req.requestId);
  // …and the claim has to expire, because the confirmation can fail to arrive at all: a socket that
  // died without a FIN still looks OPEN, so the answer is written out and lost. Tick while waiting so
  // the state flips on its own instead of waiting for an unrelated re-render.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!answered || answered.lapsed) return;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [answered?.lapsed, req.requestId]);
  if (answered && !answered.lapsed) {
    return (
      <div className="perm-answered" role="status" aria-live="polite">
        <span className="perm-answered-tick" aria-hidden="true">✓</span>
        <span>已提交「{answered.label}」—— 正在等 agent 那边回应</span>
      </div>
    );
  }
  return (
    <>
      {answered?.lapsed && (
        <div className="perm-unconfirmed" role="status" aria-live="polite">
          还没收到 agent 那边的确认（等了 {Math.max(1, Math.round((Date.now() - answered.at) / 1000))} 秒）
          —— 可能是这一次答复没送出去，可以再点一次。
        </div>
      )}
      {req.options.map((o) => (
        <button
          key={o.optionId}
          className={o.kind.startsWith("allow") ? "allow" : "reject"}
          onClick={() => answer({ outcome: "selected", optionId: o.optionId }, o.name, o)}
        >
          {o.name}
        </button>
      ))}
      <button
        title="不选任何一项：agent 会收到 cancelled，这一轮就停在这里"
        onClick={() => answer({ outcome: "cancelled" }, "取消这次请求")}
      >
        取消这次请求
      </button>
    </>
  );
}

/** Unified, hunk-only line diff of the agent's before/after.
 *
 *  `diffLines` itself lives in `changes.ts` (#38) — the per-turn file-changes panel renders the
 *  same lines, and two implementations of one diff would drift. The shape it replaced here:
 *  Hermes' edit approval hands over the WHOLE file twice (`acp.tool_diff_content`), and the
 *  operator's question is never "what is in this file" — it is "what changes". */

/** The diff BODY — shared by the approval card and the per-turn file-changes panel (#38), so
 *  the two render one diff the same way instead of drifting apart. */
function DiffLines({ lines }: { lines: DiffLine[] }): JSX.Element {
  return (
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
  );
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
      {open ? <DiffLines lines={lines} /> : null}
      {diff.truncated ? (
        <div className="perm-cut">agent 发来的是整份文件，这里只保留了改动附近的部分</div>
      ) : null}
    </div>
  );
}

/** 一个文件一条：#38 的「这一回合改了哪些文件」。
 *
 *  为什么挂在回合末尾而不是每条工具卡里：回合跑完，操作者第一个问题是「它到底改了我哪些
 *  文件」——散在各条 tool_call 里的 diff 要一条条翻才能拼出来。这一块把同一回合的所有写文件
 *  调用按 path 合并，一行一个文件，点计数看 diff、点文件名看现在的文件。
 *
 *  与审批无关：这里不看 permission、不看权限模式。`accept_edits` 模式下 agent 不问就写，
 *  那种回合根本没有审批卡可翻 —— 恰恰最需要这一块。 */
function FileChangeRow({ f }: { f: FileChange }): JSX.Element {
  const [open, setOpen] = useState(false);
  const isNew = f.oldText.length === 0 && f.newText.length > 0;
  const canDiff = isNew || f.oldText.length > 0 || f.newText.length > 0;
  const lines = useMemo(() => (canDiff ? diffLines(f.oldText, f.newText) : []), [canDiff, f.oldText, f.newText]);
  // 目录单独一格、去掉末尾分隔符：直接拼在文件名后面会读成「app.ts/repo/src/」，像一条坏路径
  const dir = f.path === f.name ? "" : f.path.slice(0, f.path.length - f.name.length).replace(/[\\/]+$/, "");
  return (
    <div className="fc-row">
      <div className="fc-line">
        <span className="fc-dot" aria-hidden="true" />
        <button
          type="button"
          className="fc-name"
          title={`在右侧面板打开 ${f.path}`}
          onClick={() => openLocalFile({ path: f.path })}
        >
          {f.name}
          {dir ? <span className="fc-dir">{dir}</span> : null}
          {f.edits > 1 ? <span className="fc-edits">改了 {f.edits} 次</span> : null}
        </button>
        <button
          type="button"
          className="fc-counts"
          aria-expanded={open}
          aria-label={`${open ? "收起" : "查看"} ${f.path} 的变更`}
          disabled={!canDiff}
          onClick={() => setOpen((o) => !o)}
        >
          {isNew ? <span className="add">新文件 · {f.insertions} 行</span> : (
            <>
              <span className="add">+{f.insertions}</span>
              <span className="del">−{f.deletions}</span>
            </>
          )}
        </button>
      </div>
      {open && canDiff ? <DiffLines lines={lines} /> : null}
    </div>
  );
}

/** 回合末尾那块：「N 个文件变更」。1 个文件就是一行（对齐 AionUi 的单文件形态），
 *  ≥2 个文件才有一个可折叠的标题行 —— 一个文件还多画一个头，只是多一层点击。 */
function FileChangesPanel({ msgs }: { msgs: MsgView[] }): JSX.Element | null {
  const files = useMemo(() => {
    const list: ToolChange[] = [];
    for (const m of msgs) if (m.kind === "tool" && m.changes?.length) list.push(...m.changes);
    return mergeChanges(list);
  }, [msgs]);
  const [open, setOpen] = useState(true);
  if (!files.length) return null;
  if (files.length === 1) {
    return (
      <div className="file-changes one">
        <FileChangeRow f={files[0]} />
      </div>
    );
  }
  const total = files.reduce((n, f) => n + f.insertions, 0);
  const gone = files.reduce((n, f) => n + f.deletions, 0);
  return (
    <div className="file-changes">
      <button
        type="button"
        className="fc-head"
        aria-expanded={open}
        aria-label={`${open ? "收起" : "展开"} ${files.length} 个文件变更`}
        onClick={() => setOpen((o) => !o)}
      >
        <IconFile size={13} />
        <span className="fc-title">{files.length} 个文件变更</span>
        <span className="fc-counts static">
          <span className="add">+{total}</span>
          <span className="del">−{gone}</span>
        </span>
        <span className="perm-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open ? files.map((f) => <FileChangeRow key={f.path} f={f} />) : null}
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
function PermDialog({ req, sessionTitle, waiting, onSkip }: {
  req: PermissionRequestView; sessionTitle: string; waiting: number; onSkip: () => void;
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
  const answered = cockpit.permAnswer(req.requestId);
  // Answering this one brings up the NEXT request, drawn the same way (an agent that writes two
  // files asks twice). Without saying so, that reads as 「我点了允许，它还在那儿」 — measured
  // 2026-10-11: with two pending, the dialog swapped to the second on the first click and the
  // operator had no way to tell it was a different request.
  const others = Math.max(0, waiting - 1);
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
        data-waiting={waiting}
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
        {others > 0 && (
          <div className="perm-queue" role="note">
            这个会话还有 <b>{others}</b> 个请求等着答复 —— 答完这个，下一个会接着显示在这里。
          </div>
        )}
        <div className="perm-note">
          已等待 {waited} 秒。一直不答复的话，agent 那边会自己放弃这次请求（等同拒绝），这一轮就停在这里。
        </div>
        {!answered && (
          <div className="row">
            <button className="cancel" onClick={onSkip}>稍后处理</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** 每 N 分钟 → 人话。Only used for labels, so it rounds nothing but whole minutes. */
function intervalLabel(sec: number): string {
  if (sec <= 0) return "";
  if (sec % 60 === 0) {
    const m = sec / 60;
    return m < 60 ? `${m} 分钟` : `${Math.round(m / 60)} 小时`;
  }
  return `${sec} 秒`;
}

/** 工作播报 (issue #24): the beat lives in the OBSERVER settings, not in the voice prefs — it is the
 *  cockpit's timer, not the browser's voice. One fetch per pane; a `null` answer (settings route
 *  unavailable) simply means 「no beat」, which is the shipped default.
 *
 *  `save` posts immediately: picking 「每 2 分钟」 must not need a trip to 设置. It also updates local
 *  state first, so the ✓ moves on the same click the operator made. */
function useObserverInterval(): [number, (sec: number) => void] {
  const [sec, setSec] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void fetch("/api/settings", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { observer?: { intervalSec?: number } } | null) => {
        if (live) setSec(Number(d?.observer?.intervalSec ?? 0));
      })
      .catch(() => { if (live) setSec(0); });
    return () => { live = false; };
  }, []);
  const save = useCallback((next: number): void => {
    setSec(next);
    void fetch("/api/settings", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ observer: { intervalSec: next } }),
    }).catch(() => { /* the label keeps the picked value; the next save fixes it */ });
  }, []);
  return [sec ?? 0, save];
}

/** Read this reply aloud / stop reading — and, on a LONG press, offer 「语音播报总结」.
 *  One button for play/stop, because the two states are the same affordance (you click where you
 *  last clicked). The long press is the second meaning, exactly as in the head: a click does the
 *  frequent thing, a hold opens a menu. */
function SpeakButton({ id, text, sid }: { id: string; text: string; sid: string }): JSX.Element | null {
  const [prefs] = useVoicePrefs();
  const spoken = useSpeaker();
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ msg: string; hint?: string } | null>(null);
  const wrap = useRef<HTMLSpanElement | null>(null);
  useDismiss(menu, [wrap], () => setMenu(false));
  // A long press must swallow the click that follows it, or the menu opens AND the message starts
  // being read underneath it (same rule as the rail's row menu).
  const press = useRef<{ timer: number | null; fired: boolean }>({ timer: null, fired: false });
  const pressClear = (): void => {
    if (press.current.timer) { window.clearTimeout(press.current.timer); press.current.timer = null; }
  };
  useEffect(() => pressClear, []);
  const pressStart = (): void => {
    press.current.fired = false;
    pressClear();
    press.current.timer = window.setTimeout(() => {
      press.current.fired = true;
      setMenu(true);
    }, 500);
  };
  if (!text.trim()) return null;
  const playing = spoken.speaking && spoken.speakingId === id;
  // Only claim we cannot speak when the browser really has no speech synthesis at all:
  // "no voices yet" is a loading state, not a verdict (the list arrives late in Chromium).
  if (typeof window !== "undefined" && !("speechSynthesis" in window) && !prefs.serverTts) {
    return <span className="bubble-note" title="this browser has no speech synthesis">no voices</span>;
  }
  // 字数档 (the operator's ask, 2026-10-18): the long press offers 100/150/200 字 beside 「按设置」,
  // and the count rides the server prompt's `{maxChars}` placeholder. `undefined` = 按设置.
  const summarise = async (maxChars?: number): Promise<void> => {
    if (busy) return;
    // Already summarised at THIS length: replay it. A second long press must not buy the same
    // paragraph twice (the note's ✕ forgets it, which turns the next press back into a real call).
    // The key carries the bucket, so 100 字 and 200 字 are two paragraphs, not one cache hit.
    const cached = getSummary(summaryKey(id, maxChars));
    if (cached) {
      setMenu(false);
      void speaker.speak(cached.text, `${id}#summary:${maxChars ?? "cfg"}`, prefs);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const s: SpeechSummary = await summarizeMessage(sid, id, maxChars);
      setMenu(false);
      void speaker.speak(s.text, `${id}#summary:${maxChars ?? "cfg"}`, prefs);
    } catch (e) {
      const se = e as SummaryError;
      // Say WHICH failure it was (off / not configured / timed out / endpoint said no) and never
      // read the original as if it were a summary.
      setErr({ msg: se?.message ?? String(e), hint: se?.hint });
      setMenu(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <span className="speak-wrap bubble-speak" ref={wrap}>
        <button
          className={`bubble-btn speak ${playing ? "on" : ""} ${busy ? "working" : ""}`}
          title={
            busy
              ? "正在生成语音播报总结…"
              : playing
                ? "stop reading（长按：语音播报总结）"
                : "read this reply aloud（长按：语音播报总结）"
          }
          aria-label={playing ? "stop reading" : "read aloud"}
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => {
            if (press.current.fired) { press.current.fired = false; return; }
            if (playing) speaker.stop();
            else void speaker.speak(text, id, prefs);
          }}
          onPointerDown={pressStart}
          onPointerUp={pressClear}
          onPointerLeave={pressClear}
          onPointerCancel={pressClear}
          onContextMenu={(e) => { e.preventDefault(); pressClear(); setMenu(true); }}
          onKeyDown={(e) => {
            if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
              e.preventDefault();
              setMenu(true);
            }
          }}
        >
          {busy ? <IconRefresh size={13} className="spin" /> : playing ? <IconVolumeOff size={13} /> : <IconVolume size={13} />}
        </button>
        {menu ? (
          <div className="speak-menu bubble-menu" role="menu">
            {/* An ACTION list, not a mode picker: no ✓ on purpose — 「读整条」 is what a click does,
                and the 字数 items fire once. A radio mark here would promise a remembered state
                that this menu deliberately does not have (the note is the record of what was made).
                The last item is the configured number, which is what a plain long press used to do. */}
            <button
              type="button"
              role="menuitem"
              className="speak-menu-item"
              data-speak-summary="verbatim"
              onClick={() => { setMenu(false); void speaker.speak(text, id, prefs); }}
            >
              <span className="speak-check">›</span>
              <span className="speak-name">读整条</span>
            </button>
            {[100, 150, 200].map((n) => (
              <button
                key={n}
                type="button"
                role="menuitem"
                className="speak-menu-item"
                disabled={busy}
                data-speak-summary={String(n)}
                onClick={() => void summarise(n)}
              >
                <span className="speak-check">{busy ? "•" : "›"}</span>
                <span className="speak-name">{busy ? "总结中…" : `语音播报总结 · 约 ${n} 字`}</span>
              </button>
            ))}
            <button
              type="button"
              role="menuitem"
              className="speak-menu-item"
              disabled={busy}
              data-speak-summary="cfg"
              onClick={() => void summarise()}
            >
              <span className="speak-check">›</span>
              <span className="speak-name">{busy ? "总结中…" : "语音播报总结 · 按设置"}</span>
            </button>
            <p className="speak-hint">把这条压成一段能听完的话；字数写进提示词交给模型（提示词在 设置 → 语音总结）</p>
          </div>
        ) : null}
      </span>
      {err ? (
        <span className="bubble-note err" role="status">
          {err.msg}{err.hint ? ` · ${err.hint}` : ""}
        </span>
      ) : null}
    </>
  );
}

/** The spoken text, visible. 「它到底念了什么」 must never be a mystery: this line is both the
 *  proof and the thing to judge the prompt by. Click to expand the full text, ✕ to drop it (the
 *  next long press then asks the model again). */
function SummaryNote({ mkey }: { mkey: string }): JSX.Element | null {
  const version = useSyncExternalStore(subscribeSummaries, summariesVersion, summariesVersion);
  const [open, setOpen] = useState(false);
  const sum = getLatestSummary(mkey);
  if (!sum) return null;
  // Which account paid for this one: the session's own provider (the default) or the voice
  // endpoint it fell back to. Same line as the model name — one glance answers "whose tokens".
  const billed = sum.route === "session"
    ? `${sum.provider ?? ""}${sum.provider ? " · " : ""}${sum.model ?? ""}`
    : sum.model ? `语音端点 · ${sum.model}` : "";
  // The bucket is part of the record: 「约 150 字」 is why this paragraph is longer than the last one.
  const bucket = sum.maxChars ? ` · 按 ${sum.maxChars} 字压` : "";
  const meta = sum.via === "verbatim"
    ? "原文本身就够短，直接念"
    : `${sum.chars} 字${bucket} · ${(sum.ms / 1000).toFixed(1)}s${billed ? ` · ${billed}` : ""}`;
  return (
    <div className={`bubble-note speech-note${open ? " open" : ""}`} data-summary-chars={sum.chars}>
      <button type="button" className="speech-note-tag" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        播报稿
      </button>
      <span className="speech-note-text" onClick={() => setOpen((o) => !o)} title="点击展开/收起">
        {sum.text}
      </span>
      <span className="speech-note-meta" title={sum.routeNote ?? undefined}>
        {meta}
      </span>
      <button type="button" className="speech-note-x" title="丢掉这份稿子（下次长按会重新生成）" aria-label="drop this summary" onClick={() => forgetSummary(mkey)}>
        <IconClose size={11} />
      </button>
      {/* version keeps the subscription honest even when this key's summary is replaced */}
      <span hidden>{version}</span>
    </div>
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

/** Enter while an IME is COMPOSING is 「选词」, not 「提交」 (issue #29).
 *
 *  The main composer has carried this guard since 2026-10-17 (a report: 「拼音模式下输入 app，按回车
 *  选中英文，消息直接发出了」). Every other box that treats Enter as "commit" — renaming a session,
 *  typing a context budget, a freeform config value — did not, so the FIRST candidate key committed.
 *  Two signals, because neither is enough: `isComposing` (Chrome sets it on keydown) and the
 *  composition ref (Safari fires keydown before compositionend clears the flag). */
function useImeGuard(): {
  handlers: { onCompositionStart: () => void; onCompositionEnd: () => void };
  isComposing: (e: { nativeEvent: KeyboardEvent }) => boolean;
} {
  const composing = useRef(false);
  return {
    handlers: {
      onCompositionStart: () => { composing.current = true; },
      onCompositionEnd: () => { composing.current = false; },
    },
    isComposing: (e) => composing.current || e.nativeEvent.isComposing === true,
  };
}

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

/** Files the clipboard is carrying (issue #31): a screenshot straight out of a snipping tool, or a
 *  file copied in Finder/Explorer. Empty for ordinary text — and that is the whole contract, because
 *  the caller must NOT intercept a text paste.
 *
 *  Two sources, because browsers disagree: `files` is populated for copied images in Chrome/Safari,
 *  while `items` is the only place some platforms put a copied FILE. De-duplicated by identity so a
 *  browser that fills both does not attach the same picture twice. */
function clipboardFiles(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = Array.from(dt.files ?? []);
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== "file") continue;
    const f = item.getAsFile();
    if (f && !out.some((x) => x.name === f.name && x.size === f.size && x.type === f.type)) out.push(f);
  }
  return out;
}

function humanBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} kB` : `${(n / 1048576).toFixed(1)} MB`;
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
  // the list is what has to stay on screen: the new-session dialog puts this bar near the top
  const listRef = usePopoverFit<HTMLDivElement>();
  if (!items.length) return <div className="tb-list" ref={listRef}><div className="tb-empty">{empty}</div></div>;
  return (
    <div className="tb-list" role="listbox" ref={listRef}>
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
  // 数字框里按回车 = 提交；用拼音输入法时第一下回车是选词，不能当成提交 (#29)。
  const ime = useImeGuard();
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
    // Same rule as the composer: a session with no process cannot run a command, and a prompt sent
    // into it is answered with `no such session`. Wake it instead of erroring at the operator.
    if (v.info.cold) { setOpen(false); void cockpit.resume(v.info.id); return; }
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
        {limit > 0 ? `${fmtTokens(usage.used)} / ${fmtTokens(limit)}` : `${fmtTokens(usage.used)} / —`}
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
                      if (ime.isComposing(e)) return;
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
                      {...ime.handlers}
                      onKeyDown={(e) => {
                        if (ime.isComposing(e)) return;
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
          {usage.size > 0 && source !== "agent" ? <div>agent 上报：{fmtTokens(usage.size)} tokens (usage_update)</div> : null}
          {remembered && source === "session" ? <div>本模型记录：{fmtTokens(remembered)} tokens</div> : null}
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
  // Enter = 确认这个值；输入法组字期间的回车是选词 (#29)。
  const ime = useImeGuard();
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
            {...ime.handlers}
            onKeyDown={(e) => { if (ime.isComposing(e)) return; if (e.key === "Enter" && draft.trim()) send(draft.trim()); }}
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

/** Per-session composer drafts (AionUi's SendBox store, kept in memory).
 *  Switching sessions must not carry one session's half-typed prompt into another, and
 *  coming back must restore it — the operator asked for exactly that ("各个会话输入框的草稿
 *  应该隔离"). Module scope, on purpose: a draft is this tab's working state, and a reload
 *  dropping it is AionUi's behaviour too (its store is a plain Map). */
const draftsBySession = new Map<string, string>();

function Composer({ v, call, onCloseCall }: { v: SessionView; call: boolean; onCloseCall: () => void }): JSX.Element {
  const [text, setText] = useState(() => draftsBySession.get(v.info.id) ?? "");
  // a phone-width placeholder that wraps to a second line just looks broken
  const placeholder = window.innerWidth < 720 ? "message… (/ for commands)" : "message… (Enter send, Shift+Enter newline, / for commands)";
  // 插话 (issue #14) is only discoverable where the operator is actually typing. While a turn runs,
  // Enter FILES into the queue — the modifier is what puts those words on the floor — so the busy
  // placeholder is the one place that can teach it. Same sentence shape as the idle placeholder with
  // one word swapped (send → queues), so it reads as a rule rather than a status: the UI language
  // here is English, and this was the only Chinese string left in the composer (his call, 2026-10-18).
  // Never say 「queued」 as a state: an empty box is not queued, and announcing a status the operator
  // never asked for reads as a stuck message. The queue row below carries the real state.
  const modKey = /Mac|iPhone|iPad/.test(navigator.platform ?? "") ? "⌘" : "Ctrl+";
  const busyHint = window.innerWidth < 720 ? "message… (Enter queues)" : `message… (${modKey}Enter interrupts · Enter queues)`;
  const [pick, setPick] = useState(0); // highlighted row in the slash palette
  // clicking outside hides the palette without eating the "/..." the operator typed
  const [paletteHidden, setPaletteHidden] = useState(false);
  const composerRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  // IME guard. While a composition is up (pinyin/汉字 candidates), the Enter that PICKS a
  // candidate is a plain keydown on the textarea — so the send handler fired and a message
  // left mid-word (the operator's 「拼音模式下输入 app，按回车选中英文，消息直接发出了」).
  // A ref set by the composition events covers Chrome and Safari (in Safari the committing
  // keydown precedes `compositionend`, and in Chrome `isComposing` is unreliable by itself).
  const composing = useRef(false);
  // ---- ↑/↓ recall of what the operator already said (issue #25) -------------------------------
  // Terminal muscle memory: ↑ walks back through this session's own messages, ↓ walks forward, and
  // leaving the walk restores the draft that was in the box before it started. Source is the
  // transcript itself (`v.msgs`), so there is no second store to keep in sync and a reload keeps it.
  //
  // Deliberately narrow: only at the edges of the draft (↑ on a line that has text above it is caret
  // movement), never with a modifier, and never while the slash palette is open (that menu owns ↑/↓).
  // `histNav` marks a setText that came from the walk, so the box's own onChange does not mistake the
  // recall for typing and drop the position.
  const histIdx = useRef<number | null>(null);
  const histDraft = useRef("");
  const histNav = useRef(false);
  const history = useMemo(
    () => v.msgs.filter((m): m is Extract<MsgView, { kind: "user" }> => m.kind === "user").map((m) => m.text).filter((t) => t.trim()),
    [v.msgs],
  );
  // The session the box currently holds text for: a switch saves under the old id and loads
  // under the new one (`text` stays the source of truth inside a session).
  const draftSid = useRef(v.info.id);
  useEffect(() => { draftsBySession.set(draftSid.current, text); }, [text]);
  useEffect(() => {
    if (draftSid.current === v.info.id) return;
    draftsBySession.set(draftSid.current, text);
    draftSid.current = v.info.id;
    setText(draftsBySession.get(v.info.id) ?? "");
    // Another conversation = another history; a walk position from the previous one means nothing here.
    histIdx.current = null;
    histDraft.current = "";
    setPaletteHidden(false);
    setPick(0);
  }, [v.info.id, text]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  // which queued prompt is open in the inline editor (the ✎ button), and its working copy
  const [editingQ, setEditingQ] = useState<{ id: string; text: string } | null>(null);
  const [attachErr, setAttachErr] = useState("");
  const [dragging, setDragging] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // which toolbar popover is open: "effort" | "model" | null (settings has its own flag)
  const [pop, setPop] = useState<"effort" | "model" | null>(null);

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

  /** What the box holds, in wire shape — shared by Enter and ⌘Enter so the two cannot disagree
   *  about what a draft attachment becomes. */
  const attachmentsOf = (): PromptAttachment[] => drafts.map((d) => (
    d.kind === "image"
      ? { kind: "image", mimeType: d.mimeType, data: d.payload, name: d.name }
      : { kind: "text", name: d.name, text: d.payload }
  ));

  /** ↑/↓ through what was already said (#25). Returns true when the key was consumed. */
  const historyKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return false;
    if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return false;
    if (!history.length) return false;
    const el = e.currentTarget;
    const at = el.selectionStart ?? 0;
    // A multi-line draft keeps its caret: ↑ inside the text is editing, not recall.
    if (e.key === "ArrowUp" && el.value.slice(0, at).includes("\n")) return false;
    if (e.key === "ArrowDown" && el.value.slice(at).includes("\n")) return false;
    e.preventDefault();
    if (e.key === "ArrowUp") {
      if (histIdx.current === null) {
        histDraft.current = el.value;                  // the draft to come back to
        histIdx.current = history.length - 1;
      } else {
        histIdx.current = Math.max(0, histIdx.current - 1);  // clamp, do not wrap: wrapping loses your place
      }
    } else {
      if (histIdx.current === null) return true;       // already at the draft: ↓ has nowhere to go
      if (histIdx.current >= history.length - 1) {
        histIdx.current = null;
        histNav.current = true;
        setText(histDraft.current);
        requestAnimationFrame(() => ta.current?.setSelectionRange(histDraft.current.length, histDraft.current.length));
        return true;
      }
      histIdx.current += 1;
    }
    const picked = history[histIdx.current];
    histNav.current = true;
    setText(picked);
    // The caret belongs at the END of the recalled message — that is where you continue typing.
    requestAnimationFrame(() => ta.current?.setSelectionRange(picked.length, picked.length));
    return true;
  };

  const send = () => {
    const t = text.trim();
    if (!t && !drafts.length) return;
    const attachments = attachmentsOf();
    // A busy agent is not a dead composer any more (Studio's message queue): what he types now is
    // filed in the queue and goes out by itself when the running turn ends. The send button is still
    // a stop button while busy, so Enter is the way in — and the queue row is where it can be
    // retracted, rewritten or forced through immediately.
    // A session with no process cannot run a turn, so the message has to WAIT for the wake — and the
    // wake used to be the whole answer here: the prompt was never filed (the draft merely stayed in
    // the box) and nothing ever sent it, so the operator pressed Enter a second time once the agent
    // was finally up (2026-10-10). Filing it alone is not enough either — the queue only drained on a
    // turn-end, and a slot that was just woken never produces one (`no such session` for a cold
    // force-send, 「发消息挂起了」). Both halves are fixed: `sendToCold` files it (idempotently, so a
    // retry press cannot double-send) and the store drains a slot's queue when it turns ready, so ONE
    // Enter both wakes the session and delivers the message. The box is cleared because those words
    // are now a visible queue row — ✕ / ✎ / ↑ included — not because they went anywhere.
    if (v.info.cold) {
      cockpit.sendToCold(v.info.id, t, attachments);
      setText("");
      setDrafts([]);
      setAttachErr("");
      setPick(0);
      streamReattach.current();
      return;
    }
    if (busyNow(v) || v.info.status !== "ready") {
      if (!t && !attachments.length) return;
      cockpit.enqueuePrompt(v.info.id, t, attachments);
    } else {
      // Ready + idle: the one path that had no acknowledgement (#26).
      cockpit.sendPrompt(v.info.id, t, attachments);
    }
    setText("");
    setDrafts([]);
    setAttachErr("");
    setPick(0);
    // Sending ends the recall: the next ↑ should walk back from the newest message, not resume a walk.
    histIdx.current = null;
    histDraft.current = "";
    // Sending is an explicit "show me the answer": re-attach the stream even if the
    // operator had scrolled up to read something.
    streamReattach.current();
  };

  /** ⌘/Ctrl+Enter — 插话: take the floor from the running turn instead of waiting in the queue
   *  (issue #14). Two steps with the mouse (Enter, then the queue row's ↑) become one keystroke.
   *
   *  `cockpit.sendNow` is enqueue + `sendQueuedNow`, so the words still get a queue row (✕/✎), the
   *  `#takingFloor` guard, and the server's `interrupt: true` hand-over. Idle is the same call:
   *  interrupt with no turn running is a plain prompt. A COLD slot has nothing to interrupt — it goes
   *  through `sendToCold` like Enter does (one wake, deduped, and its drain already interrupts). */
  const sendNow = () => {
    const t = text.trim();
    if (!t && !drafts.length) return;
    const attachments = attachmentsOf();
    if (v.info.cold) {
      cockpit.sendToCold(v.info.id, t, attachments);
    } else {
      cockpit.sendNow(v.info.id, t, attachments);
    }
    setText("");
    setDrafts([]);
    setAttachErr("");
    setPick(0);
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
    // The new-session dialog is an overlay ON this page and carries a composer of its own: while it
    // is up the transcript is HIS box's, not this one's. This effect runs FIRST (this page is
    // earlier in the tree than the dialog), so without the check it took the words and the dialog's
    // box stayed empty — the operator's 「点停止后没有填到输入框里」.
    if (!dictation.owns("chat")) return;
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
      // Cmd+V / Ctrl+V of a screenshot (issue #31). Only intercepted when the clipboard really carries
      // files: a text paste must keep the browser's own behaviour (caret, undo, IME), and swallowing it
      // here would break typing in a way that looks unrelated to attachments.
      onPaste={(e) => {
        const files = clipboardFiles(e.clipboardData);
        if (!files.length) return;
        e.preventDefault();
        void addFiles(files);
      }}
    >
      {/* Background work reads ABOVE the plan: it is about the session as a whole (is anything still
          running?), while the plan is the agent's own checklist for one job. Under the plan card the row
          was easy to miss exactly when it mattered — the operator's question 「会话是不是真的结束了」
          comes before 「它还差几步」. */}
      <BackgroundRow v={v} />
      <PlanBar v={v} />
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
        {/* Prompts written while the agent was still working (Studio's message queue). They are the
            operator's own words, so they are visible with their own buttons instead of vanishing
            into a disabled input: ↑ takes the floor now, ✎ rewrites it in place, ✕ drops it. */}
        {v.queue.length > 0 && (
          <div className="queue-list" aria-label="queued messages">
            <div className="queue-head">
              <span className="queue-title">Queued · {v.queue.length}</span>
              <span className="queue-hint">
                {v.queue.some((q) => q.unsure)
                  ? "未确认送达 — 点 ↑ 重发，或 ✕ 丢掉"
                  : v.queue.some((q) => q.inflight)
                    ? "sending…"
                    : v.resuming
                      ? "waking the agent — sends once it is up"
                      : v.info.cold
                        ? "sends when you wake this session"
                        : v.info.status !== "ready"
                          ? "process starting — sends once ready"
                          : "goes out when this turn ends"}
              </span>
            </div>
            {v.queue.map((q, i) => (
              <div key={q.id} className={`queue-row${q.inflight ? " inflight" : ""}${q.unsure ? " unsure" : ""}`} data-queue-id={q.id}>
                <span className="queue-idx" aria-hidden="true">{i + 1}</span>
                {editingQ?.id === q.id ? (
                  <textarea
                    className="queue-edit"
                    rows={1}
                    autoFocus
                    value={editingQ.text}
                    aria-label="edit the queued message"
                    onChange={(e) => setEditingQ({ id: q.id, text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") { e.preventDefault(); setEditingQ(null); return; }
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        cockpit.editQueued(v.info.id, q.id, editingQ.text);
                        setEditingQ(null);
                      }
                    }}
                    onBlur={() => {
                      // Leaving the field keeps the edit (an empty one drops the row) — a stray click
                      // must not silently throw away what he just typed.
                      cockpit.editQueued(v.info.id, q.id, editingQ.text);
                      setEditingQ(null);
                    }}
                  />
                ) : (
                  <span className="queue-text" title={q.text}>{q.text}</span>
                )}
                {q.unsure ? <span className="queue-flag" title="服务器没回执 —— 点 ↑ 重发">未送达</span> : null}
                <span className="queue-actions">
                  <button
                    className="queue-btn"
                    title="send now — stops the running turn and takes the floor"
                    aria-label="send this one now"
                    onClick={() => cockpit.sendQueuedNow(v.info.id, q.id)}
                  >
                    <IconArrowUp size={13} />
                  </button>
                  <button
                    className="queue-btn"
                    title="edit this message"
                    aria-label="edit this queued message"
                    onClick={() => setEditingQ(editingQ?.id === q.id ? null : { id: q.id, text: q.text })}
                  >
                    <IconPencil size={13} />
                  </button>
                  <button
                    className="queue-btn danger"
                    title="drop it — it will not be sent"
                    aria-label="drop this queued message"
                    onClick={() => cockpit.dropQueued(v.info.id, q.id)}
                  >
                    <IconClose size={13} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
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
            placeholder={v.resuming ? "waking the agent…" : v.info.cold ? "no ACP process — Enter wakes it" : busyNow(v) ? busyHint : v.info.status === "ready" ? placeholder : v.info.status}
            onChange={(e) => {
              setText(e.target.value);
              setPaletteHidden(false);
              setPick(0);
              // Typing during a recall means "this is my message now" — leave the walk so the next ↑
              // starts from the current text as the draft (#25).
              if (histNav.current) histNav.current = false;
              else histIdx.current = null;
            }}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; }}
            onKeyDown={(e) => {
              // Never act on a key that belongs to the IME: Enter/arrows are picking a
              // candidate, not sending or navigating.
              if (composing.current || e.nativeEvent.isComposing) return;
              // ⌘/Ctrl+Enter = 插话 (issue #14): take the floor from the running turn NOW instead of
              // filing into the queue. Checked BEFORE the slash palette on purpose — the modifier
              // always means "take the floor", while picking a command is a plain Enter/Tab gesture.
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
                e.preventDefault();
                sendNow();
                return;
              }
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
              // ↑/↓ recall (issue #25) — after the palette, so the menu keeps owning the arrows.
              if (historyKey(e)) return;
              // Esc leaves the recall and restores the draft that was in the box before it started.
              if (e.key === "Escape" && histIdx.current !== null) {
                e.preventDefault();
                histIdx.current = null;
                setText(histDraft.current);
                return;
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
                const picked = e.target.files;
                // Nothing came back (#30): the App's WebView can hand the page an EMPTY selection
                // (OEM file pickers), and silence is indistinguishable from a broken button.
                if (picked && picked.length) void addFiles(picked);
                else setAttachErr("选择器没有返回文件 —— 再试一次，或从相册 / 文件管理里选");
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
                  <ModelList
                    models={models}
                    current={currentModel}
                    bad={modelBad}
                    err={modelErr}
                    onPick={(modelId) => {
                      if (modelId === currentModel) { setPop(null); return; }
                      setSwitching(true);
                      setModelErr(null);
                      // Not closed up front: a refusal has to be read where the pick was made,
                      // with the list still in front of the operator.
                      void cockpit.setModel(v.info.id, modelId)
                        .then(() => { setPop(null); setModelErr(null); setAttachErr(""); })
                        .catch((e) => {
                          const text = String((e as Error)?.message ?? e);
                          setModelErr({ id: modelId, text });
                          setModelBad((prev) => ({ ...prev, [modelId]: text }));
                          setAttachErr(`model switch failed: ${text}`);
                        })
                        .finally(() => setSwitching(false));
                    }}
                  />
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
                /* The chat page's OWN rows, handed to the call so its captions view shows the same
                   transcript the operator reads every day (mark + name, YOU, folding, tool and plan
                   cards) instead of a simplified second one. */
                renderTranscript={(p) => <TranscriptRows {...p} notes={v.notes} />}
              />
            ) : null}
            {busyNow(v) ? (
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
                disabled={(!text.trim() && !drafts.length) || v.resuming || (!v.info.cold && v.info.status !== "ready")}
                title={v.resuming ? "正在唤醒 agent 进程…" : v.info.cold ? "唤醒会话 (Enter)" : "send (Enter)"}
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

/** The mark inside a backend CARD (the new-session form): the same two carriers the rail row uses —
 *  the vendor's artwork when we have it, our monogram otherwise — at the card's own size. */
function CardMark({ backend }: { backend: string }): JSX.Element {
  const mark = markOf(backend);
  const [broken, setBroken] = useState(false);
  return (
    <span className="be-card-mark" data-backend={backend} data-letter={mark.letter}>
      {mark.icon && !broken
        ? <img src={mark.icon} alt="" draggable={false} onError={() => setBroken(true)} />
        : mark.letter}
    </span>
  );
}

/** Which backends the new-session form may offer — the rule (mock is a dev-instance backend only)
 *  lives in `agents.ts`, where it can be asserted without a browser. */
/** The new-session surface: a REDUCED COPY OF THE CHAT PAGE, not a form.
 *
 *  The operator's correction (2026-10-14), after the first cut shipped as a message box plus a backend
 *  list plus an expanded directory tree: 「他不是说的是那个相当于一个会话页面的一个缩小版嘛…就会话页面。
 *  不包含那些聊天记录而已…那些什么选模型啊？相关的设置啊，还有语音输入啊，这个输入框啊，应该都是一样的。都要有的呀」.
 *  AionUi's `pages/guid` — the reference he named — is exactly that shape: the SAME input card as the
 *  conversation page (`GuidInputCard` = textarea + `GuidActionRow`), carrying model / permission /
 *  speech controls, with the workspace as a footnote pill instead of a page section.
 *
 *  So this renders the chat composer's own bar, with its own class names, and the only real difference
 *  is WHERE THE VALUES COME FROM: a session that does not exist yet has no configOptions, so they are
 *  read off the backend row's cached ACP handshake (`BackendView.handshake` — kept whole by
 *  `handshakeFrom` for exactly this page) and replayed onto the session the moment it comes up
 *  (`cockpit.queueSetup`). Nothing is invented: a control the agent never advertised is not drawn.
 *
 *  The message still comes first, because it is the one thing the operator already knows — Enter
 *  creates the row (which exists immediately as `status: "starting"`), files the text into the queue
 *  and opens it, so the prompt goes out on its own the moment the agent is up, and a failure lands IN
 *  that session rather than in a vanished HTTP call. */
function StartPage({ cwd: initialCwd, onClose }: { cwd?: string; onClose: () => void }): JSX.Element {
  useEscape(true, onClose);
  const [backend, setBackend] = useState("");
  // A rail group's 「+」 hands its directory in (`initialCwd`): then the only thing left to
  // choose is which agent runs there — the point of the + is that the folder is already
  // decided, and re-picking it is the step the operator asked to be rid of.
  const [dir, setDir] = useState(initialCwd ?? "");
  const fixedDir = initialCwd ?? "";
  const [text, setText] = useState("");
  // Attachments belong to the start page too: reading a file is a FileReader result, so nothing here
  // needs a session — the drafts ride out with the first message as `PromptAttachment`s, on the same
  // `enqueuePrompt` the chat composer uses.
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [attachErr, setAttachErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<BackendRow[]>([]);
  // The instance's own answer to "am I a dev instance", read next to the bundle hash: /api/version
  // is where the server describes itself, and it is the only place that knows about DEV_TREE.
  const [dev, setDev] = useState(false);
  // 后端详情 is folded away by default: `runs:` + home + env + 上次检查 were four monospace lines
  // standing between the operator and the phone screen's only button (measured: the dialog did not
  // fit 390×844 at all). The facts still exist — one tap away — because the home is the single place
  // where "this row writes into my LIVE home" is visible, and deleting it outright would delete the
  // warning that matters.
  const [detail, setDetail] = useState(false);
  // What this composer is set to before its session exists. `null` always means "the agent's own
  // default" — the same reading the chat page gives an option the agent reports no value for.
  const [pickModel, setPickModel] = useState<string | null>(null);
  const [pickEffort, setPickEffort] = useState<string | null>(null);
  const [pickMode, setPickMode] = useState<string | null>(null);
  const [pop, setPop] = useState<null | "model" | "effort" | "mode">(null);
  const [prefs] = useVoicePrefs();
  const dict = useDictation();
  const listening = dict.status === "listening" || dict.status === "recording" || dict.status === "requesting";
  const composing = useRef(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Grow with the content, exactly as the chat composer does: a box frozen at min-height clipped the
  // two-line placeholder on a 390px screen (measured), and dictation lands here programmatically
  // rather than by keystroke, so a keystroke-only resize would leave it short.
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "42px";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text]);

  const load = () => {
    setLoading(true); setErr("");
    Promise.all([
      cockpit.loadBackends(),
      fetch("/api/version", { cache: "no-store" })
        .then((r) => r.json() as Promise<{ dev?: boolean }>)
        .catch(() => ({ dev: false }) as { dev?: boolean }),
      // Where the session will run. It comes from the server's own idea of `home` — the same place
      // the picker starts — because a session with NO directory cannot be sent from (发送 stays
      // disabled without a cwd), and a form that opens unable to send is the old dead-end again.
      // The choice is pre-made and changeable; the rail's 「+」 still wins when it hands one in.
      fetch("/api/fs/dirs", { cache: "no-store" })
        .then((r) => r.json() as Promise<{ home?: string }>)
        .catch(() => ({}) as { home?: string }),
    ])
      .then(([list, ver, dirs]) => {
        setRows(list);
        setDev(Boolean(ver?.dev));
        setBackend((cur) => cur || backendChoices(list, Boolean(ver?.dev))[0]?.id || "");
        setDir((cur) => cur || (dirs as { home?: string })?.home || "");
      })
      .catch((e) => setErr(`后端列表拉取失败：${String((e as Error).message ?? e)}`))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  // While this dialog is up, THIS box is the one that takes the words: the chat page behind it is
  // still mounted with a sink of its own and its effect runs first (it is earlier in the tree). A
  // layout effect, because the claim has to be in place before that passive effect in the same
  // commit — opening the dialog exactly as an utterance ends is otherwise a race the box we cannot
  // see wins.
  useLayoutEffect(() => {
    dictation.setOwner("start");
    return () => dictation.setOwner("chat");
  }, []);

  // Dictation finishes into THIS box, exactly as it does in the chat composer: the transcript has
  // exactly one place to land, and that place is the prompt.
  useEffect(() => {
    if (!dictation.owns("start")) return;
    if (dict.status !== "idle" || !dict.text) return;
    const heard = dictation.consume();
    if (!heard) return;
    setText((cur) => (cur.trim() ? `${cur.trim()} ${heard}` : heard));
    ta.current?.focus();
  }, [dict.status, dict.text]);

  const choices = backendChoices(rows, dev);
  const sel = rows.find((b) => b.id === backend) ?? null;
  // The controls this backend ADVERTISED at its last real start — the same set the chat page reads
  // once a session exists. No handshake (a row that never ran) means no controls, which is honest:
  // the alternative is a model list this project would have had to guess at.
  const hs = sel?.handshake ?? null;
  const hsCfg = (hs?.configOptions ?? []) as unknown as SessionView["info"]["configOptions"];
  const effortCfg = pickConfigOption(hsCfg, "effort");
  const effortOptions = (effortCfg?.options ?? []) as { value: string; name?: string | null }[];
  const effortValue = pickEffort ?? String(effortCfg?.currentValue ?? "");
  const effort = effortCfg ? effortStyle(effortValue, effortOptions) : null;
  const effortName = effortOptions.find((o) => String(o.value) === effortValue)?.name ?? "";
  const modeIds = hs?.modes?.available ?? [];
  const modeValue = pickMode ?? hs?.modes?.currentModeId ?? "";
  const modeLabel = modeValue ? (hs?.modes?.names?.[modeValue] ?? modeValue) : "默认权限";
  // `models.available` is the ids-only shape the row cache keeps; the chat page's richer
  // `availableModels` (names + descriptions) only exists on a live session. Ids are enough to pick
  // by, and `shortModelName` already knows how to trim one for a button.
  const modelIds = hs?.models?.available ?? [];
  const modelValue = pickModel ?? hs?.models?.currentModelId ?? "";
  const modelLabel = modelValue ? shortModelName(modelValue) : "默认模型";

  /** The picks ride WITH the session: at `ready` the store replays them as the very frames the chat
   *  composer sends (set-model / set-config / set-mode) and only then releases the queued first
   *  message — one path for "apply what I chose" instead of a second one that exists only here. */
  const pickedSetup = (): SetupPick[] => {
    const out: SetupPick[] = [];
    if (pickModel) out.push({ kind: "model", value: pickModel });
    if (pickEffort && effortCfg) out.push({ kind: "config", id: String(effortCfg.id), value: pickEffort });
    if (pickMode) out.push({ kind: "mode", value: pickMode });
    return out;
  };

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

  const send = async () => {
    const msg = text.trim();
    // An attachment alone is a message: the same bargain the chat composer makes.
    if ((!msg && !drafts.length) || !backend || !dir.trim()) return;
    setBusy(true); setErr("");
    try {
      if (listening) dictation.stop();
      const attachments: PromptAttachment[] = drafts.map((d) => (
        d.kind === "image"
          ? { kind: "image", mimeType: d.mimeType, data: d.payload, name: d.name }
          : { kind: "text", name: d.name, text: d.payload }
      ));
      const id = await cockpit.createSession(backend, dir.trim(), "");
      cockpit.queueSetup(id, pickedSetup());
      cockpit.setActive(id);
      cockpit.enqueuePrompt(id, msg, attachments);
      onClose();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal start-page" onClick={(e) => e.stopPropagation()}>
        <div className="start-head">
          <h3>新建会话</h3>
          {/* The workspace is a BUTTON with a dialog behind it, not a section of this page
              (「搞一个按钮，然后弹一个框去选择」). Locked when the rail's 「+」 already decided it. */}
          <WorkspaceButton value={fixedDir || dir} onChange={setDir} locked={Boolean(fixedDir)} />
        </div>
        {/* The chat page's own input card and bar — same classes on purpose: same box, same buttons,
            same gaps. A reduced copy, not a lookalike. */}
        <div
          className="composer start-composer"
          // Same clipboard rule as the chat composer (#31): files in the clipboard become drafts,
          // anything else keeps the browser's own paste.
          onPaste={(e) => {
            const files = clipboardFiles(e.clipboardData);
            if (!files.length) return;
            e.preventDefault();
            void addFiles(files);
          }}
        >
          <div className="composer-inner">
            {/* The chat composer's own draft row, same classes: an attachment must look identical
                whether or not the session it will belong to exists yet. */}
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
            <div className="composer-box">
              {/* The placeholder is ONE line at 390px ON PURPOSE: a placeholder is not content, so it
                  never reaches `scrollHeight` and the auto-grow above cannot make room for a second
                  line — a longer hint gets clipped mid-word (measured). The full bargain (Shift+Enter
                  = 换行) is on the send button's tooltip. */}
              <textarea
                ref={ta}
                rows={1}
                autoFocus
                value={text}
                aria-label="first message"
                placeholder="say something to start… (Enter sends)"
                onChange={(e) => setText(e.target.value)}
                onCompositionStart={() => { composing.current = true; }}
                onCompositionEnd={() => { composing.current = false; }}
                onKeyDown={(e) => {
                  if (composing.current || e.nativeEvent.isComposing) return;
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
                }}
              />
              <div className="composer-bar">
                {/* The chat composer's own 「+」, first in the bar exactly as it is there: attaching is a
                    property of the MESSAGE, not of the session, so it needs nothing from a live agent. */}
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  hidden
                  accept={`${IMAGE_TYPES.join(",")},.txt,.md,.json,.log,.csv,.ts,.tsx,.js,.jsx,.py,.rb,.go,.rs,.java,.c,.cpp,.h,.sh,.yaml,.yml,.toml,.ini,.html,.css`}
                  onChange={(e) => {
                    const picked = e.target.files;
                    if (picked && picked.length) void addFiles(picked);
                    else setAttachErr("选择器没有返回文件 —— 再试一次，或从相册 / 文件管理里选");
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
                {/* Thinking depth — the agent's own `select`, taken from the row's handshake. */}
                {effortCfg && effortOptions.length ? (
                  <div className="tb-wrap" style={{ ["--effort" as string]: effort?.color }}>
                    <button
                      type="button"
                      className={`tb-btn tb-effort ${pop === "effort" ? "on" : ""}`}
                      style={{ color: effortValue ? effort?.color : undefined }}
                      title={`thinking depth — ${effortName || "agent default"}`}
                      aria-label={`thinking depth: ${effortName || "agent default"}`}
                      aria-expanded={pop === "effort"}
                      data-testid="start-effort"
                      onClick={() => setPop((p) => (p === "effort" ? null : "effort"))}
                    >
                      <EffortPips level={effort?.level ?? 0} total={effort?.total ?? 1} color={effort?.color ?? "var(--text-dim)"} />
                      <IconChevronDown size={11} className="tb-chev" />
                    </button>
                    {pop === "effort" ? (
                      <ChoiceList
                        items={effortOptions.map((o, i) => ({
                          value: String(o.value),
                          name: String(o.name ?? o.value),
                          hint: null,
                          color: EFFORT_COLORS[Math.min(i, EFFORT_COLORS.length - 1)],
                        }))}
                        current={effortValue}
                        empty="the agent advertises no levels"
                        onPick={(value) => { setPickEffort(value); setPop(null); }}
                      />
                    ) : null}
                  </div>
                ) : null}
                {/* Permission mode — the modes the agent listed, with the names it gave them. */}
                {modeIds.length ? (
                  <div className="tb-wrap">
                    <button
                      type="button"
                      className={`tb-btn ${pop === "mode" ? "on" : ""}`}
                      title={`权限模式 — ${modeLabel}`}
                      aria-label={`permission mode: ${modeLabel}`}
                      aria-expanded={pop === "mode"}
                      data-testid="start-mode"
                      onClick={() => setPop((p) => (p === "mode" ? null : "mode"))}
                    >
                      <IconShield size={14} />
                      <span className="tb-label">{modeLabel}</span>
                      <IconChevronDown size={11} className="tb-chev" />
                    </button>
                    {pop === "mode" ? (
                      <ChoiceList
                        items={modeIds.map((id) => ({ value: id, name: hs?.modes?.names?.[id] ?? id }))}
                        current={modeValue}
                        empty="the agent lists no modes"
                        onPick={(value) => { setPickMode(value); setPop(null); }}
                      />
                    ) : null}
                  </div>
                ) : null}
                {/* Model — the ids the agent announced. */}
                {modelIds.length ? (
                  <ToolbarSelect
                    label="model"
                    title={`model — ${modelLabel}`}
                    icon={<IconChip size={15} />}
                    value={modelLabel}
                    testId="start-model"
                    open={pop === "model"}
                    onToggle={() => setPop((p) => (p === "model" ? null : "model"))}
                  >
                    {/* The same list as the chat page — grouped by provider, filterable once
                        the agent knows many models, and opening on the current choice. This dialog
                        is meant to be a smaller session page, not a plainer one; with Hermes's 439
                        models the old flat id list was a wall you could not read. */}
                    <ModelList
                      models={modelIds.map((id) => ({ modelId: id }))}
                      current={modelValue}
                      onPick={(id) => { setPickModel(id); setPop(null); }}
                    />
                  </ToolbarSelect>
                ) : null}
                <span className="head-spacer" />
                {/* Dictation: the same control, and it needs no session to record into this box. */}
                <button
                  className={`icon-btn ${listening ? "on rec" : ""}`}
                  title={dict.error ? dict.error : listening ? "stop dictation" : "dictate a prompt"}
                  aria-label="dictate"
                  onClick={() => {
                    dictation.cancel();
                    void dictation.start(prefs);
                  }}
                >
                  <IconMic size={16} />
                </button>
                <button
                  className="send-btn"
                  onClick={() => void send()}
                  disabled={busy || (!text.trim() && !drafts.length) || !dir.trim()}
                  title={busy ? "创建中…" : "创建并发送 (Enter)"}
                  aria-label="send"
                >
                  <IconSend size={16} />
                </button>
              </div>
            </div>
            {listening || dict.status === "transcribing" || dict.error ? (
              <div className={`dict-chip ${dict.error ? "err" : ""}`}>
                <IconMic size={13} />
                {dict.error
                  ? dict.error
                  : dict.status === "requesting"
                    ? "waiting for the microphone…"
                    : dict.status === "transcribing"
                      ? "transcribing…"
                      : <>{dict.text} <span className="interim">{dict.interim}</span></>}
                {listening ? <button className="dict-stop" onClick={() => dictation.stop()}>stop</button> : null}
              </div>
            ) : null}
          </div>
        </div>
        {/* Which agent runs there. Cards, not a row of stretched pills: the mark on top and the name
            under it is the shape the operator asked for (「上面放头像，下面写文案」), and it is what the
            rail already shows in miniature. The strip scrolls sideways when it outgrows the screen —
            that is the one dimension a phone does not have, so it is the one we spend on more backends. */}
        <div className="backend-pick" role="radiogroup" aria-label="backend">
          {loading && !rows.length && <span className="dim">loading…</span>}
          {!loading && !choices.length && <span className="dim">no backends</span>}
          {choices.map((b) => (
            <button
              key={b.id}
              type="button"
              role="radio"
              aria-checked={backend === b.id}
              data-backend={b.id}
              title={b.home ? `${b.label} · home: ${b.home}` : b.label}
              className={`be-card ${backend === b.id ? "sel" : ""}`}
              onClick={() => setBackend(b.id)}
            >
              <CardMark backend={b.kind || b.id} />
              <span className="be-card-label">{b.label}</span>
            </button>
          ))}
          <button type="button" className="be-card reload" title="重新拉取后端列表" aria-label="重新拉取后端列表" onClick={load}>⟳</button>
        </div>
        {/* The warnings stay ON the form even folded: they are the actionable half (a row that
            cannot start, a login that is missing), and they are rare. */}
        {(sel?.warnings ?? []).map((w, i) => <div key={i} className="hint-warn">{w}</div>)}
        {sel ? (
          <div className={`be-detail ${detail ? "open" : ""}`}>
            <button
              type="button"
              className="be-detail-head"
              aria-expanded={detail}
              onClick={() => setDetail((v) => !v)}
            >
              <IconChevronRight size={12} className="be-detail-arrow" /> 后端详情
            </button>
            {detail ? (
              // What this row will actually be: which code (cmd + env), which home, which profile.
              // It is the operator's one chance to notice "oh, this one writes into my LIVE home".
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
                {sel.cwd ? <div>cwd: <code>{sel.cwd}</code></div> : null}
                {(sel.env ?? []).length ? <div>env: <code>{(sel.env ?? []).join(", ")}</code></div> : null}
                {hs && !hsCfg.length && !modelIds.length ? (
                  <div>这个后端还没真跑过，所以没有可选的模型 / 设置 —— 建会话后由 agent 自己的清单决定</div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {err && <div className="err">{err}</div>}
      </div>
    </div>
  );
}
