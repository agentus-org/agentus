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

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
