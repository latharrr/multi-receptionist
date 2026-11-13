-- Pilot: fenced job leases, supervised drafts, real costs in micro-dollars, live connections,
-- delivery receipts, platform controls with an operator audit trail, and retention.

-- ---------------------------------------------------------------- job ownership
-- A lease is owned by a token. Every write a handler makes re-checks the token, so a worker
-- that stalled and lost its lease can no longer change anything (fencing).
ALTER TABLE jobs ADD COLUMN lease_token uuid;
-- 'qr' jobs can only be run by the gateway process that holds the linked-device sockets.
ALTER TABLE jobs ADD COLUMN queue text NOT NULL DEFAULT 'default' CHECK (queue IN ('default', 'qr'));

-- Test chat runs in the worker too: only the worker can open the tenant's API key.
ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN (
  'import_source', 'extract_draft', 'process_inbound', 'generate_reply', 'submit_message',
  'reconcile_delivery', 'send_handoff_notice', 'validate_ai_config', 'verify_connection',
  'export_workspace', 'delete_workspace', 'purge_expired_data', 'sample_chat'));

-- ---------------------------------------------------------------- supervised replies
ALTER TABLE messages DROP CONSTRAINT messages_state_check;
ALTER TABLE messages ADD CONSTRAINT messages_state_check CHECK (state IN (
  'received', 'queued', 'generated', 'reserved', 'submitting', 'accepted', 'delivered', 'read',
  'failed', 'uncertain',
  'draft',      -- written by the assistant, waiting for a member of staff to approve
  'discarded'   -- a draft that was rejected or overtaken by a newer customer message
));
ALTER TABLE messages ADD COLUMN approved_by uuid REFERENCES users (id);
ALTER TABLE workspaces
  ADD COLUMN reply_mode text NOT NULL DEFAULT 'supervised' CHECK (reply_mode IN ('supervised', 'autonomous')),
  ADD COLUMN retention_days int CHECK (retention_days BETWEEN 1 AND 3650),
  ADD COLUMN live_allowed_at timestamptz; -- set by a platform operator, one pilot at a time
ALTER TABLE conversations ADD COLUMN last_inbound_at timestamptz; -- start of the provider's reply window

-- ---------------------------------------------------------------- live connections
ALTER TABLE connections
  ADD COLUMN link_artifact text,        -- short-lived QR payload; cleared on link, expiry or failure
  ADD COLUMN provider_account jsonb NOT NULL DEFAULT '{}', -- non-secret provider IDs
  ADD COLUMN authorized_number text,    -- digits the owner said they want connected
  ADD COLUMN last_error text;           -- sanitized code, never a raw provider error
ALTER TABLE ai_configs ADD COLUMN last_error text, ADD COLUMN validated_at timestamptz;

-- The worker and gateway use tenant keys to call providers; the web role still cannot read them.
GRANT SELECT ON secret_refs TO app_worker; -- row-level security still limits it to the job's tenant

-- ---------------------------------------------------------------- money in micro-dollars
-- A single AI reply costs a fraction of a cent, so cents are too coarse. 1 USD = 1,000,000.
ALTER TABLE budget_limits RENAME COLUMN hard_limit_minor TO hard_limit_micros;
ALTER TABLE budget_limits RENAME COLUMN reserved_minor TO reserved_micros;
ALTER TABLE budget_limits RENAME COLUMN settled_minor TO settled_micros;
UPDATE budget_limits SET hard_limit_micros = hard_limit_micros * 10000, reserved_micros = reserved_micros * 10000, settled_micros = settled_micros * 10000;
ALTER TABLE usage_events RENAME COLUMN cost_minor TO cost_micros;
UPDATE usage_events SET cost_micros = cost_micros * 10000;
-- Where each figure came from: provider-reported tokens at list price, a provider receipt, or synthetic.
ALTER TABLE usage_events ADD COLUMN provenance text NOT NULL DEFAULT 'synthetic';
-- WhatsApp charges per message at rates this system does not know, so messages are capped by count.
ALTER TABLE budget_limits
  ADD COLUMN message_cap int CHECK (message_cap >= 0),
  ADD COLUMN messages_used int NOT NULL DEFAULT 0,
  ADD CONSTRAINT message_cap_check CHECK (message_cap IS NULL OR messages_used <= message_cap);

-- ---------------------------------------------------------------- staff notice outbox
ALTER TABLE notifications DROP CONSTRAINT notifications_state_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_state_check
  CHECK (state IN ('queued', 'sending', 'sent', 'failed', 'uncertain'));

