// Account management: the account itself, the devices holding a session, and the IPs the
// login limiter has locked out.
//
// Shape follows hermes-studio's AccountSettings.vue (studied, not copied): the change
// actions are small modals rather than a form that sits open, each asking for the current
// password, and the login limiter is a visible list with an unlock button. Two things are
// ours, because this cockpit is single-operator and lives on a tunnel:
//   * the session registry — who is signed in, from where, when they were last seen, and a
//     button to drop one. Studio has no such list (its sessions are also cookie-based).
//   * the credential-epoch note: changing the password logs every other device out, so the
//     page says so before you do it.
import { useCallback, useEffect, useState } from "react";
import { IconClose, IconDevice, IconEye, IconEyeOff, IconLock } from "./Icons";

export interface AccountInfo {
  configuredUsername: string;
  credentialSource: "saved" | "env" | "default";
  minPasswordLen: number;
  usingDefaultPassword: boolean;
}

interface SessionRow {
  jti: string;
  username: string;
  ip: string;
  ua: string;
  issuedAt: number;
  expiresAt: number;
  lastSeen: number;
  current: boolean;
}

interface LockRow {
  ip: string;
  fails: number;
  locked: boolean;
  retryAfterMs: number;
}

const jsonHeaders = { "content-type": "application/json" };

/** "Chrome on macOS" beats a 120-character UA string in a settings list. */
function deviceLabel(ua: string): string {
  if (!ua) return "unknown client";
  const browser = /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : /curl\//.test(ua) ? "curl"
    : /node/i.test(ua) ? "script"
    : ua.slice(0, 24);
  const os = /Mac OS X|Macintosh/.test(ua) ? "macOS"
    : /iPhone|iPad/.test(ua) ? "iOS"
    : /Android/.test(ua) ? "Android"
    : /Windows/.test(ua) ? "Windows"
    : /Linux/.test(ua) ? "Linux"
    : "";
  return os ? `${browser} · ${os}` : browser;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}

