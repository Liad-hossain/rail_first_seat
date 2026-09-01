#!/usr/bin/env node
/**
 * One availability sweep over every tracked route, then exit.
 *
 * Use this from cron / a platform scheduler if you would rather not keep the
 * server running, or want sweeps at specific times (e.g. just after the 08:00
 * and 14:00 ticket releases, when the interesting changes happen):
 *
 *   0 8,14,20 * * *  cd /path/to/rail_first_seat && /usr/local/bin/node scripts/run-snapshot.js
 */
import { migrate, closePool } from '../src/db.js';
import { collectOnce, listWatches } from '../src/history.js';
import { serviceCredentials } from '../src/session.js';

await migrate();

// Sessions belong to individual users now; this runs on the deployment's
// designated background credentials — BR_TOKEN, else the newest saved session.
const creds = await serviceCredentials();
if (!creds.token) {
  console.error('No session token. Sign in on the website and add one in Settings, or set BR_TOKEN.');
  await closePool();
  process.exit(1);
}

const watches = await listWatches();
if (!watches.length) {
  console.error('No tracked routes. Add some in the website Settings panel, or set BR_WATCH.');
  await closePool();
  process.exit(1);
}

console.log(`Sweeping ${watches.length} route(s): ${watches.map((w) => `${w.fromLabel}>${w.toLabel}`).join(', ')}`);
const res = await collectOnce({ token: creds, log: console.log });
console.log(JSON.stringify(res));
await closePool();
if (res.authFailed) process.exit(2);
