BEGIN;
CREATE TABLE IF NOT EXISTS platform_user_controls (
 user_id uuid PRIMARY KEY REFERENCES users(id), disabled boolean NOT NULL DEFAULT false,
 reason text NOT NULL DEFAULT '',version integer NOT NULL DEFAULT 1 CHECK(version>0),
 updated_by uuid REFERENCES platform_accounts(id),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_workspace_invitations (
 tenant_id uuid NOT NULL REFERENCES workspaces(id),id uuid PRIMARY KEY,
 email text NOT NULL CHECK(email=lower(trim(email))),token_hash text UNIQUE NOT NULL,
 issued_by uuid NOT NULL REFERENCES platform_accounts(id),expires_at timestamptz NOT NULL,
 accepted_by uuid REFERENCES users(id),accepted_at timestamptz,revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((accepted_by IS NULL)=(accepted_at IS NULL)),CHECK(accepted_at IS NULL OR revoked_at IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_workspace_invitation_pending ON platform_workspace_invitations(tenant_id) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS platform_provisioning_operations (
 id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES platform_accounts(id),request_hash text NOT NULL,
 tenant_id uuid NOT NULL UNIQUE REFERENCES workspaces(id),invitation_id uuid NOT NULL REFERENCES platform_workspace_invitations(id),
 invitation_ciphertext text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE t text;BEGIN
 FOR t IN SELECT unnest(ARRAY['platform_user_controls','platform_workspace_invitations','platform_provisioning_operations']) LOOP
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
  GRANT INSERT ON platform_provisioning_operations TO drykraft_platform;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION platform_user_disabled(customer_id uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT coalesce((SELECT disabled FROM public.platform_user_controls WHERE user_id=customer_id),false)
$$;
REVOKE ALL ON FUNCTION platform_user_disabled(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_user_disabled(uuid) TO drykraft_app;
CREATE OR REPLACE FUNCTION platform_customer_management(customer_id uuid) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('id',u.id,'name',u.name,'email',u.email,'created_at',u.created_at,'mfa_enabled',u.mfa_enabled,
  'disabled',coalesce(p.disabled,false),'version',coalesce(p.version,1),'reason',coalesce(p.reason,''),
  'active_sessions',(SELECT count(*) FROM public.sessions WHERE user_id=u.id AND expires_at>now()),
  'workspace_count',(SELECT count(*) FROM public.memberships WHERE user_id=u.id))
 FROM public.users u LEFT JOIN public.platform_user_controls p ON p.user_id=u.id WHERE u.id=customer_id
$$;
CREATE OR REPLACE FUNCTION set_platform_customer_state(customer_id uuid,actor uuid,is_disabled boolean,expected_version integer,change_reason text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE previous public.platform_user_controls; current_version integer; workspace_id uuid; action text;
 BEGIN
  IF length(trim(change_reason)) NOT BETWEEN 10 AND 1000 OR NOT EXISTS(SELECT 1 FROM public.platform_accounts WHERE id=actor AND role IN ('owner','admin') AND NOT disabled AND mfa_enabled_at IS NOT NULL) THEN
   RAISE EXCEPTION 'Customer account management is not permitted' USING ERRCODE='42501';
  END IF;
  PERFORM id FROM public.users WHERE id=customer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer account does not exist' USING ERRCODE='23503';END IF;
  SELECT * INTO previous FROM public.platform_user_controls WHERE user_id=customer_id;
  current_version=coalesce(previous.version,1);
  IF current_version<>expected_version THEN RAISE EXCEPTION 'Customer status changed' USING ERRCODE='40001';END IF;
  IF coalesce(previous.disabled,false)=is_disabled THEN RETURN public.platform_customer_management(customer_id);END IF;
  INSERT INTO public.platform_user_controls(user_id,disabled,reason,version,updated_by) VALUES(customer_id,is_disabled,trim(change_reason),current_version+1,actor)
   ON CONFLICT(user_id) DO UPDATE SET disabled=excluded.disabled,reason=excluded.reason,version=excluded.version,updated_by=actor,updated_at=now();
  -- Serialize with all password/session issuance paths; restoration never resurrects old sessions.
  UPDATE public.users SET auth_version=auth_version+1 WHERE id=customer_id;
  DELETE FROM public.sessions WHERE user_id=customer_id;
  DELETE FROM public.auth_mfa_challenges WHERE user_id=customer_id;
  action=CASE WHEN is_disabled THEN 'platform.user.suspended' ELSE 'platform.user.restored' END;
  FOR workspace_id IN SELECT tenant_id FROM public.memberships WHERE user_id=customer_id LOOP
   PERFORM set_config('app.tenant_id',workspace_id::text,true);
   INSERT INTO public.outbox(id,tenant_id,type,resource_type,resource_id,actor_id,correlation_id,data)
    VALUES(gen_random_uuid(),workspace_id,action,'user',customer_id,actor,gen_random_uuid(),jsonb_build_object('disabled',is_disabled));
   INSERT INTO public.audit_events(tenant_id,id,actor_id,action,resource_id) VALUES(workspace_id,gen_random_uuid(),actor,action,customer_id);
  END LOOP;
  INSERT INTO public.platform_audit(id,actor_id,action,resource_type,resource_id,reason,data)
   VALUES(gen_random_uuid(),actor,action,'user',customer_id,trim(change_reason),jsonb_build_object('before',coalesce(previous.disabled,false),'after',is_disabled));
  RETURN public.platform_customer_management(customer_id);
 END
$$;
CREATE OR REPLACE FUNCTION provision_platform_workspace(actor uuid,workspace_id uuid,invitation_id uuid,invitation_hash text,input jsonb,blueprint jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE definition jsonb;
 BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.platform_accounts WHERE id=actor AND role IN ('owner','admin') AND NOT disabled AND mfa_enabled_at IS NOT NULL) THEN
   RAISE EXCEPTION 'Provisioning is not permitted' USING ERRCODE='42501';
  END IF;
  IF length(input->>'name') NOT BETWEEN 2 AND 100 OR input->>'slug' !~ '^[a-z][a-z0-9-]{2,39}$' OR invitation_hash !~ '^[a-f0-9]{64}$' OR jsonb_typeof(blueprint->'definitions')<>'array' OR jsonb_array_length(blueprint->'definitions') NOT BETWEEN 1 AND 100 THEN
   RAISE EXCEPTION 'Invalid provisioning configuration' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.workspaces(id,name,slug,settings) VALUES(workspace_id,input->>'name',input->>'slug',input->'settings');
  PERFORM set_config('app.tenant_id',workspace_id::text,true);
  FOR definition IN SELECT value FROM jsonb_array_elements(blueprint->'definitions') LOOP
   INSERT INTO public.object_definitions(tenant_id,key,name,singular_name,fields,built_in)
    VALUES(workspace_id,definition->>'key',definition->>'name',definition->>'singular_name',definition->'fields',true);
  END LOOP;
  INSERT INTO public.pipelines(tenant_id,id,name,stages) VALUES(workspace_id,gen_random_uuid(),'Sales pipeline',blueprint->'stages');
  INSERT INTO public.dashboards(tenant_id,id,name,widgets) VALUES(workspace_id,gen_random_uuid(),'Business overview',blueprint->'widgets');
  INSERT INTO public.platform_workspace_invitations(tenant_id,id,email,token_hash,issued_by,expires_at)
   VALUES(workspace_id,invitation_id,input->>'owner_email',invitation_hash,actor,now()+interval '7 days');
  INSERT INTO public.outbox(id,tenant_id,type,resource_type,resource_id,actor_id,correlation_id,data)
   VALUES(gen_random_uuid(),workspace_id,'platform.workspace.provisioned','workspace',workspace_id,actor,gen_random_uuid(),'{}');
  INSERT INTO public.audit_events(tenant_id,id,actor_id,action,resource_id) VALUES(workspace_id,gen_random_uuid(),actor,'platform.workspace.provisioned',workspace_id);
  RETURN jsonb_build_object('id',workspace_id,'invitation_id',invitation_id);
 END
$$;
CREATE OR REPLACE FUNCTION resolve_platform_workspace_invitation(requested_hash text) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('id',i.id,'tenant_id',i.tenant_id,'email',i.email,'role','owner','expires_at',i.expires_at,'accepted',i.accepted_at IS NOT NULL,'revoked',i.revoked_at IS NOT NULL,
  'sender_valid',NOT a.disabled AND a.role IN ('owner','admin') AND a.mfa_enabled_at IS NOT NULL,'workspace_name',w.name,'workspace_slug',w.slug)
 FROM public.platform_workspace_invitations i JOIN public.workspaces w ON w.id=i.tenant_id JOIN public.platform_accounts a ON a.id=i.issued_by WHERE i.token_hash=requested_hash
$$;
-- Lock the issuing platform account before workspace/user locks to serialize authority changes with acceptance.
CREATE OR REPLACE FUNCTION lock_platform_invitation_sender(requested_hash text) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE sender uuid;
 BEGIN
  SELECT issued_by INTO sender FROM public.platform_workspace_invitations WHERE token_hash=requested_hash AND expires_at>now() AND revoked_at IS NULL;
  IF sender IS NULL THEN RETURN false;END IF;
  PERFORM id FROM public.platform_accounts WHERE id=sender AND NOT disabled AND role IN ('owner','admin') AND mfa_enabled_at IS NOT NULL FOR SHARE;
  RETURN FOUND;
 END
$$;
CREATE OR REPLACE FUNCTION accept_platform_workspace_invitation(requested_hash text,customer_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE invite public.platform_workspace_invitations; customer public.users; workspace_name text; members integer;
 BEGIN
  SELECT * INTO invite FROM public.platform_workspace_invitations WHERE token_hash=requested_hash FOR UPDATE;
  IF NOT FOUND OR invite.expires_at<=now() OR invite.revoked_at IS NOT NULL OR public.platform_workspace_suspended(invite.tenant_id) THEN
   RAISE EXCEPTION 'Invitation is unavailable' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.platform_accounts WHERE id=invite.issued_by AND NOT disabled AND role IN ('owner','admin') AND mfa_enabled_at IS NOT NULL) THEN
   RAISE EXCEPTION 'Invitation authority changed' USING ERRCODE='42501';
  END IF;
  SELECT * INTO customer FROM public.users WHERE id=customer_id FOR UPDATE;
  IF NOT FOUND OR customer.email<>invite.email OR public.platform_user_disabled(customer_id) THEN
   RAISE EXCEPTION 'This account cannot accept this invitation' USING ERRCODE='42501';
  END IF;
  IF invite.accepted_at IS NOT NULL THEN
   IF invite.accepted_by<>customer_id OR NOT EXISTS(SELECT 1 FROM public.memberships WHERE tenant_id=invite.tenant_id AND user_id=customer_id AND role='owner') THEN
    RAISE EXCEPTION 'Invitation was already used' USING ERRCODE='22023';
   END IF;
   RETURN jsonb_build_object('id',invite.tenant_id,'already_accepted',true);
  END IF;
  IF EXISTS(SELECT 1 FROM public.memberships WHERE tenant_id=invite.tenant_id AND role='owner') THEN
   RAISE EXCEPTION 'Workspace ownership changed' USING ERRCODE='40001';
  END IF;
  PERFORM set_config('app.tenant_id',invite.tenant_id::text,true);
  INSERT INTO public.memberships(tenant_id,user_id,role) VALUES(invite.tenant_id,customer_id,'owner');
  UPDATE public.platform_workspace_invitations SET accepted_by=customer_id,accepted_at=now() WHERE id=invite.id;
  INSERT INTO public.outbox(id,tenant_id,type,resource_type,resource_id,actor_id,correlation_id,data)
   VALUES(gen_random_uuid(),invite.tenant_id,'workspace.member.joined','member',customer_id,customer_id,gen_random_uuid(),jsonb_build_object('role','owner','invitation_id',invite.id));
  INSERT INTO public.audit_events(tenant_id,id,actor_id,action,resource_id) VALUES(invite.tenant_id,gen_random_uuid(),customer_id,'workspace.member.joined',customer_id);
  INSERT INTO public.platform_audit(id,actor_id,action,resource_type,resource_id,data)
   VALUES(gen_random_uuid(),invite.issued_by,'platform.workspace.owner_joined','workspace',invite.tenant_id,jsonb_build_object('user_id',customer_id,'invitation_id',invite.id));
  RETURN jsonb_build_object('id',invite.tenant_id,'already_accepted',false);
 END
$$;
REVOKE ALL ON FUNCTION platform_customer_management(uuid),set_platform_customer_state(uuid,uuid,boolean,integer,text),provision_platform_workspace(uuid,uuid,uuid,text,jsonb,jsonb) FROM PUBLIC,drykraft_app,drykraft_worker;
REVOKE ALL ON FUNCTION resolve_platform_workspace_invitation(text),lock_platform_invitation_sender(text),accept_platform_workspace_invitation(text,uuid) FROM PUBLIC,drykraft_worker;
GRANT EXECUTE ON FUNCTION resolve_platform_workspace_invitation(text),lock_platform_invitation_sender(text),accept_platform_workspace_invitation(text,uuid) TO drykraft_app;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='drykraft_platform') THEN
  GRANT EXECUTE ON FUNCTION platform_customer_management(uuid),set_platform_customer_state(uuid,uuid,boolean,integer,text),provision_platform_workspace(uuid,uuid,uuid,text,jsonb,jsonb) TO drykraft_platform;
 END IF;
END $$;
INSERT INTO schema_migrations(version) VALUES(22) ON CONFLICT DO NOTHING;
COMMIT;
