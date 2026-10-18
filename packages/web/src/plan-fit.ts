// Fit step text on a phone: shrink the type a little so a long step stays on ONE line.
//
// The operator's ask (2026-10-18): 「计划里面每个步骤…它也会换行，我不太喜欢它换行…手机上面能不能缩小
// 字体？就是它如果出现字数太多」. Wrapping is what breaks the rhythm of the list — every wrapped step
// doubles the card's height and the check icons stop lining up — so on a narrow screen the answer is
// smaller type, not another line.
//
// Why this is measured instead of styled: how much a step needs to shrink depends on the text and on
// the width the card actually got, neither of which CSS knows. So we render at the stylesheet's size,
// look at whether the text still wraps, and step down by 0.5px until it does not — with a FLOOR,
// because 6px type that fits is worse than two lines that read.
//
// Desktop is left alone on purpose: there is width to spare, and shrinking there would be a fix for a
// problem the operator does not have.

/** The floor. Below this, going smaller stops being readable and wrapping is the better trade. */
const MIN_PX = 9.5;

/** Only phones. 720px is the width the rest of the cockpit treats as the phone breakpoint. */
const NARROW = "(max-width: 720px)";

/** True when the element's text has run onto a second line. `lineHeight` can be "normal" in some
 *  engines, hence the fontSize fallback — guessing 1.4 is right to within a rounding error, and the
 *  comparison below has a tolerance anyway. */
function wraps(el: HTMLElement, lineH: number): boolean {
  return el.getBoundingClientRect().height > lineH * 1.2;
}

/** Shrink every `.step-title` under `root` until it fits, or until the floor. Idempotent: each call
 *  starts from the stylesheet's own size, so a re-render (or a resize back to desktop) never leaves a
 *  stale inline size behind. */
export function fitPlanSteps(root: HTMLElement | null | undefined): void {
  if (!root || typeof window === "undefined") return;
  const narrow = window.matchMedia?.(NARROW)?.matches ?? false;
  const titles = [...root.querySelectorAll<HTMLElement>(".step-title")];
  // Reset first: a re-render (or a resize back to desktop) must never inherit a stale inline size.
  const sizes = titles.map((title) => { title.style.fontSize = ""; return null as number | null; });
  if (!narrow) return;

  let smallest = Infinity;
  for (let i = 0; i < titles.length; i++) {
    const title = titles[i];
    const cs = getComputedStyle(title);
    const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
    let px = parseFloat(cs.fontSize) || 13;
    // The step's own box is what the text has to fit in: `flex: 1; min-width: 0` means its width is
    // already the remaining space, so wrapping is exactly what we measure.
    while (wraps(title, lineH) && px > MIN_PX) {
      px = Math.round((px - 0.5) * 10) / 10;
      title.style.fontSize = `${px}px`;
    }
    sizes[i] = px;
    smallest = Math.min(smallest, px);
  }

  // One size for the whole list. A step shrunk on its own reads as a mistake next to its neighbours —
  // the list is scanned as a column, so the column gets the size the longest step demanded.
  if (Number.isFinite(smallest)) {
    for (const title of titles) title.style.fontSize = `${smallest}px`;
  }
}
