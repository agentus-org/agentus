// "Open this local file in the workspace panel" — a one-way request from anywhere in the tree
// (a file link inside a reply, an image chip) to whoever owns the panel.
//
// Why a bus instead of a prop: the reply tree is memoised per message (`memo(Bubble, sameMsg)`),
// so a callback prop would either defeat the memo or need threading through three layers of
// components that have no business knowing about the panel. The panel is a single global-ish
// destination ("show me this file"), which is exactly what an event is for.
export interface FileRequest {
  path: string;
  /** 1-based line to put the cursor on, when the link carried `#L12` / `:12` */
  line?: number;
}

type Listener = (req: FileRequest) => void;

const listeners = new Set<Listener>();

/** Subscribe; returns the unsubscribe function (call it in an effect cleanup). */
export function onOpenLocalFile(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function openLocalFile(req: FileRequest): void {
  for (const fn of [...listeners]) {
    try {
      fn(req);
    } catch {
      /* one bad subscriber must not swallow the click for the others */
    }
  }
}
