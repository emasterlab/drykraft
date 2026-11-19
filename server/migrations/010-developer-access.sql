BEGIN;
CREATE TABLE IF NOT EXISTS service_accounts (
 tenant_id uuid NOT NULL REFERENCES workspaces(id),id uuid NOT NULL,name text NOT NULL,
 permissions jsonb NOT NULL,disabled boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 1,
 created_by uuid REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS api_keys (
 tenant_id uuid NOT NULL,id uuid NOT NULL,service_account_id uuid NOT NULL,name text NOT NULL,
 token_hash text UNIQUE NOT NULL,prefix text NOT NULL,permissions jsonb NOT NULL,payload_hash text NOT NULL,
 expires_at timestamptz NOT NULL,revoked_at timestamptz,version integer NOT NULL DEFAULT 1,
 rotated_from uuid,created_by uuid REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,service_account_id) REFERENCES service_accounts(tenant_id,id),
 FOREIGN KEY(tenant_id,rotated_from) REFERENCES api_keys(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS api_keys_account ON api_keys(tenant_id,service_account_id,created_at DESC);
CREATE TABLE IF NOT EXISTS api_mutations (
 tenant_id uuid NOT NULL,id uuid NOT NULL,service_account_id uuid NOT NULL,
 payload_hash text NOT NULL,status integer NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,service_account_id,id),FOREIGN KEY(tenant_id,service_account_id) REFERENCES service_accounts(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS api_request_logs (
 tenant_id uuid NOT NULL,id uuid NOT NULL,service_account_id uuid NOT NULL,key_id uuid NOT NULL,
 operation text NOT NULL,status integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,service_account_id) REFERENCES service_accounts(tenant_id,id),
 FOREIGN KEY(tenant_id,key_id) REFERENCES api_keys(tenant_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['service_accounts','api_keys','api_mutations','api_request_logs'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename=t AND policyname='tenant_isolation') THEN
   EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
  END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['outbox','audit_events','activities','usage_ledger'] LOOP
  EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS service_account_id uuid DEFAULT nullif(current_setting(''app.service_account_id'',true),'''')::uuid',t);
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname=t||'_service_account') THEN
   EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY(tenant_id,service_account_id) REFERENCES service_accounts(tenant_id,id)',t,t||'_service_account');
  END IF;
 END LOOP;
END $$;
ALTER TABLE records ADD COLUMN IF NOT EXISTS created_by_service_account_id uuid DEFAULT nullif(current_setting('app.service_account_id',true),'')::uuid;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='records_service_account') THEN
  ALTER TABLE records ADD CONSTRAINT records_service_account FOREIGN KEY(tenant_id,created_by_service_account_id) REFERENCES service_accounts(tenant_id,id);
 END IF;
END $$;
CREATE OR REPLACE FUNCTION resolve_api_key(requested_hash text) RETURNS TABLE(tenant_id uuid,id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp
AS $$ SELECT k.tenant_id,k.id FROM public.api_keys k JOIN public.service_accounts s ON s.tenant_id=k.tenant_id AND s.id=k.service_account_id WHERE k.token_hash=requested_hash AND k.revoked_at IS NULL AND k.expires_at>now() AND NOT s.disabled $$;
REVOKE ALL ON FUNCTION resolve_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_api_key(text) TO drykraft_app;
GRANT SELECT,INSERT,UPDATE ON service_accounts,api_keys TO drykraft_app;
REVOKE DELETE ON service_accounts,api_keys FROM drykraft_app;
GRANT SELECT,INSERT ON api_mutations,api_request_logs TO drykraft_app;
REVOKE UPDATE,DELETE ON api_mutations,api_request_logs FROM drykraft_app;
INSERT INTO schema_migrations(version) VALUES(10) ON CONFLICT DO NOTHING;
COMMIT;
