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
