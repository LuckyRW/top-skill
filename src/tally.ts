/**
 * Which skill won a play, and the running tally of wins.
 *
 * Pure logic, kept apart from the game so the test can run it in node.
 */

/** 4K mania skills in the game's order; the panel breaks equal counts by it. */
export const SKILLS = [
	'accuracy', 'release', 'coordination', 'speed', 'stamina', 'consistency',
	'jackspeed', 'reading', 'speedjam', 'memory', 'concentration',
] as const;

/** How the game labels a skill where its key differs from its name. */
const LABELS: Record<string, string> = { reading: 'Technical' };
export const labelOf = (skill: string): string =>
	LABELS[skill] ?? skill.charAt(0).toUpperCase() + skill.slice(1);

export type Tally = Record<string, number>;

/**
 * The skills that earned the most XP in one play. A tie returns every tied
 * skill, so each of them gets the +1. A play with no positive XP has no winner.
 */
export const winners = (gains: Record<string, unknown>): string[] => {
	let best = 0;
	let top: string[] = [];
	for (const [skill, raw] of Object.entries(gains)) {
		const xp = Number(raw);
		if (!Number.isFinite(xp) || xp <= 0) continue;
		if (xp > best) { best = xp; top = [skill]; }
		else if (xp === best) top.push(skill);
	}
	return top;
};

/** `gains` as the game stores it in `score_xp.gains` (a JSON object); bad JSON wins nothing. */
export const parseGains = (json: unknown): Record<string, unknown> => {
	try {
		const value = JSON.parse(String(json));
		return value && typeof value === 'object' ? value : {};
	} catch { return {}; }
};

/** The tally with one more play counted. */
export const count = (tally: Tally, gains: Record<string, unknown>): Tally => {
	const next = { ...tally };
	for (const skill of winners(gains)) next[skill] = (next[skill] ?? 0) + 1;
	return next;
};

/** Every known skill (plus any other the game reported), most wins first, then skill order. */
export const ranked = (tally: Tally): { skill: string; wins: number }[] => {
	const order = (s: string) => {
		const i = (SKILLS as readonly string[]).indexOf(s);
		return i < 0 ? SKILLS.length : i;
	};
	const skills = new Set<string>([...SKILLS, ...Object.keys(tally)]);
	return [...skills]
		.map(skill => ({ skill, wins: tally[skill] ?? 0 }))
		.sort((a, b) => b.wins - a.wins || order(a.skill) - order(b.skill) || a.skill.localeCompare(b.skill));
};
