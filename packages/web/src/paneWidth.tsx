// Resizable side panes — the rail, the workspace panel, and the file tree inside it.
//
// The behaviour follows AionUi's `hooks/ui/useResizableSplit.tsx` (the reference the operator
// pointed at: 「左侧栏能否鼠标点击拉动啊，右侧栏也是」), minus what this project has no use for
// (ratio units, collapse-snapping). What is worth keeping from it, and why:
//
//   · **Pointer Events with `setPointerCapture`**, not mousemove-on-the-document: the pointer keeps
//     delivering to the handle even when it leaves the handle's box, and a finger works identically.
//   · **`e.buttons === 0` ends the drag** — a pointerup that lands outside the window (or on another
//     app) otherwise leaves the pane glued to the cursor forever.
//   · **rAF-throttled**: a width is a layout change, so at most one per frame.
//   · **`blur` ends the drag too** (⚠-tab / cmd-tab mid-drag).
//   · **The width is the operator's and it persists** (localStorage), and **double-clicking the
//     handle resets it** — the escape hatch from a pane dragged to a silly size.
//   · **One clamp, ordered**: each pane's `max()` is computed from the room the OTHER panes need, so
//     dragging can never squeeze the chat column to nothing. A stored width that no longer fits is
//     clamped AND written back, so a shrunken window does not poison the next load.
//
// The width goes out as a CSS custom property (`--rail-w` …) rather than an inline `width`, so the
// phone layout's own `width: auto` sheet rules (they live in later media queries) still win.
//
// `usePaneHeight` below is the same gesture turned 90° (2026-10-30: 「上下的分界线要和别的比如左边
// 会话栏一样，上下范围可以调节」). It is a second hook rather than a flag on the first because the two
// differ in more than the axis — a row split has no `rightEdge`/`MIN_CHAT` reserve, its ceiling comes
// from the CONTAINER (the panel's height) instead of the viewport's width, and its "reset" means
// half the container, not a fixed number. Sharing the drag loop while keeping the semantics separate
// is what keeps one of them from quietly reading the other's assumptions.
import { useCallback, useEffect, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from "react";

/** The chat column never goes below this — every pane's clamp is carved out against this reserve.
 *  Same number as AionUi's `MIN_CHAT_PANEL_PX` (360). */
export const MIN_CHAT = 360;

export interface PaneWidthOptions {
  /** localStorage key. The width is a preference, so it outlives the tab. */
  storage: string;
  /** Used before the operator ever drags, and by the double-click reset. */
  fallback: number;
  min: number;
  /** Upper bound, evaluated per render/resize against the viewport and the sibling panes. */
  max: () => number;
  /** The handle sits on the pane's RIGHT edge and dragging right should GROW it (the rail). */
  rightEdge?: boolean;
  /** aria-label / title for the handle. Web UI copy is English, like every other string here. */
  label: string;
}

export interface PaneWidth {
  width: number;
  handle: JSX.Element;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

function readStored(storage: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(storage);
    const n = raw === null ? Number.NaN : Number.parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    // a locked-down storage (Safari private mode) must not take the layout with it
    return fallback;
  }
}

function writeStored(storage: string, value: number): void {
  try {
    window.localStorage.setItem(storage, String(Math.round(value)));
  } catch {
    /* nothing to do — the drag still applies for this session */
  }
}

export interface PaneHeightOptions {
  /** localStorage key for the TOP pane's height, in px. */
  storage: string;
  /** The drag handle's aria-label / title. */
  label: string;
  /** Live height of the container the two rows share (the panel's content box). */
  containerPx: () => number;
  /** Neither row may go below this. A 60px row is not a pane, it is a divider with a title. */
  min: number;
}

export interface PaneHeight {
  /** The top row's height in px, already clamped. */
  height: number;
  handle: JSX.Element;
}

/**
 * Drag a HORIZONTAL divider to size the two rows it sits between.
 *
 * Same gesture contract as `usePaneWidth` — pointer capture, `buttons === 0` ends a drag whose
 * pointerup landed outside the window, rAF-throttled, `blur` ends it, double-click resets — because a
 * divider that behaves differently from the rail's would be a second thing to learn. What differs is
 * only where the numbers come from: the ceiling is `container - min` (both rows must stay visible),
 * and the reset is HALF the container rather than a fixed px value, since "half and half" is the
 * meaning of a split pane.
 */
export function usePaneHeight(options: PaneHeightOptions): PaneHeight {
  const { storage, label, containerPx, min } = options;
  const [want, setWant] = useState<number | null>(() => {
    try {
      const raw = window.localStorage.getItem(storage);
      const n = raw === null ? Number.NaN : Number.parseFloat(raw);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  });
  const [, setTick] = useState(0);

  // The ceiling is a function of the panel's height, which changes with the window and with the
  // panel's own width (the file tree wraps). Re-read it on resize, like the width hook does.
  useEffect(() => {
    const onResize = (): void => setTick((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const total = containerPx();
  const half = Math.max(min, Math.round((total - 6) / 2));
  const cap = Math.max(min, total - min - 6);
  const height = clamp(want ?? half, min, Math.max(min, cap));
  const heightRef = useRef(height);
  heightRef.current = height;

  // A stored height that no longer fits is clamped AND written back, so a shrunken window does not
  // poison the next load. Only when it was actually stored — otherwise the follow-the-half default
  // would freeze at whatever the panel happened to be on the first frame.
  useEffect(() => {
    if (want != null && want > cap) {
      setWant(Math.max(min, cap));
      writeStored(storage, Math.max(min, cap));
    }
  }, [want, cap, storage, min]);

  const onPointerDown = useCallback(
    (ev: ReactPointerEvent<HTMLDivElement>) => {
      if (ev.pointerType !== "touch" && ev.button !== 0) return;
      ev.preventDefault();
      const handle = ev.currentTarget;
      const startY = ev.clientY;
      const startH = heightRef.current;
      const limit = Math.max(min, containerPx() - min - 6);
      let latest = startH;
      let raf = 0;
      let done = false;
      const body = document.body;
      body.classList.add("pane-dragging-row");

      const finish = (clientY?: number): void => {
        if (done) return;
        done = true;
        if (raf) window.cancelAnimationFrame(raf);
        if (typeof clientY === "number") latest = clamp(startH + (clientY - startY), min, limit);
        setWant(latest);
        writeStored(storage, latest);
        body.classList.remove("pane-dragging-row");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        window.removeEventListener("blur", onBlur);
        handle.removeEventListener("lostpointercapture", onLost);
        try {
          if (handle.hasPointerCapture?.(ev.pointerId)) handle.releasePointerCapture(ev.pointerId);
        } catch {
          /* capture already gone */
        }
      };
      const onMove = (e: PointerEvent): void => {
        if (done) return;
        // Dragging DOWN grows the TOP row (the divider is under it) — the opposite sign to the rail.
        if (e.buttons === 0) { finish(e.clientY); return; }
        latest = clamp(startH + (e.clientY - startY), min, limit);
        if (raf) return;
        raf = window.requestAnimationFrame(() => { raf = 0; setWant(latest); });
      };
      const onUp = (e: PointerEvent): void => finish(e.clientY);
      const onBlur = (): void => finish();
      const onLost = (): void => finish();

      try { handle.setPointerCapture(ev.pointerId); } catch { /* the window listeners still carry it */ }
      handle.addEventListener("lostpointercapture", onLost);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      window.addEventListener("blur", onBlur);
    },
    [min, containerPx, storage],
  );

  const handle = (
    <div
      className="pane-handle-row"
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      title={`${label} — drag to resize, double-click for half and half`}
      onPointerDown={onPointerDown}
      onDoubleClick={() => {
        try { window.localStorage.removeItem(storage); } catch { /* private mode */ }
        setWant(null);
      }}
    >
      <span className="pane-handle-row-line" />
    </div>
  );

  return { height, handle };
}

export function usePaneWidth(options: PaneWidthOptions): PaneWidth {
  const { storage, fallback, min, max, rightEdge = false, label } = options;
  const [want, setWant] = useState<number>(() => readStored(storage, fallback));
  const [, setTick] = useState(0);

  // Re-evaluate the clamp when the window changes size: `max()` reads the viewport.
  useEffect(() => {
    const onResize = (): void => setTick((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const limit = Math.max(min, max());
  const width = clamp(want, min, limit);
  const widthRef = useRef(width);
  widthRef.current = width;

  // A width that no longer fits (the window shrank, a sibling grew) is clamped here AND persisted,
  // so the illegal value does not come back on the next load.
  useEffect(() => {
    if (want > limit) {
      setWant(limit);
      writeStored(storage, limit);
    }
  }, [want, limit, storage]);

  const onPointerDown = useCallback(
    (ev: ReactPointerEvent<HTMLDivElement>) => {
      if (ev.pointerType !== "touch" && ev.button !== 0) return;
      ev.preventDefault();
      const handle = ev.currentTarget;
      const startX = ev.clientX;
      const startW = widthRef.current;
      const cap = Math.max(min, max());
      let latest = startW;
      let raf = 0;
      let done = false;

      const body = document.body;
      body.classList.add("pane-dragging");

      const finish = (clientX?: number): void => {
        if (done) return;
        done = true;
        if (raf) window.cancelAnimationFrame(raf);
        if (typeof clientX === "number") {
          const delta = rightEdge ? clientX - startX : startX - clientX;
          latest = clamp(startW + delta, min, cap);
        }
        setWant(latest);
        writeStored(storage, latest);
        body.classList.remove("pane-dragging");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        window.removeEventListener("blur", onBlur);
        handle.removeEventListener("lostpointercapture", onLost);
        try {
          if (handle.hasPointerCapture?.(ev.pointerId)) handle.releasePointerCapture(ev.pointerId);
        } catch {
          /* capture already gone */
        }
      };

      const onMove = (e: PointerEvent): void => {
        if (done) return;
        // a pointerup we never saw (it landed outside the window) shows up as "no buttons held"
        if (e.buttons === 0) {
          finish(e.clientX);
          return;
        }
        const delta = rightEdge ? e.clientX - startX : startX - e.clientX;
        latest = clamp(startW + delta, min, cap);
        if (raf) return;
        raf = window.requestAnimationFrame(() => {
          raf = 0;
          setWant(latest);
        });
      };
      const onUp = (e: PointerEvent): void => finish(e.clientX);
      const onBlur = (): void => finish();
      const onLost = (): void => finish();

      try {
        handle.setPointerCapture(ev.pointerId);
      } catch {
        /* no capture available — the window listeners still carry the drag */
      }
      handle.addEventListener("lostpointercapture", onLost);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      window.addEventListener("blur", onBlur);
    },
    [min, max, rightEdge, storage],
  );

  const handle = (
    <div
      className="pane-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={`${label} — drag to resize, double-click to reset`}
      onPointerDown={onPointerDown}
      onDoubleClick={() => {
        setWant(fallback);
        writeStored(storage, fallback);
      }}
    >
      <span className="pane-handle-line" />
    </div>
  );

  return { width, handle };
}
