// issue #120: Studio's injected metadata rides ACP `_meta.hermesStudio`, not the user text.
// The fork's surface_v1 turns it into a model-bound note; the persisted user row, Hindsight and
// title generation keep seeing only the operator's own words.

export type StudioSurfaceName = "studio-dispatch" | "studio-completion" | "voice-live";

export interface StudioSurfaceMeta {
  surface: StudioSurfaceName;
  /** JSON object: provenance / call state plus the text the model should read as a note. */
  studio_context: string;
}

function context(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

/** issue #120: keep a model-bound note inside the fork's 6000-char admission limit. Truncating
 *  the FINAL JSON produced half objects (and a raw-JSON fallback note); clip the payload instead. */
function clip(text: string, max = 4000): string {
  return text.length <= max ? text : text.slice(0, max) + "…（已截断）";
}

export interface StudioOrigin {
  sessionId: string;
  title?: string | null;
}

/** A task sent from another session: the task itself stays in `text`, the provenance goes in surface. */
export function dispatchSurface(
  origin: StudioOrigin,
  kind: "dispatch" | "handoff" | "spawn" = "dispatch",
  note?: string,
): StudioSurfaceMeta {
  return {
    surface: "studio-dispatch",
    studio_context: context({
      kind,
      sourceSessionId: origin.sessionId,
      sourceTitle: origin.title ?? null,
      dispatcher: origin.title || origin.sessionId,
      ...(note ? { text: clip(note) } : {}),
    }),
  };
}

/** A completion wake: the notice is model-bound only, so the durable user row stays empty. */
export function completionSurface(text: string, origin: StudioOrigin): StudioSurfaceMeta {
  return {
    surface: "studio-completion",
    studio_context: context({
      kind: "completion",
      sourceSessionId: origin.sessionId,
      sourceTitle: origin.title ?? null,
      text: clip(text),
    }),
  };
}
