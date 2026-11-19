BEGIN;
CREATE TABLE IF NOT EXISTS platform_plans (
 id uuid PRIMARY KEY,key text UNIQUE NOT NULL CHECK(key ~ '^[a-z][a-z0-9-]{2,49}$'),
 current_version integer NOT NULL CHECK(current_version>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_plan_versions (
 plan_id uuid NOT NULL REFERENCES platform_plans(id),version integer NOT NULL CHECK(version>0),
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 2 AND 100),kind text NOT NULL CHECK(kind IN ('workspace','enterprise')),
 currency text NOT NULL DEFAULT 'USD' CHECK(currency='USD'),monthly_price_minor integer,annual_price_minor integer,
 limits jsonb NOT NULL,features jsonb NOT NULL,created_by uuid REFERENCES platform_accounts(id),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(plan_id,version),
 CHECK((kind='workspace' AND monthly_price_minor IS NOT DISTINCT FROM 100 AND annual_price_minor IS NOT DISTINCT FROM 1200) OR (kind='enterprise' AND monthly_price_minor IS NULL AND annual_price_minor IS NULL))
);
CREATE OR REPLACE FUNCTION validate_platform_plan_definition() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE item record;
 BEGIN
  IF jsonb_typeof(NEW.limits)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(NEW.limits))<>8 OR
   NOT NEW.limits ?& ARRAY['users','contacts','custom_records','pipelines','workflows','active_workflows','integrations','calendars'] OR
   jsonb_typeof(NEW.features)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(NEW.features))<>6 OR
   NOT NEW.features ?& ARRAY['crm','sales','finance','automation','outreach','calendar'] THEN
   RAISE EXCEPTION 'Invalid plan definition' USING ERRCODE='22023';
  END IF;
  FOR item IN SELECT value FROM jsonb_each(NEW.limits) LOOP
   IF item.value<>'null'::jsonb AND (jsonb_typeof(item.value)<>'number' OR item.value::text !~ '^[0-9]{1,10}$' OR (item.value::text)::bigint>1000000000) THEN
    RAISE EXCEPTION 'Invalid plan ceiling' USING ERRCODE='22023';
   END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_each(NEW.features) WHERE jsonb_typeof(value)<>'boolean') THEN RAISE EXCEPTION 'Invalid plan capabilities' USING ERRCODE='22023';END IF;
  RETURN NEW;
 END
$$;
REVOKE ALL ON FUNCTION validate_platform_plan_definition() FROM PUBLIC,drykraft_app,drykraft_worker;
DROP TRIGGER IF EXISTS platform_plan_definition_guard ON platform_plan_versions;
CREATE TRIGGER platform_plan_definition_guard BEFORE INSERT ON platform_plan_versions FOR EACH ROW EXECUTE FUNCTION validate_platform_plan_definition();
CREATE TABLE IF NOT EXISTS platform_workspace_entitlements (
 tenant_id uuid PRIMARY KEY REFERENCES workspaces(id),plan_id uuid NOT NULL,plan_version integer NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),overrides jsonb NOT NULL DEFAULT '{"limits":{},"features":{}}',
 agreement jsonb,updated_by uuid REFERENCES platform_accounts(id),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(plan_id,plan_version) REFERENCES platform_plan_versions(plan_id,version)
);
-- A stable initial version preserves existing access. Publishing never silently changes assigned workspaces.
INSERT INTO platform_plans(id,key,current_version) VALUES('00000000-0000-4000-8000-000000000001','workspace',1) ON CONFLICT DO NOTHING;
INSERT INTO platform_plan_versions(plan_id,version,name,kind,monthly_price_minor,annual_price_minor,limits,features)
 VALUES('00000000-0000-4000-8000-000000000001',1,'Workspace','workspace',100,1200,
 '{"users":null,"contacts":null,"custom_records":null,"pipelines":null,"workflows":null,"active_workflows":null,"integrations":null,"calendars":null}',
 '{"crm":true,"sales":true,"finance":true,"automation":true,"outreach":true,"calendar":true}') ON CONFLICT DO NOTHING;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='platform_plan_current_definition') THEN
  ALTER TABLE platform_plans ADD CONSTRAINT platform_plan_current_definition FOREIGN KEY(id,current_version) REFERENCES platform_plan_versions(plan_id,version) DEFERRABLE INITIALLY DEFERRED;
 END IF;
