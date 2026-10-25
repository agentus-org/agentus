// 通话页里的文字到底看得见吗？—— 这是在 live 上被肉眼抓到的问题，所以判据必须是像素级的。
//
// 形状：电话页（`.call-mode`）自己声明了一套**暗色**调色板（它是自己的表面，像视频通话画面），
// 但里面的行是聊天页的原件（`renderTranscript`），会去读这个块**没有覆盖**的变量 ——
// 展开的工具体读 `--bg`、行内代码读 `--chip-bg`。浅色主题下那两个值是浅的，而这里的正文是
// 近白的 `--text`：实测 1.05:1 与 1.04:1，就是操作员说的「白底白字，啥也看不清」。
//
// 这个守卫不看源码猜，只量：把**构建产物里的 CSS** 原样注入一个空页面，摆出真实的行结构，
// 在两个主题下量每个带文字的元素的字色与它实际坐着的表面，断言对比度 ≥ 4.5:1。
// 顺带反过来量聊天页本身（`.app-outside`），保证修通话页不是把正常页面也弄成暗的。
//
//   node scripts/qa/call-contrast.mjs          # 退出码即判决
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CDP = process.env.CDP ?? "http://127.0.0.1:9223";
const DIST = path.join(ROOT, "packages/web/dist/assets");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const cssFile = fs.readdirSync(DIST).find((f) => f.endsWith(".css"));
if (!cssFile) {
  console.error(`no built css under ${DIST} — run \`npm run build\` first`);
  process.exit(2);
}
const css = fs.readFileSync(path.join(DIST, cssFile), "utf8");

// A dark page, because the sheet is translucent and sits on the call's own backdrop: measuring it
// over white photographed a bug that is not there (the sheet itself washed out, 1.08:1).
const html = `<!doctype html><html><head><style>${css}</style></head>
<body style="margin:0;background:#05080c"><div id="host"></div></body></html>`;

const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent("data:text/html," + encodeURIComponent(html))}`, { method: "PUT" })).json();
await sleep(1200);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const waiting = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { const x = waiting.get(m.id); waiting.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); }
};
const send = (method, params = {}, to = 30000) => new Promise((res, rej) => {
  const mid = ++id; const timer = setTimeout(() => { waiting.delete(mid); rej(new Error("TIMEOUT " + method)); }, to);
  waiting.set(mid, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expr, to = 30000) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, to);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};

// The rows, exactly as `renderTranscript` emits them: an agent bubble with inline code and a fenced
// block, and a tool card whose body is open (the operator opens it by hand — so the guard leaves it
// open instead of hoping a click happens somewhere else).
const BUILD = `(() => {
  const host = document.getElementById('host');
  host.innerHTML = \`
  <div class="call-mode" data-phase="speaking">
    <div class="call-cc">
      <div class="call-cc-list">
        <div class="call-cc-inner">
          <div class="msg agent">
            <div class="role">AGENT</div>
            <div class="bubble"><div class="md">
              <p>先跑 <code>npm run build</code> 再看结果。</p>
              <pre class="md-code"><code>npm run build &amp;&amp; echo done</code></pre>
            </div></div>
          </div>
          <div class="msg">
            <div class="tool-card completed">
              <button class="tool-head"><span class="tool-dot ok"></span><span class="tool-title">Read /tmp/x.ts</span></button>
              <div class="tool-body">
                <div class="lbl">input</div><pre>{"path":"/tmp/x.ts"}</pre>
                <div class="lbl">output</div><pre>line one of output
line two of output</pre>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div class="app-outside"><div class="msg agent"><div class="bubble"><div class="md"><p>正文里的 <code>inline</code> 代码</p></div></div></div></div>\`;
  return true; })()`;

const MEASURE = `(() => {
  const parse = (c) => { const m = String(c).match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
    const p = m[1].split(',').map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const blend = (fg, bg) => ({ r: Math.round(fg.r * fg.a + bg.r * (1 - fg.a)), g: Math.round(fg.g * fg.a + bg.g * (1 - fg.a)),
    b: Math.round(fg.b * fg.a + bg.b * (1 - fg.a)), a: 1 });
  const surfaceOf = (el) => {
    const stack = []; let n = el;
    while (n && n !== document.documentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0) stack.push(c); n = n.parentElement; }
    let out = parse(getComputedStyle(document.body).backgroundColor) ?? { r: 255, g: 255, b: 255, a: 1 };
    for (let i = stack.length - 1; i >= 0; i--) out = blend(stack[i], out);
    return out;
  };
  const rows = [];
  const add = (label, sel) => {
    const el = document.querySelector(sel); if (!el) { rows.push({ label, sel, missing: true }); return; }
    const cs = getComputedStyle(el);
    const fg = parse(cs.color); const own = parse(cs.backgroundColor);
    const surf = surfaceOf(el);
    const seen = own && own.a > 0 ? blend(own, surf) : surf;
    const l1 = lum(fg), l2 = lum(seen);
    rows.push({ label, sel, color: cs.color, bg: \`rgb(\${seen.r},\${seen.g},\${seen.b})\`,
      ratio: Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100 });
  };
  add('通话正文里的行内代码', '#host .call-cc .md code');
  add('通话正文（agent 气泡）', '#host .call-cc .msg .bubble');
  add('通话里的围栏代码块文字', '#host .call-cc .md pre.md-code code');
  add('工具卡标题行', '#host .call-cc .tool-head');
  add('工具卡展开体 input/output', '#host .call-cc .tool-body pre');
  add('工具卡展开体的标签', '#host .call-cc .tool-body .lbl');
  add('（对照）聊天页行内代码', '#host .app-outside .md code');
  return { theme: document.documentElement.dataset.theme, rows }; })()`;

try {
  for (const theme of ["light", "dark"]) {
    await ev(`(() => { document.documentElement.dataset.theme = ${JSON.stringify(theme)}; return true; })()`);
    await ev(BUILD);
    await sleep(200);
    const res = await ev(MEASURE);
    console.log(`\n===== 主题 ${res.theme}`);
    for (const r of res.rows) {
      if (r.missing) { check(`${theme} · ${r.label} 存在`, false, r.sel); continue; }
      console.log(`  ${r.label}: 字 ${r.color} 面 ${r.bg} 对比 ${r.ratio}:1`);
      // 4.5:1 is WCAG AA for body text; the sheet's own rows are 12–13px, which AA does not exempt.
      check(`${theme} · ${r.label} 看得清（≥4.5:1）`, r.ratio >= 4.5, `${r.ratio}:1`);
    }
    // the sheet must not borrow the page's palette: inside it the two themes are the same picture
    const same = await ev(`(() => {
      const read = () => getComputedStyle(document.querySelector('#host .call-cc .md code')).backgroundColor;
      const before = read();
      document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      const after = read();
      document.documentElement.dataset.theme = ${JSON.stringify(theme)};
      return before === after; })()`);
    check(`${theme} · 通话页的行内代码底色不随主题变（它有自己的暗色表面）`, same === true);
  }
} finally {
  try { ws.close(); } catch { /* ignore */ }
  await fetch(`${CDP}/json/close/${tab.id}`).catch(() => {});
}
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
