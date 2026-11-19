BEGIN;
CREATE TABLE IF NOT EXISTS deal_stage_history (
 tenant_id uuid NOT NULL,id uuid NOT NULL,deal_id uuid NOT NULL,
 from_stage jsonb,to_stage jsonb NOT NULL,record_version integer NOT NULL,
 actor_id uuid REFERENCES users(id),service_account_id uuid DEFAULT nullif(current_setting('app.service_account_id',true),'')::uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,deal_id,record_version),
 FOREIGN KEY(tenant_id,deal_id) REFERENCES records(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,service_account_id) REFERENCES service_accounts(tenant_id,id)
);
ALTER TABLE deal_stage_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_stage_history FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename='deal_stage_history' AND policyname='tenant_isolation') THEN
  CREATE POLICY tenant_isolation ON deal_stage_history USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
 END IF;
END $$;
GRANT SELECT,INSERT ON deal_stage_history TO drykraft_app;
REVOKE UPDATE,DELETE ON deal_stage_history FROM drykraft_app;
INSERT INTO schema_migrations(version) VALUES(11) ON CONFLICT DO NOTHING;
COMMIT;
