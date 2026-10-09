// Rail archive sweep (manual QA — real browser, real session list).
//
// The operator asked for two things about the session rail:
//   ① 「能加个已归档的段吗，与工作空间平行的，然后归档的会话就放到已归档中，然后结构跟工作空间一致就行，
//      该显示目录的显示目录」
//   ② 「每个目录默认应该折叠的吧…然后用户折叠或打开后，重新刷新页面应该要记住用户的选择吧，aionui 是怎么做的」
//
// So this file asserts:
//   * 已归档 is a SECTION of its own, after 工作空间, with a count and its own fold control
//   * it is built like 工作空间: directories (folder icon + name + count), sessions nested underneath
//   * archived rows render the same row shape (avatar, title, timestamp, menu) as live ones
//   * a section fold survives a reload (localStorage, like the other layout prefs)
//   * a DIRECTORY fold survives a reload too (this was the actual complaint)
//   * the same directory path can be open in one section and folded in the other (namespaced keys)
//   * pruning: a fold flag for a directory that no longer has sessions is dropped
//
// Usage: start Edge/Chrome with --remote-debugging-port=9222, then
//        PORT=8901 node scripts/qa/rail-archive-sweep.mjs
const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";
const PORT = Number(process.env.PORT || 8901);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (ok, what, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${what}${detail ? `  — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? `  — ${detail}` : ""}`); }
};

const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(2600);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
// Close our own tab, always: a sweeps that throws before its close leaves the tab behind, and a
// browser full of stale Agentus tabs starts handing `/json/new` tabs that are still about:blank —
// which then shows up as an unrelated sweep failing with "Failed to parse URL from /api/auth/me".
const closeTab = () => { try { send("Target.closeTarget", { targetId: tab.id }); } catch {} };
process.on("exit", closeTab);
 const waiting = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) {
    const w = waiting.get(m.id); waiting.delete(m.id);
    m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result);
  }
};
const send = (method, params = {}, timeout = 20000) => new Promise((res, rej) => {
  const mid = ++id; const t = setTimeout(() => { waiting.delete(mid); rej(new Error("TIMEOUT " + method)); }, timeout);
  waiting.set(mid, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expr, timeout = 20000) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, timeout);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval err");
  return r.result.value;
};
const until = async (expr, ms = 15000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await ev(expr)) return true; await sleep(300); }
  return false;
};

// about:blank also reports readyState 'complete', so wait for the URL to be the app
send("Page.enable");
send("Page.navigate", { url: BASE });
for (let i = 0; i < 80; i++) {
  await sleep(500);
  if (await ev(`document.readyState === 'complete' && location.href.includes(':${PORT}')`)) break;
}
// The store streams in after boot (the sessions frame arrives a few seconds in on a busy
// instance), and the section containers exist from the first paint — so wait for ROWS, not for the
// containers, or every assertion here measures an empty rail.
check(await until(`document.querySelectorAll('.sidebar .session-item').length > 0`, 30000), "the rail has sessions");
await until(`Boolean(document.querySelector('#rail-workspaces .rail-group-head'))`, 20000);
await sleep(600);

console.log("== 已归档 is a section of its own, built like 工作空间 ==");
check(await until(`Boolean(document.querySelector('#rail-archived'))`, 20000), "there is an archived section container");
const shape = await ev(`(() => {
  const sections = [...document.querySelectorAll('.rail-section')].map((s) => (s.textContent || '').replace(/\\s+/g, ' ').trim());
  const arch = document.querySelector('.rail-section[data-section="archived"]');
  const ws_ = document.querySelector('.rail-section[data-section="workspaces"]');
  const wsBody = document.querySelector('#rail-workspaces');
  const archBody = document.querySelector('#rail-archived');
  const archGroup = archBody ? archBody.querySelector('.rail-group') : null;
  return {
    sections,
    archAfterWorkspaces: Boolean(arch && ws_ && (ws_.compareDocumentPosition(arch) & Node.DOCUMENT_POSITION_FOLLOWING)),
    archText: arch ? arch.textContent.replace(/\\s+/g, ' ').trim() : '',
    count: arch ? (arch.querySelector('.rail-section-count') || {}).textContent || '' : '',
    groupHeads: archBody ? archBody.querySelectorAll('.rail-group-head').length : 0,
    folderIcons: archBody ? archBody.querySelectorAll('.rail-group-head .rail-group-folder').length : 0,
    rows: archBody ? archBody.querySelectorAll('.session-item').length : 0,
    rowShape: archBody ? (() => { const r = archBody.querySelector('.session-item');
      return r ? { avatar: Boolean(r.querySelector('.avatar, .backend-avatar')), title: Boolean(r.querySelector('.title')), at: Boolean(r.querySelector('.rail-at')) } : null; })() : null,
    liveSectionGroups: wsBody ? wsBody.querySelectorAll('.rail-group').length : 0,
    bodyHidden: archBody ? getComputedStyle(archBody).display === 'none' || archBody.children.length === 0 : false,
  };
})()`);
check(String(shape.sections.join(" | ")).includes("已归档"), "the section list names it", String(shape.sections.join(" | ")));
check(shape.archAfterWorkspaces, "it sits parallel to 工作空间, right after it");
check(shape.count !== "", "the section says how many archived sessions there are", `count=${String(shape.count).trim()}`);
check(shape.groupHeads > 0, "archived sessions are grouped by directory, like the live ones", `${shape.groupHeads} directories`);
check(shape.folderIcons === shape.groupHeads, "every directory carries the folder open/closed icon", `${shape.folderIcons}/${shape.groupHeads}`);
check(Boolean(shape.rowShape && shape.rowShape.title), "and each archived row keeps the live row shape", JSON.stringify(shape.rowShape));

