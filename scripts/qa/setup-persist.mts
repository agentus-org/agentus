// #74 客户端的两个「不吭声」缺口（第二轮 review 抓到）：
//
//   1. reload 之后 picks 就没了。队列是持久化的（槽位还在起时写下的话，刷新后照样会发出去），
//      而对话框的选择只在内存里 —— 于是「刷新一下就成」把第一句话送进 agent 的默认模型，屏幕上
//      一个字都没有。picks 必须跟队列一样落盘。
//   2. 服务端说「我攥着这条 prompt」（prompt-held）时，页面不能把看门狗直接扔掉：攥着不等于送达，
//      会话没了它也会跟着没。改成换成更长的时钟，而不是删掉。
//
//   npx tsx scripts/qa/setup-persist.mts
import { Cockpit, HELD_ACK_MS, SEND_ACK_MS } from "../../packages/web/src/state.ts";

// node 没有 localStorage / WebSocket：给一份最小的、可观测的实现。
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
} as unknown as Storage;
// node 24 ships a localStorage global that only works with a storage flag; take the name over.}

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const SID = "sess-setup-qa";

// ---- 1. picks 落盘：换一个页面（新的 store 实例）也还在
{
  const first = new Cockpit();
  first.queueSetup(SID, [{ kind: "model", value: "custom:lab:qwen38-27b" }, { kind: "mode", value: "accept_edits" }]);
  check("the picks are written where a reload can find them",
    Boolean(store.get(`agentus.setup.${SID}`)), [...store.keys()].join(","));

  // A reload: brand-new store, same storage. Rendering a ready row for that slot must replay them.
  const reloaded = new Cockpit();
  const sent: unknown[] = [];
  // The socket is down in node: capture what the store TRIES to send instead of opening one.
  (reloaded as unknown as { ws: unknown }).ws = { readyState: 1, send: (s: string) => sent.push(JSON.parse(s)) };
  (reloaded as unknown as { auth: string }).auth = "ok";
  reloaded.apply({ t: "session", session: { id: SID, title: "qa", backend: "hermes", status: "ready", cwd: "/tmp", cold: false } } as never);

  const kinds = sent.map((m) => (m as { t: string }).t).join(",");
  check("a reloaded page replays the picks when the slot comes up", kinds === "set-model,set-mode", kinds);
  check("…and the stored copy is consumed, not replayed forever", !store.get(`agentus.setup.${SID}`),
    [...store.keys()].join(","));
}

// ---- 2. 空 picks 不落盘（「什么都不发」只是一个空集，不是一条记录）
{
  const fresh = new Cockpit();
  fresh.queueSetup("sess-empty-qa", []);
  check("no picks, nothing stored", !store.get("agentus.setup.sess-empty-qa"), [...store.keys()].join(","));
}

// ---- 3. prompt-held 换成更长的时钟，而不是把看门狗扔掉
{
  check("the held clock is longer than the ordinary ack budget", HELD_ACK_MS > SEND_ACK_MS,
    `${HELD_ACK_MS} vs ${SEND_ACK_MS}`);
}


// ---- 4. 起不来的槽位不要碰：set-mode / set-config 会「session not ready」直接抛，prompt 也没有 agent 接
{
  store.clear();
  const SID = "sess-spawning-qa";
  store.set(`agentus.setup.${SID}`, JSON.stringify([{ kind: "model", value: "custom:lab:qwen38-27b" }]));
  store.set(`agentus.queue.${SID}`, JSON.stringify([{ id: "q1", text: "第一句", attachments: [], at: Date.now() }]));

  const sent: unknown[] = [];
  const c = new Cockpit();
  (c as unknown as { ws: unknown }).ws = { readyState: 1, send: (x: string) => sent.push(JSON.parse(x)) };
  (c as unknown as { auth: string }).auth = "ok";
  c.apply({ t: "session", session: { id: SID, title: "x", backend: "hermes", status: "spawning", cwd: "/tmp", cold: false } } as never);
  c.drainPersistedQueues();
  check("a slot that is still spawning is left alone", sent.length === 0, sent.map((m) => (m as { t: string }).t).join(","));
  check("…its picks are still on disk for the ready transition", Boolean(store.get(`agentus.setup.${SID}`)));

  const before = sent.length;
  c.apply({ t: "session", session: { id: SID, title: "x", backend: "hermes", status: "ready", cwd: "/tmp", cold: false } } as never);
  const atReady = sent.slice(before).map((m) => (m as { t: string }).t).join(",");
  check("…and both are replayed the moment it comes up", atReady === "set-model,prompt", atReady);
}

// ---- 5. 两个槽位都在等，两个都得发出去（边遍历边改 storage 会漏掉一个）
{
  store.clear();
  const A = "sess-a-qa", B = "sess-b-qa";
  // 两个槽位都带着 picks：重放 picks 会删掉 storage 里的键，边遍历边删就会把另一个槽位跳过去。
  for (const [id, text] of [[A, "给 A 的话"], [B, "给 B 的话"]] as const) {
    store.set(`agentus.setup.${id}`, JSON.stringify([{ kind: "model", value: `m-${id}` }]));
    store.set(`agentus.queue.${id}`, JSON.stringify([{ id: `q-${id}`, text, attachments: [], at: Date.now() }]));
  }
  const sent: unknown[] = [];
  const c = new Cockpit();
  (c as unknown as { ws: unknown }).ws = { readyState: 1, send: (x: string) => sent.push(JSON.parse(x)) };
  (c as unknown as { auth: string }).auth = "ok";
  for (const id of [A, B]) {
    c.apply({ t: "session", session: { id, title: id, backend: "hermes", status: "cold", cwd: "/tmp", cold: true } } as never);
  }
  c.drainPersistedQueues();
  const texts = sent.filter((m) => (m as { t: string }).t === "prompt").map((m) => (m as { text: string }).text).sort();
  check("two queued slots both drain", texts.length === 2, JSON.stringify(texts));
}

// ---- 6. 看门狗放弃过的句子，真跑起来之后必须把那条「可能没送达」收回
{
  store.clear();
  const SID = "sess-retire-qa";
  const PID = "p-held-qa";
  // 看门狗把句子放回队列时留下的形状（unsure + pid）。
  store.set(`agentus.queue.${SID}`, JSON.stringify([
    { id: "q-held", text: "被攥住的那句", attachments: [], at: Date.now(), unsure: true, pid: PID },
  ]));

  const sent: unknown[] = [];
  const c = new Cockpit();
  (c as unknown as { ws: unknown }).ws = { readyState: 1, send: (x: string) => sent.push(JSON.parse(x)) };
  (c as unknown as { auth: string }).auth = "ok";
  // spawning：让队列进内存但不发出去（否则它会当成新消息又发一遍）。
  c.apply({ t: "session", session: { id: SID, title: "x", backend: "hermes", status: "spawning", cwd: "/tmp", cold: false } } as never);
  c.drainPersistedQueues();
  check("the unsure row is in memory, unsent", sent.length === 0, sent.map((m) => (m as { t: string }).t).join(","));

  c.apply({ t: "turn-start", sessionId: SID, pid: PID } as never);
  const raw = store.get(`agentus.queue.${SID}`);
  const left = raw ? (JSON.parse(raw) as { pid?: string }[]).filter((r) => r.pid === PID) : [];
  check("a turn that really starts retires the watchdog's row", left.length === 0, raw ?? "none");
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
