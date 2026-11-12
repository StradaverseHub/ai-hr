-- The scheduled payroll anomaly sweep reads each company's own net-swing threshold. DRAFT, UNALLOCATED (coordinator
-- reallocates; owner follow-on to the 11 November 2026 interim, HANDOFF.md §5 item 2).
-- One function only: no table, column, constraint, policy, grant on data or data change.
--
-- teras_payroll_loop_setting is readable only by an agent principal or an administrator of the company (2005,
-- teras_payroll_loop_setting_read), so the sweep, which runs with no login, saw no setting and judged every company at
-- the 15% default. This set-wise SECURITY DEFINER read returns, for the requested companies of the session's own
-- tenant, the threshold of each company's latest setting version and nothing else (no interval, exclusions, reminders,
-- author or history). It answers only a system session (no login and no agent principal); a login or an agent keeps
-- reading the table under its own row security, so no person gains a read they did not have. Another tenant's company,
-- a company with no setting or an empty or oversized request returns no row. One statement per call, whatever the
-- number of companies (the primary key (tenant_id, company_id, version) serves it).
--
-- Rollback (manual, only if never relied upon):
--   DROP FUNCTION app.sweep_swing_thresholds(uuid[]);
CREATE FUNCTION app.sweep_swing_thresholds(p_companies uuid[])
RETURNS TABLE(company_id uuid, threshold_bp integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT DISTINCT ON (s.company_id) s.company_id, s.swing_threshold_bp
 FROM public.teras_payroll_loop_setting s
 WHERE app.current_tenant_id() IS NOT NULL AND app.current_user_id() IS NULL AND app.current_agent_principal() IS NULL
  AND coalesce(cardinality(p_companies),0) BETWEEN 1 AND 500
  AND s.tenant_id=app.current_tenant_id() AND s.company_id=ANY(p_companies)
 ORDER BY s.company_id, s.version DESC
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.sweep_swing_thresholds(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.sweep_swing_thresholds(uuid[]) TO ai_hr_app;
