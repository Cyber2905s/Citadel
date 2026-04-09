import { PLANS } from '../lib/plans.js';
import { redis } from '../lib/redis.js';
import { rateLimited } from '../lib/metrics.js';
import { HttpError } from '../lib/errors.js';

const USAGE_TTL_SECONDS = 3 * 24 * 3600;

/**
 * Fixed one-minute window counter. One round trip (MULTI) per request.
 * ponytail: fixed window allows up to 2x burst across a window edge; switch to
 * a sliding-window Lua script if that matters.
 * @param {string} key @param {number} limit
 */
export async function hit(key, limit, extra = (m) => m) {
  const windowStart = Math.floor(Date.now() / 60_000);
  const redisKey = `rl:${key}:${windowStart}`;
  const results = await extra(redis.multi().incr(redisKey).expire(redisKey, 61)).exec();
  const count = /** @type {number} */ (results[0][1]);
  return {
    count,
    limit,
    remaining: Math.max(0, limit - count),
    resetSeconds: 60 - Math.floor((Date.now() / 1000) % 60),
    allowed: count <= limit,
  };
}

function applyHeaders(reply, r) {
  reply.header('x-ratelimit-limit', r.limit);
  reply.header('x-ratelimit-remaining', r.remaining);
  reply.header('x-ratelimit-reset', r.resetSeconds);
  if (!r.allowed) reply.header('retry-after', r.resetSeconds);
}

/**
 * preHandler (after authenticate): per-tenant limit by plan, and metering of
 * API calls into a per-day Redis hash that the usage worker rolls up to Postgres.
 */
export async function tenantRateLimit(req, reply) {
  const { tenantId, plan } = req.auth;
  const day = new Date().toISOString().slice(0, 10);
  const usageKey = `usage:${day}:${tenantId}`;
  const r = await hit(`tenant:${tenantId}`, PLANS[plan].requestsPerMinute, (m) =>
    m
      .hincrby(usageKey, 'api_calls', 1)
      .expire(usageKey, USAGE_TTL_SECONDS)
      .sadd('usage:dirty', `${day}:${tenantId}`),
  );
  applyHeaders(reply, r);
  if (!r.allowed) {
    rateLimited.inc({ plan });
    redis.hincrby(usageKey, 'rate_limited', 1).catch(() => {});
    throw new HttpError(429, `Rate limit of ${r.limit} requests/minute exceeded for ${plan} plan`);
  }
}

/** preHandler for unauthenticated endpoints (login, signup...): per-IP limit. */
export const ipRateLimit =
  (limit = 20) =>
  async (req, reply) => {
    const r = await hit(`ip:${req.routeOptions.url}:${req.ip}`, limit);
    applyHeaders(reply, r);
    if (!r.allowed) throw new HttpError(429, 'Too many requests, slow down');
  };
