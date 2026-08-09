/**
 * The fuse: the drone's battery, and therefore its life cycle.
 *
 * Lives in /shared because sacred constraint 3 makes battery server-authoritative
 * and the single source of truth. The server runs this; clients only render what
 * it reports. Deliberately free of Three.js and of any renderer type, so the
 * exact same file executes in Node.
 */
import {
  CHARGE_PAD_POSITIONS,
  DETONATION_RADIUS,
  DRONE_DOCK_HEIGHT,
  DRONE_DOCK_RADIUS,
  DRONE_INERT_TIME,
  RECHARGE_TIME,
  TELEGRAPH_TIME,
  fuseForCycle,
} from './constants';

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
  readonly position: Vec3;
  readonly cycle: number;
}

/** Minimal position type, so this file works on the server with no renderer. */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
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

  /** True when the drone has nowhere to dock because every pad is contested. */
  get stranded(): boolean {
    return this.state === 'returning' && this.targetPad === null;
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
  step(
    dt: number,
    dronePosition: Vec3,
    grounded: boolean,
    availablePads: readonly (readonly [number, number])[] = CHARGE_PAD_POSITIONS,
  ): DetonationEvent | null {
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
          this.targetPad = this.nearestPad(dronePosition, availablePads);
        }
        return null;
      }

      case 'returning': {
        // The contest rule can strand the drone: if a runner drops a core onto
        // the pad it was heading for, it has to pick a different one, and if
        // every pad is blocked it loiters with nowhere to recharge.
        if (!this.targetPad || !availablePads.some((pad) => samePad(pad, this.targetPad))) {
          this.targetPad = availablePads.length > 0 ? this.nearestPad(dronePosition, availablePads) : null;
        }
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

  private detonate(position: Vec3): DetonationEvent {
    this.charge = 0;
    this.state = 'inert';
    this.timer = 0;
    return { position: { x: position.x, y: position.y, z: position.z }, cycle: this.cycle };
  }

  private docked(position: Vec3): boolean {
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
  private nearestPad(
    position: Vec3,
    pads: readonly (readonly [number, number])[],
  ): readonly [number, number] {
    let best: readonly [number, number] = pads[0] ?? CHARGE_PAD_POSITIONS[0];
    let bestDistance = Infinity;
    for (const pad of pads) {
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

function distance(a: Vec3, b: Vec3): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function samePad(
  a: readonly [number, number],
  b: readonly [number, number] | null,
): boolean {
  return b !== null && a[0] === b[0] && a[1] === b[1];
}

/** Everything the detonation can eliminate. */
export interface Blastable {
  readonly position: Vec3;
  readonly alive: boolean;
  eliminate(): void;
}

/**
 * Sphere overlap at DETONATION_RADIUS. Anything inside is eliminated.
 * @returns the victims, for scoring and for the kill feed.
 */
export function applyBlast(origin: Vec3, targets: readonly Blastable[]): Blastable[] {
  const victims: Blastable[] = [];
  for (const target of targets) {
    if (!target.alive) continue;
    if (distance(target.position, origin) <= DETONATION_RADIUS) {
      target.eliminate();
      victims.push(target);
    }
  }
  return victims;
}
