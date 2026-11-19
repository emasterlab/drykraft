BEGIN;
CREATE TABLE IF NOT EXISTS execution_recoveries (
 tenant_id uuid NOT NULL,id uuid NOT NULL,source_id uuid NOT NULL,target_id uuid NOT NULL,
 mode text NOT NULL CHECK(mode IN ('rerun','replay','retry')),node_id text,
 actor_id uuid REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,source_id) REFERENCES executions(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,target_id) REFERENCES executions(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS execution_recovery_source ON execution_recoveries(tenant_id,source_id,created_at);
CREATE INDEX IF NOT EXISTS execution_recovery_target ON execution_recoveries(tenant_id,target_id);
ALTER TABLE execution_recoveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_recoveries FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename='execution_recoveries' AND policyname='tenant_isolation') THEN
  CREATE POLICY tenant_isolation ON execution_recoveries USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
 END IF;
END $$;
GRANT SELECT,INSERT ON execution_recoveries TO drykraft_app;
REVOKE UPDATE,DELETE ON execution_recoveries FROM drykraft_app;
INSERT INTO schema_migrations(version) VALUES(12) ON CONFLICT DO NOTHING;
COMMIT;
