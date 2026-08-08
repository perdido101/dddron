import { ALTITUDE_MAX, ROUND_TIME, TELEGRAPH_TIME } from '@shared/constants';

import type { Fuse } from '../game/fuse';

/**
 * Onboard telemetry drawn inside the feed.
 *
 * The battery here mirrors the same `Fuse` object the third-person HUD reads,
 * so the two can never disagree — sacred constraint 3 makes battery the single
 * source of truth, and this module is forbidden from computing it.
 * The crosshair is cosmetic and confers no mechanical benefit.
 */
export class FpvOverlay {
  private readonly root: HTMLElement;
  private readonly battery: HTMLElement;
  private readonly altitude: HTMLElement;
  private readonly speed: HTMLElement;
  private readonly horizon: HTMLElement;
  private readonly recTimer: HTMLElement;
  private readonly lowPower: HTMLElement;

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement('div');
    this.root.id = 'fpv';
    this.root.innerHTML = `
      <div class="fpv-corner tl"></div><div class="fpv-corner tr"></div>
      <div class="fpv-corner bl"></div><div class="fpv-corner br"></div>
      <div class="fpv-battery"><span class="fpv-batt-value">100%</span><span class="fpv-batt-label">BATT</span></div>
      <div class="fpv-right">
        <div class="fpv-rec"><span class="fpv-dot"></span><span class="fpv-time">3:00</span></div>
        <div class="fpv-alt">ALT <span>0.0</span>m</div>
        <div class="fpv-spd">SPD <span>0.0</span>m/s</div>
      </div>
      <div class="fpv-horizon"><i></i></div>
      <div class="fpv-crosshair"></div>
      <div class="fpv-lowpower">LOW POWER</div>
    `;
    parent.appendChild(this.root);

    this.battery = must(this.root.querySelector('.fpv-batt-value'));
    this.altitude = must(this.root.querySelector('.fpv-alt span'));
    this.speed = must(this.root.querySelector('.fpv-spd span'));
    this.horizon = must(this.root.querySelector('.fpv-horizon i'));
    this.recTimer = must(this.root.querySelector('.fpv-time'));
    this.lowPower = must(this.root.querySelector('.fpv-lowpower'));
    this.setVisible(false);
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? 'block' : 'none';
  }

  update(fuse: Fuse, altitude: number, speed: number, pitch: number, roll: number, elapsed: number): void {
    const percent = Math.ceil(fuse.charge * 100);
    this.battery.textContent = `${percent}%`;

    const telegraphing = fuse.telegraphProgress > 0;
    this.battery.classList.toggle('critical', telegraphing);
    this.lowPower.style.display = telegraphing ? 'block' : 'none';

    this.altitude.textContent = altitude.toFixed(1);
    this.speed.textContent = speed.toFixed(1);
    // Artificial horizon tilts with the body — it is bolted on like the camera.
    this.horizon.style.transform =
      `translate(-50%, -50%) rotate(${(-roll * 180) / Math.PI}deg) translateY(${pitch * HORIZON_PIXELS_PER_RADIAN}px)`;

    const remaining = Math.max(0, ROUND_TIME - elapsed);
    const minutes = Math.floor(remaining / 60);
    const seconds = Math.floor(remaining % 60);
    this.recTimer.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  /** Altitude ceiling shown on the readout, for context in later phases. */
  static get ceiling(): number {
    return ALTITUDE_MAX;
  }

  /** Seconds of telegraph, exposed so the overlay and HUD stay in step. */
  static get telegraphWindow(): number {
    return TELEGRAPH_TIME;
  }
}

const HORIZON_PIXELS_PER_RADIAN = 90;

function must<T>(value: T | null): T {
  if (value === null) throw new Error('FPV overlay element missing');
  return value;
}
