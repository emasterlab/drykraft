BEGIN;

-- Retail versions retain the actual author in the appropriate authentication realm.
ALTER TABLE reseller_retail_plan_versions ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE reseller_retail_plan_versions ADD COLUMN IF NOT EXISTS created_by_reseller_account_id uuid REFERENCES reseller_accounts(id);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='reseller_retail_plan_versions'::regclass AND conname='reseller_retail_version_author') THEN
  ALTER TABLE reseller_retail_plan_versions ADD CONSTRAINT reseller_retail_version_author CHECK((created_by IS NULL)<>(created_by_reseller_account_id IS NULL));
 END IF;
END $$;

CREATE TABLE IF NOT EXISTS reseller_plan_operations (
 id uuid PRIMARY KEY,reseller_id uuid NOT NULL REFERENCES reseller_organizations(id),actor_id uuid NOT NULL REFERENCES reseller_accounts(id),
 request_id uuid NOT NULL,input_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(actor_id,request_id)
);
ALTER TABLE reseller_plan_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE reseller_plan_operations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON reseller_plan_operations FROM PUBLIC,drykraft_app,drykraft_worker,drykraft_platform,drykraft_mail,drykraft_reseller_api,drykraft_reseller;
-- Persist owner-only ACLs explicitly so a paired dump/restore has the same catalog representation.
DO $$ DECLARE owner_name text;BEGIN
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid='reseller_plan_operations'::regclass;
 EXECUTE format('GRANT ALL ON reseller_plan_operations TO %I WITH GRANT OPTION',owner_name);
END $$;
DROP TRIGGER IF EXISTS immutable_version ON reseller_plan_operations;
CREATE TRIGGER immutable_version BEFORE UPDATE OR DELETE ON reseller_plan_operations FOR EACH ROW EXECUTE FUNCTION reseller_immutable_version();

CREATE OR REPLACE FUNCTION reseller_save_retail_version(reseller uuid,plan uuid,platform_actor uuid,staff_actor uuid,expected_version integer,plan_key text,definition jsonb) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE upstream public.reseller_grant_versions; previous public.reseller_retail_plans; next_version integer; price_key text;
 BEGIN
  IF (platform_actor IS NULL)=(staff_actor IS NULL) THEN RAISE EXCEPTION 'Choose one retail author' USING ERRCODE='RS403';END IF;
  IF expected_version IS NULL OR expected_version<0 OR plan IS NULL THEN RAISE EXCEPTION 'Choose a plan and current version' USING ERRCODE='RS400';END IF;
  SELECT g.* INTO upstream FROM public.reseller_grant_versions g JOIN public.reseller_organizations r ON r.id=g.reseller_id AND r.grant_version=g.version WHERE r.id=reseller;
  IF upstream.reseller_id IS NULL THEN RAISE EXCEPTION 'Wholesale grant not found' USING ERRCODE='RS404';END IF;
  SELECT * INTO previous FROM public.reseller_retail_plans WHERE id=plan;
  IF FOUND THEN
   IF previous.reseller_id<>reseller THEN RAISE EXCEPTION 'Retail plan not found' USING ERRCODE='RS404';END IF;
   IF previous.current_version<>expected_version THEN RAISE EXCEPTION 'Retail plan changed; refresh before publishing' USING ERRCODE='RS409';END IF;
  ELSIF expected_version<>0 THEN RAISE EXCEPTION 'Retail plan not found' USING ERRCODE='RS404';
  ELSIF plan_key IS NULL OR plan_key!~'^[a-z][a-z0-9-]{2,49}$' THEN RAISE EXCEPTION 'Choose a valid plan key' USING ERRCODE='RS400';END IF;
  IF jsonb_typeof(definition) IS DISTINCT FROM 'object' OR length(trim(coalesce(definition->>'name','')))<2 OR length(definition->>'name')>100 OR
   coalesce(definition->>'currency','')!~'^[A-Z]{3}$' OR jsonb_typeof(definition->'trial_days') IS DISTINCT FROM 'number' OR
   coalesce(definition->>'trial_days','')!~'^[0-9]+$' OR (definition->>'trial_days')::numeric>90 THEN
   RAISE EXCEPTION 'Choose a valid name, currency and trial' USING ERRCODE='RS400';
  END IF;
  FOR price_key IN SELECT unnest(ARRAY['monthly_price_minor','annual_price_minor','setup_price_minor']) LOOP
   IF jsonb_typeof(definition->price_key) IS DISTINCT FROM 'number' OR coalesce(definition->>price_key,'')!~'^[0-9]+$' OR (definition->>price_key)::numeric>1000000000 THEN
    RAISE EXCEPTION 'Prices must use nonnegative integer minor units' USING ERRCODE='RS400';END IF;
  END LOOP;
  PERFORM public.reseller_require_reduction(definition->'limits',definition->'features',upstream.limits,upstream.features);
  IF (definition->>'trial_days')::integer>upstream.trial_days_max THEN RAISE EXCEPTION 'The retail trial exceeds the wholesale allowance' USING ERRCODE='DK003';END IF;
  next_version=expected_version+1;
  IF expected_version=0 THEN INSERT INTO public.reseller_retail_plans(id,reseller_id,key) VALUES(plan,reseller,plan_key);END IF;
  INSERT INTO public.reseller_retail_plan_versions(plan_id,reseller_id,version,name,currency,monthly_price_minor,annual_price_minor,setup_price_minor,trial_days,limits,features,grant_version,created_by,created_by_reseller_account_id)
   VALUES(plan,reseller,next_version,trim(definition->>'name'),definition->>'currency',(definition->>'monthly_price_minor')::integer,(definition->>'annual_price_minor')::integer,(definition->>'setup_price_minor')::integer,(definition->>'trial_days')::integer,definition->'limits',definition->'features',upstream.version,platform_actor,staff_actor);
  UPDATE public.reseller_retail_plans SET current_version=next_version,updated_at=now() WHERE id=plan;
  RETURN next_version;
 END
