import { Room } from 'colyseus';
import type { Client } from 'colyseus';

import {
  CHARGE_PAD_POSITIONS,
  CORES_REQUIRED,
  CORE_INSERT_HOLD,
  CORE_ON_PAD_RADIUS,
  CORE_PICKUP_HOLD,
  CORE_PICKUP_RADIUS,
  CORE_RADIUS,
  DETONATION_RADIUS,
  DRONE_SPAWN,
  EMP_CHARGE_TIME,
  EMP_DRAIN_ON_ABANDON,
  EMP_STATION_POSITION,
  EMP_STATION_RADIUS,
  MAX_PLAYERS,
  RECONNECT_WINDOW,
  ROUND_TIME,
  RUNNER_SPAWN,
  SERVER_BROADCAST_HZ,
  empChargeMinPresent,
} from '@shared/constants';
import { Fuse, type Vec3 } from '@shared/fuse';

import { CoreEntity, GameState, PlayerState } from './schema';

/** What a client is allowed to tell the server about itself. */
interface MoveMessage {
  x: number;
  y: number;
  z: number;
  yaw: number;
  seq: number;
}

/**
 * The authoritative room.
 *
 * The authority split is sacred constraint 5, and it cuts in an unusual place:
 * runner movement is CLIENT-authoritative and simply relayed, because this is a
 * friends game and rollback would cost more than it buys. The server owns only
 * what cheating would actually ruin — battery, cores, EMP progress, detonation,
 * elimination, the round timer and the win condition.
 */
export class GameRoom extends Room<GameState> {
  override maxClients = MAX_PLAYERS;

  private readonly fuse = new Fuse();
  /** Server-side core bookkeeping, mirrored into the schema each tick. */
  private readonly holds = new Map<string, { kind: 'pickup' | 'insert'; core: number; timer: number }>();
  private readonly interacting = new Set<string>();
  private roundClock = 0;

  override onCreate(): void {
    this.state = new GameState();
    this.resetRound();

    this.onMessage('move', (client, message: MoveMessage) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      // Position is taken on trust: it is the client's own body. Only the
      // sequence number is checked, so a late packet cannot rewind someone.
      if (typeof message.seq === 'number' && message.seq <= player.seq) return;
      player.seq = message.seq ?? 0;
      player.x = message.x;
      player.y = message.y;
      player.z = message.z;
      player.yaw = message.yaw;
    });

    this.onMessage('interact', (client, held: boolean) => {
      if (held) this.interacting.add(client.sessionId);
      else this.interacting.delete(client.sessionId);
    });

    this.onMessage('start', () => {
      if (this.state.phase === 'lobby') this.beginRound();
    });

