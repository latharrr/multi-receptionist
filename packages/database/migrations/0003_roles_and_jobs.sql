-- Separate restricted roles per process (spec §4): web requests, the job worker, provider
-- callbacks and the auth library. Each connects as its own login role; none can switch role.

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['app_worker', 'app_callback', 'app_auth'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
  END LOOP;
END $$;

-- Sessions and sign-in tokens now belong to the auth library, in a schema only it can reach.
DROP TABLE signin_tokens, sessions;
CREATE SCHEMA auth AUTHORIZATION app_auth;

-- The web role may not search users by identity (RLS hides other users), so this one
-- narrow function maps a verified auth identity to its user row, creating it on first sign-in.
CREATE FUNCTION user_for_identity(p_ref text, p_email text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE u users;
BEGIN
  SELECT * INTO u FROM users WHERE auth_identity_ref = p_ref;
  IF NOT FOUND THEN
    INSERT INTO users (email, auth_identity_ref, verified_at) VALUES (lower(btrim(p_email)), p_ref, now())
    ON CONFLICT (email) DO UPDATE SET auth_identity_ref = EXCLUDED.auth_identity_ref,
                                      verified_at = COALESCE(users.verified_at, now())
    RETURNING * INTO u;
  END IF;
  RETURN CASE WHEN u.status = 'active' THEN u.id END; -- a disabled user has no identity here
END $$;
REVOKE ALL ON FUNCTION user_for_identity FROM PUBLIC;
GRANT EXECUTE ON FUNCTION user_for_identity TO app_user;
GRANT INSERT, SELECT ON local_mail TO app_user; -- development mail sink only

-- ---------------------------------------------------------------- worker
-- Same tenant policy as web requests for everything, plus cross-tenant leasing of jobs only.
ALTER TABLE jobs ADD COLUMN result jsonb;
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables b USING (table_schema, table_name)
           WHERE c.table_schema = 'public' AND c.column_name = 'workspace_id' AND b.table_type = 'BASE TABLE' LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_worker', t);
  END LOOP;
END $$;
GRANT SELECT ON workspaces, model_capabilities TO app_worker;
REVOKE UPDATE, DELETE ON audit_events, activation_snapshots, usage_events FROM app_worker;
REVOKE SELECT, UPDATE, DELETE ON secret_refs FROM app_worker;
GRANT SELECT (id, workspace_id, kind, key_version, masked_label, rotated_at, revoked_at) ON secret_refs TO app_worker;
CREATE POLICY worker_lease ON jobs TO app_worker USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------- callbacks
-- A callback never names its tenant. It presents the provider's number ID; the server-owned
-- mapping decides the workspace. It can then record the event and enqueue work, nothing else.
CREATE FUNCTION resolve_connection(p_route text, p_number_id text)
  RETURNS TABLE (workspace_id uuid, connection_id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT c.workspace_id, c.id FROM connections c
  WHERE c.route = p_route AND c.verified_number_id = p_number_id AND c.state = 'connected'
$$;
REVOKE ALL ON FUNCTION resolve_connection FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_connection TO app_callback;
GRANT INSERT, SELECT (id, workspace_id, connection_id, external_event_key) ON inbound_events TO app_callback;
GRANT INSERT ON jobs TO app_callback;

-- One spending limit per workspace in this build.
CREATE UNIQUE INDEX one_budget_limit ON budget_limits (workspace_id);
-- One editable draft of assistant settings at a time.
CREATE UNIQUE INDEX one_draft_behavior ON behavior_versions (workspace_id) WHERE status = 'draft';