$$;

CREATE OR REPLACE FUNCTION platform_publish_retail_plan(reseller uuid,plan uuid,actor uuid,expected_version integer,plan_key text,definition jsonb,change_reason text,request uuid) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE next_version integer; grant_version integer;
 BEGIN
  PERFORM public.reseller_require_platform_actor(actor,change_reason,ARRAY['owner','admin','billing']);
  PERFORM public.reseller_lock(reseller);PERFORM public.reseller_require_active(reseller);
  next_version=public.reseller_save_retail_version(reseller,plan,actor,NULL,expected_version,plan_key,definition);
  SELECT r.grant_version INTO grant_version FROM public.reseller_organizations r WHERE r.id=reseller;
  INSERT INTO public.platform_audit(id,actor_id,action,resource_type,resource_id,reason,data,request_id)
   VALUES(gen_random_uuid(),actor,'platform.reseller.retail_plan_published','retail_plan',plan,trim(change_reason),jsonb_build_object('reseller_id',reseller,'version',next_version,'grant_version',grant_version),request);
  RETURN next_version;
 EXCEPTION
  WHEN SQLSTATE 'RS400' THEN RAISE EXCEPTION '%',SQLERRM USING ERRCODE='22023';
  WHEN SQLSTATE 'RS404' THEN RAISE EXCEPTION '%',SQLERRM USING ERRCODE='23503';
  WHEN SQLSTATE 'RS409' THEN RAISE EXCEPTION '%',SQLERRM USING ERRCODE='40001';
 END
$$;

