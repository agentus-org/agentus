// Tiny zero-dep markdown subset: fenced code, inline code, bold, links.
// Deliberately minimal — this UI holds no intelligence; heavy markdown can
// land in M3+ if backends start emitting rich content we must render.
import { Fragment, type ReactNode } from "react";

function inline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-i${i++}`;
    if (tok.startsWith("**")) nodes.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) nodes.push(<code key={key} className="inline">{tok.slice(1, -1)}</code>);
    else {
      const lm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok)!;
      nodes.push(<a key={key} href={lm[2]} target="_blank" rel="noreferrer">{lm[1]}</a>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function MiniMarkdown({ text }: { text: string }): ReactNode {
  const parts = text.split(/```/);
  return (
    <>
      {parts.map((seg, idx) =>
        idx % 2 === 1 ? (
          <pre key={idx} className="code"><code>{seg.replace(/^[a-z]*\n/, "").replace(/\n$/, "")}</code></pre>
        ) : (
          <Fragment key={idx}>{inline(seg, `p${idx}`)}</Fragment>
        ),
      )}
    </>
  );
}
