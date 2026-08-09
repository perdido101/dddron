import { MAX_CONCURRENT_ROOMS } from '@shared/constants';

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

export const telemetry = new Telemetry();
