// 根证书卡 — 这台服务器的 HTTPS 是自签根签的，新设备头一次进来只会看到「不是私密连接」。
// 装一次根，之后这台设备就再也不用点「继续访问」，iOS 也才能把本站当安全上下文装到主屏。
//
// 三个设计约束，都是踩过的坑：
//  1) 必须登录后才能下载（服务端 /api/tls 自己就把门）：一个邀请你安装**信任锚**的页面不该匿名可访问。
//  2) 只能下载证书本身，绝不涉及私钥 —— 页面上要明说「只装你自己的设备」，因为装了它等于把
//     「本站是否可信」的判断权交给这台服务器的签发能力。
//  3) 三端分开写：安卓要进「加密与凭据」，iOS 装完描述文件还必须在「关于本机 → 证书信任设置」
//     里再打开一次开关（不做这步等于没装），macOS 要放进「系统」钥匙串并设成始终信任。写成一句
//     笼统的「安装证书」等于三端都不对。
import { useEffect, useState, type JSX } from "react";

type TlsInfo = {
  subject: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
  fingerprint256: string;
  bytes: number;
  selfSigned: boolean;
};

const HINT_KEY = "agentus.tls.card.seen";

/** OpenSSL 的 `Sep 30 13:39:12 2036 GMT` 对一个设置页来说太长也没必要 —— 只留日期（本地时区）。 */
function isoDay(s: string | undefined): string {
  const t = Date.parse(s ?? "");
  if (Number.isNaN(t)) return s ?? "—";
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 安卓的路径各家长得不一样，写一条最通用的 + 两家的偏门位置。 */
const STEPS: { os: string; items: JSX.Element[] }[] = [
  {
    os: "安卓",
    items: [
      <>用手机浏览器打开本页 → 点右边的「下载」（存进「下载」目录）。</>,
      <>设置 → 安全 → <b>加密与凭据</b> → 安装证书 → <b>CA 证书</b> → 选刚下载的 <code>agentus-ca.crt</code>。<br />
        <span className="tls-side">小米：安全 → 更多安全设置 → 加密与凭据；华为：安全 → 更多安全设置 → 加密和凭据。</span></>,
      <>系统会要求输一次锁屏密码，装完会有一条「网络可能会被监控」的提示 —— 那是系统对任何用户证书的标准警告。</>,
      <>Chrome 重进本站，地址栏不再报警。<b>伴侣 App 不用装</b>，它的 APK 里已经带了这张根。</>,
    ],
  },
  {
    os: "iPhone / iPad",
    items: [
      <>Safari 打开本页（会先报「不是私密连接」→ 显示详细信息 → 访问此网站）→ 点「下载」→「此网站正尝试下载配置描述文件」→ 允许。</>,
      <>设置 → 通用 → VPN 与设备管理 → <b>已下载的描述文件</b> → 安装 → 输锁屏密码。</>,
      <><b>关键一步</b>：设置 → 通用 → <b>关于本机</b> → 拉到底 → <b>证书信任设置</b> → 把这张根打开。不做这步，上一步等于没装。</>,
      <>Safari 重进本站不再报警；分享 → 添加到主屏幕，就能像 App 一样独立打开。</>,
    ],
  },
  {
    os: "电脑（Mac）",
    items: [
      <>点「下载」，双击 <code>agentus-ca.crt</code>。</>,
      <>钥匙串访问里把钥匙串选成 <b>系统</b> → 添加（要输一次管理员密码）。</>,
      <>在钥匙串里找到它 → 双击 → 展开「信任」→ 使用此证书时：<b>始终信任</b>。</>,
      <>或者一条命令：<br /><code className="tls-cmd">sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/Downloads/agentus-ca.crt</code></>,
    ],
  },
];

export function TrustCard(): JSX.Element {
  const [info, setInfo] = useState<TlsInfo | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "missing" | "error">("loading");
  const [err, setErr] = useState("");
  const [seen, setSeen] = useState(() => localStorage.getItem(HINT_KEY) === "1");

  useEffect(() => {
    let alive = true;
    fetch("/api/tls", { credentials: "same-origin" })
      .then(async (r) => {
        if (r.status === 404) { if (alive) setState("missing"); return null; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<TlsInfo>;
      })
      .then((d) => { if (!alive || !d) return; setInfo(d); setState("ok"); })
      .catch((e: Error) => { if (alive) { setErr(e.message); setState("error"); } });
    return () => { alive = false; };
  }, []);

  const dismiss = () => { localStorage.setItem(HINT_KEY, "1"); setSeen(true); };

  return (
    <section className="set-card" id="set-roots" data-setgroup="notify">
      <h3>根证书（自签 HTTPS）</h3>
      <p className="set-hint">
        本站的 HTTPS 由这台服务器的自签根签发。新设备第一次进来会看到「不是私密连接」——
        把这张根装一次，这台设备以后就直接是绿色的锁。
      </p>
      {!seen && (
        <div className="tls-once">
          <b>头一回看到这个？</b>只有全新设备才需要装，装过的设备不用再管。
          <button className="set-mini" onClick={dismiss}>知道了</button>
        </div>
      )}
      <p className="set-hint tls-warn">
        只装你自己的设备。信任一张根，等于把这台设备上「本站到底是不是真的」的判断权交给它 ——
        别装到别人的手机或公司的电脑上。
      </p>

      {state === "loading" && <p className="set-hint">正在读证书…</p>}
      {state === "missing" && (
        <p className="set-hint tls-warn">
          这台服务器没有配置根证书（<code>AGENTUS_CA_FILE</code> 未设置，默认位置也没有文件），所以这里没有可下载的东西。
        </p>
      )}
      {state === "error" && <p className="set-err">读证书失败：{err}</p>}

      {state === "ok" && info && (
        <div className="tls-cols">
          <div className="tls-left">
            {/* 不用 `download` 属性：iOS 只有「点链接 → 导航 → 收到 attachment + x-x509-ca-cert」
                才会弹「此网站正尝试下载配置描述文件」这套安装流程。带 download 属性时 Safari 会
                把它当成普通文件存进「文件」，描述文件那一步就没了。文件名靠响应头的
                Content-Disposition（agentus-ca.crt），桌面端照样落到下载目录。 */}
            <a className="tls-dl" href="/api/tls/ca.crt">
              下载 agentus-ca.crt
            </a>
            <p className="set-hint tls-meta">
              <span>{info.selfSigned ? "自签根" : "根证书"}</span>
              <span>{info.bytes} 字节</span>
              <span>到期 {isoDay(info.notAfter)}</span>
            </p>
            <p className="set-hint tls-meta">
              <span title={info.fingerprint256}>SHA-256 {info.fingerprint256.slice(0, 23)}…</span>
            </p>
            <p className="set-hint tls-side">{info.subject}</p>
          </div>
          <div className="tls-right">
            <div className="tls-steps-title">安装方法</div>
            {STEPS.map((s) => (
              <div key={s.os} className="tls-os">
                <div className="tls-os-name">{s.os}</div>
                <ol>{s.items.map((it, i) => <li key={i}>{it}</li>)}</ol>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