END $$;
-- A schema-only restore already has this FK. Validate seed events before the following DDL.
SET CONSTRAINTS platform_plan_current_definition IMMEDIATE;
DO $$ DECLARE t text;BEGIN
 FOR t IN SELECT unnest(ARRAY['platform_plans','platform_plan_versions','platform_workspace_entitlements']) LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,drykraft_app,drykraft_worker',t);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='drykraft_platform') THEN
   IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename=t AND policyname='platform_only') THEN
    EXECUTE format('CREATE POLICY platform_only ON %I TO drykraft_platform USING(true) WITH CHECK(true)',t);
   END IF;
   EXECUTE format('GRANT SELECT ON %I TO drykraft_platform',t);
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='drykraft_platform') THEN
  GRANT INSERT ON platform_plans,platform_plan_versions TO drykraft_platform;
  GRANT UPDATE(current_version,updated_at) ON platform_plans TO drykraft_platform;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION workspace_entitlements(workspace_id uuid) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE assignment public.platform_workspace_entitlements; definition public.platform_plan_versions;
 BEGIN
  IF session_user NOT IN ('drykraft_platform','postgres') AND workspace_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN
   RAISE EXCEPTION 'Workspace entitlement lookup is not permitted' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.workspaces WHERE id=workspace_id) THEN RETURN NULL;END IF;
  SELECT * INTO assignment FROM public.platform_workspace_entitlements WHERE tenant_id=workspace_id;
  SELECT * INTO definition FROM public.platform_plan_versions WHERE plan_id=coalesce(assignment.plan_id,'00000000-0000-4000-8000-000000000001') AND version=coalesce(assignment.plan_version,1);
  RETURN jsonb_build_object('plan_id',definition.plan_id,'plan_version',definition.version,'version',coalesce(assignment.version,1),'name',definition.name,'kind',definition.kind,
   'limits',definition.limits||coalesce(assignment.overrides->'limits','{}'),'features',definition.features||coalesce(assignment.overrides->'features','{}'),
   'monthly_price_minor',definition.monthly_price_minor,'annual_price_minor',definition.annual_price_minor,'currency',definition.currency,
   'agreement_active',coalesce((assignment.agreement->>'starts_at')::timestamptz<=now() AND (assignment.agreement->>'ends_at')::timestamptz>now(),false),
   'agreement_seats',(assignment.agreement->>'seats')::integer,'agreement_ends_at',assignment.agreement->>'ends_at');
 END
$$;
CREATE OR REPLACE FUNCTION platform_resource_gauge(workspace_id uuid,metric text) RETURNS bigint
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 BEGIN
  CASE metric
   WHEN 'users' THEN RETURN (SELECT count(*) FROM public.memberships WHERE tenant_id=workspace_id);
   WHEN 'contacts' THEN RETURN (SELECT count(*) FROM public.records WHERE tenant_id=workspace_id AND object_key='people' AND merged_into IS NULL);
   WHEN 'custom_records' THEN RETURN (SELECT count(*) FROM public.records WHERE tenant_id=workspace_id AND object_key NOT IN ('people','companies','leads','deals','invoices','expenses','tasks'));
   WHEN 'pipelines' THEN RETURN (SELECT count(*) FROM public.pipelines WHERE tenant_id=workspace_id);
   WHEN 'workflows' THEN RETURN (SELECT count(*) FROM public.workflows WHERE tenant_id=workspace_id);
   WHEN 'active_workflows' THEN RETURN (SELECT count(*) FROM public.workflows WHERE tenant_id=workspace_id AND status='active');
   WHEN 'integrations' THEN RETURN (SELECT count(*) FROM public.credentials WHERE tenant_id=workspace_id)+(SELECT count(*) FROM public.outreach_connections WHERE tenant_id=workspace_id AND enabled)+(SELECT count(*) FROM public.calendar_connections WHERE tenant_id=workspace_id AND enabled)+(SELECT count(*) FROM public.customer_webhooks WHERE tenant_id=workspace_id AND enabled);
   WHEN 'calendars' THEN RETURN (SELECT count(*) FROM public.calendars WHERE tenant_id=workspace_id AND enabled);
   ELSE RAISE EXCEPTION 'Unknown resource gauge' USING ERRCODE='22023';
  END CASE;
 END
