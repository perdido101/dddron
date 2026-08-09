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
  KNOCKDOWN_RECOVERY,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PRACTICE_MIN_PLAYERS,
  PROP_WASH_RADIUS,
  RECONNECT_WINDOW,
  ROUNDS_PER_MATCH_MIN,
  RUNNER_COLORWAYS,
  SCORE_DRONE_ELIM,
  SCORE_DRONE_WIPE,
  SCORE_EMP_FIRED,
  SCORE_RUNNER_SURVIVE,
  SWAT_RANGE,
  makeRoomCode,
  roundsPerMatch,
  ROUND_END_AUTO_ADVANCE,
  ROUND_TIME,
  RUNNER_SPAWN,
  SERVER_BROADCAST_HZ,
  empChargeMinPresent,
} from '@shared/constants';
import { Fuse, type Vec3 } from '@shared/fuse';

import { RoundMetrics } from './roundMetrics';
import { CoreEntity, GameState, PlayerState } from './schema';
import { telemetry } from './telemetry';

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
  /** Core-loop pacing numbers for the round in progress (handoff 02, session 3). */
  private metrics = new RoundMetrics();
  private nextBotId = 1;
  private knockdownTimer = 0;
  private intermission = 0;

  override onCreate(options: { code?: string } = {}): void {
    this.state = new GameState();
    // The code arrives as a create option and the room is filtered by it, so
    // joining by code is ordinary Colyseus matchmaking rather than a lookup.
    this.state.code = (options.code ?? makeRoomCode()).toUpperCase();
    void this.setMetadata({ code: this.state.code });
    // The cap is enforced here, not just counted: creation fails cleanly and
    // the client's lobby shows the error instead of a hung room.
    if (!telemetry.roomOpened()) {
      throw new Error('server is full — try again in a few minutes');
    }
    console.log(`[room ${this.roomId}] created, code ${this.state.code}`);
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

    // Ping echo: the client stamps a time and we bounce it straight back, so
    // every player can read their own true RTT during a playtest. Costs one
    // tiny message and touches no state.
    this.onMessage('ping', (client, sent: number) => {
      client.send('pong', sent);
    });

    this.onMessage('interact', (client, held: boolean) => {
      if (held) this.interacting.add(client.sessionId);
      else this.interacting.delete(client.sessionId);
    });

    /** Practice mode is host-only. It drops the minimum to one player. */
    this.onMessage('practice', (client, on: boolean) => {
      if (client.sessionId !== this.state.host || this.state.phase !== 'lobby') return;
      this.state.practice = on === true;
    });

    /** Each player picks their own role; the host may override anyone's. */
    this.onMessage('role', (client, role: string) => {
      if (this.state.phase !== 'lobby') return;
      this.setRole(client.sessionId, role);
    });
    this.onMessage('assignRole', (client, payload: { sessionId: string; role: string }) => {
      if (client.sessionId !== this.state.host || this.state.phase !== 'lobby') return;
      this.setRole(payload?.sessionId, payload?.role);
    });

    /** Host sets how many bots fill the room. */
    this.onMessage('setBots', (client, count: number) => {
      if (client.sessionId !== this.state.host || this.state.phase !== 'lobby') return;
      this.setBotCount(Math.max(0, Math.min(Math.floor(count) || 0, MAX_PLAYERS - 1)));
    });

    /**
     * Bot bodies are simulated by the HOST's client and relayed here, so bots
     * use exactly the same physics as a human and the server stays free of a
     * movement simulation it is not supposed to own (sacred constraint 5).
     */
    this.onMessage('botMove', (client, payload: { id: string; x: number; y: number; z: number; yaw: number }) => {
      if (client.sessionId !== this.state.host) return;
      const bot = this.state.players.get(payload?.id ?? '');
      if (!bot?.bot) return;
      bot.x = payload.x;
      bot.y = payload.y;
      bot.z = payload.z;
      bot.yaw = payload.yaw;
    });
    this.onMessage('botInteract', (client, payload: { id: string; held: boolean }) => {
      if (client.sessionId !== this.state.host) return;
      const bot = this.state.players.get(payload?.id ?? '');
      if (!bot?.bot) return;
      if (payload.held) this.interacting.add(bot.sessionId);
      else this.interacting.delete(bot.sessionId);
    });

    /**
     * "The prop wash blew the core out of my hands."
     *
     * Prop wash is applied by each client to its own body, because movement is
     * client-authoritative — but the core it knocks loose is the server's, so
     * the client reports the shove and the server performs the drop. Range is
     * checked here: a client cannot drop a core it is nowhere near the drone
     * to have lost.
     */
    this.onMessage('shoved', (client) => {
      if (this.state.phase !== 'playing') return;
      const player = this.state.players.get(client.sessionId);
      const drone = this.dronePlayer();
      if (!player?.carrying || !drone) return;
      const reach = Math.hypot(player.x - drone.x, player.y - drone.y, player.z - drone.z);
      if (reach > PROP_WASH_RADIUS * WASH_RANGE_TOLERANCE) return;
      this.dropCoresOf(client.sessionId);
      player.carrying = false;
      player.coresDropped += 1;
      this.metrics.coreDropped('wash');
    });

    /**
     * A runner sabotaged a charge pad. Sabotage is a client-side hazard and
     * the server does not model it, so this is a count and nothing more — it
     * grants no advantage and cannot be used to change any state.
     */
    this.onMessage('sabotage', () => {
      if (this.state.phase === 'playing') this.metrics.sabotage();
    });

    this.onMessage('ready', (client, ready: boolean) => {
      const player = this.state.players.get(client.sessionId);
      if (player) player.ready = ready === true;
    });

    // Host-only start, and never below the minimum player count.
    this.onMessage('start', (client) => {
      if (this.state.phase !== 'lobby' && this.state.phase !== 'intermission') return;
      if (client.sessionId !== this.state.host) return;
      const humans = this.humanCount();
      const minimum = this.state.practice ? PRACTICE_MIN_PLAYERS : MIN_PLAYERS;
      if (humans < minimum) return;
      // A round with no drone is not a round. Practice with a single human
      // runner is the case this exists for, so a bot takes the seat.
      this.ensureExactlyOneDrone();
      this.beginMatchIfNeeded();
      this.beginRound();
    });

    /** Host may force who flies round 1; after that phase 9 rotates it. */
    this.onMessage('assignDrone', (client, sessionId: string) => {
      if (client.sessionId !== this.state.host) return;
      if (this.state.phase !== 'lobby') return;
      this.state.players.forEach((player) => {
        player.role = player.sessionId === sessionId ? 'drone' : 'runner';
      });
    });

    /**
     * A swat, a thrown prop or a fan: all of them knock the drone down, and
     * none of them kill it (sacred constraint 4 — the reward is time, never
     * victory). The client reports the hit; the server owns the consequence.
     */
    this.onMessage('knockdown', (client) => {
      if (this.state.phase !== 'playing' || this.state.droneKnocked) return;
      const attacker = this.state.players.get(client.sessionId);
      const drone = this.dronePlayer();
      if (!attacker || !drone || attacker.role !== 'runner' || !attacker.alive) return;
      // Range-check server-side so a client cannot swat from across the arena.
      const reach = Math.hypot(attacker.x - drone.x, attacker.y - drone.y, attacker.z - drone.z);
      if (reach > SWAT_RANGE * SWAT_RANGE_TOLERANCE) return;
      this.knockdownTimer = KNOCKDOWN_RECOVERY;
      this.state.droneKnocked = true;
      this.metrics.knockdown();
      this.broadcast('knockdown', { by: client.sessionId });
    });

    // Dev console. Registered only when the operator opted in, so a public
    // server has no handler at all rather than a handler with a check in it.
    this.state.devEnabled = DEV_TOOLS;
    if (DEV_TOOLS) this.registerDevCommands();

    this.setSimulationInterval((deltaMs) => this.tick(deltaMs / 1000), 1000 / SERVER_BROADCAST_HZ);
  }

  override onDispose(): void {
    telemetry.roomClosed();
    console.log(`[room ${this.roomId}] disposed (code ${this.state.code})`);
  }

  override onJoin(client: Client, options: { nickname?: string } = {}): void {
    const player = new PlayerState();
    player.sessionId = client.sessionId;
    player.nickname = (options.nickname ?? '').slice(0, NICKNAME_MAX) || 'runner';
    // Basic role assignment for phase 5: first in flies, everyone else runs.
    // Phase 6 replaces this with the lobby, and phase 9 with rotation.
    player.role = this.hasDrone() ? 'runner' : 'drone';
    player.colorway = this.freeColorway();
    this.placeAtSpawn(player);
    this.state.players.set(client.sessionId, player);
    console.log(`[room ${this.roomId}] join ${client.sessionId} "${player.nickname}" as ${player.role}`);
    // First one in hosts; if they leave, the next player inherits it.
    if (!this.state.host || !this.state.players.has(this.state.host)) {
      this.state.host = client.sessionId;
    }
  }

  override async onLeave(client: Client, consented: boolean): Promise<void> {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    console.log(`[room ${this.roomId}] leave ${client.sessionId} (${consented ? 'consented' : 'dropped'})`);

    // The drone leaving mid-round ends it immediately and unscored: there is no
    // game without a drone, and handing the role to someone mid-flight would be
    // worse than stopping (brief, phase 5).
    if (player.role === 'drone' && this.state.phase === 'playing') {
      this.endRound('aborted', 'the drone player left');
    }

    if (consented) {
      this.state.players.delete(client.sessionId);
      this.rehost();
      return;
    }

    try {
      await this.allowReconnection(client, RECONNECT_WINDOW);
    } catch {
      this.state.players.delete(client.sessionId);
      this.rehost();
    }
  }

  /**
   * Test tooling (handoff 02, session 4).
   *
   * Everything here manipulates state the server owns, because a client-side
   * cheat panel would prove nothing about the server's behaviour — the point
   * of forcing a detonation is to watch the real detonation path run.
   */
  private registerDevCommands(): void {
    this.onMessage('dev', (client, payload: { action?: string; value?: number | string }) => {
      const action = payload?.action;
      const value = payload?.value;
      switch (action) {
        case 'battery':
          this.fuse.charge = clamp01(Number(value));
          this.state.battery = this.fuse.charge;
          break;

        case 'detonate':
          // SACRED CONSTRAINT 2: there is no manual trigger, not even here.
          // This empties the battery and lets the ordinary step detonate, so
          // the path under test is the real one rather than a shortcut.
          this.fuse.charge = 0;
          this.state.battery = 0;
          break;

        case 'cycle': {
          const cycle = Math.max(0, Math.min(Math.floor(Number(value)) || 0, DEV_MAX_CYCLE));
          this.fuse.cycle = cycle;
          this.fuse.charge = 1;
          this.fuse.state = 'armed';
          this.state.cycle = cycle;
          break;
        }

        case 'cores':
          // Put every core back on its pad, so the contest rule can be
          // re-tested without replaying the walk that emptied the pads.
          this.state.cores.forEach((core, index) => {
            const pad = CHARGE_PAD_POSITIONS[index % CHARGE_PAD_POSITIONS.length]!;
            core.state = 'onPad';
            core.carrier = '';
            core.pad = index % CHARGE_PAD_POSITIONS.length;
            core.x = pad[0];
            core.y = CORE_RADIUS;
            core.z = pad[1];
          });
          this.state.players.forEach((player) => { player.carrying = false; });
          this.holds.clear();
          this.state.coresInserted = 0;
          this.state.empCharge = 0;
          break;

        case 'insertAll':
          this.state.cores.forEach((core) => {
            core.state = 'inserted';
            core.carrier = '';
            core.pad = -1;
          });
          this.state.players.forEach((player) => { player.carrying = false; });
          this.state.coresInserted = this.insertedCount();
          break;

        case 'win':
          if (this.state.phase !== 'playing') break;
          this.endRound(value === 'drone' ? 'drone' : 'runners', 'dev console');
          break;

        case 'revive':
          this.state.players.forEach((player) => { player.alive = true; });
          break;

        default:
          break;
      }
      console.log(`[room ${this.roomId}] dev ${action ?? '?'} ${String(value ?? '')} by ${client.sessionId}`);
    });
  }

  private setRole(sessionId: string | undefined, role: string | undefined): void {
    if (role !== 'drone' && role !== 'runner') return;
    const player = this.state.players.get(sessionId ?? '');
    if (!player) return;
    // Exactly one drone: taking the seat vacates it for whoever had it.
    if (role === 'drone') {
      this.state.players.forEach((other) => {
        if (other !== player && other.role === 'drone') other.role = 'runner';
      });
    }
    player.role = role;
  }

  /**
   * Nobody flying is not a valid round, so somebody has to be drafted.
   *
   * A bot is drafted first when one is available. Picking "runner" in the
   * lobby is an explicit choice, and putting that player straight back into
   * the pilot seat would make the role picker a lie — practising as a runner
   * against a bot drone is exactly what bots are for. With no bots in the
   * room there is nobody else to ask, so a human takes it.
   */
  private ensureExactlyOneDrone(): void {
    let drones = 0;
    this.state.players.forEach((player) => {
      if (player.role === 'drone') drones += 1;
    });
    if (drones === 1) return;

    let chosen: PlayerState | undefined;
    this.state.players.forEach((player) => {
      if (!chosen && player.bot) chosen = player;
    });
    if (!chosen) {
      this.state.players.forEach((player) => {
        if (!chosen) chosen = player;
      });
    }
    if (!chosen) return;
    this.state.players.forEach((player) => {
      player.role = player === chosen ? 'drone' : 'runner';
    });
  }

  /**
   * Lowest colourway nobody is using. MAX_PLAYERS is 8 and there are 6
   * colourways, so the last two players do share — unavoidable, and better
   * than a hash that can collide with two players in the room.
   */
  private freeColorway(): number {
    const taken = new Set<number>();
    this.state.players.forEach((player) => taken.add(player.colorway));
    for (let i = 0; i < RUNNER_COLORWAYS.length; i += 1) {
      if (!taken.has(i)) return i;
    }
    return this.state.players.size % RUNNER_COLORWAYS.length;
  }

  private humanCount(): number {
    let count = 0;
    this.state.players.forEach((player) => {
      if (!player.bot) count += 1;
    });
    return count;
  }

  /** Add or remove filler bots so the room holds exactly `count` of them. */
  private setBotCount(count: number): void {
    const existing: PlayerState[] = [];
    this.state.players.forEach((player) => {
      if (player.bot) existing.push(player);
    });

    for (let i = existing.length; i < count; i += 1) {
      const bot = new PlayerState();
      bot.sessionId = `bot:${this.nextBotId++}`;
      bot.nickname = `[BOT] ${BOT_NAMES[i % BOT_NAMES.length]}`;
      bot.role = 'runner';
      bot.bot = true;
      bot.ready = true;
      bot.colorway = this.freeColorway();
      this.placeAtSpawn(bot);
      this.state.players.set(bot.sessionId, bot);
    }
    for (let i = count; i < existing.length; i += 1) {
      const bot = existing[i];
      if (bot) this.state.players.delete(bot.sessionId);
    }
    this.state.botCount = count;
  }

  /** Host left: hand it to whoever is still here, so the room is not stuck. */
  private rehost(): void {
    if (this.state.players.has(this.state.host)) return;
    let next = '';
    this.state.players.forEach((player) => {
      // Never hand the room to a bot: bots are simulated BY the host.
      if (!next && !player.bot) next = player.sessionId;
    });
    this.state.host = next;
  }

  // -------------------------------------------------------------- simulation

  private tick(dt: number): void {
    if (this.state.phase === 'intermission') {
      this.intermission -= dt;
      if (this.intermission <= 0) this.beginRound();
      return;
    }
    if (this.state.phase !== 'playing') return;

    if (this.knockdownTimer > 0) {
      this.knockdownTimer -= dt;
      if (this.knockdownTimer <= 0) this.state.droneKnocked = false;
    }

    this.roundClock += dt;
    this.state.roundRemaining = Math.max(0, ROUND_TIME - this.roundClock);

    this.stepFuse(dt);
    this.stepObjective(dt);
    this.stepMetrics(dt);
    this.checkWinConditions();
  }

  /** Accounting only: this reads state, and changes none of it. */
  private stepMetrics(dt: number): void {
    const coreStates: string[] = [];
    this.state.cores.forEach((core) => coreStates.push(core.state));
    const charged = this.state.coresInserted >= CORES_REQUIRED;
    this.metrics.step(
      dt,
      coreStates,
      this.availablePads().length,
      this.fuse.stranded,
      this.fuse.state,
      charged && this.state.empPresent >= this.state.empNeeded,
      charged && this.state.empPresent < this.state.empNeeded && this.state.empCharge > 0,
    );
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
        if (player.carrying) this.metrics.coreDropped('blast');
        player.carrying = false;
        this.dropCoresOf(player.sessionId);
        victims.push(player.sessionId);
      }
    });
    this.metrics.detonation(victims.length);

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
        // Re-check at the moment of completion: if another runner's hold on
        // this core finished first (same tick or an earlier one), the core is
        // already carried, and granting it again would silently steal it while
        // leaving the first carrier flagged as still holding it.
        if (core.state === 'onPad' || core.state === 'loose') {
          core.state = 'carried';
          core.carrier = sessionId;
          core.pad = -1;
          player.carrying = true;
        }
      } else if (core.state === 'carried' && core.carrier === sessionId) {
        core.state = 'inserted';
        core.carrier = '';
        core.pad = -1;
        player.carrying = false;
        this.state.coresInserted = this.insertedCount();
        this.metrics.coreInserted(this.state.coresInserted);
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

  /**
   * Match length is max(5, playerCount), and the drone rotates so everyone
   * flies once before anyone flies twice (brief, phase 9).
   */
  private beginMatchIfNeeded(): void {
    if (this.state.totalRounds > 0) return;
    this.state.totalRounds = roundsPerMatch(Math.max(this.state.players.size, ROUNDS_PER_MATCH_MIN));
    this.state.round = 0;
    this.state.players.forEach((player) => {
      player.score = 0;
      player.flown = 0;
      player.survived = 0;
      player.coresDropped = 0;
      player.fanLaunches = 0;
    });
  }

  private beginRound(): void {
    // Practice keeps whatever roles were picked; rotation is a match rule.
    if (!this.state.practice) this.rotateDrone();
    else this.ensureExactlyOneDrone();
    this.resetRound();
    this.state.round += 1;
    this.state.phase = 'playing';
  }

  /**
   * Fewest flights so far takes the drone; ties break on join order.
   *
   * Bots are skipped: the rotation exists so every *person* flies once before
   * anyone flies twice, and a bot in the queue would burn a turn nobody had.
   */
  private rotateDrone(): void {
    let pick: PlayerState | undefined;
    this.state.players.forEach((player) => {
      if (player.bot) return;
      if (!pick || player.flown < pick.flown) pick = player;
    });
    if (!pick) return;
    this.state.players.forEach((player) => {
      player.role = player === pick ? 'drone' : 'runner';
    });
    pick.flown += 1;
  }

  private resetRound(): void {
    this.roundClock = 0;
    this.metrics = new RoundMetrics();
    this.knockdownTimer = 0;
    this.state.droneKnocked = false;
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
    this.state.winner = winner;
    this.state.cause = cause;
    // Practice results never touch the match score (handoff 02, session 4).
    if (winner !== 'aborted' && !this.state.practice) this.award(winner);

    const matchOver = this.state.round >= this.state.totalRounds && this.state.totalRounds > 0;
    this.state.phase = matchOver ? 'ended' : 'intermission';
    this.intermission = ROUND_END_AUTO_ADVANCE;
    this.state.droneKnocked = false;

    let bots = 0;
    this.state.players.forEach((player) => {
      if (player.bot) bots += 1;
    });
    const summary = this.metrics.summarise(winner, cause, this.state.players.size, bots);
    telemetry.recordRound({
      winner,
      cause,
      seconds: this.roundClock,
      players: this.state.players.size,
    });
    telemetry.recordSummary(summary);

    this.broadcast('roundEnd', { winner, cause, matchOver, round: this.state.round, summary });
  }

  /** Scoring, straight from section 4 of the brief. */
  private award(winner: string): void {
    const drone = this.dronePlayer();
    const runners: PlayerState[] = [];
    this.state.players.forEach((player) => {
      if (player.role === 'runner') runners.push(player);
    });

    if (winner === 'runners') {
      for (const runner of runners) {
        if (runner.alive) runner.score += SCORE_EMP_FIRED + SCORE_RUNNER_SURVIVE;
      }
    } else if (winner === 'drone' && drone) {
      const eliminated = runners.filter((runner) => !runner.alive).length;
      drone.score += eliminated * SCORE_DRONE_ELIM;
      if (eliminated === runners.length && runners.length > 0) drone.score += SCORE_DRONE_WIPE;
      for (const runner of runners) {
        if (runner.alive) {
          runner.score += SCORE_RUNNER_SURVIVE;
          runner.survived += 1;
        }
      }
    }
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
const BOT_NAMES = ['Pip', 'Bod', 'Nix', 'Tam', 'Gus', 'Wex', 'Ozz'];
/** Slack on the server-side swat range check, to forgive 20 Hz position lag. */
const SWAT_RANGE_TOLERANCE = 1.6;
/**
 * Same idea for the prop-wash drop: the shove is felt on the shoved player's
 * own client, so by the time the report lands both bodies have moved on. The
 * check exists to reject nonsense, not to re-adjudicate the physics.
 */
const WASH_RANGE_TOLERANCE = 2.0;
/**
 * Dev console, off unless the operator sets BUZZKILL_DEV=1. The deployed
 * playtest server runs without it, so a curious player poking at the socket
 * finds no handler to call.
 */
const DEV_TOOLS = process.env.BUZZKILL_DEV === '1';
/** Cycle is a uint8 in the schema and the fuse shortens each time. */
const DEV_MAX_CYCLE = 20;

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function padUnder(x: number, z: number): number {
  for (let i = 0; i < CHARGE_PAD_POSITIONS.length; i += 1) {
    const pad = CHARGE_PAD_POSITIONS[i]!;
    if (Math.hypot(x - pad[0], z - pad[1]) <= CORE_ON_PAD_RADIUS) return i;
  }
  return -1;
}
