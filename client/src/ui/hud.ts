import {
  BATTERY_COLOR_CRITICAL,
  BATTERY_COLOR_FULL,
  BATTERY_COLOR_LOW,
  BATTERY_LOW_FRACTION,
} from '@shared/constants';

import type { Fuse } from '@shared/fuse';
import type { ObjectiveStatus } from '../game/objective';

/**
 * Battery readout.
 *
 * Deliberately public information (brief, phase 3): every player sees the same
 * percentage, because the tension comes from everyone knowing how long is left,
 * not from the runners guessing.
 */
export class Hud {
  private readonly root: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly readout: HTMLElement;
  private readonly status: HTMLElement;
  private readonly warning: HTMLElement;
  private readonly objective: HTMLElement;
  private readonly objectiveBar: HTMLElement;
  private readonly prompt: HTMLElement;
  private readonly flash: HTMLElement;
  private readonly victory: HTMLElement;

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement('div');
    this.root.id = 'hud';

    const label = document.createElement('div');
    label.className = 'hud-label';
    label.textContent = 'DRONE BATTERY';

    this.readout = document.createElement('div');
    this.readout.className = 'hud-readout';

    const track = document.createElement('div');
    track.className = 'hud-track';
    this.bar = document.createElement('div');
    this.bar.className = 'hud-bar';
    track.appendChild(this.bar);

    this.status = document.createElement('div');
    this.status.className = 'hud-status';

    this.root.append(label, this.readout, track, this.status);
    parent.appendChild(this.root);

    this.warning = document.createElement('div');
    this.warning.id = 'hud-warning';
    this.warning.textContent = 'DETONATION IMMINENT';
    parent.appendChild(this.warning);

    this.objective = document.createElement('div');
    this.objective.id = 'hud-objective';
    this.objective.innerHTML =
      '<div class="hud-obj-text"></div><div class="hud-track"><div class="hud-obj-bar"></div></div>';
    parent.appendChild(this.objective);
    this.objectiveBar = this.objective.querySelector('.hud-obj-bar') as HTMLElement;

    this.prompt = document.createElement('div');
    this.prompt.id = 'hud-prompt';
    parent.appendChild(this.prompt);

    this.flash = document.createElement('div');
    this.flash.id = 'hud-flash';
    parent.appendChild(this.flash);

    this.victory = document.createElement('div');
    this.victory.id = 'hud-victory';
    this.victory.textContent = 'EMP FIRED — RUNNERS WIN';
    parent.appendChild(this.victory);
  }

  /**
   * @param flash 0-1 of the screen-wide white pulse when the EMP fires.
   */
  updateObjective(status: ObjectiveStatus, flash: number): void {
    const text = this.objective.querySelector('.hud-obj-text') as HTMLElement;
    if (status.charging) {
      text.textContent = status.fired
        ? 'EMP DISCHARGED'
        : `EMP CHARGING — ${(status.charge * 100).toFixed(0)}%  (${status.present}/${status.needed} in the zone)`;
      this.objectiveBar.style.width = `${status.charge * 100}%`;
    } else {
      text.textContent = `POWER CORES  ${status.inserted}/${status.required}`;
      this.objectiveBar.style.width = `${(status.inserted / status.required) * 100}%`;
    }

    // The hold prompt doubles as the progress readout for the hold itself.
    if (status.prompt && !status.fired) {
      this.prompt.style.display = 'block';
      this.prompt.textContent = status.prompt;
      this.prompt.style.background =
        `linear-gradient(90deg, rgba(127,212,168,0.85) ${status.holdProgress * 100}%,` +
        ` rgba(24,30,38,0.72) ${status.holdProgress * 100}%)`;
    } else {
      this.prompt.style.display = 'none';
    }

    this.flash.style.opacity = String(flash);
    this.victory.style.display = status.fired && flash < 0.5 ? 'block' : 'none';
  }

  update(fuse: Fuse): void {
    const percent = Math.ceil(fuse.charge * 100);
    this.readout.textContent = `${percent}%`;
    this.bar.style.width = `${fuse.charge * 100}%`;
    this.bar.style.background = hex(colourFor(fuse.charge));

    this.status.textContent = statusText(fuse);

    // The visual half of the telegraph: a warning that pulses faster as the
    // fuse runs out, matching the rising prop pitch.
    const telegraph = fuse.telegraphProgress;
    if (telegraph > 0) {
      this.warning.style.opacity = String(0.55 + 0.45 * Math.abs(Math.sin(telegraph * Math.PI * 6)));
      this.warning.style.display = 'block';
    } else {
      this.warning.style.display = 'none';
    }
  }
}

function colourFor(charge: number): number {
  if (charge <= 0) return BATTERY_COLOR_CRITICAL;
  if (charge <= BATTERY_LOW_FRACTION) return BATTERY_COLOR_LOW;
  return BATTERY_COLOR_FULL;
}

function statusText(fuse: Fuse): string {
  switch (fuse.state) {
    case 'armed':
      return `cycle ${fuse.cycle + 1} · ${fuse.secondsRemaining.toFixed(1)}s of fuse left`;
    case 'telegraph':
      return `cycle ${fuse.cycle + 1} · ${fuse.secondsRemaining.toFixed(1)}s — GET CLEAR`;
    case 'inert':
      return 'detonated — drone is down';
    case 'returning':
      return 'limping back to a charge pad';
    case 'recharging':
      return `recharging · ${fuse.rechargeRemaining.toFixed(1)}s (vulnerable)`;
    default:
      return '';
  }
}

function hex(colour: number): string {
  return `#${colour.toString(16).padStart(6, '0')}`;
}
