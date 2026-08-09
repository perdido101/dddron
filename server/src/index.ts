import { createServer } from 'node:http';

import { Server } from 'colyseus';

import { MAX_CONCURRENT_ROOMS } from '@shared/constants';

import { GameRoom } from './GameRoom';
import { telemetry } from './telemetry';

/**
 * Colyseus host.
 *
 * Port and room cap come from the environment — phase 11 wants no hardcoded
 * endpoints, and starting that way costs nothing.
 */
const port = Number(process.env.PORT ?? 2567);

const gameServer = new Server({ server: createServer() });
// Filtering by `code` is what makes a 4-letter join code work: a client that
// joins with the same code can only ever land in the room created with it.
gameServer.define('buzzkill', GameRoom).filterBy(['code']);

// Room cleanup on empty is Colyseus's default (autoDispose); the cap is ours.
gameServer.onShutdown(() => console.log('BUZZKILL server shutting down'));

void gameServer.listen(port).then(() => {
  console.log(`BUZZKILL server listening on :${port} (max ${MAX_CONCURRENT_ROOMS} rooms)`);
  console.log(`telemetry: ${telemetry.summary()}`);
});
