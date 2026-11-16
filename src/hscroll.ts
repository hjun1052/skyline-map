// Rows of chips and tabs that scroll sideways, most with their scrollbar hidden (issue #34). Touchpads and
// touchscreens scroll them natively; a mouse can't (its wheel only turns up/down, and browsers don't drag-scroll), so
// here a mouse drag pulls them along, and on rows outside any scrolling panel the wheel scrolls them sideways.
// Touch and pen keep the browser's own scrolling.

/** the rows a mouse drag scrolls (some are re-rendered, so the drag listeners sit on the document) */
export const SCROLL_ROWS = '#chips, .dc-tabs, .ctx-tabs, .sm-modes, .p-quick';
/** the rows the wheel scrolls sideways: only those over the map or in a fixed header, since in a scrolling panel
 *  (Discover, context tabs, the phone sheet) the wheel passing over a row should keep scrolling the panel. Both
 *  elements persist, so the wheel listener goes on them alone and the rest of the page keeps passive scrolling. */
export const WHEEL_ROWS = '#chips, .sm-modes';
/** how far a mouse moves before a press becomes a drag (below it, it is still a click) */
export const DRAG_FROM = 5;

type Row = { scrollLeft: number; scrollWidth: number; clientWidth: number };

/** how far a wheel turn moves the row sideways; 0 leaves the event to the browser (sideways or shift-wheel, no
 *  overflow, or already at that end) */
export function wheelShift(row: Row, e: { deltaX: number; deltaY: number; deltaMode: number; shiftKey: boolean }): number {
  if (e.shiftKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return 0;
  const max = row.scrollWidth - row.clientWidth;
  if (max <= 1) return 0;
  const by = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? row.clientWidth : 1); // pixels, lines, pages
  return Math.min(max, Math.max(0, row.scrollLeft + by)) - row.scrollLeft;
}

const rowOf = (e: Event) => ((e.target as Element | null)?.closest?.(SCROLL_ROWS) ?? null) as (HTMLElement & Row) | null;

/** the wheel scrolls this row sideways while it overflows */
export function wheelScroll(row: EventTarget & Row) {
  row.addEventListener('wheel', (ev) => {
    const e = ev as WheelEvent;
    if (e.ctrlKey) return; // ctrl-wheel is the browser's zoom
    const by = wheelShift(row, e);
    if (!by) return;
    row.scrollLeft += by;
    e.preventDefault();
  }, { passive: false });
}

/** mouse drag on every row in SCROLL_ROWS, and the wheel on the WHEEL_ROWS found in `root` */
export function mouseScrollRows(root: Document | EventTarget = document) {
  if ('querySelectorAll' in root) root.querySelectorAll<HTMLElement>(WHEEL_ROWS).forEach(wheelScroll);

  let drag: { row: HTMLElement & Row; id: number; x: number; left: number; moved: boolean } | null = null;
  root.addEventListener('pointerdown', (ev) => {
    const e = ev as PointerEvent, row = rowOf(e);
    if (e.pointerType !== 'mouse' || e.button !== 0 || !row || row.scrollWidth - row.clientWidth <= 1) return;
    drag = { row, id: e.pointerId, x: e.clientX, left: row.scrollLeft, moved: false };
  });
  root.addEventListener('pointermove', (ev) => {
    const e = ev as PointerEvent;
    if (!drag || e.pointerId !== drag.id) return;
    // the button was let go of where no pointerup reached us (outside the window, before the drag took capture)
    if (!(e.buttons & 1)) { if (drag.moved) drag.row.classList.remove('row-dragging'); drag = null; return; }
    const dx = e.clientX - drag.x;
    if (!drag.moved) {
      if (Math.abs(dx) < DRAG_FROM) return;
      drag.moved = true;
      drag.row.setPointerCapture?.(e.pointerId);
      drag.row.classList.add('row-dragging');
    }
    drag.row.scrollLeft = drag.left - dx;
  });
  const end = (ev: Event) => {
    const e = ev as PointerEvent;
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (!d.moved) return;
    d.row.classList.remove('row-dragging');
    // the button let go of at the end of a drag still gets a click: it was a drag, so nothing toggles
    if (e.type === 'pointerup') {
      const swallow = (c: Event) => { c.stopImmediatePropagation(); c.preventDefault(); };
      root.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => root.removeEventListener('click', swallow, { capture: true }), 0);
    }
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
  // icons in a row would otherwise start the browser's image drag (and cancel the pointer)
  root.addEventListener('dragstart', (e) => { if (rowOf(e)) e.preventDefault(); });
}
