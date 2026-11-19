BEGIN;
CREATE TABLE IF NOT EXISTS workspace_billing (
  tenant_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  trial_started_at timestamptz NOT NULL DEFAULT now(),
  trial_ends_at timestamptz NOT NULL DEFAULT now()+interval '15 days',
  subscription_id text UNIQUE, customer_id text,
  status text CHECK(status IN ('pending','active','on_hold','paused','cancelled','failed','expired','past_due')),
  seats integer CHECK(seats BETWEEN 1 AND 10000), next_billing_date timestamptz,
  cancel_at_next_billing_date boolean NOT NULL DEFAULT false,
  synced_at timestamptz, enterprise_requested_at timestamptz, enterprise_requirements text
);
CREATE TABLE IF NOT EXISTS billing_checkouts (
  tenant_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(), seats integer NOT NULL CHECK(seats BETWEEN 1 AND 10000),
  session_id text UNIQUE, checkout_url text, created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
  PRIMARY KEY(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS billing_checkouts_recent ON billing_checkouts(tenant_id,created_at DESC);
CREATE TABLE IF NOT EXISTS billing_webhook_events (
  tenant_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL, type text NOT NULL, processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_billing','billing_checkouts','billing_webhook_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename=t AND policyname='tenant_isolation') THEN
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
    END IF;
  END LOOP;
END $$;
INSERT INTO workspace_billing(tenant_id) SELECT id FROM workspaces ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION initialize_workspace_billing() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN INSERT INTO public.workspace_billing(tenant_id) VALUES(NEW.id); RETURN NEW; END $$;
REVOKE ALL ON FUNCTION initialize_workspace_billing() FROM PUBLIC;
DROP TRIGGER IF EXISTS workspace_billing_created ON workspaces;
CREATE TRIGGER workspace_billing_created AFTER INSERT ON workspaces FOR EACH ROW EXECUTE FUNCTION initialize_workspace_billing();
GRANT SELECT,INSERT,UPDATE ON workspace_billing,billing_checkouts TO drykraft_app;
GRANT SELECT,INSERT ON billing_webhook_events TO drykraft_app;
INSERT INTO schema_migrations(version) VALUES(7) ON CONFLICT DO NOTHING;
COMMIT;
