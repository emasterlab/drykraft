BEGIN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE sessions ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE sessions ALTER COLUMN last_seen_at SET DEFAULT now();
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent text;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_id ON sessions(id);
CREATE INDEX IF NOT EXISTS sessions_user_expiry ON sessions(user_id,expires_at);
CREATE TABLE IF NOT EXISTS account_security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action text NOT NULL CHECK(action IN ('password.changed','session.ended','sessions.ended')),
  count integer NOT NULL CHECK(count>=0), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_security_events_user_time ON account_security_events(user_id,created_at DESC,id);
ALTER TABLE account_security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_security_events FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename='account_security_events' AND policyname='account_isolation') THEN
    CREATE POLICY account_isolation ON account_security_events
      USING(user_id=nullif(current_setting('app.user_id',true),'')::uuid)
      WITH CHECK(user_id=nullif(current_setting('app.user_id',true),'')::uuid);
  END IF;
END $$;
GRANT SELECT,INSERT ON account_security_events TO drykraft_app;
REVOKE UPDATE,DELETE ON account_security_events FROM drykraft_app;
INSERT INTO schema_migrations(version) VALUES(6) ON CONFLICT DO NOTHING;
COMMIT;
