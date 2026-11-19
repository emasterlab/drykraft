BEGIN;
DO $$
DECLARE
 item record;
 existing jsonb;
BEGIN
 FOR item IN SELECT tenant_id,fields FROM object_definitions WHERE key='leads' AND built_in LOOP
  SELECT f INTO existing FROM jsonb_array_elements(item.fields) f WHERE f->>'key'='consent';
  IF existing IS NULL THEN
   UPDATE object_definitions SET fields=fields || '{"key":"consent","name":"Marketing consent","type":"boolean","required":false}'::jsonb WHERE tenant_id=item.tenant_id AND key='leads';
  ELSIF existing->>'type' IS DISTINCT FROM 'boolean' THEN
   RAISE EXCEPTION 'Existing leads.consent field is not boolean; resolve this schema conflict before migration.';
  END IF;
 END LOOP;
END $$;
INSERT INTO schema_migrations(version) VALUES(33) ON CONFLICT DO NOTHING;
COMMIT;