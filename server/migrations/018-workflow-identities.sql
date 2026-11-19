BEGIN;
ALTER TABLE service_accounts ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'integration' CHECK(purpose IN ('integration','workflow'));
ALTER TABLE service_accounts ADD COLUMN IF NOT EXISTS workflow_scope jsonb NOT NULL DEFAULT '{}';
-- Identities belong to the workspace, including after their immutable version is retired.
ALTER TABLE service_accounts DROP CONSTRAINT IF EXISTS service_accounts_tenant_id_fkey;
ALTER TABLE service_accounts ADD CONSTRAINT service_accounts_tenant_id_fkey FOREIGN KEY(tenant_id) REFERENCES workspaces(id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION workflow_identity_scope(tenant uuid,version_id uuid,graph jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 WITH RECURSIVE graphs(id,g) AS (
  SELECT version_id,graph
  UNION
  SELECT v.id,v.graph FROM graphs p
  CROSS JOIN LATERAL jsonb_array_elements(p.g->'nodes') n
  CROSS JOIN LATERAL (VALUES
   (CASE WHEN n->'data'->>'kind'='workflow.call' THEN n->'data'->>'versionId' END),
   (CASE WHEN n->'data'->>'kind' LIKE 'trigger.%' THEN n->'data'->'errorWorkflow'->>'versionId' END)
  ) r(id)
  JOIN workflow_versions v ON v.tenant_id=tenant AND v.id=CASE WHEN r.id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN r.id::uuid END
 ), nodes AS (SELECT n->'data' AS d FROM graphs CROSS JOIN LATERAL jsonb_array_elements(g->'nodes') n),
 objects AS (SELECT key,fields FROM object_definitions WHERE tenant_id=tenant),
 direct AS (
  SELECT CASE WHEN d->>'kind'='crm.tags' THEN 'people' WHEN d->>'kind'='crm.stage' THEN 'deals' ELSE d->>'object' END AS key,
   CASE WHEN d->>'kind' IN ('crm.create','finance.create') THEN 'create' WHEN d->>'kind'='crm.search' THEN 'read' ELSE 'update' END AS action
  FROM nodes WHERE d->>'kind' IN ('crm.create','crm.update','crm.search','crm.link','crm.assign','crm.tags','crm.stage','finance.create')
 ), rights AS (
  SELECT direct.key,action FROM direct JOIN objects USING(key)
  UNION SELECT key,'read' FROM direct JOIN objects USING(key)
  -- Dynamic notes are restricted to the objects present at publication; future objects are not granted.
  UNION SELECT o.key,'note' FROM nodes n CROSS JOIN objects o WHERE n.d->>'kind'='crm.note'
  UNION SELECT o.key,'read' FROM nodes n CROSS JOIN objects o WHERE n.d->>'kind' IN ('crm.note','calendar.create','trigger.event')
  UNION SELECT o.key,'read' FROM nodes n CROSS JOIN objects o WHERE n.d->>'kind'='outreach.send' AND o.key IN ('people','leads')
  -- Reference validation needs read access to the declared target, or current objects for an untyped relation.
  UNION SELECT target.key,'read' FROM direct s JOIN objects source USING(key)
   CROSS JOIN LATERAL jsonb_array_elements(source.fields) f JOIN objects target ON f->>'object' IS NULL OR target.key=f->>'object'
   WHERE s.action IN ('create','update') AND f->>'type'='relation'
 ), permissions AS (SELECT key,jsonb_agg(action ORDER BY action) AS actions FROM rights GROUP BY key)
 SELECT jsonb_build_object(
  'permissions',coalesce((SELECT jsonb_object_agg(key,actions) FROM permissions),'{}'::jsonb),
  'versions',(SELECT jsonb_agg(id ORDER BY id) FROM graphs),
  'kinds',coalesce((SELECT jsonb_agg(kind ORDER BY kind) FROM (SELECT DISTINCT d->>'kind' AS kind FROM nodes) k),'[]'::jsonb),
  'credentials',coalesce((SELECT jsonb_agg(id ORDER BY id) FROM (SELECT DISTINCT id FROM nodes CROSS JOIN LATERAL (
    SELECT d->>'credentialId' AS id WHERE d->>'kind' IN ('http','graphql')
    UNION SELECT b->>'credentialId' FROM jsonb_array_elements(CASE WHEN d->>'kind'='code' THEN coalesce(d->'secretBindings','[]'::jsonb) ELSE '[]'::jsonb END) b
   ) b WHERE id IS NOT NULL) r),'[]'::jsonb),
  'calendars',coalesce((SELECT jsonb_agg(id ORDER BY id) FROM (SELECT DISTINCT d->>'calendarId' AS id FROM nodes WHERE d->>'kind'='calendar.create' AND d->>'calendarId' IS NOT NULL) r),'[]'::jsonb),
  'connections',coalesce((SELECT jsonb_agg(id ORDER BY id) FROM (SELECT DISTINCT d->>'connectionId' AS id FROM nodes WHERE d->>'kind' LIKE 'outreach.%' AND d->>'connectionId' IS NOT NULL) r),'[]'::jsonb)
 );
$$;
REVOKE ALL ON FUNCTION workflow_identity_scope(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workflow_identity_scope(uuid,uuid,jsonb) TO drykraft_app;

CREATE OR REPLACE FUNCTION create_workflow_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE policy jsonb; title text;
BEGIN
 policy:=workflow_identity_scope(NEW.tenant_id,NEW.id,NEW.graph);
 IF jsonb_array_length(policy->'versions')>1001 THEN RAISE EXCEPTION 'Workflow access exceeds 1,001 published versions'; END IF;
 SELECT name INTO title FROM workflows WHERE tenant_id=NEW.tenant_id AND id=NEW.workflow_id;
 INSERT INTO service_accounts(tenant_id,id,name,permissions,purpose,workflow_scope)
 VALUES(NEW.tenant_id,NEW.id,left(title,75)||' - version '||NEW.version,policy->'permissions','workflow',policy);
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION create_workflow_identity() FROM PUBLIC;
DROP TRIGGER IF EXISTS workflow_version_identity ON workflow_versions;
CREATE TRIGGER workflow_version_identity BEFORE INSERT ON workflow_versions FOR EACH ROW EXECUTE FUNCTION create_workflow_identity();

INSERT INTO service_accounts(tenant_id,id,name,permissions,purpose,workflow_scope)
 SELECT v.tenant_id,v.id,left(w.name,75)||' - version '||v.version,p.policy->'permissions','workflow',p.policy
 FROM workflow_versions v JOIN workflows w ON w.tenant_id=v.tenant_id AND w.id=v.workflow_id
 CROSS JOIN LATERAL (SELECT workflow_identity_scope(v.tenant_id,v.id,v.graph) AS policy) p
 ON CONFLICT(tenant_id,id) DO NOTHING;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM workflow_versions v LEFT JOIN service_accounts s ON s.tenant_id=v.tenant_id AND s.id=v.id WHERE s.purpose IS DISTINCT FROM 'workflow') THEN
  RAISE EXCEPTION 'A workflow identity conflicts with an existing integration account';
 END IF;
END $$;

CREATE OR REPLACE FUNCTION resolve_api_key(requested_hash text) RETURNS TABLE(tenant_id uuid,id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT k.tenant_id,k.id FROM public.api_keys k JOIN public.service_accounts s ON s.tenant_id=k.tenant_id AND s.id=k.service_account_id
 WHERE k.token_hash=requested_hash AND k.revoked_at IS NULL AND k.expires_at>now() AND NOT s.disabled AND s.purpose='integration'
$$;
REVOKE ALL ON FUNCTION resolve_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_api_key(text) TO drykraft_app;
-- The published policy is a ceiling, never editable by an application transaction.
REVOKE UPDATE ON service_accounts FROM drykraft_app;
GRANT UPDATE(name,permissions,disabled,version,updated_at) ON service_accounts TO drykraft_app;
INSERT INTO schema_migrations(version) VALUES(18) ON CONFLICT DO NOTHING;
COMMIT;
