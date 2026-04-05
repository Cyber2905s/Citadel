import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration by route',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

// Labelled by plan, not tenant: per-tenant labels would explode cardinality.
export const rateLimited = new client.Counter({
  name: 'rate_limited_requests_total',
  help: 'Requests rejected by the rate limiter',
  labelNames: ['plan'],
  registers: [registry],
});

export const jobsProcessed = new client.Counter({
  name: 'jobs_processed_total',
  help: 'Background jobs processed',
  labelNames: ['queue', 'status'],
  registers: [registry],
});
