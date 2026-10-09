// Tables in a reply: click a header to sort, and open one full-screen to read a wide table on a
// phone.
//
// Why post-render DOM work instead of React: a reply is rendered from an HTML string
// (dangerouslySetInnerHTML in Markdown.tsx — markdown-it + DOMPurify), so React never owned the
// table's cells and cannot re-render a sorted one. Enhancing the DOM after the paint is the same
// choice hermes-webui made (`enhanceMarkdownTables` in static/messages.js), and the operator
// pointed at that implementation as the one to follow:
//   · sorting is `localeCompare(..., {numeric:true})`, so "10" lands after "9";
//   · ties keep the original order (a hidden original-row index decides), so a second sort does
//     not shuffle equal rows;
//   · `aria-sort` is set on the header cell, and the sort control is a real <button> inside it,
//     so the column can be sorted by keyboard and screen readers hear which way it points;
//   · a filter box appears once a table has a few rows (search is what you actually want on a
//     30-row table, and it is free once the rows are in the DOM).
//
// The phone case is why the overlay exists rather than a CSS-only answer: iOS has no
// `screen.orientation.lock` (it throws), so "横屏看表格" CANNOT be done by asking the device to
// rotate. What it can be is the table rotated inside a full-screen overlay, which is what
// `.md-table-zoom.rot` does — the widest axis of the phone becomes the table's horizontal axis.
import { copyText } from "./clipboard";

const ENHANCED = "data-agentus-table";
const MIN_ROWS_FOR_FILTER = 4;

interface SortState {
  col: number;
  dir: SortDir;
}

/** Three states, and the third one matters: a click cycle of asc → desc → OFF. The off state
 *  restores the table's own row order (kept in `data-md-row` when the table was enhanced), because
 *  without it the operator has no way back from a sort — the rows stay in whatever order the second
 *  click left them, and 「撤销排序」 is not something a data table can express by staying sorted. */
type SortDir = "asc" | "desc" | "none";

const INDICATOR_IDLE = "⇕";
const INDICATOR: Record<SortDir, string> = { asc: "▲", desc: "▼", none: INDICATOR_IDLE };

/** The text of a cell without the sort control's own label/indicator inside it. */
function cellText(cell: HTMLTableCellElement | undefined | null): string {
  if (!cell) return "";
  const button = cell.querySelector(".md-table-sort");
  if (button) return (button.querySelector(".md-table-sort-label")?.textContent ?? "").trim();
  return (cell.textContent ?? "").trim();
}

function sortBody(table: HTMLTableElement, col: number, dir: SortDir): void {
  const body = table.tBodies[0];
  if (!body) return;
  const rows = Array.from(body.rows).filter((r) => r.parentElement === body);
  const original = (row: HTMLTableRowElement): number => Number(row.dataset.mdRow ?? 0);
  rows.sort((a, b) => {
    // OFF: the document's own order, which is what the table asked to be read as
    if (dir === "none") return original(a) - original(b);
    const cmp = cellText(a.cells[col]).localeCompare(cellText(b.cells[col]), undefined, {
      numeric: true,
      sensitivity: "base",
    });
    if (cmp !== 0) return dir === "asc" ? cmp : -cmp;
    return original(a) - original(b);
  });
  for (const row of rows) body.appendChild(row);
}

/** Clone a table for the overlay, with its sort state dropped (the overlay re-enhances it). */
function cloneForOverlay(table: HTMLTableElement): HTMLTableElement {
  const clone = table.cloneNode(true) as HTMLTableElement;
  clone.removeAttribute(ENHANCED);
  // the sort controls are decoration: rebuild them in the overlay instead of copying the
  // "currently sorted" arrows into a table whose order does not match them
  for (const btn of Array.from(clone.querySelectorAll(".md-table-sort"))) {
    const label = btn.querySelector(".md-table-sort-label");
    const cell = btn.parentElement;
    if (cell && label) {
      cell.textContent = label.textContent ?? "";
      cell.removeAttribute("aria-sort");
    }
  }
  return clone;
}

/** Full-screen reader for one table. Imperative on purpose: it lives outside the React tree
 *  (the reply is an HTML string), so a React portal would need a state round-trip for a view
 *  that is transient and owns nothing. */
