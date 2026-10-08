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
const defaultLinkOpen: RendererRule = md.renderer.rules.link_open
  ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
const linkOpen: RendererRule = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, idx, options, env, self);
};
md.renderer.rules.link_open = linkOpen;

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
 *  on every chunk, and parsing the whole answer each time is the expensive part. */
export function renderMarkdown(text: string): string {
  const html = md.render(String(text ?? ""));
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["target", "rel", "data-copy"],
    // hljs classes and our own wrappers
    ADD_TAGS: ["div", "span", "button", "table", "thead", "tbody", "tr", "th", "td"],
  });
}

export function Markdown({ text }: { text: string }): JSX.Element {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const ref = useRef<HTMLDivElement>(null);

  // One delegated handler per message: copy buttons, and "open link" for anything the
  // browser would otherwise handle differently inside a webview.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onClick = (ev: MouseEvent): void => {
      const target = (ev.target as HTMLElement | null)?.closest("button[data-copy]");
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
