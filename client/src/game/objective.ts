import * as THREE from 'three';

import {
  CHARGE_PAD_POSITIONS,
  COLOR_CORE,
  COLOR_CORE_CARRIED,
  CORES_REQUIRED,
  CORE_BOB_HEIGHT,
  CORE_BOB_HZ,
  CORE_CARRY_HEIGHT,
  CORE_INSERT_HOLD,
  CORE_ON_PAD_RADIUS,
  CORE_PICKUP_HOLD,
  CORE_PICKUP_RADIUS,
  CORE_RADIUS,
  CORE_SHAFT_HEIGHT,
  CORE_SHAFT_OPACITY,
  CORE_SHAFT_RADIUS,
  CORE_SHAFT_SPIN,
  CORE_SPIN_RATE,
  EMP_CHARGE_TIME,
  EMP_DRAIN_ON_ABANDON,
  EMP_STATION_POSITION,
  EMP_STATION_RADIUS,
  HEAD_OFFSET,
  HEAD_RADIUS,
  INTERACT_MOVE_CANCEL_SPEED,
  empChargeMinPresent,
} from '@shared/constants';

import type { Runner } from './runner';

export type CoreState = 'onPad' | 'loose' | 'carried' | 'inserted';

/** One power core. Spawns on a charge pad; ends up in the EMP station. */
export class PowerCore {
  state: CoreState = 'onPad';
  readonly position = new THREE.Vector3();
  readonly mesh: THREE.Mesh;
  /** Beam of light over the core while somebody is carrying it. */
  readonly shaft: THREE.Mesh;
  /** Pad this core is currently blocking, if any. */
  pad: readonly [number, number] | null;

  private bobClock = 0;

  constructor(scene: THREE.Scene, pad: readonly [number, number]) {
    this.pad = pad;
    this.position.set(pad[0], CORE_RADIUS, pad[1]);

    this.mesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(CORE_RADIUS, CORE_RADIUS * 1.1),
      new THREE.MeshLambertMaterial({ color: COLOR_CORE, emissive: COLOR_CORE, emissiveIntensity: 0.35 }),
    );
    this.mesh.castShadow = true;
    scene.add(this.mesh);

    // Same light shaft the networked cores get, so the offline build and the
    // online one read identically — a carried core is visible arena-wide.
    this.shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(CORE_SHAFT_RADIUS * 2.2, CORE_SHAFT_RADIUS, CORE_SHAFT_HEIGHT, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: COLOR_CORE_CARRIED,
        transparent: true,
        opacity: CORE_SHAFT_OPACITY,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.shaft.visible = false;
    scene.add(this.shaft);
  }

  /** True while the core physically occupies a pad and denies it to the drone. */
  get blocksPad(): boolean {
    return (this.state === 'onPad' || this.state === 'loose') && this.pad !== null;
  }

  render(frameDelta: number, carrier: Runner | null): void {
    if (this.state === 'inserted') {
      this.mesh.visible = false;
      this.shaft.visible = false;
      return;
    }
    this.mesh.visible = true;
    this.shaft.visible = this.state === 'carried';

    if (this.state === 'carried' && carrier) {
      // Held overhead, so everyone can see who has it from across the arena.
      this.position.set(
        carrier.object.position.x,
        carrier.object.position.y + HEAD_OFFSET + HEAD_RADIUS + CORE_CARRY_HEIGHT,
        carrier.object.position.z,
      );
      (this.mesh.material as THREE.MeshLambertMaterial).color.setHex(COLOR_CORE_CARRIED);
      this.mesh.position.copy(this.position);
      this.mesh.rotation.set(0, 0, 0);
      // Positioned after the carry move, not before, or the beam trails the
      // core it is supposed to be marking by a frame.
      this.shaft.position.set(
        this.position.x,
        this.position.y + CORE_SHAFT_HEIGHT / 2,
        this.position.z,
      );
      this.shaft.rotation.y += frameDelta * CORE_SHAFT_SPIN;
      return;
    }

    (this.mesh.material as THREE.MeshLambertMaterial).color.setHex(COLOR_CORE);
    this.bobClock += frameDelta;
    this.mesh.position.set(
      this.position.x,
      this.position.y + Math.sin(this.bobClock * Math.PI * 2 * CORE_BOB_HZ) * CORE_BOB_HEIGHT,
      this.position.z,
    );
    this.mesh.rotation.y = this.bobClock * CORE_SPIN_RATE;
  }
}

