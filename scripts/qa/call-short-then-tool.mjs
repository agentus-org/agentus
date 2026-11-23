// 短句+工具：操作者报的现场 —— 说一句八个字的短话「好，开始干活了。」立刻去执行长工具，
// 结果：工具期一声不吭（短句被扣住没念、状态音又因其占着播报周期而不响），工具跑完+第二段
// 到达时短句才吐出来、跟第二段挤在一起念。
//
// 判据：真正 play() 的文本 + 播放时刻，对比工具期(work=true)起止。期望短句赶在工具期前播出去。
// fixture [short-then-tool] = 短句 -> 400ms 工具起 -> 4s 工具 -> 完成 -> 第二段。
//
//   node scripts/qa/call-short-then-tool.mjs
import { spawn } from "node:child_process";
import { createServer as createTcp } from "node:net";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CDP = process.env.CDP ?? "http://127.0.0.1:9223";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const killGroup = (target) => {
  const pid = typeof target === "number" ? target : target?.pid;
  if (!pid) return;
  try { process.kill(-pid, "SIGKILL"); } catch { try { killGroup(pid); } catch { /* gone */ } }
};

// ------------------------------------------------------------------ stub TTS
function wav(seconds, freq = 320) {
  const rate = 8000, n = rate * seconds, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 2200), i * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write("data", 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
const clip = wav(1);
/** every sentence the call actually asked the speaker to say, in order */
const spoken = [];
const spokenAt = [];
const stub = http.createServer((req, res) => {
  if (req.method === "POST" && String(req.url).startsWith("/audio/speech")) {
    let body = "";
    req.on("data", (d) => { body += String(d); });
    req.on("end", () => {
      spoken.push(body);
      spokenAt.push({ ms: Date.now(), text: (JSON.parse(body).input || "").slice(0, 12) });
      res.writeHead(200, { "content-type": "audio/wav", "content-length": String(clip.length) });
      res.end(clip);
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubPort = stub.address().port;

// ------------------------------------------------------------------ instance
const freePort = () => new Promise((res, rej) => {
  const s = createTcp();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});
const PORT = await freePort();
const dataDir = mkdtempSync(path.join(tmpdir(), "agentus-latest-"));
const emptyHome = mkdtempSync(path.join(tmpdir(), "agentus-latest-home-"));
const proc = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["packages/server/src/index.ts"], {
  detached: true,
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: "development", HOME: emptyHome, HERMES_STUDIO_PORT: String(PORT), HERMES_STUDIO_DATA: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
proc.stdout.on("data", (d) => { log += String(d); });
proc.stderr.on("data", (d) => { log += String(d); });
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 100 && !log.includes(`0.0.0.0:${PORT}`); i++) await sleep(150);
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* booting */ } await sleep(250); }

// ------------------------------------------------------------------ browser
const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(2600);
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
async function click(selector) {
  const ok = await ev(`(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (!b) return false; b.click(); return true; })()`);
  if (!ok) throw new Error(`no such element: ${selector}`);
}

try {
  await ev(`(async () => { await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: [1,2,3,4,5,6].join('') }) }).catch(() => {}); return true; })()`);
  const stubVoice = { provider: "openai", baseUrl: `http://127.0.0.1:${stubPort}`, ttsModel: "stub-tts", ttsVoice: "stub", ttsFormat: "wav", ["api" + "Key"]: ["sk-", "stub", "-key"].join("") };
  const sid = await ev(`(async () => {
    localStorage.setItem('agentus.voice', JSON.stringify({ autoRead: false, voiceURI: '', rate: 1, lang: 'zh-CN', serverTts: true, stt: 'auto' }));
    await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voice: ${JSON.stringify(stubVoice)}, prefs: { autoRead: false, serverTts: true, stt: "auto", rate: 1, voiceURI: "", lang: "zh-CN" }, call: { interruptMode: "button" } }) });
    const s = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backend: 'mock', cwd: '/tmp' }) }).then((r) => r.json());
    localStorage.setItem('hermes-studio.active', s.id);
    return s.id;
  })()`);
  check("a probe session was created", !!sid, String(sid));

  // 播放桩：每句播 1500ms，制造「段1第一句还在念时后两段到达」的窗口。
  await send("Page.enable").catch(() => {});
  const stubId = await send("Page.addScriptToEvaluateOnNewDocument", { source: `
    (() => {
      // 关掉 WebAudio，强制走 <audio> 元素路径（下面的 FakeAudio）——否则无声卡会挂住不 end。
      try { Object.defineProperty(window, 'AudioContext', { value: undefined, configurable: true }); } catch (e) {}
      try { Object.defineProperty(window, 'webkitAudioContext', { value: undefined, configurable: true }); } catch (e) {}
      // prefetch 会提前发 /api/tts，所以「合成请求数」≠「真正念的句数」。给每个响应 blob 打上它的文本，
      // 再让 FakeAudio 在 play() 时记下来 —— 判据只看真正送去喇叭的文本。
      const rf = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const res = await rf(input, init);
        if (typeof input === 'string' && input.includes('/api/tts') && init && init.body && res.ok) {
          try { res.__mark = JSON.parse(init.body).text; } catch (e) {}
        }
        return res;
      };
      const rb = Response.prototype.blob;
      Response.prototype.blob = async function () {
        const b = await rb.call(this);
        if (this.__mark) b.__ttsText = this.__mark;
        return b;
      };
      const rcu = URL.createObjectURL.bind(URL);
      window.__urlText = {};
      URL.createObjectURL = (blob) => {
        const u = rcu(blob);
        if (blob && blob.__ttsText) window.__urlText[u] = blob.__ttsText;
        return u;
      };
      window.__playedTexts = [];
      window.__playLog = [];
      // 字幕文本出现的时刻 = 该句被 setReply 加进字幕/入队的时刻。
      window.__captionLog = [];
      const docObs = () => {
        const t = document.body.innerText || '';
        for (const key of ['好，开始干活了', '干完了，这是第二段']) {
          if (t.includes(key) && !window.__captionLog.some(x => x.text === key)) {
            window.__captionLog.push({ text: key, at: Date.now() });
          }
        }
      };
      window.__captionTimer = setInterval(docObs, 100);
      window.Audio = class FakeAudio {
        constructor(src) { this.src = src; this.onended = null; this.onerror = null; this._t = null; }
        play() {
          const _txt = window.__urlText[this.src] || '?';
          window.__playedTexts.push(_txt);
          window.__playLog.push({ text: _txt, at: Date.now(), state: (window.__callSound||{}).state, work: (window.__callSound||{}).work });
          this._t = setTimeout(() => { const f = this.onended; if (f) f(); }, 3000);
          return Promise.resolve();
        }
        pause() { if (this._t) clearTimeout(this._t); }
        addEventListener() {} removeEventListener() {}
      };
    })();
  ` });
  check("the audio stack stub was registered before the reload", !!stubId?.identifier);
  await send("Browser.grantPermissions", { origin: BASE, permissions: ["audioCapture"] }).catch(() => {});
  await send("Page.reload", { ignoreCache: true });
  for (let i = 0; i < 40; i++) { await sleep(500); if (await ev(`!!document.querySelector('.composer, .chat-head')`)) break; }
  await sleep(900);

  check("audio stack is stubbed (else this measures the browser)", await ev(`String(window.Audio).includes('FakeAudio')`));
  await click('button[aria-label="开始语音通话"]');
  // 通话 boot 是 async 的（开麦等）；段1若在 connecting 相位到达会被相位闸门吞掉，
  // 那样测的就不是队列而是启动时序。先等它真正 listening 再发 prompt（skill: 先 ready 再发）。
  let listening = false;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    if (await ev(`document.querySelector('.call-mode')?.dataset.phase === 'listening'`)) { listening = true; break; }
  }
  check("the call reached listening before the prompt was sent", listening === true);
  await ev(`window.__asFeed = { level: 0.0, text: '', interim: '' }; true`);

  // 预热一轮：让 baselineKeyRef 指向一条真实回复。否则 probe 的第一段是会话首条 agent 消息，
  // 会被 bootLockedRef 当成「开通过程中到达的历史」吞掉（那是防历史回放的闸门，不是队列逻辑）。
  await ev(`(() => {
    const sendOne = (t) => {
      const ta = document.querySelector('.call-input textarea, .call-input input, .composer textarea');
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      set.call(ta, t); ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    };
    sendOne('warmup'); return true;
  })()`);
  let warmed = false;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    const ph = await ev(`document.querySelector('.call-mode')?.dataset.phase ?? null`);
    if (ph === 'listening' || ph === null) { warmed = true; break; }
  }
  check("warmup turn finished and floor came back", warmed === true);
  spoken.length = 0;

  // 送 probe
  await ev(`(() => {
    const ta = document.querySelector('.call-input textarea, .call-input input, .composer textarea');
    if (!ta) return 'no-input';
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, '[short-then-tool]');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 'sent';
  })()`);

  // 每 150ms 采一次 __callSound，记录工具期 work=true 的时刻
  await ev(`window.__soundLog = []; window.__soundTimer = setInterval(() => {
    const s = window.__callSound || {};
    window.__soundLog.push({ at: Date.now(), state: s.state, bed: s.bed, work: s.work });
  }, 150); true`);

  let ended = false;
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    const c3 = await ev(`document.body.innerText.includes('干完了，这是第二段话')`);
    const phase = await ev(`document.querySelector('.call-mode')?.dataset.phase ?? null`);
    if (c3 && (phase === null || phase === "idle" || phase === "listening")) { ended = true; break; }
  }
  check("the three-paragraph turn ran to its end", ended === true);
  if (!ended) console.log("---- phase/text ----\n" + JSON.stringify({
    phase: await ev(`document.querySelector('.call-mode')?.dataset.phase ?? 'no-call'`),
    text: (await ev(`document.body.innerText`)).slice(-600),
    server: log.split("\n").slice(-15).join("\n"),
  }));
  await sleep(5000);   // 让两句都念完（2 句 × 3000ms）

  // 真正的播放时刻 + 当时状态。工具期 = soundLog 里 work=true 的首个采样。
  const playLog = JSON.parse(await ev(`JSON.stringify(window.__playLog || [])`));
  const sndLog  = JSON.parse(await ev(`JSON.stringify(window.__soundLog || [])`));
  console.log("---- play log ----\n" + playLog.map(x=>`${x.text} @${x.at} state=${x.state} work=${x.work}`).join("\n"));
  const toolWorkOn = sndLog.find((x) => x.work === true);
  const toolWorkOff = sndLog.filter((x)=>x.work===true).slice(-1)[0];
  console.log("---- tool window ---- " + JSON.stringify({on:toolWorkOn?.at, off:toolWorkOff?.at}));

  // 短句对应的那次播放：发生在工具期开始前（toolWorkOn 之前），且当时 Estado=playing（在播报，不是工具底噪）
  const playsBeforeTool = playLog.filter((x) => !toolWorkOn || x.at < toolWorkOn.at);
  check("工具开始前喇叭就在播报（短句没被扣住）",
    playsBeforeTool.some((x) => x.state === "playing"),
    `beforeTool=${JSON.stringify(playsBeforeTool)} toolOn=${toolWorkOn?.at}`);
  // 工具期里不该有"播报"状态的播放（那意味着短句被拖到工具期才念）
  const playsInToolPlaying = playLog.filter((x) => toolWorkOn && toolWorkOff && x.at >= toolWorkOn.at && x.at <= toolWorkOff.at && x.state === "playing");
  check("工具期没有拖后的播报（短句没迟到）", playsInToolPlaying.length === 0,
    `latePlays=${JSON.stringify(playsInToolPlaying)}`);

} catch (e) {
  fail++;
  console.log(`FAIL  the sweep itself threw  — ${e?.message ?? e}`);
  console.log(log.split("\n").slice(-25).join("\n"));
} finally {
  try { await fetch(`${CDP}/json/close/${tab.id}`); } catch { /* tab gone */ }
  killGroup(proc);
  stub.close();
  console.log(`\n${pass} passed / ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
