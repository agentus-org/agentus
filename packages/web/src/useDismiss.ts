// Dismissal for the app's popovers, menus and sheets.
//
// The rule this module exists for: a popover must go away when the operator's attention
// moves elsewhere — a pointer landing outside it, or Escape. Relying on "click the trigger
// again" (or a lone × button) leaves the panel sitting there while the operator clicks a
// message, a different session, or plain empty space, which reads as broken.
//
// Two details that matter:
//  * pointerdown (not click) and in the CAPTURE phase: the popover closes on the first
//    touch, and a nested handler calling stopPropagation cannot keep it alive.
//  * Escape listens in the BUBBLE phase on purpose, so an inner control (a text field in
//    edit mode, say) gets the first Escape and can stopPropagation to mean "one step back,
//    not closes". The second Escape then lands here and dismisses.
import { useEffect, useRef, type RefObject } from "react";

/** Close when the pointer goes down outside `refs`, or when Escape is pressed.
 *  Pass the trigger as one of `refs` so re-clicking it toggles instead of
 *  close-then-reopen. */
export function useDismiss(
  open: boolean,
  refs: Array<RefObject<HTMLElement>>,
  onClose: () => void,
): void {
  // keep the latest values without re-subscribing on every render
  const liveRefs = useRef(refs);
  liveRefs.current = refs;
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null): boolean =>
      liveRefs.current.some((r) => r.current && target instanceof Node && r.current.contains(target));

    const onDown = (e: Event): void => {
      if (!inside(e.target)) close.current();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !e.defaultPrevented) close.current();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
}

/** Escape alone — for modal sheets whose outside-click is already handled by a backdrop. */
export function useEscape(active: boolean, onClose: () => void): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !e.defaultPrevented) close.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active]);
}
