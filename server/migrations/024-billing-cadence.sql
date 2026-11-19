BEGIN;
ALTER TABLE workspace_billing ADD COLUMN IF NOT EXISTS billing_interval text NOT NULL DEFAULT 'monthly' CHECK(billing_interval IN ('monthly','annual'));
ALTER TABLE workspace_billing ADD COLUMN IF NOT EXISTS product_id text;
ALTER TABLE workspace_billing ADD COLUMN IF NOT EXISTS past_due_ends_at timestamptz;
ALTER TABLE billing_checkouts ADD COLUMN IF NOT EXISTS billing_interval text NOT NULL DEFAULT 'monthly' CHECK(billing_interval IN ('monthly','annual'));
ALTER TABLE billing_checkouts ADD COLUMN IF NOT EXISTS product_id text;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='drykraft_platform') THEN
  GRANT SELECT(billing_interval,past_due_ends_at) ON workspace_billing TO drykraft_platform;
 END IF;
END $$;
INSERT INTO schema_migrations(version) VALUES(24) ON CONFLICT DO NOTHING;
COMMIT;
