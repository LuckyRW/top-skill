/** Which skill won a play, and the tally. */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.test.mjs');
await build({
	entryPoints: [join(root, 'src/tally.ts')], outfile: out, bundle: true, format: 'esm', platform: 'node',
	target: 'es2022', logLevel: 'error',
});
const m = await import(pathToFileURL(out).href);
rmSync(out);

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : (fail++, console.log('  FAIL:', name, extra)); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

check('the highest XP wins', eq(m.winners({ accuracy: 10, speed: 30, stamina: 20 }), ['speed']));
check('a tie counts every tied skill', eq(m.winners({ accuracy: 30, speed: 30, stamina: 5 }), ['accuracy', 'speed']));
check('no positive XP, no winner', eq(m.winners({ accuracy: 0 }), []));
check('bad JSON wins nothing', eq(m.winners(m.parseGains('nope')), []));
let t = {};
t = m.count(t, m.parseGains('{"reading":12.5,"memory":3}'));
t = m.count(t, { reading: 1, memory: 9 });
t = m.count(t, { reading: 4 });
check('the tally adds up', eq(t, { reading: 2, memory: 1 }), JSON.stringify(t));
const r = m.ranked(t);
check('ranked: most wins first', r[0].skill === 'reading' && r[1].skill === 'memory');
check('ranked: every skill listed, zeros in skill order', r.length === 11 && r[2].skill === 'accuracy');
check('reading is labelled Technical', m.labelOf('reading') === 'Technical');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;

// --- export: averages, rate parsing, and a workbook a zip reader can open ---
const out2 = join(root, '.test2.mjs');
await build({ stdin: { contents: "export * from './src/average.ts'; export * from './src/xlsx.ts';", resolveDir: root, loader: 'ts' },
	outfile: out2, bundle: true, format: 'esm', platform: 'node', target: 'es2022', logLevel: 'error' });
const x = await import(pathToFileURL(out2).href);
rmSync(out2);
let p2 = 0, f2 = 0;
const check2 = (name, ok, extra = '') => { ok ? p2++ : (f2++, console.log('  FAIL:', name, extra)); };
check2('rate with a comma', x.parseRate('1,2') === 1.2);
check2('rate with an x', x.parseRate('1.5x') === 1.5 && x.parseRate('x0.8') === 0.8);
check2('junk is no rate', x.parseRate('fast') === undefined && x.parseRate('') === undefined);
// map 1 is 57 s at 1x and map 2 117 s, so with 3 s of autopilot a play takes 60 s and 120 s
const lengths = { 1: 57_000, 2: 117_000 };
const strains = { 1: { before: 10, after: 11 }, 2: { before: 20, after: 22 } };
const rows = x.averageRows([
	{ scoreId: 1, beatmapId: 1, rate: 1, mods: '', gains: '{"accuracy":10,"speed":4}' },
	{ scoreId: 2, beatmapId: 1, rate: 1, mods: '', gains: '{"accuracy":20}' },
	{ scoreId: 3, beatmapId: 1, rate: 1, mods: 'EZ', gains: '{"accuracy":5}' },
	{ scoreId: 4, beatmapId: 2, rate: 1, mods: '', gains: '{"speed":100}' },
	{ scoreId: 5, beatmapId: 1, rate: 1.2000000000000002, mods: '', gains: '{"accuracy":40}' },
	{ scoreId: 6, beatmapId: 3, rate: 1, mods: '', gains: '{"accuracy":999}' },
], { nameOf: id => `map ${id}`, lengthOf: id => lengths[id], strainOf: id => strains[id] });
const head = rows[0];
const col = name => head.indexOf(name);
const acc = col('Avg Accuracy XP'), spd = col('Avg Speed XP'), accS = col('Accuracy XP/s'), total = col('Avg total XP');
check2('header', head[0] === 'Map' && head[1] === 'Rate' && acc > total && accS > acc && col('Avg strain drift (min)') > accS, JSON.stringify(head));
check2('most total XP per second first', rows[1][0] === 'map 2' && rows[1][col('Total XP/s')] === 0.833, JSON.stringify(rows[1]));
const nm = rows.find(r => r[0] === 'map 1' && r[1] === 1 && r[2] === 'NM');
check2('averages over every play, 0 where a skill got nothing', nm[3] === 2 && nm[acc] === 15 && nm[spd] === 2, JSON.stringify(nm));
check2('map time and time per play with autopilot', nm[col('Map time (s)')] === 57 && nm[5] === 60);
check2('XP per second per skill', nm[accS] === 0.25 && nm[col('Speed XP/s')] === 0.033 && nm[col('Total XP/s')] === 0.283, JSON.stringify(nm));
check2('strain before, after and drift averaged', nm[col('Avg strain before (min)')] === 15
	&& nm[col('Avg strain after (min)')] === 16.5 && nm[col('Avg strain drift (min)')] === 1.5 && nm[col('Plays with strain read')] === 2);
