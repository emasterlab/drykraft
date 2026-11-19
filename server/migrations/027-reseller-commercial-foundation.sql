BEGIN;
CREATE TABLE IF NOT EXISTS reseller_organizations (
 id uuid PRIMARY KEY,key text UNIQUE NOT NULL CHECK(key ~ '^[a-z][a-z0-9-]{2,49}$'),
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 2 AND 100),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','suspended')),
 customer_access_policy text NOT NULL DEFAULT 'retain_access' CHECK(customer_access_policy IN ('retain_access','suspend_access')),
 contract_reference text NOT NULL CHECK(length(trim(contract_reference)) BETWEEN 3 AND 200),
 billing_mode text NOT NULL CHECK(billing_mode IN ('wholesale','managed_rebilling')),
 contract_starts_at timestamptz NOT NULL,contract_ends_at timestamptz NOT NULL CHECK(contract_ends_at>contract_starts_at),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),grant_version integer NOT NULL DEFAULT 1 CHECK(grant_version>0),
 created_by uuid NOT NULL REFERENCES platform_accounts(id),updated_by uuid NOT NULL REFERENCES platform_accounts(id),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reseller_grant_versions (
 reseller_id uuid NOT NULL REFERENCES reseller_organizations(id),version integer NOT NULL CHECK(version>0),
 platform_plan_id uuid NOT NULL,platform_plan_version integer NOT NULL,
 max_workspaces integer CHECK(max_workspaces BETWEEN 0 AND 1000000000),trial_days_max integer NOT NULL CHECK(trial_days_max BETWEEN 0 AND 90),
 limits jsonb NOT NULL,aggregate_limits jsonb NOT NULL,features jsonb NOT NULL,
 created_by uuid NOT NULL REFERENCES platform_accounts(id),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(reseller_id,version),FOREIGN KEY(platform_plan_id,platform_plan_version) REFERENCES platform_plan_versions(plan_id,version)
);
CREATE TABLE IF NOT EXISTS reseller_retail_plans (
 id uuid PRIMARY KEY,reseller_id uuid NOT NULL REFERENCES reseller_organizations(id),key text NOT NULL CHECK(key ~ '^[a-z][a-z0-9-]{2,49}$'),
 current_version integer NOT NULL DEFAULT 1 CHECK(current_version>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(reseller_id,key),UNIQUE(id,reseller_id)
);
CREATE TABLE IF NOT EXISTS reseller_retail_plan_versions (
 plan_id uuid NOT NULL,reseller_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 2 AND 100),currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 monthly_price_minor integer NOT NULL CHECK(monthly_price_minor BETWEEN 0 AND 1000000000),
 annual_price_minor integer NOT NULL CHECK(annual_price_minor BETWEEN 0 AND 1000000000),
 setup_price_minor integer NOT NULL CHECK(setup_price_minor BETWEEN 0 AND 1000000000),
 trial_days integer NOT NULL CHECK(trial_days BETWEEN 0 AND 90),limits jsonb NOT NULL,features jsonb NOT NULL,
 grant_version integer NOT NULL,created_by uuid NOT NULL REFERENCES platform_accounts(id),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(plan_id,version),UNIQUE(plan_id,version,reseller_id),
 FOREIGN KEY(plan_id,reseller_id) REFERENCES reseller_retail_plans(id,reseller_id),
 FOREIGN KEY(reseller_id,grant_version) REFERENCES reseller_grant_versions(reseller_id,version)
);
-- Keep the assignment version when a customer returns to direct management, preventing stale transfer replay.
CREATE TABLE IF NOT EXISTS reseller_workspace_links (
 tenant_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,reseller_id uuid REFERENCES reseller_organizations(id),
 retail_plan_id uuid,retail_plan_version integer,version integer NOT NULL DEFAULT 0 CHECK(version>=0),
 updated_by uuid REFERENCES platform_accounts(id),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((reseller_id IS NULL AND retail_plan_id IS NULL AND retail_plan_version IS NULL) OR (reseller_id IS NOT NULL AND retail_plan_id IS NOT NULL AND retail_plan_version IS NOT NULL)),
 FOREIGN KEY(retail_plan_id,retail_plan_version,reseller_id) REFERENCES reseller_retail_plan_versions(plan_id,version,reseller_id)
);
CREATE INDEX IF NOT EXISTS reseller_workspace_parent ON reseller_workspace_links(reseller_id,tenant_id) WHERE reseller_id IS NOT NULL;
-- A stable version-zero row gives direct workspaces the same optimistic ownership contract as reseller customers.
INSERT INTO reseller_workspace_links(tenant_id) SELECT id FROM workspaces ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION reseller_seed_direct_workspace() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 BEGIN INSERT INTO public.reseller_workspace_links(tenant_id) VALUES(NEW.id);RETURN NEW;END
$$;
DROP TRIGGER IF EXISTS reseller_direct_workspace ON workspaces;
CREATE TRIGGER reseller_direct_workspace AFTER INSERT ON workspaces FOR EACH ROW EXECUTE FUNCTION reseller_seed_direct_workspace();
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='reseller_current_grant') THEN
  ALTER TABLE reseller_organizations ADD CONSTRAINT reseller_current_grant FOREIGN KEY(id,grant_version) REFERENCES reseller_grant_versions(reseller_id,version) DEFERRABLE INITIALLY DEFERRED;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='reseller_current_retail_version') THEN
  ALTER TABLE reseller_retail_plans ADD CONSTRAINT reseller_current_retail_version FOREIGN KEY(id,current_version,reseller_id) REFERENCES reseller_retail_plan_versions(plan_id,version,reseller_id) DEFERRABLE INITIALLY DEFERRED;
 END IF;
