import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';

import { Server } from 'colyseus';

import { MAX_CONCURRENT_ROOMS } from '@shared/constants';

import { GameRoom } from './GameRoom';
import { telemetry } from './telemetry';

/**
 * Colyseus host.
 *
 * Port comes from the environment — phase 11 and handoff 02 both forbid
 * hardcoded endpoints, and every host (Railway, Fly, Render, Colyseus Cloud)
 * injects PORT.
 */
const port = Number(process.env.PORT ?? 2567);

const httpServer = createServer();
const gameServer = new Server({ server: httpServer });

// Filtering by `code` is what makes a 4-letter join code work: a client that
// joins with the same code can only ever land in the room created with it.
gameServer.define('buzzkill', GameRoom).filterBy(['code']);

/**
 * Health and stats, answered before Colyseus's own router sees the request.
 * After responding, the response object is neutered so a second handler
 * writing to it is a harmless no-op rather than a crash.
 */
httpServer.prependListener('request', (req, res) => {
  // Anything Colyseus does not route has NO handler on a bare http server, so
  // the request hangs until the host's gateway gives up and shows a 502. Only
  // these exact paths are intercepted; /matchmake/* still falls through.
  if (req.url === '/' || req.url === '/favicon.ico' || req.url === '/robots.txt') {
    respond(res, 200, {
      service: 'buzzkill',
      note: 'game server — play at https://perdido101.github.io/dddron/',
      rooms: telemetry.rooms,
    });
  } else if (req.url === '/health') {
    respond(res, 200, { ok: true, rooms: telemetry.rooms, uptime: Math.round(process.uptime()) });
  } else if (req.url === '/stats') {
    respond(res, 200, telemetry.stats());
  }
});

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
  res.writeHead = (() => res) as never;
  res.write = (() => true) as never;
  res.end = (() => res) as never;
}

// Colyseus installs its own SIGINT/SIGTERM graceful shutdown by default;
// this hook is just the log line proving it ran.
gameServer.onShutdown(() => console.log('[server] graceful shutdown complete'));

void gameServer.listen(port).then(() => {
  console.log(`BUZZKILL server listening on :${port} (max ${MAX_CONCURRENT_ROOMS} rooms)`);
  console.log(`[telemetry] ${telemetry.summary()}`);
});