    this.setSimulationInterval((deltaMs) => this.tick(deltaMs / 1000), 1000 / SERVER_BROADCAST_HZ);
  }

  override onJoin(client: Client, options: { nickname?: string } = {}): void {
    const player = new PlayerState();
    player.sessionId = client.sessionId;
    player.nickname = (options.nickname ?? '').slice(0, NICKNAME_MAX) || 'runner';
    // Basic role assignment for phase 5: first in flies, everyone else runs.
    // Phase 6 replaces this with the lobby, and phase 9 with rotation.
    player.role = this.hasDrone() ? 'runner' : 'drone';
    this.placeAtSpawn(player);
    this.state.players.set(client.sessionId, player);
  }

  override async onLeave(client: Client, consented: boolean): Promise<void> {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    // The drone leaving mid-round ends it immediately and unscored: there is no
    // game without a drone, and handing the role to someone mid-flight would be
    // worse than stopping (brief, phase 5).
    if (player.role === 'drone' && this.state.phase === 'playing') {
      this.endRound('aborted', 'the drone player left');
    }

    if (consented) {
      this.state.players.delete(client.sessionId);
      return;
    }

    try {
      await this.allowReconnection(client, RECONNECT_WINDOW);
    } catch {
      this.state.players.delete(client.sessionId);
    }
  }

  // -------------------------------------------------------------- simulation

  private tick(dt: number): void {
    if (this.state.phase !== 'playing') return;

    this.roundClock += dt;
    this.state.roundRemaining = Math.max(0, ROUND_TIME - this.roundClock);

    this.stepFuse(dt);
    this.stepObjective(dt);
    this.checkWinConditions();
  }

  /** Battery drain, detonation and the dock/recharge cycle. */
  private stepFuse(dt: number): void {
    const drone = this.dronePlayer();
    const position: Vec3 = drone
      ? { x: drone.x, y: drone.y, z: drone.z }
      : { x: DRONE_SPAWN[0], y: DRONE_SPAWN[1], z: DRONE_SPAWN[2] };

    // The client reports the drone's altitude, so "has it landed" is derived
    // from that rather than from a physics body the server does not run.
    const settled = position.y < SETTLED_ALTITUDE;
    const detonation = this.fuse.step(dt, position, settled, this.availablePads());

    this.state.battery = this.fuse.charge;
    this.state.cycle = this.fuse.cycle;
    this.state.fuseState = this.fuse.state;

    if (!detonation) return;

    // The blast is computed here and nowhere else. Clients render the confetti
    // and the elimination they are told about; they never decide either.
    const victims: string[] = [];
    this.state.players.forEach((player) => {
      if (player.role !== 'runner' || !player.alive) return;
      const d = Math.sqrt(
        (player.x - detonation.position.x) ** 2 +
        (player.y - detonation.position.y) ** 2 +
        (player.z - detonation.position.z) ** 2,
      );
      if (d <= DETONATION_RADIUS) {
        player.alive = false;
        player.carrying = false;
        this.dropCoresOf(player.sessionId);
        victims.push(player.sessionId);
      }
    });

    this.broadcast('detonation', {
      x: detonation.position.x,
      y: detonation.position.y,
      z: detonation.position.z,
      cycle: detonation.cycle,
      victims,
    });
  }

  /** Core pickup, carry, insert and the EMP charge phase. */
  private stepObjective(dt: number): void {
    for (const [sessionId, hold] of this.holds) {
      const player = this.state.players.get(sessionId);
      const core = this.state.cores[hold.core];
      if (!player || !core || !player.alive || !this.interacting.has(sessionId)) {
        this.holds.delete(sessionId);
        continue;
      }

      hold.timer += dt;
      const duration = hold.kind === 'insert' ? CORE_INSERT_HOLD : CORE_PICKUP_HOLD;
      if (hold.timer < duration) continue;

      if (hold.kind === 'pickup') {
        core.state = 'carried';
        core.carrier = sessionId;
        core.pad = -1;
        player.carrying = true;
      } else {
        core.state = 'inserted';
        core.carrier = '';
        core.pad = -1;
        player.carrying = false;
        this.state.coresInserted = this.insertedCount();
      }
      this.holds.delete(sessionId);
    }

    // Start any hold that is newly valid.
    this.interacting.forEach((sessionId) => {
      if (this.holds.has(sessionId)) return;
      const player = this.state.players.get(sessionId);
      if (!player || player.role !== 'runner' || !player.alive) return;

      const carried = this.carriedIndex(sessionId);
      if (carried >= 0) {
        if (this.inStation(player)) this.holds.set(sessionId, { kind: 'insert', core: carried, timer: 0 });
        return;
      }
      const nearby = this.nearestFreeCore(player);
      if (nearby >= 0) this.holds.set(sessionId, { kind: 'pickup', core: nearby, timer: 0 });
    });

    // Carried cores ride along with their carrier so every client sees them.
    this.state.cores.forEach((core) => {
      if (core.state !== 'carried') return;
      const carrier = this.state.players.get(core.carrier);
      if (!carrier) return;
      core.x = carrier.x;
      core.y = carrier.y + CORE_CARRY_OFFSET;
      core.z = carrier.z;
    });

    this.stepEmp(dt);
  }

  private stepEmp(dt: number): void {
    const alive = this.aliveRunners();
    this.state.empNeeded = empChargeMinPresent(alive.length);
    this.state.empPresent = alive.filter((player) => this.inStation(player)).length;

    if (this.state.coresInserted < CORES_REQUIRED) {
      this.state.empCharge = 0;
      return;
    }

    const rate = 1 / EMP_CHARGE_TIME;
    if (this.state.empPresent >= this.state.empNeeded) {
      this.state.empCharge = Math.min(1, this.state.empCharge + rate * dt);
    } else {
      this.state.empCharge = Math.max(0, this.state.empCharge - rate * EMP_DRAIN_ON_ABANDON * dt);
    }
  }

  private checkWinConditions(): void {
    if (this.state.empCharge >= 1) {
      this.broadcast('emp');
      this.endRound('runners', 'EMP fired');
      return;
    }
    if (this.aliveRunners().length === 0 && this.runnerCount() > 0) {
      this.endRound('drone', 'all runners eliminated');
      return;
    }
    if (this.state.roundRemaining <= 0) {
      this.endRound('drone', 'time expired');
    }
  }

  // ------------------------------------------------------------------ rounds

  private beginRound(): void {
    this.resetRound();
    this.state.phase = 'playing';
  }

  private resetRound(): void {
    this.roundClock = 0;
    this.holds.clear();
    this.interacting.clear();
    Object.assign(this.fuse, new Fuse());

    this.state.winner = '';
    this.state.cause = '';
    this.state.battery = 1;
    this.state.cycle = 0;
    this.state.fuseState = 'armed';
    this.state.coresInserted = 0;
    this.state.empCharge = 0;
    this.state.roundRemaining = ROUND_TIME;

    this.state.cores.clear();
    for (let i = 0; i < CORES_REQUIRED; i += 1) {
      const pad = CHARGE_PAD_POSITIONS[i % CHARGE_PAD_POSITIONS.length]!;
      const core = new CoreEntity();
      core.x = pad[0];
      core.y = CORE_RADIUS;
      core.z = pad[1];
      core.state = 'onPad';
      core.pad = i % CHARGE_PAD_POSITIONS.length;
      this.state.cores.push(core);
    }

    this.state.players.forEach((player) => {
      player.alive = true;
      player.carrying = false;
      this.placeAtSpawn(player);
    });
  }

  private endRound(winner: string, cause: string): void {
    this.state.phase = 'ended';
    this.state.winner = winner;
    this.state.cause = cause;
    this.broadcast('roundEnd', { winner, cause });
  }

  // ------------------------------------------------------------------ helpers

  private placeAtSpawn(player: PlayerState): void {
    const spawn = player.role === 'drone' ? DRONE_SPAWN : RUNNER_SPAWN;
    player.x = spawn[0];
    player.y = spawn[1];
    player.z = spawn[2];
  }

  private hasDrone(): boolean {
    return this.dronePlayer() !== undefined;
  }

  private dronePlayer(): PlayerState | undefined {
    let found: PlayerState | undefined;
    this.state.players.forEach((player) => {
      if (player.role === 'drone') found = player;
    });
    return found;
  }

  private aliveRunners(): PlayerState[] {
    const list: PlayerState[] = [];
    this.state.players.forEach((player) => {
      if (player.role === 'runner' && player.alive) list.push(player);
    });
    return list;
  }

  private runnerCount(): number {
    let count = 0;
    this.state.players.forEach((player) => {
      if (player.role === 'runner') count += 1;
    });
    return count;
  }

  private insertedCount(): number {
    let count = 0;
    this.state.cores.forEach((core) => {
      if (core.state === 'inserted') count += 1;
    });
    return count;
  }

  /** The contest rule: a core sitting on a pad denies that pad to the drone. */
  private availablePads(): readonly (readonly [number, number])[] {
    const blocked = new Set<number>();
    this.state.cores.forEach((core) => {
      if ((core.state === 'onPad' || core.state === 'loose') && core.pad >= 0) blocked.add(core.pad);
    });
    return CHARGE_PAD_POSITIONS.filter((_, index) => !blocked.has(index));
  }

  private inStation(player: PlayerState): boolean {
    return Math.hypot(player.x - EMP_STATION_POSITION[0], player.z - EMP_STATION_POSITION[1])
      <= EMP_STATION_RADIUS;
  }

  private carriedIndex(sessionId: string): number {
    let index = -1;
    this.state.cores.forEach((core, i) => {
      if (core.state === 'carried' && core.carrier === sessionId) index = i;
    });
    return index;
  }

  private nearestFreeCore(player: PlayerState): number {
    let best = -1;
    let bestDistance = CORE_PICKUP_RADIUS;
    this.state.cores.forEach((core, index) => {
      if (core.state !== 'onPad' && core.state !== 'loose') return;
      const distance = Math.hypot(core.x - player.x, core.z - player.z);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return best;
  }

  /** Anything an eliminated runner was carrying falls where they stood. */
  private dropCoresOf(sessionId: string): void {
    this.state.cores.forEach((core) => {
      if (core.state !== 'carried' || core.carrier !== sessionId) return;
      core.state = 'loose';
      core.y = CORE_RADIUS;
      core.carrier = '';
      core.pad = padUnder(core.x, core.z);
    });
    this.holds.delete(sessionId);
  }
}

/** Height a carried core rides above the carrier's reported origin. */
const CORE_CARRY_OFFSET = 1.6;
/** Below this altitude a detonated drone counts as having hit the floor. */
const SETTLED_ALTITUDE = 1.0;
const NICKNAME_MAX = 16;

function padUnder(x: number, z: number): number {
  for (let i = 0; i < CHARGE_PAD_POSITIONS.length; i += 1) {
    const pad = CHARGE_PAD_POSITIONS[i]!;
    if (Math.hypot(x - pad[0], z - pad[1]) <= CORE_ON_PAD_RADIUS) return i;
  }
  return -1;
}
