BEGIN;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS runtime jsonb NOT NULL DEFAULT '{}';
ALTER TABLE node_executions ADD COLUMN IF NOT EXISTS iteration_path text NOT NULL DEFAULT '';
ALTER TABLE execution_recoveries ADD COLUMN IF NOT EXISTS iteration_path text NOT NULL DEFAULT '';
DO $$ BEGIN
 IF position('iteration_path' in pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conrelid='node_executions'::regclass AND contype='p')))=0 THEN
  ALTER TABLE node_executions DROP CONSTRAINT node_executions_pkey;
  ALTER TABLE node_executions ADD PRIMARY KEY(tenant_id,execution_id,node_id,iteration_path);
 END IF;
END $$;
INSERT INTO schema_migrations(version) VALUES(16) ON CONFLICT DO NOTHING;
COMMIT;
