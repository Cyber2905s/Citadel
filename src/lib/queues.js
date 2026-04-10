import { Queue } from 'bullmq';
import { config } from '../config.js';

const url = new URL(config.redisUrl);
/** BullMQ needs its own connections (blocking commands), so pass options, not a client. */
export const connection = {
  host: url.hostname,
  port: Number(url.port || 6379),
  username: url.username || undefined,
  password: url.password || undefined,
  maxRetriesPerRequest: null,
};

export const emailQueue = new Queue('email', {
  connection,
  defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 1000 },
});

export const usageQueue = new Queue('usage', { connection });
