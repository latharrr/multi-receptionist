-- Spec §5 data model. Conventions:
--  * created_at/updated_at, the updated_at trigger, RLS, the tenant policy and app_user
--    grants are applied to every table by the loop at the bottom, so no table can miss them.
--  * Every tenant table has UNIQUE (workspace_id, id); children reference (workspace_id, x_id)
--    so a row can never point at another tenant's parent.
--  * States are text + CHECK (cheaper to migrate than enum types). Edges live in @lathar/contracts.

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN CREATE ROLE app_user NOLOGIN; END IF;
END $$;

CREATE FUNCTION app_workspace_id() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.workspace_id', true), '')::uuid $$;
CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS
  $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

-- Knowledge/behavior versions: only status may change once a row leaves draft.
CREATE FUNCTION immutable_after_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft'
     AND (to_jsonb(OLD) - '{status,updated_at}'::text[]) <> (to_jsonb(NEW) - '{status,updated_at}'::text[]) THEN
    RAISE EXCEPTION '% % is immutable after draft', TG_TABLE_NAME, OLD.id;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- identity

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(btrim(email))),
  auth_identity_ref text UNIQUE,
  verified_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled'))
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  country text,
  timezone text NOT NULL DEFAULT 'UTC',
  language text NOT NULL DEFAULT 'en',
  state text NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft', 'configuring', 'testing', 'ready', 'active', 'paused', 'suspended', 'closing')),
  lock_version int NOT NULL DEFAULT 1,
  owner_user_id uuid NOT NULL REFERENCES users (id)
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  user_id uuid NOT NULL REFERENCES users (id),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'support_agent')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'revoked')),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, user_id)
);

CREATE TABLE permission_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  grantee_user_id uuid NOT NULL,
  capability text NOT NULL,
  granted_by uuid NOT NULL REFERENCES users (id),
  expires_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, grantee_user_id) REFERENCES memberships (workspace_id, user_id)
);

CREATE TABLE support_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  operator_user_id uuid NOT NULL REFERENCES users (id),
  purpose text NOT NULL,
  scope jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  approved_by uuid NOT NULL REFERENCES users (id),
  revoked_at timestamptz,
  UNIQUE (workspace_id, id)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  actor_user_id uuid REFERENCES users (id), -- NULL = system
  action text NOT NULL,
  target jsonb NOT NULL DEFAULT '{}', -- IDs only; never bodies or secrets
  metadata jsonb NOT NULL DEFAULT '{}',
  outcome text NOT NULL DEFAULT 'ok',
  UNIQUE (workspace_id, id)
);

-- ---------------------------------------------------------------- durable work

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  kind text NOT NULL CHECK (kind IN (
    'import_source', 'extract_draft', 'process_inbound', 'generate_reply', 'submit_message',
    'reconcile_delivery', 'send_handoff_notice', 'validate_ai_config', 'verify_connection',
    'export_workspace', 'delete_workspace', 'purge_expired_data')),
  dedupe_key text NOT NULL,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'leased', 'complete', 'retry_wait', 'dead_letter')),
  payload_ref jsonb NOT NULL DEFAULT '{}',
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  error_code text,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, kind, dedupe_key)
);
CREATE INDEX jobs_lease ON jobs (available_at) WHERE state IN ('queued', 'retry_wait');

-- ---------------------------------------------------------------- onboarding & knowledge

CREATE TABLE business_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL UNIQUE REFERENCES workspaces (id),
  draft_type text,
  confirmed_type text,
  display_name text,
  facts jsonb NOT NULL DEFAULT '{}', -- not the reply authority; knowledge_versions is
  UNIQUE (workspace_id, id)
);

CREATE TABLE sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  type text NOT NULL CHECK (type IN ('url', 'file', 'text', 'faq')),
  url text,
  object_key text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'importing', 'imported', 'failed')),
  content_hash text,
  imported_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}',
  UNIQUE (workspace_id, id)
);

CREATE TABLE import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  source_id uuid NOT NULL,
  job_id uuid,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'complete', 'failed')),
  attempt_count int NOT NULL DEFAULT 0,
  error_code text,
  extraction_version text,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, source_id) REFERENCES sources (workspace_id, id),
  FOREIGN KEY (workspace_id, job_id) REFERENCES jobs (workspace_id, id)
);

CREATE TABLE fact_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  source_id uuid, -- NULL = entered manually
  field_path text NOT NULL,
  value jsonb NOT NULL,
  evidence text,
  confidence text CHECK (confidence IN ('low', 'medium', 'high')),
  conflict_group uuid,
  review_state text NOT NULL DEFAULT 'pending'
    CHECK (review_state IN ('pending', 'accepted', 'edited', 'rejected')),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, source_id) REFERENCES sources (workspace_id, id)
);

