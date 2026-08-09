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
      new THREE.MeshLambertMaterial({ color: COLOR_CORE, emissive: COLOR_CORE, emissiveIntensity: 0.7 }),
    );
    this.mesh.castShadow = true;
    scene.add(this.mesh);

    // Same light shaft the networked cores get, so the offline build and the
    // online one read identically — a carried core is visible arena-wide.
    this.shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(CORE_SHAFT_RADIUS * 2.2, CORE_SHAFT_RADIUS, CORE_SHAFT_HEIGHT, 12, 1, true),
      new THREE.MeshBasicMaterial({
        // Saturated core cyan, not the pale carried tint: an additive shaft
        // in a washed-out colour disappears against a sunlit floor, and this
        // beam's whole job is to be seen over rooftops from 40 m.
        color: COLOR_CORE,
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

/** One runner's in-progress hold. */
interface Hold {
  kind: 'pickup' | 'insert';
  target: PowerCore;
  timer: number;
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

  /**
   * Per-runner state, so offline bots can work the objective alongside the
   * player. This was a single carrier and a single hold, which was correct
   * while offline meant exactly one body — it stopped being correct the moment
   * solo play grew bots, and one shared hold timer would have let a bot's
   * pickup complete under the player's finger.
   */
  private readonly held = new Map<Runner, PowerCore>();
  private readonly holds = new Map<Runner, Hold>();
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
  step(dt: number, runners: readonly Runner[]): void {
    if (this.fired) return;

    // Read the shove flags once per step: both the core drop and the insert
    // cancel depend on them, and consuming twice would lose the second read.
    const shoved = new Set<Runner>();
    for (const runner of runners) if (runner.consumeShoved()) shoved.add(runner);

    this.dropIfShoved(shoved);
    this.prompt = null;
    for (const runner of runners) this.updateHold(dt, runner, shoved, runner === runners[0]);
    this.updateCharge(dt, runners);
  }

  /**
   * Knock loose any core whose carrier is no longer carrying it.
   *
   * Three ways that happens: prop wash shoved them, they were eliminated, or
   * something outside cleared their `carrying` flag. The last one is not
   * hypothetical — an eliminated bot that respawns before this runs comes back
   * alive and empty-handed while the core is still mapped to it, and then the
   * bot hunts for a core that does not exist while the objective waits for it
   * to deliver one it does not think it has. Reconciling on the flag rather
   * than only on the cause makes that state unrepresentable.
   */
  private dropIfShoved(shoved: ReadonlySet<Runner>): void {
    for (const [carrier, core] of [...this.held]) {
      if (!shoved.has(carrier) && carrier.alive && carrier.carrying) continue;

      core.state = 'loose';
      // Move it first: the pad test has to run against where it LANDS, not
      // against where it was being carried.
      core.position.set(carrier.position.x, CORE_RADIUS, carrier.position.z);
      core.pad = padUnder(core.position);
      carrier.carrying = false;
      this.held.delete(carrier);
      this.holds.delete(carrier);
    }
  }

  /** @param speaks whether this runner's situation drives the on-screen prompt. */
  private updateHold(
    dt: number,
    actor: Runner,
    shoved: ReadonlySet<Runner>,
    speaks: boolean,
  ): void {
    if (!actor.alive) {
      this.holds.delete(actor);
      return;
    }
    const carried = this.held.get(actor);

    // Inserting takes priority: if you are carrying a core and standing in the
    // station, that is obviously what you are trying to do.
    if (carried && this.inStation(actor)) {
      if (speaks) this.prompt = `hold E to insert core (${this.insertedCount + 1}/${CORES_REQUIRED})`;
      this.runHold(dt, actor, 'insert', carried, CORE_INSERT_HOLD, actor, shoved, () => {
        carried.state = 'inserted';
        carried.pad = null;
        actor.carrying = false;
        this.held.delete(actor);
      });
      return;
    }

    if (carried) {
      if (speaks) this.prompt = 'carry the core to the EMP station';
      this.holds.delete(actor);
      return;
    }

    const target = this.nearestPickup(actor);
    if (!target) {
      this.holds.delete(actor);
      return;
    }

    if (speaks) this.prompt = 'hold E to lift the power core';
    this.runHold(dt, actor, 'pickup', target, CORE_PICKUP_HOLD, null, shoved, () => {
      // Re-check on completion: two runners can hold the same core, and the
      // second to finish must not take it out of the first one's hands.
      if (target.state !== 'onPad' && target.state !== 'loose') return;
      target.state = 'carried';
      target.pad = null;
      this.held.set(actor, target);
      actor.carrying = true;
    });
  }

  /**
   * @param stillness runner that must stand still, or null if movement is fine.
   */
  private runHold(
    dt: number,
    actor: Runner,
    kind: 'pickup' | 'insert',
    target: PowerCore,
    duration: number,
    stillness: Runner | null,
    shoved: ReadonlySet<Runner>,
    complete: () => void,
  ): void {
    if (!actor.interacting) {
      this.holds.delete(actor);
      return;
    }
    // "Cancels on movement or hit" (brief, phase 4). Movement means the player
    // asking to move, not being shoved around — the shove is the separate
    // "or hit" clause, and conflating them lets a distant brush of wash cancel
    // every insert without the drone ever committing to the station.
    if (stillness && (stillness.intentSpeed > INTERACT_MOVE_CANCEL_SPEED || shoved.has(stillness))) {
      this.holds.delete(actor);
      return;
    }

    let hold = this.holds.get(actor);
    if (!hold || hold.kind !== kind || hold.target !== target) {
      hold = { kind, target, timer: 0 };
      this.holds.set(actor, hold);
    }
    hold.timer += dt;
    if (hold.timer >= duration) {
      complete();
      this.holds.delete(actor);
    }
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

  /** Who is holding this core, if anyone. */
  private carrierOf(core: PowerCore): Runner | null {
    for (const [runner, held] of this.held) {
      if (held === core) return runner;
    }
    return null;
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
      core.render(frameDelta, this.carrierOf(core));
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

  status(player?: Runner): ObjectiveStatus {
    const hold = player ? this.holds.get(player) : undefined;
    const duration = hold?.kind === 'insert' ? CORE_INSERT_HOLD : CORE_PICKUP_HOLD;
    return {
      inserted: this.insertedCount,
      required: CORES_REQUIRED,
      charge: this.charge,
      charging: this.insertedCount >= CORES_REQUIRED,
      present: this.present,
      needed: this.needed,
      prompt: this.prompt,
      holdProgress: hold ? Math.min(hold.timer / duration, 1) : 0,
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
