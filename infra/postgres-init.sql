-- Login roles for local development. In a real environment these are provisioned by the
-- operator with real credentials; migrations only create them NOLOGIN if they are missing.
-- Safe to run again: `pnpm db` applies it on every start so new roles reach existing volumes.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY[
    'app_user',      -- web requests
    'app_worker',    -- job worker
    'app_callback',  -- provider callbacks
    'app_auth',      -- auth library's own schema
    'app_operator'   -- operator diagnostics: one read-only function, nothing else
  ] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN EXECUTE format('ALTER ROLE %I LOGIN PASSWORD ''dev''', r);
    ELSE EXECUTE format('CREATE ROLE %I LOGIN PASSWORD ''dev''', r);
    END IF;
  END LOOP;
END $$;