END $$;
DO $$ DECLARE t text;BEGIN
 FOR t IN SELECT unnest(ARRAY['reseller_organizations','reseller_grant_versions','reseller_retail_plans','reseller_retail_plan_versions','reseller_workspace_links']) LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,drykraft_app,drykraft_worker,drykraft_platform',t);
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename=t AND policyname='platform_only') THEN
   EXECUTE format('CREATE POLICY platform_only ON %I TO drykraft_platform USING(true) WITH CHECK(true)',t);
  END IF;
  EXECUTE format('GRANT SELECT ON %I TO drykraft_platform',t);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION reseller_immutable_version() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'Published reseller versions are immutable' USING ERRCODE='42501';END
$$;
DROP TRIGGER IF EXISTS immutable_version ON reseller_grant_versions;
CREATE TRIGGER immutable_version BEFORE UPDATE OR DELETE ON reseller_grant_versions FOR EACH ROW EXECUTE FUNCTION reseller_immutable_version();
DROP TRIGGER IF EXISTS immutable_version ON reseller_retail_plan_versions;
CREATE TRIGGER immutable_version BEFORE UPDATE OR DELETE ON reseller_retail_plan_versions FOR EACH ROW EXECUTE FUNCTION reseller_immutable_version();
CREATE OR REPLACE FUNCTION reseller_validate_definition(limits jsonb,features jsonb) RETURNS void LANGUAGE plpgsql AS $$
 DECLARE item record;
 BEGIN
  IF limits IS NULL OR features IS NULL OR jsonb_typeof(limits)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(limits))<>8 OR
   NOT limits ?& ARRAY['users','contacts','custom_records','pipelines','workflows','active_workflows','integrations','calendars'] OR
   jsonb_typeof(features)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(features))<>6 OR NOT features ?& ARRAY['crm','sales','finance','automation','outreach','calendar'] THEN
   RAISE EXCEPTION 'Invalid reseller entitlement definition' USING ERRCODE='22023';END IF;
  FOR item IN SELECT value FROM jsonb_each(limits) LOOP
   IF item.value<>'null'::jsonb AND (jsonb_typeof(item.value)<>'number' OR item.value::text !~ '^[0-9]{1,10}$' OR (item.value::text)::bigint>1000000000) THEN
    RAISE EXCEPTION 'Invalid reseller ceiling' USING ERRCODE='22023';END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_each(features) WHERE jsonb_typeof(value)<>'boolean') THEN RAISE EXCEPTION 'Invalid reseller capability' USING ERRCODE='22023';END IF;
 END
$$;
CREATE OR REPLACE FUNCTION reseller_require_reduction(limits jsonb,features jsonb,upstream_limits jsonb,upstream_features jsonb) RETURNS void LANGUAGE plpgsql AS $$
 DECLARE item record;
 BEGIN
  PERFORM public.reseller_validate_definition(limits,features);
  FOR item IN SELECT key,value FROM jsonb_each(limits) LOOP
   IF upstream_limits->item.key<>'null'::jsonb AND (item.value='null'::jsonb OR (item.value::text)::bigint>(upstream_limits->>item.key)::bigint) THEN
    RAISE EXCEPTION 'Reseller limits may only reduce upstream ceilings' USING ERRCODE='DK003';END IF;
  END LOOP;
  FOR item IN SELECT key,value FROM jsonb_each(features) LOOP
   IF (item.value::text)::boolean AND NOT (upstream_features->>item.key)::boolean THEN
    RAISE EXCEPTION 'Reseller capabilities may only reduce upstream grants' USING ERRCODE='DK003';END IF;
  END LOOP;
 END
