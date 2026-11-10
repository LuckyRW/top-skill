/**
 * Each skill's XP multiplier, as the Character screen works it out:
 * upgrade boost (upgrades x overdrive) x prestige x genetics x medals.
 *
 * Built from the game's own rules (bundled from the pinned oss!idle release),
 * fed with the character's row from the game's local database and the medals
 * the server says it holds.
 */

import { type MedalCatalogue, medalXPMultiplier } from '@oss-idle/shared/achievements/catalogue';
import { geneticsXpMultiplier, readGenetics } from '@oss-idle/shared/genetics';
import { GENETICS_4K } from '@oss-idle/shared/rulesets/mania/4k/genes';
import { MEDAL_LINES, MEDALS } from '@oss-idle/shared/rulesets/mania/4k/medals';
import { prestigeXPMultiplier, upgradeXPMultiplier } from '@oss-idle/shared/upgrades';
import { SKILLS } from './tally.js';

/** Only `medals` is read to price them; the names are for the game's own screens. */
const CATALOGUE: MedalCatalogue = {
	medals: MEDALS, lines: MEDAL_LINES, prefix: '', name: id => id, description: () => '',
};

/** The medal multiplier for the medal ids held (x2.73 for 108 medals, on the Character screen). */
export const medalMultiplier = (ids: readonly string[]): number => medalXPMultiplier(CATALOGUE, ids);

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** The character's genetics, from its `geneticsJson` column; none when it is empty or unreadable. */
const geneticsOf = (json: unknown) => {
	try {
		return readGenetics(json ? JSON.parse(String(json)) : undefined);
	} catch {
		return readGenetics(undefined);
	}
};

/**
 * Every 4K skill's total XP multiplier, from the character's local row
 * (`<skill>Upgrades`, `<skill>Overdrive`, `<skill>Prestige`, `geneticsJson`)
 * and the medal multiplier.
 */
export const skillMultipliers = (row: Record<string, unknown>, medals: number): Record<string, number> => {
	const genetics = geneticsOf(row.geneticsJson);
	const out: Record<string, number> = {};
	for (const skill of SKILLS) {
		out[skill] = upgradeXPMultiplier(num(row[`${skill}Upgrades`]), num(row[`${skill}Overdrive`]))
			* prestigeXPMultiplier(num(row[`${skill}Prestige`]))
			* geneticsXpMultiplier(GENETICS_4K, genetics, skill)
			* medals;
	}
	return out;
};