CREATE TABLE clarification_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  field_path text NOT NULL,
  reason text NOT NULL,
  priority int NOT NULL DEFAULT 0,
  optional boolean NOT NULL DEFAULT false,
  answer jsonb,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'active', 'answered', 'skipped')),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, field_path)
);
CREATE UNIQUE INDEX one_active_question ON clarification_questions (workspace_id) WHERE state = 'active';

CREATE TABLE knowledge_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  sequence int NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'published', 'superseded')),
  content jsonb NOT NULL,
  content_hash text,
  approved_by uuid REFERENCES users (id),
  approved_at timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, sequence),
  CHECK (status = 'draft' OR approved_by IS NOT NULL)
);
CREATE UNIQUE INDEX one_published_knowledge ON knowledge_versions (workspace_id) WHERE status = 'published';
CREATE TRIGGER immutable_after_draft BEFORE UPDATE ON knowledge_versions
  FOR EACH ROW EXECUTE FUNCTION immutable_after_draft();

CREATE TABLE behavior_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  sequence int NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'published', 'superseded')),
  instructions text NOT NULL DEFAULT '',
  allowed jsonb NOT NULL DEFAULT '{}', -- enquiry fields / fixed actions
  handoff_policy jsonb NOT NULL DEFAULT '{}',
  approved_by uuid REFERENCES users (id),
  approved_at timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, sequence),
  CHECK (status = 'draft' OR approved_by IS NOT NULL)
);
CREATE UNIQUE INDEX one_published_behavior ON behavior_versions (workspace_id) WHERE status = 'published';
CREATE TRIGGER immutable_after_draft BEFORE UPDATE ON behavior_versions
  FOR EACH ROW EXECUTE FUNCTION immutable_after_draft();

-- ---------------------------------------------------------------- secrets, routes, AI

CREATE TABLE secret_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  kind text NOT NULL,
  ciphertext bytea NOT NULL, -- envelope-encrypted; key material lives outside the database
  key_version text NOT NULL,
  masked_label text NOT NULL,
  rotated_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (workspace_id, id)
);

CREATE TABLE connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  route text NOT NULL CHECK (route IN ('official_cloud_api', 'unofficial_qr')),
  state text NOT NULL DEFAULT 'unconfigured' CHECK (state IN (
    'unconfigured', 'pending_auth', 'connecting', 'connected', 'needs_action', 'disconnected', 'revoked')),
  verified_business_id text,
  verified_number_id text,
  masked_number text,
  secret_ref_id uuid,
  last_health text,
  last_health_at timestamptz,
  version int NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, secret_ref_id) REFERENCES secret_refs (workspace_id, id)
);
-- A provider number resolves to at most one connected tenant (server-owned callback mapping).
CREATE UNIQUE INDEX one_connected_number ON connections (route, verified_number_id) WHERE state = 'connected';

CREATE TABLE connection_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  connection_id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users (id),
  disclosure_version text NOT NULL,
  route text NOT NULL,
  authorized_number text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connections (workspace_id, id)
);

-- Global registry. Deliberately ships empty: rows are added only with checked provenance.
CREATE TABLE model_capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  model_id text NOT NULL,
  adapter_version text NOT NULL,
  supports jsonb NOT NULL,
  verified_at timestamptz NOT NULL,
  provenance text NOT NULL,
  UNIQUE (provider, model_id, adapter_version)
);

CREATE TABLE ai_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  provider text NOT NULL CHECK (provider IN ('anthropic', 'groq', 'nvidia', 'custom')),
  endpoint text,
  model_id text NOT NULL,
  capability_snapshot jsonb,
  secret_ref_id uuid,
  revision int NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft', 'validating', 'valid', 'active', 'invalid', 'revoked')),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, secret_ref_id) REFERENCES secret_refs (workspace_id, id)
);

-- ---------------------------------------------------------------- money

CREATE TABLE budget_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  funding_source text NOT NULL CHECK (funding_source IN ('platform', 'byok')),
  provider text NOT NULL,
  period text NOT NULL CHECK (period IN ('day', 'month', 'total')),
  currency text NOT NULL,
  hard_limit_minor bigint NOT NULL CHECK (hard_limit_minor >= 0),
  reserved_minor bigint NOT NULL DEFAULT 0 CHECK (reserved_minor >= 0),
  settled_minor bigint NOT NULL DEFAULT 0 CHECK (settled_minor >= 0),
  max_requests int,
  max_tokens bigint,
  approved_by uuid NOT NULL REFERENCES users (id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  UNIQUE (workspace_id, id),
  -- Reservations are plain UPDATEs; the row lock + this check make over-reservation impossible.
  CONSTRAINT budget_cap CHECK (reserved_minor + settled_minor <= hard_limit_minor)
);

