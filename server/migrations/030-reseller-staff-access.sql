BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='drykraft_reseller') THEN
  CREATE ROLE drykraft_reseller NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS reseller_accounts (
 id uuid PRIMARY KEY, email text UNIQUE NOT NULL CHECK(email=lower(email)),
 name text NOT NULL CHECK(length(name)>=2 AND length(name)<=100), password_hash text NOT NULL,
 disabled boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 auth_version integer NOT NULL DEFAULT 1 CHECK(auth_version>0), secret_ciphertext text,
 last_step bigint NOT NULL DEFAULT -1, recovery_hashes text[] NOT NULL DEFAULT '{}',
 mfa_enabled_at timestamptz, password_changed_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reseller_memberships (
 id uuid PRIMARY KEY, reseller_id uuid NOT NULL REFERENCES reseller_organizations(id),
 account_id uuid NOT NULL REFERENCES reseller_accounts(id), UNIQUE(reseller_id,account_id),
 role text NOT NULL CHECK(role IN ('owner','admin','support','billing')), disabled boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1 CHECK(version>0), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reseller_memberships_account ON reseller_memberships(account_id,reseller_id);
CREATE TABLE IF NOT EXISTS reseller_auth_challenges (
 token_hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES reseller_accounts(id),
 auth_version integer NOT NULL, verified_password_hash text NOT NULL, pending_ciphertext text,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0 AND attempts<=10),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reseller_challenges_account ON reseller_auth_challenges(account_id);
CREATE TABLE IF NOT EXISTS reseller_sessions (
 token_hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES reseller_accounts(id),
 selected_reseller_id uuid, FOREIGN KEY(selected_reseller_id,account_id) REFERENCES reseller_memberships(reseller_id,account_id),
 auth_version integer NOT NULL, expires_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL DEFAULT now(),
 user_agent text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reseller_sessions_account ON reseller_sessions(account_id);
CREATE TABLE IF NOT EXISTS reseller_audit (
 id uuid PRIMARY KEY, reseller_id uuid REFERENCES reseller_organizations(id), actor_id uuid REFERENCES reseller_accounts(id),
 platform_actor_id uuid REFERENCES platform_accounts(id), action text NOT NULL, resource_type text NOT NULL,
 resource_id uuid, reason text NOT NULL DEFAULT '', data jsonb NOT NULL DEFAULT '{}', request_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(actor_id IS NULL OR platform_actor_id IS NULL)
);
CREATE INDEX IF NOT EXISTS reseller_audit_page ON reseller_audit(reseller_id,id);
CREATE TABLE IF NOT EXISTS reseller_member_operations (
 id uuid PRIMARY KEY, reseller_id uuid NOT NULL REFERENCES reseller_organizations(id),
 actor_id uuid REFERENCES reseller_accounts(id), platform_actor_id uuid REFERENCES platform_accounts(id),
 request_id uuid NOT NULL, input_hash text NOT NULL CHECK(input_hash~'^[a-f0-9]{64}$'),
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((actor_id IS NULL)<>(platform_actor_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS reseller_member_staff_request ON reseller_member_operations(actor_id,request_id) WHERE actor_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reseller_member_platform_request ON reseller_member_operations(platform_actor_id,request_id) WHERE platform_actor_id IS NOT NULL;
DO $$ DECLARE t text; BEGIN
 FOR t IN SELECT unnest(ARRAY['reseller_accounts','reseller_memberships','reseller_auth_challenges','reseller_sessions','reseller_audit','reseller_member_operations']) LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,drykraft_app,drykraft_worker,drykraft_platform,drykraft_mail,drykraft_reseller_api,drykraft_reseller',t);
 END LOOP;
 FOR t IN SELECT unnest(ARRAY['reseller_accounts','reseller_auth_challenges','reseller_sessions','reseller_audit']) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename=t AND policyname='reseller_auth_service') THEN
   EXECUTE format('CREATE POLICY reseller_auth_service ON %I TO drykraft_reseller USING(true) WITH CHECK(true)',t);
  END IF;
 END LOOP;
END $$;
GRANT USAGE ON SCHEMA public TO drykraft_reseller;
GRANT SELECT ON reseller_accounts,reseller_auth_challenges,reseller_sessions TO drykraft_reseller;
GRANT UPDATE(name,password_hash,version,auth_version,secret_ciphertext,last_step,recovery_hashes,mfa_enabled_at,password_changed_at) ON reseller_accounts TO drykraft_reseller;
GRANT INSERT,UPDATE,DELETE ON reseller_auth_challenges TO drykraft_reseller;
GRANT INSERT,DELETE ON reseller_sessions TO drykraft_reseller;
GRANT UPDATE(last_seen_at) ON reseller_sessions TO drykraft_reseller;
GRANT INSERT ON reseller_audit TO drykraft_reseller;
-- Owner-only tables have no runtime ACL. Record the owner's existing grant authority explicitly:
-- pg_dump otherwise omits a default owner-only ACL, changing its catalog representation on restore.
-- No runtime principal gains table access; the exact restoration check keeps comparing stored ACLs.
DO $$ DECLARE t text; owner_name text; BEGIN
 FOR t IN SELECT unnest(ARRAY['reseller_memberships','reseller_member_operations']) LOOP
  SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid=t::regclass;
  EXECUTE format('GRANT ALL ON TABLE %I TO %I WITH GRANT OPTION',t,owner_name);
 END LOOP;
END $$;
DROP TRIGGER IF EXISTS immutable_version ON reseller_audit;
CREATE TRIGGER immutable_version BEFORE UPDATE OR DELETE ON reseller_audit FOR EACH ROW EXECUTE FUNCTION reseller_immutable_version();
DROP TRIGGER IF EXISTS immutable_version ON reseller_member_operations;
CREATE TRIGGER immutable_version BEFORE UPDATE OR DELETE ON reseller_member_operations FOR EACH ROW EXECUTE FUNCTION reseller_immutable_version();

-- These helpers are private to the security-definer entry points. They never accept a customer identity.
CREATE OR REPLACE FUNCTION reseller_staff_session_account(session_hash text) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE account uuid; a public.reseller_accounts; s public.reseller_sessions;
 BEGIN
  SELECT account_id INTO account FROM public.reseller_sessions WHERE token_hash=session_hash;
  IF account IS NULL THEN RAISE EXCEPTION 'Reseller session expired' USING ERRCODE='RS401';END IF;
  SELECT * INTO a FROM public.reseller_accounts WHERE id=account FOR SHARE;
  SELECT * INTO s FROM public.reseller_sessions WHERE token_hash=session_hash FOR SHARE;
  IF s.token_hash IS NULL OR a.disabled OR a.mfa_enabled_at IS NULL OR a.auth_version<>s.auth_version OR s.expires_at<=clock_timestamp() OR s.last_seen_at<=clock_timestamp()-interval '15 minutes' THEN
   RAISE EXCEPTION 'Reseller session expired or changed' USING ERRCODE='RS401';END IF;
  RETURN account;
 END
$$;
CREATE OR REPLACE FUNCTION reseller_staff_authorize(session_hash text,reseller uuid,allowed_roles text[],require_selection boolean DEFAULT true,require_active boolean DEFAULT true) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE account uuid; m public.reseller_memberships; organization public.reseller_organizations;
 BEGIN
  SELECT * INTO organization FROM public.reseller_organizations WHERE id=reseller FOR SHARE;
  account=public.reseller_staff_session_account(session_hash);
  SELECT * INTO m FROM public.reseller_memberships WHERE reseller_id=reseller AND account_id=account FOR SHARE;
  IF organization.id IS NULL OR m.id IS NULL OR m.disabled OR NOT m.role=ANY(allowed_roles) OR
   (require_selection AND (SELECT selected_reseller_id FROM public.reseller_sessions WHERE token_hash=session_hash) IS DISTINCT FROM reseller) THEN
   RAISE EXCEPTION 'Your reseller role cannot perform this action' USING ERRCODE='RS403';END IF;
  IF require_active AND (organization.status<>'active' OR organization.contract_starts_at>clock_timestamp() OR organization.contract_ends_at<=clock_timestamp()) THEN
   RAISE EXCEPTION 'This organization needs an active contract before management can continue' USING ERRCODE='RS403';END IF;
  RETURN account;
 END
$$;
CREATE OR REPLACE FUNCTION reseller_staff_session_info(session_hash text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE account uuid; result jsonb;
 BEGIN
  account=public.reseller_staff_session_account(session_hash);
  SELECT jsonb_build_object('account',jsonb_build_object('id',a.id,'name',a.name,'email',a.email,'version',a.version,'mfa_enabled',a.mfa_enabled_at IS NOT NULL),
   'expires_at',s.expires_at,'idle_timeout_seconds',900,'organization',(
    SELECT jsonb_build_object('id',r.id,'name',r.name,'key',r.key,'status',r.status,'role',m.role,'available',r.status='active' AND r.contract_starts_at<=clock_timestamp() AND r.contract_ends_at>clock_timestamp())
    FROM public.reseller_organizations r JOIN public.reseller_memberships m ON m.reseller_id=r.id WHERE r.id=s.selected_reseller_id AND m.account_id=account AND NOT m.disabled)) INTO result
   FROM public.reseller_accounts a JOIN public.reseller_sessions s ON s.account_id=a.id WHERE s.token_hash=session_hash;
  RETURN result;
 END
$$;
CREATE OR REPLACE FUNCTION reseller_staff_select(session_hash text,reseller uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 BEGIN
  PERFORM public.reseller_staff_authorize(session_hash,reseller,ARRAY['owner','admin','support','billing'],false,true);
  UPDATE public.reseller_sessions SET selected_reseller_id=reseller WHERE token_hash=session_hash;
  RETURN public.reseller_staff_session_info(session_hash);
 END
$$;
CREATE OR REPLACE FUNCTION reseller_staff_members(reseller uuid,platform_actor uuid,session_hash text,cursor_id uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE result jsonb;
 BEGIN
  IF (platform_actor IS NULL)=(session_hash IS NULL) THEN RAISE EXCEPTION 'Choose one administration identity' USING ERRCODE='RS403';END IF;
  IF platform_actor IS NOT NULL THEN
   PERFORM public.reseller_require_platform_actor(platform_actor,'Read organization team',ARRAY['owner','admin','viewer']);
   IF NOT EXISTS(SELECT 1 FROM public.reseller_organizations WHERE id=reseller) THEN RAISE EXCEPTION 'Reseller not found' USING ERRCODE='RS404';END IF;
  ELSE PERFORM public.reseller_staff_authorize(session_hash,reseller,ARRAY['owner','admin']);END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(page) ORDER BY page.id),'[]'::jsonb) INTO result FROM (
   SELECT m.id,m.account_id,a.name,a.email,m.role,m.disabled,m.version,a.mfa_enabled_at IS NOT NULL AS mfa_enabled,a.disabled AS account_disabled,m.created_at
   FROM public.reseller_memberships m JOIN public.reseller_accounts a ON a.id=m.account_id WHERE m.reseller_id=reseller AND (cursor_id IS NULL OR m.id>cursor_id) ORDER BY m.id LIMIT 26
  ) page;
  RETURN jsonb_build_object('items',result);
 END
$$;
CREATE OR REPLACE FUNCTION reseller_staff_save_member(reseller uuid,platform_actor uuid,session_hash text,member uuid,expected_version integer,input jsonb,change_reason text,request uuid,input_fingerprint text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE actor uuid; target uuid; previous public.reseller_memberships; actor_role text; saved jsonb; operation public.reseller_member_operations; next_role text; next_disabled boolean; account_uuid uuid;
 BEGIN
  IF (platform_actor IS NULL)=(session_hash IS NULL) OR length(trim(coalesce(change_reason,'')))<10 OR length(trim(change_reason))>1000 THEN
   RAISE EXCEPTION 'A permitted identity and reason are required' USING ERRCODE='RS403';END IF;
  -- One organization lock serializes last-owner decisions. NO KEY UPDATE permits session FK checks.
  PERFORM id FROM public.reseller_organizations WHERE id=reseller FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reseller not found' USING ERRCODE='RS404';END IF;
  IF member IS NOT NULL THEN
   SELECT * INTO previous FROM public.reseller_memberships WHERE id=member AND reseller_id=reseller;
   IF previous.id IS NULL THEN RAISE EXCEPTION 'Team member not found' USING ERRCODE='RS404';END IF;
   target=previous.account_id;
  ELSE SELECT id INTO target FROM public.reseller_accounts WHERE email=input->>'email';END IF;
  IF session_hash IS NOT NULL THEN SELECT account_id INTO actor FROM public.reseller_sessions WHERE token_hash=session_hash;END IF;
  -- Lock actor and target in the same order across organizations before validating the session.
  FOR account_uuid IN SELECT DISTINCT x FROM unnest(ARRAY[actor,target]) x WHERE x IS NOT NULL ORDER BY x LOOP
   PERFORM id FROM public.reseller_accounts WHERE id=account_uuid FOR UPDATE;
  END LOOP;
  IF platform_actor IS NOT NULL THEN
   PERFORM public.reseller_require_platform_actor(platform_actor,change_reason,ARRAY['owner','admin']);
  ELSE
   actor=public.reseller_staff_authorize(session_hash,reseller,ARRAY['owner','admin']);
   SELECT role INTO actor_role FROM public.reseller_memberships WHERE reseller_id=reseller AND account_id=actor;
  END IF;
  next_role=input->>'role';next_disabled=coalesce((input->>'disabled')::boolean,false);
  IF next_role IS NULL OR NOT next_role=ANY(ARRAY['owner','admin','support','billing']) THEN RAISE EXCEPTION 'Choose a reseller role' USING ERRCODE='RS400';END IF;
  IF actor_role='admin' AND (next_role='owner' OR previous.role='owner') THEN RAISE EXCEPTION 'Only an owner can manage owners' USING ERRCODE='RS403';END IF;
  IF member IS NULL THEN
   IF request IS NULL OR input_fingerprint IS NULL OR input_fingerprint!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'A setup request is required' USING ERRCODE='RS400';END IF;
   -- The actor lock serializes retries even when the request is sent to a different parent.
   IF platform_actor IS NOT NULL THEN PERFORM id FROM public.platform_accounts WHERE id=platform_actor FOR UPDATE;END IF;
   SELECT * INTO operation FROM public.reseller_member_operations WHERE request_id=request AND
    (platform_actor IS NOT NULL AND platform_actor_id=platform_actor OR actor IS NOT NULL AND actor_id=actor);
   IF operation.id IS NOT NULL THEN
    IF operation.reseller_id<>reseller OR operation.input_hash<>input_fingerprint THEN RAISE EXCEPTION 'This setup request was used with different details' USING ERRCODE='RS409';END IF;
    RETURN operation.result||jsonb_build_object('replayed',true);
   END IF;
   IF input->>'mode'='new_account' THEN
    IF target IS NOT NULL THEN RAISE EXCEPTION 'A reseller account already exists for this email. Choose existing account explicitly' USING ERRCODE='RS409';END IF;
    IF input->>'password_hash' IS NULL OR input->>'password_hash'!~'^[a-f0-9]{32}:[a-f0-9]{128}$' OR length(coalesce(input->>'name',''))<2 OR length(input->>'name')>100 OR input->>'email' IS NULL OR input->>'email'<>lower(input->>'email') THEN
     RAISE EXCEPTION 'New account details are invalid' USING ERRCODE='RS400';END IF;
    target=gen_random_uuid();
    INSERT INTO public.reseller_accounts(id,name,email,password_hash) VALUES(target,input->>'name',input->>'email',input->>'password_hash');
   ELSIF input->>'mode'='existing_account' THEN
    IF target IS NULL THEN RAISE EXCEPTION 'No reseller account exists for this email' USING ERRCODE='RS404';END IF;
    IF EXISTS(SELECT 1 FROM public.reseller_accounts WHERE id=target AND disabled) THEN RAISE EXCEPTION 'This reseller account is disabled' USING ERRCODE='RS403';END IF;
   ELSE RAISE EXCEPTION 'Choose new or existing reseller account' USING ERRCODE='RS400';END IF;
   IF EXISTS(SELECT 1 FROM public.reseller_memberships WHERE reseller_id=reseller AND account_id=target) THEN RAISE EXCEPTION 'This account is already on the team. Edit its saved membership' USING ERRCODE='RS409';END IF;
   IF NOT EXISTS(SELECT 1 FROM public.reseller_memberships m JOIN public.reseller_accounts a ON a.id=m.account_id WHERE m.reseller_id=reseller AND m.role='owner' AND NOT m.disabled AND NOT a.disabled) AND next_role<>'owner' THEN
    RAISE EXCEPTION 'The first team member must be an owner' USING ERRCODE='RS400';END IF;
   member=gen_random_uuid();
   INSERT INTO public.reseller_memberships(id,reseller_id,account_id,role) VALUES(member,reseller,target,next_role);
  ELSE
   IF expected_version IS NULL OR previous.version<>expected_version THEN RAISE EXCEPTION 'Team member changed. Refresh before saving' USING ERRCODE='RS409';END IF;
   IF previous.role='owner' AND NOT previous.disabled AND (next_role<>'owner' OR next_disabled) AND NOT EXISTS(
    SELECT 1 FROM public.reseller_memberships m JOIN public.reseller_accounts a ON a.id=m.account_id WHERE m.reseller_id=reseller AND m.id<>member AND m.role='owner' AND NOT m.disabled AND NOT a.disabled
   ) THEN RAISE EXCEPTION 'Keep at least one enabled organization owner' USING ERRCODE='RS409';END IF;
   IF previous.role IS DISTINCT FROM next_role OR previous.disabled IS DISTINCT FROM next_disabled THEN
    UPDATE public.reseller_memberships SET role=next_role,disabled=next_disabled,version=version+1,updated_at=now() WHERE id=member;
    UPDATE public.reseller_accounts SET auth_version=auth_version+1 WHERE id=target;
    DELETE FROM public.reseller_sessions WHERE account_id=target;
    DELETE FROM public.reseller_auth_challenges WHERE account_id=target;
   ELSE RETURN jsonb_build_object('id',member,'account_id',target,'version',previous.version,'unchanged',true);END IF;
  END IF;
  SELECT jsonb_build_object('id',m.id,'account_id',a.id,'name',a.name,'email',a.email,'role',m.role,'disabled',m.disabled,'version',m.version,'mfa_enabled',a.mfa_enabled_at IS NOT NULL) INTO saved
   FROM public.reseller_memberships m JOIN public.reseller_accounts a ON a.id=m.account_id WHERE m.id=member;
  INSERT INTO public.reseller_audit(id,reseller_id,actor_id,platform_actor_id,action,resource_type,resource_id,reason,data,request_id)
   VALUES(gen_random_uuid(),reseller,actor,platform_actor,CASE WHEN previous.id IS NULL THEN 'reseller.member.created' ELSE 'reseller.member.updated' END,'membership',member,trim(change_reason),
    jsonb_build_object('before',CASE WHEN previous.id IS NULL THEN NULL ELSE jsonb_build_object('role',previous.role,'disabled',previous.disabled,'version',previous.version) END,'after',saved),request);
  IF platform_actor IS NOT NULL THEN
   INSERT INTO public.platform_audit(id,actor_id,action,resource_type,resource_id,reason,data,request_id) VALUES(gen_random_uuid(),platform_actor,
    CASE WHEN previous.id IS NULL THEN 'platform.reseller.member.created' ELSE 'platform.reseller.member.updated' END,'reseller',reseller,trim(change_reason),saved,request);
  END IF;
  IF previous.id IS NULL THEN INSERT INTO public.reseller_member_operations(id,reseller_id,actor_id,platform_actor_id,request_id,input_hash,result) VALUES(gen_random_uuid(),reseller,actor,platform_actor,request,input_fingerprint,saved);END IF;
  RETURN saved||jsonb_build_object('replayed',false);
 END
$$;

CREATE OR REPLACE FUNCTION reseller_staff_read(session_hash text,section text,cursor_id uuid DEFAULT NULL,resource_id uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE reseller uuid; account uuid; result jsonb; role_name text;
 BEGIN
  IF section='organizations' THEN
   account=public.reseller_staff_session_account(session_hash);
   SELECT coalesce(jsonb_agg(to_jsonb(page) ORDER BY page.id),'[]'::jsonb) INTO result FROM (
    SELECT r.id,r.name,r.key,r.status,m.role,r.status='active' AND r.contract_starts_at<=clock_timestamp() AND r.contract_ends_at>clock_timestamp() AS available
    FROM public.reseller_memberships m JOIN public.reseller_organizations r ON r.id=m.reseller_id WHERE m.account_id=account AND NOT m.disabled AND (cursor_id IS NULL OR r.id>cursor_id) ORDER BY r.id LIMIT 26
   ) page;RETURN jsonb_build_object('items',result);
  END IF;
  SELECT selected_reseller_id INTO reseller FROM public.reseller_sessions WHERE token_hash=session_hash;
  IF reseller IS NULL THEN PERFORM public.reseller_staff_session_account(session_hash);RAISE EXCEPTION 'Choose your organization first' USING ERRCODE='RS403';END IF;
  account=public.reseller_staff_authorize(session_hash,reseller,ARRAY['owner','admin','support','billing']);
  SELECT role INTO role_name FROM public.reseller_memberships WHERE reseller_id=reseller AND account_id=account;
  IF section='members' THEN RETURN public.reseller_staff_members(reseller,NULL,session_hash,cursor_id);
  ELSIF section='overview' THEN
   SELECT jsonb_build_object('reseller_id',r.id,'name',r.name,'key',r.key,'status',r.status,'role',role_name,'customer_count',(SELECT count(*) FROM public.reseller_workspace_links WHERE reseller_id=reseller),
    'grant_version',r.grant_version,'max_workspaces',g.max_workspaces,'limits',g.limits,'aggregate_limits',g.aggregate_limits,'features',g.features,
    'usage',public.reseller_resource_gauges(reseller)) INTO result FROM public.reseller_organizations r JOIN public.reseller_grant_versions g ON g.reseller_id=r.id AND g.version=r.grant_version WHERE r.id=reseller;
  ELSIF section='customers' THEN
   SELECT coalesce(jsonb_agg(to_jsonb(page) ORDER BY page.id),'[]'::jsonb) INTO result FROM (
    SELECT w.id,w.name,w.slug,w.created_at,l.version,l.retail_plan_id,l.retail_plan_version,v.name AS retail_plan_name,public.platform_workspace_suspended(w.id) AS suspended
    FROM public.reseller_workspace_links l JOIN public.workspaces w ON w.id=l.tenant_id LEFT JOIN public.reseller_retail_plan_versions v ON v.plan_id=l.retail_plan_id AND v.version=l.retail_plan_version
    WHERE l.reseller_id=reseller AND (cursor_id IS NULL OR w.id>cursor_id) ORDER BY w.id LIMIT 26
   ) page;RETURN jsonb_build_object('items',result);
  ELSIF section='plans' THEN
   IF role_name='support' THEN RAISE EXCEPTION 'Your role cannot read commercial plans' USING ERRCODE='RS403';END IF;
   SELECT coalesce(jsonb_agg(to_jsonb(page) ORDER BY page.id),'[]'::jsonb) INTO result FROM (
    SELECT p.id,p.key,p.current_version,v.name,v.currency,v.monthly_price_minor,v.annual_price_minor,v.setup_price_minor,v.trial_days,v.limits,v.features
    FROM public.reseller_retail_plans p JOIN public.reseller_retail_plan_versions v ON v.plan_id=p.id AND v.version=p.current_version WHERE p.reseller_id=reseller AND (cursor_id IS NULL OR p.id>cursor_id) ORDER BY p.id LIMIT 26
   ) page;RETURN jsonb_build_object('items',result);
  ELSIF section='usage' THEN
   SELECT jsonb_build_object('reseller_id',reseller,'usage',public.reseller_resource_gauges(reseller),'aggregate_limits',g.aggregate_limits) INTO result
    FROM public.reseller_grant_versions g JOIN public.reseller_organizations r ON r.id=g.reseller_id AND r.grant_version=g.version WHERE r.id=reseller;
  ELSIF section='audit' THEN
   IF role_name NOT IN ('owner','admin') THEN RAISE EXCEPTION 'Your role cannot read team audit' USING ERRCODE='RS403';END IF;
   SELECT coalesce(jsonb_agg(to_jsonb(page) ORDER BY page.id),'[]'::jsonb) INTO result FROM (
    SELECT e.id,e.action,e.resource_type,e.resource_id,e.reason,e.data,e.created_at,CASE WHEN e.platform_actor_id IS NOT NULL THEN 'Platform administrator' ELSE a.name END AS actor_name
    FROM public.reseller_audit e LEFT JOIN public.reseller_accounts a ON a.id=e.actor_id WHERE e.reseller_id=reseller AND (cursor_id IS NULL OR e.id>cursor_id) ORDER BY e.id LIMIT 26
   ) page;RETURN jsonb_build_object('items',result);
  ELSE RAISE EXCEPTION 'Reseller page not found' USING ERRCODE='RS404';END IF;
  RETURN result;
END
$$;
CREATE OR REPLACE FUNCTION platform_reseller_members(reseller uuid,actor uuid,cursor_id uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.reseller_staff_members(reseller,actor,NULL,cursor_id)
$$;
CREATE OR REPLACE FUNCTION platform_save_reseller_member(reseller uuid,actor uuid,member uuid,expected_version integer,input jsonb,change_reason text,request uuid,input_fingerprint text) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.reseller_staff_save_member(reseller,actor,NULL,member,expected_version,input,change_reason,request,input_fingerprint)
$$;
CREATE OR REPLACE FUNCTION reseller_staff_save_team(session_hash text,member uuid,expected_version integer,input jsonb,change_reason text,request uuid,input_fingerprint text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE reseller uuid;
 BEGIN
  SELECT selected_reseller_id INTO reseller FROM public.reseller_sessions WHERE token_hash=session_hash;
  IF reseller IS NULL THEN PERFORM public.reseller_staff_session_account(session_hash);RAISE EXCEPTION 'Choose your organization first' USING ERRCODE='RS403';END IF;
  RETURN public.reseller_staff_save_member(reseller,NULL,session_hash,member,expected_version,input,change_reason,request,input_fingerprint);
 END
$$;
REVOKE ALL ON FUNCTION reseller_staff_session_account(text),reseller_staff_authorize(text,uuid,text[],boolean,boolean),reseller_staff_session_info(text),reseller_staff_select(text,uuid),reseller_staff_members(uuid,uuid,text,uuid),reseller_staff_save_member(uuid,uuid,text,uuid,integer,jsonb,text,uuid,text),reseller_staff_read(text,text,uuid,uuid)
 FROM PUBLIC,drykraft_app,drykraft_worker,drykraft_platform,drykraft_mail,drykraft_reseller_api,drykraft_reseller;
REVOKE ALL ON FUNCTION platform_reseller_members(uuid,uuid,uuid),platform_save_reseller_member(uuid,uuid,uuid,integer,jsonb,text,uuid,text),reseller_staff_save_team(text,uuid,integer,jsonb,text,uuid,text)
 FROM PUBLIC,drykraft_app,drykraft_worker,drykraft_platform,drykraft_mail,drykraft_reseller_api,drykraft_reseller;
GRANT EXECUTE ON FUNCTION reseller_staff_session_info(text),reseller_staff_select(text,uuid),reseller_staff_read(text,text,uuid,uuid),reseller_staff_save_team(text,uuid,integer,jsonb,text,uuid,text) TO drykraft_reseller;
GRANT EXECUTE ON FUNCTION platform_reseller_members(uuid,uuid,uuid),platform_save_reseller_member(uuid,uuid,uuid,integer,jsonb,text,uuid,text) TO drykraft_platform;
INSERT INTO schema_migrations(version) VALUES(30) ON CONFLICT DO NOTHING;
COMMIT;
