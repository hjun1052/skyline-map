// Chip and tab rows with a hidden scrollbar scroll with a mouse (issue #34, src/hscroll.ts): the wheel moves them
// sideways, a mouse drag pulls them along without toggling the chip let go of, and touch is left to the browser.
//   npm run check:hscroll
import { wheelShift, mouseScrollRows, DRAG_FROM, WHEEL_ROWS } from '../src/hscroll';

let failures = 0;
const ok = (c: boolean, m: string) => { if (!c) { failures++; console.error('  ✗ ' + m); } };
const wheel = (deltaY: number, o: Partial<{ deltaX: number; deltaMode: number; shiftKey: boolean }> = {}) => ({ deltaX: 0, deltaY, deltaMode: 0, shiftKey: false, ...o });

console.log('wheel');
const row = { scrollLeft: 0, scrollWidth: 900, clientWidth: 400 };
ok(wheelShift(row, wheel(100)) === 100, 'wheel down scrolls right');
ok(wheelShift({ ...row, scrollLeft: 200 }, wheel(-100)) === -100, 'wheel up scrolls left');
ok(wheelShift({ ...row, scrollLeft: 450 }, wheel(100)) === 50, 'stops at the right end');
ok(wheelShift({ ...row, scrollLeft: 500 }, wheel(100)) === 0, 'at the right end the wheel goes on to the page or panel');
ok(wheelShift(row, wheel(-100)) === 0, 'at the left end too');
ok(wheelShift({ ...row, scrollWidth: 400 }, wheel(100)) === 0, 'a row that fits is left alone');
ok(wheelShift(row, wheel(100, { deltaX: 120 })) === 0, 'sideways scrolling (touchpad) is left to the browser');
ok(wheelShift(row, wheel(100, { shiftKey: true })) === 0, 'shift-wheel is left to the browser');
ok(wheelShift(row, wheel(3, { deltaMode: 1 })) === 48, 'line-based wheels (Firefox) move by lines');

console.log('drag');
// a fake document: events carry the element they happened on, which sits in the row
class Ev extends Event {
  constructor(type: string, public over: unknown, init: Record<string, unknown> = {}) { super(type, { cancelable: true }); Object.assign(this, init); }
  get target() { return this.over as EventTarget; }
}
const root = new EventTarget();
const classes = new Set<string>();
// a row of the given kind: closest() answers only for the selector lists that name it
const rowLike = (sel: string) => {
  const r = { scrollLeft: 0, scrollWidth: 900, clientWidth: 400, classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) }, setPointerCapture() {}, closest: (q: string) => (q.split(', ').includes(sel) ? r : null) };
  return r;
};
const el = rowLike('#chips');
const chip = { closest: (q: string) => el.closest(q) };
mouseScrollRows(root);
// (a plain EventTarget has no capture phase, so a click counts when nothing cancelled it, as the chip would see it)
let clicks = 0;
const click = () => { if (root.dispatchEvent(new Ev('click', chip))) clicks++; };
const p = (type: string, clientX: number, pointerType = 'mouse') => root.dispatchEvent(new Ev(type, chip, { pointerId: 1, pointerType, button: 0, clientX }));

p('pointerdown', 300); p('pointermove', 300 - (DRAG_FROM - 1)); p('pointerup', 300 - (DRAG_FROM - 1));
click();
ok(el.scrollLeft === 0 && clicks === 1, 'a press that barely moves is still a click');

p('pointerdown', 300); p('pointermove', 250); p('pointermove', 180);
ok(el.scrollLeft === 120 && classes.has('row-dragging'), `dragging left scrolls the row right (scrollLeft ${el.scrollLeft})`);
p('pointerup', 180);
click();
ok(clicks === 1 && !classes.has('row-dragging'), 'letting go after a drag toggles nothing');
await new Promise((r) => setTimeout(r, 5));
click();
ok(clicks === 2, 'the next real click works');

el.scrollLeft = 0;
p('pointerdown', 300, 'touch'); p('pointermove', 200, 'touch'); p('pointerup', 200, 'touch');
ok(el.scrollLeft === 0, 'touch is left to the browser');

const w = new Ev('wheel', chip, { deltaX: 0, deltaY: 100, deltaMode: 0, shiftKey: false, ctrlKey: false });
root.dispatchEvent(w);
ok(el.scrollLeft === 100 && w.defaultPrevented, 'the wheel listener scrolls the row and keeps the page still');
const z = new Ev('wheel', chip, { deltaX: 0, deltaY: 100, deltaMode: 0, shiftKey: false, ctrlKey: true });
root.dispatchEvent(z);
ok(el.scrollLeft === 100 && !z.defaultPrevented, 'ctrl-wheel (browser zoom) is left alone');

// tabs inside a scrolling panel: the wheel keeps scrolling the panel, a drag still scrolls the tabs
ok(WHEEL_ROWS.includes('#chips') && !WHEEL_ROWS.includes('.dc-tabs') && !WHEEL_ROWS.includes('.ctx-tabs') && !WHEEL_ROWS.includes('.p-quick'), 'the wheel takes over only rows outside scrolling panels');
const tabs = rowLike('.dc-tabs'), tab = { closest: (q: string) => tabs.closest(q) };
const tw = new Ev('wheel', tab, { deltaX: 0, deltaY: 100, deltaMode: 0, shiftKey: false, ctrlKey: false });
root.dispatchEvent(tw);
ok(tabs.scrollLeft === 0 && !tw.defaultPrevented, 'wheel over Discover tabs is left to the panel');
const tp = (type: string, clientX: number) => root.dispatchEvent(new Ev(type, tab, { pointerId: 2, pointerType: 'mouse', button: 0, clientX }));
tp('pointerdown', 300); tp('pointermove', 240); tp('pointerup', 240);
ok(tabs.scrollLeft === 60, `a mouse drag still scrolls them (scrollLeft ${tabs.scrollLeft})`);

if (failures) { console.error(`\n${failures} row scrolling check(s) failed`); process.exit(1); }
console.log('\nrow scrolling checks passed');
