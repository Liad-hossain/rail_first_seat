/**
 * Hourly availability sweep — the serverless twin of startCollector().
 * Silently does nothing without a session token, which is the normal state
 * until one is saved in Settings.
 */
import { collectOnce, listWatches } from '../../src/history.js';
import { getMeta, migrate } from '../../src/db.js';
import { setDeviceIdentity } from '../../src/shohoz.js';

let schemaReady = false;

export default async () => {
  if (!schemaReady) { await migrate(); schemaReady = true; }

  const token = (await getMeta('br_token')) || process.env.BR_TOKEN || null;
  if (!token) return new Response('no session token');
  if (!(await listWatches()).length) return new Response('no tracked routes');

  // The session is bound to the device it was issued to; without these the
  // request is rejected exactly as if the token had expired.
  setDeviceIdentity({
    deviceId: (await getMeta('br_device_id')) || process.env.BR_DEVICE_ID || null,
    deviceKey: (await getMeta('br_device_key')) || process.env.BR_DEVICE_KEY || null,
  });

  const res = await collectOnce({ token, log: console.log });
  console.log('collector:', JSON.stringify(res));
  return new Response('ok');
};

export const config = { schedule: '7 * * * *' };