CREATE TABLE usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  provider text NOT NULL,
  account_ref text,
  model_id text,
  category text NOT NULL,
  quantities jsonb NOT NULL DEFAULT '{}', -- integer token/request counts
  cost_minor bigint,
  currency text,
  is_estimate boolean NOT NULL,
  attribution_key text NOT NULL,
  measured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, attribution_key)
);

CREATE TABLE test_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  type text NOT NULL,
  ai_config_id uuid,
  ai_config_revision int,
  knowledge_version_id uuid,
  mode text NOT NULL CHECK (mode IN ('mock', 'live')),
  authorized_by uuid REFERENCES users (id),
  cost_ceiling_minor bigint,
  currency text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'passed', 'failed')),
  results jsonb,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, ai_config_id) REFERENCES ai_configs (workspace_id, id),
  FOREIGN KEY (workspace_id, knowledge_version_id) REFERENCES knowledge_versions (workspace_id, id),
  CHECK (mode = 'mock' OR (authorized_by IS NOT NULL AND cost_ceiling_minor IS NOT NULL))
);

CREATE TABLE activation_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  connection_id uuid NOT NULL,
  connection_version int NOT NULL,
  ai_config_id uuid NOT NULL,
  ai_config_revision int NOT NULL,
  knowledge_version_id uuid NOT NULL,
  behavior_version_id uuid NOT NULL,
  budget_limit_id uuid NOT NULL,
  consent_version text NOT NULL,
  approved_by uuid NOT NULL REFERENCES users (id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connections (workspace_id, id),
  FOREIGN KEY (workspace_id, ai_config_id) REFERENCES ai_configs (workspace_id, id),
  FOREIGN KEY (workspace_id, knowledge_version_id) REFERENCES knowledge_versions (workspace_id, id),
  FOREIGN KEY (workspace_id, behavior_version_id) REFERENCES behavior_versions (workspace_id, id),
  FOREIGN KEY (workspace_id, budget_limit_id) REFERENCES budget_limits (workspace_id, id)
);

-- ---------------------------------------------------------------- conversations

CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  connection_id uuid NOT NULL,
  provider_customer_id text NOT NULL,
  name text,
  fields jsonb NOT NULL DEFAULT '{}',
  UNIQUE (workspace_id, id),
  UNIQUE (connection_id, provider_customer_id),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connections (workspace_id, id)
);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  connection_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  mode text NOT NULL DEFAULT 'bot' CHECK (mode IN ('bot', 'handoff_requested', 'human', 'resolved')),
  assigned_user_id uuid,
  last_message_at timestamptz,
  control_version int NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, contact_id),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connections (workspace_id, id),
  FOREIGN KEY (workspace_id, contact_id) REFERENCES contacts (workspace_id, id),
  FOREIGN KEY (workspace_id, assigned_user_id) REFERENCES memberships (workspace_id, user_id)
);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  conversation_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sender text NOT NULL CHECK (sender IN ('customer', 'bot', 'staff')),
  external_message_id text, -- absent until the provider assigns one
  type text NOT NULL DEFAULT 'text',
  body text,
  state text NOT NULL CHECK (state IN (
    'received', 'queued', 'generated', 'reserved', 'submitting', 'accepted', 'delivered', 'read',
    'failed', 'uncertain')),
  provider_ts timestamptz,
  received_at timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations (workspace_id, id),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connections (workspace_id, id)
);
CREATE UNIQUE INDEX messages_external_id ON messages (connection_id, external_message_id)
  WHERE external_message_id IS NOT NULL;

CREATE TABLE inbound_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id), -- derived server-side from the connection
  connection_id uuid NOT NULL,
  external_event_key text NOT NULL, -- receipts/statuses carry their own key, not the message's
  kind text NOT NULL,
  payload_hash text NOT NULL,
  state text NOT NULL DEFAULT 'received' CHECK (state IN ('received', 'processed', 'ignored', 'failed')),
  UNIQUE (workspace_id, id),
  UNIQUE (connection_id, external_event_key),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connections (workspace_id, id)
);

