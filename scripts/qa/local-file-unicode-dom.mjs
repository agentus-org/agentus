// issue #110 DOM 红绿：本地文件链接/图片的非 ASCII 路径双重编码 + 空 alt 塌成 2px 点。
//
// 用真浏览器的 window.__renderMarkdown(md, base)（shipping 的 markdown 渲染入口）渲染：
//   ![单机](/中文路径/1-单机监控.png)   和   [磁盘](/中文路径/磁盘 监控.png)
// markdown-it 解析期已 mdurl.encode 非 ASCII/空格；修复前 localTarget 不解码 + rawFileUrl
// 再编一次 -> %25XX 双编码 -> /api/fs/raw 404；image 规则不填 alt -> <img alt=""> 2px 点。
//
// 断言（端到端，读真实 DOM 与真实 fetch）：
//   1. <img class=md-img> 的 src 单编码（含 %E5，不含 %25）
//   2. 该 src fetch 回来 200 image/png（真文件）
//   3. <img alt> 是真 alt 文本（不是空、不是 percent 串）
//   4. 链接 chip 的 data-file-path 是解码后的真实路径（含中文/空格）
//   5. 指向不存在文件的图片仍有非空 alt（不再是 2px 不可见的点）
//
// Usage: PORT=8901 CDP=http://127.0.0.1:9223 node scripts/qa/local-file-unicode-dom.mjs
import fs from 'node:fs';
import path from 'node:path';

const CDP = process.env.CDP || 'http://127.0.0.1:9223';
const PORT = Number(process.env.PORT || 8901);
const BASE = `http://127.0.0.1:${PORT}`;
const WORK = '/tmp/agentus-qa-unicode-files';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8Dwn4GBgYGJAQoAHgQCAZ7lYbQAAAAASUVORK5CYII=',
  'base64',
);
fs.mkdirSync(path.join(WORK, '中文路径'), { recursive: true });
const imgFile = path.join(WORK, '中文路径', '1-单机监控聚合.png');
const linkFile = path.join(WORK, '中文路径', '磁盘 监控.png');
fs.writeFileSync(imgFile, PNG);
fs.writeFileSync(linkFile, PNG);

const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: 'PUT' })).json();
await sleep(2000);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const waiting = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { const x = waiting.get(m.id); waiting.delete(m.id);
    m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); } };
const send = (method, params = {}, to = 30000) => new Promise((res, rej) => {
  const mid = ++id; const t = setTimeout(() => { waiting.delete(mid); rej(new Error('TIMEOUT ' + method)); }, to);
  waiting.set(mid, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expr, to = 30000) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, to);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result.value;
};

try {
  // dev 实例端口独立 cookie：先登录，否则 /api/fs/raw 一律 401
  const me = await ev(`fetch('/api/auth/me',{credentials:'same-origin'}).then(r=>r.json()).then(d=>d.authenticated)`);
  if (!me) {
    const code = await ev(`fetch('/api/auth/login',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({username:'scratch',password:'scratch-pass-1'})}).then(r=>r.status)`);
    check('logged into dev instance', code === 200, String(code));
    await ev('location.reload()');
    await sleep(2500);
  }
  const hasFn = await ev(`typeof window.__renderMarkdown === 'function'`);
  check('__renderMarkdown QA handle exists', hasFn === true);
  if (!hasFn) throw new Error('no markdown QA handle on this build');

  // agent 写 markdown 时链接目标会被 mdurl 编码（空格->%20，中文->%XX）；图片规则收到的是同样形态。
  const linkEncoded = linkFile.replace(/ /g, '%20');
  const md = `![单机监控](${imgFile})\n\n[磁盘监控](${linkEncoded})\n\n![不存在](${WORK}/中文路径/没有的文件.png)`;
  const html = await ev(`window.__renderMarkdown(${JSON.stringify(md)}, ${JSON.stringify(WORK)})`);
  console.log('---- rendered html ----\n' + html);

  // 1. 图片 src 单编码
  const imgSrc = await ev(`(() => { const d=document.createElement('div'); d.innerHTML=${JSON.stringify(html)};
    const img=d.querySelector('img.md-img'); return img ? img.getAttribute('src') : null })()`);
  check('image src is single-encoded (%E5 present, no %25)',
    !!imgSrc && imgSrc.includes('%E5') && !imgSrc.includes('%25'), imgSrc || '(no img)');

  // 2. 真 fetch src -> 200 image/png
  const status = await ev(`(async () => { const d=document.createElement('div'); d.innerHTML=${JSON.stringify(html)};
    const img=d.querySelector('img.md-img'); if(!img) return 'no-img';
    const r=await fetch(img.getAttribute('src')); return r.status + ' ' + r.headers.get('content-type') })()`);
  check('image src fetch returns 200 image/png', status === '200 image/png', String(status));

  // 3. alt 是真文本（不是空、不是 percent 串）
  const alt = await ev(`(() => { const d=document.createElement('div'); d.innerHTML=${JSON.stringify(html)};
    const img=d.querySelector('img.md-img'); return img ? img.getAttribute('alt') : null })()`);
  check('image alt is real text, not empty / not percent-encoded',
    alt === '单机监控', JSON.stringify(alt));

  // 4. 链接 chip 的 data-file-path 解码后真实路径
  const chip = await ev(`(() => { const d=document.createElement('div'); d.innerHTML=${JSON.stringify(html)};
    const a=d.querySelector('a.md-file-link'); return a ? a.getAttribute('data-file-path') : null })()`);
  check('file link data-file-path is decoded real path (CJK + space)',
    chip === linkFile, JSON.stringify(chip));

  // 5. 不存在的图片仍有非空 alt（不再 2px 点）
  const missingAlt = await ev(`(() => { const d=document.createElement('div'); d.innerHTML=${JSON.stringify(html)};
    const imgs=[...d.querySelectorAll('img.md-img')]; const m=imgs.find(x=>(x.getAttribute('src')||'').includes('%E6%B2%A1'));
    return m ? m.getAttribute('alt') : null })()`);
  check('missing image still has non-empty alt (no 2px dot)',
    !!missingAlt && missingAlt.length > 0, JSON.stringify(missingAlt));

} catch (e) {
  fail++;
  console.log(`FAIL  sweep threw  — ${e?.message ?? e}`);
} finally {
  try { await fetch(`${CDP}/json/close/${tab.id}`); } catch {}
  console.log(`\n${pass} passed / ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