$$;
CREATE OR REPLACE FUNCTION platform_resource_gauges(workspace_id uuid) RETURNS jsonb
 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_object_agg(metric,public.platform_resource_gauge(workspace_id,metric)) FROM unnest(ARRAY['users','contacts','custom_records','pipelines','workflows','active_workflows','integrations','calendars']) AS metric
$$;
CREATE OR REPLACE FUNCTION platform_workspace_entitlement_detail(workspace_id uuid) RETURNS jsonb
 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.workspace_entitlements(workspace_id)||jsonb_build_object('overrides',coalesce(e.overrides,'{"limits":{},"features":{}}'::jsonb),'agreement',e.agreement,
  'usage',public.platform_resource_gauges(workspace_id),'trial_started_at',b.trial_started_at,'trial_ends_at',b.trial_ends_at,'updated_at',e.updated_at)
 FROM public.workspace_billing b LEFT JOIN public.platform_workspace_entitlements e ON e.tenant_id=b.tenant_id WHERE b.tenant_id=workspace_id
$$;
CREATE OR REPLACE FUNCTION workspace_require_capability(workspace_id uuid,capability text) RETURNS void
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE entitlements jsonb;
 BEGIN
  entitlements=public.workspace_entitlements(workspace_id);
  IF NOT coalesce((entitlements->'features'->>capability)::boolean,false) THEN
   RAISE EXCEPTION 'The workspace plan does not enable %. Ask the owner to review the plan.',capability USING ERRCODE='DK002';
  END IF;
 END
