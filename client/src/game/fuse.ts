import * as THREE from 'three';

import {
  CHARGE_PAD_POSITIONS,
  DETONATION_RADIUS,
  DRONE_DOCK_HEIGHT,
  DRONE_DOCK_RADIUS,
  DRONE_INERT_TIME,
  RECHARGE_TIME,
  TELEGRAPH_TIME,
  fuseForCycle,
} from '@shared/constants';

/**
 * The drone's life cycle. The battery IS the fuse (concept, section 1), and
 * detonation is purely a function of it reaching zero — sacred constraint 2
 * says there is no manual trigger, ever, so nothing here takes pilot input.
 */
export type FuseState =
  /** Powered and piloted. */
  | 'armed'
  /** Final TELEGRAPH_TIME seconds. Still piloted, but loudly about to go off. */
  | 'telegraph'
  /** Dead weight, falling. */
  | 'inert'
  /** Flying itself back to a charge pad at reduced speed. */
  | 'returning'
  /** Sat on a pad, immobile and vulnerable. */
  | 'recharging';

export interface DetonationEvent {
  readonly position: THREE.Vector3;
  readonly cycle: number;
}

/**
 * Server-authoritative in phase 5 — sacred constraint 3 makes battery the
 * single source of truth, computed in one place and only rendered by clients.
 * Keeping it in its own class with no rendering and no input means moving it
 * to the server later is a relocation, not a rewrite.
 */
export class Fuse {
  state: FuseState = 'armed';
  /** Detonation cycle. Index 0 is the drone's first life. */
  cycle = 0;
  /** 1 = full, 0 = detonation. The HUD renders this; it never computes it. */
  charge = 1;

  private timer = 0;
  private targetPad: readonly [number, number] | null = null;

  /** Seconds of fuse remaining on this cycle. */
  get secondsRemaining(): number {
    return this.charge * fuseForCycle(this.cycle);
  }

  /** 0 outside the telegraph window, ramping to 1 at detonation. */
  get telegraphProgress(): number {
    if (this.state !== 'telegraph') return 0;
    return 1 - Math.min(this.secondsRemaining / TELEGRAPH_TIME, 1);
  }

  /** True while the drone answers the pilot at all. */
  get piloted(): boolean {
    return this.state === 'armed' || this.state === 'telegraph';
  }

  /** Pad the drone is heading for or sat on, if any. */
  get pad(): readonly [number, number] | null {
    return this.targetPad;
  }

  /**
   * Advance one fixed step.
   *
   * @param dronePosition used to pick a pad and to test docking.
   * @param grounded whether the inert drone has hit the floor yet.
   * @returns a detonation event on the step the battery hits zero, else null.
   */
  step(dt: number, dronePosition: THREE.Vector3, grounded: boolean): DetonationEvent | null {
    switch (this.state) {
      case 'armed':
      case 'telegraph': {
        const fuse = fuseForCycle(this.cycle);
        this.charge = Math.max(0, this.charge - dt / fuse);
        if (this.charge <= 0) return this.detonate(dronePosition);
        this.state = this.secondsRemaining <= TELEGRAPH_TIME ? 'telegraph' : 'armed';
        return null;
      }

      case 'inert': {
        // Only start counting once it has actually landed, so a detonation
        // high above the arena still reads as "it fell out of the sky".
        if (grounded) this.timer += dt;
        if (this.timer >= DRONE_INERT_TIME) {
          this.state = 'returning';
          this.targetPad = this.nearestPad(dronePosition);
        }
        return null;
      }

      case 'returning': {
        if (this.docked(dronePosition)) {
          this.state = 'recharging';
          this.timer = 0;
        }
        return null;
      }

      case 'recharging': {
        this.timer += dt;
        if (this.timer >= RECHARGE_TIME) {
          // Relaunch on the next cycle — a shorter fuse than last time.
          this.cycle += 1;
          this.charge = 1;
          this.state = 'armed';
          this.targetPad = null;
        }
        return null;
      }

      default:
        return null;
    }
  }

  private detonate(position: THREE.Vector3): DetonationEvent {
    this.charge = 0;
    this.state = 'inert';
    this.timer = 0;
    return { position: position.clone(), cycle: this.cycle };
  }

  private docked(position: THREE.Vector3): boolean {
    if (!this.targetPad) return false;
    const [px, pz] = this.targetPad;
    return (
      Math.hypot(position.x - px, position.z - pz) < DRONE_DOCK_RADIUS &&
      position.y < DRONE_DOCK_HEIGHT + DRONE_DOCK_RADIUS
    );
  }

  /**
   * Nearest pad by straight-line distance. Phase 4 adds the contest rule —
   * a pad holding a power core cannot be docked on — and this is where that
   * filter goes.
   */
  private nearestPad(position: THREE.Vector3): readonly [number, number] {
    let best: readonly [number, number] = CHARGE_PAD_POSITIONS[0];
    let bestDistance = Infinity;
    for (const pad of CHARGE_PAD_POSITIONS) {
      const distance = Math.hypot(position.x - pad[0], position.z - pad[1]);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = pad;
      }
    }
    return best;
  }

  /** Seconds left of the current recharge, for the HUD. */
  get rechargeRemaining(): number {
    return this.state === 'recharging' ? Math.max(0, RECHARGE_TIME - this.timer) : 0;
  }
}

/** Everything the detonation can eliminate. */
export interface Blastable {
  readonly position: THREE.Vector3;
  readonly alive: boolean;
  eliminate(): void;
}

/**
 * Sphere overlap at DETONATION_RADIUS. Anything inside is eliminated.
 * @returns the victims, for scoring and for the kill feed.
 */
export function applyBlast(origin: THREE.Vector3, targets: readonly Blastable[]): Blastable[] {
  const victims: Blastable[] = [];
  for (const target of targets) {
    if (!target.alive) continue;
    if (target.position.distanceTo(origin) <= DETONATION_RADIUS) {
      target.eliminate();
      victims.push(target);
    }
  }
  return victims;
}
