-- Sign-in, local-only mailbox, and the columns the self-service flow needs.

-- Auth tables have no workspace_id and no app_user grant: only the server's own role reads them.
CREATE TABLE signin_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id),
  token_hash text NOT NULL UNIQUE, -- sha256; the token itself is never stored
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Prototype mail sink. Nothing here leaves the machine.
CREATE TABLE local_mail (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_email text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Mock and live connections are different things and must never be confused.
ALTER TABLE connections
  ADD COLUMN mode text NOT NULL DEFAULT 'live' CHECK (mode IN ('mock', 'live')),
  ADD COLUMN link_expires_at timestamptz;
-- Switching route can never leave two routes open for one workspace.
CREATE UNIQUE INDEX one_open_connection ON connections (workspace_id)
  WHERE state IN ('unconfigured', 'pending_auth', 'connecting', 'connected', 'needs_action');

-- Pause is a no-new-send boundary that also applies before activation (test mode).
ALTER TABLE workspaces ADD COLUMN replies_paused_at timestamptz;

-- Re-importing identical content must not create a second source or duplicate facts.
CREATE UNIQUE INDEX one_source_per_content ON sources (workspace_id, content_hash) WHERE content_hash IS NOT NULL;

-- Which answer a mock sample chat or a reply came from.
ALTER TABLE messages ADD COLUMN fact_path text;
