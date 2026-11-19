BEGIN;
CREATE TABLE IF NOT EXISTS outreach_connections (
 tenant_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,id uuid NOT NULL,
 name text NOT NULL,channel text NOT NULL CHECK(channel IN ('email','sms','voice','whatsapp')),
 provider text NOT NULL CHECK(provider IN ('smtp','google','microsoft','curl','qcall','whatsapp')),
 config jsonb NOT NULL DEFAULT '{}',ciphertext text NOT NULL,enabled boolean NOT NULL DEFAULT true,
 verified_at timestamptz,last_error text,daily_limit integer NOT NULL DEFAULT 100 CHECK(daily_limit BETWEEN 1 AND 10000),
 hourly_limit integer NOT NULL DEFAULT 20 CHECK(hourly_limit BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS outreach_campaigns (
 tenant_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,id uuid NOT NULL,name text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('campaign','sequence')),channel text NOT NULL,
 object_key text NOT NULL,list_id uuid,connection_id uuid NOT NULL,steps jsonb NOT NULL,
 workflow_id uuid NOT NULL,status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','paused','cancelled')),
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,connection_id) REFERENCES outreach_connections(tenant_id,id),
 FOREIGN KEY(tenant_id,workflow_id) REFERENCES workflows(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS outreach_enrollments (
 tenant_id uuid NOT NULL,id uuid NOT NULL,campaign_id uuid NOT NULL,record_id uuid NOT NULL,
 execution_id uuid NOT NULL,recipient text NOT NULL,status text NOT NULL DEFAULT 'active'
 CHECK(status IN ('active','replied','unsubscribed','cancelled')),
 unsubscribe_hash text UNIQUE NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,campaign_id,record_id),UNIQUE(tenant_id,execution_id),
 FOREIGN KEY(tenant_id,campaign_id) REFERENCES outreach_campaigns(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,execution_id) REFERENCES executions(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS outreach_deliveries (
 tenant_id uuid NOT NULL,id uuid NOT NULL,execution_id uuid NOT NULL,node_id text NOT NULL,connection_id uuid NOT NULL,
 channel text NOT NULL,recipient text NOT NULL,status text NOT NULL CHECK(status IN ('sending','accepted','delivered','read','replied','failed','unknown','skipped')),
 provider_id text,detail jsonb NOT NULL DEFAULT '{}',error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,execution_id,node_id),
 FOREIGN KEY(tenant_id,execution_id) REFERENCES executions(tenant_id,id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES outreach_connections(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS outreach_delivery_provider ON outreach_deliveries(tenant_id,connection_id,provider_id);
CREATE TABLE IF NOT EXISTS outreach_receipts (
 tenant_id uuid NOT NULL,connection_id uuid NOT NULL,provider_id text NOT NULL,status text NOT NULL,
 PRIMARY KEY(tenant_id,connection_id,provider_id),FOREIGN KEY(tenant_id,connection_id) REFERENCES outreach_connections(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS outreach_suppressions (
 tenant_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,channel text NOT NULL,recipient text NOT NULL,
 reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,channel,recipient)
);
CREATE TABLE IF NOT EXISTS outreach_messages (
 tenant_id uuid NOT NULL,connection_id uuid NOT NULL,provider_id text NOT NULL,sender text NOT NULL,
 body text NOT NULL,received_at timestamptz NOT NULL,execution_id uuid,
 PRIMARY KEY(tenant_id,connection_id,provider_id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES outreach_connections(tenant_id,id) ON DELETE CASCADE
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['outreach_connections','outreach_campaigns','outreach_enrollments','outreach_deliveries','outreach_receipts','outreach_suppressions','outreach_messages'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY; ALTER TABLE %I FORCE ROW LEVEL SECURITY',t,t);
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename=t AND policyname='tenant_isolation') THEN
 EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 END IF;
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO drykraft_app',t);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION resolve_outreach_connection(requested_id uuid) RETURNS TABLE(tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT c.tenant_id FROM public.outreach_connections c WHERE c.id=requested_id AND c.provider='whatsapp' AND c.enabled $$;
CREATE OR REPLACE FUNCTION resolve_outreach_unsubscribe(requested_hash text) RETURNS TABLE(tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT e.tenant_id FROM public.outreach_enrollments e WHERE e.unsubscribe_hash=requested_hash $$;
REVOKE ALL ON FUNCTION resolve_outreach_connection(uuid),resolve_outreach_unsubscribe(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_outreach_connection(uuid),resolve_outreach_unsubscribe(text) TO drykraft_app;
INSERT INTO schema_migrations(version) VALUES(8) ON CONFLICT DO NOTHING;
GRANT SELECT ON outreach_connections TO drykraft_worker;
COMMIT;