CREATE TABLE reply_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  conversation_id uuid NOT NULL,
  trigger_message_ids uuid[] NOT NULL,
  knowledge_version_id uuid NOT NULL,
  behavior_version_id uuid NOT NULL,
  ai_config_id uuid NOT NULL,
  ai_config_revision int NOT NULL,
  control_version int NOT NULL,
  generation_state text NOT NULL DEFAULT 'pending',
  check_state text NOT NULL DEFAULT 'pending',
  result_hash text, -- no model reasoning is stored
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations (workspace_id, id),
  FOREIGN KEY (workspace_id, knowledge_version_id) REFERENCES knowledge_versions (workspace_id, id),
  FOREIGN KEY (workspace_id, behavior_version_id) REFERENCES behavior_versions (workspace_id, id),
  FOREIGN KEY (workspace_id, ai_config_id) REFERENCES ai_configs (workspace_id, id)
);

CREATE TABLE delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  message_id uuid NOT NULL,
  logical_send_key text NOT NULL,
  provider_message_id text,
  state text NOT NULL DEFAULT 'reserved'
    CHECK (state IN ('reserved', 'submitting', 'accepted', 'failed', 'uncertain')),
  attempt_number int NOT NULL DEFAULT 1,
  submitted_at timestamptz,
  error_code text, -- sanitized, never a raw provider error
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, logical_send_key),
  FOREIGN KEY (workspace_id, message_id) REFERENCES messages (workspace_id, id)
);

CREATE TABLE handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  conversation_id uuid NOT NULL,
  reason text NOT NULL,
  notice_state text NOT NULL DEFAULT 'pending' CHECK (notice_state IN ('pending', 'sent', 'failed')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  assignee_user_id uuid,
  resolution text,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations (workspace_id, id),
  FOREIGN KEY (workspace_id, assignee_user_id) REFERENCES memberships (workspace_id, user_id)
);

CREATE TABLE enquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  conversation_id uuid NOT NULL,
  fields jsonb NOT NULL DEFAULT '{}',
  provenance jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'open', 'closed')),
  assignee_user_id uuid,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations (workspace_id, id),
  FOREIGN KEY (workspace_id, assignee_user_id) REFERENCES memberships (workspace_id, user_id)
);

-- ---------------------------------------------------------------- export / deletion

CREATE TABLE export_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  requester_user_id uuid NOT NULL REFERENCES users (id),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'complete', 'failed', 'expired')),
  result_ref text,
  expires_at timestamptz,
  UNIQUE (workspace_id, id)
);

CREATE TABLE deletion_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  requester_user_id uuid NOT NULL REFERENCES users (id),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'running', 'complete', 'failed')),
  manifest jsonb NOT NULL DEFAULT '{}',
  scheduled_for timestamptz,
  UNIQUE (workspace_id, id)
);

-- ---------------------------------------------------------------- applied to every table

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT relname FROM pg_class
           WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname <> 'schema_migrations'
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
                                   ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now()', t);
    EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I
                    FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
    IF EXISTS (SELECT FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = t AND column_name = 'workspace_id') THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('CREATE POLICY tenant ON %I USING (workspace_id = app_workspace_id())', t);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t);
    END IF;
  END LOOP;
END $$;

-- Tables without workspace_id.
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON workspaces USING (id = app_workspace_id());
CREATE POLICY member_read ON workspaces FOR SELECT
  USING (id IN (SELECT workspace_id FROM memberships WHERE user_id = app_user_id() AND status = 'active'));
GRANT SELECT, INSERT, UPDATE ON workspaces TO app_user;

-- Lets a user list their own memberships across workspaces; read-only on purpose.
CREATE POLICY own_read ON memberships FOR SELECT USING (user_id = app_user_id());

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY self_or_comember ON users
  USING (id = app_user_id() OR id IN (SELECT user_id FROM memberships))
  WITH CHECK (id = app_user_id());
GRANT SELECT, INSERT, UPDATE ON users TO app_user;

GRANT SELECT ON model_capabilities TO app_user;

-- Append-only through the application role.
REVOKE UPDATE, DELETE ON audit_events, activation_snapshots, usage_events FROM app_user;

-- The request role can store and revoke secrets but never read ciphertext back.
REVOKE SELECT, UPDATE, DELETE ON secret_refs FROM app_user;
GRANT SELECT (id, workspace_id, kind, key_version, masked_label, rotated_at, revoked_at, created_at, updated_at),
      UPDATE (rotated_at, revoked_at)
  ON secret_refs TO app_user;

CREATE INDEX ON conversations (workspace_id, last_message_at DESC);
CREATE INDEX ON messages (workspace_id, conversation_id, created_at);
CREATE INDEX ON audit_events (workspace_id, created_at);
