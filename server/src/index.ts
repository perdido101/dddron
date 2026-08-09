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
    // Anything Colyseus does not route has NO handler on a bare http server, so
    // the request hangs until the host's gateway gives up and shows a 502.
    //
    // A person who lands here typed the server's address expecting the game, so
    // they get a page that says so and links to it. A script gets the JSON it
    // came for. Deciding on Accept rather than on the path means /stats-style
    // tooling keeps working while a browser stops being shown raw JSON.
    if ((req.headers.accept ?? '').includes('text/html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(LANDING_PAGE);
      neuter(res);
    } else {
      respond(res, 200, {
        service: 'buzzkill',
        note: `game server — play at ${GAME_URL}`,
        rooms: telemetry.rooms,
      });
    }
  } else if (req.url === '/health') {
    respond(res, 200, { ok: true, rooms: telemetry.rooms, uptime: Math.round(process.uptime()) });
  } else if (req.url === '/stats') {
    respond(res, 200, { ...telemetry.stats(), ...telemetry.pacing() });
  } else if (req.url === '/rounds.csv') {
    // One row per round, for a spreadsheet (handoff 02, session 3). Anonymous
    // by construction: RoundSummary carries no nickname and no session id.
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="buzzkill-rounds.csv"',
    });
    res.end(telemetry.csv());
    neuter(res);
  }
});

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
  neuter(res);
}

/** Where the actual game lives. This host only serves the rooms behind it. */
const GAME_URL = 'https://perdido101.github.io/dddron/';

/**
 * What a browser sees at the server's address.
 *
 * Inline everything: this host serves no static files, and a landing page that
 * needs a second request is a landing page that can fail on its own.
 */
const LANDING_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>BUZZKILL — game server</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#bfe4f2; color:#223; text-align:center;
         font:16px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace; }
  .card { padding:34px 30px; border-radius:16px; background:#f4f7fb;
          box-shadow:0 18px 50px rgba(0,0,0,.25); max-width:460px; margin:20px; }
  h1 { margin:0 0 4px; font-size:34px; letter-spacing:.12em; }
  p.sub { margin:0 0 22px; font-size:10px; letter-spacing:.2em; opacity:.6; }
  a.play { display:block; padding:13px; border-radius:9px; background:#7fd4a8;
           color:#12301f; font-weight:700; letter-spacing:.12em; text-decoration:none; }
  a.play:hover { background:#6cc296; }
  p.note { margin:18px 0 0; font-size:12px; opacity:.7; }
  code { background:#e3e9f0; padding:1px 5px; border-radius:4px; }
</style></head>
<body><div class="card">
  <h1>BUZZKILL</h1>
  <p class="sub">this is the game server, not the game</p>
  <a class="play" href="${GAME_URL}">PLAY BUZZKILL &rarr;</a>
  <p class="note">You have reached the machine that runs the rooms. It has no
  game to show you &mdash; the game is at the link above, and it talks to this
  address in the background.</p>
  <p class="note">Status: <code>/health</code> &middot; <code>/stats</code>
  &middot; <code>/rounds.csv</code></p>
</div></body></html>`;

/** Make a second write to an already-answered response a no-op, not a crash. */
function neuter(res: ServerResponse): void {
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