CREATE OR REPLACE FUNCTION reseller_staff_publish_plan(session_hash text,plan uuid,expected_version integer,plan_key text,definition jsonb,change_reason text,request uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE reseller uuid; actor uuid; saved public.reseller_plan_operations; fingerprint text; next_version integer; result jsonb; target uuid;
 BEGIN
  SELECT selected_reseller_id INTO reseller FROM public.reseller_sessions WHERE token_hash=session_hash;
  IF reseller IS NULL THEN PERFORM public.reseller_staff_session_account(session_hash);RAISE EXCEPTION 'Choose your organization first' USING ERRCODE='RS403';END IF;
  -- Commercial publication acquires its advisory lock before parent/account locks, like wholesale changes.
  PERFORM public.reseller_lock(reseller);
  actor=public.reseller_staff_authorize(session_hash,reseller,ARRAY['owner','admin']);
  IF request IS NULL OR length(trim(coalesce(change_reason,'')))<10 OR length(trim(change_reason))>1000 THEN RAISE EXCEPTION 'A request ID and reason are required' USING ERRCODE='RS400';END IF;
  fingerprint=encode(pg_catalog.sha256(convert_to(jsonb_build_object('reseller',reseller,'plan',plan,'version',expected_version,'key',plan_key,'definition',definition,'reason',trim(change_reason))::text,'UTF8')),'hex');
  SELECT * INTO saved FROM public.reseller_plan_operations WHERE actor_id=actor AND request_id=request;
  IF FOUND THEN
   IF saved.reseller_id<>reseller OR saved.input_hash<>fingerprint THEN RAISE EXCEPTION 'This request ID was used for a different publication' USING ERRCODE='RS409';END IF;
   RETURN saved.result||jsonb_build_object('replayed',true);
  END IF;
  IF (plan IS NULL AND expected_version IS DISTINCT FROM 0) OR (plan IS NOT NULL AND (expected_version IS NULL OR expected_version<1)) THEN
   RAISE EXCEPTION 'Choose a new plan or its current version' USING ERRCODE='RS400';END IF;
  target=coalesce(plan,gen_random_uuid());
  next_version=public.reseller_save_retail_version(reseller,target,NULL,actor,expected_version,plan_key,definition);
  SELECT jsonb_build_object('id',target,'reseller_id',reseller,'version',next_version,'grant_version',r.grant_version,'request_id',request,'replayed',false) INTO result FROM public.reseller_organizations r WHERE r.id=reseller;
  INSERT INTO public.reseller_plan_operations(id,reseller_id,actor_id,request_id,input_hash,result) VALUES(gen_random_uuid(),reseller,actor,request,fingerprint,result);
  INSERT INTO public.reseller_audit(id,reseller_id,actor_id,action,resource_type,resource_id,reason,data,request_id)
   VALUES(gen_random_uuid(),reseller,actor,'reseller.retail_plan.published','retail_plan',target,trim(change_reason),result,request);
  RETURN result;
 END
$$;

CREATE OR REPLACE FUNCTION reseller_staff_plan_history(session_hash text,plan uuid,before_version integer DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE reseller uuid; current_plan public.reseller_retail_plans; result jsonb;
 BEGIN
  SELECT selected_reseller_id INTO reseller FROM public.reseller_sessions WHERE token_hash=session_hash;
  IF reseller IS NULL THEN PERFORM public.reseller_staff_session_account(session_hash);RAISE EXCEPTION 'Choose your organization first' USING ERRCODE='RS403';END IF;
  PERFORM public.reseller_staff_authorize(session_hash,reseller,ARRAY['owner','admin','billing']);
  SELECT * INTO current_plan FROM public.reseller_retail_plans WHERE id=plan AND reseller_id=reseller;
  IF NOT FOUND THEN RAISE EXCEPTION 'Retail plan not found' USING ERRCODE='RS404';END IF;
  IF before_version IS NOT NULL AND before_version<1 THEN RAISE EXCEPTION 'Choose a positive history cursor' USING ERRCODE='RS400';END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(page) ORDER BY page.version DESC),'[]'::jsonb) INTO result FROM (
   SELECT v.version,v.name,v.currency,v.monthly_price_minor,v.annual_price_minor,v.setup_price_minor,v.trial_days,v.limits,v.features,v.grant_version,v.created_at,
    CASE WHEN v.created_by IS NOT NULL THEN 'Platform administrator' ELSE a.name END AS author_name
   FROM public.reseller_retail_plan_versions v LEFT JOIN public.reseller_accounts a ON a.id=v.created_by_reseller_account_id
   WHERE v.plan_id=plan AND v.reseller_id=reseller AND (before_version IS NULL OR v.version<before_version) ORDER BY v.version DESC LIMIT 26
  ) page;
  RETURN jsonb_build_object('id',current_plan.id,'key',current_plan.key,'reseller_id',reseller,'current_version',current_plan.current_version,'items',result);
 END
