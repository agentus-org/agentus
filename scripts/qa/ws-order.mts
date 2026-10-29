// #74 服务端那一半：同一条 socket 上的帧是 FIFO，**派发**不是。
//
// 场景（实测 13 次里 6 次落这个坑）：新建会话时页面把对话框里的选择（set-model）和操作者的
// 第一句话（prompt）背靠背发出去。`ws.on("message")` 给每一帧各起一个 async 调用，`prompt`
// 又不 await，于是 prompt 可能抢在 set-model 前面抵达 agent：它先占了回合，随后的模型切换撞上
// "Session is busy" 被丢掉 —— 会话用默认模型跑完，页面只多一行红字。反过来的顺序同样坏：
// prompt 撞上 agent 的命令锁被"排队"，客户端只能把它读成一个当场就结束的回合。
//
// 这条闸门只管一件事：**一帧 prompt 要等它之前已经到达的控制帧落定**。prompt 之间不串行
// （回合顺序归 agent 的队列管），prompt 之后的控制帧也不等 prompt。
//
//   npx tsx scripts/qa/ws-order.mts
import { createFrameGate } from "../../packages/server/src/ws-order.ts";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log: string[] = [];

// ---- 1. prompt 等它前面的控制帧（这就是 #74 的坏顺序）
{
  log.length = 0;
  const gate = createFrameGate();
  let release: () => void = () => {};
  const slow = new Promise<void>((r) => { release = r; });

  const ctrl = gate.control(async () => {
    await slow;
    log.push("set-model done");
  });
  gate.afterControl(() => log.push("prompt starts"));
  await sleep(20);

  check("a prompt does not start while a control frame is in flight", log.length === 0, log.join(" → "));
  release();
  await ctrl;
  await sleep(10);
  check("…and starts in order once it settles", log.join(" → ") === "set-model done → prompt starts", log.join(" → "));
}

// ---- 2. 控制帧失败也不能吞掉操作者的话
{
  log.length = 0;
  const gate = createFrameGate();
  const bad = gate.control(async () => { await sleep(5); throw new Error("unknown model"); });
  void bad.catch(() => {});
  gate.afterControl(() => log.push("prompt starts"));
  await sleep(30);
  check("a rejected control frame still releases the prompt (allSettled, not all)",
    log.join(" → ") === "prompt starts", log.join(" → "));
}

// ---- 3. prompt 之间不串行：一个回合跑着，后一句照样能发
{
  log.length = 0;
  const gate = createFrameGate();
  let release: () => void = () => {};
  const longControl = new Promise<void>((r) => { release = r; });
  void gate.control(() => longControl);
  gate.afterControl(() => log.push("first"));
  gate.afterControl(() => log.push("second"));
  await sleep(10);
  check("both prompts wait for the same control frame, not for each other", log.length === 0, log.join(" → "));
  release();
  await sleep(20);
  check("…and both are released once it settles", log.join(",") === "first,second", log.join(" → "));
}

// ---- 4. 顺序：prompt 之后到达的控制帧不等 prompt（否则 stop 会被一整个回合堵住）
{
  log.length = 0;
  const gate = createFrameGate();
  gate.afterControl(() => log.push("prompt"));
  void gate.control(async () => { log.push("cancel"); });
  await sleep(10);
  check("a control frame that arrives after a prompt is not gated by it", log.join(" → ") === "cancel → prompt"
    || log.join(" → ") === "prompt → cancel", log.join(" → "));
}

// ---- 5. 空集：没有在途控制帧时 prompt 立刻发（不能为了排队而排队）
{
  const gate = createFrameGate();
  const order: string[] = [];
  gate.afterControl(() => order.push("ran"));
  check("with nothing in flight the prompt runs synchronously", order.join("") === "ran", order.join(""));
}

// ---- 6. 落定的控制帧不再拖住后面的 prompt（集合要收干净）
{
  log.length = 0;
  const gate = createFrameGate();
  await gate.control(async () => { await sleep(5); });
  await sleep(10);
  const t0 = Date.now();
  gate.afterControl(() => log.push("prompt"));
  check("a settled control frame does not gate a later prompt", log.length === 1 && Date.now() - t0 < 20,
    `${Date.now() - t0}ms`);
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
