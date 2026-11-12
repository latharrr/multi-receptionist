-- Login roles for local development. In a real environment these are provisioned by the
-- operator with real credentials; migrations only create them NOLOGIN if they are missing.
CREATE ROLE app_user LOGIN PASSWORD 'dev';      -- web requests
CREATE ROLE app_worker LOGIN PASSWORD 'dev';    -- job worker
CREATE ROLE app_callback LOGIN PASSWORD 'dev';  -- provider callbacks
CREATE ROLE app_auth LOGIN PASSWORD 'dev';      -- auth library's own schema
