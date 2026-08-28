#!/usr/bin/env node
/** Refresh the train/route catalog from Bangladesh Railway's public endpoints. */
import { migrate, closePool } from '../src/db.js';
import { syncCatalog } from '../src/catalog.js';

await migrate();

let last = 0;
const res = await syncCatalog({
  onProgress: ({ phase, done, total }) => {
    if (phase !== 'routes') return;
    const pct = Math.floor((done / total) * 100);
    if (pct >= last + 5 || done === total) {
      last = pct;
      process.stdout.write(`\r  routes ${done}/${total} (${pct}%)   `);
    }
  },
});
process.stdout.write('\n');
console.log(`Synced ${res.trains} trains, ${res.stations} stations, ${res.stops} stops.`);
if (res.failures.length) {
  console.log(`${res.failures.length} train(s) had no route data:`,
    res.failures.map((f) => f.trainNumber).join(', '));
}
await closePool();
