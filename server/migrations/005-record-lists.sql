BEGIN;
CREATE TABLE IF NOT EXISTS record_lists (
  tenant_id uuid NOT NULL, id uuid NOT NULL, object_key text NOT NULL,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80), filter jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1, created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,object_key) REFERENCES object_definitions(tenant_id,key)
);
CREATE UNIQUE INDEX IF NOT EXISTS record_lists_name ON record_lists(tenant_id,object_key,lower(name));
ALTER TABLE record_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE record_lists FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename='record_lists' AND policyname='tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON record_lists USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
  END IF;
END $$;
GRANT SELECT,INSERT,UPDATE,DELETE ON record_lists TO drykraft_app;
INSERT INTO schema_migrations(version) VALUES(5) ON CONFLICT DO NOTHING;
COMMIT;