$$;
CREATE OR REPLACE FUNCTION reseller_require_platform_actor(actor uuid,change_reason text,allowed_roles text[]) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 BEGIN
  IF change_reason IS NULL OR length(trim(change_reason)) NOT BETWEEN 10 AND 1000 OR NOT EXISTS(SELECT 1 FROM public.platform_accounts WHERE id=actor AND role=ANY(allowed_roles) AND NOT disabled AND mfa_enabled_at IS NOT NULL) THEN
   RAISE EXCEPTION 'Reseller management is not permitted' USING ERRCODE='42501';END IF;
 END
$$;
CREATE OR REPLACE FUNCTION reseller_lock(reseller uuid) RETURNS void LANGUAGE sql AS $$
 SELECT pg_advisory_xact_lock(hashtextextended('reseller-commercial:'||reseller::text,0))
$$;
CREATE OR REPLACE FUNCTION reseller_require_active(reseller uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.reseller_organizations WHERE id=reseller AND status='active' AND contract_starts_at<=now() AND contract_ends_at>now()) THEN
   RAISE EXCEPTION 'The reseller must be approved with a current contract' USING ERRCODE='DK003';END IF;
 END
$$;
CREATE OR REPLACE FUNCTION reseller_lock_customer_change(reseller uuid) RETURNS void
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE locked_workspaces uuid[];
 BEGIN
  -- Existing Calendar/team actions can hold workspace rows before reaching a resource guard.
  -- Lock the referenced rows before the reseller lock so event FK checks cannot invert that order.
  SELECT coalesce(array_agg(id),'{}'::uuid[]) INTO locked_workspaces FROM (
   SELECT w.id FROM public.workspaces w JOIN public.reseller_workspace_links l ON l.tenant_id=w.id WHERE l.reseller_id=reseller ORDER BY w.id FOR KEY SHARE OF w
  ) AS saved;
  PERFORM public.reseller_lock(reseller);
  IF EXISTS(SELECT 1 FROM public.reseller_workspace_links WHERE reseller_id=reseller AND NOT tenant_id=ANY(locked_workspaces)) THEN
   RAISE EXCEPTION 'Reseller customers changed during this action. Retry with current details.' USING ERRCODE='40001';END IF;
 END
$$;
CREATE OR REPLACE FUNCTION reseller_resource_gauge(reseller uuid,metric text) RETURNS bigint
 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT coalesce(sum(public.platform_resource_gauge(tenant_id,metric)),0)::bigint FROM public.reseller_workspace_links WHERE reseller_id=reseller
$$;
CREATE OR REPLACE FUNCTION reseller_resource_gauges(reseller uuid) RETURNS jsonb
 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_object_agg(metric,public.reseller_resource_gauge(reseller,metric)) FROM unnest(ARRAY['users','contacts','custom_records','pipelines','workflows','active_workflows','integrations','calendars']) AS metric
$$;
CREATE OR REPLACE FUNCTION reseller_publish_customer_event(workspace uuid,reseller uuid,actor uuid,event_type text,request uuid,details jsonb) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 BEGIN
  INSERT INTO public.outbox(id,tenant_id,type,resource_type,resource_id,actor_id,correlation_id,data)
   VALUES(gen_random_uuid(),workspace,event_type,'workspace',workspace,actor,request,details||jsonb_build_object('reseller_id',reseller,'tenant_id',workspace,'schema_version',1));
  INSERT INTO public.audit_events(id,tenant_id,actor_id,action,resource_id) VALUES(gen_random_uuid(),workspace,actor,event_type,workspace);
 END
$$;
CREATE OR REPLACE FUNCTION reseller_save_grant(reseller uuid,actor uuid,expected_version integer,definition jsonb) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE organization public.reseller_organizations; upstream public.platform_plan_versions; next_version integer;
 BEGIN
  SELECT * INTO organization FROM public.reseller_organizations WHERE id=reseller;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reseller does not exist' USING ERRCODE='23503';END IF;
  IF (expected_version=0 AND EXISTS(SELECT 1 FROM public.reseller_grant_versions WHERE reseller_id=reseller)) OR
   (expected_version<>0 AND organization.grant_version<>expected_version) THEN RAISE EXCEPTION 'The wholesale grant changed' USING ERRCODE='40001';END IF;
  SELECT * INTO upstream FROM public.platform_plan_versions WHERE plan_id=(definition->>'platform_plan_id')::uuid AND version=(definition->>'platform_plan_version')::integer;
  IF NOT FOUND THEN RAISE EXCEPTION 'Upstream plan version does not exist' USING ERRCODE='23503';END IF;
  PERFORM public.reseller_require_reduction(definition->'limits',definition->'features',upstream.limits,upstream.features);
  PERFORM public.reseller_validate_definition(definition->'aggregate_limits',definition->'features');
  next_version=expected_version+1;
  INSERT INTO public.reseller_grant_versions(reseller_id,version,platform_plan_id,platform_plan_version,max_workspaces,trial_days_max,limits,aggregate_limits,features,created_by)
   VALUES(reseller,next_version,upstream.plan_id,upstream.version,(definition->>'max_workspaces')::integer,(definition->>'trial_days_max')::integer,definition->'limits',definition->'aggregate_limits',definition->'features',actor);
  UPDATE public.reseller_organizations SET grant_version=next_version,updated_by=actor,updated_at=now() WHERE id=reseller;
  RETURN next_version;
 END
