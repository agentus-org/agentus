// Real markdown rendering for replies and tool output.
//
// Two things drove this: the operators' complaint that an agent's answer arrived as
// raw text (headings, lists and tables all showing as punctuation), and the studio
// comparison — hermes-studio renders with markdown-it + highlight.js, so a cockpit that
// does not is behind the tool the people already use.
//
// Choices worth stating:
//  * **markdown-it, `html: false`.** Agent output is untrusted text; letting raw HTML
//    through and then sanitising it is a losing race. With html off, markdown-it only
//    ever emits the tags it owns, and DOMPurify is the second belt (it also strips
//    `javascript:` links and event handlers from anything we add ourselves).
//  * **highlight.js core + an explicit language list.** The full bundle is ~1MB; a
//    cockpit needs the languages agents actually emit. Unknown languages still render
//    as plain code — never as an error.
//  * **`breaks: true`.** Agents write chat-shaped prose where a single newline is a
//    line break; rendering it as a space (CommonMark's rule) is technically right and
//    practically annoying.
//  * Copy buttons are wired once per container via a click handler, not one React
//    listener per code block (a long answer can hold dozens).
import { useEffect, useMemo, useRef } from "react";
import { copyText } from "./clipboard";
import { openLocalFile } from "./fileBus";
import { enhanceTables } from "./tableSort";
import { rawFileUrl } from "./state";
import MarkdownIt from "markdown-it";
import type { MarkdownIt as MarkdownItInstance, RendererRule } from "markdown-it";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
// Ordered cheapest-first: these are the languages agent transcripts actually contain.
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

for (const [name, lang] of Object.entries({
  bash, css, diff, go, ini, java, javascript, json, markdown, python, rust, sql, typescript, xml, yaml,
})) {
  hljs.registerLanguage(name, lang as never);
}
// Aliases agents use in fences: ```sh, ```ts, ```yml, ```py, ```shell …
for (const [alias, target] of Object.entries({
  sh: "bash", shell: "bash", zsh: "bash", console: "bash",
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", python3: "python", yml: "yaml", rb: "ruby", rs: "rust", golang: "go",
  html: "xml", vue: "xml", svg: "xml", md: "markdown", toml: "ini", conf: "ini", text: "bash", txt: "bash",
})) {
  try {
    hljs.registerAliases(alias, { languageName: target });
  } catch {
    /* an alias that already exists is fine */
  }
}

// Recognising a LOCAL FILE inside a reply.
//
// Measured 2026-10-09: `[x.md](file:///…/x.md#L12)` rendered as literal text with visible
// brackets (markdown-it's validateLink rejects the `file:` scheme), `[x.md](/abs/x.md)` became a
// link that reloaded the whole cockpit in a new tab (the SPA fallback answers any path), bare
// paths were never linkified at all, and `![](/abs/a.png)` was a broken image. Four symptoms,
// one missing idea: a path is a thing you can open, not a URL.
interface LocalTarget {
  path: string;
  line?: number;
}