$$;
CREATE OR REPLACE FUNCTION reseller_staff_plan_receipt(session_hash text,request uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE reseller uuid; actor uuid; result jsonb;
 BEGIN
  SELECT selected_reseller_id INTO reseller FROM public.reseller_sessions WHERE token_hash=session_hash;
  IF reseller IS NULL THEN PERFORM public.reseller_staff_session_account(session_hash);RAISE EXCEPTION 'Choose your organization first' USING ERRCODE='RS403';END IF;
  actor=public.reseller_staff_authorize(session_hash,reseller,ARRAY['owner','admin']);
  SELECT o.result INTO result FROM public.reseller_plan_operations o WHERE o.reseller_id=reseller AND o.actor_id=actor AND o.request_id=request;
  IF NOT FOUND THEN RAISE EXCEPTION 'Publication receipt not found' USING ERRCODE='RS404';END IF;
  RETURN result;
 END
$$;
REVOKE ALL ON FUNCTION reseller_save_retail_version(uuid,uuid,uuid,uuid,integer,text,jsonb),reseller_staff_publish_plan(text,uuid,integer,text,jsonb,text,uuid),reseller_staff_plan_history(text,uuid,integer),reseller_staff_plan_receipt(text,uuid)
 FROM PUBLIC,drykraft_app,drykraft_worker,drykraft_platform,drykraft_mail,drykraft_reseller_api,drykraft_reseller;
GRANT EXECUTE ON FUNCTION reseller_staff_publish_plan(text,uuid,integer,text,jsonb,text,uuid),reseller_staff_plan_history(text,uuid,integer),reseller_staff_plan_receipt(text,uuid) TO drykraft_reseller;

CREATE OR REPLACE FUNCTION reseller_member_detail(reseller uuid,platform_actor uuid,session_hash text,member uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE result jsonb;
 BEGIN
  IF (platform_actor IS NULL)=(session_hash IS NULL) THEN RAISE EXCEPTION 'Choose one administration identity' USING ERRCODE='RS403';END IF;
  IF platform_actor IS NOT NULL THEN PERFORM public.reseller_require_platform_actor(platform_actor,'Read organization member',ARRAY['owner','admin','viewer']);
  ELSE PERFORM public.reseller_staff_authorize(session_hash,reseller,ARRAY['owner','admin']);END IF;
  SELECT jsonb_build_object('id',m.id,'account_id',m.account_id,'name',a.name,'email',a.email,'role',m.role,'disabled',m.disabled,'version',m.version,'mfa_enabled',a.mfa_enabled_at IS NOT NULL,'account_disabled',a.disabled,'created_at',m.created_at)
   INTO result FROM public.reseller_memberships m JOIN public.reseller_accounts a ON a.id=m.account_id WHERE m.id=member AND m.reseller_id=reseller;
  IF NOT FOUND THEN RAISE EXCEPTION 'Organization member not found' USING ERRCODE='RS404';END IF;
  RETURN result;
 END
$$;
CREATE OR REPLACE FUNCTION platform_reseller_member_detail(reseller uuid,actor uuid,member uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT public.reseller_member_detail(reseller,actor,NULL,member) $$;
CREATE OR REPLACE FUNCTION reseller_staff_member_detail(session_hash text,member uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE reseller uuid;
 BEGIN
  SELECT selected_reseller_id INTO reseller FROM public.reseller_sessions WHERE token_hash=session_hash;
  IF reseller IS NULL THEN PERFORM public.reseller_staff_session_account(session_hash);RAISE EXCEPTION 'Choose your organization first' USING ERRCODE='RS403';END IF;
  RETURN public.reseller_member_detail(reseller,NULL,session_hash,member);
 END
$$;
REVOKE ALL ON FUNCTION reseller_member_detail(uuid,uuid,text,uuid),platform_reseller_member_detail(uuid,uuid,uuid),reseller_staff_member_detail(text,uuid)
 FROM PUBLIC,drykraft_app,drykraft_worker,drykraft_platform,drykraft_mail,drykraft_reseller_api,drykraft_reseller;
GRANT EXECUTE ON FUNCTION platform_reseller_member_detail(uuid,uuid,uuid) TO drykraft_platform;
GRANT EXECUTE ON FUNCTION reseller_staff_member_detail(text,uuid) TO drykraft_reseller;

CREATE OR REPLACE FUNCTION reseller_staff_plan_allowance(session_hash text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE reseller uuid; result jsonb;
 BEGIN
  SELECT selected_reseller_id INTO reseller FROM public.reseller_sessions WHERE token_hash=session_hash;
  IF reseller IS NULL THEN PERFORM public.reseller_staff_session_account(session_hash);RAISE EXCEPTION 'Choose your organization first' USING ERRCODE='RS403';END IF;
  PERFORM public.reseller_staff_authorize(session_hash,reseller,ARRAY['owner','admin','billing']);
  SELECT jsonb_build_object('reseller_id',reseller,'grant_version',g.version,'trial_days_max',g.trial_days_max,'limits',g.limits,'features',g.features) INTO result
   FROM public.reseller_grant_versions g JOIN public.reseller_organizations r ON r.id=g.reseller_id AND r.grant_version=g.version WHERE r.id=reseller;
  RETURN result;
 END
$$;
CREATE OR REPLACE FUNCTION reseller_member_receipt(reseller uuid,platform_actor uuid,session_hash text,request uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE actor uuid; result jsonb;
 BEGIN
  IF (platform_actor IS NULL)=(session_hash IS NULL) THEN RAISE EXCEPTION 'Choose one administration identity' USING ERRCODE='RS403';END IF;
  IF platform_actor IS NOT NULL THEN PERFORM public.reseller_require_platform_actor(platform_actor,'Recover organization member creation',ARRAY['owner','admin']);
  ELSE actor=public.reseller_staff_authorize(session_hash,reseller,ARRAY['owner','admin']);END IF;
  SELECT o.result INTO result FROM public.reseller_member_operations o WHERE o.reseller_id=reseller AND o.request_id=request AND
   ((platform_actor IS NOT NULL AND o.platform_actor_id=platform_actor) OR (actor IS NOT NULL AND o.actor_id=actor));
  IF NOT FOUND THEN RAISE EXCEPTION 'Membership creation receipt not found' USING ERRCODE='RS404';END IF;
  RETURN result;
 END
$$;
CREATE OR REPLACE FUNCTION platform_reseller_member_receipt(reseller uuid,actor uuid,request uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT public.reseller_member_receipt(reseller,actor,NULL,request) $$;
CREATE OR REPLACE FUNCTION reseller_staff_member_receipt(session_hash text,request uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE reseller uuid;
 BEGIN
  SELECT selected_reseller_id INTO reseller FROM public.reseller_sessions WHERE token_hash=session_hash;
  IF reseller IS NULL THEN PERFORM public.reseller_staff_session_account(session_hash);RAISE EXCEPTION 'Choose your organization first' USING ERRCODE='RS403';END IF;
  RETURN public.reseller_member_receipt(reseller,NULL,session_hash,request);
 END
$$;
REVOKE ALL ON FUNCTION reseller_staff_plan_allowance(text),reseller_member_receipt(uuid,uuid,text,uuid),platform_reseller_member_receipt(uuid,uuid,uuid),reseller_staff_member_receipt(text,uuid)
 FROM PUBLIC,drykraft_app,drykraft_worker,drykraft_platform,drykraft_mail,drykraft_reseller_api,drykraft_reseller;
GRANT EXECUTE ON FUNCTION reseller_staff_plan_allowance(text),reseller_staff_member_receipt(text,uuid) TO drykraft_reseller;
GRANT EXECUTE ON FUNCTION platform_reseller_member_receipt(uuid,uuid,uuid) TO drykraft_platform;
INSERT INTO schema_migrations(version) VALUES(31) ON CONFLICT DO NOTHING;
COMMIT;
