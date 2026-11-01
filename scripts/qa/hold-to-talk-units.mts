// 按住说话的手势状态机 —— 纯逻辑检查（packages/web/src/holdToTalk.ts，issue #82）。
//
// 这里钉的是三个「必须」：够久才算说话、短按交回原行为、指针漂出阈值就作废（拖选不能被吃掉）。
// 浏览器那边只验「事件真的接到了」（hold-to-talk-sweep.mjs），走的是同一份状态机。
//
// Run: npm run hold-to-talk-units   (tsx; 无浏览器、无服务端、无网络)
import {
  createHoldToTalk, holdHintText, HOLD_MOVE_TOLERANCE_PX, HOLD_TO_TALK_MS, type HoldGesture,
} from "../../packages/web/src/holdToTalk.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- 1. 长按：够久就说话，松手报 hold
{
  let fired = 0;
  const h = createHoldToTalk({ thresholdMs: 60, onHold: () => fired++ });
  check("按下被接收", h.down(10, 10) === true);
  check("还没到阈值时不算说话", h.holding() === false && fired === 0);
  await sleep(90);
  check("过了阈值开始说话（onHold 只触发一次）", fired === 1 && h.holding() === true, `fired=${fired}`);
  check("松手报 hold", h.up() === "hold");
  check("松手之后不再是 holding", h.holding() === false);
}

// ---- 2. 短按：不触发说话，交回原行为
{
  let fired = 0;
  const h = createHoldToTalk({ thresholdMs: 200, onHold: () => fired++ });
  h.down(0, 0);
  const g: HoldGesture = h.up();
  check("短按不触发 onHold", fired === 0);
  check("短按报 tap（调用方照旧处理点击）", g === "tap");
  await sleep(250);
  check("短按之后定时器不会再开火", fired === 0);
}

// ---- 3. 漂移阈值：拖选不能被吃掉
{
  let fired = 0;
  const h = createHoldToTalk({ thresholdMs: 60, onHold: () => fired++ });
  h.down(100, 100);
  h.move(100 + HOLD_MOVE_TOLERANCE_PX - 1, 100);   // 阈值内的小抖动：布局自己动是会这样的
  await sleep(90);
  check("阈值内的抖动照常进入说话", fired === 1);
  h.cancel();
}
{
  let fired = 0;
  const h = createHoldToTalk({ thresholdMs: 60, onHold: () => fired++ });
  h.down(100, 100);
  h.move(100 + HOLD_MOVE_TOLERANCE_PX + 6, 100);   // 他在拖选
  await sleep(90);
  check("漂出阈值后作废，不会偷偷开始录音", fired === 0);
  check("作废之后松手是 null（既不是 hold 也不是 tap）", h.up() === null);
}

// ---- 3b. 开火之后的位移不作废（P0 判据：按住时布局会动，指针相对元素会漂）
{
  let fired = 0, stopped = 0;
  const h = createHoldToTalk({ thresholdMs: 60, onHold: () => fired++ });
  h.down(0, 0);
  await sleep(90);
  h.move(400, 400);                       // 输入框长高、按钮被顶走：指针相对元素漂了很远
  check("movement AFTER the hold fired does not cancel it", fired === 1 && h.holding() === true);
  const g = h.up();
  if (g === "hold") stopped++;
  check("…and the release still says 「我说完了」", g === "hold" && stopped === 1, String(g));
}

// ---- 4. cancel / 通话中不 arm
{
  let fired = 0;
  const h = createHoldToTalk({ thresholdMs: 60, onHold: () => fired++ });
  h.down(0, 0);
  h.cancel();
  await sleep(90);
  check("cancel 之后定时器开不了火", fired === 0);
  check("cancel 之后松手是 null", h.up() === null);
}
{
  const h = createHoldToTalk({ thresholdMs: 60, onHold: () => {} });
  h.down(0, 0);
  check("已经在按住时，第二次 down 被拒绝", h.down(0, 0) === false);
  h.up();
}

// ---- 5. 提示文案：桌面端才许诺输入框那条路
{
  check("手机只有麦克风那句", !/输入框/.test(holdHintText(false)) && /按住麦克风/.test(holdHintText(false)), holdHintText(false));
  check("桌面端多一句输入框长按", /输入框里长按鼠标左键/.test(holdHintText(true)), holdHintText(true));
  check("默认阈值就是 480ms（与仓里那套相同）", HOLD_TO_TALK_MS === 480, String(HOLD_TO_TALK_MS));
}

console.log(`\nhold-to-talk-units: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
