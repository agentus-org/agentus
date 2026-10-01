import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { cockpit, type MsgView, type SessionView } from "./state";
import { MiniMarkdown } from "./MiniMarkdown";
import type { ClientCommand } from "@agentslot/shared";

export function App(): JSX.Element {
  const snap = useSyncExternalStore(cockpit.subscribe, cockpit.getSnapshot);
  const [drawer, setDrawer] = useState(false);
  const [modal, setModal] = useState(false);

  useEffect(() => { cockpit.connect(); }, []);
  useEffect(() => { setDrawer(false); }, [snap.activeId]);

  return (
    <div className="app">
      {drawer && <div className="scrim" onClick={() => setDrawer(false)} />}
      <Sidebar open={drawer} onNew={() => setModal(true)} />
      <Main onMenu={() => setDrawer(true)} />
      {modal && <NewSessionModal onClose={() => setModal(false)} />}
    </div>
  );
}

function Sidebar({ open, onNew }: { open: boolean; onNew: () => void }): JSX.Element {
  const { sessions, activeId, conn } = useSyncExternalStore(cockpit.subscribe, cockpit.getSnapshot);
  return (
    <aside className={`sidebar ${open ? "open" : ""}`}>
      <header>
        <span className="logo">⛟ AgentSlot</span>
        <span className="tagline">keep your agents on the track</span>
      </header>
      <button className="new-btn" onClick={onNew}>+ new slot</button>
      <div className="session-list">
        {sessions.map((s) => (
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
        {!sessions.length && (
          <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 13 }}>
            No sessions yet — open a slot.
          </div>
        )}
      </div>
      <footer>
        <span className={`conn ${conn === "online" ? "" : "off"}`}>● {conn}</span>
        {" · "}
        <span title={location.hostname}>{location.host}</span>
      </footer>
    </aside>
  );
}

function Main({ onMenu }: { onMenu: () => void }): JSX.Element {
  const { active } = useSyncExternalStore(cockpit.subscribe, cockpit.getSnapshot);
  if (!active) {
    return (
      <div className="main">
        <div className="chat-head">
          <button className="menu-btn" onClick={onMenu}>☰</button>
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
      <ChatHead v={active} onMenu={onMenu} />
      <Stream v={active} />
      <Composer v={active} />
    </div>
  );
}

function ChatHead({ v, onMenu }: { v: SessionView; onMenu: () => void }): JSX.Element {
  const info = v.info;
  const modes = info.modes?.availableModes ?? [];
  const cfg = info.configOptions.find((o) => o.type === "select" && /reason|effort|think/i.test(o.id));
  return (
    <div className="chat-head">
      <button className="menu-btn" onClick={onMenu}>☰</button>
      <span className="title">{info.title}</span>
      {modes.length > 0 && (
        <select
          value={info.modes?.currentModeId ?? ""}
          onChange={(e) => cockpit.send({ t: "set-mode", sessionId: info.id, modeId: e.target.value })}
          title="permission mode"
        >
          {modes.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      )}
      {cfg && cfg.options && (
        <select
          value={String(cfg.currentValue ?? "")}
          onChange={(e) => cockpit.send({ t: "set-config", sessionId: info.id, configId: cfg.id, value: e.target.value })}
          title="reasoning effort"
        >
          {cfg.options.map((o) => <option key={o.value} value={o.value}>🧠 {o.name}</option>)}
        </select>
      )}
      <span className="kv" title={info.cwd}><code>{info.cwd}</code></span>
      {info.status === "running" ? (
        <button className="ghost-btn danger" onClick={() => cockpit.send({ t: "cancel", sessionId: info.id })}>
          ■ stop
        </button>
      ) : null}
      <button className="ghost-btn danger" onClick={() => cockpit.closeSession(info.id)}>close</button>
    </div>
  );
}

function Stream({ v }: { v: SessionView }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [, force] = useState(0);

  // stick-to-bottom (hermes-studio rule): follow only if user hasn't scrolled up
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  // idle hint: running but silent for >3min => "still waiting" (AionUi F-RELIABILITY-02 lite)
  useEffect(() => {
    if (!v.busy) return;
    const t = setTimeout(() => force((x) => x + 1), 180_000);
    return () => clearTimeout(t);
  }, [v.busy, v.msgs.length]);

  const showWait = v.busy && Date.now() - v.lastAt > 175_000;

  return (
    <div className="stream" ref={ref}>
      <div className="stream-inner">
        {v.perms.map((p) => <PermCard key={p.requestId} sid={v.info.id} req={p} />)}
        {v.msgs.map((m) => <Bubble key={m.key} m={m} />)}
        {v.busy && <div style={{ color: "var(--text-dim)", fontSize: 12.5 }}>▸ turn in progress…</div>}
        {showWait && <div style={{ color: "var(--text-dim)", fontSize: 12.5 }}>⏳ still waiting for the agent…</div>}
      </div>
    </div>
  );
}

function Bubble({ m }: { m: MsgView }): JSX.Element | null {
  switch (m.kind) {
    case "user":
      return <div className="msg user"><div className="role">YOU</div><div className="bubble">{m.text}</div></div>;
    case "agent":
      return <div className="msg agent"><div className="role">AGENT</div><div className="bubble"><MiniMarkdown text={m.text} /></div></div>;
    case "thought":
      return <Thought m={m} />;
    case "tool":
      return (
        <div className="msg">
          <div className={`tool-card ${m.status}`}>
            <div className="t">🔧 {m.title}</div>
            <div className="st">{m.kind2 ? `${m.kind2} · ` : ""}{m.status}</div>
          </div>
        </div>
      );
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
            onClick={() =>
              cockpit.send({
                t: "respond-permission", sessionId: sid, requestId: req.requestId,
                decision: { outcome: "cancelled" },
              })
            }
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

function Composer({ v }: { v: SessionView }): JSX.Element {
  const [text, setText] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);
  const send = () => {
    const t = text.trim();
    if (!t || v.busy || v.info.status !== "ready") return;
    cockpit.send({ t: "prompt", sessionId: v.info.id, text: t });
    setText("");
  };
  return (
    <div className="composer">
      <div className="composer-inner">
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder={v.info.status === "ready" ? "message… (Enter send, Shift+Enter newline)" : v.info.status}
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = "42px";
            e.target.style.height = Math.min(e.target.scrollHeight, window.innerHeight * 0.4) + "px";
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
          }}
        />
        <button className="send-btn" onClick={send} disabled={!text.trim() || v.busy || v.info.status !== "ready"}>
          {v.busy ? "…" : "⇥"}
        </button>
      </div>
    </div>
  );
}

function NewSessionModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [backend, setBackend] = useState("mock");
  const [cwd, setCwd] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [backends, setBackends] = useState<{ id: string; label: string }[]>([]);

  useEffect(() => {
    fetch("/api/backends").then((r) => r.json()).then(setBackends).catch(() => {});
  }, []);

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
          {(backends.length ? backends : [{ id: "mock", label: "Mock" }]).map((b) => (
            <button key={b.id} className={backend === b.id ? "sel" : ""} onClick={() => setBackend(b.id)}>
              {b.label}
            </button>
          ))}
        </div>
        <label>working directory (abs path)</label>
        <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/Users/me/project" />
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
