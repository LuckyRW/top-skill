/**
 * Top Skill: after every finished map, +1 to the skill that earned the most XP.
 *
 * The game records each play's per-skill XP in its local `score_xp` table (one
 * row per play, `gains` as JSON). The add-on polls that table for rows past a
 * watermark it keeps in localStorage with the counters, so the tally survives
 * closing the overlay and restarting the game. On first run the watermark is
 * set to the newest play, so earlier history is not counted.
 */

import { createSettings, gameDb } from '@oss-idle/addon-sdk';
import { ReactAddon } from '@oss-idle/addon-sdk/react';
import type { ReactNode } from 'react';
import { count, labelOf, parseGains, ranked, type Tally } from './tally.js';
import styles from './styles.css';

const TOGGLE = 'Ctrl+Shift+K';
const POLL_MS = 3000;

type State = {
	tally: Tally;
	plays: number;
	/** Newest play already looked at: (playedAt, scoreId). -1 = not started yet. */
	lastPlayedAt: number;
	lastScoreId: number;
};

const store = createSettings<State>('top-skill', { tally: {}, plays: 0, lastPlayedAt: -1, lastScoreId: -1 });

type Row = { scoreId: number; playedAt: number; gains: string };

export class TopSkillAddon extends ReactAddon {

	private open = false;
	private state: State = store.load();
	private polling = false;
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
			for (const row of rows) { tally = count(tally, parseGains(row.gains)); plays++; }
			const last = rows[rows.length - 1];
			this.save({ tally, plays, lastPlayedAt: last.playedAt, lastScoreId: last.scoreId });
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

	/** Zero the counters; plays already finished stay uncounted. */
	private clear(): void {
		this.save({ ...this.state, tally: {}, plays: 0 });
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
		const { plays } = this.state;
		return (
			<div className="panel">
				<header>
					<strong>Top skill per map</strong>
					<button className="x" onClick={() => this.toggle()} title={`Close (${TOGGLE})`}>×</button>
				</header>
				<div className="sub">{plays} map{plays === 1 ? '' : 's'} counted</div>
				<ol>
					{rows.map(({ skill, wins }) => (
						<li key={skill} className={wins > 0 && wins === top ? 'lead' : wins ? '' : 'zero'}>
							<span>{labelOf(skill)}</span><span>{wins}</span>
						</li>
					))}
				</ol>
				<button className="clear" onClick={() => this.clear()}>Clear all</button>
			</div>
		);
	}
}
