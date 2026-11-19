BEGIN;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS memberships_tenant ON memberships(tenant_id,user_id);
CREATE TABLE IF NOT EXISTS invitations (
  tenant_id uuid NOT NULL REFERENCES workspaces(id), id uuid NOT NULL,
  email text NOT NULL CHECK(email=lower(trim(email))),
  role text NOT NULL CHECK(role IN ('admin','member','viewer')),
  token_hash text UNIQUE NOT NULL, invited_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  accepted_at timestamptz, accepted_by uuid REFERENCES users(id), revoked_at timestamptz,
  PRIMARY KEY(tenant_id,id),
  CHECK((accepted_at IS NULL)=(accepted_by IS NULL)),
  CHECK(accepted_at IS NULL OR revoked_at IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS invitations_pending_email ON invitations(tenant_id,email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS invitations_pending_created ON invitations(tenant_id,created_at DESC,id DESC)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename='invitations' AND policyname='tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON invitations
      USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
      WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
  END IF;
END $$;
CREATE OR REPLACE FUNCTION resolve_invitation(requested_hash text)
RETURNS TABLE(id uuid,tenant_id uuid,email text,role text,expires_at timestamptz,accepted_at timestamptz,revoked_at timestamptz,workspace_name text,workspace_slug text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp
AS $$ SELECT i.id,i.tenant_id,i.email,i.role,i.expires_at,i.accepted_at,i.revoked_at,w.name,w.slug
  FROM public.invitations i JOIN public.workspaces w ON w.id=i.tenant_id WHERE i.token_hash=requested_hash $$;
REVOKE ALL ON FUNCTION resolve_invitation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_invitation(text) TO drykraft_app;
GRANT SELECT,INSERT,UPDATE ON invitations TO drykraft_app;
REVOKE DELETE ON invitations FROM drykraft_app;
INSERT INTO schema_migrations(version) VALUES(3) ON CONFLICT DO NOTHING;
COMMIT;
