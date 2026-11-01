// L0 规则适配层 — 「把这一条念出来」之前，先把念不清楚的东西换成能念的说法。
//
// 为什么要有这一层：播报的唯一收口以前只做三件事（把代码块换成英文 " code block"、把 `|` 抹掉、
// 压空白），结果表格变成「列列列行行行」、链接逐字母念、绝对路径念一长串。实测一条消息里约
// 五分之一字符属于这类噪音，而「压成 200 字总结」又会把结论以外的细节全丢掉 —— 中间这一档是空的。
//
// 三条规矩：
//  1) **零成本、可复现**：纯本地规则，不发请求；同输入必须同输出（缓存 key 带 `SPEAKABLE_RULES_VERSION`）。
//  2) **不许静默丢内容**：跳过代码、折叠表格都必须**念出来**说明（「代码块，12 行」「后面还有 K 行」），
//     并且能在稿子的 meta 里看见。用户得知道自己漏了什么。
//  3) **正文一字不改**：只改「怎么说」，不替对方改写事实。

/** 规则版本进缓存 key：改了规则，旧稿不能继续被念。 */
export const SPEAKABLE_RULES_VERSION = "v1";

export interface SpeakableNotes {
  /** 规则版本，跟着稿子一起走（缓存 key / meta 都用它） */
  version: string;
  /** 跳过的代码块数量，以及它们的总行数 */
  codeBlocks: number;
  codeLines: number;
  /** 表格：念出来的行、被折叠的行 */
  tableRows: number;
  tableRowsFolded: number;
  tables: number;
  /** 被改写成「链接：…」的数量 */
  links: number;
  /** 长串（hex / UUID / base64 / 无空格超长 token）被换成「一个长串，略过」的数量 */
  longTokens: number;
  /** 绝对路径被缩成文件名 */
  paths: number;
  /** 念稿的字符数（含标点） */
  chars: number;
}

export interface Speakable {
  /** 要念的正文（已分好句，未按 TTS 分块） */
  script: string;
  notes: SpeakableNotes;
}

/** 表格超过这么多行就折叠 —— 不是「不许念」，是「念完要承认后面还有」。 */
export const TABLE_ROW_LIMIT = 15;

const CJK_PER_SECOND = 4.5;
const LATIN_WORDS_PER_SECOND = 2.6;

/** 这一段念出来大概多少秒。中文按 4.5 字/秒，英文按词；`rate` 参与换算（2 = 两倍速）。 */
export function estimateSpeechSeconds(text: string, rate = 1): number {
  const r = rate > 0 ? rate : 1;
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f]/g) ?? []).length;
  const latinWords = (text.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, " ").match(/[A-Za-z0-9][A-Za-z0-9'’.-]*/g) ?? []).length;
  const digits = (text.match(/\d/g) ?? []).length;
  const seconds = cjk / CJK_PER_SECOND + latinWords / LATIN_WORDS_PER_SECOND + digits * 0.05;
  return seconds / r;
}

/** 「约 11 分钟」/「约 40 秒」—— 播报前先把代价说清楚，别让人点了才发现是二十分钟。 */
export function humanDuration(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return `约 ${s} 秒`;
  const m = Math.round(s / 60);
  return m < 1 ? "约 1 分钟" : `约 ${m} 分钟`;
}

/** 稿子下面那一行：念了什么、漏了什么，一眼可见。 */
export function describeSpeakable(notes: SpeakableNotes, seconds?: number): string {
  const bits = [`规则版`];
  if (notes.codeBlocks) bits.push(`跳过 ${notes.codeBlocks} 个代码块（共 ${notes.codeLines} 行）`);
  if (notes.tableRowsFolded) bits.push(`表格折叠 ${notes.tableRowsFolded} 行`);
  else if (notes.tables) bits.push(`表格 ${notes.tableRows} 行全部念出`);
  if (notes.links) bits.push(`${notes.links} 个链接只念域名与路径`);
  if (notes.longTokens) bits.push(`${notes.longTokens} 个长串略过`);
  if (seconds !== undefined) bits.push(humanDuration(seconds));
  return bits.join(" · ");
}

// ------------------------------------------------------------------ 规则本体

const ZERO_WIDTH = /[\u200b-\u200f\u2028\u2029\ufeff]/g;
/** 代理对形式的 emoji（含肤色/组合标记）、变体选择符、Keycap —— 念出来只会是「红色方块」。 */
const EMOJI = /[\p{Extended_Pictographic}\u{1f3fb}-\u{1f3ff}\ufe0f\u20e3]/gu;
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/g;

/** 长串：UUID、hex、base64、以及任何没有空格的超长 token。 */
const LONG_TOKEN = /[A-Za-z0-9+/=_-]{24,}/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ABS_PATH = /(?:^|\s)((?:\/[\w.@+-]+){3,}\/?)/g;
const MD_LINK = /\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g;
const BARE_URL = /\bhttps?:\/\/[^\s<>()\]]+/gi;

