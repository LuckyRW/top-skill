/**
 * Top Skill: after every finished map, +1 to the skill that earned the most XP,
 * and the XP each skill earned since the last clear.
 *
 * The game records each play's per-skill XP in its local `score_xp` table (one
 * row per play, `gains` as JSON). The add-on polls that table for rows past a
 * watermark it keeps in localStorage with the counters, so the tally survives
 * closing the overlay and restarting the game. On first run the watermark is
 * set to the newest play, so earlier history is not counted.
 *
 * The export reads the whole history of the same table instead: the average XP
 * per skill per map, at one rate, as an .xlsx file.
 */

import { beatmapStore, createSettings, gameDb } from '@oss-idle/addon-sdk';
import { ReactAddon } from '@oss-idle/addon-sdk/react';
import type { ReactNode } from 'react';
import { averageRows, isAllRates, parseRate, type Play, type Strain } from './average.js';
import { medalMultiplier, skillMultipliers } from './multiplier.js';
import { count, labelOf, parseGains, ranked, SKILLS, type Tally } from './tally.js';
import { workbook } from './xlsx.js';
import styles from './styles.css';

const TOGGLE = 'Ctrl+Shift+K';
const POLL_MS = 3000;

type State = {
	tally: Tally;
	/** XP per skill since the last clear. */
	xp: Record<string, number>;
	plays: number;
	/** Newest play already looked at: (playedAt, scoreId). -1 = not started yet. */
	lastPlayedAt: number;
	lastScoreId: number;
	/** What the rate field last held. */
	rate: string;
	/** The newest play when Clear was last pressed: the export skips it and older ones. -1 = never cleared. */
	clearedPlayedAt: number;
	clearedScoreId: number;
	/** Export base XP (divided by each play's multipliers) rather than XP as gained. */
	base: boolean;
	/** The medal multiplier last read, for when the server cannot be asked. 0 = never read. */
	medals: number;
};

const store = createSettings<State>('top-skill', {
	tally: {}, xp: {}, plays: 0, lastPlayedAt: -1, lastScoreId: -1, rate: '1',
	clearedPlayedAt: -1, clearedScoreId: -1, base: true, medals: 0,
});

/** Each skill's XP multiplier as a play landed, in SKILLS order, by its local score id. */
type MultRecord = { scoreId: number; m: number[] };
/** About 100 bytes each: kept well inside the browser storage the game shares. */
const MAX_MULT_RECORDS = 5_000;
const multStore = createSettings<{ records: MultRecord[] }>('top-skill-mult', { records: [] });

/** The server the medals are read from: the API's own host. */
const API_HOST = 'https://api.oss.idle.rhythmgamers.net';
/** Medals change rarely: asked again at most this often. */
const MEDALS_TTL_MS = 10 * 60_000;

/** Strain minutes read around one play, by its local score id. */
type StrainRecord = Strain & { scoreId: number };
/** Enough for weeks of autopilot; the oldest are dropped past it. */
const MAX_STRAIN_RECORDS = 20_000;
const strainStore = createSettings<{ records: StrainRecord[] }>('top-skill-strain', { records: [] });

/** How often the add-on looks for the play screen opening, to read strain before a play. */
const PLAY_CHECK_MS = 500;

type Row = { scoreId: number; characterId: number; playedAt: number; gains: string };

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: n < 100 ? 1 : 0 });

export class TopSkillAddon extends ReactAddon {

	private open = false;
	private state: State = store.load();
	private polling = false;
	private exporting = false;
	private status = '';
	private escape?: () => void;
	/** Whether the play screen was open at the last check. */
	private playing = false;
	/** Strain read as the current play started, settled once `/me` answers. */
	private strainBefore?: Promise<number | undefined>;
	/** When the medals were last read from the server. */
	private medalsReadAt = 0;

	constructor() {
		super({ name: 'Top Skill', overlayId: 'top-skill', styles });
	}

