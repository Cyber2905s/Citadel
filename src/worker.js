import http from 'node:http';
import { Worker } from 'bullmq';
import pino from 'pino';
import { config } from './config.js';
import { pool } from './db/index.js';
import { jobsProcessed, registry } from './lib/metrics.js';
import { connection, usageQueue } from './lib/queues.js';
import { redis } from './lib/redis.js';
import { rollupUsage } from './modules/usage/service.js';

const log = pino({ level: config.logLevel, base: { service: 'worker' } });

// ponytail: no SMTP provider wired up; emails are logged. Swap in nodemailer/SES here.
const emailWorker = new Worker(
  'email',
  async (job) => {
    log.info(
      { job_id: job.id, to: job.data.to, subject: job.data.subject, text: job.data.text },
      'email sent',
    );
  },
  { connection, concurrency: 5 },
);

const usageWorker = new Worker(
  'usage',
  async () => {
    const tenants = await rollupUsage();
    log.info({ tenants }, 'usage rolled up');
  },
  { connection },
);

for (const w of [emailWorker, usageWorker]) {
  w.on('completed', () => jobsProcessed.inc({ queue: w.name, status: 'completed' }));
  w.on('failed', (job, err) => {
    jobsProcessed.inc({ queue: w.name, status: 'failed' });
    log.error({ job_id: job?.id, queue: w.name, err }, 'job failed');
  });
}

// Idempotent: re-registering on every boot just updates the schedule.
await usageQueue.upsertJobScheduler('usage-rollup', { every: 60_000 }, { name: 'rollup' });

const metricsServer = http
  .createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.setHeader('content-type', registry.contentType);
      return res.end(await registry.metrics());
    }
    res.end('ok');
  })
  .listen(Number(process.env.WORKER_METRICS_PORT ?? 9100));

log.info('worker started');

async function shutdown() {
  await Promise.all([emailWorker.close(), usageWorker.close(), usageQueue.close()]);
  metricsServer.close();
  await Promise.all([pool.end(), redis.quit()]);
  process.exit(0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
