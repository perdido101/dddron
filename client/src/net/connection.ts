import { Client, type Room } from 'colyseus.js';

import { CLIENT_SEND_HZ, RUN_SPEED, makeRoomCode } from '@shared/constants';

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
  /** Filler player simulated by the host client, not a person. */
  bot: boolean;
  /** Index into RUNNER_COLORWAYS; the server hands these out without collisions. */
  colorway: number;
}

/** Everything the client renders but does not own. */
export interface NetSnapshot {
  players: RemotePlayer[];
  cores: { x: number; y: number; z: number; state: string; carrier: string; pad: number }[];
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
  practice: boolean;
  botCount: number;
  /** Whether this server accepts dev-console commands at all. */
  devEnabled: boolean;
}

/**
 * Core-loop metrics for one finished round (handoff 02, session 3).
 *
 * Measured entirely on the server and sent verbatim; the client formats it and
 * changes nothing. Shape mirrors server/src/roundMetrics.ts.
 */
export interface RoundSummary {
  seconds: number;
  winner: string;
  cause: string;
  players: number;
  bots: number;
  secondsToFirstCore: number | null;
  secondsToLastCore: number | null;
  coreFreeSeconds: number;
  coreUntouchedSeconds: number;
  coreCarriedSeconds: number;
  dropsByBlast: number;
  dropsByWash: number;
  allPadsBlockedSeconds: number;
  droneStrandedSeconds: number;
  droneDownSeconds: number;
  empChargingSeconds: number;
  empDrainingSeconds: number;
  detonations: number;
  eliminations: number;
  knockdowns: number;
  sabotages: number;
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
  onRoundEnd: ((summary: RoundSummary) => void) | null = null;

  private sendTimer = 0;
  private sequence = 0;
  private lastInteract = false;
  private pingTimer = 0;
  private readonly rtts: number[] = [];

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
      room.onMessage('roundEnd', (message: { summary?: RoundSummary }) => {
        if (message?.summary) this.onRoundEnd?.(message.summary);
      });
      room.onMessage('pong', (sent: number) => {
        // Keep a short rolling window: one bad sample should not dominate the
        // reading a player sees mid-round.
        this.rtts.push(Date.now() - sent);
        if (this.rtts.length > RTT_SAMPLES) this.rtts.shift();
      });

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

  /** Host-only. The server ignores it from anyone else. */
  setPractice(on: boolean): void {
    this.room?.send('practice', on);
  }

  /** Ask for a role. The server keeps exactly one drone, so this may bump someone. */
  setRole(role: 'drone' | 'runner'): void {
    this.room?.send('role', role);
  }

  /** Host-only: how many filler bots the room should hold. */
  setBots(count: number): void {
    this.room?.send('setBots', count);
  }

  /**
   * Relay one host-simulated bot body. Bots exist so a round can be played
   * below the 3-player minimum; their bodies are simulated on the host's
   * client exactly like a human's, and only the resulting position is sent —
   * the server still simulates no movement at all (sacred constraint 5).
   */
  sendBotMove(id: string, x: number, y: number, z: number, yaw: number): void {
    this.room?.send('botMove', { id, x, y, z, yaw });
  }

  sendBotInteract(id: string, held: boolean): void {
    this.room?.send('botInteract', { id, held });
  }

  /**
   * Dev-console command. Silently ignored unless the server was started with
   * dev tools on, which `NetSnapshot.devEnabled` reports so the UI can say so.
   */
  sendDev(action: string, value?: number | string): void {
    this.room?.send('dev', { action, value });
  }

  /**
   * Tell the server a hazard connected. The server range-checks it and owns
   * the consequence — the client never decides that the drone is down.
   */
  reportKnockdown(): void {
    this.room?.send('knockdown');
  }

  /**
   * The prop wash blew the core out of our hands. We felt the shove (our body
   * is ours), the server owns the core, so it performs the drop.
   */
  reportShoved(): void {
    this.room?.send('shoved');
  }

  /** A pad was sabotaged. Counted for telemetry; grants nothing. */
  reportSabotage(): void {
    this.room?.send('sabotage');
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

    this.pingTimer += frameDelta;
    if (this.pingTimer >= PING_INTERVAL) {
      this.pingTimer = 0;
      room.send('ping', Date.now());
    }

    this.sendTimer += frameDelta;
    const interval = 1 / CLIENT_SEND_HZ;
    if (this.sendTimer < interval) return;
    this.sendTimer = 0;
    this.sequence += 1;
    room.send('move', { x: self.x, y: self.y, z: self.z, yaw: self.yaw, seq: this.sequence });
  }

  /** Median round-trip time in ms, or null before the first pong. */
  get rtt(): number | null {
    if (this.rtts.length === 0) return null;
    const sorted = [...this.rtts].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? null;
  }

  /**
   * How far the server's view of us can lag at the current RTT, in metres.
   * Half the RTT plus one send interval, at full running speed — the honest
   * upper bound on "died past where my screen showed me".
   */
  get positionLagMetres(): number | null {
    const rtt = this.rtt;
    if (rtt === null) return null;
    return (rtt / 2 / 1000 + 1 / CLIENT_SEND_HZ) * RUN_SPEED;
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
        bot: player.bot,
        colorway: player.colorway,
      });
    });

    const cores: NetSnapshot['cores'] = [];
    (state.cores as { forEach: (fn: (value: NetSnapshot['cores'][number]) => void) => void }).forEach(
      (core) =>
        cores.push({
          x: core.x,
          y: core.y,
          z: core.z,
          state: core.state,
          carrier: core.carrier,
          pad: core.pad,
        }),
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
      practice: state.practice as boolean,
      botCount: state.botCount as number,
      devEnabled: state.devEnabled === true,
    };
  }

  async leave(): Promise<void> {
    await this.room?.leave(true);
    this.room = null;
  }
}

/** Seconds between pings, and how many samples the median is taken over. */
const PING_INTERVAL = 1;
const RTT_SAMPLES = 9;

/**
 * Where to connect. Environment-driven with a query-string override, so there
 * is no hardcoded endpoint anywhere (phase 11 requires this and it is free now).
 * Absent configuration means single-player.
 */
export function resolveEndpoint(): string {
  const fromQuery = new URLSearchParams(window.location.search).get('server');
  if (fromQuery !== null) return normaliseEndpoint(fromQuery);
  const fromEnv = import.meta.env.VITE_SERVER_URL;
  if (typeof fromEnv === 'string' && fromEnv) return normaliseEndpoint(fromEnv);
  // Local dev falls back to the local server automatically (handoff 02).
  // `?server=` with an empty value still forces solo when that is wanted.
  if (import.meta.env.DEV) return 'ws://localhost:2567';
  return '';
}

/**
 * The page is HTTPS in production, and browsers refuse an insecure socket
 * from a secure page — so ws:// is upgraded rather than left to fail with an
 * opaque mixed-content error.
 */
function normaliseEndpoint(raw: string): string {
  if (!raw) return '';
  let url = raw.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
  if (window.location.protocol === 'https:' && url.startsWith('ws://')) {
    console.warn('BUZZKILL: upgrading server endpoint to wss:// (mixed content)');
    url = `wss://${url.slice('ws://'.length)}`;
  }
  return url;
}
