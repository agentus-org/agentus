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

/** One writer per session — and it is the AGENT's, whenever it has something to say.
 *
 *  Both channels can exist for the same session, and two writers means two plans racing on one card.
 *  The rule is not "whoever typed first" but *native priority*: a frame is the agent's own plan, so
 *  it is NEVER refused — it takes the card over from a tool-written plan — and once a frame has
 *  landed, `current` is "acp" and the tool is refused from then on. Failures land in the visible
 *  direction: the plan on screen is the agent's.
 *
 *  Since every backend is MCP-driven by default, `incoming: "acp"` is now only ever seen from a row
 *  that opted back into frames (session-manager's `#framesAccepted` drops the rest at the door), so
 *  this is a backstop rather than the everyday path. */
export function acceptsWriteFrom(current: PlanSource | undefined, incoming: PlanSource): boolean {
  if (incoming === "acp") return true; // the agent's own channel outranks any tool
  if (incoming === "server") return true; // the turn lifecycle is not a competing writer
  if (!current || current === "server") return true;
  return current === incoming;
}

/** ACP v2's plan updates (`session/update` → `plan_update`), behind an experiment switch.
 *
 *  v2 is still a draft: the SDK ships it under an experimental subpath and both ends of this wire
 *  declare protocolVersion 1, so NOTHING may depend on it yet. Parsing it anyway costs one branch,
 *  and it buys the property that matters for a draft schema — a client that ignores a frame it does
 *  not understand renders a plan that is quietly wrong. Off unless asked for: an experiment switch,
 *  not a feature flag. */
export function v2PlanEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENTUS_ACP_V2_PLAN === "1";
}

/** Fold a v2 `plan_update` payload back into the v1 frame shape, or null when it carries nothing a
 *  step list can render.
 *
 *  v2 wraps the entries one level deeper (`plan: { planId, type: "items", entries }`) and allows
 *  two other content kinds — `markdown` and `file` — which are NOT step lists; guessing a list out
 *  of them would put words on the card the agent never wrote as steps. It also allows several plans
 *  per session (`planId`), which is why the id is returned rather than ignored: the caller decides
 *  what to do with a second one. Kept pure (and exported) so the mapping can be unit-tested against
 *  the draft schema without a server. */
export function foldPlanUpdate(update: Record<string, unknown>): { entries: PlanItem[]; planId: string; meta: unknown } | null {
  const plan = (update?.plan ?? null) as { planId?: unknown; type?: unknown; entries?: unknown } | null;
  if (!plan || plan.type !== "items") return null;
  return {
    entries: normalizeItems(plan.entries),
    planId: String(plan.planId ?? ""),
    meta: update._meta ?? null,
  };
}
