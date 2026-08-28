/**
 * The alarm scheduler, as a cron.
 *
 * A persistent process arms a precise timer and fires within milliseconds of
 * the sale instant. Cron granularity is one minute, so this runs every minute
 * and closes the gap by waiting out the last few seconds inside the invocation
 * when an alarm is about to become due. Expect a few seconds of lag rather
 * than a few hundred milliseconds.
 */
import { runAlarmTick } from '../../src/notify.js';
import { migrate } from '../../src/db.js';

let schemaReady = false;

export default async () => {
  if (!schemaReady) { await migrate(); schemaReady = true; }

  const result = await runAlarmTick({
    log: console.log,
    // Netlify allows 30s for a scheduled function; 8s of waiting keeps a wide
    // margin for the DB round trip and the Telegram send that follow.
    waitWindowMs: 8_000,
  });

  if (result.fired || result.retried || result.expired) console.log('alarm tick:', result);
  return new Response('ok');
};

export const config = { schedule: '* * * * *' };
