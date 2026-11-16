// Route shields on the map: a road whose name is exactly a route designation ("I-4", "US 27", "CR 44", "SR 35",
// "국도 제1호선"…) gets a shield with the number along it, as on Apple and Google Maps, instead of its text label.
//
// Recognition is deliberately strict: a rule matches the WHOLE name (after trimming), so "Interstate 4 Express Lanes",
// "Crystal Road", "US Bank Way", "I-4 Exit 72" or "Expressway 9th Ave" stay normal text labels. Names without a
// number (most Korean in-game names, like "경부고속도로") get no shield: the number is never guessed.
//
// Extending: add rules to RULES (country, style, pattern, how to read the number) and, for a new look, a drawer to
// DRAWERS. Nothing else needs to change; the map asks for shield images by id ("shield:<style>:<ref>").

export type ShieldStyle = 'us-interstate' | 'us-route' | 'us-state' | 'us-county' | 'kr-expressway' | 'kr-national' | 'kr-local';
export interface Shield { style: ShieldStyle; ref: string }
interface Rule { country: string; style: ShieldStyle; re: RegExp; ref?: (m: RegExpMatchArray) => string }

// "4", "35E", "95A": up to 3 digits (4 for county and state roads) and an optional single letter
const DIR = String.raw`(?:\s+(?:N|S|E|W|NB|SB|EB|WB|North|South|East|West|Northbound|Southbound|Eastbound|Westbound))?`;
const STATES = 'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY';

export const RULES: Rule[] = [
  // Interstates: I-4, I 4, I-35E, Interstate 4, Interstate Highway 95, I-95 North
  { country: 'US', style: 'us-interstate', re: new RegExp(String.raw`^(?:I-\s?|I\s|Interstate\s+(?:Highway\s+)?)([1-9]\d{0,2}[ENWSC]?)${DIR}$`) },
  // U.S. Routes: US 27, US-27, U.S. 27, U.S. Route 27, US Hwy 27, U.S. Highway 27, United States Route 27
  { country: 'US', style: 'us-route', re: new RegExp(String.raw`^(?:U\.?S\.?(?:\s*-\s*|\s+)(?:(?:Route|Rte\.?|Highway|Hwy\.?)\s+)?|United\s+States\s+(?:Route|Highway)\s+)([1-9]\d{0,2}[A-Z]?)${DIR}$`) },
  // County roads: CR 44, CR-44, C.R. 44, County Road 44, County Rd 44, County Route 44
  { country: 'US', style: 'us-county', re: new RegExp(String.raw`^(?:C\.?R\.?(?:\s*-\s*|\s+)|County\s+(?:Road|Rd\.?|Route)\s+)([1-9]\d{0,3}[A-Z]?)${DIR}$`) },
  // State roads: SR 35, S.R. 35, State Road 35, State Route 35, State Highway 35, FL-35, NY 500 (one generic shield)
  { country: 'US', style: 'us-state', re: new RegExp(String.raw`^(?:S\.?R\.?(?:\s*-\s*|\s+)|State\s+(?:Road|Route|Highway|Hwy\.?)\s+|(?:${STATES})(?:\s*-\s*|\s+))([1-9]\d{0,3}[A-Z]?)${DIR}$`) },
  // Korean expressways with their number: 고속국도 제1호선, 고속도로 1호선, 제1호 고속국도
  { country: 'KR', style: 'kr-expressway', re: /^(?:고속국도|고속도로)\s*제?([1-9]\d{0,2})호선?$|^제?([1-9]\d{0,2})호선?\s*(?:고속국도|고속도로)$/u, ref: (m) => m[1] ?? m[2] },
  // Korean national roads: 국도 제1호선, 일반국도 1호선, 1번 국도, 국도 1호, National Route 1
  { country: 'KR', style: 'kr-national', re: /^(?:(?:일반)?국도\s*제?([1-9]\d?)호선?|제?([1-9]\d?)번\s*국도|National\s+Route\s+([1-9]\d?))$/u, ref: (m) => m[1] ?? m[2] ?? m[3] },
  // Korean provincial roads: 지방도 제313호선, 지방도 313호선, 313번 지방도
  { country: 'KR', style: 'kr-local', re: /^(?:지방도\s*제?([1-9]\d{0,3})호선?|제?([1-9]\d{0,3})번\s*지방도)$/u, ref: (m) => m[1] ?? m[2] },
];

/** the shield for a road name, or null when it isn't (exactly) a route designation */
export function parseShield(name: string): Shield | null {
  const n = name.trim().replace(/\s+/g, ' ');
  if (!n || n.length > 40) return null;
  for (const r of RULES) {
    const m = n.match(r.re);
    if (m) { const ref = (r.ref ? r.ref(m) : m[1])?.toUpperCase(); if (ref) return { style: r.style, ref }; }
  }
  return null;
}

export const shieldImageId = (s: Shield) => `shield:${s.style}:${s.ref}`;
export function parseImageId(id: string): Shield | null {
  const m = /^shield:([a-z-]+):([0-9A-Z]{1,5})$/.exec(id);
  return m && m[1] in DRAWERS ? { style: m[1] as ShieldStyle, ref: m[2] } : null;
}

// ------------------------------------------------------------------ drawing

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
interface Look { w: number; h: number; text: string; font: number; ty?: number; draw: (g: Ctx, w: number, h: number) => void }

