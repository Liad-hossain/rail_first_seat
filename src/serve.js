import http from 'node:http';
import { PORT, NODE_ENV, SALE_OPEN_TIME } from './config.js';
import { migrate, verifyConnection, catalogIsEmpty, closePool } from './db.js';
import { catalogStatus, stationLabel } from './catalog.js';
import {
  historyOverview, listWatches, addWatch, startCollector, startReleaseProbe,
  saleReleaseEvidence,
} from './history.js';
import { notifyStatus, startNotifications, ensureBots } from './notify.js';
import { countBots } from './bots.js';
import { setDeviceIdentity } from './shohoz.js';
import {
  handlers, HttpError, sendJson, serveStatic, readBody, dispatch,
  resolveStation, runSync, getToken, getDeviceIdentity,
} from './server.js';

/* -------------------------------- wiring -------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    const isApi = url.pathname.startsWith('/api/') || Boolean(handlers[`${req.method} ${url.pathname}`]);
    if (isApi) {
      const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : {};
      const result = await dispatch({
        method: req.method,
        pathname: url.pathname,
        searchParams: url.searchParams,
        body,
        headers: req.headers,
      });
      return sendJson(res, result.status, result.body);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, ...err.extra });
    console.error('unhandled error', err);
    return sendJson(res, 500, {
      error: NODE_ENV === 'production' ? 'Internal server error' : (err.message || 'Internal error'),
    });
  }
});

/* --------------------------------- boot --------------------------------- */

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n  Port ${PORT} is already in use — most likely another copy of this ` +
      'server is still running.\n\n' +
      '  See what is holding it:\n' +
      `    lsof -nP -iTCP:${PORT} -sTCP:LISTEN\n\n` +
      '  Stop it:\n' +
      '    pkill -f "node src/server.js"\n\n' +
      '  Or start on a different port:\n' +
      `    PORT=${PORT + 1} npm start\n`,
    );
  } else if (err.code === 'EACCES') {
    console.error(
      `\n  Not allowed to bind port ${PORT}. Ports below 1024 need elevated ` +
      'privileges — use a higher port, e.g. PORT=8787 npm start\n',
    );
  } else {
    console.error(`\n  Server failed to start: ${err.message}\n`);
  }
  closePool().catch(() => {}).finally(() => process.exit(1));
});

async function start() {
  let conn;
  try {
    conn = await verifyConnection();
    await migrate();
  } catch (err) {
    console.error(`\n  Cannot start: ${err.message}\n`);
    process.exit(1);
  }

  setDeviceIdentity(await getDeviceIdentity());

  await ensureBots({ log: console.log });

  const [catalog, token, overview, notify, bots, release] = await Promise.all([
    catalogStatus(), getToken(), historyOverview(), notifyStatus(), countBots(),
    saleReleaseEvidence(),
  ]);

  server.listen(PORT, () => {
    console.log(`\n  rail_first_seat  →  http://localhost:${PORT}\n`);
    console.log(`  database: ${conn.version} at ${conn.label}`);
    console.log(`  catalog : ${catalog.trains} trains, ${catalog.stations} stations, ${catalog.stops} stops` +
      (catalog.syncedAt ? ` (synced ${catalog.syncedAt})` : ''));
    console.log(`  session : ${token.token
      ? `background token present (${token.source}) — history and the release probe can run`
      : 'no token — schedules and sale times only, until a signed-in user saves one'}`);
    console.log(`  history : ${overview.snapshots} snapshot(s) recorded`);
    console.log(`  release : seats open ${release.time || SALE_OPEN_TIME} Dhaka`
      + (release.evidence
        ? ` (measured ${release.evidence.observedOn}, closed ${release.evidence.absentAtDhaka}`
          + ` → open ${release.evidence.seenAtDhaka})`
        : release.unmeasured
          ? ` (default — ignoring a stored ${release.unmeasured.storedTime} with ${release.unmeasured.reason};`
            + ' an older build writing to this database records first sightings, not measurements)'
          : ' (default — will self-correct once a session token lets it be measured)'));
    console.log(`  alarms  : ${bots
      ? `${bots} Telegram bot(s) connected`
        + (notify.sharedBot ? `, shared @${notify.sharedBot.username}` : ', none shared')
      : 'no bot connected yet — users add their own in Settings'}\n`);
  });

  // Seeding needs the catalog, so it waits for a first-run sync to finish.
  const seedWatchlist = async () => {
    if (!process.env.BR_WATCH || (await listWatches()).length > 0) return;
    for (const pair of process.env.BR_WATCH.split(',')) {
      const [f, t] = pair.split('>').map((s) => s?.trim());
      if (!f || !t) continue;
      try {
        await addWatch(await resolveStation(f, 'from'), await resolveStation(t, 'to'));
        console.log(`  watchlist: tracking ${f} → ${t}`);
      } catch (e) {
        console.warn(`  watchlist: skipped "${pair}" — ${e.message}`);
      }
    }
  };

  if (await catalogIsEmpty()) {
    console.log('  Catalog is empty — fetching it now from Bangladesh Railway (~1 min)…');
    runSync()
      .then(async (r) => {
        console.log(`  Catalog ready: ${r.trains} trains, ${r.stations} stations.\n`);
        await seedWatchlist();
      })
      .catch((e) => console.error(`  Catalog sync failed: ${e.message}\n`));
  } else {
    await seedWatchlist();
  }

  startCollector({ getToken, log: (m) => console.log(`  ${m}`) });
  startReleaseProbe({ getToken, log: (m) => console.log(`  ${m}`) });
  startNotifications({ log: (m) => console.log(`  ${m}`) });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log('\n  shutting down…');
    server.close();
    await closePool().catch(() => {});
    process.exit(0);
  });
}

start();
