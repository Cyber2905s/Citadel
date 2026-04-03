-- Row-Level Security: every tenant-scoped row is visible only when
-- app.tenant_id (set per transaction via set_config(..., true)) matches.
-- Unset => NULL => no rows. FORCE makes it apply to the table owner too.

CREATE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (id = current_tenant_id())
  WITH CHECK (id = current_tenant_id());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['memberships', 'invitations', 'api_keys', 'audit_logs',
                           'usage_daily', 'projects', 'tasks']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = current_tenant_id())
         WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

-- The few lookups that must happen *before* a tenant is known go through
-- narrow SECURITY DEFINER functions instead of giving the app role BYPASSRLS.

CREATE FUNCTION auth_api_key(p_key_hash text)
  RETURNS TABLE (id uuid, tenant_id uuid, role text)
  LANGUAGE sql SECURITY DEFINER SET search_path = public
  AS $$
    UPDATE api_keys k SET last_used_at = now()
    FROM tenants t
    WHERE k.key_hash = p_key_hash AND k.revoked_at IS NULL
      AND t.id = k.tenant_id AND t.deleted_at IS NULL
    RETURNING k.id, k.tenant_id, k.role
  $$;

CREATE FUNCTION user_tenants(p_user_id uuid)
  RETURNS TABLE (tenant_id uuid, name text, plan text, role text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT t.id, t.name, t.plan, m.role
    FROM memberships m JOIN tenants t ON t.id = m.tenant_id
    WHERE m.user_id = p_user_id AND m.deleted_at IS NULL AND t.deleted_at IS NULL
    ORDER BY m.id
  $$;

CREATE FUNCTION invitation_by_token(p_token_hash text)
  RETURNS TABLE (id uuid, tenant_id uuid, email text, role text,
                 expires_at timestamptz, accepted_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT i.id, i.tenant_id, i.email, i.role, i.expires_at, i.accepted_at
    FROM invitations i WHERE i.token_hash = p_token_hash
  $$;
