BEGIN;
CREATE TABLE IF NOT EXISTS calendars (
 tenant_id uuid NOT NULL REFERENCES workspaces(id),id uuid NOT NULL,name text NOT NULL,config jsonb NOT NULL,
 enabled boolean NOT NULL DEFAULT true,public_enabled boolean NOT NULL DEFAULT false,booking_key uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
 next_host integer NOT NULL DEFAULT 0,version integer NOT NULL DEFAULT 1,created_by uuid REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS appointments (
 tenant_id uuid NOT NULL,id uuid NOT NULL,calendar_id uuid NOT NULL,title text NOT NULL,guest_name text NOT NULL,guest_email text NOT NULL,
 record_id uuid,host_ids uuid[] NOT NULL,starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,blocked_start timestamptz NOT NULL,blocked_end timestamptz NOT NULL,
 timezone text NOT NULL,location text NOT NULL DEFAULT '',notes text NOT NULL DEFAULT '',state text NOT NULL DEFAULT 'booked' CHECK(state IN ('booked','completed','no_show','cancelled')),
 source text NOT NULL CHECK(source IN ('workspace','public','workflow')),manage_key uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,create_hash text NOT NULL,
 version integer NOT NULL DEFAULT 1,created_by uuid REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,calendar_id) REFERENCES calendars(tenant_id,id),FOREIGN KEY(tenant_id,record_id) REFERENCES records(tenant_id,id),
 CHECK(ends_at>starts_at AND blocked_start<=starts_at AND blocked_end>=ends_at),CHECK(cardinality(host_ids)>0)
);
CREATE INDEX IF NOT EXISTS appointments_range ON appointments(tenant_id,starts_at,ends_at) WHERE state='booked';
CREATE INDEX IF NOT EXISTS appointments_hosts ON appointments USING gin(host_ids) WHERE state='booked';
CREATE TABLE IF NOT EXISTS appointment_changes (
 tenant_id uuid NOT NULL,id uuid NOT NULL,appointment_id uuid NOT NULL,version integer NOT NULL,kind text NOT NULL,actor_id uuid REFERENCES users(id),snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,appointment_id,version),FOREIGN KEY(tenant_id,appointment_id) REFERENCES appointments(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS calendar_reminders (
 tenant_id uuid NOT NULL,id uuid NOT NULL,appointment_id uuid NOT NULL,appointment_version integer NOT NULL,minutes integer NOT NULL,due_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','emitted','cancelled')),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,appointment_id,appointment_version,minutes),
 FOREIGN KEY(tenant_id,appointment_id) REFERENCES appointments(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS calendar_reminders_due ON calendar_reminders(due_at) WHERE state='pending';
CREATE TABLE IF NOT EXISTS calendar_connections (
 tenant_id uuid NOT NULL,id uuid NOT NULL,user_id uuid NOT NULL,email text NOT NULL,provider text NOT NULL CHECK(provider IN ('google','microsoft')),ciphertext text NOT NULL,
 calendar_id text NOT NULL DEFAULT '',calendar_name text NOT NULL DEFAULT '',enabled boolean NOT NULL DEFAULT false,export_enabled boolean NOT NULL DEFAULT false,
 synced_at timestamptz,range_start timestamptz,range_end timestamptz,last_error text,next_sync_at timestamptz NOT NULL DEFAULT now(),version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(user_id,tenant_id) REFERENCES memberships(user_id,tenant_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS calendar_busy (
 tenant_id uuid NOT NULL,connection_id uuid NOT NULL,remote_id text NOT NULL,starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,appointment_id uuid,
 PRIMARY KEY(tenant_id,connection_id,remote_id),FOREIGN KEY(tenant_id,connection_id) REFERENCES calendar_connections(tenant_id,id) ON DELETE CASCADE,CHECK(ends_at>starts_at)
);
CREATE TABLE IF NOT EXISTS calendar_exports (
 tenant_id uuid NOT NULL,id uuid NOT NULL,connection_id uuid NOT NULL,appointment_id uuid NOT NULL,provider_id text,remote_etag text,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','synced','error','unknown','conflict')),synced_version integer NOT NULL DEFAULT 0,last_error text,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,connection_id,appointment_id),FOREIGN KEY(tenant_id,connection_id) REFERENCES calendar_connections(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,appointment_id) REFERENCES appointments(tenant_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['calendars','appointments','appointment_changes','calendar_reminders','calendar_connections','calendar_busy','calendar_exports'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename=t AND policyname='tenant_isolation') THEN
   EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
  END IF;
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION resolve_calendar_booking(requested uuid) RETURNS TABLE(tenant_id uuid,calendar_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT c.tenant_id,c.id FROM public.calendars c WHERE c.booking_key=requested AND c.enabled AND c.public_enabled $$;
CREATE OR REPLACE FUNCTION resolve_appointment_management(requested uuid) RETURNS TABLE(tenant_id uuid,appointment_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT a.tenant_id,a.id FROM public.appointments a WHERE a.manage_key=requested AND a.source='public' $$;
REVOKE ALL ON FUNCTION resolve_calendar_booking(uuid),resolve_appointment_management(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_calendar_booking(uuid),resolve_appointment_management(uuid) TO drykraft_app;
GRANT SELECT,INSERT,UPDATE ON calendars,appointments,calendar_reminders,calendar_connections,calendar_exports TO drykraft_app;
GRANT SELECT,INSERT,DELETE ON calendar_busy TO drykraft_app;
GRANT SELECT,INSERT ON appointment_changes TO drykraft_app;
REVOKE UPDATE,DELETE ON appointment_changes FROM drykraft_app;
REVOKE DELETE ON calendars,appointments,calendar_reminders,calendar_connections,calendar_exports FROM drykraft_app;
GRANT SELECT ON calendar_connections,calendar_reminders TO drykraft_worker;
INSERT INTO schema_migrations(version) VALUES(14) ON CONFLICT DO NOTHING;
COMMIT;
