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
const rows = x.averageRows([
	{ beatmapId: 1, mods: '', gains: '{"accuracy":10,"speed":4}' },
	{ beatmapId: 1, mods: '', gains: '{"accuracy":20}' },
	{ beatmapId: 1, mods: 'EZ', gains: '{"accuracy":5}' },
	{ beatmapId: 2, mods: '', gains: '{"speed":100}' },
], id => `map ${id}`);
const head = rows[0];
const acc = head.indexOf('Avg Accuracy XP'), spd = head.indexOf('Avg Speed XP');
check2('header', head[0] === 'Map' && head[3] === 'Avg total XP' && acc > 3, JSON.stringify(head));
check2('most total XP first', rows[1][0] === 'map 2' && rows[1][3] === 100);
const nm = rows.find(r => r[0] === 'map 1' && r[1] === 'NM');
check2('averages over every play, 0 where a skill got nothing', nm[2] === 2 && nm[acc] === 15 && nm[spd] === 2, JSON.stringify(nm));
check2('mods kept apart', rows.some(r => r[0] === 'map 1' && r[1] === 'EZ' && r[2] === 1));
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
	check2('the workbook unzips, with the sheet inside', sheet.includes('map 2') && sheet.includes('<v>100</v>'));
} catch (e) { check2('the workbook unzips', false, e.message); }
rmSync(dir, { recursive: true, force: true });
console.log(`export: ${p2} passed, ${f2} failed`);
if (f2) process.exitCode = 1;