	protected override async onReady(): Promise<void> {
		this.own(this.hotkeys.register(TOGGLE, () => this.toggle(), { allowInText: true }));
		this.log.info(`ready - press ${TOGGLE} to open`);
		try { await gameDb.ready(); } catch { this.log.warn('game database never opened'); return; }
		this.interval(() => this.watchPlay(), PLAY_CHECK_MS);
		await this.poll();
		this.interval(() => void this.poll(), POLL_MS);
	}

	/** The strain the server has for the signed-in character (`/me` fatigue.minutes). */
	private async readStrain(): Promise<number | undefined> {
		const api = (this.host as { api?: { me(): Promise<unknown> } } | undefined)?.api;
		if (!api) return undefined;
		try {
			const me = await api.me() as { fatigue?: { minutes?: unknown } };
			const minutes = Number(me?.fatigue?.minutes);
			return Number.isFinite(minutes) ? minutes : undefined;
		} catch {
			return undefined; // a guest, or offline: no strain for this play
		}
	}

	/** Read strain when the play screen opens: that is the "before" of the next play. */
	private watchPlay(): void {
		const playing = document.querySelector('.play__canvas') !== null;
		if (playing && !this.playing) this.strainBefore = this.readStrain();
		this.playing = playing;
	}

	/** The medal multiplier: from the server every {@link MEDALS_TTL_MS}, else the last one read. */
	private async medalBoost(characterId: number): Promise<number | undefined> {
		if (characterId > 0 && Date.now() - this.medalsReadAt > MEDALS_TTL_MS) {
			try {
				const res = await fetch(`${API_HOST}/v1/characters/${characterId}/medals?ruleset=mania4k`);
				if (res.ok) {
					const { held } = await res.json() as { held?: { id: string }[] };
					if (Array.isArray(held)) {
						this.medalsReadAt = Date.now();
						this.save({ ...this.state, medals: medalMultiplier(held.map(m => m.id)) });
					}
				}
			} catch { /* offline: keep the last one */ }
		}
		return this.state.medals > 0 ? this.state.medals : undefined;
	}

	/**
	 * Each skill's multiplier for the play that just landed, from the character's
	 * row in the game's database, as the Character screen works it out.
	 */
	private async recordMultipliers(scoreId: number, characterId: number): Promise<void> {
		try {
			const [row, medals] = await Promise.all([
				gameDb.first<Record<string, unknown>>('SELECT * FROM character WHERE id = ?', [characterId]),
				this.medalBoost(characterId),
			]);
			if (!row || medals === undefined) return;
			const mult = skillMultipliers(row, medals);
			const m = SKILLS.map(s => Math.round(mult[s] * 10_000) / 10_000);
			const records = [...multStore.load().records, { scoreId, m }].slice(-MAX_MULT_RECORDS);
			multStore.save({ records });
		} catch { /* this play just has no base XP */ }
	}

	/** Strain after the play that just landed, stored with the reading from its start. */
	private async recordStrain(scoreId: number): Promise<void> {
		const pending = this.strainBefore;
		this.strainBefore = undefined;
		if (!pending) return;
		const [before, after] = await Promise.all([pending, this.readStrain()]);
		if (before === undefined || after === undefined) return;
		const records = [...strainStore.load().records, { scoreId, before, after }].slice(-MAX_STRAIN_RECORDS);
		strainStore.save({ records });
	}

