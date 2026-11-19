BEGIN;
DO $$ DECLARE item record; existing jsonb; addition jsonb; BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=25) THEN
  FOR item IN SELECT tenant_id,key,fields FROM object_definitions WHERE key='people' LOOP
   SELECT f INTO existing FROM jsonb_array_elements(item.fields) f WHERE f->>'key'='company_id';
   IF existing IS NULL THEN
    UPDATE object_definitions SET fields=fields || '{"key": "company_id", "name": "Linked company", "type": "relation", "required": false, "object": "companies"}'::jsonb WHERE tenant_id=item.tenant_id AND key=item.key;
   ELSIF existing->>'type' <> 'relation' OR existing->>'object' IS DISTINCT FROM 'companies' THEN
    RAISE EXCEPTION 'Existing people.company_id field conflicts with the CRM relationship. Review its custom definition before migration.';
   END IF;
  END LOOP;
  FOR item IN SELECT tenant_id,key,fields FROM object_definitions WHERE key='leads' LOOP
   SELECT f INTO existing FROM jsonb_array_elements(item.fields) f WHERE f->>'key'='person_id';
   IF existing IS NULL THEN
    UPDATE object_definitions SET fields=fields || '{"key": "person_id", "name": "Linked contact", "type": "relation", "required": false, "object": "people"}'::jsonb WHERE tenant_id=item.tenant_id AND key=item.key;
   ELSIF existing->>'type' <> 'relation' OR existing->>'object' IS DISTINCT FROM 'people' THEN
    RAISE EXCEPTION 'Existing leads.person_id field conflicts with the CRM relationship. Review its custom definition before migration.';
   END IF;
  END LOOP;
  FOR item IN SELECT tenant_id,key,fields FROM object_definitions WHERE key='leads' LOOP
   SELECT f INTO existing FROM jsonb_array_elements(item.fields) f WHERE f->>'key'='company_id';
   IF existing IS NULL THEN
    UPDATE object_definitions SET fields=fields || '{"key": "company_id", "name": "Linked company", "type": "relation", "required": false, "object": "companies"}'::jsonb WHERE tenant_id=item.tenant_id AND key=item.key;
   ELSIF existing->>'type' <> 'relation' OR existing->>'object' IS DISTINCT FROM 'companies' THEN
    RAISE EXCEPTION 'Existing leads.company_id field conflicts with the CRM relationship. Review its custom definition before migration.';
   END IF;
  END LOOP;
  FOR item IN SELECT tenant_id,key,fields FROM object_definitions WHERE key='deals' LOOP
   SELECT f INTO existing FROM jsonb_array_elements(item.fields) f WHERE f->>'key'='company_id';
   IF existing IS NULL THEN
    UPDATE object_definitions SET fields=fields || '{"key": "company_id", "name": "Linked company", "type": "relation", "required": false, "object": "companies"}'::jsonb WHERE tenant_id=item.tenant_id AND key=item.key;
   ELSIF existing->>'type' <> 'relation' OR existing->>'object' IS DISTINCT FROM 'companies' THEN
    RAISE EXCEPTION 'Existing deals.company_id field conflicts with the CRM relationship. Review its custom definition before migration.';
   END IF;
  END LOOP;
  FOR item IN SELECT tenant_id,key,fields FROM object_definitions WHERE key='deals' LOOP
   SELECT f INTO existing FROM jsonb_array_elements(item.fields) f WHERE f->>'key'='lead_id';
   IF existing IS NULL THEN
    UPDATE object_definitions SET fields=fields || '{"key": "lead_id", "name": "Source lead", "type": "relation", "required": false, "object": "leads"}'::jsonb WHERE tenant_id=item.tenant_id AND key=item.key;
   ELSIF existing->>'type' <> 'relation' OR existing->>'object' IS DISTINCT FROM 'leads' THEN
    RAISE EXCEPTION 'Existing deals.lead_id field conflicts with the CRM relationship. Review its custom definition before migration.';
   END IF;
  END LOOP;
  FOR item IN SELECT tenant_id,key,fields FROM object_definitions WHERE key='invoices' LOOP
   SELECT f INTO existing FROM jsonb_array_elements(item.fields) f WHERE f->>'key'='company_id';
   IF existing IS NULL THEN
    UPDATE object_definitions SET fields=fields || '{"key": "company_id", "name": "Linked company", "type": "relation", "required": false, "object": "companies"}'::jsonb WHERE tenant_id=item.tenant_id AND key=item.key;
   ELSIF existing->>'type' <> 'relation' OR existing->>'object' IS DISTINCT FROM 'companies' THEN
    RAISE EXCEPTION 'Existing invoices.company_id field conflicts with the CRM relationship. Review its custom definition before migration.';
   END IF;
  END LOOP;
  FOR item IN SELECT tenant_id,key,fields FROM object_definitions WHERE key='expenses' LOOP
   SELECT f INTO existing FROM jsonb_array_elements(item.fields) f WHERE f->>'key'='company_id';
   IF existing IS NULL THEN
    UPDATE object_definitions SET fields=fields || '{"key": "company_id", "name": "Vendor company", "type": "relation", "required": false, "object": "companies"}'::jsonb WHERE tenant_id=item.tenant_id AND key=item.key;
   ELSIF existing->>'type' <> 'relation' OR existing->>'object' IS DISTINCT FROM 'companies' THEN
    RAISE EXCEPTION 'Existing expenses.company_id field conflicts with the CRM relationship. Review its custom definition before migration.';
   END IF;
  END LOOP;
  UPDATE object_definitions SET fields=fields || '{"key":"phone","name":"Phone","type":"phone","required":false}'::jsonb WHERE key='leads' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(fields) f WHERE f->>'key'='phone');
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS records_lead_link ON records(tenant_id,(data->>'lead_id')) WHERE object_key='deals' AND merged_into IS NULL;
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
 ), automatic AS (
  SELECT 'companies' AS key,'create' AS action FROM direct WHERE key IN ('people','leads','deals') AND action IN ('create','update')
  UNION SELECT 'deals','update' FROM direct WHERE key='leads' AND action='update'
  UNION SELECT target,'create' FROM direct CROSS JOIN (VALUES ('people'),('deals')) t(target) WHERE key='leads' AND action='create'
 ), rights AS (
  SELECT direct.key,action FROM direct JOIN objects USING(key)
  UNION SELECT automatic.key,action FROM automatic JOIN objects USING(key)
  UNION SELECT automatic.key,'read' FROM automatic JOIN objects USING(key)
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


-- Existing published identities keep their reviewed ceiling. Republish lead-creation workflows to authorize the connected writes.
INSERT INTO schema_migrations(version) VALUES(25) ON CONFLICT DO NOTHING;
COMMIT;
