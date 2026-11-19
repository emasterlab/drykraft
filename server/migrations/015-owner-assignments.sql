BEGIN;
-- Preserve historical text references; do not guess an identity from a name.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM object_definitions d CROSS JOIN LATERAL jsonb_array_elements(d.fields) f WHERE d.built_in AND d.key IN ('people','companies','leads','deals','tasks') AND f->>'key'='owner_id' AND f->>'type'<>'user') THEN
  RAISE EXCEPTION 'Existing owner_id field is not a user field; resolve this schema conflict before migration.';
 END IF;
 IF EXISTS(SELECT 1 FROM object_definitions d WHERE d.built_in AND d.key IN ('people','companies','leads','deals','tasks') AND jsonb_array_length(d.fields)>=100 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.fields) f WHERE f->>'key'='owner_id')) THEN
  RAISE EXCEPTION 'An owner assignment would exceed the object field limit; resolve this schema conflict before migration.';
 END IF;
END $$;
UPDATE object_definitions d SET fields=(
 SELECT jsonb_agg(v ORDER BY position,part) FROM (
  SELECT CASE WHEN f->>'key'='owner' AND f->>'name'='Owner' THEN jsonb_set(f,'{name}','"Owner reference"') ELSE f END AS v,position,1 AS part
  FROM jsonb_array_elements(d.fields) WITH ORDINALITY x(f,position)
  UNION ALL
  SELECT '{"key":"owner_id","name":"Assigned owner","type":"user","required":false}'::jsonb,coalesce((SELECT position FROM jsonb_array_elements(d.fields) WITH ORDINALITY x(f,position) WHERE f->>'key'='owner'),jsonb_array_length(d.fields)+1),0
  WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.fields) f WHERE f->>'key'='owner_id')
 ) ordered_fields
) WHERE d.built_in AND d.key IN ('people','companies','leads','deals','tasks');
INSERT INTO schema_migrations(version) VALUES(15) ON CONFLICT DO NOTHING;
COMMIT;
