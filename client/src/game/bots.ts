import * as THREE from 'three';

import {
  CARRY_SPEED,
  CHARGE_PAD_POSITIONS,
  CORE_PICKUP_RADIUS,
  EMP_STATION_POSITION,
  EMP_STATION_RADIUS,
  RUNNER_SPAWN,
  RUN_SPEED,
} from '@shared/constants';

import type { NetSnapshot } from '../net/connection';

/** One bot body the host is simulating on everyone else's behalf. */
interface BotBody {
  readonly id: string;
  readonly position: THREE.Vector3;
  yaw: number;
  interacting: boolean;
}

export interface BotCommand {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly interacting: boolean;
}

/**
 * Filler bots, simulated by the host client.
 *
 * Their job is to occupy space so detonation clustering and pad contention can
 * be tested with fewer than five humans — not to play well. Deliberately the
 * simplest thing that completes the core loop: walk to the nearest free core,
 * carry it to the station, insert, then stand in the charge zone. They do not
 * dodge, do not use hazards, and do not react to the drone at all.
 *
 * The host owns their bodies and relays positions, which keeps movement
 * client-authoritative exactly as it is for humans (sacred constraint 5) —
 * the server never simulates a body.
 */
export class Bots {
  private readonly bodies = new Map<string, BotBody>();
  private readonly station = new THREE.Vector3(EMP_STATION_POSITION[0], 0, EMP_STATION_POSITION[1]);

  /**
   * @param snapshot current server state, which names the bots and holds cores.
   * @returns one command per bot for the host to relay.
   */
  update(dt: number, snapshot: NetSnapshot): BotCommand[] {
    const commands: BotCommand[] = [];
    const live = new Set<string>();

    for (const player of snapshot.players) {
      if (!player.bot || player.role !== 'runner') continue;
      live.add(player.sessionId);

      let body = this.bodies.get(player.sessionId);
      if (!body) {
        // Seed from where the server already put them. It spreads runners on
        // an arc at spawn, and inventing our own start here would make every
        // bot visibly jump on its first relayed frame.
        body = {
          id: player.sessionId,
          position: new THREE.Vector3(player.x, player.y, player.z),
          yaw: player.yaw,
          interacting: false,
        };
        this.bodies.set(player.sessionId, body);
      }

      if (!player.alive) {
        body.interacting = false;
        commands.push(toCommand(body));
        continue;
      }

      const target = this.pickTarget(body, snapshot, player.carrying);
      this.steer(dt, body, target.point, player.carrying ? CARRY_SPEED : RUN_SPEED);
      body.interacting = target.interact;
      commands.push(toCommand(body));
    }

    // Forget bodies whose bot left the room.
    for (const id of [...this.bodies.keys()]) {
      if (!live.has(id)) this.bodies.delete(id);
    }
    return commands;
  }

  /**
   * Carrying a core means the station; otherwise the nearest free core. With
   * everything delivered they stand in the zone, which is what the EMP charge
   * needs bodies for.
   */
  private pickTarget(
    body: BotBody,
    snapshot: NetSnapshot,
    carrying: boolean,
  ): { point: THREE.Vector3; interact: boolean } {
    if (carrying) {
      const atStation = flatDistance(body.position, this.station) <= EMP_STATION_RADIUS * STATION_INSET;
      // Standing still is required for the insert hold, so stop before holding.
      return { point: atStation ? body.position : this.station, interact: atStation };
    }

    let best: THREE.Vector3 | null = null;
    let bestDistance = Infinity;
    for (const core of snapshot.cores) {
      if (core.state !== 'onPad' && core.state !== 'loose') continue;
      TARGET.set(core.x, 0, core.z);
      const distance = flatDistance(body.position, TARGET);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = TARGET.clone();
      }
    }

    if (!best) {
      // Nothing left to fetch: hold the charge zone so the EMP can fill.
      const atStation = flatDistance(body.position, this.station) <= EMP_STATION_RADIUS * STATION_INSET;
      return { point: atStation ? body.position : this.station, interact: false };
    }
    return { point: best, interact: bestDistance <= CORE_PICKUP_RADIUS * PICKUP_INSET };
  }

  /** Straight-line steering. No pathfinding — they will bump into pillars. */
  private steer(dt: number, body: BotBody, target: THREE.Vector3, speed: number): void {
    const dx = target.x - body.position.x;
    const dz = target.z - body.position.z;
    const distance = Math.hypot(dx, dz);
    if (distance < ARRIVE_EPSILON) return;

    const step = Math.min(speed * dt, distance);
    body.position.x += (dx / distance) * step;
    body.position.z += (dz / distance) * step;
    body.position.y = RUNNER_SPAWN[1] - BOT_GROUND_DROP;
    body.yaw = Math.atan2(-dx, -dz);
  }

  /**
   * Forget every body, e.g. at the start of a round.
   *
   * Dropping them rather than repositioning them means the next update reseeds
   * from the server's fresh spawn placement, so there is one authority on
   * where a round starts instead of two that can disagree.
   */
  reset(): void {
    this.bodies.clear();
  }

  get count(): number {
    return this.bodies.size;
  }
}

function toCommand(body: BotBody): BotCommand {
  return {
    id: body.id,
    x: body.position.x,
    y: body.position.y,
    z: body.position.z,
    yaw: body.yaw,
    interacting: body.interacting,
  };
}

function flatDistance(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

const TARGET = new THREE.Vector3();
/** Stop comfortably inside a zone rather than on its exact edge. */
const STATION_INSET = 0.55;
const PICKUP_INSET = 0.7;
const ARRIVE_EPSILON = 0.05;
/** Bots walk at ground height; they never jump or fall. */
const BOT_GROUND_DROP = 1.1;

/** Pad positions, exposed so a caller can seed bots near the objective. */
export const BOT_PAD_TARGETS = CHARGE_PAD_POSITIONS;
