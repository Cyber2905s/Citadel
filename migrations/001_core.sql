-- Core identity + tenancy tables.
-- Tenant-scoped tables carry tenant_id and are protected by RLS (see 003_rls.sql).
-- IDs are UUIDv7 (time-ordered) so "ORDER BY id" doubles as creation order for cursor pagination.

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  name        text NOT NULL,
  plan        text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'enterprise')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

-- Users are global: one person can belong to many orgs.
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  email          text NOT NULL UNIQUE,
  name           text NOT NULL,
  password_hash  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  role        text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE UNIQUE INDEX memberships_active_uniq ON memberships (tenant_id, user_id) WHERE deleted_at IS NULL;
CREATE INDEX memberships_user_idx ON memberships (user_id);

-- Refresh tokens rotate on every use; family_id groups a chain so reuse of an
-- already-rotated token revokes the whole chain.
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id     uuid NOT NULL REFERENCES users(id),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  family_id   uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);

CREATE TABLE invitations (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  email        text NOT NULL,
  role         text NOT NULL CHECK (role IN ('admin', 'member')),
  token_hash   text NOT NULL UNIQUE,
  invited_by   uuid NOT NULL REFERENCES users(id),
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_tenant_idx ON invitations (tenant_id);

CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  name          text NOT NULL,
  prefix        text NOT NULL,
  key_hash      text NOT NULL UNIQUE,
  role          text NOT NULL CHECK (role IN ('admin', 'member')),
  created_by    uuid NOT NULL REFERENCES users(id),
  last_used_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);
CREATE INDEX api_keys_tenant_idx ON api_keys (tenant_id);

CREATE TABLE audit_logs (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  actor_type   text NOT NULL CHECK (actor_type IN ('user', 'api_key', 'system')),
  actor_id     uuid,
  action       text NOT NULL,
  target_type  text,
  target_id    uuid,
  metadata     jsonb NOT NULL DEFAULT '{}',
  ip           text,
  request_id   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_tenant_id_idx ON audit_logs (tenant_id, id DESC);

CREATE TABLE usage_daily (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  day        date NOT NULL,
  metric     text NOT NULL,
  count      bigint NOT NULL,
  PRIMARY KEY (tenant_id, day, metric)
);