check2('mods kept apart', rows.some(r => r[0] === 'map 1' && r[2] === 'EZ' && r[3] === 1));
const fast = rows.find(r => r[0] === 'map 1' && r[1] === 1.2);
check2('rates kept apart, float noise rounded, map time at the rate', fast && fast[3] === 1 && fast[4] === 47.5 && fast[5] === 50.5, JSON.stringify(fast));
const unknown = rows.at(-1);
check2('a map with no stored length has no time, no XP/s, and sorts last', unknown[0] === 'map 3' && unknown[4] === null && unknown[col('Total XP/s')] === null);
check2('no strain read leaves the strain blank', unknown[col('Avg strain drift (min)')] === null && unknown[col('Plays with strain read')] === 0);
check2('empty or all means every rate', x.isAllRates('') && x.isAllRates(' All ') && !x.isAllRates('1.2'));
check2('column letters', x.column(0) === 'A' && x.column(25) === 'Z' && x.column(26) === 'AA');

const { writeFileSync, mkdtempSync, readFileSync } = await import('node:fs');
const { execFileSync } = await import('node:child_process');
const { tmpdir } = await import('node:os');
const dir = mkdtempSync(join(tmpdir(), 'top-skill-'));
writeFileSync(join(dir, 't.xlsx'), x.workbook('1.2x', rows));
try {
	// Windows' own tar is bsdtar, which reads zips; elsewhere, unzip
	if (process.platform === 'win32') execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', 't.xlsx'], { cwd: dir });
	else execFileSync('unzip', ['-q', 't.xlsx'], { cwd: dir });
	const sheet = readFileSync(join(dir, 'xl/worksheets/sheet1.xml'), 'utf8');
	check2('the workbook unzips, with the sheet inside', sheet.includes('map 2') && sheet.includes('<v>0.833</v>'));
} catch (e) { check2('the workbook unzips', false, e.message); }
rmSync(dir, { recursive: true, force: true });
console.log(`export: ${p2} passed, ${f2} failed`);
if (f2) process.exitCode = 1;

// --- base XP: the multiplier the Character screen shows, and the division ---
const out3 = join(root, '.test3.mjs');
await build({
	entryPoints: [join(root, 'src/multiplier.ts')], outfile: out3, bundle: true, format: 'esm', platform: 'node',
	target: 'es2022', logLevel: 'error',
	alias: { '@oss-idle/shared': join(root, 'node_modules/oss-idle/packages/shared/src') },
});
const mu = await import(pathToFileURL(out3).href);
rmSync(out3);
let p3 = 0, f3 = 0;
const check3 = (name, ok, extra = '') => { ok ? p3++ : (f3++, console.log('  FAIL:', name, extra)); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
// from the Character screen: Accuracy 10 upgrades, overdrive 86.1, 2 prestige, no genetics, x2.73 medals = x34.92;
// Coordination 10 upgrades, overdrive 69.1, 1 prestige = x29.90
const mx = mu.skillMultipliers({
	accuracyUpgrades: 10, accuracyOverdrive: 86.1, accuracyPrestige: 2,
	coordinationUpgrades: 10, coordinationOverdrive: 69.1, coordinationPrestige: 1,
	geneticsJson: '',
}, 2.73);
check3('Accuracy matches the Character screen (x34.92)', near(mx.accuracy, 34.92, 0.1), mx.accuracy);
check3('Coordination matches the Character screen (x29.90)', near(mx.coordination, 29.9, 0.1), mx.coordination);
check3('a skill with nothing is x1 times medals', near(mx.memory, 2.73, 1e-9), mx.memory);
check3('bad genetics JSON is no genetics', near(mu.skillMultipliers({ geneticsJson: '{oops' }, 1).speed, 1, 1e-9));
check3('no medals is x1', mu.medalMultiplier([]) === 1);
const based = x.averageRows([{ scoreId: 1, beatmapId: 1, rate: 1, mods: '', gains: '{"accuracy":100,"speed":30}' }], {
	nameOf: () => 'map', lengthOf: () => 57_000, strainOf: () => undefined, multOf: () => ({ accuracy: 10, speed: 3 }),
});
const bh = based[0];
check3('base XP divides each skill by its own multiplier', based[1][bh.indexOf('Avg Accuracy base XP')] === 10
	&& based[1][bh.indexOf('Avg Speed base XP')] === 10 && based[1][bh.indexOf('Avg total base XP')] === 20, JSON.stringify(bh));
console.log(`base XP: ${p3} passed, ${f3} failed`);
if (f3) process.exitCode = 1;
