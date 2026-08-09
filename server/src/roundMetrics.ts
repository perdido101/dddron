import { CORES_REQUIRED } from '@shared/constants';

/**
 * What one round looked like, in numbers.
 *
 * Handoff 02 session 3. The brief's tuning questions are all about the core
 * loop's *pacing* — how long a core sits untouched, how long the drone spends
 * unable to find a pad, whether the EMP charge keeps collapsing — and none of
 * them are answerable from a win/loss record. These are.
 *
 * Everything here is measured on the server, because everything here is state
 * the server owns. Nothing is estimated and nothing is inferred from a client
 * report except the two events only a client can witness (a prop-wash drop and
 * a sabotage), both of which are range-checked before they get here.
 */
export interface RoundSummary {
  seconds: number;
  winner: string;
  cause: string;
  players: number;
  bots: number;

  /** Seconds from round start to the first and last core going in. */
  secondsToFirstCore: number | null;
  secondsToLastCore: number | null;

  /** Summed across cores: sitting free, and sitting free before anyone ever took it. */
  coreFreeSeconds: number;
  coreUntouchedSeconds: number;
  /** Summed across cores: being carried. */
  coreCarriedSeconds: number;

  /** How the cores came loose. */
  dropsByBlast: number;
  dropsByWash: number;

  /** Seconds with no pad free for the drone to dock on, and with it stranded. */
  allPadsBlockedSeconds: number;
  droneStrandedSeconds: number;
  /** Seconds the drone spent inert, returning or recharging: its downtime. */
  droneDownSeconds: number;

  /** Seconds the EMP was charging, and seconds it was draining for lack of bodies. */
  empChargingSeconds: number;
  empDrainingSeconds: number;

  detonations: number;
  eliminations: number;
  knockdowns: number;
  sabotages: number;
}

/** One core's clocks. */
interface CoreClock {
  free: number;
  carried: number;
  everTouched: boolean;
  untouched: number;
}

export class RoundMetrics {
  private clock = 0;
  private readonly cores: CoreClock[] = [];

  private firstCore: number | null = null;
  private lastCore: number | null = null;
  private allPadsBlocked = 0;
  private stranded = 0;
  private droneDown = 0;
  private empCharging = 0;
  private empDraining = 0;
  private dropsBlast = 0;
  private dropsWash = 0;
  private detonations = 0;
  private eliminations = 0;
  private knockdowns = 0;
  private sabotages = 0;

  constructor(coreCount = CORES_REQUIRED) {
    for (let i = 0; i < coreCount; i += 1) {
      this.cores.push({ free: 0, carried: 0, everTouched: false, untouched: 0 });
    }
  }

  /**
   * One simulation step's worth of accounting.
   *
   * @param coreStates one entry per core, as the schema has them.
   * @param padsFree how many charge pads the drone could dock on.
   */
  step(
    dt: number,
    coreStates: readonly string[],
    padsFree: number,
    stranded: boolean,
    fuseState: string,
    empCharging: boolean,
    empDraining: boolean,
  ): void {
    this.clock += dt;

    for (let i = 0; i < this.cores.length; i += 1) {
      const core = this.cores[i];
      const state = coreStates[i];
      if (!core || !state) continue;
      if (state === 'carried') {
        core.everTouched = true;
        core.carried += dt;
      } else if (state === 'onPad' || state === 'loose') {
        core.free += dt;
        // "Untouched" is the dead time before anyone ever came for it — the
        // number that says whether a core is spawning somewhere nobody goes.
        if (!core.everTouched) core.untouched += dt;
      }
    }

    if (padsFree === 0) this.allPadsBlocked += dt;
    if (stranded) this.stranded += dt;
    if (fuseState === 'inert' || fuseState === 'returning' || fuseState === 'recharging') {
      this.droneDown += dt;
    }
    if (empCharging) this.empCharging += dt;
    if (empDraining) this.empDraining += dt;
  }

  /** @param inserted the running total, so the first and last are both caught. */
  coreInserted(inserted: number): void {
    if (this.firstCore === null) this.firstCore = this.clock;
    if (inserted >= CORES_REQUIRED) this.lastCore = this.clock;
  }

  coreDropped(cause: 'blast' | 'wash'): void {
    if (cause === 'blast') this.dropsBlast += 1;
    else this.dropsWash += 1;
  }

  detonation(victims: number): void {
    this.detonations += 1;
    this.eliminations += victims;
  }

  knockdown(): void {
    this.knockdowns += 1;
  }

  sabotage(): void {
    this.sabotages += 1;
  }

  summarise(winner: string, cause: string, players: number, bots: number): RoundSummary {
    const sum = (pick: (core: CoreClock) => number): number =>
      Number(this.cores.reduce((total, core) => total + pick(core), 0).toFixed(1));

    return {
      seconds: Number(this.clock.toFixed(1)),
      winner,
      cause,
      players,
      bots,
      secondsToFirstCore: this.firstCore === null ? null : Number(this.firstCore.toFixed(1)),
      secondsToLastCore: this.lastCore === null ? null : Number(this.lastCore.toFixed(1)),
      coreFreeSeconds: sum((core) => core.free),
      coreUntouchedSeconds: sum((core) => core.untouched),
      coreCarriedSeconds: sum((core) => core.carried),
      dropsByBlast: this.dropsBlast,
      dropsByWash: this.dropsWash,
      allPadsBlockedSeconds: Number(this.allPadsBlocked.toFixed(1)),
      droneStrandedSeconds: Number(this.stranded.toFixed(1)),
      droneDownSeconds: Number(this.droneDown.toFixed(1)),
      empChargingSeconds: Number(this.empCharging.toFixed(1)),
      empDrainingSeconds: Number(this.empDraining.toFixed(1)),
      detonations: this.detonations,
      eliminations: this.eliminations,
      knockdowns: this.knockdowns,
      sabotages: this.sabotages,
    };
  }
}

/** Column order for the CSV export, so header and rows cannot drift apart. */
export const SUMMARY_COLUMNS: readonly (keyof RoundSummary)[] = [
  'seconds',
  'winner',
  'cause',
  'players',
  'bots',
  'secondsToFirstCore',
  'secondsToLastCore',
  'coreFreeSeconds',
  'coreUntouchedSeconds',
  'coreCarriedSeconds',
  'dropsByBlast',
  'dropsByWash',
  'allPadsBlockedSeconds',
  'droneStrandedSeconds',
  'droneDownSeconds',
  'empChargingSeconds',
  'empDrainingSeconds',
  'detonations',
  'eliminations',
  'knockdowns',
  'sabotages',
];

/** RFC 4180 enough: quote anything with a comma or a quote in it. */
export function toCsv(rows: readonly RoundSummary[]): string {
  const cell = (value: unknown): string => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [SUMMARY_COLUMNS.join(',')];
  for (const row of rows) lines.push(SUMMARY_COLUMNS.map((key) => cell(row[key])).join(','));
  return `${lines.join('\n')}\n`;
}
