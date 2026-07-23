-- Dashboard customization for Manager and HR Admin roles (feedback 9606c59f).
--
-- The dashboard_card_config catalog gains a ROLE dimension: audience text[] — which dashboard roles
-- (employee | manager | hr_admin, per lib/dashboard-cards resolveDashboardRole) may see and arrange the
-- card. Existing rows are the employee card set → column default '{employee}' covers them. The four shared
-- section cards widen to all three roles, and the manager/admin dashboard sections become proper catalog
-- cards so those roles get the same Customize Dashboard experience (add / remove / reorder / pin / save)
-- employees already have. No RLS change: the column lives on dashboard_card_config, whose tenant-read /
-- admin-write policy (0212) already fences it.

ALTER TABLE dashboard_card_config
  ADD COLUMN IF NOT EXISTS audience text[] NOT NULL DEFAULT '{employee}';--> statement-breakpoint
-- Statement 2: widen the shared section cards to every role. Guarded on the pristine '{employee}' default
-- so a re-run — or a later HR-customised audience — is never clobbered (idempotent, 0296 pattern).
UPDATE dashboard_card_config
SET audience = '{employee,manager,hr_admin}'
WHERE card_key IN ('plannedAbsences', 'upcomingEvents', 'recentlyJoined', 'recentActivity')
  AND audience = '{employee}';--> statement-breakpoint
-- Statement 3: seed the manager/admin dashboard sections as cards for every existing tenant (idempotent via
-- the (tenant_id, card_key) unique index, 0212 pattern). Display orders mirror the old hardcoded per-role
-- arrangement: the role summary cards first (1..4), the shared sections keep 4..7 from the 0212/0296 seed,
-- and the newly card-wrapped sections land at 8..10. default_display = true everywhere so day one shows every
-- card the old fixed layout showed. Names are HR-authored master data (single-language English defaults,
-- exactly like the 0212 seed).
INSERT INTO dashboard_card_config
  ("tenant_id", "card_key", "name", "description", "card_type", "status", "employee_selectable", "default_display", "mandatory", "display_order", "href", "audience")
SELECT t.id, v.card_key, v.name, v.description, v.card_type, 'active', true, true, false, v.display_order, v.href, v.audience::text[]
FROM "tenant" t
CROSS JOIN (VALUES
	('teamAwayToday',      'Team Away Today',      'Direct reports on approved leave today.',           'information', 1,  '#planned-absences',  '{manager}'),
	('approvalRequests',   'Approval Requests',    'Requests awaiting your action.',                    'action',      2,  '/approvals',         '{manager}'),
	('upcomingReminders',  'Upcoming Reminders',   'Review deadlines and holidays coming up.',          'information', 3,  '#upcoming-events',   '{manager}'),
	('headcount',          'Headcount',            'Active employees across your companies.',           'information', 1,  '/personnel',         '{hr_admin}'),
	('pendingLeave',       'Pending Leave',        'Leave requests awaiting approval.',                 'information', 2,  '/leave',             '{hr_admin}'),
	('companies',          'Companies',            'Companies and departments in your organization.',   'information', 3,  '/admin/organization','{hr_admin}'),
	('latestPayroll',      'Latest Payroll',       'The latest payroll run at a glance.',               'information', 4,  '/payroll',           '{hr_admin}'),
	('attendanceOverview', 'Attendance Overview',  'Today''s attendance breakdown.',                    'information', 8,  NULL,                 '{manager,hr_admin}'),
	('headcountByCompany', 'Headcount by Company', 'Headcount per company and department.',             'information', 9,  NULL,                 '{hr_admin}'),
	('latestPayrollRun',   'Latest Payroll Run',   'Detail of the most recent payroll run.',            'information', 10, NULL,                 '{hr_admin}')
) AS v(card_key, name, description, card_type, display_order, href, audience)
ON CONFLICT (tenant_id, card_key) DO NOTHING;
