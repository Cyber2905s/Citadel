import { buildApp } from './app.js';
import { config } from './config.js';
import { pool } from './db/index.js';
import { redis } from './lib/redis.js';
import { emailQueue, usageQueue } from './lib/queues.js';

const app = await buildApp();

async function shutdown(signal) {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await Promise.all([emailQueue.close(), usageQueue.close()]);
  await Promise.all([pool.end(), redis.quit()]);
  process.exit(0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

await app.listen({ port: config.port, host: '0.0.0.0' });
