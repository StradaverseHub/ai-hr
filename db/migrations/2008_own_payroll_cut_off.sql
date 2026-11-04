-- AI v2 Phase 2, P2-3: the person's own payroll cut-off day. Source allocation 2008 / when1793330001408 in the AI Centre
-- block 2000-2019 (docs/MIGRATION-ALLOCATION.md), renumbered from the never-applied 0967 / when1793330000367 at the AI v2
-- Phase 2 integration (4 November 2026). It grants no installation. Production is held.
--
-- WHY. The "Before payroll" checklist (core/pre-salary/person-items.ts) tells each person what is pending from them and
-- by when. "By when" is the payroll cut-off, which the payroll owner resolves from the company's cut_off_day
-- (core/payroll-policy-config.ts cutOffWindowFor). company_payroll_config is readable only by that company's
-- administrators (0081, company_payroll_config_rls), and that policy is unchanged: this function answers one narrower
-- question for the calling login only.
--
-- WHAT IT RETURNS. For an employment that is the calling login's OWN current employment (the login's person, not
-- archived or blocked, no agent principal, a current principal snapshot, not terminated before today), one row with
-- that employment's company's cut-off days: the salary cut_off_day and, since the Phase 2 hardening (4 November 2026,
-- while unapplied), the per-type ones the payroll owner resolves each input's window from (attendance, overtime, claim and
-- unpaid leave). Each is NULL when the company sets none, which the payroll owner reads as the salary cut-off or the month
-- end (core/payroll-policy-config.ts cutOffWindowFor). For any other employment (another person's, another company's, a
-- terminated one, an unknown id) or a caller with no employment: no row. Nothing else from the payroll configuration (no
-- pay day, no policy, no amount), and nothing about any other company or person.
--
-- Function rules: SECURITY DEFINER with a fixed search_path; STABLE; plain SQL, no dynamic SQL; REVOKE ALL FROM PUBLIC,
-- EXECUTE granted to the application role only. No table, column, constraint or policy changes, so no writer review.

CREATE FUNCTION app.own_payroll_cut_off_day(p_employment uuid) RETURNS TABLE(cut_off_day integer,attendance_cut_off_day integer,
 overtime_cut_off_day integer,claim_cut_off_day integer,unpaid_leave_cut_off_day integer)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT cfg.cut_off_day,cfg.attendance_cut_off_day,cfg.overtime_cut_off_day,cfg.claim_cut_off_day,cfg.unpaid_leave_cut_off_day
 FROM public.app_user u
 JOIN public.employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id
 LEFT JOIN public.company_payroll_config cfg ON cfg.company_id=e.company_id AND cfg.tenant_id=e.tenant_id
 WHERE e.id=p_employment AND u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL
  AND NOT app.login_blocked(u.id) AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND (e.terminated_on IS NULL OR e.terminated_on>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.own_payroll_cut_off_day(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.own_payroll_cut_off_day(uuid) TO ai_hr_app;
