/**
 * Hourly availability sweep — the serverless twin of startCollector().
 * Silently does nothing without a session token, which is the normal state
 * until one is saved in Settings.
 */
import { collectOnce, listWatches } from '../../src/history.js';
import { migrate } from '../../src/db.js';
import { serviceCredentials } from '../../src/session.js';

let schemaReady = false;

export default async () => {
  if (!schemaReady) { await migrate(); schemaReady = true; }

  // Sessions are per-user now, so background work runs on whichever credentials
  // the deployment designated — an explicit BR_TOKEN, else the most recently
  // saved user session. The device id/key travel inside, because upstream binds
  // a session to the device it was issued to.
  const creds = await serviceCredentials();
  if (!creds.token) return new Response('no session token');
  if (!(await listWatches()).length) return new Response('no tracked routes');

  const res = await collectOnce({ token: creds, log: console.log });
  console.log('collector:', JSON.stringify(res));
  return new Response('ok');
};

export const config = { schedule: '7 * * * *' };
