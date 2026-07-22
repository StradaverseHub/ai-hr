-- Feedback 2806443b: employee dashboard rows reorganised — the Leave Calendar (plannedAbsences) becomes a
-- MANDATORY card (employees cannot remove it; it is also pinned full-width via lib/dashboard-layout
-- FIXED_ROW_KEYS, a code rule not a DB flag), and the default top row becomes
-- leaveBalance · nextHoliday · pendingTasks · upcomingEvents by swapping the seed display orders of
-- recentlyJoined (5 → 6) and upcomingEvents (6 → 5). Idempotent data migration (0255 pattern); no schema
-- changes.
--
-- Statement 1: force the Leave Calendar mandatory for every tenant. This intentionally overrides tenants
-- where HR had un-defaulted the card — the feedback demands the calendar stay pinned for employees.
-- MANDATORY implies DEFAULT-DISPLAY (the service invariant), so default_display is coerced true alongside.
-- STATUS is deliberately untouched: a row HR deactivated stays inactive (mandatory only has effect while
-- active; on reactivation the pin and mandatory apply). Idempotent via the mandatory = false guard.
UPDATE dashboard_card_config
SET mandatory = true, default_display = true
WHERE card_key = 'plannedAbsences'
  AND mandatory = false;--> statement-breakpoint
-- Statement 2: guarded display-order swap — applied ONLY where the tenant still has BOTH exact 0212 seed
-- values (recentlyJoined = 5 AND upcomingEvents = 6), so HR-customised orders are never clobbered.
-- Idempotent: after the swap recentlyJoined is 6, the guard no longer matches, and a re-run is a no-op.
UPDATE dashboard_card_config c
SET display_order = CASE c.card_key WHEN 'recentlyJoined' THEN 6 WHEN 'upcomingEvents' THEN 5 END
WHERE c.card_key IN ('recentlyJoined', 'upcomingEvents')
  AND EXISTS (
    SELECT 1 FROM dashboard_card_config r
    WHERE r.tenant_id = c.tenant_id AND r.card_key = 'recentlyJoined' AND r.display_order = 5
  )
  AND EXISTS (
    SELECT 1 FROM dashboard_card_config u
    WHERE u.tenant_id = c.tenant_id AND u.card_key = 'upcomingEvents' AND u.display_order = 6
  );
