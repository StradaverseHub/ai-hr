-- Employee Dashboard Customization — Add / Remove / Shortcut (feedback 578a2fcf), the third and last item in
-- the dashboard chain (after 7d9d145d reorder + 1586d2f5 card master). Two backward-compatible, idempotent
-- steps; NO DDL (app_user.dashboard_layout is already a jsonb column from migration 0207, and
-- dashboard_card_config already exists from 0212).
--
-- 1) WIDEN THE STORED LAYOUT SHAPE. The per-user layout evolves from an order-only cardKey[] to
--    { selected: cardKey[], order: cardKey[] }. Any existing legacy value is a JSON *array*; wrap it as
--    { selected: <array>, order: <array> } so the stored shape matches the new model going forward. The
--    read path (lib/dashboard-layout.normalizeDashboardLayout) also understands a bare legacy array and the
--    legacy "cards" block token, so this backfill is belt-and-suspenders, not load-bearing. Idempotent:
--    only rows whose value is still an array are touched (after the wrap the type is 'object').
UPDATE app_user
SET dashboard_layout = jsonb_build_object('selected', dashboard_layout, 'order', dashboard_layout)
WHERE dashboard_layout IS NOT NULL
  AND jsonb_typeof(dashboard_layout) = 'array';--> statement-breakpoint

-- 2) SEED THE ACTION / SHORTCUT CARDS. The reporter's shortcut cards jump straight to a common HR task.
--    Seeded for every existing tenant as employee-selectable, non-default, non-mandatory 'shortcut' cards
--    with their destination href; they show up in the employee "Add Card" menu and render as clickable
--    links. Idempotent via the (tenant_id, card_key) unique index. Display order continues after the R39
--    information cards (1-7 from 0212).
INSERT INTO "dashboard_card_config" ("tenant_id","card_key","name","description","card_type","status","employee_selectable","default_display","mandatory","display_order","href")
SELECT t.id, v.card_key, v.name, v.description, 'shortcut', 'active', true, false, false, v.display_order, v.href
FROM "tenant" t
CROSS JOIN (VALUES
	('applyLeave',     'Apply Leave',            'Jump to the leave application page.',        8,  '/leave'),
	('submitClaim',    'Submit Claim',           'Jump to the claim submission page.',         9,  '/claims'),
	('viewPayslip',    'View Payslip',           'Jump to your payslips.',                     10, '/me/payslip'),
	('updateProfile',  'Update Profile',         'Jump to your employee profile.',             11, '/me'),
	('myApplications', 'My Applications Status',  'Track the status of your applications.',     12, '/me')
) AS v(card_key, name, description, display_order, href)
ON CONFLICT (tenant_id, card_key) DO NOTHING;
