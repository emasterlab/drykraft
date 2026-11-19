BEGIN;
ALTER TABLE platform_workspace_invitations ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1 CHECK(version>0);
ALTER TABLE platform_workspace_invitations ADD COLUMN IF NOT EXISTS token_ciphertext text;
CREATE TABLE IF NOT EXISTS platform_invitation_operations (
 id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES platform_accounts(id),invitation_id uuid NOT NULL REFERENCES platform_workspace_invitations(id),
 action text NOT NULL CHECK(action IN ('renew','revoke','email')),request_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_mail_transport (
 id boolean PRIMARY KEY DEFAULT true CHECK(id),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 metadata jsonb NOT NULL DEFAULT '{}',ciphertext text,enabled boolean NOT NULL DEFAULT false,verified_at timestamptz,
 updated_by uuid REFERENCES platform_accounts(id),updated_at timestamptz NOT NULL DEFAULT now(),CHECK(NOT enabled OR (ciphertext IS NOT NULL AND verified_at IS NOT NULL))
);
INSERT INTO platform_mail_transport(id) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS platform_mail_templates (
 key text PRIMARY KEY CHECK(key='owner_invitation'),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 subject text NOT NULL,body text NOT NULL,updated_by uuid REFERENCES platform_accounts(id),updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_mail_templates(key,subject,body) VALUES('owner_invitation','You are invited to {{workspace_name}} on {{product_name}}',
 E'You have been invited to become the owner of {{workspace_name}} on {{product_name}}.\n\nAccept your invitation:\n{{invite_url}}\n\nThis private link expires on {{expires_at}}. Sign in with your existing account, or create your account during acceptance. Keep the link private.\n\nIf you were not expecting this invitation, you can ignore this email. For assistance, contact {{support_email}}.') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS platform_mail_template_versions (
 key text NOT NULL REFERENCES platform_mail_templates(key),version integer NOT NULL,subject text NOT NULL,body text NOT NULL,
 created_by uuid REFERENCES platform_accounts(id),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(key,version)
);
INSERT INTO platform_mail_template_versions(key,version,subject,body) SELECT key,version,subject,body FROM platform_mail_templates ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS platform_mail_jobs (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES workspaces(id),invitation_id uuid NOT NULL REFERENCES platform_workspace_invitations(id),
 invitation_version integer NOT NULL,actor_id uuid NOT NULL REFERENCES platform_accounts(id),template_key text NOT NULL DEFAULT 'owner_invitation',template_version integer NOT NULL,
 transport_version integer NOT NULL,recipient text NOT NULL,payload_ciphertext text NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sending','accepted','failed','unknown','cancelled')),
 lease_id uuid,lease_expires_at timestamptz,accepted_at timestamptz,finished_at timestamptz,error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(template_key,template_version) REFERENCES platform_mail_template_versions(key,version)
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_mail_invitation_active ON platform_mail_jobs(invitation_id,invitation_version) WHERE state IN ('queued','sending');
CREATE INDEX IF NOT EXISTS platform_mail_queue ON platform_mail_jobs(created_at,id) WHERE state='queued';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='drykraft_mail') THEN CREATE ROLE drykraft_mail NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;END IF;
END $$;
GRANT USAGE ON SCHEMA public TO drykraft_mail;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['platform_invitation_operations','platform_mail_transport','platform_mail_templates','platform_mail_template_versions','platform_mail_jobs'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY; ALTER TABLE %I FORCE ROW LEVEL SECURITY',t,t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,drykraft_app,drykraft_worker,drykraft_mail',t);
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename=t AND policyname='platform_only') THEN
   EXECUTE format('CREATE POLICY platform_only ON %I TO drykraft_platform USING(true) WITH CHECK(true)',t);
  END IF;
  EXECUTE format('GRANT SELECT ON %I TO drykraft_platform',t);
 END LOOP;
END $$;
GRANT INSERT ON platform_invitation_operations,platform_mail_jobs,platform_mail_template_versions TO drykraft_platform;
GRANT UPDATE ON platform_mail_transport,platform_mail_templates TO drykraft_platform;

CREATE OR REPLACE FUNCTION lock_platform_owner_invitation(actor uuid,workspace_id uuid,invitation_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.platform_accounts WHERE id=actor AND role IN ('owner','admin') AND NOT disabled AND mfa_enabled_at IS NOT NULL) THEN RAISE EXCEPTION 'Invitation management is not permitted' USING ERRCODE='42501';END IF;
  PERFORM id FROM public.workspaces WHERE id=workspace_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false;END IF;
  PERFORM id FROM public.platform_workspace_invitations WHERE id=invitation_id AND tenant_id=workspace_id FOR UPDATE;
  RETURN FOUND;
 END
$$;
CREATE OR REPLACE FUNCTION manage_platform_workspace_invitation(actor uuid,workspace_id uuid,invitation_id uuid,expected_version integer,operation text,new_hash text,new_ciphertext text,change_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE invite public.platform_workspace_invitations;
 BEGIN
  IF operation IS NULL OR operation NOT IN ('renew','revoke') OR change_reason IS NULL OR length(trim(change_reason)) NOT BETWEEN 10 AND 1000 OR NOT EXISTS(SELECT 1 FROM public.platform_accounts WHERE id=actor AND role IN ('owner','admin') AND NOT disabled AND mfa_enabled_at IS NOT NULL) THEN
   RAISE EXCEPTION 'Invitation management is not permitted' USING ERRCODE='42501';
  END IF;
  PERFORM id FROM public.workspaces WHERE id=workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Workspace does not exist' USING ERRCODE='23503';END IF;
  SELECT * INTO invite FROM public.platform_workspace_invitations WHERE id=invitation_id AND tenant_id=workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invitation does not exist' USING ERRCODE='23503';END IF;
  IF invite.version<>expected_version THEN RAISE EXCEPTION 'Invitation changed' USING ERRCODE='40001';END IF;
  IF invite.accepted_at IS NOT NULL THEN RAISE EXCEPTION 'Accepted invitations cannot be changed' USING ERRCODE='22023';END IF;
  IF operation='renew' THEN
   IF public.platform_workspace_suspended(workspace_id) OR EXISTS(SELECT 1 FROM public.memberships WHERE tenant_id=workspace_id AND role='owner') THEN
    RAISE EXCEPTION 'Workspace ownership or access changed' USING ERRCODE='22023';
   END IF;
   IF new_hash IS NULL OR new_hash !~ '^[a-f0-9]{64}$' OR new_ciphertext IS NULL OR length(new_ciphertext)<20 THEN RAISE EXCEPTION 'Invalid invitation token' USING ERRCODE='22023';END IF;
   UPDATE public.platform_workspace_invitations SET token_hash=new_hash,token_ciphertext=new_ciphertext,issued_by=actor,expires_at=now()+interval '7 days',revoked_at=NULL,version=version+1 WHERE id=invitation_id RETURNING * INTO invite;
  ELSE
   IF invite.revoked_at IS NULL THEN UPDATE public.platform_workspace_invitations SET revoked_at=now(),version=version+1,token_ciphertext=NULL WHERE id=invitation_id RETURNING * INTO invite;END IF;
  END IF;
  -- A message already submitted may arrive, but its invitation can no longer grant access.
  UPDATE public.platform_mail_jobs j SET state='cancelled',finished_at=now(),error_code='invitation_changed' WHERE j.invitation_id=invite.id AND j.state='queued';
  INSERT INTO public.platform_audit(id,actor_id,action,resource_type,resource_id,reason,data) VALUES(gen_random_uuid(),actor,'platform.workspace.invitation.'||operation,'workspace',workspace_id,trim(change_reason),jsonb_build_object('invitation_id',invite.id,'version',invite.version));
  RETURN jsonb_build_object('invitation_id',invite.id,'version',invite.version,'expires_at',invite.expires_at,'revoked_at',invite.revoked_at);
 END
$$;

CREATE OR REPLACE FUNCTION claim_platform_mail(requested_lease uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE job public.platform_mail_jobs; transport public.platform_mail_transport; valid boolean; expired public.platform_mail_jobs;
 BEGIN
  -- SMTP acceptance cannot be rolled back. A crashed sender is never silently retried.
  FOR expired IN UPDATE public.platform_mail_jobs SET state='unknown',finished_at=now(),error_code='sender_interrupted' WHERE state='sending' AND lease_expires_at<=now() RETURNING * LOOP
   INSERT INTO public.platform_audit(id,actor_id,action,resource_type,resource_id,data) VALUES(gen_random_uuid(),expired.actor_id,'platform.mail.unknown','workspace',expired.tenant_id,jsonb_build_object('mail_id',expired.id,'invitation_id',expired.invitation_id,'error_code','sender_interrupted'));
  END LOOP;
  SELECT * INTO transport FROM public.platform_mail_transport WHERE id=true;
  IF requested_lease IS NULL THEN RAISE EXCEPTION 'A mail lease is required' USING ERRCODE='22023';END IF;
  IF NOT transport.enabled OR transport.verified_at IS NULL THEN RETURN NULL;END IF;
  LOOP
   SELECT * INTO job FROM public.platform_mail_jobs WHERE state='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1;
   IF NOT FOUND THEN RETURN NULL;END IF;
   SELECT EXISTS(SELECT 1 FROM public.platform_workspace_invitations i JOIN public.platform_accounts a ON a.id=i.issued_by
    WHERE i.id=job.invitation_id AND i.tenant_id=job.tenant_id AND i.version=job.invitation_version AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now()
    AND a.id=job.actor_id AND NOT a.disabled AND a.role IN ('owner','admin') AND a.mfa_enabled_at IS NOT NULL
    AND NOT public.platform_workspace_suspended(i.tenant_id) AND NOT EXISTS(SELECT 1 FROM public.memberships WHERE tenant_id=i.tenant_id AND role='owner')) INTO valid;
   IF NOT valid OR transport.version<>job.transport_version THEN
    UPDATE public.platform_mail_jobs SET state='cancelled',finished_at=now(),error_code=CASE WHEN NOT valid THEN 'invitation_unavailable' ELSE 'transport_changed' END WHERE id=job.id;
   ELSE
    UPDATE public.platform_mail_jobs SET state='sending',lease_id=requested_lease,lease_expires_at=now()+interval '2 minutes' WHERE id=job.id;
    RETURN jsonb_build_object('id',job.id,'lease_id',requested_lease,'payload_ciphertext',job.payload_ciphertext,'transport_ciphertext',transport.ciphertext);
   END IF;
  END LOOP;
 END
$$;
CREATE OR REPLACE FUNCTION finish_platform_mail(job_id uuid,requested_lease uuid,outcome text,failure_code text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE job public.platform_mail_jobs;
 BEGIN
  IF outcome IS NULL OR outcome NOT IN ('accepted','failed','unknown') OR (failure_code IS NOT NULL AND failure_code !~ '^[a-z_]{1,50}$') THEN RAISE EXCEPTION 'Invalid mail outcome' USING ERRCODE='22023';END IF;
  UPDATE public.platform_mail_jobs SET state=outcome,accepted_at=CASE WHEN outcome='accepted' THEN now() ELSE NULL END,finished_at=now(),error_code=CASE WHEN outcome='accepted' THEN NULL ELSE failure_code END
   WHERE id=job_id AND lease_id=requested_lease AND state='sending' RETURNING * INTO job;
  IF NOT FOUND THEN RETURN false;END IF;
  INSERT INTO public.platform_audit(id,actor_id,action,resource_type,resource_id,data) VALUES(gen_random_uuid(),job.actor_id,'platform.mail.'||outcome,'workspace',job.tenant_id,jsonb_build_object('mail_id',job.id,'invitation_id',job.invitation_id,'error_code',job.error_code));
  RETURN true;
 END
$$;
REVOKE ALL ON FUNCTION manage_platform_workspace_invitation(uuid,uuid,uuid,integer,text,text,text,text) FROM PUBLIC,drykraft_app,drykraft_worker,drykraft_mail;
GRANT EXECUTE ON FUNCTION manage_platform_workspace_invitation(uuid,uuid,uuid,integer,text,text,text,text) TO drykraft_platform;
REVOKE ALL ON FUNCTION lock_platform_owner_invitation(uuid,uuid,uuid) FROM PUBLIC,drykraft_app,drykraft_worker,drykraft_mail;
GRANT EXECUTE ON FUNCTION lock_platform_owner_invitation(uuid,uuid,uuid) TO drykraft_platform;
REVOKE ALL ON FUNCTION claim_platform_mail(uuid),finish_platform_mail(uuid,uuid,text,text) FROM PUBLIC,drykraft_app,drykraft_worker,drykraft_platform;
GRANT EXECUTE ON FUNCTION claim_platform_mail(uuid),finish_platform_mail(uuid,uuid,text,text) TO drykraft_mail;
INSERT INTO schema_migrations(version) VALUES(26) ON CONFLICT DO NOTHING;
COMMIT;
