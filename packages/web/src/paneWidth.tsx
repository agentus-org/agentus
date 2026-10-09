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
