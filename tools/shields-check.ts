// Route shield recognition (src/shields.ts): every documented form becomes the right shield, and names that only look
// similar keep their normal text label. Precision matters more than recall: a wrong shield is worse than none.
//   npm run check:shields
import { parseShield, shieldImageId, parseImageId, DRAWERS, RULES, type ShieldStyle } from '../src/shields';

let failures = 0;
const ok = (c: boolean, m: string) => { if (!c) { failures++; console.error('  ✗ ' + m); } };

const yes: [string, ShieldStyle, string][] = [
  ['I-4', 'us-interstate', '4'], ['I 4', 'us-interstate', '4'], ['I-95', 'us-interstate', '95'], ['I-405', 'us-interstate', '405'], ['I-35E', 'us-interstate', '35E'],
  ['Interstate 4', 'us-interstate', '4'], ['Interstate Highway 95', 'us-interstate', '95'], ['I-95 North', 'us-interstate', '95'], ['I-4 EB', 'us-interstate', '4'], ['  I-10  ', 'us-interstate', '10'],
  ['US 27', 'us-route', '27'], ['US-27', 'us-route', '27'], ['U.S. 27', 'us-route', '27'], ['U.S.-27', 'us-route', '27'], ['U.S. Route 27', 'us-route', '27'], ['US Hwy 27', 'us-route', '27'],
  ['U.S. Highway 441', 'us-route', '441'], ['United States Route 1', 'us-route', '1'], ['US 301 Southbound', 'us-route', '301'], ['US 1A', 'us-route', '1A'],
  ['CR 44', 'us-county', '44'], ['CR-44', 'us-county', '44'], ['C.R. 44', 'us-county', '44'], ['C.R.-44', 'us-county', '44'], ['County Road 484', 'us-county', '484'], ['County Rd 25', 'us-county', '25'], ['County Route 1001', 'us-county', '1001'],
  ['SR 35', 'us-state', '35'], ['S.R. 35', 'us-state', '35'], ['State Road 35', 'us-state', '35'], ['State Route 1', 'us-state', '1'], ['State Highway 71', 'us-state', '71'], ['FL-35', 'us-state', '35'], ['NY 500', 'us-state', '500'], ['CA-1', 'us-state', '1'],
  ['고속국도 제1호선', 'kr-expressway', '1'], ['고속도로 1호선', 'kr-expressway', '1'], ['제15호 고속국도', 'kr-expressway', '15'], ['고속국도 제400호선', 'kr-expressway', '400'],
  ['국도 제1호선', 'kr-national', '1'], ['일반국도 77호선', 'kr-national', '77'], ['1번 국도', 'kr-national', '1'], ['국도 3호', 'kr-national', '3'], ['National Route 17', 'kr-national', '17'],
  ['지방도 제313호선', 'kr-local', '313'], ['지방도 98호선', 'kr-local', '98'], ['322번 지방도', 'kr-local', '322'],
];
const no = [
  '', 'Interstate', 'I-', 'I-4 Express Lanes', 'I-4 Exit 72', 'Interstate 4 Connector', 'I-0', 'I-1234', 'Iris Road', 'Ivy Lane 4', 'I4', 'Isle 9',
  'US Bank Way', 'USA Boulevard', 'U.S. Route', 'US 27 Business Loop', 'Old US 27', 'US 27 & SR 35', 'Usher Street 27',
  'Crystal Road', 'CR', 'Cr 44 Bypass', 'County Road', 'Creek Road 44', 'CRA 9',
  'SR', 'Sr Street', 'State Street', 'State Road', 'Main State Road 9', 'NE 5th St', 'NW 13 Ave', 'OK Corral Road 7', 'ME Lane', 'Florida Avenue', 'IN-N-OUT Drive', 'XX 12',
  '경부고속도로', '서랑고속화도로', '차서고속도로', '국도변길', '1번길', '지방도로', '국도 제0호선', '중앙로 1', 'Expressway 1', 'Route 66', 'Highway 1', 'A1', 'M25', 'Chaseo Expressway', 'Seorang Northern Ring Expressway',
];

console.log('recognised');
for (const [name, style, ref] of yes) {
  const s = parseShield(name);
  ok(!!s && s.style === style && s.ref === ref, `"${name}" → ${style} ${ref} (got ${s ? s.style + ' ' + s.ref : 'none'})`);
}
console.log('left as text');
for (const name of no) { const s = parseShield(name); ok(!s, `"${name}" stays a text label (got ${s ? s.style + ' ' + s.ref : ''})`); }
// the real city's names (Korean, English) carry no route numbers: none may become a shield
const seorang = ['차서고속도로', '신서랑대로', '서랑고속화도로', '서빛하늘대교', '서랑북부외곽고속도로', '북서랑1길', '공항2로', 'Chaseo Expressway', 'North Seorang 1-gil', 'Airport Road 2', 'Seobit Airport Expressway'];
ok(seorang.every((n) => !parseShield(n)), 'no road of the sample city gets a shield (its names have no route numbers)');

console.log('images');
const styles = [...new Set(RULES.map((r) => r.style))];
ok(styles.every((s) => s in DRAWERS), 'every recognised style has a drawer');
for (const [name] of yes) { const s = parseShield(name)!; const back = parseImageId(shieldImageId(s)); ok(!!back && back.style === s.style && back.ref === s.ref, `image id round trip for "${name}"`); }
ok(!parseImageId('shield:evil:1') && !parseImageId('shield:us-route:<svg>') && !parseImageId('oneway') && !parseImageId('shield:us-route:123456'), 'other image ids are not shields');
for (const s of styles) for (const ref of ['1', '95', '441', '1001']) { const l = DRAWERS[s](ref); ok(l.w >= 22 && l.w <= 60 && l.h >= 20 && l.h <= 30, `${s} ${ref}: a sensible size (${l.w}×${l.h})`); }

if (failures) { console.error(`\n${failures} shield check(s) failed`); process.exit(1); }
console.log(`\nshield checks passed (${yes.length} recognised, ${no.length} left as text)`);
