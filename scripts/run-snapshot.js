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
import { migrate, getMeta, closePool } from '../src/db.js';
import { collectOnce, listWatches } from '../src/history.js';

await migrate();

const token = (await getMeta('br_token')) || process.env.BR_TOKEN || null;
if (!token) {
  console.error('No session token. Add one in the website Settings panel, or set BR_TOKEN.');
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
const res = await collectOnce({ token, log: console.log });
console.log(JSON.stringify(res));
await closePool();
if (res.authFailed) process.exit(2);