export function openTableOverlay(source: HTMLTableElement): void {
  if (document.querySelector(".md-table-overlay")) return;
  const overlay = document.createElement("div");
  overlay.className = "md-table-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "table");

  const bar = document.createElement("div");
  bar.className = "md-table-bar";
  const rotate = document.createElement("button");
  rotate.type = "button";
  rotate.className = "md-table-btn";
  rotate.textContent = "rotate";
  const spacer = document.createElement("span");
  spacer.className = "head-spacer";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "md-table-btn";
  copy.textContent = "copy";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "md-table-btn";
  close.textContent = "close";
  close.setAttribute("aria-label", "close table");
  bar.append(rotate, spacer, copy, close);

  const stage = document.createElement("div");
  stage.className = "md-table-stage";
  const zoom = document.createElement("div");
  // `md` too, not just `md-table-zoom`: the overlay is appended to document.body, i.e. OUTSIDE the
  // rendered markdown's subtree — so every rule written as `.md th, .md td { … }` (the cell borders,
  // the padding, the header fill) simply does not match here and the enlarged table arrived with no
  // grid at all. Carrying the class puts the same rules back in scope; `.md-table-zoom table` is the
  // more specific selector, so the zoom's own `display: table` still wins over `.md table`.
  zoom.className = "md-table-zoom md";
  const table = cloneForOverlay(source);
  zoom.appendChild(table);
  stage.appendChild(zoom);
  overlay.append(bar, stage);
  document.body.appendChild(overlay);

  enhanceTables(zoom);

  // Portrait phones cannot be forced into landscape; rotating the CONTENT is the honest
  // substitute, and it is opt-out (the operator may want to read it upright).
  const portrait = window.innerHeight > window.innerWidth;
  zoom.classList.toggle("rot", portrait);

  const closeOverlay = (): void => {
    overlay.remove();
    window.removeEventListener("keydown", onKey);
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") closeOverlay();
  };
  window.addEventListener("keydown", onKey);
  rotate.addEventListener("click", () => zoom.classList.toggle("rot"));
  close.addEventListener("click", closeOverlay);
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay || ev.target === stage) closeOverlay();
  });
  copy.addEventListener("click", () => {
    // tab-separated: pastes into a spreadsheet as a grid
    const lines = Array.from(table.rows).map((row) =>
      Array.from(row.cells).map((c) => cellText(c).replace(/\s+/g, " ")).join("\t"));
    void copyText(lines.join("\n")).then((ok) => {
      copy.textContent = ok ? "copied" : "copy failed";
      window.setTimeout(() => { copy.textContent = "copy"; }, 1200);
    });
  });
  close.focus();
}

/** Wire every not-yet-wired table under `root`: sortable headers, a filter for long tables and
 *  a button that opens the full-screen reader. Idempotent (a re-render re-runs it cheaply). */
export function enhanceTables(root: HTMLElement | null): void {
  if (!root?.querySelectorAll) return;
  for (const table of Array.from(root.querySelectorAll<HTMLTableElement>(`table:not([${ENHANCED}])`))) {
    // a table inside a code block is example text, not data
    if (table.closest(".md-code") || table.closest(".file-source")) continue;
    const headerRow = table.tHead?.rows[0] ?? table.rows[0];
    const body = table.tBodies[0];
    if (!headerRow || !body || body.rows.length === 0) continue;
    table.setAttribute(ENHANCED, "1");

    const state: SortState = { col: -1, dir: "asc" };
    Array.from(body.rows).forEach((row, i) => { row.dataset.mdRow = String(i); });

    for (const [col, cell] of Array.from(headerRow.cells).entries()) {
      const name = (cell.textContent ?? "").trim() || `column ${col + 1}`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "md-table-sort";
      button.title = `sort by ${name}`;
      button.setAttribute("aria-label", `sort by ${name}`);
      // keep the header's own markup (bold, code) inside the button's label
      const label = document.createElement("span");
      label.className = "md-table-sort-label";
      while (cell.firstChild) label.appendChild(cell.firstChild);
      const indicator = document.createElement("span");
      indicator.className = "md-table-sort-indicator";
      indicator.setAttribute("aria-hidden", "true");
      indicator.textContent = "⇕";
      cell.setAttribute("aria-sort", "none");
      button.append(label, indicator);
      button.addEventListener("click", () => {
        // asc → desc → OFF (and OFF is sticky: clicking the same header again starts over at asc)
        const next: SortDir =
          state.col !== col ? "asc" : state.dir === "asc" ? "desc" : state.dir === "desc" ? "none" : "asc";
        state.col = col;
        state.dir = next;
        for (const other of Array.from(headerRow.cells)) {
          other.setAttribute("aria-sort", "none");
          const ind = other.querySelector(".md-table-sort-indicator");
          if (ind) ind.textContent = INDICATOR_IDLE;
        }
        if (next === "none") {
          cell.setAttribute("aria-sort", "none");
          indicator.textContent = INDICATOR_IDLE;
        } else {
          cell.setAttribute("aria-sort", next === "asc" ? "ascending" : "descending");
          indicator.textContent = INDICATOR[next];
        }
        sortBody(table, col, next);
      });
      cell.appendChild(button);
    }

    // A bar above the table: the filter (only when there is something to filter) and the
    // full-screen reader, which is the phone-sized answer to a wide table.
    const bar = document.createElement("div");
    bar.className = "md-table-bar";
    if (body.rows.length >= MIN_ROWS_FOR_FILTER) {
      const filter = document.createElement("input");
      filter.type = "search";
      filter.className = "md-table-filter";
      filter.placeholder = "filter rows…";
      filter.setAttribute("aria-label", `filter ${headerRow.cells.length}-column table`);
      filter.autocomplete = "off";
      filter.addEventListener("input", () => {
        const q = filter.value.trim().toLowerCase();
        for (const row of Array.from(body.rows)) {
          row.hidden = Boolean(q) && !(row.textContent ?? "").toLowerCase().includes(q);
        }
      });
      bar.appendChild(filter);
    }
    const expand = document.createElement("button");
    expand.type = "button";
    expand.className = "md-table-btn";
    expand.title = "open this table full screen (landscape on a phone)";
    expand.setAttribute("aria-label", "open table full screen");
    expand.textContent = "⤢";
    expand.addEventListener("click", () => openTableOverlay(table));
    bar.appendChild(expand);
    table.parentElement?.insertBefore(bar, table);
  }
}