const CN_NUM = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五"];

/** 这一段像不像一个路径（相对/绝对都算）：没有空格、有 / 或 \\、由路径字符组成。 */
function pathTail(t: string): string | null {
  if (/\s/.test(t) || t.length > 200) return null;
  if (!/^[\w./\\@+-]+$/.test(t)) return null;
  const segs = t.split(/[\\/]/).filter(Boolean);
  if (segs.length < 2) return null;
  return segs[segs.length - 1];
}

/** 把一个裸 URL 念成「链接：域名 上的 末段」。协议、参数、锚点全部丢掉。 */
function speakUrl(raw: string): string {
  let u: URL | null = null;
  try { u = new URL(raw); } catch { u = null; }
  if (!u) return "链接";
  const host = u.hostname.replace(/^www\./, "");
  const segs = u.pathname.split("/").filter(Boolean);
  const last = segs.length ? decodeURIComponent(segs[segs.length - 1]) : "";
  // 末段是 ID / 数字（issue-76、1234、a1b2c3）时，直接念它 —— 那才是这条链接的身份。
  const idLike = /^(?:[a-z-]*[-_]?)?\d{1,6}$/i.test(last) || /^[0-9a-f]{6,10}$/i.test(last);
  if (!last) return `链接：${host}`;
  const tail = idLike ? last : last
    .replace(/\.(md|html?|json|ya?ml|txt|log|mjs|cjs|js|ts|tsx|jsx|py|sh|css|toml|ini|cfg)$/i, "")
    .replace(/[-_]+/g, " ");
  return `链接：${host} 上的 ${tail}`;
}

