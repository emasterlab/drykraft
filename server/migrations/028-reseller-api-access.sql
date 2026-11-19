BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='drykraft_reseller_api') THEN
  CREATE ROLE drykraft_reseller_api NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS reseller_api_keys (
 id uuid PRIMARY KEY, reseller_id uuid NOT NULL REFERENCES reseller_organizations(id),
 name text NOT NULL CHECK(length(name) BETWEEN 2 AND 100),
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 prefix text NOT NULL CHECK(prefix ~ '^dk_res_[a-f0-9]{8}$'),
 scopes text[] NOT NULL CHECK(cardinality(scopes) BETWEEN 1 AND 3 AND scopes <@ ARRAY['reseller.customers.read','reseller.plans.read','reseller.usage.read']::text[]),
 expires_at timestamptz NOT NULL, revoked_at timestamptz,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_by uuid NOT NULL REFERENCES platform_accounts(id), request_id uuid NOT NULL,
 input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(created_by,request_id), CHECK(expires_at>created_at AND expires_at<=created_at+interval '90 days')
);
CREATE INDEX IF NOT EXISTS reseller_api_keys_directory ON reseller_api_keys(reseller_id,id);
CREATE TABLE IF NOT EXISTS reseller_api_requests (
 id uuid PRIMARY KEY, reseller_id uuid NOT NULL REFERENCES reseller_organizations(id),
 key_id uuid NOT NULL REFERENCES reseller_api_keys(id),
 action text NOT NULL CHECK(action IN ('me','customers','plans','usage')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reseller_api_requests_directory ON reseller_api_requests(reseller_id,created_at DESC,id DESC);
DO $$ DECLARE t text; BEGIN
 FOR t IN SELECT unnest(ARRAY['reseller_api_keys','reseller_api_requests']) LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,drykraft_app,drykraft_worker,drykraft_mail,drykraft_reseller_api',t);
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename=t AND policyname='platform_only') THEN
   EXECUTE format('CREATE POLICY platform_only ON %I TO drykraft_platform USING(true) WITH CHECK(true)',t);
  END IF;
  EXECUTE format('GRANT SELECT ON %I TO drykraft_platform',t);
 END LOOP;
 GRANT INSERT ON reseller_api_keys TO drykraft_platform;
 GRANT UPDATE(revoked_at,version) ON reseller_api_keys TO drykraft_platform;
 GRANT USAGE ON SCHEMA public TO drykraft_reseller_api;
END $$;
CREATE OR REPLACE FUNCTION reseller_api_key_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['revoked_at','version']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revoked_at','version'])
   OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.version<>OLD.version+1 THEN
   RAISE EXCEPTION 'A reseller key can only be revoked once; replace it to change scope or expiry' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
 END
$$;
DROP TRIGGER IF EXISTS immutable_key ON reseller_api_keys;
CREATE TRIGGER immutable_key BEFORE UPDATE OR DELETE ON reseller_api_keys FOR EACH ROW EXECUTE FUNCTION reseller_api_key_immutable();
DROP TRIGGER IF EXISTS immutable_request ON reseller_api_requests;
CREATE TRIGGER immutable_request BEFORE UPDATE OR DELETE ON reseller_api_requests FOR EACH ROW EXECUTE FUNCTION reseller_immutable_version();
CREATE OR REPLACE FUNCTION platform_reseller_key_parent(reseller uuid,actor uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE organization public.reseller_organizations;
 BEGIN
  PERFORM public.reseller_require_platform_actor(actor,'Read reseller API key metadata',ARRAY['owner','admin','viewer']);
  SELECT * INTO organization FROM public.reseller_organizations WHERE id=reseller FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('id',organization.id,'available',organization.status='active' AND organization.contract_starts_at<=now() AND organization.contract_ends_at>now());
 END
$$;
-- Reseller runtime has no table privileges or customer service identity. Every read
-- rechecks the opaque key and contract in the database; a tenant GUC cannot select a parent.
CREATE OR REPLACE FUNCTION reseller_api_authorize(key_hash text,required_scope text) RETURNS reseller_api_keys
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE saved public.reseller_api_keys; organization public.reseller_organizations;
 BEGIN
  SELECT * INTO saved FROM public.reseller_api_keys WHERE token_hash=key_hash;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reseller API key is unavailable' USING ERRCODE='DR401'; END IF;
  -- Same parent-before-dependent-key order as key administration. Read locks let
  -- accepted requests finish before a revoke or contract suspension commits.
  SELECT * INTO organization FROM public.reseller_organizations WHERE id=saved.reseller_id FOR SHARE;
  SELECT * INTO saved FROM public.reseller_api_keys WHERE id=saved.id FOR SHARE;
  IF saved.revoked_at IS NOT NULL OR saved.expires_at<=now() THEN
   RAISE EXCEPTION 'Reseller API key expired or was revoked' USING ERRCODE='DR401';
  END IF;
  IF organization.status<>'active' OR organization.contract_starts_at>now() OR organization.contract_ends_at<=now() THEN
   RAISE EXCEPTION 'Reseller API access requires an active contract' USING ERRCODE='DR403';
  END IF;
  IF required_scope IS NOT NULL AND NOT required_scope=ANY(saved.scopes) THEN
   RAISE EXCEPTION 'This reseller API key does not allow this operation' USING ERRCODE='DR403';
  END IF;
  RETURN saved;
 END
$$;
CREATE OR REPLACE FUNCTION reseller_api_identity(key_hash text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE saved public.reseller_api_keys;
 BEGIN
  saved=public.reseller_api_authorize(key_hash,NULL);
  RETURN jsonb_build_object('reseller_id',saved.reseller_id,'key_id',saved.id,'scopes',saved.scopes,'expires_at',saved.expires_at);
 END
$$;
CREATE OR REPLACE FUNCTION reseller_api_read(key_hash text,section text,after_id uuid,request_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE saved public.reseller_api_keys; required_scope text; result jsonb; parent_name text;
 BEGIN
  required_scope=CASE section WHEN 'me' THEN NULL WHEN 'customers' THEN 'reseller.customers.read'
   WHEN 'plans' THEN 'reseller.plans.read' WHEN 'usage' THEN 'reseller.usage.read' ELSE 'invalid' END;
  IF required_scope='invalid' OR (after_id IS NOT NULL AND section IN ('me','usage')) THEN
   RAISE EXCEPTION 'Unsupported reseller request' USING ERRCODE='DR400';
  END IF;
  saved=public.reseller_api_authorize(key_hash,required_scope);
  IF section='me' THEN
   SELECT name INTO parent_name FROM public.reseller_organizations WHERE id=saved.reseller_id;
   result=jsonb_build_object('reseller_id',saved.reseller_id,'reseller_name',parent_name,'key_id',saved.id,'scopes',saved.scopes,'expires_at',saved.expires_at);
  ELSIF section='customers' THEN
   WITH page AS (
    SELECT w.id,w.name,w.slug,l.version,l.retail_plan_id,l.retail_plan_version,l.updated_at
    FROM public.reseller_workspace_links l JOIN public.workspaces w ON w.id=l.tenant_id
    WHERE l.reseller_id=saved.reseller_id AND (after_id IS NULL OR w.id>after_id) ORDER BY w.id LIMIT 26
   ), numbered AS (SELECT *,row_number() OVER(ORDER BY id) AS n FROM page)
   SELECT jsonb_build_object('items',coalesce(jsonb_agg(to_jsonb(numbered)-'n' ORDER BY id) FILTER(WHERE n<=25),'[]'::jsonb),
    'next_cursor',CASE WHEN count(*)>25 THEN (SELECT id FROM numbered WHERE n=25) ELSE NULL END) INTO result FROM numbered;
  ELSIF section='plans' THEN
   WITH page AS (
    SELECT p.id,p.key,p.current_version,v.name,v.currency,v.monthly_price_minor,v.annual_price_minor,v.setup_price_minor,
     v.trial_days,v.limits,v.features,v.grant_version
    FROM public.reseller_retail_plans p JOIN public.reseller_retail_plan_versions v ON v.plan_id=p.id AND v.version=p.current_version
    WHERE p.reseller_id=saved.reseller_id AND (after_id IS NULL OR p.id>after_id) ORDER BY p.id LIMIT 26
   ), numbered AS (SELECT *,row_number() OVER(ORDER BY id) AS n FROM page)
   SELECT jsonb_build_object('items',coalesce(jsonb_agg(to_jsonb(numbered)-'n' ORDER BY id) FILTER(WHERE n<=25),'[]'::jsonb),
    'next_cursor',CASE WHEN count(*)>25 THEN (SELECT id FROM numbered WHERE n=25) ELSE NULL END) INTO result FROM numbered;
  ELSE
   SELECT jsonb_build_object('reseller_id',saved.reseller_id,'usage',public.reseller_resource_gauges(saved.reseller_id),
    'customer_count',(SELECT count(*) FROM public.reseller_workspace_links WHERE reseller_id=saved.reseller_id),
    'grant_version',r.grant_version,'limits',g.limits,'aggregate_limits',g.aggregate_limits,'max_workspaces',g.max_workspaces,
    'features',g.features,'collection_configured',false) INTO result
   FROM public.reseller_organizations r JOIN public.reseller_grant_versions g ON g.reseller_id=r.id AND g.version=r.grant_version WHERE r.id=saved.reseller_id;
  END IF;
  INSERT INTO public.reseller_api_requests(id,reseller_id,key_id,action) VALUES(request_id,saved.reseller_id,saved.id,section);
  RETURN result;
 END
$$;
REVOKE ALL ON FUNCTION platform_reseller_key_parent(uuid,uuid),reseller_api_key_immutable(),reseller_api_authorize(text,text),reseller_api_identity(text),reseller_api_read(text,text,uuid,uuid) FROM PUBLIC,drykraft_app,drykraft_worker,drykraft_mail,drykraft_platform,drykraft_reseller_api;
GRANT EXECUTE ON FUNCTION platform_reseller_key_parent(uuid,uuid) TO drykraft_platform;
GRANT EXECUTE ON FUNCTION reseller_api_identity(text),reseller_api_read(text,text,uuid,uuid) TO drykraft_reseller_api;
INSERT INTO schema_migrations(version) VALUES(28) ON CONFLICT DO NOTHING;
COMMIT;