function until(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时`;
  return `${Math.round(s / 86400)} 天`;
}

/** One dialog, studio-shaped: title, body, a cancel and a primary action. */
function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }): JSX.Element {
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal narrow" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="close"><IconClose size={13} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Password input with a reveal toggle — typing a new password twice is hard enough. */
function PasswordField({ value, onChange, label, placeholder, onEnter }: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder?: string;
  onEnter?: () => void;
}): JSX.Element {
  const [show, setShow] = useState(false);
  return (
    <>
      <label>{label}</label>
      <div className="pw-wrap">
        <input
          type={show ? "text" : "password"}
          value={value}
          autoComplete="off"
          aria-label={label}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && onEnter) onEnter(); }}
        />
        <button
          type="button"
          className="pw-eye"
          onClick={() => setShow((s) => !s)}
          title={show ? "隐藏" : "显示"}
          aria-label={show ? "hide password" : "show password"}
        >
          {show ? <IconEyeOff size={14} /> : <IconEye size={14} />}
        </button>
      </div>
    </>
  );
}

export function AccountPanels({ account, onChanged }: {
  account: AccountInfo | null;
  onChanged: (next: Partial<AccountInfo> & { username?: string }) => void;
}): JSX.Element {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [ttlMs, setTtlMs] = useState(0);
  const [locks, setLocks] = useState<LockRow[]>([]);
  const [limits, setLimits] = useState({ maxFails: 5, lockMs: 30000 });
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const [userOpen, setUserOpen] = useState(false);
  const [passOpen, setPassOpen] = useState(false);
  const [curPw, setCurPw] = useState("");
  const [newUser, setNewUser] = useState("");
  const [newPw, setNewPw] = useState("");
  const [again, setAgain] = useState("");

  const flash = (text: string): void => {
    setMsg(text);
    window.setTimeout(() => setMsg(""), 4000);
  };

  const loadSessions = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/auth/sessions", { credentials: "same-origin" });
      const data = (await res.json().catch(() => ({}))) as { sessions?: SessionRow[]; ttlMs?: number };
      if (res.ok) { setSessions(data.sessions ?? []); if (data.ttlMs) setTtlMs(data.ttlMs); }
    } catch { /* the card just stays empty */ }
  }, []);

  const loadLocks = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/auth/locked-ips", { credentials: "same-origin" });
      const data = (await res.json().catch(() => ({}))) as { locks?: LockRow[]; maxFails?: number; lockMs?: number };
      if (res.ok) {
        setLocks(data.locks ?? []);
        setLimits({ maxFails: data.maxFails ?? 5, lockMs: data.lockMs ?? 30000 });
      }
    } catch { /* ditto */ }
  }, []);

  useEffect(() => { void loadSessions(); void loadLocks(); }, [loadSessions, loadLocks]);

  const change = async (body: Record<string, string>, what: string): Promise<boolean> => {
    setBusy(what);
    setErr("");
    try {
      const res = await fetch("/api/auth/credentials", {
        method: "POST", credentials: "same-origin", headers: jsonHeaders, body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; username?: string; credentialSource?: string; usingDefaultPassword?: boolean };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      onChanged({
        username: data.username,
        configuredUsername: data.username,
        credentialSource: (data.credentialSource as AccountInfo["credentialSource"]) ?? "saved",
        usingDefaultPassword: Boolean(data.usingDefaultPassword),
      });
      await loadSessions(); // the password path mints a new session for this browser
      return true;
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
      return false;
    } finally {
      setBusy("");
    }
  };

  const saveUsername = async (): Promise<void> => {
    setErr("");
    const user = newUser.trim();
    if (user.length < 2) { setErr("用户名至少 2 位"); return; }
    if (user === account?.configuredUsername) { setErr("和现在的用户名一样"); return; }
    if (await change({ currentPassword: curPw, username: user }, "user")) {
      setUserOpen(false); setCurPw(""); setNewUser("");
      flash("用户名已更新");
    }
  };

  const savePassword = async (): Promise<void> => {
    setErr("");
    if (newPw !== again) { setErr("两次输入的新密码不一致"); return; }
    if (newPw.length < (account?.minPasswordLen ?? 6)) { setErr(`密码至少 ${account?.minPasswordLen ?? 6} 位`); return; }
    if (await change({ currentPassword: curPw, newPassword: newPw }, "pass")) {
      setPassOpen(false); setCurPw(""); setNewPw(""); setAgain("");
      flash("密码已更新；其他设备已登出");
    }
  };

  const revoke = async (jti: string): Promise<void> => {
    setBusy(jti); setErr("");
    try {
      const res = await fetch("/api/auth/sessions/revoke", { method: "POST", credentials: "same-origin", headers: jsonHeaders, body: JSON.stringify({ jti }) });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
      await loadSessions();
      flash("已撤销该设备");
    } catch (e) { setErr(String((e as Error)?.message ?? e)); } finally { setBusy(""); }
  };

  const revokeOthers = async (): Promise<void> => {
    setBusy("others"); setErr("");
    try {
      const res = await fetch("/api/auth/sessions/revoke-others", { method: "POST", credentials: "same-origin" });
      const data = (await res.json().catch(() => ({}))) as { count?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      await loadSessions();
      flash(data.count ? `已登出其他 ${data.count} 个会话` : "没有其他会话");
    } catch (e) { setErr(String((e as Error)?.message ?? e)); } finally { setBusy(""); }
  };

  const unlock = async (ip?: string): Promise<void> => {
    setBusy(ip ?? "all"); setErr("");
    try {
      const res = await fetch(`/api/auth/locked-ips${ip ? `?ip=${encodeURIComponent(ip)}` : ""}`, { method: "DELETE", credentials: "same-origin" });
      const data = (await res.json().catch(() => ({}))) as { count?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      await loadLocks();
      flash(ip ? `已解除 ${ip} 的锁定` : `已解除全部锁定（${data.count ?? 0}）`);
    } catch (e) { setErr(String((e as Error)?.message ?? e)); } finally { setBusy(""); }
  };

  const others = sessions.filter((s) => !s.current).length;
  // Every login mints a session and only its browser keeps the newest cookie, so a machine
  // that logs in repeatedly leaves orphan rows behind. They are still valid cookies (that is
  // why they are listed) but a long list is noise: show the recent ones and say how many more.
  const shown = sessions.slice(0, 8);

  return (
    <>
      {/* ---------- 账号 ---------- */}
      <section className="set-card">
        <h3>账号</h3>
        <p className="set-hint">
          {account?.credentialSource === "default" ? (
            <>现在是<b>内置默认口令</b>（<code>admin / 123456</code>），对公网开放时务必改掉。</>
          ) : account?.credentialSource === "env" ? (
            <>当前口令来自环境变量（<code>AGENTSLOT_USERNAME</code> / <code>AGENTSLOT_PASSWORD</code>）；
              在这里保存后以本页为准，环境变量只当引导。</>
          ) : (
            <>当前口令存在数据目录的 <code>credentials.json</code>（0600，scrypt 哈希，明文不落盘）。</>
          )}
          {" "}改密码会让<b>其他设备</b>立刻登出（本机自动续上）。
        </p>
        <div className="set-row">
          <label>当前账号</label>
          <div className="set-pair">
            <span className="acct-name">{account?.configuredUsername ?? "—"}</span>
            <button className="set-mini" onClick={() => { setErr(""); setUserOpen(true); }}>改用户名</button>
            <button className="set-mini" onClick={() => { setErr(""); setPassOpen(true); }}>改密码</button>
            {msg ? <span className="set-toast">{msg}</span> : null}
            {err && !userOpen && !passOpen ? <span className="set-inline-err">{err}</span> : null}
          </div>
        </div>
      </section>

      {/* ---------- 登录会话 ---------- */}
      <section className="set-card">
        <h3><IconDevice size={14} /> 登录会话</h3>
        <p className="set-hint">
          每个浏览器/脚本各占一行；会话有效期 {ttlMs ? Math.round(ttlMs / 86400000) : 7} 天，
          可以单独踢掉一台设备。改密码等于把其他设备全部登出。
        </p>
        <div className="acct-list">
          {sessions.length === 0 ? <div className="acct-empty">没有可显示的会话</div> : null}
          {shown.map((s) => (
            <div className="acct-row" key={s.jti}>
              <div className="acct-main">
                <span className="acct-name">
                  {deviceLabel(s.ua)}
                  {s.current ? <span className="acct-badge">当前</span> : null}
                </span>
                <span className="acct-sub">
                  {s.ip || "未知 IP"} · {s.current ? "现在" : `活跃 ${ago(s.lastSeen)}`} · 到期还有 {until(s.expiresAt - Date.now())}
                </span>
              </div>
              {s.current ? (
                <span className="acct-when">这台设备</span>
              ) : (
                <button className="set-mini danger" disabled={busy === s.jti} onClick={() => void revoke(s.jti)}>
                  {busy === s.jti ? "…" : "撤销"}
                </button>
              )}
            </div>
          ))}
          {sessions.length > shown.length ? (
            <div className="acct-empty">还有 {sessions.length - shown.length} 个会话未列出 —— 点“登出其他设备”可以一次清掉。</div>
          ) : null}
        </div>
        <div className="set-row">
          <label />
          <div className="set-pair">
            <button className="set-mini" onClick={() => void loadSessions()} disabled={busy === "reload"}>刷新</button>
            <button className="set-mini danger" onClick={() => void revokeOthers()} disabled={busy === "others" || others === 0}>
              {busy === "others" ? "…" : others ? `登出其他设备（${others}）` : "没有其他设备"}
            </button>
          </div>
        </div>
      </section>

      {/* ---------- 登录失败锁定 ---------- */}
      <section className="set-card">
        <h3><IconLock size={14} /> 登录失败锁定</h3>
        <p className="set-hint">
          同一个 IP 连续失败 {limits.maxFails} 次会被锁定 {Math.round(limits.lockMs / 1000)} 秒
          （防爆破；把自己锁在门外时可以在这里放行）。清单在内存里，重启即清空。
        </p>
        <div className="acct-list">
          {locks.length === 0 ? <div className="acct-empty">没有失败的来源，也没有被锁的 IP</div> : null}
          {locks.map((l) => (
            <div className="acct-row" key={l.ip}>
              <div className="acct-main">
                <span className="acct-name">
                  {l.ip}
                  {l.locked ? <span className="acct-badge danger">已锁定 {until(l.retryAfterMs)}</span> : null}
                </span>
                <span className="acct-sub">
                  {l.locked ? `剩余 ${until(l.retryAfterMs)} 后自动解除` : `已失败 ${l.fails} 次`}
                </span>
              </div>
              <button className="set-mini" disabled={busy === l.ip} onClick={() => void unlock(l.ip)}>
                {busy === l.ip ? "…" : "解锁"}
              </button>
            </div>
          ))}
        </div>
        <div className="set-row">
          <label />
          <div className="set-pair">
            <button className="set-mini" onClick={() => void loadLocks()}>刷新</button>
            <button className="set-mini danger" disabled={busy === "all" || locks.length === 0} onClick={() => void unlock()}>
              {busy === "all" ? "…" : "全部解锁"}
            </button>
          </div>
        </div>
      </section>

      {userOpen ? (
        <Modal title="改用户名" onClose={() => { setUserOpen(false); setErr(""); }}>
          <PasswordField label="当前密码" value={curPw} onChange={setCurPw} placeholder="改之前先证明是你" />
          <label>新用户名</label>
          <input
            value={newUser}
            autoComplete="off"
            aria-label="new username"
            placeholder={account?.configuredUsername ?? ""}
            onChange={(e) => setNewUser(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void saveUsername(); }}
          />
          {err ? <div className="err">{err}</div> : null}
          <div className="row">
            <button className="cancel" onClick={() => { setUserOpen(false); setErr(""); }}>取消</button>
            <button className="go" disabled={busy === "user" || !curPw || !newUser.trim()} onClick={() => void saveUsername()}>
              {busy === "user" ? "…" : "保存"}
            </button>
          </div>
        </Modal>
      ) : null}

      {passOpen ? (
        <Modal title="改密码" onClose={() => { setPassOpen(false); setErr(""); }}>
          <PasswordField label="当前密码" value={curPw} onChange={setCurPw} />
          <PasswordField label="新密码" value={newPw} onChange={setNewPw} placeholder={`至少 ${account?.minPasswordLen ?? 6} 位`} />
          <PasswordField label="确认新密码" value={again} onChange={setAgain} onEnter={() => void savePassword()} />
          <div className="set-hint">保存后其他设备会被登出；本机自动续上。</div>
          {err ? <div className="err">{err}</div> : null}
          <div className="row">
            <button className="cancel" onClick={() => { setPassOpen(false); setErr(""); }}>取消</button>
            <button className="go" disabled={busy === "pass" || !curPw || !newPw || !again} onClick={() => void savePassword()}>
              {busy === "pass" ? "…" : "保存"}
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
