CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL,
  password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY, name text NOT NULL, slug text UNIQUE NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (slug ~ '^[a-z][a-z0-9-]{2,39}$')
);
CREATE TABLE IF NOT EXISTS memberships (
  user_id uuid NOT NULL REFERENCES users(id), tenant_id uuid NOT NULL REFERENCES workspaces(id),
  role text NOT NULL CHECK (role IN ('owner','admin','member','viewer')), PRIMARY KEY(user_id,tenant_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  tenant_id uuid NOT NULL REFERENCES workspaces(id), expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS object_definitions (
  tenant_id uuid NOT NULL REFERENCES workspaces(id), key text NOT NULL, name text NOT NULL,
  singular_name text NOT NULL, fields jsonb NOT NULL, built_in boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,key)
);
CREATE TABLE IF NOT EXISTS records (
  id uuid NOT NULL, tenant_id uuid NOT NULL REFERENCES workspaces(id), object_key text NOT NULL,
  data jsonb NOT NULL, version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,object_key) REFERENCES object_definitions(tenant_id,key)
);
CREATE INDEX IF NOT EXISTS records_object_created ON records(tenant_id,object_key,created_at DESC,id);
CREATE INDEX IF NOT EXISTS records_data_gin ON records USING gin(data jsonb_path_ops);
CREATE UNIQUE INDEX IF NOT EXISTS people_email_unique ON records(tenant_id,lower(data->>'email'))
  WHERE object_key='people' AND coalesce(data->>'email','')<>'';
CREATE TABLE IF NOT EXISTS record_links (
  tenant_id uuid NOT NULL, source_id uuid NOT NULL, target_id uuid NOT NULL, relation text NOT NULL,
  PRIMARY KEY(tenant_id,source_id,target_id,relation),
  FOREIGN KEY(tenant_id,source_id) REFERENCES records(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,target_id) REFERENCES records(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS activities (
  id uuid NOT NULL, tenant_id uuid NOT NULL, record_id uuid, actor_id uuid REFERENCES users(id),
  type text NOT NULL, body text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,record_id) REFERENCES records(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS activity_record_time ON activities(tenant_id,record_id,created_at DESC);
CREATE TABLE IF NOT EXISTS pipelines (
  tenant_id uuid NOT NULL REFERENCES workspaces(id), id uuid NOT NULL, name text NOT NULL,
  stages jsonb NOT NULL, PRIMARY KEY(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS dashboards (
  tenant_id uuid NOT NULL REFERENCES workspaces(id), id uuid NOT NULL, name text NOT NULL,
  widgets jsonb NOT NULL DEFAULT '[]', version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS workflows (
  tenant_id uuid NOT NULL REFERENCES workspaces(id), id uuid NOT NULL, name text NOT NULL,
  description text NOT NULL DEFAULT '', draft jsonb NOT NULL, published_version_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused')),
  next_run_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS workflow_versions (
  tenant_id uuid NOT NULL, id uuid NOT NULL, workflow_id uuid NOT NULL, version integer NOT NULL,
  graph jsonb NOT NULL, published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,workflow_id,version),
  FOREIGN KEY(tenant_id,workflow_id) REFERENCES workflows(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS workflow_webhooks (
  tenant_id uuid NOT NULL, workflow_id uuid NOT NULL, token_hash text UNIQUE NOT NULL, ciphertext text NOT NULL,
  PRIMARY KEY(tenant_id,workflow_id),
  FOREIGN KEY(tenant_id,workflow_id) REFERENCES workflows(tenant_id,id) ON DELETE CASCADE
);
CREATE OR REPLACE FUNCTION resolve_workflow_webhook(requested_hash text)
RETURNS TABLE(tenant_id uuid,workflow_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp
AS $$ SELECT h.tenant_id,h.workflow_id FROM public.workflow_webhooks h WHERE h.token_hash=requested_hash $$;
REVOKE ALL ON FUNCTION resolve_workflow_webhook(text) FROM PUBLIC;
CREATE TABLE IF NOT EXISTS executions (
  tenant_id uuid NOT NULL, id uuid NOT NULL, workflow_id uuid NOT NULL, version_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'queued', input jsonb NOT NULL DEFAULT '{}',
  context jsonb NOT NULL DEFAULT '{}', runtime jsonb NOT NULL DEFAULT '{}', current_node text, resume_at timestamptz,
  event_id uuid, error text, attempts integer NOT NULL DEFAULT 0,
  started_at timestamptz, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,workflow_id,event_id),
  FOREIGN KEY(tenant_id,workflow_id) REFERENCES workflows(tenant_id,id),
  FOREIGN KEY(tenant_id,version_id) REFERENCES workflow_versions(tenant_id,id),
  CHECK (state IN ('queued','running','waiting','succeeded','failed','cancelled','retrying'))
);
CREATE INDEX IF NOT EXISTS execution_state ON executions(state,resume_at,created_at);
ALTER TABLE executions ADD COLUMN IF NOT EXISTS dispatch_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE TABLE IF NOT EXISTS node_executions (
  tenant_id uuid NOT NULL, execution_id uuid NOT NULL, node_id text NOT NULL, iteration_path text NOT NULL DEFAULT '',
  state text NOT NULL, input jsonb, output jsonb, error text,
  started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  PRIMARY KEY(tenant_id,execution_id,node_id,iteration_path),
  FOREIGN KEY(tenant_id,execution_id) REFERENCES executions(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS credentials (
  tenant_id uuid NOT NULL, id uuid NOT NULL, name text NOT NULL, provider text NOT NULL,
  ciphertext text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS outbox (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES workspaces(id), type text NOT NULL,
  resource_type text, resource_id uuid, actor_id uuid, correlation_id uuid NOT NULL,
  causation_id uuid, data jsonb NOT NULL DEFAULT '{}', occurred_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(occurred_at) WHERE published_at IS NULL;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS depth integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS audit_events (
  tenant_id uuid NOT NULL, id uuid NOT NULL, actor_id uuid, action text NOT NULL,
  resource_id uuid, data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS usage_ledger (
  tenant_id uuid NOT NULL, id uuid NOT NULL, metric text NOT NULL, amount numeric NOT NULL,
  reference_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,metric,reference_id)
);
INSERT INTO schema_migrations(version) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS finance_counters (
  tenant_id uuid NOT NULL REFERENCES workspaces(id), year integer NOT NULL, value integer NOT NULL DEFAULT 0, PRIMARY KEY(tenant_id,year)
);
CREATE UNIQUE INDEX IF NOT EXISTS invoice_number_unique ON records(tenant_id,(data->>'invoice_number')) WHERE object_key='invoices' AND data->>'invoice_number' IS NOT NULL;
CREATE TABLE IF NOT EXISTS finance_entries (
  tenant_id uuid NOT NULL, id uuid NOT NULL, record_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('invoice_payment','expense_payment')),
  amount_minor bigint NOT NULL CHECK(amount_minor>0), currency text NOT NULL, paid_on date NOT NULL, method text NOT NULL, reference text NOT NULL,
  actor_id uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,record_id) REFERENCES records(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS finance_entries_record ON finance_entries(tenant_id,record_id,created_at);