/** 行内代码：去掉反引号照念，但 `--flag` / `snake_case` / `some/Path` 里的符号换成空格。 */
function speakInlineCode(code: string): string {
  const t = code.replace(/[`]/g, "").trim();
  if (!t) return "";
  // 路径先认出来：`packages/server/src/index.ts` 长得像个长串，但它其实有名字可念（最后一段）。
  const tail = pathTail(t);
  if (tail) return tail;
  if (LONG_TOKEN.test(t) && !/\s/.test(t) && t.length >= 24) { LONG_TOKEN.lastIndex = 0; return "一个长串，略过"; }
  LONG_TOKEN.lastIndex = 0;
  const readable = t.replace(/[_.:/\\{}()[\]<>|+*=~^$#@!?;,"'`]/g, " ").replace(/\s+/g, " ").trim();
  // `npm run build` 这种本身就是人话的，别拆；只有符号多于字母时才当标识符处理。
  const letters = (t.match(/[A-Za-z]/g) ?? []).length;
  const symbols = (t.match(/[_.:/\\{}()[\]<>|+*=~^$#@!?;,"'`]/g) ?? []).length;
  return symbols > 0 && letters > 0 && symbols / letters > 0.15 ? readable : t;
}

/** 一句普通文字的行内净化：链接、URL、路径、长串、行内代码、强调符号。 */
function inline(text: string, notes: SpeakableNotes): string {
  let s = text;
  // [文字](url) —— 只念文字；锚文本为空才回落到 URL 的说法。
  s = s.replace(MD_LINK, (_m, label: string, url: string) => {
    notes.links++;
    const t = String(label).trim();
    return t ? t : speakUrl(String(url));
  });
  s = s.replace(BARE_URL, (m: string) => {
    notes.links++;
    return speakUrl(m.replace(/[.,;:!?]+$/, ""));
  });
  // 行内代码先认出来，免得里面的 / 和 _ 被后面当成路径或强调符号。
  s = s.replace(/`([^`]+)`/g, (_m, code: string) => {
    const raw = String(code).trim();
    const out = speakInlineCode(raw);
    if (out === "一个长串，略过") notes.longTokens++;
    else if (pathTail(raw)) notes.paths++;
    return out;
  });
  s = s.replace(ABS_PATH, (m: string, p: string) => {
    notes.paths++;
    const base = p.split("/").filter(Boolean).pop() ?? "";
    return m.replace(p, base || "一个路径");
  });
  // 正文里的相对路径同样是「有名字的东西」：念最后一段，别当成长串略过。
  s = s.replace(/(^|\s)([\w.-]+(?:[\\/][\w.@+-]+){2,})(?=$|[\s，。、；：」）)]|\s)/g, (m: string, pre: string, p: string) => {
    const tail = pathTail(p);
    if (!tail) return m;
    notes.paths++;
    return `${pre}${tail}`;
  });
  s = s.replace(UUID, () => { notes.longTokens++; return "一个长串，略过"; });
  s = s.replace(LONG_TOKEN, (m: string) => {
    // 24 字以上的纯词不算长串（中文长词、正常英文单词都在 24 以下；这条主要抓 hex/base64/哈希）
    if (/^[A-Za-z]+$/.test(m) && !/[0-9]/.test(m) && m.length < 40) return m;
    notes.longTokens++;
    return "一个长串，略过";
  });
  // 强调 / 标记符号：留着只会被逐字念出来。
  s = s.replace(/[*_~#>|]/g, " ");
  s = s.replace(/[ \t]+/g, " ");
  return s.trim();
}

/** 表格的一行拆成单元格（去掉首尾的 |，以及对齐用的冒号）。 */
function cells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** 表格要**念内容**：先一句「这张表在说什么」，再一行一句，用口语顺序，不念分隔符。 */
function speakTable(header: string[], rows: string[][], notes: SpeakableNotes): string {
  notes.tables++;
  const cols = header.filter((h) => h.length > 0);
  const head = `一张表，${cols.length || header.length} 列：${(cols.length ? cols : header).map((h) => inline(h, notes)).join("、")}。`;
  const kept = rows.slice(0, TABLE_ROW_LIMIT);
  const out: string[] = [];
  kept.forEach((row, i) => {
    const vals = row.map((c) => inline(c, notes)).filter((c) => c.length > 0);
    if (!vals.length) return;
    notes.tableRows++;
    out.push(`第${CN_NUM[i] ?? `${i + 1}`}行，${vals.join("，")}。`);
  });
  const folded = Math.max(0, rows.length - kept.length);
  if (folded > 0) {
    notes.tableRowsFolded += folded;
    // 静默丢内容是禁止的：必须说出来。
    out.push(`后面还有 ${folded} 行，内容类似。`);
  }
  return head + out.join("");
}

/** 代码块只报表，不念内容 —— 但如果开头是注释，那句注释就是这段代码的自述。 */
function speakCode(lines: string[], notes: SpeakableNotes): string {
  notes.codeBlocks++;
  notes.codeLines += lines.length;
  const first = lines.find((l) => l.trim().length > 0) ?? "";
  const comment = first.match(/^\s*(?:#|\/\/|\/\*+|\*|--|<!--|;)\s*(.+?)\s*(?:\*\/|-->)?\s*$/);
  const n = lines.filter((l) => l.trim().length > 0).length;
  if (comment && comment[1] && comment[1].length <= 60 && !/^[{}()[\];]+$/.test(comment[1])) {
    return `代码块，${n} 行，开头写着：${comment[1]}。`;
  }
  return `代码块，${n} 行。`;
}

/**
 * 主入口：Markdown 正文 → 可念稿。
 *
 * 只做「怎么念」，不改事实：代码块报行数、表格逐行念、链接只念域名与末段、长串说「略过」。
 */
export function toSpeakable(text: string): Speakable {
  const notes: SpeakableNotes = {
    version: SPEAKABLE_RULES_VERSION,
    codeBlocks: 0, codeLines: 0,
    tableRows: 0, tableRowsFolded: 0, tables: 0,
    links: 0, longTokens: 0, paths: 0,
    chars: 0,
  };
  const clean = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(ZERO_WIDTH, "")
    .replace(HTML_TAG, " ")
    .replace(EMOJI, " ");

  const lines = clean.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // ---- 围栏代码
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)\s*$/);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${marker[0]}{3,}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence
      out.push(speakCode(body, notes));
      continue;
    }
    // ---- 表格：第一行是表头，第二行是分隔行
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && !TABLE_SEP.test(line)) {
      const header = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim().length > 0) {
        rows.push(cells(lines[i]));
        i++;
      }
      out.push(speakTable(header, rows, notes));
      continue;
    }
    // ---- 空行 / 分隔线 / 纯图片
    if (!line.trim() || /^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line) || /^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(line)) {
      i++;
      continue;
    }
    // ---- 标题：补一个停顿，别把标题和正文黏成一句
    const h = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (h) {
      const t = inline(h[1], notes);
      if (t) out.push(`${t.replace(/[。！？.!?]$/, "")}。`);
      i++;
      continue;
    }
    // ---- 列表：同一组列表项用「；」连起来，整组只在末尾落句号
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i])) {
        const t = inline(lines[i].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""), notes);
        if (t) items.push(t.replace(/[。；;]+$/, ""));
        i++;
      }
      const joined = items.join("；");
      if (joined) out.push(`${joined}。`);
      continue;
    }
    // ---- 引用：去掉 > 照念
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      const t = inline(quote[1], notes);
      if (t) out.push(/[。！？.!?]$/.test(t) ? t : `${t}。`);
      i++;
      continue;
    }
    // ---- 普通段落：一行一句，保留原有标点
    const t = inline(line, notes);
    if (t) out.push(t);
    i++;
  }

  const script = out
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/([。！？])\s+/g, "$1")
    .replace(/\s+([。，；：！？、])/g, "$1")
    .trim();
  notes.chars = script.length;
  return { script, notes };
}
