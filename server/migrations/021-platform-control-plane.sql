BEGIN;
CREATE TABLE IF NOT EXISTS platform_accounts (
 id uuid PRIMARY KEY, email text UNIQUE NOT NULL CHECK(email=lower(email)),
 name text NOT NULL CHECK(length(name) BETWEEN 2 AND 100), password_hash text NOT NULL,
 role text NOT NULL CHECK(role IN ('owner','admin','support','billing','viewer')),
 disabled boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 auth_version integer NOT NULL DEFAULT 1 CHECK(auth_version>0),
 secret_ciphertext text, last_step bigint NOT NULL DEFAULT -1, recovery_hashes text[] NOT NULL DEFAULT '{}',
 mfa_enabled_at timestamptz, password_changed_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_auth_challenges (
 token_hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES platform_accounts(id),
 auth_version integer NOT NULL, verified_password_hash text NOT NULL,
 pending_ciphertext text, attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 10),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_challenges_account ON platform_auth_challenges(account_id);
CREATE TABLE IF NOT EXISTS platform_sessions (
 token_hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES platform_accounts(id),
 auth_version integer NOT NULL, expires_at timestamptz NOT NULL,
 last_seen_at timestamptz NOT NULL DEFAULT now(), user_agent text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_sessions_account ON platform_sessions(account_id);
CREATE TABLE IF NOT EXISTS platform_audit (
 id uuid PRIMARY KEY, actor_id uuid REFERENCES platform_accounts(id), action text NOT NULL,
 resource_type text NOT NULL, resource_id uuid, reason text NOT NULL DEFAULT '',
 data jsonb NOT NULL DEFAULT '{}', request_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_audit_page ON platform_audit(created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS platform_audit_resource ON platform_audit(resource_type,resource_id,created_at DESC);
CREATE TABLE IF NOT EXISTS platform_workspace_controls (
 tenant_id uuid PRIMARY KEY REFERENCES workspaces(id), suspended boolean NOT NULL DEFAULT false,
 reason text NOT NULL DEFAULT '', version integer NOT NULL DEFAULT 1 CHECK(version>0),
 updated_by uuid REFERENCES platform_accounts(id), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE platform_workspace_controls ADD COLUMN IF NOT EXISTS event_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE TABLE IF NOT EXISTS platform_settings (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 data jsonb NOT NULL DEFAULT '{"signup_enabled":true,"support_email":"support@drykraft.com","maintenance_message":""}',
 updated_by uuid REFERENCES platform_accounts(id), updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_settings(id) VALUES(true) ON CONFLICT DO NOTHING;
DO $$ DECLARE t text; BEGIN
 FOR t IN SELECT unnest(ARRAY['platform_accounts','platform_auth_challenges','platform_sessions','platform_audit','platform_workspace_controls','platform_settings']) LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,drykraft_app,drykraft_worker',t);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='drykraft_platform') THEN
   IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename=t AND policyname='platform_only') THEN
    EXECUTE format('CREATE POLICY platform_only ON %I TO drykraft_platform USING(true) WITH CHECK(true)',t);
   END IF;
   EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO drykraft_platform',t);
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='drykraft_platform') THEN
  GRANT USAGE ON SCHEMA public TO drykraft_platform;
  REVOKE UPDATE,DELETE ON platform_audit FROM drykraft_platform;
  REVOKE DELETE ON platform_accounts,platform_workspace_controls,platform_settings FROM drykraft_platform;
  GRANT SELECT(id,name,slug,created_at) ON workspaces TO drykraft_platform;
  GRANT SELECT(id,name,email,created_at) ON users TO drykraft_platform;
  GRANT SELECT(tenant_id,user_id,role) ON memberships TO drykraft_platform;
  GRANT SELECT(tenant_id,status,seats,trial_started_at,trial_ends_at,next_billing_date,cancel_at_next_billing_date,synced_at) ON workspace_billing TO drykraft_platform;
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename='workspace_billing' AND policyname='platform_billing_read') THEN
   CREATE POLICY platform_billing_read ON workspace_billing FOR SELECT TO drykraft_platform USING(true);
  END IF;
  REVOKE ALL ON outbox,audit_events FROM drykraft_platform;
 END IF;
END $$;
-- This narrow lookup exposes no customer data or control reasons to ordinary runtime roles.
CREATE OR REPLACE FUNCTION platform_workspace_suspended(workspace_id uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT coalesce((SELECT suspended FROM public.platform_workspace_controls WHERE tenant_id=workspace_id),false)
$$;
CREATE OR REPLACE FUNCTION platform_signup_enabled() RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT coalesce((SELECT (data->>'signup_enabled')::boolean FROM public.platform_settings WHERE id=true),true)
$$;
REVOKE ALL ON FUNCTION platform_workspace_suspended(uuid),platform_signup_enabled() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_workspace_suspended(uuid) TO drykraft_app,drykraft_worker;
GRANT EXECUTE ON FUNCTION platform_signup_enabled() TO drykraft_app;
CREATE OR REPLACE FUNCTION public_platform_settings() RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('support_email',data->>'support_email','maintenance_message',data->>'maintenance_message') FROM public.platform_settings WHERE id=true
$$;
REVOKE ALL ON FUNCTION public_platform_settings() FROM PUBLIC,drykraft_worker;
GRANT EXECUTE ON FUNCTION public_platform_settings() TO drykraft_app;
-- Publish only the saved control transition; platform runtime cannot read customer webhook configuration.
CREATE OR REPLACE FUNCTION publish_platform_workspace_state(workspace_id uuid,actor uuid) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE control public.platform_workspace_controls; action text; inserted uuid;
 BEGIN
  SELECT * INTO control FROM public.platform_workspace_controls WHERE tenant_id=workspace_id AND updated_by=actor;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.platform_accounts WHERE id=actor AND role IN ('owner','admin') AND NOT disabled AND mfa_enabled_at IS NOT NULL) THEN
   RAISE EXCEPTION 'Saved platform transition is unavailable' USING ERRCODE='42501';
  END IF;
  action=CASE WHEN control.suspended THEN 'platform.workspace.suspended' ELSE 'platform.workspace.restored' END;
  PERFORM set_config('app.tenant_id',workspace_id::text,true);
  INSERT INTO public.outbox(id,tenant_id,type,resource_type,resource_id,actor_id,correlation_id,data)
   VALUES(control.event_id,workspace_id,action,'workspace',workspace_id,actor,gen_random_uuid(),jsonb_build_object('suspended',control.suspended))
   ON CONFLICT(id) DO NOTHING RETURNING id INTO inserted;
  IF inserted IS NOT NULL THEN
   INSERT INTO public.audit_events(tenant_id,id,actor_id,action,resource_id) VALUES(workspace_id,gen_random_uuid(),actor,action,workspace_id);
  END IF;
  RETURN control.event_id;
 END
$$;
REVOKE ALL ON FUNCTION publish_platform_workspace_state(uuid,uuid) FROM PUBLIC,drykraft_app,drykraft_worker;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='drykraft_platform') THEN
  GRANT EXECUTE ON FUNCTION publish_platform_workspace_state(uuid,uuid) TO drykraft_platform;
 END IF;
END $$;
INSERT INTO schema_migrations(version) VALUES(21) ON CONFLICT DO NOTHING;
COMMIT;
