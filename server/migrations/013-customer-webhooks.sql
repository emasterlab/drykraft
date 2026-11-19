BEGIN;
CREATE TABLE IF NOT EXISTS customer_webhooks (
 tenant_id uuid NOT NULL REFERENCES workspaces(id),id uuid NOT NULL,name text NOT NULL,url text NOT NULL,
 events text[] NOT NULL,enabled boolean NOT NULL DEFAULT true,ciphertext text NOT NULL,
 create_hash text NOT NULL,version integer NOT NULL DEFAULT 1,secret_version integer NOT NULL DEFAULT 1,disabled_reason text,
 created_by uuid REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS outbox_tenant_identity ON outbox(tenant_id,id);
CREATE TABLE IF NOT EXISTS customer_webhook_deliveries (
 tenant_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),endpoint_id uuid NOT NULL,event_id uuid NOT NULL,
 event_type text NOT NULL,destination text NOT NULL,body text NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','retrying','succeeded','failed','cancelled')),
 attempts integer NOT NULL DEFAULT 0,cycle_attempts integer NOT NULL DEFAULT 0,version integer NOT NULL DEFAULT 1,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),last_status integer,last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,endpoint_id,event_id),
 FOREIGN KEY(tenant_id,endpoint_id) REFERENCES customer_webhooks(tenant_id,id),
 FOREIGN KEY(tenant_id,event_id) REFERENCES outbox(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS customer_webhook_due ON customer_webhook_deliveries(next_attempt_at,id) WHERE state IN ('queued','retrying');
CREATE INDEX IF NOT EXISTS customer_webhook_history ON customer_webhook_deliveries(tenant_id,endpoint_id,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS customer_webhook_attempts (
 tenant_id uuid NOT NULL,id uuid NOT NULL,delivery_id uuid NOT NULL,attempt integer NOT NULL,secret_version integer NOT NULL,
 status integer,error text,started_at timestamptz NOT NULL,completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,delivery_id,attempt),
 FOREIGN KEY(tenant_id,delivery_id) REFERENCES customer_webhook_deliveries(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS customer_webhook_operations (
 tenant_id uuid NOT NULL,id uuid NOT NULL,endpoint_id uuid NOT NULL,payload_hash text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('rotate','replay')),result jsonb NOT NULL,actor_id uuid REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,endpoint_id) REFERENCES customer_webhooks(tenant_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['customer_webhooks','customer_webhook_deliveries','customer_webhook_attempts','customer_webhook_operations'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename=t AND policyname='tenant_isolation') THEN
   EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
  END IF;
 END LOOP;
END $$;
-- An event and its external delivery commit together. Existing events are never backfilled.
-- Only the fixed envelope is sent; CRM values, messages and credential bodies stay in DryKraft.
CREATE OR REPLACE FUNCTION enqueue_customer_webhooks() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN
 INSERT INTO customer_webhook_deliveries(tenant_id,endpoint_id,event_id,event_type,destination,body)
 SELECT NEW.tenant_id,w.id,NEW.id,NEW.type,w.url,
 jsonb_build_object('schema_version',1,'id',NEW.id,'type',NEW.type,'workspace_id',NEW.tenant_id,
  'occurred_at',NEW.occurred_at,'resource',jsonb_build_object('type',NEW.resource_type,'id',NEW.resource_id),
  'correlation_id',NEW.correlation_id,'causation_id',NEW.causation_id)::text
 FROM customer_webhooks w WHERE w.tenant_id=NEW.tenant_id AND w.enabled AND NEW.type=ANY(w.events);
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS outbox_customer_webhooks ON outbox;
CREATE TRIGGER outbox_customer_webhooks AFTER INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION enqueue_customer_webhooks();
REVOKE ALL ON FUNCTION enqueue_customer_webhooks() FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON customer_webhooks TO drykraft_app;
REVOKE DELETE ON customer_webhooks FROM drykraft_app;
GRANT SELECT,INSERT ON customer_webhook_deliveries,customer_webhook_attempts,customer_webhook_operations TO drykraft_app;
REVOKE UPDATE,DELETE ON customer_webhook_deliveries,customer_webhook_attempts,customer_webhook_operations FROM drykraft_app;
GRANT UPDATE(state,attempts,cycle_attempts,version,next_attempt_at,last_status,last_error,completed_at) ON customer_webhook_deliveries TO drykraft_app;
GRANT SELECT ON customer_webhook_deliveries TO drykraft_worker;
INSERT INTO schema_migrations(version) VALUES(13) ON CONFLICT DO NOTHING;
COMMIT;
