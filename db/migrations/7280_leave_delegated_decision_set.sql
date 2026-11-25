-- 7280 (renumbered from 7260, which Phase 3 reserved first). ADR 0181 employment-visibility addendum, step (d), approved by the owner on 24 November 2026
-- (docs/adr/0181-addendum-precomputed-employment-visibility.md, decision 3).
--
-- Five leave read policies admit a row when its subject is visible OR the caller may decide it through a delegation:
-- `... OR app.can_decide_via_delegation(subject)`, a SECURITY DEFINER call per row that joins two reporting lines,
-- two employments and app_user each time. app.delegated_decision_employment_ids() answers the same question once per
-- statement: the subjects whose current direct administrative manager (not terminated) is the delegator of one of
-- the caller's current delegate lines. It is the 0109 predicate exactly (not 0818's narrower module-scoped rule,
-- which these policies have never used); only where it is evaluated changes. Delegations stay live, not stored.
-- WITH CHECK, roles and commands are unchanged; each USING is guarded by its exact installed text.
--
-- The set is tested through app.delegated_decision_includes(subject, set), a PL/pgSQL membership check the planner
-- cannot inline. That keeps the planner's row estimate for these tables exactly where the per-row predecessor left
-- it (a boolean function call: default selectivity and cost), while the set itself is still built once per
-- statement. A bare `subject = ANY ((SELECT set)::uuid[])` arm was estimated at about 1% instead, which turned the
-- Leave approvals candidate query's CTE join into a nested loop (1,001 pending subjects: 5.8 s per read against the
-- per-row control's 0.7 s, where release 7 had passed the same test below 0.8x). The check reads no table and runs
-- with the caller's rights.
CREATE FUNCTION app.delegated_decision_employment_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(array_agg(DISTINCT adm.subordinate_employment_id ORDER BY adm.subordinate_employment_id),'{}'::uuid[])
 FROM public.reporting_line del
 JOIN public.reporting_line adm
   ON adm.line_type = 'administrative'
  AND adm.manager_employment_id = del.subordinate_employment_id
  AND adm.valid_from <= current_date AND (adm.valid_to IS NULL OR adm.valid_to > current_date)
  AND adm.superseded_at IS NULL
 JOIN public.employment adm_mgr ON adm_mgr.id = adm.manager_employment_id AND adm_mgr.terminated_on IS NULL
 JOIN public.employment del_emp ON del_emp.id = del.manager_employment_id
 JOIN public.app_user u ON u.person_id = del_emp.person_id
 WHERE del.line_type::text = 'delegate'
   AND del.tenant_id = app.current_tenant_id()
   AND del.valid_from <= current_date AND (del.valid_to IS NULL OR del.valid_to > current_date)
   AND del.superseded_at IS NULL
   AND u.id = app.current_user_id()
   AND adm.subordinate_employment_id IS NOT NULL;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.delegated_decision_employment_ids() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.delegated_decision_employment_ids() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.delegated_decision_includes(subject uuid, delegated uuid[]) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
 RETURN subject OPERATOR(pg_catalog.=) ANY (delegated);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.delegated_decision_includes(uuid, uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.delegated_decision_includes(uuid, uuid[]) TO ai_hr_app;
--> statement-breakpoint
DO $leave$
DECLARE
 p record;installed text;expected text;next text;
BEGIN
 FOR p IN SELECT * FROM (VALUES
  ('leave_request','leave_request_rls','employment_id'),
  ('leave_approval_step','leave_approval_step_rls','subject_employment_id'),
  ('leave_request_date','leave_request_date_rls','subject_employment_id'),
  ('replacement_leave_request','replacement_leave_request_rls','employment_id'),
  ('replacement_leave_request_date','replacement_leave_request_date_rls','subject_employment_id')) v(tbl,pol,col)
 LOOP
  SELECT pg_get_expr(x.polqual,x.polrelid) INTO installed FROM pg_policy x WHERE x.polrelid=('public.'||p.tbl)::regclass AND x.polname=p.pol;
  expected:=format('((tenant_id = app.current_tenant_id()) AND ((%1$s = ANY (( SELECT app.visible_employment_ids() AS visible_employment_ids)::uuid[])) OR app.can_decide_via_delegation(%1$s)))',p.col);
  IF installed IS DISTINCT FROM expected THEN
   RAISE EXCEPTION '% differs from the reviewed predecessor',p.pol USING ERRCODE='55000';
  END IF;
  next:=format('(tenant_id = app.current_tenant_id()) AND ((%1$s = ANY ((SELECT app.visible_employment_ids())::uuid[])) OR app.delegated_decision_includes(%1$s, (SELECT app.delegated_decision_employment_ids())))',p.col);
  EXECUTE format('ALTER POLICY %I ON public.%I USING (%s)',p.pol,p.tbl,next);
 END LOOP;
END;
$leave$;
