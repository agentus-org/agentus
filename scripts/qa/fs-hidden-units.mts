// 文件浏览器要看得见隐藏文件（operator: 「文件浏览器里面隐藏文件也要支持显示出来，不要把隐藏文件给
// 不显示」）。
//
// 原来 `listDirs` 直接 `if (d.name.startsWith(".")) continue;` —— 一个工作区里真正要紧的东西常常正是
// `.claude/`、`.github/`、`.env.example`、`.gitignore`，于是面板在说谎：它告诉你目录里没有这些文件。
//
// 现在的契约：**都列出来**，但 dot-entry 排在同类型末尾、带 `hidden: true`（面板据此淡化），并且
// picker（`includeFiles` 未开）仍然只列目录 —— 那是另一件事，不能顺带改。
//
//   npx tsx scripts/qa/fs-hidden-units.mts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listDirs } from "../../packages/server/src/fs.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const show = (a: unknown): string => JSON.stringify(a);

// A directory that looks like a real workspace: ordinary entries plus the dot-entries that used to
// be invisible.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-hidden-"));
fs.mkdirSync(path.join(dir, "src"));
fs.mkdirSync(path.join(dir, ".github"));
fs.writeFileSync(path.join(dir, "README.md"), "# readme\n");
fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules\n");
fs.writeFileSync(path.join(dir, ".env.example"), "KEY=\n");
fs.mkdirSync(path.join(dir, ".git"));      // the loud one: 10k files in a real repo, still just a dir here

{
  const listing = listDirs(dir, { includeFiles: true });
  const names = listing.entries.map((e) => e.name);
  check("隐藏文件/目录都出现在列表里（不再是 continue 掉）",
    names.includes(".gitignore") && names.includes(".env.example") && names.includes(".github"),
    show(names));
  check("普通项一个不少", names.includes("src") && names.includes("README.md"), show(names));
  check("…并且被标成 hidden（面板据此淡化）",
    listing.entries.filter((e) => e.name.startsWith(".")).every((e) => e.hidden === true), show(listing.entries));
  check("普通项不带 hidden 标记（不会被误淡化）",
    listing.entries.filter((e) => !e.name.startsWith(".")).every((e) => e.hidden !== true), show(listing.entries));

  // Order: ordinary dirs, hidden dirs, ordinary files, hidden files — a workspace should not open
  // onto a wall of dotfiles.
  const order = listing.entries.map((e) => `${e.kind}:${e.hidden ? "h" : "n"}:${e.name}`);
  const firstHidden = order.findIndex((s) => s.includes(":h:"));
  const lastNormalDir = order.reduce((acc, s, i) => (s.startsWith("dir:n:") ? i : acc), -1);
  check("隐藏项排在普通项之后（同类内下沉）", firstHidden > lastNormalDir && lastNormalDir >= 0,
    show(order));
  // Every dir precedes every file: the kind flag must never go back up once it has flipped.
  const kinds = order.map((s) => (s.startsWith("dir:") ? 0 : 1));
  check("目录仍然排在文件之前（kind 只翻转一次）",
    kinds.every((k, i) => i === 0 || k >= kinds[i - 1]), show(order));
  check("点名的那个 dotfile 就在同一层（路径可直接打开）",
    listing.entries.some((e) => e.path === path.join(dir, ".gitignore")), show(listing.entries.map((e) => e.path)));
}

{
  // The picker (new slot / change working directory) asks for directories only. Listing dot-DIRS
  // there is right (a hidden directory can be a workspace); files must still not show up.
  const listing = listDirs(dir);
  check("picker 仍然只列目录（includeFiles 不传）",
    listing.entries.every((e) => e.kind === "dir"), show(listing.entries.map((e) => `${e.kind}:${e.name}`)));
  check("…隐藏目录也在（.github 可以被选为工作目录）",
    listing.entries.some((e) => e.name === ".github" && e.hidden === true), show(listing.entries.map((e) => e.name)));
}

{
  // A directory whose entries are ALL dot-entries must not look empty.
  const only = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-hidden-only-"));
  fs.writeFileSync(path.join(only, ".env"), "A=1\n");
  const listing = listDirs(only, { includeFiles: true });
  check("只有隐藏文件的目录不再显示成空目录",
    listing.entries.length === 1 && listing.entries[0].name === ".env", show(listing.entries.map((e) => e.name)));
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
