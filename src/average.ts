/**
 * Average XP per skill per map, for the export.
 *
 * Pure logic: the add-on reads the plays from the game's database and the map
 * names from its beatmap store, and this turns them into spreadsheet rows.
 */

import type { Cell } from './xlsx.js';
import { labelOf, parseGains, SKILLS } from './tally.js';

/** One play, as read from `score_xp` joined to `score`. */
export type Play = { beatmapId: number; rate: number; mods: string; gains: string };

/** An empty rate field, or "all", exports every rate. */
export const isAllRates = (text: string): boolean => /^\s*(all)?\s*$/i.test(text);

/**
 * A rate typed by the player: "1.2", "1,2" (comma as decimal mark), "1.2x",
 * "x1.2". Undefined when it is not a usable rate.
 */
export const parseRate = (text: string): number | undefined => {
	if (isAllRates(text)) return undefined;
	const cleaned = text.trim().toLowerCase().replace(/x/g, '').replace(',', '.').trim();
	if (!/^\d+(\.\d+)?$|^\.\d+$/.test(cleaned)) return undefined;
	const rate = Number(cleaned);
	return rate > 0 && rate <= 10 ? rate : undefined;
};

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * One row per map, rate and mod combination (EZ and HR change XP, so they are
 * kept apart), with the average XP each skill gained per play, most total XP first.
 * Every play counts towards the average, including plays where a skill got 0.
 */
export const averageRows = (plays: Play[], nameOf: (beatmapId: number) => string): Cell[][] => {
	const groups = new Map<string, { beatmapId: number; rate: number; mods: string; plays: number; xp: Record<string, number> }>();
	const seen = new Set<string>(SKILLS);
	for (const play of plays) {
		// stored rates are floats: 1.2 can come back as 1.2000000000000002
		const rate = Math.round(play.rate * 100) / 100;
		const key = `${play.beatmapId}|${rate}|${play.mods}`;
		let group = groups.get(key);
		if (!group) groups.set(key, group = { beatmapId: play.beatmapId, rate, mods: play.mods, plays: 0, xp: {} });
		group.plays++;
		for (const [skill, raw] of Object.entries(parseGains(play.gains))) {
			const xp = Number(raw);
			if (!Number.isFinite(xp)) continue;
			seen.add(skill);
			group.xp[skill] = (group.xp[skill] ?? 0) + xp;
		}
	}
	const skills = [...seen];
	const rows = [...groups.values()].map(g => {
		const avg = skills.map(s => round((g.xp[s] ?? 0) / g.plays));
		const total = round(skills.reduce((n, s) => n + (g.xp[s] ?? 0), 0) / g.plays);
		return { total, cells: [nameOf(g.beatmapId), g.rate, g.mods.replace(/,/g, '') || 'NM', g.plays, total, ...avg] as Cell[] };
	});
	rows.sort((a, b) => b.total - a.total);
	return [
		['Map', 'Rate', 'Mods', 'Plays', 'Avg total XP', ...skills.map(s => `Avg ${labelOf(s)} XP`)],
		...rows.map(r => r.cells),
	];
};
