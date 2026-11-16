// How the traffic layer colours a road's density (the game's m_trafficDensity, 0-100 %), in one place so the map,
// the legend and the checks agree.
//   gradient (default, as before): every matched road, green through red, like the game's own traffic view
//   simple: only slowdowns are coloured, like most navigation apps: yellow (slow), red (heavy), dark red (jammed);
//           free-flowing roads keep their normal (or neutral) road colour
import type { ExpressionSpecification } from 'maplibre-gl';

export type TrafficStyle = 'gradient' | 'simple';

/** gradient view: density → colour stops */
export const TRAFFIC_COLORS: [number, string][] = [[0, '#34a853'], [40, '#a8c530'], [60, '#f6bf26'], [80, '#f2853d'], [100, '#d93025']];

/**
 * simple view: [lowest density, colour] per band; nothing is drawn below the first. The bands sit where the gradient
 * already reads as yellow, orange-red and red, so a road looks equally busy in both views.
 */
export const SIMPLE_BANDS: [number, string][] = [[50, '#f6bf26'], [75, '#e8453c'], [90, '#a31515']];

/** the lowest density the view draws at all (densities below it are left uncoloured) */
export const drawnFrom = (s: TrafficStyle) => (s === 'simple' ? SIMPLE_BANDS[0][0] : 0);

/** the line colour for a density expression `v` (which is -1 where a road has no value; those aren't drawn anyway) */
export function trafficColor(s: TrafficStyle, v: ExpressionSpecification): ExpressionSpecification {
  if (s === 'simple') return ['step', v, SIMPLE_BANDS[0][1], ...SIMPLE_BANDS.slice(1).flat()] as ExpressionSpecification;
  return ['interpolate', ['linear'], v, ...TRAFFIC_COLORS.flat()] as ExpressionSpecification;
}

/** the colour a density gets (for the legend and checks); null where the view leaves the road uncoloured */
export function colorOf(s: TrafficStyle, density: number): string | null {
  if (density < drawnFrom(s)) return null;
  if (s === 'simple') { let c = SIMPLE_BANDS[0][1]; for (const [from, col] of SIMPLE_BANDS) if (density >= from) c = col; return c; }
  return null; // the gradient is drawn by MapLibre's interpolation
}

/** CSS background for the legend bar: the gradient, or the bands with "no colour" in grey stripes for free-flowing */
export function legendBackground(s: TrafficStyle): string {
  if (s === 'gradient') return `linear-gradient(90deg,${TRAFFIC_COLORS.map(([, c]) => c).join(',')})`;
  const stops = SIMPLE_BANDS.map(([from, c], i) => `${c} ${from}% ${SIMPLE_BANDS[i + 1]?.[0] ?? 100}%`).join(',');
  return `linear-gradient(90deg,transparent 0 ${SIMPLE_BANDS[0][0]}%,${stops}),var(--line)`;
}
