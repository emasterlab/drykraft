BEGIN;
ALTER TABLE finance_counters ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'invoice';
ALTER TABLE finance_counters DROP CONSTRAINT IF EXISTS finance_counters_pkey;
ALTER TABLE finance_counters ADD CONSTRAINT finance_counters_pkey PRIMARY KEY(tenant_id,year,kind);
ALTER TABLE finance_counters ADD CONSTRAINT finance_counters_kind_check CHECK(kind IN ('invoice','purchase_order'));
CREATE UNIQUE INDEX IF NOT EXISTS purchase_order_number_unique ON records(tenant_id,(data->>'po_number')) WHERE object_key='purchase_orders' AND data->>'po_number' IS NOT NULL;
INSERT INTO object_definitions(tenant_id,key,name,singular_name,fields,built_in)
SELECT w.id,'purchase_orders','Purchase Orders','Purchase Order',jsonb_build_array(
 '{"key":"name","name":"Title","type":"text","required":true}'::jsonb,
 '{"key":"vendor","name":"Vendor","type":"text","required":true}'::jsonb,
 '{"key":"vendor_email","name":"Vendor email","type":"email","required":false}'::jsonb,
 '{"key":"vendor_address","name":"Vendor address","type":"text","required":false}'::jsonb,
 '{"key":"currency","name":"Currency","type":"text","required":true}'::jsonb,
 '{"key":"order_date","name":"Order date","type":"date","required":true}'::jsonb,
 '{"key":"expected_date","name":"Expected delivery","type":"date","required":false}'::jsonb,
 '{"key":"items","name":"Line items","type":"json","required":true}'::jsonb,
 '{"key":"notes","name":"Notes","type":"text","required":false}'::jsonb,
 '{"key":"deal_id","name":"Deal","type":"relation","object":"deals","required":false}'::jsonb,
 '{"key":"po_number","name":"Po number","type":"text","required":false}'::jsonb,
 '{"key":"status","name":"Status","type":"text","required":false}'::jsonb,
 '{"key":"issued_at","name":"Issued at","type":"text","required":false}'::jsonb,
 '{"key":"cancelled_at","name":"Cancelled at","type":"text","required":false}'::jsonb,
 '{"key":"cancel_reason","name":"Cancel reason","type":"text","required":false}'::jsonb,
 '{"key":"subtotal_minor","name":"Subtotal minor","type":"number","required":false}'::jsonb,
 '{"key":"discount_minor","name":"Discount minor","type":"number","required":false}'::jsonb,
 '{"key":"tax_minor","name":"Tax minor","type":"number","required":false}'::jsonb,
 '{"key":"total_minor","name":"Total minor","type":"number","required":false}'::jsonb,
 '{"key":"issuer","name":"Issuer","type":"json","required":false}'::jsonb,
 '{"key":"company_id","name":"Vendor company","type":"relation","object":"companies","required":false}'::jsonb
),true FROM workspaces w ON CONFLICT(tenant_id,key) DO NOTHING;
DO $$
DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('public.platform_resource_gauge(uuid,text)'::regprocedure) INTO definition;
 definition=replace(definition,'''people'',''companies'',''leads'',''deals'',''invoices'',''expenses'',''tasks''','''people'',''companies'',''leads'',''deals'',''invoices'',''purchase_orders'',''expenses'',''tasks''');
 EXECUTE definition;
 SELECT pg_get_functiondef('public.guard_workspace_resource()'::regprocedure) INTO definition;
 definition=replace(definition,'''invoices'',''expenses''','''invoices'',''purchase_orders'',''expenses''');
 definition=replace(definition,'''people'',''companies'',''leads'',''deals'',''invoices'',''expenses'',''tasks''','''people'',''companies'',''leads'',''deals'',''invoices'',''purchase_orders'',''expenses'',''tasks''');
 EXECUTE definition;
END $$;
INSERT INTO schema_migrations(version) VALUES(35) ON CONFLICT DO NOTHING;
COMMIT;
