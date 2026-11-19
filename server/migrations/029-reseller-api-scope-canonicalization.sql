BEGIN;
-- BETWEEN expands to a nested AND expression, which pg_dump/pg_restore flatten.
-- Keep the same scope predicate in canonical form so schema fingerprints survive
-- exact backup restoration without relaxing the security verifier.
ALTER TABLE reseller_api_keys DROP CONSTRAINT IF EXISTS reseller_api_keys_scopes_check;
ALTER TABLE reseller_api_keys ADD CONSTRAINT reseller_api_keys_scopes_check CHECK (
 cardinality(scopes)>=1 AND cardinality(scopes)<=3
 AND scopes <@ ARRAY['reseller.customers.read','reseller.plans.read','reseller.usage.read']::text[]
);
INSERT INTO schema_migrations(version) VALUES(29) ON CONFLICT DO NOTHING;
COMMIT;
