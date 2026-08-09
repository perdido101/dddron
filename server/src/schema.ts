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
});