$$;
CREATE OR REPLACE FUNCTION platform_create_reseller(reseller uuid,actor uuid,input jsonb,grant_definition jsonb,change_reason text,request uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 BEGIN
  PERFORM public.reseller_require_platform_actor(actor,change_reason,ARRAY['owner','admin']);
  INSERT INTO public.reseller_organizations(id,key,name,contract_reference,billing_mode,contract_starts_at,contract_ends_at,customer_access_policy,created_by,updated_by)
   VALUES(reseller,input->>'key',input->>'name',input->>'contract_reference',input->>'billing_mode',(input->>'contract_starts_at')::timestamptz,(input->>'contract_ends_at')::timestamptz,input->>'customer_access_policy',actor,actor);
  -- The first grant is constructed through the same validation as later immutable publications.
  PERFORM public.reseller_save_grant(reseller,actor,0,grant_definition);
  INSERT INTO public.platform_audit(id,actor_id,action,resource_type,resource_id,reason,data,request_id)
   VALUES(gen_random_uuid(),actor,'platform.reseller.created','reseller',reseller,trim(change_reason),jsonb_build_object('status','pending','grant_version',1),request);
 END
$$;
CREATE OR REPLACE FUNCTION platform_publish_reseller_grant(reseller uuid,actor uuid,expected_version integer,definition jsonb,change_reason text,request uuid) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE next_version integer;workspace uuid;
 BEGIN
  PERFORM public.reseller_require_platform_actor(actor,change_reason,ARRAY['owner','admin','billing']);PERFORM public.reseller_lock_customer_change(reseller);
  next_version=public.reseller_save_grant(reseller,actor,expected_version,definition);
  INSERT INTO public.platform_audit(id,actor_id,action,resource_type,resource_id,reason,data,request_id)
   VALUES(gen_random_uuid(),actor,'platform.reseller.grant_published','reseller',reseller,trim(change_reason),jsonb_build_object('grant_version',next_version),request);
  FOR workspace IN SELECT tenant_id FROM public.reseller_workspace_links WHERE reseller_id=reseller LOOP
   PERFORM public.reseller_publish_customer_event(workspace,reseller,actor,'reseller.customer.plan_changed',request,jsonb_build_object('grant_version',next_version));
  END LOOP;
  RETURN next_version;
 END
$$;
CREATE OR REPLACE FUNCTION platform_update_reseller(reseller uuid,actor uuid,expected_version integer,input jsonb,change_reason text,request uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE previous public.reseller_organizations;workspace uuid;event_type text;
 BEGIN
  PERFORM public.reseller_require_platform_actor(actor,change_reason,ARRAY['owner','admin']);PERFORM public.reseller_lock_customer_change(reseller);
  SELECT * INTO previous FROM public.reseller_organizations WHERE id=reseller;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reseller does not exist' USING ERRCODE='23503';END IF;
  IF previous.version<>expected_version THEN RAISE EXCEPTION 'Reseller changed' USING ERRCODE='40001';END IF;
  UPDATE public.reseller_organizations SET name=input->>'name',status=input->>'status',customer_access_policy=input->>'customer_access_policy',
   contract_reference=input->>'contract_reference',billing_mode=input->>'billing_mode',contract_starts_at=(input->>'contract_starts_at')::timestamptz,
   contract_ends_at=(input->>'contract_ends_at')::timestamptz,version=version+1,updated_by=actor,updated_at=now() WHERE id=reseller;
  INSERT INTO public.platform_audit(id,actor_id,action,resource_type,resource_id,reason,data,request_id)
   VALUES(gen_random_uuid(),actor,'platform.reseller.updated','reseller',reseller,trim(change_reason),jsonb_build_object('before',to_jsonb(previous),'after',input,'version',expected_version+1),request);
  event_type=CASE WHEN input->>'status'='suspended' THEN 'reseller.organization.suspended' WHEN input->>'status'='active' THEN 'reseller.organization.activated' ELSE 'reseller.organization.updated' END;
  FOR workspace IN SELECT tenant_id FROM public.reseller_workspace_links WHERE reseller_id=reseller LOOP
   PERFORM public.reseller_publish_customer_event(workspace,reseller,actor,event_type,request,jsonb_build_object('version',expected_version+1,'customer_access_policy',input->>'customer_access_policy'));
  END LOOP;
 END
$$;
CREATE OR REPLACE FUNCTION platform_publish_retail_plan(reseller uuid,plan uuid,actor uuid,expected_version integer,plan_key text,definition jsonb,change_reason text,request uuid) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE upstream public.reseller_grant_versions;previous public.reseller_retail_plans;next_version integer;
 BEGIN
  PERFORM public.reseller_require_platform_actor(actor,change_reason,ARRAY['owner','admin','billing']);PERFORM public.reseller_lock(reseller);PERFORM public.reseller_require_active(reseller);
  SELECT g.* INTO upstream FROM public.reseller_grant_versions g JOIN public.reseller_organizations r ON r.id=g.reseller_id AND r.grant_version=g.version WHERE r.id=reseller;
  SELECT * INTO previous FROM public.reseller_retail_plans WHERE id=plan;
  IF FOUND THEN
   IF previous.reseller_id<>reseller THEN RAISE EXCEPTION 'This retail plan belongs to another reseller' USING ERRCODE='42501';END IF;
   IF previous.current_version<>expected_version THEN RAISE EXCEPTION 'Retail plan changed' USING ERRCODE='40001';END IF;
  ELSIF expected_version<>0 THEN RAISE EXCEPTION 'Retail plan does not exist' USING ERRCODE='23503';END IF;
  PERFORM public.reseller_require_reduction(definition->'limits',definition->'features',upstream.limits,upstream.features);
  IF (definition->>'trial_days')::integer>upstream.trial_days_max THEN RAISE EXCEPTION 'The retail trial exceeds the wholesale allowance' USING ERRCODE='DK003';END IF;
  next_version=expected_version+1;
  IF expected_version=0 THEN INSERT INTO public.reseller_retail_plans(id,reseller_id,key) VALUES(plan,reseller,plan_key);END IF;
  INSERT INTO public.reseller_retail_plan_versions(plan_id,reseller_id,version,name,currency,monthly_price_minor,annual_price_minor,setup_price_minor,trial_days,limits,features,grant_version,created_by)
   VALUES(plan,reseller,next_version,definition->>'name',definition->>'currency',(definition->>'monthly_price_minor')::integer,(definition->>'annual_price_minor')::integer,(definition->>'setup_price_minor')::integer,(definition->>'trial_days')::integer,definition->'limits',definition->'features',upstream.version,actor);
  UPDATE public.reseller_retail_plans SET current_version=next_version,updated_at=now() WHERE id=plan;
  INSERT INTO public.platform_audit(id,actor_id,action,resource_type,resource_id,reason,data,request_id)
   VALUES(gen_random_uuid(),actor,'platform.reseller.retail_plan_published','retail_plan',plan,trim(change_reason),jsonb_build_object('reseller_id',reseller,'version',next_version,'grant_version',upstream.version),request);
  RETURN next_version;
 END
$$;
CREATE OR REPLACE FUNCTION platform_assign_reseller_workspace(workspace uuid,actor uuid,expected_version integer,reseller uuid,plan uuid,plan_version integer,change_reason text,request uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE previous public.reseller_workspace_links;upstream public.reseller_grant_versions;retail public.reseller_retail_plan_versions;parent uuid;metric text;cap bigint;count_customers bigint;
 BEGIN
  PERFORM public.reseller_require_platform_actor(actor,change_reason,ARRAY['owner','admin']);
  IF NOT EXISTS(SELECT 1 FROM public.workspaces WHERE id=workspace) THEN RAISE EXCEPTION 'Workspace does not exist' USING ERRCODE='23503';END IF;
  PERFORM 1 FROM public.workspaces WHERE id=workspace FOR KEY SHARE;
  SELECT * INTO previous FROM public.reseller_workspace_links WHERE tenant_id=workspace;
  IF NOT FOUND THEN RAISE EXCEPTION 'Workspace commercial assignment is unavailable' USING ERRCODE='23503';END IF;
  -- Referenced workspace row first, sorted parent locks next, then the workspace entitlement lock.
  FOR parent IN SELECT DISTINCT x FROM unnest(ARRAY[previous.reseller_id,reseller]) AS x WHERE x IS NOT NULL ORDER BY x LOOP PERFORM public.reseller_lock(parent);END LOOP;
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace-entitlements:'||workspace::text,0));
  IF coalesce((SELECT version FROM public.reseller_workspace_links WHERE tenant_id=workspace),0)<>expected_version THEN
   RAISE EXCEPTION 'Customer ownership changed' USING ERRCODE='40001';END IF;
  IF reseller IS NULL THEN
   IF plan IS NOT NULL OR plan_version IS NOT NULL THEN RAISE EXCEPTION 'A direct customer cannot have a retail plan' USING ERRCODE='22023';END IF;
  ELSE
   PERFORM public.reseller_require_active(reseller);
   SELECT g.* INTO upstream FROM public.reseller_grant_versions g JOIN public.reseller_organizations r ON r.id=g.reseller_id AND r.grant_version=g.version WHERE r.id=reseller;
   SELECT * INTO retail FROM public.reseller_retail_plan_versions WHERE plan_id=plan AND version=plan_version AND reseller_id=reseller;
   IF NOT FOUND THEN RAISE EXCEPTION 'The retail plan does not belong to this reseller' USING ERRCODE='23503';END IF;
   PERFORM public.reseller_require_reduction(retail.limits,retail.features,upstream.limits,upstream.features);
   IF retail.trial_days>upstream.trial_days_max THEN RAISE EXCEPTION 'The retail trial exceeds the current wholesale allowance' USING ERRCODE='DK003';END IF;
   IF previous.reseller_id IS DISTINCT FROM reseller THEN
    SELECT count(*) INTO count_customers FROM public.reseller_workspace_links WHERE reseller_id=reseller;
    IF upstream.max_workspaces IS NOT NULL AND count_customers>=upstream.max_workspaces THEN RAISE EXCEPTION 'The reseller has reached its customer workspace limit' USING ERRCODE='DK001';END IF;
    FOR metric IN SELECT jsonb_object_keys(upstream.aggregate_limits) LOOP
     cap=(upstream.aggregate_limits->>metric)::bigint;
     IF cap IS NOT NULL AND public.reseller_resource_gauge(reseller,metric)+public.platform_resource_gauge(workspace,metric)>cap THEN
      RAISE EXCEPTION 'The customer exceeds the reseller shared % allowance',replace(metric,'_',' ') USING ERRCODE='DK001';END IF;
    END LOOP;
   END IF;
  END IF;
  UPDATE public.reseller_workspace_links SET reseller_id=reseller,retail_plan_id=plan,retail_plan_version=plan_version,version=expected_version+1,updated_by=actor,updated_at=now() WHERE tenant_id=workspace;
  INSERT INTO public.platform_audit(id,actor_id,action,resource_type,resource_id,reason,data,request_id)
   VALUES(gen_random_uuid(),actor,'platform.reseller.customer_assigned','workspace',workspace,trim(change_reason),jsonb_build_object('before',to_jsonb(previous),'after',jsonb_build_object('reseller_id',reseller,'retail_plan_id',plan,'retail_plan_version',plan_version,'version',expected_version+1)),request);
  PERFORM public.reseller_publish_customer_event(workspace,reseller,actor,CASE WHEN previous.reseller_id IS DISTINCT FROM reseller THEN 'reseller.customer.transferred' ELSE 'reseller.customer.plan_changed' END,request,
   jsonb_build_object('previous_reseller_id',previous.reseller_id,'retail_plan_id',plan,'retail_plan_version',plan_version,'version',expected_version+1));
 END
$$;
CREATE OR REPLACE FUNCTION workspace_entitlements(workspace_id uuid) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE assignment public.platform_workspace_entitlements;definition public.platform_plan_versions;link public.reseller_workspace_links;
  wholesale public.reseller_grant_versions;retail public.reseller_retail_plan_versions;effective_limits jsonb;effective_features jsonb;metric text;cap bigint;upstream_cap bigint;result jsonb;
 BEGIN
  IF session_user NOT IN ('drykraft_platform','postgres') AND workspace_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN
   RAISE EXCEPTION 'Workspace entitlement lookup is not permitted' USING ERRCODE='42501';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.workspaces WHERE id=workspace_id) THEN RETURN NULL;END IF;
  SELECT * INTO assignment FROM public.platform_workspace_entitlements WHERE tenant_id=workspace_id;
  SELECT * INTO definition FROM public.platform_plan_versions WHERE plan_id=coalesce(assignment.plan_id,'00000000-0000-4000-8000-000000000001') AND version=coalesce(assignment.plan_version,1);
  effective_limits=definition.limits||coalesce(assignment.overrides->'limits','{}');effective_features=definition.features||coalesce(assignment.overrides->'features','{}');
  result=jsonb_build_object('plan_id',definition.plan_id,'plan_version',definition.version,'version',coalesce(assignment.version,1),'name',definition.name,'kind',definition.kind,
   'monthly_price_minor',definition.monthly_price_minor,'annual_price_minor',definition.annual_price_minor,'currency',definition.currency,
   'agreement_active',coalesce((assignment.agreement->>'starts_at')::timestamptz<=now() AND (assignment.agreement->>'ends_at')::timestamptz>now(),false),
   'agreement_seats',(assignment.agreement->>'seats')::integer,'agreement_ends_at',assignment.agreement->>'ends_at');
  SELECT * INTO link FROM public.reseller_workspace_links WHERE tenant_id=workspace_id;
  IF link.reseller_id IS NOT NULL THEN
   SELECT g.* INTO wholesale FROM public.reseller_grant_versions g JOIN public.reseller_organizations r ON r.id=g.reseller_id AND r.grant_version=g.version WHERE r.id=link.reseller_id;
   SELECT * INTO retail FROM public.reseller_retail_plan_versions WHERE plan_id=link.retail_plan_id AND version=link.retail_plan_version;
   FOR metric IN SELECT jsonb_object_keys(effective_limits) LOOP
    cap=(effective_limits->>metric)::bigint;
    upstream_cap=(wholesale.limits->>metric)::bigint;
    IF upstream_cap IS NOT NULL THEN cap=least(cap,upstream_cap);END IF;
    upstream_cap=(retail.limits->>metric)::bigint;
    IF upstream_cap IS NOT NULL THEN cap=least(cap,upstream_cap);END IF;
    effective_limits=jsonb_set(effective_limits,ARRAY[metric],coalesce(to_jsonb(cap),'null'::jsonb));
   END LOOP;
   FOR metric IN SELECT jsonb_object_keys(effective_features) LOOP
    effective_features=jsonb_set(effective_features,ARRAY[metric],to_jsonb((effective_features->>metric)::boolean AND (wholesale.features->>metric)::boolean AND (retail.features->>metric)::boolean));
   END LOOP;
   result=result||jsonb_build_object('reseller',jsonb_build_object('id',link.reseller_id,'assignment_version',link.version,'grant_version',wholesale.version,'retail_plan_id',retail.plan_id,'retail_plan_version',retail.version,
    'retail_name',retail.name,'currency',retail.currency,'monthly_price_minor',retail.monthly_price_minor,'annual_price_minor',retail.annual_price_minor,'setup_price_minor',retail.setup_price_minor,'trial_days',least(retail.trial_days,wholesale.trial_days_max)));
  END IF;
  RETURN result||jsonb_build_object('limits',effective_limits,'features',effective_features);
 END
$$;
CREATE OR REPLACE FUNCTION platform_workspace_suspended(workspace_id uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT coalesce((SELECT suspended FROM public.platform_workspace_controls WHERE tenant_id=workspace_id),false) OR EXISTS(
  SELECT 1 FROM public.reseller_workspace_links l JOIN public.reseller_organizations r ON r.id=l.reseller_id WHERE l.tenant_id=workspace_id AND r.customer_access_policy='suspend_access'
   AND (r.status<>'active' OR r.contract_starts_at>now() OR r.contract_ends_at<=now()))
$$;
-- A lookup before taking locks must be revalidated after the workspace lock, including direct-to-reseller transitions.
CREATE OR REPLACE FUNCTION lock_workspace_reseller_commercial(workspace uuid) RETURNS uuid
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE parent uuid;initial_version integer;
 BEGIN
  PERFORM 1 FROM public.workspaces WHERE id=workspace FOR KEY SHARE;
  SELECT reseller_id,version INTO parent,initial_version FROM public.reseller_workspace_links WHERE tenant_id=workspace;
  IF parent IS NOT NULL THEN PERFORM public.reseller_lock(parent);END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace-entitlements:'||workspace::text,0));
  IF coalesce((SELECT version FROM public.reseller_workspace_links WHERE tenant_id=workspace),0)<>coalesce(initial_version,0) THEN
   RAISE EXCEPTION 'Customer ownership changed during this action. Retry with current details.' USING ERRCODE='40001';END IF;
  RETURN parent;
 END
$$;

CREATE OR REPLACE FUNCTION guard_workspace_resource() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE reseller uuid; aggregate_cap bigint; metric text; secondary text; cap bigint; entitlements jsonb; capability text; old_record jsonb; new_record jsonb;
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
  reseller=public.lock_workspace_reseller_commercial(NEW.tenant_id);
  IF reseller IS NOT NULL AND public.platform_workspace_suspended(NEW.tenant_id) THEN RAISE EXCEPTION 'This reseller customer workspace is suspended' USING ERRCODE='DK002';END IF;
  IF capability IS NOT NULL THEN PERFORM public.workspace_require_capability(NEW.tenant_id,capability);END IF;
  IF metric IS NULL AND secondary IS NULL THEN RETURN NEW;END IF;
  entitlements=public.workspace_entitlements(NEW.tenant_id);
  FOR metric IN SELECT unnest(ARRAY[metric,secondary]) LOOP
   IF metric IS NULL THEN CONTINUE;END IF;
   cap=(entitlements->'limits'->>metric)::bigint;
   IF cap IS NOT NULL AND public.platform_resource_gauge(NEW.tenant_id,metric)>=cap THEN
    RAISE EXCEPTION 'The workspace has reached its % limit (%). Ask the owner to review the plan.',replace(metric,'_',' '),cap USING ERRCODE='DK001';
   END IF;
   IF reseller IS NOT NULL THEN
    SELECT (g.aggregate_limits->>metric)::bigint INTO aggregate_cap FROM public.reseller_grant_versions g JOIN public.reseller_organizations r ON r.id=g.reseller_id AND r.grant_version=g.version WHERE r.id=reseller;
    IF aggregate_cap IS NOT NULL AND public.reseller_resource_gauge(reseller,metric)>=aggregate_cap THEN
     RAISE EXCEPTION 'The reseller has reached its shared % limit (%). Ask the owner to review the plan.',replace(metric,'_',' '),aggregate_cap USING ERRCODE='DK001';END IF;
   END IF;
  END LOOP;
  RETURN NEW;
 END
$$;
REVOKE ALL ON FUNCTION reseller_seed_direct_workspace(),reseller_lock_customer_change(uuid),reseller_immutable_version(),reseller_validate_definition(jsonb,jsonb),reseller_require_reduction(jsonb,jsonb,jsonb,jsonb),reseller_require_platform_actor(uuid,text,text[]),reseller_lock(uuid),reseller_require_active(uuid),reseller_resource_gauge(uuid,text),reseller_resource_gauges(uuid),reseller_publish_customer_event(uuid,uuid,uuid,text,uuid,jsonb),reseller_save_grant(uuid,uuid,integer,jsonb),lock_workspace_reseller_commercial(uuid),platform_create_reseller(uuid,uuid,jsonb,jsonb,text,uuid),platform_publish_reseller_grant(uuid,uuid,integer,jsonb,text,uuid),platform_update_reseller(uuid,uuid,integer,jsonb,text,uuid),platform_publish_retail_plan(uuid,uuid,uuid,integer,text,jsonb,text,uuid),platform_assign_reseller_workspace(uuid,uuid,integer,uuid,uuid,integer,text,uuid) FROM PUBLIC,drykraft_app,drykraft_worker,drykraft_platform;
GRANT EXECUTE ON FUNCTION reseller_resource_gauges(uuid),platform_create_reseller(uuid,uuid,jsonb,jsonb,text,uuid),platform_publish_reseller_grant(uuid,uuid,integer,jsonb,text,uuid),platform_update_reseller(uuid,uuid,integer,jsonb,text,uuid),platform_publish_retail_plan(uuid,uuid,uuid,integer,text,jsonb,text,uuid),platform_assign_reseller_workspace(uuid,uuid,integer,uuid,uuid,integer,text,uuid) TO drykraft_platform;

-- The existing plan/trial writes use the same workspace-row-first order before their outbox FK checks.
CREATE OR REPLACE FUNCTION assign_platform_workspace_plan(workspace_id uuid,actor uuid,expected_version integer,selected_plan uuid,selected_version integer,requested_overrides jsonb,requested_agreement jsonb,change_reason text,request uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE previous public.platform_workspace_entitlements; definition public.platform_plan_versions; item record; current_version integer;
 BEGIN
  IF length(trim(change_reason)) NOT BETWEEN 10 AND 1000 OR NOT EXISTS(SELECT 1 FROM public.platform_accounts WHERE id=actor AND role IN ('owner','admin','billing') AND NOT disabled AND mfa_enabled_at IS NOT NULL) THEN
   RAISE EXCEPTION 'Plan management is not permitted' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM public.workspaces WHERE id=workspace_id FOR KEY SHARE;
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
  PERFORM 1 FROM public.workspaces WHERE id=workspace_id FOR KEY SHARE;
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
GRANT EXECUTE ON FUNCTION platform_workspace_suspended(uuid) TO drykraft_platform;
INSERT INTO schema_migrations(version) VALUES(27) ON CONFLICT DO NOTHING;
COMMIT;