	private async poll(): Promise<void> {
		if (this.polling) return;
		this.polling = true;
		try {
			if (this.state.lastPlayedAt < 0) {
				const last = await gameDb.first<{ playedAt: number; scoreId: number }>(
					'SELECT playedAt, scoreId FROM score_xp ORDER BY playedAt DESC, scoreId DESC LIMIT 1');
				this.save({ ...this.state, lastPlayedAt: last?.playedAt ?? 0, lastScoreId: last?.scoreId ?? 0 });
				return;
			}
			const rows = await gameDb.select<Row>(
				`SELECT scoreId, characterId, playedAt, gains FROM score_xp
				 WHERE playedAt > ? OR (playedAt = ? AND scoreId > ?)
				 ORDER BY playedAt, scoreId`,
				[this.state.lastPlayedAt, this.state.lastPlayedAt, this.state.lastScoreId]);
			if (!rows.length) return;
			let { tally, plays } = this.state;
			const xp = { ...this.state.xp };
			for (const row of rows) {
				const gains = parseGains(row.gains);
				tally = count(tally, gains);
				for (const [skill, raw] of Object.entries(gains)) {
					const n = Number(raw);
					if (Number.isFinite(n) && n > 0) xp[skill] = (xp[skill] ?? 0) + n;
				}
				plays++;
			}
			const last = rows[rows.length - 1];
			this.save({ ...this.state, tally, xp, plays, lastPlayedAt: last.playedAt, lastScoreId: last.scoreId });
			// the strain read at the play's start belongs to the newest play only
			void this.recordStrain(last.scoreId);
			// read right after the plays land: what the character has now is what they were multiplied by
			for (const row of rows) void this.recordMultipliers(row.scoreId, row.characterId);
		} catch {
			// score_xp only exists once the game has saved its first gain; try again next tick
		} finally {
			this.polling = false;
		}
	}

	private save(state: State): void {
		this.state = state;
		store.save(state);
		this.refresh();
	}

	/**
	 * Zero the counters and XP totals, and start the export over: plays already
	 * finished stay out of both. The game's own play history is left untouched.
	 */
	private clear(): void {
		this.save({
			...this.state, tally: {}, xp: {}, plays: 0,
			clearedPlayedAt: Math.max(this.state.lastPlayedAt, 0), clearedScoreId: Math.max(this.state.lastScoreId, 0),
		});
		this.setStatus('Cleared: the export starts from here too');
	}

