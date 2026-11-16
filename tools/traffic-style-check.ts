// The traffic layer's colours (src/traffic-style.ts), evaluated with MapLibre's own expression engine: the simple view
// leaves free-flowing roads uncoloured and puts each density in the documented band; the default gradient is unchanged.
//   npm run check:traffic-style
import { createExpression, Color } from '@maplibre/maplibre-gl-style-spec';
import { trafficColor, colorOf, drawnFrom, legendBackground, SIMPLE_BANDS, TRAFFIC_COLORS } from '../src/traffic-style';

let failures = 0;
const ok = (c: boolean, m: string) => { if (!c) { failures++; console.error('  ✗ ' + m); } };
const hex = (c: { r: number; g: number; b: number }) => '#' + [c.r, c.g, c.b].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
/** what MapLibre draws for a road whose feature-state density is `t` */
function evalColor(style: 'simple', t: number) {
  const e = createExpression(trafficColor(style, ['coalesce', ['feature-state', 't'], -1]) as any, { type: 'color', 'property-type': 'data-driven', expression: { interpolated: true, parameters: ['zoom', 'feature', 'feature-state'] } } as any);
  if (e.result !== 'success') throw new Error((e.value as any[]).map((x) => x.message).join('; '));
  const raw = e.value.evaluate({ zoom: 14 }, { type: 2, properties: {} } as any, { t }) as any;
  const c = typeof raw === 'string' ? Color.parse(raw) : raw;
  if (!c || typeof c.r !== 'number') throw new Error('not a colour: ' + JSON.stringify(c));
  return hex(c);
}

console.log('simple view');
ok(drawnFrom('simple') === 50 && drawnFrom('gradient') === 0, 'the simple view draws from 50 %, the gradient from 0 (as before)');
for (const d of [0, 10, 30, 49]) ok(colorOf('simple', d) === null, `${d} %: free-flowing, left uncoloured`);
const cases: [number, string][] = [[50, '#f6bf26'], [60, '#f6bf26'], [74, '#f6bf26'], [75, '#e8453c'], [89, '#e8453c'], [90, '#a31515'], [100, '#a31515']];
for (const [d, want] of cases) {
  ok(colorOf('simple', d) === want, `${d} %: ${want} in the legend's reckoning`);
  ok(evalColor('simple', d) === want, `${d} %: MapLibre draws ${want} (got ${evalColor('simple', d)})`);
}
ok(new Set(SIMPLE_BANDS.map(([, c]) => c)).size === 3 && SIMPLE_BANDS.every(([from], i) => i === 0 || from > SIMPLE_BANDS[i - 1][0]), 'three colours, in rising order');

console.log('gradient (default) unchanged');
// exactly the expression the traffic layer used before this view existed (the standalone style-spec package can't
// evaluate colour interpolation outside a style, so this compares the expression itself)
const v = ['coalesce', ['feature-state', 't'], -1];
ok(JSON.stringify(trafficColor('gradient', v as any)) === JSON.stringify(['interpolate', ['linear'], v, 0, '#34a853', 40, '#a8c530', 60, '#f6bf26', 80, '#f2853d', 100, '#d93025']), 'the gradient expression is the same as before');

console.log('legend');
const lg = legendBackground('simple');
ok(lg.startsWith('linear-gradient(90deg,transparent 0 50%') && SIMPLE_BANDS.every(([from, c]) => lg.includes(`${c} ${from}%`)) && lg.endsWith('var(--line)'), 'the simple legend shows no colour up to 50 %, then the three bands');
ok(legendBackground('gradient') === `linear-gradient(90deg,${TRAFFIC_COLORS.map(([, c]) => c).join(',')})`, 'the gradient legend is as before');

if (failures) { console.error(`\n${failures} traffic style check(s) failed`); process.exit(1); }
console.log('\ntraffic style checks passed');
