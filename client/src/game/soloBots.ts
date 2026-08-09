import * as THREE from 'three';

import {
  CORE_PICKUP_RADIUS,
  EMP_STATION_POSITION,
  EMP_STATION_RADIUS,
  RUNNER_SPAWN,
} from '@shared/constants';

import type { Physics } from '../engine/physics';
import type { Objective } from './objective';
import { Runner } from './runner';

/**
 * Bot runners for offline play.
 *
 * Online, bots are relayed player records simulated by the host. Offline there
 * is no server to hold them, so these are real Runner instances: same
 * controller, same collider, same animated body, same objective. That costs a
 * few rigid bodies and buys the thing that actually matters — the solo build
 * plays the real game rather than a diorama of it, so the EMP needs bodies in
 * the zone and cores genuinely get carried.
 *
 * The brain is deliberately the same shape as the networked one: walk to the
 * nearest free core, carry it to the station, insert, then stand in the zone.
 * No dodging, no hazards, no reaction to the drone.
 */
export class SoloBots {
  readonly runners: Runner[] = [];
  private readonly station = new THREE.Vector3(EMP_STATION_POSITION[0], 0, EMP_STATION_POSITION[1]);
  private readonly move = new THREE.Vector2();
  /** Seconds each bot has been down, for the offline respawn. */
  private readonly deadFor: number[] = [];

  constructor(
    private readonly physics: Physics,
    private readonly scene: THREE.Scene,
  ) {}

  /**
   * Grow or shrink to `count` bots.
   *
   * Bodies are never destroyed, only parked out of play: Rapier colliders are
   * awkward to remove mid-session and a party game's bot count moves by one at
   * a time, so the pool is reused instead.
   */
  setCount(count: number, onCreate: (runner: Runner) => void): void {
    while (this.runners.length < count) {
      const bot = new Runner(this.physics, this.scene);
      const index = this.runners.length;
      // Same arc the server spawns runners on, so solo and online look alike.
      const step = Math.ceil((index + 1) / 2) * ((index + 1) % 2 === 1 ? -1 : 1);
      const angle = step * SPAWN_ARC_STEP;
      bot.moveTo(
        RUNNER_SPAWN[0] + Math.sin(angle) * SPAWN_ARC_RADIUS,
        RUNNER_SPAWN[1],
        RUNNER_SPAWN[2] + (Math.cos(angle) - 1) * SPAWN_ARC_RADIUS,
      );
      // Colourways 1.. — the player keeps 0, so nobody shares their colour.
      bot.setColorway(index + 1);
      onCreate(bot);
      this.runners.push(bot);
    }
    for (let i = count; i < this.runners.length; i += 1) {
      this.runners[i]?.park();
    }
    for (let i = 0; i < Math.min(count, this.runners.length); i += 1) {
      this.runners[i]?.unpark();
    }
  }

  /** One fixed step of brain plus body, for every live bot. */
  fixedUpdate(dt: number, objective: Objective, count: number): void {
    for (let i = 0; i < Math.min(count, this.runners.length); i += 1) {
      const bot = this.runners[i];
      if (!bot) continue;
      if (!bot.alive) {
        // Offline there is no round loop to reset anyone, so a solo session
        // would quietly empty out one detonation at a time until the arena was
        // just the player again. They come back on their own instead.
        bot.interacting = false;
        this.deadFor[i] = (this.deadFor[i] ?? 0) + dt;
        if ((this.deadFor[i] ?? 0) >= SOLO_BOT_RESPAWN) {
          this.deadFor[i] = 0;
          bot.respawn();
        }
        bot.fixedUpdate(dt, ZERO, 0);
        continue;
      }
      this.deadFor[i] = 0;

      const target = this.pickTarget(bot, objective);
      const dx = target.point.x - bot.position.x;
      const dz = target.point.z - bot.position.z;
      const distance = Math.hypot(dx, dz);

      if (distance > ARRIVE_EPSILON && !target.stopped) {
        // Runner.fixedUpdate takes camera-relative input, so feed it a heading
        // pointing at the target and a constant "forward". The bot then uses
        // exactly the acceleration curves a player does.
        const heading = Math.atan2(-dx, -dz);
        this.move.set(0, 1);
        bot.fixedUpdate(dt, this.move, heading);
      } else {
        bot.fixedUpdate(dt, ZERO, 0);
      }
      bot.interacting = target.interact;
    }
  }

  /** Carrying means the station; otherwise the nearest core still in play. */
  private pickTarget(
    bot: Runner,
    objective: Objective,
  ): { point: THREE.Vector3; interact: boolean; stopped: boolean } {
    if (bot.carrying) {
      const arrived = flat(bot.position, this.station) <= EMP_STATION_RADIUS * STATION_INSET;
      // The insert hold cancels on movement, so stop before holding.
      return { point: this.station, interact: arrived, stopped: arrived };
    }

    let best: THREE.Vector3 | null = null;
    let bestDistance = Infinity;
    for (const core of objective.cores) {
      if (core.state !== 'onPad' && core.state !== 'loose') continue;
      const distance = flat(bot.position, core.position);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = core.position;
      }
    }

    if (!best) {
      // Everything delivered: hold the zone, which is what the charge needs.
      const arrived = flat(bot.position, this.station) <= EMP_STATION_RADIUS * STATION_INSET;
      return { point: this.station, interact: false, stopped: arrived };
    }
    const close = bestDistance <= CORE_PICKUP_RADIUS * PICKUP_INSET;
    return { point: best, interact: close, stopped: close };
  }

  /** Put every bot back on the start line. */
  respawn(count: number): void {
    for (let i = 0; i < Math.min(count, this.runners.length); i += 1) {
      this.runners[i]?.respawn();
    }
  }
}

function flat(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

const ZERO = new THREE.Vector2(0, 0);
/** Stop comfortably inside a zone rather than on its exact edge. */
const STATION_INSET = 0.55;
const PICKUP_INSET = 0.7;
const ARRIVE_EPSILON = 0.35;
/** Seconds a solo bot stays down before it gets back up. */
const SOLO_BOT_RESPAWN = 6.0;
/** Matches the server's runner spawn arc. */
const SPAWN_ARC_RADIUS = 3.2;
const SPAWN_ARC_STEP = 0.55;
