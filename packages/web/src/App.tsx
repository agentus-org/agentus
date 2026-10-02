import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { cockpit, type MsgView, type SessionView } from "./state";
import { MiniMarkdown } from "./MiniMarkdown";
import { WorkspacePicker } from "./WorkspacePicker";
import { ToolPanel } from "./ToolPanel";
import {
  browserDictationAvailable, dictation, loadVoiceCaps, speaker, useAutoRead, useDictation,
  useSpeaker, useVoicePrefs, voiceCaps, type VoicePrefs,
} from "./voice";
import {
  IconArrowDown, IconChevronDown, IconChevronRight, IconClose, IconFile, IconFolder, IconGauge,
  IconHome, IconMenu, IconMic, IconPanel, IconPaperclip, IconPause, IconPlus, IconPower, IconResume,
  IconSearch, IconSend, IconSettings, IconShield, IconStop, IconVolume, IconVolumeOff,
} from "./Icons";
import type { ClientCommand, PromptAttachment, TurnTrace, UsageView } from "@agentslot/shared";

export function App(): JSX.Element {
  const snap = useSyncExternalStore(cockpit.subscribe, cockpit.getSnapshot);
  const [drawer, setDrawer] = useState(false);
  const [modal, setModal] = useState(false);

  // Who are we? Asked before anything else: /api/auth/me decides between the login
  // view and the cockpit. Dialling the socket first would be wasted — an
  // unauthenticated upgrade is refused with 401.
  useEffect(() => { void cockpit.checkAuth(); }, []);
  useEffect(() => { setDrawer(false); }, [snap.activeId]);

  if (snap.auth !== "in") return <AuthScreen />;

  return (
    <div className="app">
      {drawer && <div className="scrim" onClick={() => setDrawer(false)} />}
      <Sidebar open={drawer} onNew={() => setModal(true)} />
      <Main onMenu={() => setDrawer(true)} />
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

function Sidebar({ open, onNew }: { open: boolean; onNew: () => void }): JSX.Element {
  const { sessions, archived, activeId, conn, net, netError, authInfo } = useSyncExternalStore(cockpit.subscribe, cockpit.getSnapshot);
  const [q, setQ] = useState("");
  // Search spans live + cold slots by title / backend / cwd — the rail is a launch pad,
  // so "where was that session?" must work without opening each slot (M4).
  const needle = q.trim().toLowerCase();
  const match = (s: { title: string; backend: string; cwd: string }) =>
    !needle ||
    `${s.title} ${s.backend} ${s.cwd}`.toLowerCase().includes(needle);
  const live = sessions.filter(match);
  const cold = archived.filter(match);
  return (
    <aside className={`sidebar ${open ? "open" : ""}`}>
      <header>
        <span className="logo">⛟ AgentSlot</span>
        <span className="tagline">keep your agents on the track</span>
      </header>
      {net === "degraded" || conn === "offline" ? (
        <div className="net-banner" title={netError}>
          <span>
            {conn === "offline" ? "⚠ 与服务的连接已断开 — 正在重连（指令会排队）" : "⚠ 服务不可达 — 请求超时"}
          </span>
          <button onClick={() => location.reload()}>reload</button>
        </div>
      ) : null}
      <button className="new-btn" onClick={onNew} title="new slot (pick a backend + working directory)">
        <IconPlus size={14} /> new slot
      </button>
      <div className="rail-search-wrap">
        <IconSearch size={13} />
        <input
          className="rail-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search slots…"
          aria-label="search sessions"
        />
      </div>
      <div className="session-list">
        {live.map((s) => (
          <div
            key={s.id}
            className={`session-item ${s.id === activeId ? "active" : ""}`}
            onClick={() => cockpit.setActive(s.id)}
          >
            <div className="title">{s.title}</div>
            <div className="meta">
              <span className={`dot ${s.status}`} />
              <span>{s.backend}</span>
              <span>{s.status === "running" ? "running" : s.status}</span>
              {cockpit.byId.get(s.id)?.perms.length ? (
                <span className="badge perm">⚿ {cockpit.byId.get(s.id)!.perms.length}</span>
              ) : null}
            </div>
          </div>
        ))}
        {!live.length && (
          <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 13 }}>
            {needle ? "no live slot matches that search." : "No sessions yet — open a slot."}
          </div>
        )}
        {cold.length > 0 && (
          <>
            <div className="rail-sep">
              <span>cold slots</span>
              <span className="hint" title="sessions kept in SQLite after their process exited">
                on disk · {cold.length}{needle ? ` of ${archived.length}` : ""}
              </span>
            </div>
            {cold.map((s) => (
              <div key={s.id} className="session-item cold" title="resume this cold slot" onClick={() => void cockpit.resume(s.id)}>
                <div className="title">{s.title}</div>
                <div className="meta">
                  <span className="dot cold" />
                  <span>{s.backend}</span>
                  <button
                    className="cold-resume"
                    title="resume this cold slot (respawn the agent and reload its transcript)"
                    aria-label={`resume cold slot ${s.title}`}
                    onClick={(e) => { e.stopPropagation(); void cockpit.resume(s.id); }}
                  >
                    <IconResume size={13} />
                  </button>
                  <button
                    className="cold-purge"
                    title="delete this cold slot and its transcript for good"
                    aria-label={`delete cold slot ${s.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`delete cold slot "${s.title}"?\n\nthe transcript is removed from disk — this cannot be undone.`)) {
                        cockpit.purgeCold(s.id);
                      }
                    }}
                  >
                    <IconClose size={12} />
                  </button>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
      <footer>
        <span className={`conn ${conn === "online" ? "" : "off"}`}>● {conn}</span>
        {" · "}
        <span title={location.hostname}>{location.host}</span>
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

function Main({ onMenu }: { onMenu: () => void }): JSX.Element {
  const { active } = useSyncExternalStore(cockpit.subscribe, cockpit.getSnapshot);
  // The panel (files · terminal) is per-slot UI state, not a server thing: it lives
  // here so switching slots keeps the panel open on the new slot's workspace.
  const [panelOpen, setPanelOpen] = useState(false);
  const [pickWorkspace, setPickWorkspace] = useState(false);
  // Voice capabilities are fetched once; the buttons fall back to browser-only until
  // the answer arrives.
  useEffect(() => { void loadVoiceCaps(); }, []);
  useAutoRead(lastFinishedReply(active), Boolean(active && !active.busy && active.loaded));

  if (!active) {
    return (
      <div className="main">
        <div className="chat-head">
          <button className="icon-btn menu-btn" onClick={onMenu} title="slots" aria-label="slots"><IconMenu /></button>
          <span className="title">AgentSlot</span>
        </div>
        <div className="empty">
          <div className="big">⛟</div>
          <p>No slot selected.<br />Create one and point it at a real <code>hermes acp</code> / <code>qodercli --acp</code>.</p>
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
      />
      <div className="main-body">
        <div className="chat-col">
          <Stream v={active} />
          <Composer v={active} />
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
          was started in — the new one applies to this slot from the next resume.
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

function ChatHead({ v, onMenu, panelOpen, onTogglePanel, onPickWorkspace }: {
  v: SessionView;
  onMenu: () => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
  onPickWorkspace: () => void;
}): JSX.Element {
  const info = v.info;
  const wsName = (info.workspace || info.cwd).split("/").filter(Boolean).pop() ?? info.cwd;
  // Two controls, and only two (the operator's ask, and hermes-studio's head does the
  // same): where this slot works, and the panel that shows it. Mode, thinking depth,
  // context and voice all moved into the composer, where the prompt is written —
  // a header is a place for identity, not for settings.
  return (
    <div className="chat-head">
      <button className="icon-btn menu-btn" onClick={onMenu} title="slots" aria-label="slots"><IconMenu /></button>
      <span className="title" title={info.title}>{info.title}</span>
      {v.perms.length > 0 ? (
        <span className="chip perm-chip" title="requests waiting for your approval in this slot">
          <span className="perm-pulse" />⚿ {v.perms.length}
        </span>
      ) : null}
      <span className="head-spacer" />
      <button
        className="icon-btn"
        title={`workspace: ${info.workspace || info.cwd}\nclick to point this slot at another directory`}
        aria-label="workspace"
        onClick={onPickWorkspace}
      >
        <IconFolder size={16} />
      </button>
      <button
        className={`icon-btn ${panelOpen ? "on" : ""}`}
        title="workspace panel — files and terminal"
        aria-label="workspace panel"
        aria-expanded={panelOpen}
        onClick={onTogglePanel}
      >
        <IconPanel size={16} />
      </button>
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
          {v.msgs.map((m) => <Bubble key={m.key} m={m} />)}
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

function Bubble({ m }: { m: MsgView }): JSX.Element | null {
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
          </div>
        </div>
      );
    case "agent":
      return (
        <div className="msg agent">
          <div className="role">AGENT</div>
          <div className="bubble">
            <MiniMarkdown text={m.text} />
            <div className="bubble-actions">
              <SpeakButton id={m.key} text={m.text} />
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
function ToolCard({ m }: { m: Extract<MsgView, { kind: "tool" }> }): JSX.Element {
  const [open, setOpen] = useState(false);
  const hasBody = Boolean(m.input || m.detail);
  return (
    <div className="msg">
      <div className={`tool-card ${m.status}`}>
        <div
          className="t"
          style={{ cursor: hasBody ? "pointer" : "default" }}
          onClick={() => hasBody && setOpen((x) => !x)}
          title={hasBody ? "show input/output" : undefined}
        >
          🔧 {m.title} {hasBody ? (open ? "▾" : "▸") : ""}
        </div>
        <div className="st">{m.kind2 ? `${m.kind2} · ` : ""}{m.status}</div>
        {open && (
          <div className="tool-body">
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
      {open && <div className="bubble">{m.text}</div>}
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
  const hasVoices = useSyncExternalStore(speaker.subscribeVoices, () => speaker.voices().length);
  if (!text.trim()) return null;
  const playing = spoken.speaking && spoken.speakingId === id;
  if (!hasVoices && !prefs.serverTts) {
    return <span className="bubble-note" title="this browser exposes no speech synthesis">no voices</span>;
  }
  return (
    <button
      className={`icon-btn tiny ${playing ? "on" : ""}`}
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

/** Context + spend, in small type above the box (the operator's ask). The bar is
 *  the same reading the ring used to give, minus the ring's claim on the header. */
function UsageRow({ usage, trace }: { usage?: UsageView | null; trace?: TurnTrace | null }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (!usage || (!usage.used && !usage.size)) return null;
  const pct = usage.size > 0 ? Math.min(100, Math.round((usage.used / usage.size) * 100)) : 0;
  const level = pct >= 85 ? "hot" : pct >= 65 ? "warn" : "ok";
  const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
  const remaining = usage.size > 0 ? Math.max(0, usage.size - usage.used) : 0;
  return (
    <div className={`usage-row ${level}`}>
      <button className="usage-text" onClick={() => setOpen((o) => !o)} title="context window and this turn">
        ctx {fmt(usage.used)}{usage.size > 0 ? ` / ${fmt(usage.size)}` : ""}
        {usage.size > 0 ? ` · ${pct}% · ${fmt(remaining)} left` : ""}
        {usage.cost != null ? ` · $${usage.cost.toFixed(4)}` : ""}
        {trace && (trace.effort || trace.mode)
          ? ` · ${[trace.effort && `effort ${trace.effort}`, trace.mode && `mode ${trace.mode}`].filter(Boolean).join(" / ")}`
          : ""}
      </button>
      {usage.size > 0 ? (
        <div className="usage-bar" title={`${fmt(usage.used)} of ${fmt(usage.size)} tokens`}>
          <i style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      {open ? (
        <div className="usage-detail">
          <div>context window: {usage.used} / {usage.size || "—"} tokens ({pct}%)</div>
          <div>remaining: {usage.size > 0 ? remaining : "unknown"} tokens</div>
          {usage.cost != null ? <div>session cost: ${usage.cost.toFixed(6)}</div> : null}
          {trace?.model ? <div>model: {trace.model}</div> : null}
          {trace && (trace.effort || trace.mode)
            ? <div>this turn: {[trace.effort && `effort ${trace.effort}`, trace.mode && `mode ${trace.mode}`].filter(Boolean).join(", ")}</div>
            : null}
        </div>
      ) : null}
    </div>
  );
}

/** Everything that used to crowd the header: permission mode, thinking depth,
 *  read-aloud, dictation engine. One popover, next to the prompt it affects. */
function SettingsPopover({ v, prefs, setPrefs, onClose }: {
  v: SessionView;
  prefs: VoicePrefs;
  setPrefs: (patch: Partial<VoicePrefs>) => void;
  onClose: () => void;
}): JSX.Element {
  const info = v.info;
  const modes = info.modes?.availableModes ?? [];
  const cfg = info.configOptions.find((o) => o.type === "select" && /reason|effort|think/i.test(o.id));
  // re-render when the browser finally publishes its voice list
  const voiceCount = useSyncExternalStore(speaker.subscribeVoices, () => speaker.voices().length);
  const voices = voiceCount ? speaker.voices() : [];
  const caps = voiceCaps();
  return (
    <div className="settings-pop" role="dialog" aria-label="chat settings">
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
      {cfg?.options && (
        <div className="settings-group">
          <div className="settings-label"><IconGauge size={13} /> thinking depth</div>
          {cfg.options.map((o) => (
            <button
              key={String(o.value)}
              className={`settings-opt ${String(cfg.currentValue ?? "") === String(o.value) ? "sel" : ""}`}
              onClick={() => cockpit.send({ t: "set-config", sessionId: info.id, configId: cfg.id, value: o.value })}
            >
              {o.name}
            </button>
          ))}
        </div>
      )}
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
          <option value="auto">auto — browser if available</option>
          <option value="browser">browser{!browserDictationAvailable() ? " (unavailable)" : ""}</option>
          <option value="server">server{caps.stt.server ? ` (${caps.stt.model ?? "configured"})` : " (not configured)"}</option>
        </select>
        <input
          className="settings-input"
          value={prefs.lang}
          onChange={(e) => setPrefs({ lang: e.target.value })}
          placeholder="language, e.g. zh-CN"
          aria-label="speech language"
        />
        <div className="settings-note">
          browser dictation {browserDictationAvailable() ? "available" : "unavailable"} · server STT {caps.stt.server ? "configured" : "not configured"}
        </div>
      </div>
    </div>
  );
}

function Composer({ v }: { v: SessionView }): JSX.Element {
  const [text, setText] = useState("");
  // a phone-width placeholder that wraps to a second line just looks broken
  const placeholder = window.innerWidth < 720 ? "message… (/ for commands)" : "message… (Enter send, Shift+Enter newline, / for commands)";
  const [pick, setPick] = useState(0); // highlighted row in the slash palette
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [attachErr, setAttachErr] = useState("");
  const [dragging, setDragging] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [prefs, setPrefs] = useVoicePrefs();
  const dict = useDictation();
  const spoken = useSpeaker();
  const ta = useRef<HTMLTextAreaElement>(null);
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
    if (dict.status !== "idle" || !dict.text) return;
    const heard = dictation.consume();
    if (!heard) return;
    setText((cur) => (cur.trim() ? `${cur.trim()} ${heard}` : heard));
    ta.current?.focus();
  }, [dict.status, dict.text]);

  // Slash palette (AionUi F-DISPLAY-10): the commands are the AGENT's own
  // (available_commands_update over ACP) — we never invent a command list here.
  const slashQuery = /^\/\S*$/.test(text) ? text.slice(1).toLowerCase() : null;
  const matches = slashQuery === null ? [] : v.info.commands
    .filter((c) => c.name.toLowerCase().includes(slashQuery))
    .slice(0, 8);
  const paletteOpen = slashQuery !== null && v.info.status === "ready";

  const accept = (name: string) => {
    setText(`/${name} `);
    setPick(0);
    ta.current?.focus();
  };

  const listening = dict.status === "listening" || dict.status === "recording" || dict.status === "requesting";

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
      <UsageRow usage={v.info.usage} trace={v.trace} />
      <div className="composer-inner">
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
          <SettingsPopover v={v} prefs={prefs} setPrefs={setPrefs} onClose={() => setSettingsOpen(false)} />
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
        {listening || dict.status === "transcribing" || dict.error ? (
          <div className={`dict-chip ${dict.error ? "err" : ""}`}>
            <IconMic size={13} />
            {dict.error
              ? dict.error
              : dict.status === "requesting"
                ? "waiting for the microphone…"
                : dict.status === "transcribing"
                  ? "transcribing…"
                  : <>{dict.text} <span className="interim">{dict.interim}</span>{dict.engine === "server" ? ` · ${dict.seconds}s` : ""}</>}
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
            placeholder={v.info.status === "ready" ? placeholder : v.info.status}
            onChange={(e) => {
              setText(e.target.value);
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
          <div className="composer-bar">
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
            <button
              className={`icon-btn ${settingsOpen ? "on" : ""}`}
              title="chat settings — mode, thinking depth, voice"
              aria-label="chat settings"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((o) => !o)}
            >
              <IconSettings size={16} />
            </button>
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
                void dictation.start(prefs);
              }}
            >
              <IconMic size={16} />
            </button>
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

type BackendRow = { id: string; label: string; home?: string | null; blocked?: string | null };

function NewSessionModal({ onClose }: { onClose: () => void }): JSX.Element {
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
        <h3>New slot</h3>
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
        {backends.find((b) => b.id === backend)?.home && (
          <div className="hint">isolated home: {backends.find((b) => b.id === backend)!.home}</div>
        )}
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
