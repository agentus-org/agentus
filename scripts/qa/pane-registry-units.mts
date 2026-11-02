// The pane registry, as data (packages/web/src/panes.ts — issues #78/#80/#88).
//
// #88 came from adding a THIRD pane (`desktop`) and finding that the two shipped panes were fine and
// the third was worse in two silent ways: `headEntry: false` copied from the neighbouring row meant
// the pane worked everywhere except the head (and, on a phone, not even the `⋯` menu, which is fed by
// the same filtered list), and the head's `pane.id === "ide" ? <IconCode/> : <IconTerminal/>` ternary
// gave the new pane the terminal's glyph while its own title said otherwise.
//
// Both were authoring traps, not bugs in a given pane — so the fix is the shape of the table, and what
// this file pins is that shape:
//   1. the head's door list is DERIVED from `available` (plus exactly one opt-out), so a row cannot be
//      usable in the panel and invisible in the head;
//   2. every row carries its own glyph, and two rows cannot share one by accident;
//   3. `splitSeed` still seeds the same pairs it always did.
//
// Needs the web tsconfig for `jsx: react-jsx` (the registry imports the icon set):
//   npm run pane-registry-units
import { PANES, headPanes, splitSeed, type PaneSpec } from "../../packages/web/src/panes.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const IDE_UP = { configured: true, reachable: true, base: "http://127.0.0.1:9/v1", prefix: "", start: "" };
const IDE_DOWN = { configured: true, reachable: false, base: "http://127.0.0.1:9/v1", prefix: "", start: "" };
const NO_IDE = { configured: false, reachable: false, base: null, prefix: "", start: "" };

// ---- 1. a new pane gets a head entry by default (#88 §1) -----------------------------------
{
  const optedOut = PANES.filter((p) => p.headEntry === false).map((p) => p.id);
  check("只有 files 明确 opt-out；其余行都不写 headEntry（= 默认进 head）",
    optedOut.length === 1 && optedOut[0] === "files",
    `opt-out: [${optedOut.join(", ")}]`);
  check("复制邻居行不会把新 pane 关在 head 外面：不写 headEntry 就等于 true",
    PANES.filter((p) => p.id !== "files").every((p) => p.headEntry !== false),
    PANES.map((p) => `${p.id}=${p.headEntry ?? "default"}`).join(" "));
}

// ---- 2. the head's doors are derived from availability, not stored -------------------------
{
  const wide = headPanes(IDE_UP).map((p) => p.id);
  check("有 IDE 时 head 的门是 terminal + ide（files 走它自己的文件夹按钮）",
    wide.length === 2 && wide.includes("terminal") && wide.includes("ide") && !wide.includes("files"),
    `[${wide.join(", ")}]`);
  const unconfigured = headPanes(NO_IDE).map((p) => p.id);
  check("没配 IDE 时 head 只留 terminal（不可用的 pane 不留按钮）",
    unconfigured.length === 1 && unconfigured[0] === "terminal",
    `[${unconfigured.join(", ")}]`);
  check("IDE 配了但在重启中（reachable=false）仍算可用 —— 可用性是「能不能开」，不是「现在好不好」",
    headPanes(IDE_DOWN).some((p) => p.id === "ide"),
    `[${headPanes(IDE_DOWN).map((p) => p.id).join(", ")}]`);
  check("head 里没有一行是 available() 为假时混进来的",
    headPanes(NO_IDE).every((p) => p.available(NO_IDE)),
    `[${headPanes(NO_IDE).map((p) => p.id).join(", ")}]`);
  check("除 opt-out 外，head 的门与「可用的 pane」一一对应（面板有、head 没有 = #88 的原现象）",
    PANES.filter((p) => p.available(IDE_UP) && p.headEntry !== false).length === headPanes(IDE_UP).length,
    `${headPanes(IDE_UP).length}`);
}

// ---- 3. the glyph lives on the row, and rows do not share one by accident (#88 §2) ---------
{
  check("每一行都有 icon（视图不再按 id 分支选图标）",
    PANES.every((p: PaneSpec) => typeof p.icon === "function"));
  const glyph = (p: PaneSpec): string => JSON.stringify(p.icon({}));
  const drawn = PANES.map((p) => ({ id: p.id, g: glyph(p) }));
  const dupes: string[] = [];
  for (let i = 0; i < drawn.length; i++) {
    for (let j = i + 1; j < drawn.length; j++) if (drawn[i].g === drawn[j].g) dupes.push(`${drawn[i].id}=${drawn[j].id}`);
  }
  check("两行不会画出同一个图标（第三个 pane 复制邻居图标是这条 issue 的第二个坑）",
    dupes.length === 0, dupes.join(", "));
  check("ide 的图标不再是 terminal 的（同一个 title 配了错的图）",
    glyph(PANES.find((p) => p.id === "ide")!) !== glyph(PANES.find((p) => p.id === "terminal")!));
  const el = PANES.find((p) => p.id === "ide")!.icon({ size: 13 }) as { props: { height?: number; width?: number } };
  check("size 参数真的传下去（head 用 14、分屏标题用 13）",
    el.props.height === 13 && el.props.width === 13,
    `height=${el.props.height} width=${el.props.width}`);
}

// ---- 4. the split still seeds the pairs it always seeded -----------------------------------
{
  check("有 IDE：上面 IDE、下面终端", JSON.stringify(splitSeed(IDE_UP)) === JSON.stringify(["ide", "terminal"]),
    JSON.stringify(splitSeed(IDE_UP)));
  check("没有 IDE：上面 files、下面终端（否则这台机器根本不能分屏）",
    JSON.stringify(splitSeed(NO_IDE)) === JSON.stringify(["files", "terminal"]),
    JSON.stringify(splitSeed(NO_IDE)));
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
