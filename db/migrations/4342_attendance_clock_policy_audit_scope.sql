-- Keep dated operational reads and inserts available through the existing policies.
-- Private audit fields are read only through the scoped History owner. The previous app version
-- still selects `reason` directly (core/attendance-clock-policy.ts attendanceClockPolicyHistory) while
-- old and new builds run together, so this release keeps that one column granted; every other private
-- field is closed now. The first release after this one, once no old build can run, revokes `reason`.
REVOKE SELECT ON TABLE public.attendance_clock_policy_revision FROM ai_hr_app;
GRANT SELECT (id, tenant_id, company_id, rule_id, ordinal, effective_from, policy, reason)
 ON TABLE public.attendance_clock_policy_revision TO ai_hr_app;
--> statement-breakpoint
-- The insert guard runs with caller privileges and only needs the prior order and date. Migration
-- 4600_attendance_clock_policy_group_scope, which now applies before this one, already installs that
-- guard (reading only ordinal and effective_from, for company and group-wide chains), so it is not
-- re-created here: re-creating the company-only body would refuse every group-wide revision.
CREATE FUNCTION app.attendance_clock_policy_history(wanted_company uuid,wanted_rule uuid)
 RETURNS TABLE(id uuid,ordinal integer,effective_from date,policy jsonb,reason text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
 SELECT r.id,r.ordinal,r.effective_from,r.policy,r.reason
 FROM public.attendance_clock_policy_revision r
 WHERE r.tenant_id=app.current_tenant_id()
  AND r.company_id=wanted_company AND r.rule_id=wanted_rule
  AND (SELECT app.attendance_policy_principal_current())
  AND app.is_admin_for(wanted_company)
 ORDER BY r.ordinal LIMIT 501
$$;
REVOKE ALL ON FUNCTION app.attendance_clock_policy_history(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_clock_policy_history(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
-- The ordinary audit policy treats any scoped HR administrator as an admin.
-- For this event, bind the payload's scope to the stored revision before displaying it.
SET LOCAL lock_timeout='5s';
--> statement-breakpoint
CREATE POLICY attendance_clock_policy_audit_read ON public.domain_event AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(CASE WHEN event_type='attendance-rule.clock-policy.scheduled' THEN (
  aggregate_type='attendance-rule' AND actor_type='user'
  AND (SELECT app.attendance_policy_principal_current())
  AND EXISTS(
   SELECT 1 FROM public.attendance_clock_policy_revision r
   WHERE r.id=CASE WHEN pg_input_is_valid(domain_event.payload->>'versionId','uuid')
    THEN (domain_event.payload->>'versionId')::uuid END
    AND r.tenant_id=domain_event.tenant_id AND r.rule_id=domain_event.aggregate_id
    AND r.company_id::text=domain_event.payload->>'companyId'
    AND app.is_admin_for(r.company_id)
  )
 ) ELSE true END);
--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
