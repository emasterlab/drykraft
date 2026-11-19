BEGIN;
CREATE TABLE IF NOT EXISTS account_password_reset_mail_jobs (
 id uuid PRIMARY KEY,
 recipient text NOT NULL,
 transport_version integer NOT NULL CHECK(transport_version>0),
 payload_ciphertext text NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sending','accepted','failed','unknown','cancelled')),
 lease_id uuid,
 lease_expires_at timestamptz,
 accepted_at timestamptz,
 finished_at timestamptz,
 error_code text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_password_reset_mail_queue ON account_password_reset_mail_jobs(created_at,id) WHERE state='queued';
ALTER TABLE account_password_reset_mail_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_password_reset_mail_jobs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON account_password_reset_mail_jobs FROM PUBLIC,drykraft_app,drykraft_worker,drykraft_mail,drykraft_platform;
CREATE POLICY platform_only ON account_password_reset_mail_jobs TO drykraft_platform USING(true) WITH CHECK(true);
GRANT SELECT,INSERT ON account_password_reset_mail_jobs TO drykraft_platform;

CREATE OR REPLACE FUNCTION claim_platform_mail(requested_lease uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE job public.platform_mail_jobs; reset_job public.account_password_reset_mail_jobs; transport public.platform_mail_transport; valid boolean; expired public.platform_mail_jobs;
 BEGIN
  FOR expired IN UPDATE public.platform_mail_jobs SET state='unknown',finished_at=now(),error_code='sender_interrupted' WHERE state='sending' AND lease_expires_at<=now() RETURNING * LOOP
   INSERT INTO public.platform_audit(id,actor_id,action,resource_type,resource_id,data) VALUES(gen_random_uuid(),expired.actor_id,'platform.mail.unknown','workspace',expired.tenant_id,jsonb_build_object('mail_id',expired.id,'invitation_id',expired.invitation_id,'error_code','sender_interrupted'));
  END LOOP;
  UPDATE public.account_password_reset_mail_jobs SET state='unknown',finished_at=now(),error_code='sender_interrupted' WHERE state='sending' AND lease_expires_at<=now();
  SELECT * INTO transport FROM public.platform_mail_transport WHERE id=true;
  IF requested_lease IS NULL THEN RAISE EXCEPTION 'A mail lease is required' USING ERRCODE='22023';END IF;
  IF NOT transport.enabled OR transport.verified_at IS NULL THEN RETURN NULL;END IF;
  SELECT * INTO reset_job FROM public.account_password_reset_mail_jobs WHERE state='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1;
  IF FOUND THEN
   IF transport.version<>reset_job.transport_version THEN
    UPDATE public.account_password_reset_mail_jobs SET state='cancelled',finished_at=now(),error_code='transport_changed' WHERE id=reset_job.id;
   ELSE
    UPDATE public.account_password_reset_mail_jobs SET state='sending',lease_id=requested_lease,lease_expires_at=now()+interval '2 minutes' WHERE id=reset_job.id;
    RETURN jsonb_build_object('kind','account_password_reset','id',reset_job.id,'lease_id',requested_lease,'payload_ciphertext',reset_job.payload_ciphertext,'transport_ciphertext',transport.ciphertext);
   END IF;
  END IF;
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
    RETURN jsonb_build_object('kind','owner_invitation','id',job.id,'lease_id',requested_lease,'payload_ciphertext',job.payload_ciphertext,'transport_ciphertext',transport.ciphertext);
   END IF;
  END LOOP;
 END
$$;

CREATE OR REPLACE FUNCTION finish_platform_mail(job_id uuid,requested_lease uuid,outcome text,failure_code text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE job public.platform_mail_jobs;
 BEGIN
  IF outcome IS NULL OR outcome NOT IN ('accepted','failed','unknown') OR (failure_code IS NOT NULL AND failure_code !~ '^[a-z_]{1,50}$') THEN RAISE EXCEPTION 'Invalid mail outcome' USING ERRCODE='22023';END IF;
  UPDATE public.account_password_reset_mail_jobs SET state=outcome,accepted_at=CASE WHEN outcome='accepted' THEN now() ELSE NULL END,finished_at=now(),error_code=CASE WHEN outcome='accepted' THEN NULL ELSE failure_code END
   WHERE id=job_id AND lease_id=requested_lease AND state='sending';
  IF FOUND THEN RETURN true;END IF;
  UPDATE public.platform_mail_jobs SET state=outcome,accepted_at=CASE WHEN outcome='accepted' THEN now() ELSE NULL END,finished_at=now(),error_code=CASE WHEN outcome='accepted' THEN NULL ELSE failure_code END
   WHERE id=job_id AND lease_id=requested_lease AND state='sending' RETURNING * INTO job;
  IF NOT FOUND THEN RETURN false;END IF;
  INSERT INTO public.platform_audit(id,actor_id,action,resource_type,resource_id,data) VALUES(gen_random_uuid(),job.actor_id,'platform.mail.'||outcome,'workspace',job.tenant_id,jsonb_build_object('mail_id',job.id,'invitation_id',job.invitation_id,'error_code',job.error_code));
  RETURN true;
 END
$$;
REVOKE ALL ON FUNCTION claim_platform_mail(uuid),finish_platform_mail(uuid,uuid,text,text) FROM PUBLIC,drykraft_app,drykraft_worker,drykraft_platform;
GRANT EXECUTE ON FUNCTION claim_platform_mail(uuid),finish_platform_mail(uuid,uuid,text,text) TO drykraft_mail;
INSERT INTO schema_migrations(version) VALUES(34) ON CONFLICT DO NOTHING;
COMMIT;
