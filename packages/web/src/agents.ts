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

/**
 * Which backends the NEW-SESSION form may offer.
 *
 * The scripted mock agent is a QA backend: it answers with canned text and spends nothing, so on an
 * instance the operator actually works in it is a row that LOOKS like a working agent and is not
 * one. The server says whether this instance is a dev one (`/api/version.dev`, set from
 * `scripts/dev.sh`'s own `DEV_TREE`), and only there does it appear (operator, 2026-10-11:
 * 「默认不要放 mock agent 吧，这个不应该只在 dev 中使用吗」). Nothing else about the row changes: it
 * stays in 设置 → 后端, and the QA suites create mock sessions over the API.
 *
 * Lives here, with the other agent-facing tables, so the rule can be asserted without a browser
 * (`scripts/qa/backend-choice.mts`) — "mock is not offered on a live instance" is a data claim, not
 * a rendering one. If filtering would leave nothing to choose, the filter yields: an empty form is
 * worse than a dev backend on a machine that has nothing else.
 */
export function backendChoices<T extends { kind?: string }>(rows: T[], dev: boolean): T[] {
  const usable = rows.filter((row) => row.kind !== "mock" || dev);
  return usable.length ? usable : rows;
}
