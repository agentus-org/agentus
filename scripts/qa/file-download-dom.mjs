// 文件面板的「下载」必须是下载，不是跳转（operator: 「文件下载的时候，好像是直接跳转成一个链接，
// 而不是直接下载」）。
//
// 原来 head 上那颗下载图标接的是 `window.open(rawFileUrl(path), "_blank")`，而 `/api/fs/raw` 一律
// `content-disposition: inline` —— 于是 PDF 在标签页里展开、文本文件被显示成纯文本、图片变成看图，
// 下载目录里什么都没有。操作员点的是「下载」，得到的是「跳转」。
//
// 这个 sweep 钉的是两端：
//   ① head 的下载动作是真下载（`<a download>` + `?download=1`），CDP 收到 downloadWillBegin，
//      落盘的文件名就是文件自己的名字（这里故意用中文+空格，验 RFC 5987 的 filename*）；
//   ② 预览行为没被破坏 —— `<img>` / `<iframe>` 取的还是 inline 的那条 URL，另有一颗「新标签打开」。
//
//   AGENTUS_BASE=http://127.0.0.1:8901 CDP_URL=http://127.0.0.1:9223 node scripts/qa/file-download-dom.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";
const BASE = process.env.AGENTUS_BASE || "http://127.0.0.1:8901";
const USER = process.env.AGENTUS_USER || "scratch";
const PASS = process.env.AGENTUS_PASS || "scratch-pass-1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// ---- 素材：一个名字里带中文和空格的文件，和一个真 PNG（预览路径的对照） ------------------
const NAME = "中文 名称 测试.txt";
const BODY = "中文文件下载测试\nsecond line\n";
fs.writeFileSync(path.join("/tmp", NAME), BODY);
// 1x1 png
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");
fs.writeFileSync("/tmp/dl-shot.png", PNG);

const DL = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-dl-"));

const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(1500);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const waiting = new Map();
/** Everything CDP pushes at us that we care about (downloads arrive as events, not replies). */
const events = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) {
    const x = waiting.get(m.id); waiting.delete(m.id);
    m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result);
    return;
  }
  if (m.method) events.push(m);
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id; waiting.set(mid, { res, rej });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
const goto = async (url) => { await send("Page.navigate", { url }); await sleep(3200); };

await send("Page.enable");
await send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: DL });

await goto(BASE);
const status = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({username:${JSON.stringify(USER)},password:${JSON.stringify(PASS)}})}).then(r=>r.status)`);
check("logged in", status === 200, `status ${status}`);

// 一个 cwd=/tmp 的 mock 会话，文件面板才列得出 /tmp 里的素材。
const created = await ev(`fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({backend:'mock',cwd:'/tmp',title:'file download check'})}).then(r=>r.json())`);
const sid = created?.session?.id ?? created?.id;
check("打开了 /tmp 的会话（文件面板以它的 cwd 为根）", Boolean(sid), JSON.stringify(created).slice(0, 120));

await send("Emulation.setDeviceMetricsOverride", { width: 1300, height: 900, deviceScaleFactor: 1, mobile: false });
await goto(BASE);
await sleep(800);
await ev(`(() => { const row = [...document.querySelectorAll('.session-item')]
  .find(r => (r.textContent || '').includes('file download check')); if (row) row.click(); return Boolean(row); })()`);
await sleep(2500);
await ev(`(() => { const b = document.querySelector('.chat-head button[aria-label="file browser"]'); if (b) b.click(); return true; })()`);
await sleep(2000);

// ---- 隐藏文件必须在列表里（operator: 「文件浏览器里面隐藏文件也要支持显示出来」） -------------
// 造两个 dot-entry，再读真页面：它们得出现在列表里、排在同组末尾、带 hidden 的淡化标记。
fs.writeFileSync("/tmp/.agentus-hidden-check.md", "hidden file body\n");
fs.mkdirSync("/tmp/.agentus-hidden-dir", { recursive: true });
await ev(`(() => { const b = document.querySelector('.file-bar button[aria-label="refresh"]')
  || [...document.querySelectorAll('.file-bar button')].pop(); if (b) b.click(); return true; })()`);
await sleep(1800);
const rows = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('.file-row')].map(r => ({
  name: (r.querySelector('.file-name')?.textContent || '').trim(),
  hidden: r.classList.contains('hidden-file'),
})))`));
check("隐藏文件出现在文件浏览器里", rows.some((r) => r.name === ".agentus-hidden-check.md"),
  rows.map((r) => r.name).join(","));
check("…隐藏目录也在", rows.some((r) => r.name === ".agentus-hidden-dir"), rows.map((r) => r.name).join(","));
check("…它们带淡化的 hidden 标记（不是假装和普通文件一样）",
  rows.filter((r) => r.name.startsWith(".agentus-hidden-")).every((r) => r.hidden === true),
  JSON.stringify(rows.filter((r) => r.name.startsWith(".agentus-hidden-"))));
const firstDot = rows.findIndex((r) => r.name.startsWith("."));
check("…并且沉到列表后段（普通项先出现）",
  firstDot === -1 || rows.slice(0, firstDot).every((r) => !r.name.startsWith(".")), `first dot at ${firstDot}/${rows.length}`);

// 点开那个文件
const opened = await ev(`(() => {
  const row = [...document.querySelectorAll('.file-row')].find(r => (r.textContent || '').includes(${JSON.stringify(NAME)}));
  if (!row) return false; row.click(); return true;
})()`);
check("文件面板里点得开那个文件", opened === true);
await sleep(1500);