$$;
CREATE OR REPLACE FUNCTION assign_platform_workspace_plan(workspace_id uuid,actor uuid,expected_version integer,selected_plan uuid,selected_version integer,requested_overrides jsonb,requested_agreement jsonb,change_reason text,request uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE previous public.platform_workspace_entitlements; definition public.platform_plan_versions; item record; current_version integer;
 BEGIN
  IF length(trim(change_reason)) NOT BETWEEN 10 AND 1000 OR NOT EXISTS(SELECT 1 FROM public.platform_accounts WHERE id=actor AND role IN ('owner','admin','billing') AND NOT disabled AND mfa_enabled_at IS NOT NULL) THEN
   RAISE EXCEPTION 'Plan management is not permitted' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace-entitlements:'||workspace_id::text,0));
  SELECT * INTO previous FROM public.platform_workspace_entitlements WHERE tenant_id=workspace_id;
  current_version=coalesce(previous.version,1);
  IF current_version<>expected_version THEN RAISE EXCEPTION 'Workspace entitlements changed' USING ERRCODE='40001';END IF;
  SELECT * INTO definition FROM public.platform_plan_versions WHERE plan_id=selected_plan AND version=selected_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'The selected plan version does not exist' USING ERRCODE='23503';END IF;
  IF jsonb_typeof(requested_overrides)<>'object' OR requested_overrides-ARRAY['limits','features']<>'{}' OR jsonb_typeof(requested_overrides->'limits')<>'object' OR jsonb_typeof(requested_overrides->'features')<>'object' THEN
   RAISE EXCEPTION 'Invalid entitlement overrides' USING ERRCODE='22023';
  END IF;
  FOR item IN SELECT key,value FROM jsonb_each(requested_overrides->'limits') LOOP
   IF NOT definition.limits ? item.key OR (item.value<>'null'::jsonb AND (jsonb_typeof(item.value)<>'number' OR item.value::text !~ '^[0-9]{1,10}$' OR (item.value::text)::bigint>1000000000)) OR
    (definition.limits->item.key<>'null'::jsonb AND (item.value='null'::jsonb OR (item.value::text)::bigint>(definition.limits->>item.key)::bigint)) THEN
    RAISE EXCEPTION 'Workspace limits may only reduce plan ceilings' USING ERRCODE='DK003';
   END IF;
  END LOOP;
  FOR item IN SELECT key,value FROM jsonb_each(requested_overrides->'features') LOOP
   IF NOT definition.features ? item.key OR jsonb_typeof(item.value)<>'boolean' OR ((item.value::text)::boolean AND NOT (definition.features->>item.key)::boolean) THEN
    RAISE EXCEPTION 'Workspace capabilities may only reduce plan grants' USING ERRCODE='DK003';
   END IF;
  END LOOP;
  IF requested_agreement IS NOT NULL THEN
   IF definition.kind<>'enterprise' OR jsonb_typeof(requested_agreement)<>'object' OR NOT requested_agreement ?& ARRAY['reference','starts_at','ends_at','seats'] OR requested_agreement-ARRAY['reference','starts_at','ends_at','seats']<>'{}' OR
    jsonb_typeof(requested_agreement->'reference')<>'string' OR jsonb_typeof(requested_agreement->'starts_at')<>'string' OR jsonb_typeof(requested_agreement->'ends_at')<>'string' OR jsonb_typeof(requested_agreement->'seats')<>'number' OR
    length(trim(requested_agreement->>'reference')) NOT BETWEEN 3 AND 200 OR (requested_agreement->>'ends_at')::timestamptz<=(requested_agreement->>'starts_at')::timestamptz OR
    (requested_agreement->>'ends_at')::timestamptz>now()+interval '366 days' OR (requested_agreement->>'seats')::integer NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'Invalid enterprise agreement' USING ERRCODE='22023';
   END IF;
  END IF;
  INSERT INTO public.platform_workspace_entitlements(tenant_id,plan_id,plan_version,version,overrides,agreement,updated_by)
   VALUES(workspace_id,selected_plan,selected_version,current_version+1,requested_overrides,requested_agreement,actor)
   ON CONFLICT(tenant_id) DO UPDATE SET plan_id=excluded.plan_id,plan_version=excluded.plan_version,version=excluded.version,overrides=excluded.overrides,agreement=excluded.agreement,updated_by=actor,updated_at=now();
  INSERT INTO public.platform_audit(id,actor_id,action,resource_type,resource_id,reason,data,request_id)
   VALUES(gen_random_uuid(),actor,'platform.workspace.plan_assigned','workspace',workspace_id,trim(change_reason),jsonb_build_object('before',to_jsonb(previous),'after',jsonb_build_object('plan_id',selected_plan,'plan_version',selected_version,'version',current_version+1,'overrides',requested_overrides,'agreement',requested_agreement)),request);
  PERFORM set_config('app.tenant_id',workspace_id::text,true);
  INSERT INTO public.outbox(id,tenant_id,type,resource_type,resource_id,actor_id,correlation_id,data)
   VALUES(gen_random_uuid(),workspace_id,'billing.entitlements.updated','workspace',workspace_id,actor,gen_random_uuid(),jsonb_build_object('plan_id',selected_plan,'plan_version',selected_version,'version',current_version+1));
  INSERT INTO public.audit_events(tenant_id,id,actor_id,action,resource_id) VALUES(workspace_id,gen_random_uuid(),actor,'billing.entitlements.updated',workspace_id);
 END
$$;
CREATE OR REPLACE FUNCTION extend_platform_workspace_trial(workspace_id uuid,actor uuid,expected_version integer,requested_end timestamptz,change_reason text,request uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE previous public.platform_workspace_entitlements; saved_end timestamptz; current_version integer;
 BEGIN
  IF length(trim(change_reason)) NOT BETWEEN 10 AND 1000 OR NOT EXISTS(SELECT 1 FROM public.platform_accounts WHERE id=actor AND role IN ('owner','admin','billing') AND NOT disabled AND mfa_enabled_at IS NOT NULL) THEN
   RAISE EXCEPTION 'Trial management is not permitted' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace-entitlements:'||workspace_id::text,0));
  SELECT * INTO previous FROM public.platform_workspace_entitlements WHERE tenant_id=workspace_id;
  current_version=coalesce(previous.version,1);
  IF current_version<>expected_version THEN RAISE EXCEPTION 'Workspace entitlements changed' USING ERRCODE='40001';END IF;
  SELECT trial_ends_at INTO saved_end FROM public.workspace_billing WHERE tenant_id=workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Workspace does not exist' USING ERRCODE='23503';END IF;
  IF requested_end<=saved_end OR requested_end<=now() OR requested_end>now()+interval '90 days' THEN RAISE EXCEPTION 'Extend the current trial to a later date within 90 days' USING ERRCODE='DK003';END IF;
  UPDATE public.workspace_billing SET trial_ends_at=requested_end WHERE tenant_id=workspace_id;
  INSERT INTO public.platform_workspace_entitlements(tenant_id,plan_id,plan_version,version,updated_by)
   VALUES(workspace_id,'00000000-0000-4000-8000-000000000001',1,current_version+1,actor)
   ON CONFLICT(tenant_id) DO UPDATE SET version=excluded.version,updated_by=actor,updated_at=now();
  INSERT INTO public.platform_audit(id,actor_id,action,resource_type,resource_id,reason,data,request_id)
   VALUES(gen_random_uuid(),actor,'platform.workspace.trial_extended','workspace',workspace_id,trim(change_reason),jsonb_build_object('before',saved_end,'after',requested_end,'version',current_version+1),request);
  PERFORM set_config('app.tenant_id',workspace_id::text,true);
  INSERT INTO public.outbox(id,tenant_id,type,resource_type,resource_id,actor_id,correlation_id,data)
   VALUES(gen_random_uuid(),workspace_id,'billing.trial.extended','workspace',workspace_id,actor,gen_random_uuid(),jsonb_build_object('trial_ends_at',requested_end,'version',current_version+1));
  INSERT INTO public.audit_events(tenant_id,id,actor_id,action,resource_id) VALUES(workspace_id,gen_random_uuid(),actor,'billing.trial.extended',workspace_id);
 END
$$;
-- Called only by triggers. One transaction lock serializes resource growth and plan assignment.
CREATE OR REPLACE FUNCTION guard_workspace_resource() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE metric text; secondary text; cap bigint; entitlements jsonb; capability text; old_record jsonb; new_record jsonb;
 BEGIN
  IF TG_OP='UPDATE' AND OLD.tenant_id<>NEW.tenant_id THEN RAISE EXCEPTION 'Resources cannot change workspace' USING ERRCODE='42501';END IF;
  old_record=CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;new_record=to_jsonb(NEW);
  IF TG_TABLE_NAME='memberships' THEN
   IF TG_OP='UPDATE' THEN RETURN NEW;END IF;metric='users';
  ELSIF TG_TABLE_NAME='records' THEN
   capability=CASE WHEN NEW.object_key IN ('invoices','expenses') THEN 'finance' WHEN NEW.object_key='deals' THEN 'sales' ELSE 'crm' END;
   IF NEW.object_key='people' AND NEW.merged_into IS NULL AND (TG_OP='INSERT' OR OLD.merged_into IS NOT NULL OR OLD.object_key<>'people') THEN metric='contacts';
   ELSIF NEW.object_key NOT IN ('people','companies','leads','deals','invoices','expenses','tasks') AND (TG_OP='INSERT' OR OLD.object_key IN ('people','companies','leads','deals','invoices','expenses','tasks')) THEN metric='custom_records';END IF;
  ELSIF TG_TABLE_NAME='pipelines' THEN capability='sales';IF TG_OP='INSERT' THEN metric='pipelines';END IF;
  ELSIF TG_TABLE_NAME='workflows' THEN
   capability='automation';
   IF TG_OP='UPDATE' AND NEW.status<>'active' THEN RETURN NEW;END IF;
   IF TG_OP='INSERT' THEN metric='workflows';END IF;
   IF NEW.status='active' AND (TG_OP='INSERT' OR OLD.status<>'active') THEN secondary='active_workflows';END IF;
  ELSIF TG_TABLE_NAME='calendars' THEN
   capability='calendar';IF NOT NEW.enabled THEN RETURN NEW;END IF;
   IF TG_OP='INSERT' OR NOT OLD.enabled THEN metric='calendars';END IF;
  ELSIF TG_TABLE_NAME='appointments' THEN
   IF TG_OP='UPDATE' AND NEW.state='cancelled' THEN RETURN NEW;END IF;capability='calendar';
  ELSIF TG_TABLE_NAME='finance_entries' THEN capability='finance';
  ELSIF TG_TABLE_NAME='executions' THEN
   capability='automation';
  ELSE
   capability=CASE WHEN TG_TABLE_NAME='calendar_connections' THEN 'calendar' WHEN TG_TABLE_NAME='outreach_connections' THEN 'outreach' ELSE NULL END;
   IF TG_TABLE_NAME='credentials' THEN IF TG_OP='INSERT' THEN metric='integrations';END IF;
   ELSE
    IF NOT (new_record->>'enabled')::boolean THEN RETURN NEW;END IF;
    IF TG_OP='INSERT' OR NOT (old_record->>'enabled')::boolean THEN metric='integrations';END IF;
   END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace-entitlements:'||NEW.tenant_id::text,0));
  IF capability IS NOT NULL THEN PERFORM public.workspace_require_capability(NEW.tenant_id,capability);END IF;
  IF metric IS NULL AND secondary IS NULL THEN RETURN NEW;END IF;
  entitlements=public.workspace_entitlements(NEW.tenant_id);
  FOR metric IN SELECT unnest(ARRAY[metric,secondary]) LOOP
   IF metric IS NULL THEN CONTINUE;END IF;
   cap=(entitlements->'limits'->>metric)::bigint;
   IF cap IS NOT NULL AND public.platform_resource_gauge(NEW.tenant_id,metric)>=cap THEN
    RAISE EXCEPTION 'The workspace has reached its % limit (%). Ask the owner to review the plan.',replace(metric,'_',' '),cap USING ERRCODE='DK001';
   END IF;
  END LOOP;
  RETURN NEW;
 END
$$;
DO $$ DECLARE t text;BEGIN
 FOR t IN SELECT unnest(ARRAY['memberships','records','pipelines','workflows','credentials','outreach_connections','calendar_connections','customer_webhooks','calendars','appointments','finance_entries']) LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS workspace_resource_guard ON %I',t);
  EXECUTE format('CREATE TRIGGER workspace_resource_guard BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION guard_workspace_resource()',t);
 END LOOP;
 DROP TRIGGER IF EXISTS workspace_resource_guard ON executions;
 CREATE TRIGGER workspace_resource_guard BEFORE INSERT ON executions FOR EACH ROW EXECUTE FUNCTION guard_workspace_resource();
END $$;
REVOKE ALL ON FUNCTION workspace_entitlements(uuid),workspace_require_capability(uuid,text),platform_resource_gauge(uuid,text),platform_resource_gauges(uuid),platform_workspace_entitlement_detail(uuid),guard_workspace_resource(),assign_platform_workspace_plan(uuid,uuid,integer,uuid,integer,jsonb,jsonb,text,uuid),extend_platform_workspace_trial(uuid,uuid,integer,timestamptz,text,uuid) FROM PUBLIC,drykraft_app,drykraft_worker;
GRANT EXECUTE ON FUNCTION workspace_entitlements(uuid),workspace_require_capability(uuid,text) TO drykraft_app,drykraft_worker;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='drykraft_platform') THEN
  GRANT EXECUTE ON FUNCTION workspace_entitlements(uuid),platform_workspace_entitlement_detail(uuid),assign_platform_workspace_plan(uuid,uuid,integer,uuid,integer,jsonb,jsonb,text,uuid),extend_platform_workspace_trial(uuid,uuid,integer,timestamptz,text,uuid) TO drykraft_platform;
 END IF;
END $$;
INSERT INTO schema_migrations(version) VALUES(23) ON CONFLICT DO NOTHING;
COMMIT;
