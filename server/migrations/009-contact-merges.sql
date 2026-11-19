BEGIN;
ALTER TABLE records ADD COLUMN IF NOT EXISTS merged_into uuid;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='records_merge_target') THEN
    ALTER TABLE records ADD CONSTRAINT records_merge_target FOREIGN KEY(tenant_id,merged_into) REFERENCES records(tenant_id,id);
    ALTER TABLE records ADD CONSTRAINT records_merge_not_self CHECK(merged_into IS NULL OR (object_key='people' AND merged_into<>id));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS records_merge_aliases ON records(tenant_id,merged_into) WHERE merged_into IS NOT NULL;
DROP INDEX IF EXISTS people_email_unique;
CREATE UNIQUE INDEX people_email_unique ON records(tenant_id,lower(data->>'email')) WHERE object_key='people' AND merged_into IS NULL AND coalesce(data->>'email','')<>'';
CREATE TABLE IF NOT EXISTS record_merges (
  tenant_id uuid NOT NULL REFERENCES workspaces(id), id uuid NOT NULL,
  payload_hash text NOT NULL, before_records jsonb NOT NULL, result jsonb NOT NULL,
  actor_id uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id)
);
ALTER TABLE record_merges ENABLE ROW LEVEL SECURITY;
ALTER TABLE record_merges FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename='record_merges' AND policyname='tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON record_merges USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
  END IF;
END $$;
GRANT SELECT,INSERT ON record_merges TO drykraft_app;
REVOKE UPDATE,DELETE ON record_merges FROM drykraft_app;
INSERT INTO schema_migrations(version) VALUES(9) ON CONFLICT DO NOTHING;
COMMIT;