// ---- ① head 的下载是一个真下载 --------------------------------------------------------------
const dlLink = JSON.parse(await ev(`(() => {
  const a = document.querySelector('.file-preview-head a[aria-label="download file"]');
  if (!a) return JSON.stringify({ found: false });
  return JSON.stringify({ found: true, tag: a.tagName, download: a.getAttribute('download'),
    href: a.getAttribute('href'), title: a.getAttribute('title'), target: a.getAttribute('target') });
})()`));
check("head 的下载是一颗 <a>（不是 window.open 的按钮）", dlLink.found === true && dlLink.tag === "A",
  JSON.stringify(dlLink));
check("…它带 download 属性，文件名就是文件自己的名字（中文与空格保留）", dlLink.download === NAME, String(dlLink.download));
check("…地址带 ?download=1（服务端据此发 attachment，不只是靠属性）", String(dlLink.href || "").includes("download=1"), String(dlLink.href));

// —— 服务端的两种 disposition 必须分开：一个是 attachment，一个是 inline
const headers = JSON.parse(await ev(`(async () => {
  const p = encodeURIComponent('/tmp/' + ${JSON.stringify(NAME)});
  const dl = await fetch('/api/fs/raw?path=' + p + '&download=1');
  const inline = await fetch('/api/fs/raw?path=' + p);
  return JSON.stringify({ dl: dl.headers.get('content-disposition'), inline: inline.headers.get('content-disposition') });
})()`));
check("?download=1 回 attachment 且带 RFC 5987 的 filename*",
  /^attachment;/.test(String(headers.dl)) && String(headers.dl).includes("filename*=UTF-8''"), String(headers.dl));
check("…filename* 里是真正的名字（百分号编码的 UTF-8，不是下划线）",
  String(headers.dl).includes(encodeURIComponent(NAME).slice(0, 12)), String(headers.dl));
check("不带 download 时仍然是 inline（预览走的就是这条）", headers.inline === "inline", String(headers.inline));

// —— 真的点一下，看浏览器有没有落盘
const before = events.length;
const tabsBeforeIds = new Set((await fetch(`${CDP}/json/list`).then((r) => r.json()))
  .filter((t) => t.type === "page").map((t) => t.id));
await ev(`document.querySelector('.file-preview-head a[aria-label="download file"]').click(); true`);
await sleep(2500);
const began = events.slice(before).find((m) => m.method === "Page.downloadWillBegin");
const progress = events.slice(before).filter((m) => m.method === "Page.downloadProgress").pop();
check("点击触发了真正的下载（Page.downloadWillBegin，不是新标签）", Boolean(began),
  JSON.stringify(events.slice(before).map((m) => m.method)));
check("…浏览器建议的文件名就是文件自己的名字", began?.params?.suggestedFilename === NAME, String(began?.params?.suggestedFilename));
check("…下载completed", progress?.params?.state === "completed", JSON.stringify(progress?.params ?? null));
const landed = fs.readdirSync(DL).filter((f) => f !== ".DS_Store");
check("…文件真的落到了下载目录", landed.includes(NAME), landed.join(" | "));
if (landed.includes(NAME)) {
  check("…落盘内容与磁盘上的原文件一致",
    fs.readFileSync(path.join(DL, NAME), "utf8") === BODY,
    JSON.stringify(fs.readFileSync(path.join(DL, NAME), "utf8").slice(0, 40)));
}
// 旧行为是 `window.open(_blank)` —— 它不会报错，只会多出一个标签页；所以这条要跟点击前的数量比。
const tabsNow = (await fetch(`${CDP}/json/list`).then((r) => r.json())).filter((t) => t.type === "page");
// Edge opens its own `edge://downloads/hub` panel to show a finished download — browser chrome, not
// a page the click navigated to. Only real pages count.
const fresh = tabsNow.filter((t) => !tabsBeforeIds.has(t.id) && /^https?:/.test(t.url || ""));
check("…点下载没有顺带弹出标签页（旧实现是 window.open(_blank)，它只会多一个页面）",
  fresh.length === 0, `${tabsBeforeIds.size} → ${tabsNow.length}; new: ${JSON.stringify(fresh.map((t) => t.url).slice(0, 3))}`);

// ---- ② 「新标签打开」还在一颗上，且它拿的是 inline 那条 --------------------------------------
const openLink = JSON.parse(await ev(`(() => {
  const a = document.querySelector('.file-preview-head a[aria-label="open raw"]');
  if (!a) return JSON.stringify({ found: false });
  return JSON.stringify({ found: true, href: a.getAttribute('href'), target: a.getAttribute('target') });
})()`));
check("「新标签打开」仍在（下载没有把它顶掉）", openLink.found === true && openLink.target === "_blank",
  JSON.stringify(openLink));
check("…它指向 inline 的那条地址（不带 download=1）", !String(openLink.href || "").includes("download="), String(openLink.href));

// ---- ③ 预览没有被破坏：图片走 inline，不弹下载 ---------------------------------------------
const imgOpened = await ev(`(() => {
  const row = [...document.querySelectorAll('.file-row')].find(r => (r.textContent || '').includes('dl-shot.png'));
  if (!row) return false; row.click(); return true;
})()`);
check("能打开图片预览（对照项）", imgOpened === true);
await sleep(1500);
const img = JSON.parse(await ev(`(() => {
  const el = document.querySelector('.file-preview-body img.file-image');
  return JSON.stringify({ src: el ? el.getAttribute('src') : null });
})()`));
check("图片预览的 src 是不带 download=1 的那条（attachment 会渲染成空白）",
  Boolean(img.src) && img.src.includes("/api/fs/raw?") && !img.src.includes("download="), String(img.src));

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
await send("Page.close").catch(() => {});
ws.close();
process.exit(fail === 0 ? 0 : 1);