	/** Average XP per skill per map at the typed rate, as an .xlsx download. */
	private async exportXlsx(): Promise<void> {
		const all = isAllRates(this.state.rate);
		const rate = all ? -1 : parseRate(this.state.rate);
		if (rate === undefined) { this.setStatus('Type a rate like 1.2, or all'); return; }
		const label = all ? 'all rates' : `${rate}x`;
		if (this.exporting) return;
		this.exporting = true;
		this.setStatus('Exporting...');
		try {
			// The character being played: the one that made the newest play.
			const characterId = await gameDb.value<number>(
				'SELECT characterId FROM score_xp ORDER BY playedAt DESC, scoreId DESC LIMIT 1');
			if (characterId === undefined) { this.setStatus('No plays with XP yet'); return; }
			// A score synced from the server can be stored again under a new id, so
			// a play whose id no longer matches is found by map and time instead.
			const plays = await gameDb.select<Play>(
				`SELECT * FROM (
					SELECT x.scoreId AS scoreId, x.beatmapId AS beatmapId, COALESCE(s.rate, s2.rate) AS rate,
						COALESCE(s.mods, s2.mods, '') AS mods, x.gains AS gains
					FROM score_xp x
					LEFT JOIN score s ON s.id = x.scoreId
					LEFT JOIN score s2 ON s.id IS NULL AND s2.characterId = x.characterId
						AND s2.beatmapId = x.beatmapId AND s2.playedAt = x.playedAt
					WHERE x.characterId = ?
						AND (x.playedAt > ? OR (x.playedAt = ? AND x.scoreId > ?))
				 ) WHERE rate IS NOT NULL AND (? < 0 OR ABS(rate - ?) < 0.0001)`,
				[characterId, this.state.clearedPlayedAt, this.state.clearedPlayedAt, this.state.clearedScoreId, rate, rate]);
			if (!plays.length) {
				this.setStatus(`No plays at ${label}${this.state.clearedPlayedAt >= 0 ? ' since the last clear' : ''}`);
				return;
			}
			const names = new Map<number, string>();
			const lengths = new Map<number, number>();
			try {
				for (const { set, version } of await beatmapStore.difficulties()) {
					names.set(version.id, `${set.artist} - ${set.title} [${version.version}]`);
					// the local store keeps lengths in milliseconds (song select divides by 1000)
					if (Number.isFinite(version.total_length)) lengths.set(version.id, version.total_length);
				}
			} catch { /* a map not stored locally keeps its id and has no time */ }
			const strain = new Map(strainStore.load().records.map(r => [r.scoreId, r]));
			const { base } = this.state;
			// base XP needs the multipliers a play had: plays from before they were recorded are left out
			const mult = new Map(multStore.load().records.map(r =>
				[r.scoreId, Object.fromEntries(SKILLS.map((s, i) => [s, r.m[i]]))]));
			const used = base ? plays.filter(p => mult.has(p.scoreId)) : plays;
			if (!used.length) {
				this.setStatus(`None of the ${plays.length} plays at ${label} has its multipliers recorded yet:`
					+ ' untick Base XP, or play a few maps first');
				return;
			}
			const rows = averageRows(used, {
				nameOf: id => names.get(id) ?? `beatmap ${id}`,
				lengthOf: id => lengths.get(id),
				strainOf: scoreId => strain.get(scoreId),
				multOf: base ? scoreId => mult.get(scoreId) : undefined,
			});
			const file = workbook(`${label}${base ? ' base' : ''}`, rows);
			const url = URL.createObjectURL(new Blob([file],
				{ type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
			const a = document.createElement('a');
			a.href = url;
			a.download = `top-skill-${base ? 'base-' : ''}xp-${all ? 'all-rates' : `${rate}x`}.xlsx`;
			document.body.append(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
			const skipped = plays.length - used.length;
			this.setStatus(`Saved ${rows.length - 1} map${rows.length === 2 ? '' : 's'} (${used.length} plays`
				+ `${skipped ? `; ${skipped} older plays have no multipliers recorded` : ''})`);
		} catch (e) {
			this.setStatus(`Export failed: ${(e as Error).message}`);
		} finally {
			this.exporting = false;
		}
	}

	private setStatus(status: string): void {
		this.status = status;
		this.refresh();
	}

	private toggle(): void {
		this.open = !this.open;
		this.escape?.();
		this.escape = this.open
			? this.hotkeys.register('Escape', () => this.toggle(), { allowInText: true })
			: undefined;
		this.refresh();
	}

	protected render(): ReactNode {
		if (!this.open) return null;
		const rows = ranked(this.state.tally);
		const top = rows[0]?.wins ?? 0;
		const { plays, xp } = this.state;
		return (
			<div className="panel">
				<header>
					<strong>Top skill per map</strong>
					<button className="x" onClick={() => this.toggle()} title={`Close (${TOGGLE})`}>×</button>
				</header>
				<div className="sub">{plays} map{plays === 1 ? '' : 's'} counted · wins / XP</div>
				<ol>
					{rows.map(({ skill, wins }) => (
						<li key={skill} className={wins > 0 && wins === top ? 'lead' : wins || xp[skill] ? '' : 'zero'}>
							<span>{labelOf(skill)}</span>
							<span className="num">{wins}<em>{fmt(xp[skill] ?? 0)}</em></span>
						</li>
					))}
				</ol>
				<button className="wide" onClick={() => this.clear()}>Clear all</button>
				<div className="export">
					<label>
						Rate
						<input
							type="text" value={this.state.rate} placeholder="all"
							title="A rate like 1.2, or empty / all for every rate"
							onChange={e => this.save({ ...this.state, rate: e.target.value })}
							onKeyDown={e => { if (e.key === 'Enter') void this.exportXlsx(); }}
						/>
					</label>
					<button onClick={() => void this.exportXlsx()} disabled={this.exporting}>Export .xlsx</button>
				</div>
				<div className="export">
					<label title="Each play's XP divided by the multipliers it had (upgrades, overdrive, prestige, genetics, medals). Untick for the XP as gained.">
						<input
							type="checkbox" checked={this.state.base}
							onChange={e => this.save({ ...this.state, base: e.target.checked })}
						/>
						Base XP (÷ multipliers)
					</label>
				</div>
				{this.status && <div className="sub">{this.status}</div>}
			</div>
		);
	}
}
