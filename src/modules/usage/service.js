import { withTenant } from '../../db/index.js';
import { redis } from '../../lib/redis.js';

/**
 * Copies per-day Redis counters into usage_daily. Idempotent (upsert sets the
 * absolute count), so it is safe to run often or twice. Past days are dropped
 * from the dirty set once written.
 */
export async function rollupUsage() {
  const today = new Date().toISOString().slice(0, 10);
  const entries = await redis.smembers('usage:dirty');
  for (const entry of entries) {
    const [day, tenantId] = entry.split(':');
    const counts = await redis.hgetall(`usage:${day}:${tenantId}`);
    const metrics = Object.entries(counts);
    if (metrics.length) {
      await withTenant(tenantId, async (c) => {
        for (const [metric, count] of metrics) {
          await c.query(
            `INSERT INTO usage_daily (tenant_id, day, metric, count) VALUES ($1, $2, $3, $4)
             ON CONFLICT (tenant_id, day, metric) DO UPDATE SET count = EXCLUDED.count`,
            [tenantId, day, metric, Number(count)],
          );
        }
      });
    }
    if (day < today) await redis.srem('usage:dirty', entry);
  }
  return entries.length;
}
