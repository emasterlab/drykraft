BEGIN;
ALTER TABLE reseller_workspace_links ADD COLUMN IF NOT EXISTS customer_suspended boolean NOT NULL DEFAULT false;
ALTER TABLE reseller_workspace_links ADD COLUMN IF NOT EXISTS customer_control_version integer NOT NULL DEFAULT 1 CHECK(customer_control_version>0);
ALTER TABLE reseller_workspace_links ADD COLUMN IF NOT EXISTS updated_by_reseller uuid REFERENCES reseller_accounts(id);
CREATE TABLE IF NOT EXISTS reseller_owner_invitations (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES workspaces(id),reseller_id uuid NOT NULL REFERENCES reseller_organizations(id),
 email text NOT NULL CHECK(email=lower(trim(email))),token_hash text UNIQUE NOT NULL CHECK(token_hash~'^[a-f0-9]{64}$'),token_ciphertext text NOT NULL,
 issued_by uuid NOT NULL REFERENCES reseller_accounts(id),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 expires_at timestamptz NOT NULL,accepted_by uuid REFERENCES users(id),accepted_at timestamptz,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((accepted_by IS NULL)=(accepted_at IS NULL)),CHECK(accepted_at IS NULL OR revoked_at IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS reseller_owner_pending ON reseller_owner_invitations(tenant_id) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS reseller_customer_operations (
 request_id uuid PRIMARY KEY,reseller_id uuid NOT NULL REFERENCES reseller_organizations(id),actor_id uuid NOT NULL REFERENCES reseller_accounts(id),
 input_hash text NOT NULL CHECK(input_hash~'^[a-f0-9]{64}$'),tenant_id uuid NOT NULL UNIQUE REFERENCES workspaces(id),
 invitation_id uuid NOT NULL REFERENCES reseller_owner_invitations(id),created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['reseller_owner_invitations','reseller_customer_operations'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;ALTER TABLE %I FORCE ROW LEVEL SECURITY',t,t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,drykraft_app,drykraft_worker,drykraft_platform,drykraft_mail,drykraft_reseller,drykraft_reseller_api',t);
  -- No bulk erasure is needed. Explicit non-default owner ACLs also survive pg_dump/restore byte-for-byte.
  EXECUTE format('REVOKE TRUNCATE ON %I FROM %I',t,current_user);
 END LOOP;
END $$;
DROP TRIGGER IF EXISTS immutable_version ON reseller_customer_operations;
CREATE TRIGGER immutable_version BEFORE UPDATE OR DELETE ON reseller_customer_operations FOR EACH ROW EXECUTE FUNCTION reseller_immutable_version();

CREATE OR REPLACE FUNCTION reseller_customer_transfer_guard() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 BEGIN
  IF OLD.reseller_id IS DISTINCT FROM NEW.reseller_id THEN
   NEW.customer_suspended=false;NEW.customer_control_version=OLD.customer_control_version+1;
   IF OLD.reseller_id IS NOT NULL OR NEW.updated_by IS NOT NULL THEN NEW.updated_by_reseller=NULL;END IF;
   UPDATE public.reseller_owner_invitations SET revoked_at=now(),version=version+1 WHERE tenant_id=OLD.tenant_id AND accepted_at IS NULL AND revoked_at IS NULL;
  ELSIF NEW.updated_by IS NOT NULL THEN NEW.updated_by_reseller=NULL;
  END IF;
  RETURN NEW;
 END
$$;
DROP TRIGGER IF EXISTS reseller_customer_transfer ON reseller_workspace_links;
CREATE TRIGGER reseller_customer_transfer BEFORE UPDATE ON reseller_workspace_links FOR EACH ROW EXECUTE FUNCTION reseller_customer_transfer_guard();
CREATE OR REPLACE FUNCTION platform_workspace_suspended(workspace_id uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT coalesce((SELECT suspended FROM public.platform_workspace_controls WHERE tenant_id=workspace_id),false) OR EXISTS(
  SELECT 1 FROM public.reseller_workspace_links l JOIN public.reseller_organizations r ON r.id=l.reseller_id WHERE l.tenant_id=workspace_id AND
   (l.customer_suspended OR (r.customer_access_policy='suspend_access' AND (r.status<>'active' OR r.contract_starts_at>now() OR r.contract_ends_at<=now()))))
$$;

-- Internal gateways take the existing workspace row before the commercial lock, then current account/membership locks.
CREATE OR REPLACE FUNCTION reseller_customer_actor(session_hash text,workspace uuid,roles text[],writing boolean,active_required boolean DEFAULT true) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE parent uuid;actor uuid;
 BEGIN
  SELECT selected_reseller_id INTO parent FROM public.reseller_sessions WHERE token_hash=session_hash;
  IF parent IS NULL THEN PERFORM public.reseller_staff_session_account(session_hash);RAISE EXCEPTION 'Choose your organization first' USING ERRCODE='RS403';END IF;
  IF writing THEN
   IF workspace IS NOT NULL THEN PERFORM id FROM public.workspaces WHERE id=workspace FOR KEY SHARE;END IF;
   PERFORM public.reseller_lock(parent);
  END IF;
  actor=public.reseller_staff_authorize(session_hash,parent,roles,true,active_required);
  IF workspace IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.reseller_workspace_links WHERE tenant_id=workspace AND reseller_id=parent) THEN
   RAISE EXCEPTION 'This customer does not belong to your organization' USING ERRCODE='RS404';END IF;
  RETURN actor;
 END
$$;
CREATE OR REPLACE FUNCTION reseller_customer_metadata(workspace uuid) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('id',w.id,'name',w.name,'slug',w.slug,'settings',jsonb_build_object('currency',w.settings->'currency','currencies',w.settings->'currencies','timezone',w.settings->'timezone'),
  'reseller_id',l.reseller_id,'version',l.version,'customer_control_version',l.customer_control_version,'customer_suspended',l.customer_suspended,
  'platform_suspended',coalesce(p.suspended,false),'suspended',public.platform_workspace_suspended(w.id),
  'retail_plan_id',l.retail_plan_id,'retail_plan_version',l.retail_plan_version,'retail_plan_name',v.name,'retail_currency',v.currency,
  'monthly_price_minor',v.monthly_price_minor,'annual_price_minor',v.annual_price_minor,'setup_price_minor',v.setup_price_minor,
  'billing',jsonb_build_object('status',b.status,'trial_started_at',b.trial_started_at,'trial_ends_at',b.trial_ends_at,'next_billing_date',b.next_billing_date),
  'owner_joined',EXISTS(SELECT 1 FROM public.memberships WHERE tenant_id=w.id AND role='owner'),
  'invitation',(SELECT jsonb_build_object('id',i.id,'email',i.email,'version',i.version,'expires_at',i.expires_at,'accepted',i.accepted_at IS NOT NULL,'revoked',i.revoked_at IS NOT NULL,'issued_by',i.issued_by)
   FROM public.reseller_owner_invitations i WHERE i.tenant_id=w.id AND i.reseller_id=l.reseller_id ORDER BY i.created_at DESC,i.id DESC LIMIT 1),
  'usage',public.platform_resource_gauges(w.id),'created_at',w.created_at)
 FROM public.workspaces w JOIN public.reseller_workspace_links l ON l.tenant_id=w.id LEFT JOIN public.platform_workspace_controls p ON p.tenant_id=w.id
 LEFT JOIN public.reseller_retail_plan_versions v ON v.plan_id=l.retail_plan_id AND v.version=l.retail_plan_version LEFT JOIN public.workspace_billing b ON b.tenant_id=w.id WHERE w.id=workspace
$$;
CREATE OR REPLACE FUNCTION reseller_staff_customer_detail(session_hash text,workspace uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 BEGIN
  PERFORM public.reseller_customer_actor(session_hash,workspace,ARRAY['owner','admin','support','billing'],false);
  RETURN public.reseller_customer_metadata(workspace);
 END
$$;
CREATE OR REPLACE FUNCTION reseller_staff_customer_receipt(session_hash text,request uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE actor uuid;op public.reseller_customer_operations;parent uuid;
 BEGIN
  actor=public.reseller_customer_actor(session_hash,NULL,ARRAY['owner','admin'],false,false);
  SELECT selected_reseller_id INTO parent FROM public.reseller_sessions WHERE token_hash=session_hash;
  SELECT * INTO op FROM public.reseller_customer_operations WHERE request_id=request AND actor_id=actor AND reseller_id=parent;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.reseller_workspace_links WHERE tenant_id=op.tenant_id AND reseller_id=parent) THEN
   RAISE EXCEPTION 'This request has no saved customer for your account and organization' USING ERRCODE='RS404';END IF;
  RETURN public.reseller_customer_metadata(op.tenant_id)||jsonb_build_object('request_id',request,'replayed',true);
 END
$$;
CREATE OR REPLACE FUNCTION reseller_staff_provision_customer(session_hash text,input jsonb,request uuid,fingerprint text,invitation uuid,invitation_hash text,ciphertext text,blueprint jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE actor uuid;parent uuid;workspace uuid;op public.reseller_customer_operations;grant_record public.reseller_grant_versions;retail public.reseller_retail_plan_versions;definition jsonb;result jsonb;effective jsonb;
 BEGIN
  actor=public.reseller_customer_actor(session_hash,NULL,ARRAY['owner','admin'],true);
  SELECT selected_reseller_id INTO parent FROM public.reseller_sessions WHERE token_hash=session_hash;
  IF request IS NULL OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'A valid request ID is required' USING ERRCODE='RS400';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('reseller-customer-request:'||request::text,0));
  SELECT * INTO op FROM public.reseller_customer_operations WHERE request_id=request;
  IF FOUND THEN
   IF op.actor_id<>actor OR op.reseller_id<>parent OR op.input_hash<>fingerprint THEN RAISE EXCEPTION 'This request belongs to different customer details' USING ERRCODE='RS409';END IF;
   RETURN public.reseller_staff_customer_receipt(session_hash,request);
  END IF;
  IF jsonb_typeof(input) IS DISTINCT FROM 'object' OR length(trim(coalesce(input->>'reason',''))) NOT BETWEEN 10 AND 1000 OR length(trim(coalesce(input->>'name',''))) NOT BETWEEN 2 AND 100 OR
   coalesce(input->>'slug','')!~'^[a-z][a-z0-9-]{2,39}$' OR input->>'slug'=ANY(ARRAY['www','app','api','admin','auth','support','mail','assets','status','demo']) OR
   coalesce(input->>'owner_email','')!~'^[^@ ]+@[^@ ]+\.[^@ ]+$' OR input->>'owner_email'<>lower(trim(input->>'owner_email')) OR
   invitation IS NULL OR coalesce(invitation_hash,'')!~'^[a-f0-9]{64}$' OR length(coalesce(ciphertext,''))<20 OR jsonb_typeof(input->'settings') IS DISTINCT FROM 'object' OR
   jsonb_typeof(blueprint->'definitions') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'Invalid customer configuration' USING ERRCODE='RS400';END IF;
  IF jsonb_array_length(blueprint->'definitions') NOT BETWEEN 1 AND 100 OR coalesce(input#>>'{settings,currency}','')!~'^[A-Z]{3}$' OR
   jsonb_typeof(input#>'{settings,currencies}') IS DISTINCT FROM 'array' OR
   NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=input#>>'{settings,timezone}') THEN
   RAISE EXCEPTION 'Invalid customer currency or timezone' USING ERRCODE='RS400';END IF;
  IF jsonb_array_length(input#>'{settings,currencies}') NOT BETWEEN 1 AND 180 OR
   NOT (input#>'{settings,currencies}') @> jsonb_build_array(input#>>'{settings,currency}') OR
   EXISTS(SELECT 1 FROM jsonb_array_elements_text(input#>'{settings,currencies}') c WHERE c!~'^[A-Z]{3}$') OR
   (SELECT count(*)<>count(DISTINCT c) FROM jsonb_array_elements_text(input#>'{settings,currencies}') c) THEN
   RAISE EXCEPTION 'Enabled currencies must be unique and include the default currency' USING ERRCODE='RS400';END IF;
  SELECT g.* INTO grant_record FROM public.reseller_grant_versions g JOIN public.reseller_organizations r ON r.id=g.reseller_id AND r.grant_version=g.version WHERE r.id=parent;
  SELECT * INTO retail FROM public.reseller_retail_plan_versions WHERE reseller_id=parent AND plan_id=(input->>'retail_plan_id')::uuid AND version=(input->>'retail_plan_version')::integer;
  IF NOT FOUND THEN RAISE EXCEPTION 'Choose a retail version from your organization' USING ERRCODE='RS404';END IF;
  PERFORM public.reseller_require_reduction(retail.limits,retail.features,grant_record.limits,grant_record.features);
  IF coalesce((retail.limits->>'users')::bigint,1)<1 OR coalesce((grant_record.limits->>'users')::bigint,1)<1 THEN
   RAISE EXCEPTION 'The customer plan needs at least one user seat for its owner' USING ERRCODE='DK001';END IF;
  IF retail.trial_days>grant_record.trial_days_max THEN RAISE EXCEPTION 'The selected trial exceeds the current wholesale allowance' USING ERRCODE='DK003';END IF;
  IF grant_record.max_workspaces IS NOT NULL AND (SELECT count(*) FROM public.reseller_workspace_links WHERE reseller_id=parent)>=grant_record.max_workspaces THEN
   RAISE EXCEPTION 'Your organization has reached its customer workspace limit' USING ERRCODE='DK001';END IF;
  workspace=gen_random_uuid();
  INSERT INTO public.workspaces(id,name,slug,settings) VALUES(workspace,input->>'name',input->>'slug',input->'settings');
  UPDATE public.reseller_workspace_links SET reseller_id=parent,retail_plan_id=retail.plan_id,retail_plan_version=retail.version,version=1,updated_by_reseller=actor WHERE tenant_id=workspace;
  UPDATE public.workspace_billing SET trial_ends_at=trial_started_at+make_interval(days=>retail.trial_days) WHERE tenant_id=workspace;
  PERFORM set_config('app.tenant_id',workspace::text,true);
  effective=public.workspace_entitlements(workspace);
  IF coalesce((effective->'limits'->>'users')::bigint,1)<1 THEN RAISE EXCEPTION 'The effective customer plan needs an owner seat' USING ERRCODE='DK001';END IF;
  FOR definition IN SELECT value FROM jsonb_array_elements(blueprint->'definitions') LOOP
   INSERT INTO public.object_definitions(tenant_id,key,name,singular_name,fields,built_in) VALUES(workspace,definition->>'key',definition->>'name',definition->>'singular_name',definition->'fields',true);
  END LOOP;
  -- Standard data is configuration only. Disabled Sales/zero-pipeline packages never receive a hidden resource above their allowance.
  IF (effective->'features'->>'sales')::boolean AND coalesce((effective->'limits'->>'pipelines')::bigint,1)>0 THEN
   INSERT INTO public.pipelines(tenant_id,id,name,stages) VALUES(workspace,gen_random_uuid(),'Sales pipeline',blueprint->'stages');
  END IF;
  INSERT INTO public.dashboards(tenant_id,id,name,widgets) VALUES(workspace,gen_random_uuid(),'Business overview',blueprint->'widgets');
  INSERT INTO public.reseller_owner_invitations(id,tenant_id,reseller_id,email,token_hash,token_ciphertext,issued_by,expires_at)
   VALUES(invitation,workspace,parent,input->>'owner_email',invitation_hash,ciphertext,actor,now()+interval '7 days');
  INSERT INTO public.reseller_customer_operations(request_id,reseller_id,actor_id,input_hash,tenant_id,invitation_id) VALUES(request,parent,actor,fingerprint,workspace,invitation);
  result=public.reseller_customer_metadata(workspace)||jsonb_build_object('request_id',request,'replayed',false);
  INSERT INTO public.reseller_audit(id,reseller_id,actor_id,action,resource_type,resource_id,reason,data,request_id)
   VALUES(gen_random_uuid(),parent,actor,'reseller.customer.provisioned','workspace',workspace,trim(input->>'reason'),jsonb_build_object('retail_plan_id',retail.plan_id,'retail_plan_version',retail.version,'invitation_id',invitation),request);
  PERFORM public.reseller_publish_customer_event(workspace,parent,NULL,'reseller.customer.created',request,jsonb_build_object('retail_plan_id',retail.plan_id,'retail_plan_version',retail.version));
  RETURN result;
 END
$$;
CREATE OR REPLACE FUNCTION reseller_staff_update_customer(session_hash text,workspace uuid,expected_version integer,requested_name text,change_reason text,request uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE actor uuid;parent uuid;
 BEGIN
  actor=public.reseller_customer_actor(session_hash,workspace,ARRAY['owner','admin'],true);
  IF length(trim(coalesce(requested_name,''))) NOT BETWEEN 2 AND 100 OR length(trim(coalesce(change_reason,''))) NOT BETWEEN 10 AND 1000 THEN RAISE EXCEPTION 'A name and reason are required' USING ERRCODE='RS400';END IF;
  SELECT reseller_id INTO parent FROM public.reseller_workspace_links WHERE tenant_id=workspace;
  IF (SELECT customer_control_version FROM public.reseller_workspace_links WHERE tenant_id=workspace) IS DISTINCT FROM expected_version THEN RAISE EXCEPTION 'Customer controls changed. Refresh first' USING ERRCODE='RS409';END IF;
  UPDATE public.workspaces SET name=trim(requested_name) WHERE id=workspace;
  UPDATE public.reseller_workspace_links SET customer_control_version=customer_control_version+1,updated_by=NULL,updated_by_reseller=actor,updated_at=now() WHERE tenant_id=workspace;
  INSERT INTO public.reseller_audit(id,reseller_id,actor_id,action,resource_type,resource_id,reason,data,request_id) VALUES(gen_random_uuid(),parent,actor,'reseller.customer.updated','workspace',workspace,trim(change_reason),jsonb_build_object('name',trim(requested_name)),request);
  PERFORM public.reseller_publish_customer_event(workspace,parent,NULL,'reseller.customer.updated',request,jsonb_build_object('name',trim(requested_name)));
  RETURN public.reseller_customer_metadata(workspace);
 END
$$;
CREATE OR REPLACE FUNCTION reseller_staff_customer_state(session_hash text,workspace uuid,expected_version integer,suspended boolean,change_reason text,request uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE actor uuid;parent uuid;
 BEGIN
  actor=public.reseller_customer_actor(session_hash,workspace,ARRAY['owner','admin'],true);
  IF suspended IS NULL OR length(trim(coalesce(change_reason,''))) NOT BETWEEN 10 AND 1000 THEN RAISE EXCEPTION 'A state and reason are required' USING ERRCODE='RS400';END IF;
  SELECT reseller_id INTO parent FROM public.reseller_workspace_links WHERE tenant_id=workspace;
  IF (SELECT customer_control_version FROM public.reseller_workspace_links WHERE tenant_id=workspace) IS DISTINCT FROM expected_version THEN RAISE EXCEPTION 'Customer controls changed. Refresh first' USING ERRCODE='RS409';END IF;
  UPDATE public.reseller_workspace_links SET customer_suspended=suspended,customer_control_version=customer_control_version+1,updated_by=NULL,updated_by_reseller=actor,updated_at=now() WHERE tenant_id=workspace;
  IF suspended THEN DELETE FROM public.sessions WHERE tenant_id=workspace;END IF;
  INSERT INTO public.reseller_audit(id,reseller_id,actor_id,action,resource_type,resource_id,reason,data,request_id) VALUES(gen_random_uuid(),parent,actor,'reseller.customer.state_changed','workspace',workspace,trim(change_reason),jsonb_build_object('customer_suspended',suspended),request);
  PERFORM public.reseller_publish_customer_event(workspace,parent,NULL,'reseller.customer.state_changed',request,jsonb_build_object('customer_suspended',suspended));
  RETURN public.reseller_customer_metadata(workspace);
 END
$$;
CREATE OR REPLACE FUNCTION reseller_staff_assign_customer_plan(session_hash text,workspace uuid,expected_version integer,plan uuid,plan_version integer,change_reason text,request uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE actor uuid;parent uuid;retail public.reseller_retail_plan_versions;upstream public.reseller_grant_versions;
 BEGIN
  actor=public.reseller_customer_actor(session_hash,workspace,ARRAY['owner','admin','billing'],true);
  IF length(trim(coalesce(change_reason,''))) NOT BETWEEN 10 AND 1000 THEN RAISE EXCEPTION 'A reason is required' USING ERRCODE='RS400';END IF;
  SELECT reseller_id INTO parent FROM public.reseller_workspace_links WHERE tenant_id=workspace;
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace-entitlements:'||workspace::text,0));
  IF (SELECT version FROM public.reseller_workspace_links WHERE tenant_id=workspace) IS DISTINCT FROM expected_version THEN RAISE EXCEPTION 'Customer assignment changed. Refresh first' USING ERRCODE='RS409';END IF;
  SELECT g.* INTO upstream FROM public.reseller_grant_versions g JOIN public.reseller_organizations r ON r.id=g.reseller_id AND r.grant_version=g.version WHERE r.id=parent;
  SELECT * INTO retail FROM public.reseller_retail_plan_versions WHERE reseller_id=parent AND plan_id=plan AND version=plan_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'Choose a retail version from your organization' USING ERRCODE='RS404';END IF;
  PERFORM public.reseller_require_reduction(retail.limits,retail.features,upstream.limits,upstream.features);
  IF retail.trial_days>upstream.trial_days_max THEN RAISE EXCEPTION 'The selected trial exceeds the current wholesale allowance' USING ERRCODE='DK003';END IF;
  UPDATE public.reseller_workspace_links SET retail_plan_id=plan,retail_plan_version=plan_version,version=version+1,updated_by=NULL,updated_by_reseller=actor,updated_at=now() WHERE tenant_id=workspace;
  INSERT INTO public.reseller_audit(id,reseller_id,actor_id,action,resource_type,resource_id,reason,data,request_id) VALUES(gen_random_uuid(),parent,actor,'reseller.customer.plan_changed','workspace',workspace,trim(change_reason),jsonb_build_object('retail_plan_id',plan,'retail_plan_version',plan_version,'version',expected_version+1),request);
  PERFORM public.reseller_publish_customer_event(workspace,parent,NULL,'reseller.customer.plan_changed',request,jsonb_build_object('retail_plan_id',plan,'retail_plan_version',plan_version,'version',expected_version+1));
  RETURN public.reseller_customer_metadata(workspace);
 END
$$;

CREATE OR REPLACE FUNCTION reseller_staff_owner_invitation(session_hash text,workspace uuid,expected_version integer,operation text,new_hash text,new_ciphertext text,change_reason text,request uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE actor uuid;invite public.reseller_owner_invitations;parent uuid;result jsonb;
 BEGIN
  actor=public.reseller_customer_actor(session_hash,workspace,ARRAY['owner','admin'],true);
  IF length(trim(coalesce(change_reason,''))) NOT BETWEEN 10 AND 1000 OR operation IS NULL OR NOT operation=ANY(ARRAY['link','renew','revoke']) THEN RAISE EXCEPTION 'An action and reason are required' USING ERRCODE='RS400';END IF;
  SELECT reseller_id INTO parent FROM public.reseller_workspace_links WHERE tenant_id=workspace;
  SELECT * INTO invite FROM public.reseller_owner_invitations WHERE tenant_id=workspace AND reseller_id=parent ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No owner invitation exists for this customer' USING ERRCODE='RS404';END IF;
  IF invite.version IS DISTINCT FROM expected_version THEN RAISE EXCEPTION 'The invitation changed. Refresh first' USING ERRCODE='RS409';END IF;
  IF invite.accepted_at IS NOT NULL OR EXISTS(SELECT 1 FROM public.memberships WHERE tenant_id=workspace AND role='owner') THEN RAISE EXCEPTION 'The owner has already joined. This invitation cannot be changed or reused' USING ERRCODE='RS409';END IF;
  IF operation='link' THEN
   IF invite.issued_by<>actor OR invite.revoked_at IS NOT NULL OR invite.expires_at<=clock_timestamp() OR public.platform_workspace_suspended(workspace) THEN RAISE EXCEPTION 'Only the current issuer can view an available invitation link' USING ERRCODE='RS403';END IF;
  ELSIF operation='renew' THEN
   IF coalesce(new_hash,'')!~'^[a-f0-9]{64}$' OR length(coalesce(new_ciphertext,''))<20 OR public.platform_workspace_suspended(workspace) THEN RAISE EXCEPTION 'An available customer and new private link are required' USING ERRCODE='RS400';END IF;
   UPDATE public.reseller_owner_invitations SET token_hash=new_hash,token_ciphertext=new_ciphertext,issued_by=actor,version=version+1,expires_at=now()+interval '7 days',revoked_at=NULL WHERE id=invite.id RETURNING * INTO invite;
  ELSE
   IF invite.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'This invitation is already revoked' USING ERRCODE='RS409';END IF;
   UPDATE public.reseller_owner_invitations SET revoked_at=now(),version=version+1 WHERE id=invite.id RETURNING * INTO invite;
  END IF;
  result=jsonb_build_object('id',invite.id,'email',invite.email,'version',invite.version,'expires_at',invite.expires_at,'revoked',invite.revoked_at IS NOT NULL);
  INSERT INTO public.reseller_audit(id,reseller_id,actor_id,action,resource_type,resource_id,reason,data,request_id) VALUES(gen_random_uuid(),parent,actor,'reseller.owner_invitation.'||operation,'workspace',workspace,trim(change_reason),result,request);
  IF operation='link' THEN result=result||jsonb_build_object('ciphertext',invite.token_ciphertext);END IF;
  RETURN result;
 END
$$;
CREATE OR REPLACE FUNCTION resolve_reseller_workspace_invitation(requested_hash text) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('id',i.id,'tenant_id',i.tenant_id,'email',i.email,'role','owner','expires_at',i.expires_at,'accepted',i.accepted_at IS NOT NULL,'revoked',i.revoked_at IS NOT NULL,
  'sender_valid',NOT a.disabled AND a.mfa_enabled_at IS NOT NULL AND NOT m.disabled AND m.role IN ('owner','admin') AND r.status='active' AND r.contract_starts_at<=now() AND r.contract_ends_at>now() AND NOT public.platform_workspace_suspended(w.id),
  'workspace_name',w.name,'workspace_slug',w.slug,'reseller_name',r.name)
 FROM public.reseller_owner_invitations i JOIN public.workspaces w ON w.id=i.tenant_id JOIN public.reseller_workspace_links l ON l.tenant_id=w.id AND l.reseller_id=i.reseller_id
 JOIN public.reseller_organizations r ON r.id=i.reseller_id JOIN public.reseller_accounts a ON a.id=i.issued_by JOIN public.reseller_memberships m ON m.reseller_id=r.id AND m.account_id=a.id WHERE i.token_hash=requested_hash
$$;
CREATE OR REPLACE FUNCTION lock_reseller_invitation_sender(requested_hash text) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE invite public.reseller_owner_invitations;
 BEGIN
  SELECT * INTO invite FROM public.reseller_owner_invitations WHERE token_hash=requested_hash;
  IF NOT FOUND THEN RETURN false;END IF;
  -- The public acceptance handler subsequently takes FOR UPDATE; acquire that same lock before the parent to avoid an upgrade cycle.
  PERFORM id FROM public.workspaces WHERE id=invite.tenant_id FOR UPDATE;
  PERFORM public.reseller_lock(invite.reseller_id);
  PERFORM id FROM public.reseller_organizations WHERE id=invite.reseller_id AND status='active' AND contract_starts_at<=clock_timestamp() AND contract_ends_at>clock_timestamp() FOR SHARE;
  IF NOT FOUND THEN RETURN false;END IF;
  PERFORM id FROM public.reseller_accounts WHERE id=invite.issued_by AND NOT disabled AND mfa_enabled_at IS NOT NULL FOR SHARE;
  IF NOT FOUND THEN RETURN false;END IF;
  PERFORM id FROM public.reseller_memberships WHERE reseller_id=invite.reseller_id AND account_id=invite.issued_by AND NOT disabled AND role IN ('owner','admin') FOR SHARE;
  RETURN FOUND AND EXISTS(SELECT 1 FROM public.reseller_workspace_links WHERE tenant_id=invite.tenant_id AND reseller_id=invite.reseller_id);
 END
$$;
CREATE OR REPLACE FUNCTION accept_reseller_workspace_invitation(requested_hash text,customer_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE invite public.reseller_owner_invitations;customer public.users;
 BEGIN
  IF NOT public.lock_reseller_invitation_sender(requested_hash) THEN RAISE EXCEPTION 'Invitation authority changed' USING ERRCODE='42501';END IF;
  SELECT * INTO invite FROM public.reseller_owner_invitations WHERE token_hash=requested_hash FOR UPDATE;
  IF NOT FOUND OR invite.expires_at<=clock_timestamp() OR invite.revoked_at IS NOT NULL OR public.platform_workspace_suspended(invite.tenant_id) THEN RAISE EXCEPTION 'Invitation is unavailable' USING ERRCODE='22023';END IF;
  SELECT * INTO customer FROM public.users WHERE id=customer_id FOR UPDATE;
  IF NOT FOUND OR customer.email<>invite.email OR public.platform_user_disabled(customer_id) THEN RAISE EXCEPTION 'This account cannot accept the invitation' USING ERRCODE='42501';END IF;
  IF invite.accepted_at IS NOT NULL THEN
   IF invite.accepted_by<>customer_id OR NOT EXISTS(SELECT 1 FROM public.memberships WHERE tenant_id=invite.tenant_id AND user_id=customer_id AND role='owner') THEN RAISE EXCEPTION 'Invitation was already used' USING ERRCODE='22023';END IF;
   RETURN jsonb_build_object('id',invite.tenant_id,'already_accepted',true);
  END IF;
  IF EXISTS(SELECT 1 FROM public.memberships WHERE tenant_id=invite.tenant_id AND role='owner') THEN RAISE EXCEPTION 'Workspace ownership changed' USING ERRCODE='40001';END IF;
  PERFORM set_config('app.tenant_id',invite.tenant_id::text,true);
  INSERT INTO public.memberships(tenant_id,user_id,role) VALUES(invite.tenant_id,customer_id,'owner');
  UPDATE public.reseller_owner_invitations SET accepted_by=customer_id,accepted_at=now() WHERE id=invite.id;
  INSERT INTO public.reseller_audit(id,reseller_id,actor_id,action,resource_type,resource_id,data) VALUES(gen_random_uuid(),invite.reseller_id,invite.issued_by,'reseller.customer.owner_joined','workspace',invite.tenant_id,jsonb_build_object('invitation_id',invite.id));
  PERFORM public.reseller_publish_customer_event(invite.tenant_id,invite.reseller_id,customer_id,'workspace.member.joined',gen_random_uuid(),jsonb_build_object('role','owner','invitation_id',invite.id));
  RETURN jsonb_build_object('id',invite.tenant_id,'already_accepted',false);
 END
$$;

REVOKE ALL ON FUNCTION reseller_customer_transfer_guard(),reseller_customer_actor(text,uuid,text[],boolean,boolean),reseller_customer_metadata(uuid),reseller_staff_customer_detail(text,uuid),reseller_staff_customer_receipt(text,uuid),reseller_staff_provision_customer(text,jsonb,uuid,text,uuid,text,text,jsonb),reseller_staff_update_customer(text,uuid,integer,text,text,uuid),reseller_staff_customer_state(text,uuid,integer,boolean,text,uuid),reseller_staff_assign_customer_plan(text,uuid,integer,uuid,integer,text,uuid),reseller_staff_owner_invitation(text,uuid,integer,text,text,text,text,uuid),resolve_reseller_workspace_invitation(text),lock_reseller_invitation_sender(text),accept_reseller_workspace_invitation(text,uuid) FROM PUBLIC,drykraft_app,drykraft_worker,drykraft_platform,drykraft_reseller,drykraft_reseller_api,drykraft_mail;
GRANT EXECUTE ON FUNCTION reseller_staff_customer_detail(text,uuid),reseller_staff_customer_receipt(text,uuid),reseller_staff_provision_customer(text,jsonb,uuid,text,uuid,text,text,jsonb),reseller_staff_update_customer(text,uuid,integer,text,text,uuid),reseller_staff_customer_state(text,uuid,integer,boolean,text,uuid),reseller_staff_assign_customer_plan(text,uuid,integer,uuid,integer,text,uuid),reseller_staff_owner_invitation(text,uuid,integer,text,text,text,text,uuid) TO drykraft_reseller;
GRANT EXECUTE ON FUNCTION resolve_reseller_workspace_invitation(text),lock_reseller_invitation_sender(text),accept_reseller_workspace_invitation(text,uuid) TO drykraft_app;
INSERT INTO schema_migrations(version) VALUES(32) ON CONFLICT DO NOTHING;
COMMIT;
