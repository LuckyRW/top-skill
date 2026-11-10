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
import { averageRows, isAllRates, parseRate, type Play } from './average.js';
import { count, labelOf, parseGains, ranked, type Tally } from './tally.js';
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
};

const store = createSettings<State>('top-skill', {
	tally: {}, xp: {}, plays: 0, lastPlayedAt: -1, lastScoreId: -1, rate: '1',
	clearedPlayedAt: -1, clearedScoreId: -1,
});

type Row = { scoreId: number; playedAt: number; gains: string };

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: n < 100 ? 1 : 0 });

export class TopSkillAddon extends ReactAddon {

	private open = false;
	private state: State = store.load();
	private polling = false;
	private exporting = false;
	private status = '';
	private escape?: () => void;

	constructor() {
		super({ name: 'Top Skill', overlayId: 'top-skill', styles });
	}

	protected override async onReady(): Promise<void> {
		this.own(this.hotkeys.register(TOGGLE, () => this.toggle(), { allowInText: true }));
		this.log.info(`ready - press ${TOGGLE} to open`);
		try { await gameDb.ready(); } catch { this.log.warn('game database never opened'); return; }
		await this.poll();
		this.interval(() => void this.poll(), POLL_MS);
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
				`SELECT scoreId, playedAt, gains FROM score_xp
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
					SELECT x.beatmapId AS beatmapId, COALESCE(s.rate, s2.rate) AS rate,
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
			try {
				for (const { set, version } of await beatmapStore.difficulties())
					names.set(version.id, `${set.artist} - ${set.title} [${version.version}]`);
			} catch { /* names are a nicety: ids still identify the maps */ }
			const rows = averageRows(plays, id => names.get(id) ?? `beatmap ${id}`);
			const file = workbook(label, rows);
			const url = URL.createObjectURL(new Blob([file],
				{ type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
			const a = document.createElement('a');
			a.href = url;
			a.download = `top-skill-xp-${all ? 'all-rates' : `${rate}x`}.xlsx`;
			document.body.append(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
			this.setStatus(`Saved ${rows.length - 1} map${rows.length === 2 ? '' : 's'} (${plays.length} plays)`);
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
				{this.status && <div className="sub">{this.status}</div>}
			</div>
		);
	}
}
