import { Client, type Room } from 'colyseus.js';

import { CLIENT_SEND_HZ, makeRoomCode } from '@shared/constants';

/** A snapshot of one networked player, as the renderer needs it. */
export interface RemotePlayer {
  sessionId: string;
  nickname: string;
  role: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  alive: boolean;
  carrying: boolean;
  ready: boolean;
  score: number;
  survived: number;
  coresDropped: number;
  fanLaunches: number;
}

/** Everything the client renders but does not own. */
export interface NetSnapshot {
  players: RemotePlayer[];
  cores: { x: number; y: number; z: number; state: string; carrier: string }[];
  battery: number;
  cycle: number;
  fuseState: string;
  coresInserted: number;
  empCharge: number;
  empPresent: number;
  empNeeded: number;
  roundRemaining: number;
  phase: string;
  winner: string;
  cause: string;
  code: string;
  host: string;
  round: number;
  totalRounds: number;
  droneKnocked: boolean;
}

export interface DetonationMessage {
  x: number;
  y: number;
  z: number;
  cycle: number;
  victims: string[];
}

/**
 * The client half of the authority split.
 *
 * Sacred constraint 5: this sends our own position and never accepts a
 * correction to it. Everything it *reads* — battery, cores, EMP, elimination,
 * the timer — is the server's word and is rendered verbatim.
 *
 * Connection is entirely optional. With no server configured the game runs
 * exactly as it did before, single-player, which is what keeps the offline
 * build playable while the netcode lands.
 */
export class Connection {
  room: Room | null = null;
  /** Set when the socket drops; the UI surfaces this rather than freezing. */
  error: string | null = null;
  onDetonation: ((message: DetonationMessage) => void) | null = null;
  onEmp: (() => void) | null = null;

  private sendTimer = 0;
  private sequence = 0;
  private lastInteract = false;

  get connected(): boolean {
    return this.room !== null && this.error === null;
  }

  get sessionId(): string {
    return this.room?.sessionId ?? '';
  }

  /**
   * Create a room with a fresh code. @param endpoint empty means stay offline.
   */
  async connect(endpoint: string, nickname: string): Promise<void> {
    const code = makeRoomCode();
    return this.open(endpoint, async (client) => client.create('buzzkill', { nickname, code }));
  }

  /**
   * Join by 4-letter code. The server filters rooms by `code`, so `join` (which
   * never creates) lands us in that room or fails cleanly.
   */
  async joinByCode(endpoint: string, nickname: string, code: string): Promise<void> {
    return this.open(endpoint, async (client) =>
      client.join('buzzkill', { nickname, code: code.toUpperCase() }),
    );
  }

  private async open(endpoint: string, joiner: (client: Client) => Promise<Room>): Promise<void> {
    if (!endpoint) return;
    try {
      const client = new Client(endpoint);
      const room = await joiner(client);
      this.room = room;
      this.error = null;

      room.onMessage('detonation', (message: DetonationMessage) => this.onDetonation?.(message));
      room.onMessage('emp', () => this.onEmp?.());
      // Registered so colyseus.js does not warn; phase 9 renders this properly.
      room.onMessage('roundEnd', () => undefined);

      room.onLeave((code) => {
        // A clean error beats a frozen world: the client keeps rendering and
        // says what happened (phase 5 acceptance).
        this.error = code === 1000 ? 'disconnected from the server' : `connection lost (code ${code})`;
        this.room = null;
      });
      room.onError((code, message) => {
        this.error = `server error ${code}: ${message ?? 'unknown'}`;
      });
    } catch (cause) {
      this.error = `could not reach the server — ${String(cause)}`;
      this.room = null;
    }
  }

  /** Ask the server to start the round. Ignored unless we are the host. */
  start(): void {
    this.room?.send('start');
  }

  setReady(ready: boolean): void {
    this.room?.send('ready', ready);
  }

  /**
   * Tell the server a hazard connected. The server range-checks it and owns
   * the consequence — the client never decides that the drone is down.
   */
  reportKnockdown(): void {
    this.room?.send('knockdown');
  }

  /**
   * Push our own state at CLIENT_SEND_HZ. Called every frame; it rate-limits
   * itself rather than being tied to the render loop.
   */
  update(
    frameDelta: number,
    self: { x: number; y: number; z: number; yaw: number },
    interacting: boolean,
  ): void {
    const room = this.room;
    if (!room) return;

    if (interacting !== this.lastInteract) {
      room.send('interact', interacting);
      this.lastInteract = interacting;
    }

    this.sendTimer += frameDelta;
    const interval = 1 / CLIENT_SEND_HZ;
    if (this.sendTimer < interval) return;
    this.sendTimer = 0;
    this.sequence += 1;
    room.send('move', { x: self.x, y: self.y, z: self.z, yaw: self.yaw, seq: this.sequence });
  }

  /** Current server state, or null offline. */
  snapshot(): NetSnapshot | null {
    const room = this.room;
    if (!room) return null;
    const state = room.state as Record<string, unknown> | undefined;
    // The first frames after joining arrive before the schema has been
    // populated, so the collections genuinely are undefined for a tick or two.
    if (!state?.players || !state.cores) return null;

    const players: RemotePlayer[] = [];
    (state.players as { forEach: (fn: (value: RemotePlayer) => void) => void }).forEach((player) => {
      players.push({
        sessionId: player.sessionId,
        nickname: player.nickname,
        role: player.role,
        x: player.x,
        y: player.y,
        z: player.z,
        yaw: player.yaw,
        alive: player.alive,
        carrying: player.carrying,
        ready: player.ready,
        score: player.score,
        survived: player.survived,
        coresDropped: player.coresDropped,
        fanLaunches: player.fanLaunches,
      });
    });

    const cores: NetSnapshot['cores'] = [];
    (state.cores as { forEach: (fn: (value: NetSnapshot['cores'][number]) => void) => void }).forEach(
      (core) => cores.push({ x: core.x, y: core.y, z: core.z, state: core.state, carrier: core.carrier }),
    );

    return {
      players,
      cores,
      battery: state.battery as number,
      cycle: state.cycle as number,
      fuseState: state.fuseState as string,
      coresInserted: state.coresInserted as number,
      empCharge: state.empCharge as number,
      empPresent: state.empPresent as number,
      empNeeded: state.empNeeded as number,
      roundRemaining: state.roundRemaining as number,
      phase: state.phase as string,
      winner: state.winner as string,
      cause: state.cause as string,
      code: state.code as string,
      host: state.host as string,
      round: state.round as number,
      totalRounds: state.totalRounds as number,
      droneKnocked: state.droneKnocked as boolean,
    };
  }

  async leave(): Promise<void> {
    await this.room?.leave(true);
    this.room = null;
  }
}

/**
 * Where to connect. Environment-driven with a query-string override, so there
 * is no hardcoded endpoint anywhere (phase 11 requires this and it is free now).
 * Absent configuration means single-player.
 */
export function resolveEndpoint(): string {
  const fromQuery = new URLSearchParams(window.location.search).get('server');
  if (fromQuery !== null) return fromQuery;
  const fromEnv = import.meta.env.VITE_SERVER_URL;
  return typeof fromEnv === 'string' ? fromEnv : '';
}
