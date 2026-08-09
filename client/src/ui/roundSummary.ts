import type { RoundSummary } from '../net/connection';

/**
 * The round's core-loop numbers, shown after it ends (handoff 02, session 3).
 *
 * These answer the pacing questions a playtest cannot answer by feel: whether
 * a core spent the whole round sitting somewhere nobody goes, whether the
 * drone spent more time hunting for a free pad than hunting runners, whether
 * the EMP charge kept collapsing because there were never enough bodies.
 *
 * Dev-only and off by default: it is a measuring instrument, not a scoreboard,
 * and a real match should end on the results screen and nothing else.
 */
export class RoundSummaryPanel {
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly rounds: RoundSummary[] = [];
  private open = false;

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement('div');
    this.root.id = 'roundsummary';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="rs-title">ROUND METRICS <span class="rs-count"></span></div>
      <table class="rs-table"></table>
      <div class="rs-actions">
        <button class="rs-csv">COPY CSV</button>
        <button class="rs-close">CLOSE</button>
      </div>
      <div class="rs-note"></div>
    `;
    parent.appendChild(this.root);
    this.body = this.root.querySelector('.rs-table') as HTMLElement;

    (this.root.querySelector('.rs-close') as HTMLButtonElement).onclick = () => this.hide();
    (this.root.querySelector('.rs-csv') as HTMLButtonElement).onclick = () => {
      const csv = this.csv();
      void navigator.clipboard?.writeText(csv).then(
        () => this.say(`copied ${this.rounds.length} round(s) to the clipboard`),
        () => {
          // Clipboard needs a permission the page may not have; the console
          // always works, and a playtester can copy from there.
          console.log(csv);
          this.say('clipboard blocked — CSV written to the browser console');
        },
      );
    };
  }

  /** Record a finished round and show the panel. */
  record(summary: RoundSummary): void {
    this.rounds.push(summary);
    this.render(summary);
    this.open = true;
    this.root.hidden = false;
  }

  hide(): void {
    this.open = false;
    this.root.hidden = true;
  }

  toggle(): void {
    if (this.rounds.length === 0) return;
    this.open = !this.open;
    this.root.hidden = !this.open;
    const latest = this.rounds[this.rounds.length - 1];
    if (this.open && latest) this.render(latest);
  }

  private render(summary: RoundSummary): void {
    (this.root.querySelector('.rs-count') as HTMLElement).textContent =
      `· round ${this.rounds.length} of this session`;

    const seconds = (value: number | null): string =>
      value === null ? 'never' : `${value.toFixed(1)} s`;
    const share = (value: number): string =>
      summary.seconds > 0 ? `${((value / summary.seconds) * 100).toFixed(0)}%` : '—';

    const rows: [string, string, string][] = [
      ['outcome', `${summary.winner} — ${summary.cause}`, `${summary.seconds.toFixed(1)} s`],
      ['players', `${summary.players - summary.bots} human`, `${summary.bots} bot`],
      ['first core in', seconds(summary.secondsToFirstCore), ''],
      ['all cores in', seconds(summary.secondsToLastCore), ''],
      ['cores lying free', seconds(summary.coreFreeSeconds), share(summary.coreFreeSeconds)],
      ['…never touched', seconds(summary.coreUntouchedSeconds), share(summary.coreUntouchedSeconds)],
      ['cores carried', seconds(summary.coreCarriedSeconds), share(summary.coreCarriedSeconds)],
      ['drops (blast / wash)', `${summary.dropsByBlast} / ${summary.dropsByWash}`, ''],
      ['every pad blocked', seconds(summary.allPadsBlockedSeconds), share(summary.allPadsBlockedSeconds)],
      ['drone stranded', seconds(summary.droneStrandedSeconds), share(summary.droneStrandedSeconds)],
      ['drone down', seconds(summary.droneDownSeconds), share(summary.droneDownSeconds)],
      ['EMP charging', seconds(summary.empChargingSeconds), ''],
      ['EMP draining', seconds(summary.empDrainingSeconds), ''],
      ['detonations / kills', `${summary.detonations} / ${summary.eliminations}`, ''],
      ['knockdowns / sabotage', `${summary.knockdowns} / ${summary.sabotages}`, ''],
    ];

    this.body.innerHTML = rows
      .map(([label, value, extra]) =>
        `<tr><th>${label}</th><td>${value}</td><td class="rs-share">${extra}</td></tr>`)
      .join('');
  }

  /** Every round this session, one row each. Column order is fixed. */
  private csv(): string {
    const keys = Object.keys(this.rounds[0] ?? {}) as (keyof RoundSummary)[];
    const cell = (value: unknown): string => {
      const text = value === null || value === undefined ? '' : String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    return [
      keys.join(','),
      ...this.rounds.map((row) => keys.map((key) => cell(row[key])).join(',')),
    ].join('\n');
  }

  private say(message: string): void {
    (this.root.querySelector('.rs-note') as HTMLElement).textContent = message;
  }
}
