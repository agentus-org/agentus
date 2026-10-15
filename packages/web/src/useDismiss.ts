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
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** How close to an edge a popover is allowed to come, in px. */
const EDGE = 10;
/** The gap between the trigger and the list it opens (matches the old CSS: calc(100% + 6px)). */
const GAP = 6;

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

/** Fit a popover to the room it actually has, and start it on the current choice.
 *
 *  `.tb-list` is `position: fixed` (theme.css explains why: a dialog would otherwise clip it), so
 *  somebody has to say where it goes — CSS cannot know where the trigger landed. That is this hook:
 *  top/left from the trigger's box, clamped into the window, height capped to the room on the side it
 *  opens toward. Which side: alternate by room, which comes out as "upward in the chat page" (its
 *  composer sits at the bottom of the window, 700+px of room above) and "downward in the new-session
 *  dialog" (measured 2026-10-15, 1440×900: 413px above vs 437 below).
 *
 *  Phones are left alone: the 720px query pins the list to the viewport as a sheet above the
 *  composer, which is the right shape there and does not need measuring.
 *
 *  And it brings the current row into view: with 439 models the selection sits far down the list,
 *  and "which model am I on" must not require a hunt. */
export function usePopoverFit<T extends HTMLElement>(): RefObject<T> {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = (): void => {
      el.style.top = "";
      el.style.left = "";
      el.style.maxHeight = "";
      if (window.matchMedia("(max-width: 720px)").matches) return;
      const wrap = el.parentElement;
      const anchor = (wrap?.firstElementChild ?? wrap)?.getBoundingClientRect();
      if (!anchor) return;
      const natural = el.getBoundingClientRect().height;
      const above = anchor.top - EDGE;
      const below = window.innerHeight - anchor.bottom - EDGE;
      const openBelow = below > above;
      const room = Math.min(Math.max(above, below), window.innerHeight * 0.46);
      el.style.maxHeight = `${Math.round(room)}px`;
      const height = Math.min(natural, room);
      el.style.top = `${Math.round(openBelow ? anchor.bottom + GAP : anchor.top - GAP - height)}px`;
      // sideways the list is wider than the mid-bar button it hangs from, so align on the trigger's
      // left edge but never let it leave the window
      const width = el.getBoundingClientRect().width;
      el.style.left = `${Math.round(Math.min(Math.max(anchor.left, EDGE), window.innerWidth - EDGE - width))}px`;
      const sel = el.querySelector<HTMLElement>(".tb-opt.sel");
      const scroller = sel?.closest<HTMLElement>(".tb-scroll") ?? el;
      if (sel) {
        const s = sel.getBoundingClientRect();
        const b = scroller.getBoundingClientRect();
        if (s.top < b.top) scroller.scrollTop -= b.top - s.top + 8;
        else if (s.bottom > b.bottom) scroller.scrollTop += s.bottom - b.bottom + 8;
      }
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  return ref;
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
