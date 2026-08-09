import { createServer } from 'node:http';

import { Server } from 'colyseus';

import { GameRoom } from './GameRoom';

/**
 * Colyseus host.
 *
 * Port and room cap come from the environment — phase 11 wants no hardcoded
 * endpoints, and starting that way costs nothing.
 */
const port = Number(process.env.PORT ?? 2567);

const gameServer = new Server({ server: createServer() });
gameServer.define('buzzkill', GameRoom);

void gameServer.listen(port).then(() => {
  console.log(`BUZZKILL server listening on :${port}`);
});
