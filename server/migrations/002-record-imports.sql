BEGIN;
CREATE TABLE IF NOT EXISTS record_imports (
    tenant_id uuid NOT NULL REFERENCES workspaces(id), id uuid NOT NULL,
    object_key text NOT NULL, payload_hash text NOT NULL, result jsonb NOT NULL,
    actor_id uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(tenant_id,id)
);
ALTER TABLE record_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE record_imports FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename='record_imports' AND policyname='tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON record_imports USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
    END IF;
END $$;
GRANT SELECT,INSERT ON record_imports TO drykraft_app;
REVOKE UPDATE,DELETE ON record_imports FROM drykraft_app;
INSERT INTO schema_migrations(version) VALUES(2) ON CONFLICT DO NOTHING;
COMMIT;
