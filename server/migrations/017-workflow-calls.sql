BEGIN;
CREATE INDEX IF NOT EXISTS execution_call_root ON executions(tenant_id,(runtime->'call'->>'root_id')) WHERE runtime ? 'call';
CREATE INDEX IF NOT EXISTS execution_call_ancestors ON executions USING gin((runtime->'call'->'ancestors')) WHERE runtime ? 'call';
INSERT INTO schema_migrations(version) VALUES(17) ON CONFLICT DO NOTHING;
COMMIT;
