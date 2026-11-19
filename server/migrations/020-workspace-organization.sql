BEGIN;
CREATE TABLE IF NOT EXISTS workspace_locations (
 tenant_id uuid NOT NULL REFERENCES workspaces(id), id uuid NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 2 AND 100), description text NOT NULL DEFAULT '',
 address text NOT NULL DEFAULT '', city text NOT NULL DEFAULT '', country text NOT NULL DEFAULT '',
 timezone text NOT NULL, version integer NOT NULL DEFAULT 1 CHECK(version>0), archived_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_locations_name ON workspace_locations(tenant_id,lower(name));
CREATE INDEX IF NOT EXISTS workspace_locations_page ON workspace_locations(tenant_id,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS workspace_teams (
 tenant_id uuid NOT NULL REFERENCES workspaces(id), id uuid NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 2 AND 100), description text NOT NULL DEFAULT '',
 location_id uuid, lead_id uuid, version integer NOT NULL DEFAULT 1 CHECK(version>0), archived_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,location_id) REFERENCES workspace_locations(tenant_id,id),
 FOREIGN KEY(tenant_id,lead_id) REFERENCES memberships(tenant_id,user_id) ON DELETE SET NULL (lead_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_teams_name ON workspace_teams(tenant_id,lower(name));
CREATE INDEX IF NOT EXISTS workspace_teams_page ON workspace_teams(tenant_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS workspace_teams_location ON workspace_teams(tenant_id,location_id);
CREATE TABLE IF NOT EXISTS workspace_team_members (
 tenant_id uuid NOT NULL, team_id uuid NOT NULL, user_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,team_id,user_id),
 FOREIGN KEY(tenant_id,team_id) REFERENCES workspace_teams(tenant_id,id),
 FOREIGN KEY(tenant_id,user_id) REFERENCES memberships(tenant_id,user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS workspace_team_members_user ON workspace_team_members(tenant_id,user_id,team_id);
CREATE TABLE IF NOT EXISTS workspace_location_members (
 tenant_id uuid NOT NULL, location_id uuid NOT NULL, user_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,location_id,user_id),
 FOREIGN KEY(tenant_id,location_id) REFERENCES workspace_locations(tenant_id,id),
 FOREIGN KEY(tenant_id,user_id) REFERENCES memberships(tenant_id,user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS workspace_location_members_user ON workspace_location_members(tenant_id,user_id,location_id);
DO $$ DECLARE _table text; BEGIN
 FOR _table IN SELECT unnest(ARRAY['workspace_locations','workspace_teams','workspace_team_members','workspace_location_members']) LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',_table);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',_table);
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename=_table AND policyname='tenant_isolation') THEN
   EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',_table);
  END IF;
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON workspace_locations,workspace_teams TO drykraft_app;
REVOKE DELETE ON workspace_locations,workspace_teams FROM drykraft_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON workspace_team_members,workspace_location_members TO drykraft_app;
REVOKE ALL ON workspace_locations,workspace_teams,workspace_team_members,workspace_location_members FROM drykraft_worker;
INSERT INTO schema_migrations(version) VALUES(20) ON CONFLICT DO NOTHING;
COMMIT;