/** a classic shield outline (flat top, curved sides meeting at the bottom point), inset by `i` */
function shieldPath(g: Ctx, w: number, h: number, i = 0, top = 0) {
  g.beginPath();
  g.moveTo(i, top + i);
  g.lineTo(w - i, top + i);
  g.bezierCurveTo(w - i, h * 0.55, w * 0.75, h * 0.86, w / 2, h - i);
  g.bezierCurveTo(w * 0.25, h * 0.86, i, h * 0.55, i, top + i);
  g.closePath();
}
const rounded = (g: Ctx, x: number, y: number, w: number, h: number, r: number) => { g.beginPath(); g.roundRect(x, y, w, h, r); };
/** width for a number of `n` characters */
const widthFor = (n: number, base: number, per: number) => base + Math.max(0, n - 2) * per;

export const DRAWERS: Record<ShieldStyle, (ref: string) => Look> = {
  'us-interstate': (ref) => ({
    w: widthFor(ref.length, 26, 6), h: 28, text: '#fff', font: ref.length > 2 ? 11 : 12, ty: 0.6,
    draw: (g, w, h) => {
      shieldPath(g, w, h); g.fillStyle = '#fff'; g.fill();
      shieldPath(g, w, h, 1.5); g.fillStyle = '#1f4fa8'; g.fill();
      g.save(); shieldPath(g, w, h, 1.5); g.clip(); g.fillStyle = '#c62828'; g.fillRect(0, 0, w, h * 0.3); g.restore();
    },
  }),
  'us-route': (ref) => ({
    w: widthFor(ref.length, 24, 6), h: 26, text: '#111', font: ref.length > 2 ? 11 : 12, ty: 0.48,
    draw: (g, w, h) => { shieldPath(g, w, h); g.fillStyle = '#111'; g.fill(); shieldPath(g, w, h, 1.6); g.fillStyle = '#fff'; g.fill(); },
  }),
  'us-state': (ref) => ({
    w: widthFor(ref.length, 24, 6), h: 22, text: '#111', font: ref.length > 2 ? 11 : 12,
    draw: (g, w, h) => { rounded(g, 0, 0, w, h, 4); g.fillStyle = '#111'; g.fill(); rounded(g, 1.5, 1.5, w - 3, h - 3, 3); g.fillStyle = '#fff'; g.fill(); },
  }),
  'us-county': (ref) => ({
    w: widthFor(ref.length, 26, 6), h: 26, text: '#f9c80e', font: ref.length > 2 ? 10.5 : 11.5, ty: 0.55,
    draw: (g, w, h) => {
      const pent = (i: number) => { g.beginPath(); g.moveTo(w * 0.2 + i, i); g.lineTo(w * 0.8 - i, i); g.lineTo(w - i, h * 0.38); g.lineTo(w / 2, h - i); g.lineTo(i, h * 0.38); g.closePath(); };
      pent(0); g.fillStyle = '#f9c80e'; g.fill(); pent(1.6); g.fillStyle = '#1e5bb8'; g.fill();
    },
  }),
  'kr-expressway': (ref) => ({
    w: widthFor(ref.length, 26, 6), h: 28, text: '#fff', font: ref.length > 2 ? 11 : 12, ty: 0.6,
    draw: (g, w, h) => {
      shieldPath(g, w, h); g.fillStyle = '#fff'; g.fill();
      shieldPath(g, w, h, 1.5); g.fillStyle = '#1d5fb5'; g.fill();
      g.save(); shieldPath(g, w, h, 1.5); g.clip(); g.fillStyle = '#d7263d'; g.fillRect(0, 0, w, h * 0.24); g.restore();
    },
  }),
  'kr-national': (ref) => ({
    w: widthFor(ref.length, 26, 6), h: 22, text: '#fff', font: 12,
    draw: (g, w, h) => { rounded(g, 0, 0, w, h, h / 2); g.fillStyle = '#fff'; g.fill(); rounded(g, 1.5, 1.5, w - 3, h - 3, (h - 3) / 2); g.fillStyle = '#1d5fb5'; g.fill(); },
  }),
  'kr-local': (ref) => ({
    w: widthFor(ref.length, 26, 6), h: 22, text: '#1b2a4a', font: ref.length > 3 ? 10.5 : 11.5,
    draw: (g, w, h) => { rounded(g, 0, 0, w, h, 4); g.fillStyle = '#fff'; g.fill(); rounded(g, 1.5, 1.5, w - 3, h - 3, 3); g.fillStyle = '#f6c343'; g.fill(); },
  }),
};

/** the shield image, drawn at `ratio` × its size (crisp on high-DPI screens); null outside a browser */
export function drawShield(s: Shield, ratio = 2): ImageData | null {
  const look = DRAWERS[s.style](s.ref);
  if (typeof OffscreenCanvas === 'undefined' && typeof document === 'undefined') return null;
  const W = Math.ceil(look.w * ratio), H = Math.ceil(look.h * ratio);
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = c.getContext('2d') as Ctx | null;
  if (!g) return null;
  g.scale(ratio, ratio);
  look.draw(g, look.w, look.h);
  g.fillStyle = look.text;
  g.font = `700 ${look.font}px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(s.ref, look.w / 2, look.h * (look.ty ?? 0.53), look.w - 6);
  return g.getImageData(0, 0, W, H);
}
