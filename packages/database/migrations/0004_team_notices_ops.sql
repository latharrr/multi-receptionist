-- Team invitations, staff handoff notices, monthly limits, worker heartbeat and operator diagnostics.

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_operator') THEN CREATE ROLE app_operator NOLOGIN; END IF;
END $$;

-- ---------------------------------------------------------------- monthly spending limit
-- The count restarts each calendar month in the workspace's timezone (see usage.ts).
ALTER TABLE budget_limits ADD COLUMN period_start date NOT NULL DEFAULT date_trunc('month', now())::date;
UPDATE budget_limits SET period = 'month';

-- ---------------------------------------------------------------- team
-- The web role cannot see or create other people's user rows, so inviting goes through this
-- function. It re-checks the caller's own role: owners invite anyone, admins invite agents.
CREATE FUNCTION invite_member(p_email text, p_role text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE my_role text; u uuid; m uuid;
BEGIN
  SELECT role INTO my_role FROM memberships
    WHERE workspace_id = app_workspace_id() AND user_id = app_user_id() AND status = 'active';
  IF p_role NOT IN ('admin', 'support_agent') OR my_role IS NULL
     OR NOT (my_role = 'owner' OR (my_role = 'admin' AND p_role = 'support_agent')) THEN
    RAISE EXCEPTION 'not allowed to invite' USING ERRCODE = '42501';
  END IF;
  INSERT INTO users (email) VALUES (lower(btrim(p_email)))
    ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id INTO u;
  INSERT INTO memberships (workspace_id, user_id, role, status) VALUES (app_workspace_id(), u, p_role, 'invited')
    ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'invited'
      WHERE memberships.status = 'revoked'
    RETURNING id INTO m;
  RETURN m; -- NULL: already a member or already invited
END $$;

-- An invited person is not a member yet, so they cannot read the workspace row themselves.
CREATE FUNCTION my_invitations() RETURNS TABLE (id uuid, workspace_name text, role text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.id, w.name, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
  WHERE m.user_id = app_user_id() AND m.status = 'invited' ORDER BY m.created_at
$$;

CREATE FUNCTION accept_invitation(p_id uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE w uuid;
BEGIN
  UPDATE memberships SET status = 'active'
    WHERE id = p_id AND user_id = app_user_id() AND status = 'invited'
      AND EXISTS (SELECT FROM users WHERE id = app_user_id() AND verified_at IS NOT NULL AND status = 'active')
    RETURNING workspace_id INTO w;
  IF w IS NOT NULL THEN
    INSERT INTO audit_events (workspace_id, actor_user_id, action, target)
      VALUES (w, app_user_id(), 'member.accept', jsonb_build_object('membership_id', p_id));
  END IF;
  RETURN w;
END $$;

REVOKE ALL ON FUNCTION invite_member, my_invitations, accept_invitation FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invite_member, my_invitations, accept_invitation TO app_user;

-- ---------------------------------------------------------------- staff handoff notices
-- One row per recipient, so a retry never sends twice to someone who already got it.
ALTER TABLE handoffs DROP CONSTRAINT handoffs_notice_state_check;
ALTER TABLE handoffs ADD CONSTRAINT handoffs_notice_state_check
  CHECK (notice_state IN ('pending', 'sent', 'failed', 'skipped')); -- skipped: staff took over first

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  handoff_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users (id),
  channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('email')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'sent', 'failed')),
  error_code text, -- sanitized, never a raw provider error
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (handoff_id, user_id),
  FOREIGN KEY (workspace_id, handoff_id) REFERENCES handoffs (workspace_id, id)
);
CREATE TRIGGER set_updated_at BEFORE UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON notifications USING (workspace_id = app_workspace_id());
GRANT SELECT ON notifications TO app_user;
GRANT SELECT, INSERT, UPDATE ON notifications TO app_worker;
-- The worker addresses notices to the tenant's own members only (row-level security still applies).
GRANT SELECT (id, email, status) ON users TO app_worker;
GRANT INSERT ON local_mail TO app_worker; -- development mail sink only

-- ---------------------------------------------------------------- operator diagnostics
CREATE TABLE worker_heartbeats (name text PRIMARY KEY, seen_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT, INSERT, UPDATE ON worker_heartbeats TO app_worker;

-- Fleet health for platform support: counts, states and IDs only. No message text, customer
-- numbers, job payloads, emails or secrets leave through here.
CREATE FUNCTION operator_diagnostics() RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'workspaces', (SELECT jsonb_build_object('total', count(*), 'automation_paused', count(*) FILTER (WHERE replies_paused_at IS NOT NULL)) FROM workspaces),
    'workers', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', name, 'seconds_ago', floor(extract(epoch FROM now() - seen_at))::int) ORDER BY seen_at DESC), '[]')
                FROM worker_heartbeats WHERE seen_at > now() - interval '1 day'),
    'jobs_open', (SELECT coalesce(jsonb_agg(to_jsonb(j)), '[]') FROM (
                    SELECT kind, state, count(*)::int AS n, floor(extract(epoch FROM now() - min(created_at)))::int AS oldest_seconds
                    FROM jobs WHERE state <> 'complete' GROUP BY kind, state ORDER BY kind, state) j),
    'jobs_completed_24h', (SELECT count(*) FROM jobs WHERE state = 'complete' AND updated_at > now() - interval '1 day'),
    'jobs_needing_attention', (SELECT coalesce(jsonb_agg(to_jsonb(j)), '[]') FROM (
                    SELECT id, workspace_id, kind, CASE WHEN state = 'leased' THEN 'lease_expired' ELSE state END AS state,
                           attempts, max_attempts, error_code, updated_at
                    FROM jobs WHERE state IN ('dead_letter', 'retry_wait') OR (state = 'leased' AND lease_until < now())
                    ORDER BY updated_at DESC LIMIT 50) j),
    'sends_24h', (SELECT coalesce(jsonb_agg(to_jsonb(s)), '[]') FROM (
                    SELECT state, error_code, count(*)::int AS n FROM delivery_attempts
                    WHERE updated_at > now() - interval '1 day' GROUP BY state, error_code ORDER BY state, error_code) s),
    'connections', (SELECT coalesce(jsonb_agg(to_jsonb(c)), '[]') FROM (
                    SELECT route, mode, state, count(*)::int AS n FROM connections GROUP BY route, mode, state ORDER BY route, mode, state) c),
    'staff_notices', (SELECT coalesce(jsonb_agg(to_jsonb(h)), '[]') FROM (
                    SELECT notice_state AS state, count(*)::int AS n FROM handoffs GROUP BY notice_state ORDER BY notice_state) h)
  )
$$;
REVOKE ALL ON FUNCTION operator_diagnostics FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_diagnostics TO app_operator;