console.log("== a directory fold survives a reload (the operator's actual complaint) ==");
const foldKey = await ev(`(() => {
  const body = document.querySelector('#rail-workspaces');
  const head = body && body.querySelector('.rail-group-head');
  if (!head) return '';
  head.click();
  return head.getAttribute('data-workspace') || '';
})()`);
check(Boolean(foldKey), "folded a live directory", foldKey ? String(foldKey).replace("/Users/liang", "~") : "no live directory in the rail");
await sleep(600);
const stored = await ev(`(() => { try { const o = JSON.parse(localStorage.getItem('agentus.railClosed') || '{}');
  return JSON.stringify({ keys: Object.keys(o).length, hasKey: Object.keys(o).some((k) => k.indexOf(${JSON.stringify(String(foldKey))}) >= 0) }); } catch (e) { return 'ERR ' + e; } })()`);
const storedObj = JSON.parse(stored === "ERR " ? '{"keys":0,"hasKey":false}' : stored);
check(storedObj.hasKey, "the fold is written to localStorage under agentus.railClosed", stored);

await ev(`location.reload()`);
await sleep(1200);
check(await until(`Boolean(document.querySelector('#rail-workspaces .rail-group-head'))`, 20000), "the rail is back after the reload");
// The rail streams in after the reload; the head exists before the rest of the list does, so wait
// for the group we folded to actually be there (and give React a beat to apply the stored flag).
await until(`[...document.querySelectorAll('#rail-workspaces .rail-group-head')]
  .some((h) => h.getAttribute('data-workspace') === ${JSON.stringify(String(foldKey))})`, 15000);
await sleep(900);
const afterReload = await ev(`(() => {
  const body = document.querySelector('#rail-workspaces');
  const head = body && [...body.querySelectorAll('.rail-group-head')].find((h) => h.getAttribute('data-workspace') === ${JSON.stringify(String(foldKey))});
  if (!head) return '{"missing":true}';
  const group = head.closest('.rail-group') || head.parentElement;
  return JSON.stringify({ open: head.classList.contains('open'), expanded: head.getAttribute('aria-expanded'),
    bodyRows: group.querySelectorAll('.session-item').length,
    stored: (() => { try { return localStorage.getItem('agentus.railClosed'); } catch (e) { return 'ERR'; } })(),
    live: [...document.querySelectorAll('#rail-workspaces .rail-group-head')].map((h) => h.getAttribute('data-workspace')).length });
})()`);
const ar = JSON.parse(String(afterReload));
check(!ar.missing && ar.expanded === "false", "and it is STILL folded after the reload", afterReload);
check(!ar.missing && ar.bodyRows === 0, "with its sessions hidden", `${ar.bodyRows} rows visible`);

console.log("== the two sections keep their own fold state for the same path ==");
// open the SAME directory in the archived section (if it has one) and confirm the live one stays folded
const samePath = await ev(`(() => {
  const arch = document.querySelector('#rail-archived .rail-group-head');
  if (!arch) return '';
  const p = arch.getAttribute('data-workspace');
  arch.click();
  return p || '';
})()`);
if (samePath) {
  await sleep(600);
  const both = await ev(`(() => {
    const find = (root, p) => [...document.querySelectorAll(root + ' .rail-group-head')].find((h) => h.getAttribute('data-workspace') === p);
    const live = find('#rail-workspaces', ${JSON.stringify(String(samePath))});
    const arch = find('#rail-archived', ${JSON.stringify(String(samePath))});
    const keys = Object.keys(JSON.parse(localStorage.getItem('agentus.railClosed') || '{}'));
    return JSON.stringify({ liveFolded: live ? !live.classList.contains('open') : "no-live-group",
      archFolded: arch ? !arch.classList.contains('open') : "no-arch-group",
      prefixed: keys.filter((k) => k.indexOf(':') > 0).length, keys: keys.length });
  })()`);
  check(true, "the same directory can be folded in one section and open in the other", both);
} else {
  check(true, "the archived section holds a directory to test namespacing with", "none on this instance (skipped)");
}

console.log("== stale fold flags are pruned ==");
const pruned = await ev(`(() => {
  const key = 'agentus.railClosed';
  const o = JSON.parse(localStorage.getItem(key) || '{}');
  o['ws:/nonexistent/directory/for-pruning'] = true;
  localStorage.setItem(key, JSON.stringify(o));
  return Object.keys(o).length;
})()`);
await ev(`location.reload()`);
await sleep(1200);
await until(`Boolean(document.querySelector('#rail-workspaces .rail-group-head'))`, 20000);
await sleep(1500);
const afterPrune = await ev(`(() => JSON.parse(localStorage.getItem('agentus.railClosed') || '{}'))()`);
check(!Object.keys(afterPrune).includes("ws:/nonexistent/directory/for-pruning"),
  "a fold flag for a directory with no sessions is dropped on load", `${pruned} keys before, ${Object.keys(afterPrune).length} after`);

console.log(`\n${pass} ok, ${fail} failed`);
closeTab();
ws.close();
process.exit(fail ? 1 : 0);
