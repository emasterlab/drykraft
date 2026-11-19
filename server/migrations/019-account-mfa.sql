BEGIN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS auth_version integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS account_mfa (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 secret_ciphertext text, enabled_at timestamptz, last_step bigint NOT NULL DEFAULT -1,
 recovery_hashes text[] NOT NULL DEFAULT '{}',
 pending_ciphertext text, pending_id uuid, pending_expires_at timestamptz,
 CHECK ((secret_ciphertext IS NULL)=(enabled_at IS NULL)),
 CHECK (cardinality(recovery_hashes)<=10)
);
CREATE TABLE IF NOT EXISTS auth_mfa_challenges (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 tenant_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
 auth_version integer NOT NULL, verified_password_hash text NOT NULL,
 host_slug text, attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_mfa_challenges_user ON auth_mfa_challenges(user_id,expires_at);
ALTER TABLE account_mfa ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_mfa FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_mfa_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_mfa_challenges FORCE ROW LEVEL SECURITY;
DO $$ DECLARE _table text; BEGIN
 FOR _table IN SELECT unnest(ARRAY['account_mfa','auth_mfa_challenges']) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename=_table AND policyname='account_isolation') THEN
   EXECUTE format('CREATE POLICY account_isolation ON %I USING(user_id=nullif(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK(user_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',_table);
  END IF;
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION resolve_mfa_challenge(_hash text) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT user_id FROM public.auth_mfa_challenges WHERE token_hash=_hash AND expires_at>now() AND attempts<5
$$;
REVOKE ALL ON FUNCTION resolve_mfa_challenge(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_mfa_challenge(text) TO drykraft_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON account_mfa,auth_mfa_challenges TO drykraft_app;
ALTER TABLE account_security_events DROP CONSTRAINT IF EXISTS account_security_events_action_check;
ALTER TABLE account_security_events ADD CONSTRAINT account_security_events_action_check CHECK(action IN ('password.changed','session.ended','sessions.ended','mfa.enabled','mfa.disabled','mfa.recovery.regenerated','mfa.recovery.used'));
INSERT INTO schema_migrations(version) VALUES(19) ON CONFLICT DO NOTHING;
COMMIT;
