import { ArraySchema, MapSchema, Schema, defineTypes } from '@colyseus/schema';

/**
 * Networked state.
 *
 * Written with `defineTypes` rather than decorators so the schema needs no
 * decorator compiler flags and behaves identically under any TypeScript
 * version — this monorepo has already had two TS majors resolved into it.
 *
 * What is here reflects the authority split in sacred constraint 5: the server
 * carries battery, cores, EMP, elimination, the timer and the win condition,
 * and it carries player positions only as a relay so other clients can draw
 * them. It never simulates or corrects runner movement.
 */
export class PlayerState extends Schema {
  sessionId = '';
  nickname = '';
  /** 'drone' | 'runner' | 'spectator'. */
  role = 'spectator';
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;
  alive = true;
  carrying = false;
  /** Client's own tick, so late packets can be dropped. */
  seq = 0;
  ready = false;
  /** Rounds this player has flown the drone, for phase 9 rotation. */
  flown = 0;
  score = 0;
  /** Joke-award counters (phase 9). */
  survived = 0;
  coresDropped = 0;
  fanLaunches = 0;
  /** Server-driven filler player. Simulated by the host client. */
  bot = false;
}
defineTypes(PlayerState, {
  sessionId: 'string',
  nickname: 'string',
  role: 'string',
  x: 'float32',
  y: 'float32',
  z: 'float32',
  yaw: 'float32',
  alive: 'boolean',
  carrying: 'boolean',
  seq: 'uint32',
  ready: 'boolean',
  flown: 'uint8',
  score: 'uint16',
  survived: 'uint8',
  coresDropped: 'uint8',
  fanLaunches: 'uint8',
  bot: 'boolean',
});

export class CoreEntity extends Schema {
  x = 0;
  y = 0;
  z = 0;
  /** 'onPad' | 'loose' | 'carried' | 'inserted'. */
  state = 'onPad';
  /** Index into CHARGE_PAD_POSITIONS, or -1 when the core blocks no pad. */
  pad = -1;
  /** Session id of whoever is carrying it, empty when nobody is. */
  carrier = '';
}
defineTypes(CoreEntity, {
  x: 'float32',
  y: 'float32',
  z: 'float32',
  state: 'string',
  pad: 'int8',
  carrier: 'string',
});

export class GameState extends Schema {
  players = new MapSchema<PlayerState>();
  cores = new ArraySchema<CoreEntity>();

  /** 'lobby' | 'playing' | 'ended'. */
  phase = 'lobby';
  /** 'runners' | 'drone' | 'aborted' | '' while a round is live. */
  winner = '';
  /** Why the round ended, for the round-end screen in phase 9. */
  cause = '';

  /** THE single source of truth for battery (sacred constraint 3). */
  battery = 1;
  cycle = 0;
  fuseState = 'armed';

  coresInserted = 0;
  empCharge = 0;
  empPresent = 0;
  empNeeded = 1;

  roundRemaining = 0;

  /** 4-letter join code, shown in the lobby. */
  code = '';
  /** Session id of the host, who alone may start. */
  host = '';
  round = 0;
  totalRounds = 0;
  /** Drone knockdown, so every client can see it is grounded (phase 7). */
  droneKnocked = false;
  /**
   * Practice mode: one player is enough, and results are not scored into the
   * match. Deliberately a separate flag rather than a lowered minimum, so real
   * matches keep the brief's 3-player rule intact.
   */
  practice = false;
  botCount = 0;
}
defineTypes(GameState, {
  players: { map: PlayerState },
  cores: [CoreEntity],
  phase: 'string',
  winner: 'string',
  cause: 'string',
  battery: 'float32',
  cycle: 'uint8',
  fuseState: 'string',
  coresInserted: 'uint8',
  empCharge: 'float32',
  empPresent: 'uint8',
  empNeeded: 'uint8',
  roundRemaining: 'float32',
  code: 'string',
  host: 'string',
  round: 'uint8',
  totalRounds: 'uint8',
  droneKnocked: 'boolean',
  practice: 'boolean',
  botCount: 'uint8',
});
