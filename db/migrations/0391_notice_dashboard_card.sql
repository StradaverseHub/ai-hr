-- 6e122302 — the Notice Board card joins the dashboard CATALOGUE, rather than being hardcoded on the page.
--
-- dashboard_card_config (0212, role-widened by 0299) is the tenant-scoped catalogue the dashboard is built
-- from: it decides which cards exist, which show by default, which an employee may remove, and in what
-- order. A card added straight to app/page.tsx would be invisible to the Customize Dashboard flow and
-- un-removable, which is the thing that catalogue exists to prevent. So the notice card is a row in it.
--
-- audience = all three roles. A notice targets an EMPLOYMENT, and an HR admin or a manager is an employee
-- who receives notices like anyone else; giving the card to the employee dashboard only would hide from
-- managers the announcements they were sent.
--
-- display_order 11 — AFTER every card any role currently has (the highest in use is latestPayrollRun at
-- 10). Chosen so this is a pure APPEND for all three roles: no existing card moves, and the drift-guard
-- assertions in test/dashboard-fixed-row.test.ts change by one added name at the end rather than by a
-- reshuffle. default_display = true, because a communication channel nobody has switched on communicates
-- nothing.
--
-- Idempotent via the (tenant_id, card_key) unique index — the 0212/0299 pattern. A tenant provisioned
-- AFTER this migration gets no row at all and falls back to lib/dashboard-layout BUILTIN_DASHBOARD_CARDS,
-- which this migration's companion change adds the same entry to; that fallback is why the two must agree.
INSERT INTO dashboard_card_config
  ("tenant_id", "card_key", "name", "description", "card_type", "status", "employee_selectable", "default_display", "mandatory", "display_order", "href", "audience")
SELECT t.id, 'noticeBoard', 'Notice Board', 'Company announcements published to you.', 'information', 'active', true, true, false, 11, '/notices', '{employee,manager,hr_admin}'::text[]
FROM "tenant" t
ON CONFLICT (tenant_id, card_key) DO NOTHING;
