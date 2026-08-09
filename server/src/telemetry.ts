import { MAX_CONCURRENT_ROOMS } from '@shared/constants';

import { toCsv, type RoundSummary } from './roundMetrics';

interface RoundRecord {
  winner: string;
  cause: string;
  seconds: number;
  players: number;
}

/**
 * Anonymous round telemetry.
 *
 * Deliberately tiny and deliberately anonymous: no nicknames, no ids, no
 * addresses — just the outcome, the length and the headcount. Its whole purpose
 * is the post-launch tuning pass, and the number that matters is the drone win
 * rate, which section 6 wants sitting between 35% and 45%.
 *
 * In-memory for now. Phase 11's "queryable" requirement is met by the /stats
 * endpoint; persisting it needs a store this project does not yet have.
 */
class Telemetry {
  private readonly rounds: RoundRecord[] = [];
  private readonly summaries: RoundSummary[] = [];
  private liveRooms = 0;

  roomOpened(): boolean {
    if (this.liveRooms >= MAX_CONCURRENT_ROOMS) return false;
    this.liveRooms += 1;
    return true;
  }

  roomClosed(): void {
    this.liveRooms = Math.max(0, this.liveRooms - 1);
  }

  get rooms(): number {
    return this.liveRooms;
  }

  recordRound(record: RoundRecord): void {
    // Aborted rounds are explicitly not scored, so they are not counted either.
    if (record.winner === 'aborted') return;
    this.rounds.push(record);
  }

  /**
   * Full core-loop metrics for one round (handoff 02, session 3).
   *
   * Kept to a bounded window: this lives in memory on a small host, and a
   * long-running server must not accumulate rows until it runs out of it.
   */
  recordSummary(summary: RoundSummary): void {
    if (summary.winner === 'aborted') return;
    this.summaries.push(summary);
    if (this.summaries.length > SUMMARY_WINDOW) this.summaries.shift();
  }

  /** One row per round, for a spreadsheet. */
  csv(): string {
    return toCsv(this.summaries);
  }

  get summaryCount(): number {
    return this.summaries.length;
  }

  /**
   * Medians across the window, which is what a pacing question actually wants
   * — one 180-second stalemate should not drag the average for twenty rounds.
   */
  pacing(): Record<string, number | null> {
    const median = (pick: (row: RoundSummary) => number | null): number | null => {
      const values = this.summaries
        .map(pick)
        .filter((value): value is number => value !== null)
        .sort((a, b) => a - b);
      const middle = values[Math.floor(values.length / 2)];
      return middle === undefined ? null : Number(middle.toFixed(1));
    };
    return {
      medianSecondsToFirstCore: median((row) => row.secondsToFirstCore),
      medianSecondsToLastCore: median((row) => row.secondsToLastCore),
      medianCoreUntouchedSeconds: median((row) => row.coreUntouchedSeconds),
      medianAllPadsBlockedSeconds: median((row) => row.allPadsBlockedSeconds),
      medianDroneStrandedSeconds: median((row) => row.droneStrandedSeconds),
      medianDroneDownSeconds: median((row) => row.droneDownSeconds),
      medianEmpDrainingSeconds: median((row) => row.empDrainingSeconds),
      medianDetonations: median((row) => row.detonations),
      medianEliminations: median((row) => row.eliminations),
    };
  }

  /** The tuning number: what fraction of scored rounds the drone took. */
  droneWinRate(): number {
    if (this.rounds.length === 0) return 0;
    const wins = this.rounds.filter((round) => round.winner === 'drone').length;
    return wins / this.rounds.length;
  }

  averageRoundLength(): number {
    if (this.rounds.length === 0) return 0;
    return this.rounds.reduce((total, round) => total + round.seconds, 0) / this.rounds.length;
  }

  stats(): Record<string, number> {
    return {
      rounds: this.rounds.length,
      droneWinRate: Number(this.droneWinRate().toFixed(3)),
      averageRoundSeconds: Number(this.averageRoundLength().toFixed(1)),
      liveRooms: this.liveRooms,
    };
  }

  summary(): string {
    const s = this.stats();
    return `${s.rounds} rounds recorded, drone win rate ${(s.droneWinRate! * 100).toFixed(1)}%`;
  }
}

/**
 * How many round summaries to keep. Far past the point where the medians stop
 * moving in a playtest, and small enough to bound memory on a shared host: a
 * summary is ~20 numbers, so the whole window is a few tens of kilobytes.
 */
const SUMMARY_WINDOW = 200;

export const telemetry = new Telemetry();
