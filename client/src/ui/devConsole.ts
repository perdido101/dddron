import {
  ALTITUDE_MAX,
  ALTITUDE_MIN,
  CORES_REQUIRED,
  DETONATION_RADIUS,
  DRONE_LINEAR_DAMPING,
  DRONE_MAX_SPEED,
  EMP_CHARGE_TIME,
  MIN_PLAYERS,
  ROUND_TIME,
  fuseForCycle,
} from '@shared/constants';

/** One action the console can fire. Server actions need a live connection. */
export interface DevActions {
  /** Server-owned: battery, cores, the round result. */
  send: (action: string, value?: number | string) => void;
  /** Client-owned: our own body, and the local hazard props. */
  teleport: (where: 'spawn' | 'station' | 'pad' | 'ceiling') => void;
  toggleHazards: () => boolean;
  /** Offline equivalents, so the console is not dead in single player. */
  localBattery: (charge: number) => void;
  localCycle: (cycle: number) => void;
}

/**
 * Dev console (handoff 02, session 4).
 *
 * Exists so a playtest can reach the states that take five minutes to reach
 * honestly — cycle 4, an empty battery, three cores already inserted — without
 * playing five minutes to get there. Everything that the server owns is asked
 * for over the wire rather than faked locally, because faking it would test
 * the fake.
 *
 * Never present in a production build: main.ts only constructs this when the
 * console is enabled, and Vite drops the import when it is not.
 */
export class DevConsole {
  private readonly root: HTMLElement;
  private readonly readout: HTMLElement;
  private open = false;
  private hazardsOn = true;
  private online = false;
  private serverDev = false;

  constructor(private readonly actions: DevActions, parent: HTMLElement = document.body) {
    this.root = document.createElement('div');
    this.root.id = 'devconsole';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="dev-title">DEV CONSOLE <span class="dev-note"></span></div>
      <div class="dev-group">
        <span>battery</span>
        <button data-act="battery" data-val="1">100%</button>
        <button data-act="battery" data-val="0.25">25%</button>
        <button data-act="battery" data-val="0.05">5%</button>
        <button data-act="detonate">DETONATE</button>
      </div>
      <div class="dev-group">
        <span>cycle</span>
        <button data-act="cycle" data-val="0">1</button>
        <button data-act="cycle" data-val="1">2</button>
        <button data-act="cycle" data-val="2">3</button>
        <button data-act="cycle" data-val="3">4</button>
      </div>
      <div class="dev-group">
        <span>cores</span>
        <button data-act="cores">RESET TO PADS</button>
        <button data-act="insertAll">INSERT ALL</button>
      </div>
      <div class="dev-group">
        <span>round</span>
        <button data-act="win" data-val="runners">RUNNERS WIN</button>
        <button data-act="win" data-val="drone">DRONE WINS</button>
        <button data-act="revive">REVIVE ALL</button>
      </div>
      <div class="dev-group">
        <span>teleport</span>
        <button data-tp="spawn">SPAWN</button>
        <button data-tp="station">EMP</button>
        <button data-tp="pad">PAD</button>
        <button data-tp="ceiling">CEILING</button>
      </div>
      <div class="dev-group">
        <span>hazards</span>
        <button data-hz="1">ON</button>
      </div>
      <pre class="dev-constants"></pre>
      <div class="dev-readout"></div>
    `;
    parent.appendChild(this.root);
    this.readout = this.root.querySelector('.dev-readout') as HTMLElement;

    (this.root.querySelector('.dev-constants') as HTMLElement).textContent = SACRED.join('\n');

    this.root.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest('button');
      if (!button) return;

      const teleport = button.dataset.tp;
      if (teleport) {
        this.actions.teleport(teleport as 'spawn' | 'station' | 'pad' | 'ceiling');
        this.say(`teleported to ${teleport}`);
        return;
      }
      if (button.dataset.hz) {
        this.hazardsOn = this.actions.toggleHazards();
        button.textContent = this.hazardsOn ? 'ON' : 'OFF';
        this.say(`hazards ${this.hazardsOn ? 'enabled' : 'disabled'}`);
        return;
      }

      const action = button.dataset.act;
      if (!action) return;
      const raw = button.dataset.val;
      const value = raw === undefined ? undefined : Number.isNaN(Number(raw)) ? raw : Number(raw);

      if (this.online) {
        if (!this.serverDev) {
          this.say('server has dev tools disabled (BUZZKILL_DEV=1 to enable)');
          return;
        }
        this.actions.send(action, value);
        this.say(`sent ${action}${raw === undefined ? '' : ` ${raw}`}`);
        return;
      }

      // Offline only the battery and the cycle have local equivalents; the
      // rest are server concepts and there is no server to ask.
      if (action === 'battery') this.actions.localBattery(Number(value));
      else if (action === 'detonate') this.actions.localBattery(0);
      else if (action === 'cycle') this.actions.localCycle(Number(value));
      else {
        this.say(`${action} needs a server — join a room first`);
        return;
      }
      this.say(`applied ${action} locally`);
    });
  }

  /** @param serverDev whether the connected server accepts dev commands. */
  setContext(online: boolean, serverDev: boolean): void {
    this.online = online;
    this.serverDev = serverDev;
    const note = this.root.querySelector('.dev-note') as HTMLElement;
    note.textContent = online
      ? serverDev ? '· server tools live' : '· server tools OFF'
      : '· offline';
  }

  toggle(): void {
    this.open = !this.open;
    this.root.hidden = !this.open;
  }

  get visible(): boolean {
    return this.open;
  }

  private say(message: string): void {
    this.readout.textContent = message;
  }
}

/**
 * The sacred constraints' numbers, shown rather than described.
 *
 * A playtester who thinks the drone feels too controllable can read the
 * damping here instead of asking whether someone quietly raised it.
 */
const SACRED = [
  `drone linear damping   ${DRONE_LINEAR_DAMPING}   (hard cap 0.8)`,
  `drone max speed        ${DRONE_MAX_SPEED} m/s`,
  `altitude band          ${ALTITUDE_MIN} – ${ALTITUDE_MAX} m`,
  `detonation radius      ${DETONATION_RADIUS} m`,
  `fuse, cycles 1-4       ${[0, 1, 2, 3].map((c) => fuseForCycle(c).toFixed(0)).join(' / ')} s`,
  `cores required         ${CORES_REQUIRED}`,
  `EMP charge time        ${EMP_CHARGE_TIME} s`,
  `round time             ${ROUND_TIME} s`,
  `players, real match    ${MIN_PLAYERS} minimum`,
];
