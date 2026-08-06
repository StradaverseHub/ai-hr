-- a00c4f64 — the Leave Calendar leaves the Dashboard for its own screen (Manage → Team Leave Tracker).
--
-- Two DATA statements on an existing, already-granted table (dashboard_card_config, 0212 / role-widened by
-- 0299). No DDL, so no GRANT.
--
-- Statement 1 — DELETE, not deactivate. The card is gone from the code catalogue too
-- (lib/dashboard-layout BUILTIN_DASHBOARD_CARDS / BUILTIN_ROLE_DASHBOARD_CARDS), and app/page.tsx no
-- longer renders a node for it. Leaving an INACTIVE row behind would put a re-activate button in the HR
-- Card Library that brings back a MANDATORY card with nothing to render — an unreachable-but-reachable
-- broken state. Deleting it is also what makes every saved personal layout self-heal: normalizeDashboardLayout
-- filters both `selected` and `order` through the live catalogue, so a key that is no longer a row is
-- dropped on read and, being no longer mandatory, is never force-re-added. That is why there is no
-- app_user.dashboard_layout migration here — the JSON needs none.
--
-- The row was seeded by 0212 and made mandatory by 0296. It is deleted for EVERY tenant deliberately: the
-- calendar is not on the dashboard for anyone any more, so a tenant keeping the row would keep a card the
-- application cannot draw. Idempotent by construction (a second run deletes nothing).
DELETE FROM dashboard_card_config WHERE card_key = 'plannedAbsences';--> statement-breakpoint
-- Statement 2 — the Team Away Today card's href followed the calendar. 0299 seeded it as the in-page
-- anchor '#planned-absences', which now scrolls to nothing. Guarded on the exact seeded value so an
-- HR-customised href is never clobbered, which also makes the statement idempotent.
UPDATE dashboard_card_config
SET href = '/leave/tracker'
WHERE card_key = 'teamAwayToday'
  AND href = '#planned-absences';
