/**
 * Average XP per skill per map, XP per second, and strain drift, for the export.
 *
 * Pure logic: the add-on reads the plays from the game's database, map names
 * and lengths from its beatmap store and strain from the API, and this turns
 * them into spreadsheet rows.
 */

import type { Cell } from './xlsx.js';
import { labelOf, parseGains, SKILLS } from './tally.js';

/** Seconds autopilot spends between maps, counted into every play's time. */
export const AUTOPILOT_S = 3;

/** One play, as read from `score_xp` joined to `score`. */
export type Play = { scoreId: number; beatmapId: number; rate: number; mods: string; gains: string };

/** Strain minutes (`/me` fatigue.minutes) read as the play started and after it ended. */
export type Strain = { before: number; after: number };

export type MapInfo = {
	nameOf: (beatmapId: number) => string;
	/** The map's length at 1x, in milliseconds; undefined when the map is not stored locally. */
	lengthOf: (beatmapId: number) => number | undefined;
	strainOf: (scoreId: number) => Strain | undefined;
};

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

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

/**
 * One row per map, rate and mod combination (EZ and HR change XP, so they are
 * kept apart), most total XP per second first. Every play counts towards the
 * average, including plays where a skill got 0. XP per second divides by the
 * map's length at its rate plus {@link AUTOPILOT_S}. Strain drift averages only
 * the plays whose strain was read on both sides.
 */
export const averageRows = (plays: Play[], info: MapInfo): Cell[][] => {
	type Group = {
		beatmapId: number; rate: number; mods: string; plays: number; xp: Record<string, number>;
		strained: number; before: number; after: number;
	};
	const groups = new Map<string, Group>();
	const seen = new Set<string>(SKILLS);
	for (const play of plays) {
		// stored rates are floats: 1.2 can come back as 1.2000000000000002
		const rate = Math.round(play.rate * 100) / 100;
		const key = `${play.beatmapId}|${rate}|${play.mods}`;
		let group = groups.get(key);
		if (!group) groups.set(key, group = {
			beatmapId: play.beatmapId, rate, mods: play.mods, plays: 0, xp: {}, strained: 0, before: 0, after: 0,
		});
		group.plays++;
		for (const [skill, raw] of Object.entries(parseGains(play.gains))) {
			const xp = Number(raw);
			if (!Number.isFinite(xp)) continue;
			seen.add(skill);
			group.xp[skill] = (group.xp[skill] ?? 0) + xp;
		}
		const strain = info.strainOf(play.scoreId);
		if (strain && Number.isFinite(strain.before) && Number.isFinite(strain.after)) {
			group.strained++;
			group.before += strain.before;
			group.after += strain.after;
		}
	}
	const skills = [...seen];
	const rows = [...groups.values()].map(g => {
		const length = info.lengthOf(g.beatmapId);
		const mapS = length === undefined ? undefined : length / 1000 / g.rate;
		const playS = mapS === undefined ? undefined : mapS + AUTOPILOT_S;
		const avg = skills.map(s => (g.xp[s] ?? 0) / g.plays);
		const total = avg.reduce((n, x) => n + x, 0);
		const perS = (x: number) => playS === undefined ? null : round(x / playS, 3);
		const strain = g.strained
			? [round(g.before / g.strained), round(g.after / g.strained), round((g.after - g.before) / g.strained, 3), g.strained]
			: [null, null, null, 0];
		return {
			sort: playS === undefined ? -1 : total / playS,
			cells: [
				info.nameOf(g.beatmapId), g.rate, g.mods.replace(/,/g, '') || 'NM', g.plays,
				mapS === undefined ? null : round(mapS, 1), playS === undefined ? null : round(playS, 1),
				round(total), perS(total),
				...avg.map(x => round(x)),
				...avg.map(perS),
				...strain,
			] as Cell[],
		};
	});
	rows.sort((a, b) => b.sort - a.sort);
	return [
		[
			'Map', 'Rate', 'Mods', 'Plays', 'Map time (s)', `Time per play incl. ${AUTOPILOT_S}s autopilot (s)`,
			'Avg total XP', 'Total XP/s',
			...skills.map(s => `Avg ${labelOf(s)} XP`),
			...skills.map(s => `${labelOf(s)} XP/s`),
			'Avg strain before (min)', 'Avg strain after (min)', 'Avg strain drift (min)', 'Plays with strain read',
		],
		...rows.map(r => r.cells),
	];
};