/** What the HUD needs to draw, and what the tests read. */
export interface ObjectiveStatus {
  readonly inserted: number;
  readonly required: number;
  readonly charge: number;
  readonly charging: boolean;
  readonly present: number;
  readonly needed: number;
  readonly prompt: string | null;
  readonly holdProgress: number;
  readonly fired: boolean;
}

/**
 * Power cores and the EMP.
 *
 * Sacred constraint 6: every objective action here is slow, loud and
 * co-located. Nothing can be done alone, quickly and safely — picking a core
 * up is a hold, carrying it costs you your speed and your jump, inserting it is
 * a longer hold that any movement cancels, and the final charge needs bodies
 * standing in one place.
 */
export class Objective {
  readonly cores: PowerCore[] = [];
  /** 0-1 across EMP_CHARGE_TIME. */
  charge = 0;
  fired = false;

  private carriedBy: Runner | null = null;
  private carried: PowerCore | null = null;
  private holdTimer = 0;
  private holdKind: 'pickup' | 'insert' | null = null;
  private holdTarget: PowerCore | null = null;
  private prompt: string | null = null;
  private present = 0;
  private needed = 1;
  private coresVisible = true;

  private readonly station = new THREE.Vector3(EMP_STATION_POSITION[0], 0, EMP_STATION_POSITION[1]);

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < CORES_REQUIRED; i += 1) {
      const pad = CHARGE_PAD_POSITIONS[i % CHARGE_PAD_POSITIONS.length];
      if (pad) this.cores.push(new PowerCore(scene, pad));
    }
  }

  get insertedCount(): number {
    return this.cores.filter((core) => core.state === 'inserted').length;
  }

  /** Pads not currently blocked by a core — the drone's dockable options. */
  availablePads(): readonly (readonly [number, number])[] {
    return CHARGE_PAD_POSITIONS.filter(
      (pad) => !this.cores.some((core) => core.blocksPad && samePad(core.pad, pad)),
    );
  }

  /**
   * One fixed step.
   *
   * @param interact whether the interact key is currently held.
   */
  step(dt: number, runners: readonly Runner[], interact: boolean): void {
    if (this.fired) return;

    // Read the shove flags once per step: both the core drop and the insert
    // cancel depend on them, and consuming twice would lose the second read.
    const shoved = new Set<Runner>();
    for (const runner of runners) if (runner.consumeShoved()) shoved.add(runner);

    this.dropIfShoved(shoved);
    this.updateHold(dt, runners, interact, shoved);
    this.updateCharge(dt, runners);
  }

  /** Prop wash knocks a carried core loose where the runner stands. */
  private dropIfShoved(shoved: ReadonlySet<Runner>): void {
    const carrier = this.carriedBy;
    const core = this.carried;
    if (!carrier || !core) return;
    if (!shoved.has(carrier) && carrier.alive) return;

    core.state = 'loose';
    // Move it first: the pad test has to run against where it LANDS, not
    // against where it was being carried.
    core.position.set(carrier.position.x, CORE_RADIUS, carrier.position.z);
    core.pad = padUnder(core.position);
    carrier.carrying = false;
    this.carriedBy = null;
    this.carried = null;
    this.cancelHold();
  }

  private updateHold(
    dt: number,
    runners: readonly Runner[],
    interact: boolean,
    shoved: ReadonlySet<Runner>,
  ): void {
    const actor = runners.find((runner) => runner.alive) ?? null;
    this.prompt = null;
    if (!actor) {
      this.cancelHold();
      return;
    }

    // Inserting takes priority: if you are carrying a core and standing in the
    // station, that is obviously what you are trying to do.
    if (this.carried && this.carriedBy === actor && this.inStation(actor)) {
      this.prompt = `hold E to insert core (${this.insertedCount + 1}/${CORES_REQUIRED})`;
      this.runHold(dt, interact, 'insert', this.carried, CORE_INSERT_HOLD, actor, shoved, () => {
        const core = this.carried;
        if (!core) return;
        core.state = 'inserted';
        core.pad = null;
        actor.carrying = false;
        this.carried = null;
        this.carriedBy = null;
      });
      return;
    }

    if (this.carried) {
      this.prompt = 'carry the core to the EMP station';
      this.cancelHold();
      return;
    }

    const target = this.nearestPickup(actor);
    if (!target) {
      this.cancelHold();
      return;
    }

    this.prompt = 'hold E to lift the power core';
    this.runHold(dt, interact, 'pickup', target, CORE_PICKUP_HOLD, null, shoved, () => {
      target.state = 'carried';
      target.pad = null;
      this.carried = target;
      this.carriedBy = actor;
      actor.carrying = true;
    });
  }

  /**
   * @param stillness runner that must stand still, or null if movement is fine.
   */
  private runHold(
    dt: number,
    interact: boolean,
    kind: 'pickup' | 'insert',
    target: PowerCore,
    duration: number,
    stillness: Runner | null,
    shoved: ReadonlySet<Runner>,
    complete: () => void,
  ): void {
    if (!interact) {
      this.cancelHold();
      return;
    }
    // "Cancels on movement or hit" (brief, phase 4). Movement means the player
    // asking to move, not being shoved around — the shove is the separate
    // "or hit" clause, and conflating them lets a distant brush of wash cancel
    // every insert without the drone ever committing to the station.
    if (stillness && (stillness.intentSpeed > INTERACT_MOVE_CANCEL_SPEED || shoved.has(stillness))) {
      this.cancelHold();
      return;
    }
    if (this.holdKind !== kind || this.holdTarget !== target) {
      this.holdKind = kind;
      this.holdTarget = target;
      this.holdTimer = 0;
    }
    this.holdTimer += dt;
    if (this.holdTimer >= duration) {
      complete();
      this.cancelHold();
    }
  }

  private cancelHold(): void {
    this.holdTimer = 0;
    this.holdKind = null;
    this.holdTarget = null;
  }

  /**
   * Charge phase. Needs bodies in the zone; decays at EMP_DRAIN_ON_ABANDON of
   * the fill rate when they leave, so wandering off costs you real progress.
   */
  private updateCharge(dt: number, runners: readonly Runner[]): void {
    const alive = runners.filter((runner) => runner.alive);
    this.needed = empChargeMinPresent(alive.length);
    this.present = alive.filter((runner) => this.inStation(runner)).length;

    if (this.insertedCount < CORES_REQUIRED) {
      this.charge = 0;
      return;
    }

    const rate = 1 / EMP_CHARGE_TIME;
    if (this.present >= this.needed) {
      this.charge = Math.min(1, this.charge + rate * dt);
      if (this.charge >= 1) this.fired = true;
    } else {
      this.charge = Math.max(0, this.charge - rate * EMP_DRAIN_ON_ABANDON * dt);
    }
  }

  private inStation(runner: Runner): boolean {
    return Math.hypot(runner.position.x - this.station.x, runner.position.z - this.station.z)
      <= EMP_STATION_RADIUS;
  }

  private nearestPickup(runner: Runner): PowerCore | null {
    let best: PowerCore | null = null;
    let bestDistance = CORE_PICKUP_RADIUS;
    for (const core of this.cores) {
      if (core.state !== 'onPad' && core.state !== 'loose') continue;
      const distance = Math.hypot(
        core.position.x - runner.position.x,
        core.position.z - runner.position.z,
      );
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = core;
      }
    }
    return best;
  }

  render(frameDelta: number): void {
    if (!this.coresVisible) {
      for (const core of this.cores) {
        core.mesh.visible = false;
        core.shaft.visible = false;
      }
      return;
    }
    for (const core of this.cores) {
      core.render(frameDelta, core === this.carried ? this.carriedBy : null);
    }
  }

  /**
   * Hide the local cores.
   *
   * Online the server owns every core and the network layer draws them from
   * its snapshot. Leaving these on renders each core twice, in two different
   * places, and the wrong copy is the one that responds to your key presses.
   */
  setCoresVisible(visible: boolean): void {
    this.coresVisible = visible;
  }

  status(): ObjectiveStatus {
    const duration = this.holdKind === 'insert' ? CORE_INSERT_HOLD : CORE_PICKUP_HOLD;
    return {
      inserted: this.insertedCount,
      required: CORES_REQUIRED,
      charge: this.charge,
      charging: this.insertedCount >= CORES_REQUIRED,
      present: this.present,
      needed: this.needed,
      prompt: this.prompt,
      holdProgress: this.holdKind ? Math.min(this.holdTimer / duration, 1) : 0,
      fired: this.fired,
    };
  }
}

function samePad(a: readonly [number, number] | null, b: readonly [number, number]): boolean {
  return a !== null && a[0] === b[0] && a[1] === b[1];
}

/** Which pad, if any, a dropped core has landed on. */
function padUnder(position: THREE.Vector3): readonly [number, number] | null {
  for (const pad of CHARGE_PAD_POSITIONS) {
    if (Math.hypot(position.x - pad[0], position.z - pad[1]) <= CORE_ON_PAD_RADIUS) return pad;
  }
  return null;
}
