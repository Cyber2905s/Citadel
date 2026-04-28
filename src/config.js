const env = process.env;

function required(name, fallback) {
  const value = env[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing env var ${name}`);
  return value;
}

export const config = {
  env: env.NODE_ENV ?? 'development',
  port: Number(env.PORT ?? 3000),
  logLevel: env.LOG_LEVEL ?? 'info',
  databaseUrl: required(
    'DATABASE_URL',
    'postgres://citadel_app:citadel_app@localhost:5432/citadel',
  ),
  migrationDatabaseUrl: required(
    'MIGRATION_DATABASE_URL',
    'postgres://postgres:postgres@localhost:5432/citadel',
  ),
  appDbUser: env.APP_DB_USER ?? 'citadel_app',
  appDbPassword: env.APP_DB_PASSWORD ?? 'citadel_app',
  redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
  jwtSecret: required('JWT_SECRET', 'dev-only-secret-change-me-dev-only-secret'),
  accessTokenTtl: env.ACCESS_TOKEN_TTL ?? '15m',
  refreshTokenTtlDays: Number(env.REFRESH_TOKEN_TTL_DAYS ?? 30),
  appUrl: env.APP_URL ?? 'http://localhost:8080',
  // Per-IP limit on login/signup/refresh/invite-accept.
  authRateLimitPerMinute: Number(env.AUTH_RATE_LIMIT_PER_MINUTE ?? 20),
  // Only trust X-Forwarded-For from known proxies, or clients can spoof their IP
  // past the per-IP limiter. e.g. "uniquelocal" behind the compose nginx.
  trustProxy: env.TRUST_PROXY || false,
};

if (config.env === 'production' && config.jwtSecret.startsWith('dev-only')) {
  throw new Error('JWT_SECRET must be set in production');
}