/** `:12` / `#12` / `#L12` on the end of a path — how editors and agents mark a line. */
const LINE_SUFFIX = /(?:#L(\d+)|#(\d+)|:(\d+))$/;

/** Resolve a link/image/text target to a local file, or null when it is an ordinary URL.
 *  Relative paths resolve against `base` (the session workspace, or the directory of the
 *  markdown file being previewed); `~` is handed through for the server to expand. */
export function localTarget(url: string, base?: string): LocalTarget | null {
  let raw = String(url ?? "").trim();
  if (!raw || raw === "#") return null;
  if (/^file:\/\//i.test(raw)) {
    raw = decodeURIComponent(raw.replace(/^file:\/\/(?:localhost)?/i, ""));
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    // http(s), mailto, data:, javascript:, vscode:, x-apple:… — none of them are ours to open
    return null;
  }
  const suffix = LINE_SUFFIX.exec(raw);
  let line: number | undefined;
  if (suffix) {
    line = Number(suffix[1] ?? suffix[2] ?? suffix[3]);
    raw = raw.slice(0, suffix.index);
  }
  if (!raw) return null;
  if (!raw.startsWith("/") && !raw.startsWith("~/")) {
    // Relative: only when it is unambiguous. A slash means a path (`docs/a.md`); without one we
    // need an extension (`notes.md`, `shot.png`) so ordinary prose with a full stop stays prose.
    const looksLikePath = raw.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(raw);
    if (!base || !looksLikePath || !/^[\w.@+/-]+$/.test(raw)) return null;
    raw = joinPath(base, raw);
  }
  if (line == null || !Number.isFinite(line)) return { path: raw };
  return { path: raw, line };
}

function joinPath(base: string, rel: string): string {
  const parts = base.split("/").filter(Boolean);
  for (const seg of rel.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join("/")}`;
}

function baseOf(env: unknown): string | undefined {
  const base = (env as { base?: unknown } | null)?.base;
  return typeof base === "string" && base ? base : undefined;
}

const md: MarkdownItInstance = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(rawCode, lang) {
    // A fence's content always ends with a newline; keeping it renders a trailing empty
    // line inside the block (measured: a 3-line fence drew 4 line boxes). Inner blank
    // lines are preserved — only the final break goes.
    const code = rawCode.replace(/\n$/, "");
    const name = (lang || "").trim().toLowerCase();
    if (name && hljs.getLanguage(name)) {
      try {
        return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
      } catch {
        /* fall through to plain */
      }
    }
    return md.utils.escapeHtml(code);
  },
});

// Links open in a new tab: an agent's URL must never navigate the cockpit away.
// A LOCAL file link is the exception (see below): it opens the workspace panel instead.
const defaultLinkOpen: RendererRule = md.renderer.rules.link_open
  ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
const linkOpen: RendererRule = (tokens, idx, options, env, self) => {
  const href = String(tokens[idx].attrGet("href") ?? "");
  const local = href ? localTarget(href, baseOf(env)) : null;
  if (local) {
    // Not a URL: a file in the workspace. It must NOT open a tab (the browser would either
    // 404 it or, worse, reload the cockpit through the SPA fallback — measured: a
    // `[x.md](/abs/x.md)` link reopened the whole app in a new tab). It carries the path and
    // the line instead, and the delegated click handler below hands it to the panel.
    tokens[idx].attrSet("href", "#");
    tokens[idx].attrSet("class", "md-file-link");
    tokens[idx].attrSet("data-file-path", local.path);
    if (local.line) tokens[idx].attrSet("data-file-line", String(local.line));
    return self.renderToken(tokens, idx, options);
  }
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, idx, options, env, self);
};
md.renderer.rules.link_open = linkOpen;

// Images: a local path becomes the byte endpoint. This is the whole of §2c — before it, every
// screenshot an agent wrote into a reply (`![shot](/Users/…/shot.png)`, or a relative
// `![](screens/x.png)`) rendered as a broken image, because the browser asked the static
// handler for /Users/… and the app has no such route.
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const src = String(tokens[idx].attrGet("src") ?? "");
  const local = src ? localTarget(src, baseOf(env)) : null;
  if (local) {
    tokens[idx].attrSet("src", rawFileUrl(local.path));
    tokens[idx].attrSet("loading", "lazy");
    tokens[idx].attrSet("class", "md-img");
    // click → the raw file in a new tab (full size, right-click still offers save)
    const alt = tokens[idx].content ?? "";
    const html = self.renderToken(tokens, idx, options);
    return `<a class="md-img-link" href="${md.utils.escapeHtml(rawFileUrl(local.path))}" target="_blank" rel="noopener noreferrer" title="${md.utils.escapeHtml(alt || local.path)}">${html}</a>`;
  }
  return self.renderToken(tokens, idx, options);
};

// A path written as plain prose gets the same treatment. Agents paste paths constantly
// (`/Users/liang/x.md`, `~/notes/a.md:12`) and markdown-it's linkify ignores them — a path is
// not a URL. Done in the `text` renderer instead of by rewriting tokens: no token surgery, and
// the `inLink` mark set by the core rule below keeps an <a> from nesting inside an <a>.
// The lookbehind refuses to match inside something else (`https://x.com/a.png`), and the
// capture groups keep what the agent wrote visible (`:12` stays in the label).
const BARE_FILE = /(?<![\w"'`/.\-])(?:file:\/\/)?((?:~\/|\/)[\w.@+/-]*[\w.@+-]\.[A-Za-z0-9]{1,8})(?::(\d+))?/g;
type FlaggedToken = { inLink?: boolean };
const defaultText: RendererRule = md.renderer.rules.text ?? ((tokens, idx) => md.utils.escapeHtml(tokens[idx].content));
md.renderer.rules.text = (tokens, idx, options, env, self) => {
  const raw = tokens[idx].content;
  if ((tokens[idx] as unknown as FlaggedToken).inLink || !raw) return defaultText(tokens, idx, options, env, self);
  const base = baseOf(env);
  let out = "";
  let last = 0;
  BARE_FILE.lastIndex = 0;
  for (const m of raw.matchAll(BARE_FILE)) {
    const resolved = localTarget(m[0], base);
    const at = m.index ?? 0;
    if (!resolved) continue;
    out += md.utils.escapeHtml(raw.slice(last, at));
    const lineAttr = resolved.line ? ` data-file-line="${resolved.line}"` : "";
    const shown = `${md.utils.escapeHtml(m[1])}${m[2] ? `<span class="md-file-line">:${m[2]}</span>` : ""}`;
    out += `<a class="md-file-link" href="#" data-file-path="${md.utils.escapeHtml(resolved.path)}"${lineAttr}>${shown}</a>`;
    last = at + m[0].length;
  }
  return out ? out + md.utils.escapeHtml(raw.slice(last)) : defaultText(tokens, idx, options, env, self);
};

// Inline children are a flat stream (link_open, text…, link_close as siblings), so "am I inside
// a link?" has to be marked rather than looked up. One pass, no token construction.
md.core.ruler.push("local-file-mark", (state) => {
  for (const token of state.tokens) {
    if (token.type !== "inline" || !token.children) continue;
    let depth = 0;
    for (const child of token.children) {
      if (child.type === "link_open") depth += 1;
      else if (child.type === "link_close") depth = Math.max(0, depth - 1);
      else if (depth > 0) (child as unknown as FlaggedToken).inLink = true;
    }
  }
  return true;
});

// markdown-it refuses the `file:` scheme outright (validateLink), which is why a `file:///…`
// link used to render as raw text with visible brackets. The scheme is allowed through here
// because the rules above turn it into a panel click, never into navigation.
const originalValidateLink = md.validateLink.bind(md);
md.validateLink = (url: string): boolean => (/^file:/i.test(url) ? true : originalValidateLink(url));

// Fenced code gets a language label and a copy button.
const defaultFence: RendererRule = md.renderer.rules.fence
  ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
const fence: RendererRule = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const info = (token.info || "").trim().split(/\s+/)[0] ?? "";
  const body = defaultFence(tokens, idx, options, env, self);
  return `<div class="md-code"><div class="md-code-bar"><span class="md-lang">${md.utils.escapeHtml(info || "code")}</span>`
    + `<button class="md-copy" type="button" data-copy>copy</button></div>${body}</div>`;
};
md.renderer.rules.fence = fence;

/** Markdown → sanitised HTML. Memoised on the text: a streaming reply re-renders this
 *  on every chunk, and parsing the whole answer each time is the expensive part.
 *  `base` is what a relative path in the text resolves against (the session workspace for a
 *  reply, the file's own directory when previewing a file). */
export function renderMarkdown(text: string, base?: string): string {
  const html = md.render(String(text ?? ""), { base });
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["target", "rel", "data-copy", "data-file-path", "data-file-line", "loading"],
    // hljs classes and our own wrappers
    ADD_TAGS: ["div", "span", "button", "table", "thead", "tbody", "tr", "th", "td"],
  });
}

export function Markdown({ text, base }: { text: string; base?: string }): JSX.Element {
  const html = useMemo(() => renderMarkdown(text, base), [text, base]);
  const ref = useRef<HTMLDivElement>(null);

  // Tables are enhanced AFTER the paint: the reply is an HTML string, so React never owned the
  // cells and cannot re-render a sorted one (see tableSort.ts).
  useEffect(() => {
    enhanceTables(ref.current);
  }, [html]);

  // One delegated handler per message: copy buttons, and a click on a local file link (a path
  // is not a URL — it must open the workspace panel, not navigate).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onClick = (ev: MouseEvent): void => {
      const hit = ev.target as HTMLElement | null;
      const fileLink = hit?.closest<HTMLElement>("a.md-file-link");
      if (fileLink) {
        ev.preventDefault();
        const path = fileLink.dataset.filePath ?? "";
        const line = Number(fileLink.dataset.fileLine ?? "") || undefined;
        if (path) openLocalFile({ path, ...(line ? { line } : {}) });
        return;
      }
      const target = hit?.closest("button[data-copy]");
      if (!target) return;
      const block = target.closest(".md-code")?.querySelector("code");
      const code = block?.textContent ?? "";
      // `copyText`, not `navigator.clipboard` directly: on the plain-http LAN entry the
      // clipboard API does not exist, and a bare `navigator.clipboard?.writeText(...).then`
      // threw on the undefined — no copy AND no feedback (the reported 「点击后没有触发复制」).
      void copyText(code).then((ok) => {
        target.textContent = ok ? "copied" : "copy failed";
        window.setTimeout(() => { target.textContent = "copy"; }, 1200);
      });
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, []);

  return <div className="md" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}