-- Deleting one customer's data on request removes their notices too.
GRANT DELETE ON notifications TO app_user;

-- ---------------------------------------------------------------- platform controls
-- Facts the web process publishes for the others (its public address).
CREATE TABLE runtime_info (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT, INSERT, UPDATE ON runtime_info TO app_user;
GRANT SELECT ON runtime_info TO app_worker;

-- Switches only a platform operator can change. 'sending_stopped' halts every outbound send.
CREATE TABLE platform_controls (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO platform_controls (key, value) VALUES ('sending_stopped', 'false');
GRANT SELECT ON platform_controls TO app_user, app_worker, app_operator;

-- What operators looked at and changed. IDs and action names only; append-only.
CREATE TABLE operator_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_email text NOT NULL,
  action text NOT NULL,
  target jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION operator_log(p_email text, p_action text, p_target jsonb) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO operator_audit (operator_email, action, target) VALUES (p_email, p_action, p_target)
$$;
CREATE FUNCTION operator_audit_recent() RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.created_at DESC), '[]')
  FROM (SELECT operator_email, action, target, created_at FROM operator_audit ORDER BY created_at DESC LIMIT 50) a
$$;
CREATE FUNCTION operator_set_control(p_email text, p_key text, p_value text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE platform_controls SET value = p_value, updated_at = now() WHERE key = p_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown control'; END IF;
  INSERT INTO operator_audit (operator_email, action, target) VALUES (p_email, 'control.set', jsonb_build_object('key', p_key, 'value', p_value));
END $$;
-- Real customers can only be switched on for a workspace an operator has allowed.
CREATE FUNCTION operator_allow_live(p_email text, p_workspace uuid, p_allow boolean) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE workspaces SET live_allowed_at = CASE WHEN p_allow THEN now() END,
                        state = CASE WHEN NOT p_allow AND state = 'active' THEN 'paused' ELSE state END
    WHERE id = p_workspace;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown workspace'; END IF;
  INSERT INTO operator_audit (operator_email, action, target)
    VALUES (p_email, CASE WHEN p_allow THEN 'live.allow' ELSE 'live.revoke' END, jsonb_build_object('workspace_id', p_workspace));
END $$;
REVOKE ALL ON FUNCTION operator_log, operator_audit_recent, operator_set_control, operator_allow_live FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_log, operator_audit_recent, operator_set_control, operator_allow_live TO app_operator;

-- ---------------------------------------------------------------- provider callbacks
-- Unknown or disconnected numbers still resolve to nothing; live events also need the workspace
-- to be switched on, mock connections never do.
CREATE OR REPLACE FUNCTION resolve_connection(p_route text, p_number_id text)
  RETURNS TABLE (workspace_id uuid, connection_id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT c.workspace_id, c.id FROM connections c JOIN workspaces w ON w.id = c.workspace_id
  WHERE c.route = p_route AND c.verified_number_id = p_number_id AND c.state = 'connected'
    AND (c.mode = 'mock' OR w.state = 'active')
$$;

-- A delivery receipt moves a message forward only (accepted < delivered < read). `failed` never
-- overwrites proof of delivery. Returns false when the message is not known.
CREATE FUNCTION record_receipt(p_route text, p_number_id text, p_provider_message_id text, p_status text,
                               p_billable boolean, p_category text, p_error text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m record; rank_now int; rank_new int;
  ranks CONSTANT text[] := ARRAY['uncertain', 'submitting', 'accepted', 'delivered', 'read'];
BEGIN
  SELECT x.id, x.workspace_id, x.state INTO m FROM messages x JOIN connections c ON c.id = x.connection_id
    WHERE c.route = p_route AND c.verified_number_id = p_number_id AND x.external_message_id = p_provider_message_id
      AND x.direction = 'outbound' FOR UPDATE OF x;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_status = 'failed' THEN
    IF m.state IN ('accepted', 'submitting', 'uncertain') THEN
      UPDATE messages SET state = 'failed' WHERE id = m.id;
      UPDATE delivery_attempts SET state = 'failed', error_code = COALESCE(left(p_error, 60), 'rejected_after_acceptance') WHERE message_id = m.id;
    END IF;
  ELSE
    rank_now := array_position(ranks, m.state);
    rank_new := array_position(ranks, CASE p_status WHEN 'sent' THEN 'accepted' ELSE p_status END);
    IF rank_new IS NULL THEN RETURN true; END IF;
    IF rank_now IS NOT NULL AND rank_new > rank_now THEN
      UPDATE messages SET state = ranks[rank_new] WHERE id = m.id;
      UPDATE delivery_attempts SET state = 'accepted', error_code = NULL WHERE message_id = m.id AND state IN ('uncertain', 'submitting');
    END IF;
  END IF;
  -- The provider's own statement of whether this message is charged. The rate is not known here.
  IF p_billable IS NOT NULL THEN
    INSERT INTO usage_events (workspace_id, provider, category, quantities, cost_micros, currency, is_estimate, attribution_key, provenance)
    VALUES (m.workspace_id, 'whatsapp', 'whatsapp_message',
            jsonb_build_object('messages', 1, 'billable', p_billable, 'provider_category', p_category), NULL, NULL, false,
            'wa:' || p_provider_message_id, 'provider receipt; charged by Meta at a rate not known to this system')
    ON CONFLICT (workspace_id, attribution_key) DO NOTHING;
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION record_receipt FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_receipt TO app_callback, app_worker;

-- ---------------------------------------------------------------- QR gateway
-- The gateway keeps one linked-device session per live QR connection, across tenants.
CREATE FUNCTION qr_connections() RETURNS TABLE (id uuid, workspace_id uuid, state text, authorized_number text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.workspace_id, c.state, c.authorized_number FROM connections c
  WHERE c.route = 'unofficial_qr' AND c.mode = 'live' AND c.state IN ('pending_auth', 'connecting', 'connected')
$$;
REVOKE ALL ON FUNCTION qr_connections FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qr_connections TO app_worker;
GRANT EXECUTE ON FUNCTION resolve_connection TO app_worker; -- the gateway receives QR messages itself

-- ---------------------------------------------------------------- retention
-- Removes customer content older than each workspace's own retention period. Workspaces
-- without one are left alone (and cannot be switched on for real customers).
CREATE FUNCTION purge_expired_data() RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE w record; n_messages int; n_conversations int; total jsonb := '[]';
BEGIN
  FOR w IN SELECT id, retention_days FROM workspaces WHERE retention_days IS NOT NULL LOOP
    CREATE TEMP TABLE doomed ON COMMIT DROP AS
      SELECT c.id, c.contact_id FROM conversations c
      WHERE c.workspace_id = w.id AND COALESCE(c.last_message_at, c.created_at) < now() - make_interval(days => w.retention_days);
    DELETE FROM notifications n USING handoffs h, doomed d WHERE n.handoff_id = h.id AND h.conversation_id = d.id;
    DELETE FROM handoffs h USING doomed d WHERE h.conversation_id = d.id;
    DELETE FROM enquiries e USING doomed d WHERE e.conversation_id = d.id;
    DELETE FROM reply_runs r USING doomed d WHERE r.conversation_id = d.id;
    DELETE FROM delivery_attempts a USING messages m, doomed d WHERE a.message_id = m.id AND m.conversation_id = d.id;
    DELETE FROM messages m USING doomed d WHERE m.conversation_id = d.id;
    GET DIAGNOSTICS n_messages = ROW_COUNT;
    DELETE FROM conversations c USING doomed d WHERE c.id = d.id;
    GET DIAGNOSTICS n_conversations = ROW_COUNT;
    DELETE FROM contacts k USING doomed d WHERE k.id = d.contact_id;
    DELETE FROM jobs j WHERE j.workspace_id = w.id AND j.state IN ('complete', 'dead_letter') AND j.updated_at < now() - make_interval(days => w.retention_days);
    DELETE FROM inbound_events i WHERE i.workspace_id = w.id AND i.created_at < now() - make_interval(days => w.retention_days);
    DROP TABLE doomed;
    IF n_conversations > 0 THEN
      INSERT INTO audit_events (workspace_id, action, target, metadata)
        VALUES (w.id, 'retention.purge', '{}', jsonb_build_object('conversations', n_conversations, 'messages', n_messages));
      total := total || jsonb_build_object('workspace_id', w.id, 'conversations', n_conversations, 'messages', n_messages);
    END IF;
  END LOOP;
  DELETE FROM local_mail WHERE created_at < now() - interval '30 days';
  RETURN total;
END $$;
REVOKE ALL ON FUNCTION purge_expired_data FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_expired_data TO app_worker;
