/** Which face stands for which agent — ONE table, because an agent must not wear two of them.
 *
 *  Two places draw it: the rail's row (`.be-avatar`, which adds the status dot and the live halo) and
 *  the transcript's own label on every reply. That label used to read a flat "AGENT": the class, not
 *  the agent, while the row right beside it showed a face. The operator asked for the reference
 *  behaviour instead (studio puts the mark on every message: 「Hermes 的话就放 hermes 的头像和 Hermes
 *  这个单词」).
 *
 *  It lives here rather than inside App.tsx so the table can be asserted without a browser
 *  (`scripts/qa/turn-pulse.mts`) — "hermes has an icon AND the word Hermes" is a data claim, not a
 *  rendering one, and the assets are shipped files (`packages/web/public/coding-agents/`).
 *
 *  Hermes and Qoder ship real brand artwork (hermes.png from the hermes-studio assets, qoder's
 *  favIcon from qoder.com) — use them wherever a backend has official art. The monogram is the
 *  fallback path (mock agent, missing asset, broken img) so a label ALWAYS renders something
 *  identifiable.
 */

export interface AgentMarkSpec {
  letter: string;
  label: string;
  icon?: string;
}

export const BACKEND_MARK: Record<string, AgentMarkSpec> = {
  hermes: { letter: "H", label: "Hermes", icon: "/coding-agents/hermes.png" },
  qoder: { letter: "Q", label: "Qoder", icon: "/coding-agents/qoder.svg" },
  mock: { letter: "M", label: "Mock" },
};

/** The spec for a backend, with the fallback folded in so both callers get identical behaviour.
 *  An unknown (or empty — a team session has no backend of its own) id yields a monogram, never a
 *  blank label; the transcript additionally falls back to the old word "AGENT" when even the
 *  monogram would be empty. */
export function markOf(backend: string): AgentMarkSpec {
  return BACKEND_MARK[backend] ?? { letter: backend.slice(0, 1).toUpperCase(), label: backend };
}
