/**
 * Plan semantics, in one place.
 *
 * ACP plan frames are whole-list snapshots (`plan` in v1 = replace semantics), and an agent's own
 * todo state dies with its PROCESS — which is why a plan used to vanish from the cockpit after a
 * restart (`tasks/20261001-agentus/design-plan-service.md` §1 has the forensics). So the server owns
 * the plan object (Store's `plans` table) and every writer funnels through here, so that they agree
 * on two things:
 *
 *   · NORMALISATION — the item shape the card renders. Unknown statuses pass through on purpose:
 *     ACP v2 adds `cancelled` and reserves `_`-prefixed unknowns, and a client that drops what it
 *     does not understand renders a plan that is quietly wrong.
 *   · the TURN LIFECYCLE rules — only the run closes a plan, never the agent (Studio's rule). A
 *     leftover `in_progress` step is demoted to `pending` (nothing is running it anymore) and the
 *     snapshot carries an honest terminal stamp.
 */
import type { PlanItem } from "@agentus/shared";

/** Studio caps its plan remark at 1000 chars; take the same bound rather than invent one. */
export const MAX_EXPLANATION = 1000;

export type PlanTerminal = "ended" | "interrupted" | "failed";
export type PlanSource = "acp" | "mcp" | "server";

/** Coerce whatever a writer sent (agent frame, MCP tool) into what the card renders. */
export function normalizeItems(raw: unknown): PlanItem[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const content = String(e.content ?? "").trim();
    if (!content) continue;
    const item: PlanItem = {
      content,
      // An entry with no status is not "completed" and not "in_progress": it is something the
      // agent listed and has not said anything else about.
      status: typeof e.status === "string" && e.status ? e.status : "pending",
    };
    if (typeof e.priority === "string" && e.priority) item.priority = e.priority;
    out.push(item);
  }
  return out;
}

/** Anything the run still owes the operator. `completed`/`cancelled` are closed; an UNKNOWN status
 *  counts as unfinished — a step we cannot interpret should not be reported as done. */
export function hasUnfinished(items: PlanItem[]): boolean {
  return items.some((i) => i.status !== "completed" && i.status !== "cancelled");
}

/** Demote steps that cannot still be running, because the run that owned them is over. */
export function demoteInProgress(items: PlanItem[]): PlanItem[] {
  return items.map((i) => (i.status === "in_progress" ? { ...i, status: "pending" } : i));
}

/** Studio's bound and Studio's tolerance: a non-string is dropped, not stringified. */
export function clampExplanation(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  return s.length > MAX_EXPLANATION ? s.slice(0, MAX_EXPLANATION) : s;
}

/** One writer per session.
 *
 *  Native frames and the plan MCP tool can both exist for the same session (Hermes emits frames AND
 *  could be handed the tool), and two writers means two plans racing on one card. The rule: whoever
 *  got there first keeps it — a session already fed by native frames never accepts a tool write.
 *  Cheap, and it fails in the direction that is visible (the frame's plan is the one on screen). */
export function acceptsWriteFrom(current: PlanSource | undefined, incoming: PlanSource): boolean {
  if (incoming === "server") return true; // the turn lifecycle is not a competing writer
  if (!current || current === "server") return true;
  return current === incoming;
}
